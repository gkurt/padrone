import type {
  AnyPadroneCommand,
  AnyPadroneProgram,
  InterceptorDefBuilder,
  InterceptorErrorContext,
  InterceptorErrorResult,
  InterceptorFactory,
  InterceptorMeta,
  InterceptorPipelinePhase,
  InterceptorShutdownContext,
  InterceptorStartContext,
  PadroneCaller,
  PadroneEventHandler,
  PadroneInput,
  PadroneInterceptorFn,
  RegisteredInterceptor,
  ResolvedInterceptor,
} from '../types/index.ts';
import { PadroneError } from './errors.ts';
import { runsForCaller, withEmit } from './events.ts';
import { thenMaybe } from './results.ts';
import type { ResolvedPadroneRuntime } from './runtime.ts';

// ---------------------------------------------------------------------------
// defineInterceptor — creates a single-value distributable interceptor
// ---------------------------------------------------------------------------

/** Callers with a terminal and the process's stdin: `cli()`, `eval()`, `run()` and the REPL. For `callers` meta. */
export const LOCAL_CALLERS = ['cli', 'eval', 'run', 'repl'] as const satisfies readonly PadroneCaller[];

/** Callers that return results through their own transport (HTTP, MCP, AI tool calls): no terminal, no stdin. */
export const REMOTE_CALLERS = ['serve', 'mcp', 'tool'] as const satisfies readonly PadroneCaller[];

/** Meta fields stored as own properties of an interceptor function (`name` is the function's name). */
const META_KEYS = ['id', 'order', 'disabled', 'inherit', 'options', 'env', 'async', 'helpOptions', 'callers'] as const;

/**
 * Wraps the factory in a new function carrying the meta. `.on()` and `.requires()` build a new interceptor
 * (same id, meta and factory), so a shared, exported interceptor is never changed.
 */
function buildInterceptorFn(meta: InterceptorMeta, factory: InterceptorFactory<any, any, any>): PadroneInterceptorFn<any, any, any> {
  const fn: any = () => factory();
  Object.defineProperty(fn, 'name', { value: meta.name, configurable: true });
  for (const key of META_KEYS) if (meta[key] !== undefined) fn[key] = meta[key];
  if (meta.requires) fn['~requires'] = [...meta.requires];
  if (meta.on) fn['~on'] = { ...meta.on };
  fn.provides = () => fn;
  // `.requires<T>('padrone:logger')`: the ids are checked when the command runs
  fn.requires = (...ids: string[]) => buildInterceptorFn({ ...meta, requires: [...(meta.requires ?? []), ...ids] }, factory);
  fn.on = (event: { id: string }, handler: PadroneEventHandler) => {
    const previous = meta.on?.[event.id];
    const combined: PadroneEventHandler = previous
      ? async (payload, ctx) => {
          await previous(payload, ctx);
          await handler(payload, ctx);
        }
      : handler;
    return buildInterceptorFn({ ...meta, on: { ...meta.on, [event.id]: combined } }, factory);
  };
  return fn;
}

/**
 * Creates a self-contained interceptor value by attaching static metadata to the factory function.
 * The returned value can be passed directly to `.intercept()` or exported from a package.
 *
 * Two-arg form — define metadata and factory in one call:
 * ```ts
 * export const myInterceptor = defineInterceptor(
 *   { name: 'my-interceptor', order: 10 },
 *   () => ({
 *     execute(ctx, next) { return next(); },
 *   }),
 * );
 * ```
 *
 * Single-arg form — chain `.requires<T>()` for typed context, then `.factory()`:
 * ```ts
 * export const myInterceptor = defineInterceptor({ name: 'with-db' })
 *   .requires<{ db: DB }>()
 *   .factory(() => ({
 *     execute(ctx, next) {
 *       ctx.context.db; // typed!
 *       return next();
 *     },
 *   }));
 * ```
 */
export function defineInterceptor<TArgs = unknown, TResult = unknown>(
  meta: InterceptorMeta,
  factory: InterceptorFactory<TArgs, TResult>,
): PadroneInterceptorFn<TArgs, TResult>;
export function defineInterceptor(meta: InterceptorMeta): InterceptorDefBuilder;
export function defineInterceptor(
  meta: InterceptorMeta,
  factory?: InterceptorFactory<any, any, any>,
): PadroneInterceptorFn<any, any, any> | InterceptorDefBuilder {
  if (factory) return buildInterceptorFn(meta, factory);
  let requires = meta.requires;
  const builder: InterceptorDefBuilder = {
    requires: (...ids: string[]) => {
      if (ids.length > 0) requires = [...(requires ?? []), ...ids];
      return builder as any;
    },
    factory: (f) => buildInterceptorFn({ ...meta, requires }, f) as any,
  };
  return builder;
}

// ---------------------------------------------------------------------------
// Registration normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes an interceptor input (single-value form or two-arg form) into the internal
 * `RegisteredInterceptor` storage format.
 */
export function toRegisteredInterceptor(
  metaOrFn: InterceptorMeta | PadroneInterceptorFn<any, any, any>,
  factory?: InterceptorFactory<any, any, any>,
): RegisteredInterceptor {
  if (typeof metaOrFn === 'function') {
    // Single-value form: PadroneInterceptorFn (factory with meta as own properties)
    return {
      meta: {
        name: metaOrFn.name,
        id: metaOrFn.id,
        order: metaOrFn.order,
        disabled: metaOrFn.disabled,
        inherit: metaOrFn.inherit,
        options: metaOrFn.options,
        env: metaOrFn.env,
        async: metaOrFn.async,
        helpOptions: metaOrFn.helpOptions,
        callers: metaOrFn.callers,
        requires: (metaOrFn as { '~requires'?: string[] })['~requires'],
        on: (metaOrFn as { '~on'?: InterceptorMeta['on'] })['~on'],
      },
      factory: metaOrFn,
    };
  }
  // Two-arg form: (meta, factory)
  return { meta: metaOrFn, factory: factory! };
}

// ---------------------------------------------------------------------------
// Factory resolution
// ---------------------------------------------------------------------------

/**
 * Resolves registered interceptors by calling their factories and merging the resulting
 * phase handlers with the static metadata. Uses a cache to ensure each factory is called
 * at most once per execution (so root interceptor closures are shared across all phases).
 */
export function resolveRegisteredInterceptors(
  registered: RegisteredInterceptor[],
  cache: Map<RegisteredInterceptor, ResolvedInterceptor>,
): ResolvedInterceptor[] {
  return registered.map((reg) => {
    let resolved = cache.get(reg);
    if (!resolved) {
      resolved = { ...reg.meta, ...reg.factory() };
      cache.set(reg, resolved);
    }
    return resolved;
  });
}

// ---------------------------------------------------------------------------
// Interceptor chain runner
// ---------------------------------------------------------------------------

/**
 * Deduplicates interceptors by `id`. When multiple interceptors share the same `id`,
 * only the last one in the array is kept. Interceptors without an `id` are always kept.
 */
function deduplicateInterceptors(interceptors: ResolvedInterceptor[]): ResolvedInterceptor[] {
  // Fast path: no ids at all
  if (!interceptors.some((p) => p.id)) return interceptors;

  // Find the last index for each id
  const lastIndex = new Map<string, number>();
  for (let i = 0; i < interceptors.length; i++) {
    const id = interceptors[i]!.id;
    if (id) lastIndex.set(id, i);
  }

  return interceptors.filter((p, i) => !p.id || lastIndex.get(p.id) === i);
}

/**
 * Runs an interceptor chain for a given phase using the onion/middleware pattern.
 * Interceptors are sorted by `order` (ascending, stable), then composed so that
 * the first interceptor in sorted order is the outermost wrapper.
 * If no interceptors handle this phase, `core` is called directly.
 *
 * Each interceptor's `next()` accepts optional partial overrides that are merged
 * into the context before passing to the next interceptor or core function.
 */
export function runInterceptorChain<TCtx extends object, TResult>(
  phase: 'start' | 'parse' | 'route' | 'validate' | 'execute' | 'error' | 'shutdown',
  interceptors: ResolvedInterceptor[],
  ctx: TCtx,
  core: (ctx: TCtx) => TResult | Promise<TResult>,
): TResult | Promise<TResult> {
  // Deduplicate by id (last wins), then filter to enabled interceptors for this caller that have a handler for this phase
  const deduped = deduplicateInterceptors(interceptors);
  const caller = (ctx as { caller?: PadroneCaller }).caller;
  const phaseInterceptors = deduped.filter((p) => p[phase] && !p.disabled && runsForCaller(p, caller));
  if (phaseInterceptors.length === 0) return core(ctx);

  // Stable sort by order (lower = outermost). Equal order preserves registration order.
  phaseInterceptors.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Build chain from inside out: last interceptor wraps core, first interceptor is outermost
  let next: (currentCtx: TCtx) => TResult | Promise<TResult> = core;
  for (let i = phaseInterceptors.length - 1; i >= 0; i--) {
    const handler = phaseInterceptors[i]![phase]! as unknown as (
      ctx: TCtx,
      next: (overrides?: Record<string, unknown>) => TResult | Promise<TResult>,
    ) => TResult | Promise<TResult>;
    const prevNext = next;
    next = (currentCtx: TCtx) =>
      handler(currentCtx, (overrides?: Record<string, unknown>) => {
        if (!overrides) return prevNext(currentCtx);
        // Auto-merge context: `next({ context: { user } })` merges into existing context
        // instead of replacing it, so interceptors can't accidentally drop context.
        if (overrides.context != null && typeof overrides.context === 'object') {
          overrides = { ...overrides, context: Object.assign({}, (currentCtx as Record<string, unknown>).context, overrides.context) };
        }
        const merged = Object.assign({}, currentCtx, overrides) as TCtx;
        // `emit` follows the overrides (e.g. a new runtime)
        if ('emit' in merged && !('emit' in overrides)) withEmit(merged as never);
        return prevNext(merged);
      });
  }

  return next(ctx);
}

/** Runs the error chain. An error interceptor that throws replaces the error, so shutdown still runs. */
function runErrorChain(
  interceptors: ResolvedInterceptor[],
  ctx: InterceptorErrorContext,
  error: unknown,
): InterceptorErrorResult | Promise<InterceptorErrorResult> {
  const thrown = (e: unknown): InterceptorErrorResult => ({ error: e });
  try {
    const result = runInterceptorChain('error', interceptors, ctx, (): InterceptorErrorResult => ({ error }));
    return result instanceof Promise ? result.catch(thrown) : result;
  } catch (e) {
    return thrown(e);
  }
}

/**
 * Wraps a pipeline with start → error → shutdown lifecycle hooks.
 * - `start` interceptors wrap the pipeline (onion pattern, root interceptors only).
 * - On error: `error` interceptors run (can transform/suppress the error).
 * - Always: `shutdown` interceptors run (success or failure).
 * - `overridden`: root interceptors a same-id one on the routed command replaces; they skip error and shutdown.
 */
export function wrapWithLifecycle<T>(
  interceptors: ResolvedInterceptor[],
  command: AnyPadroneCommand,
  input: PadroneInput | undefined,
  pipeline: (signal: AbortSignal, context: unknown) => T | Promise<T>,
  wrapErrorResult?: (result: unknown) => T,
  signal?: AbortSignal,
  context?: unknown,
  runtime?: ResolvedPadroneRuntime,
  program?: AnyPadroneProgram,
  caller: PadroneCaller = 'eval',
  pipelineState?: { phase: InterceptorPipelinePhase; rawArgs?: Record<string, unknown>; positionalArgs?: string[]; args?: unknown },
  overridden?: ReadonlySet<ResolvedInterceptor>,
): T | Promise<T> {
  const defaultSignal = typeof AbortSignal !== 'undefined' ? AbortSignal.abort() : (undefined as unknown as AbortSignal);
  const hasStart = interceptors.some((p) => p.start);
  const hasError = interceptors.some((p) => p.error);
  const hasShutdown = interceptors.some((p) => p.shutdown);

  const effectivePipelineState = pipelineState ?? { phase: 'start' as const };

  // Fast path: no lifecycle interceptors
  if (!hasStart && !hasError && !hasShutdown) return pipeline(signal ?? defaultSignal, context);
  // Mutable refs: start-phase interceptors can override signal and context (e.g., signal extension, auth),
  // and the overrides propagate to error/shutdown contexts.
  let effectiveSignal = signal ?? defaultSignal;
  let effectiveContext = context;
  const lifecycleInterceptors = () => (overridden?.size ? interceptors.filter((i) => !overridden.has(i)) : interceptors);

  const runShutdown = (error?: unknown, result?: unknown) => {
    if (!hasShutdown) return;
    const ctx: InterceptorShutdownContext = withEmit({
      command,
      input,
      error,
      result,
      signal: effectiveSignal,
      context: effectiveContext as object,
      runtime: runtime!,
      program: program!,
      caller,
      ...effectivePipelineState,
    });
    return runInterceptorChain('shutdown', lifecycleInterceptors(), ctx, () => {});
  };

  const runError = (error: unknown): T | Promise<T> => {
    if (!hasError) {
      const s = runShutdown(error);
      if (s instanceof Promise)
        return s.then(() => {
          throw error;
        });
      throw error;
    }
    const ctx: InterceptorErrorContext = withEmit({
      command,
      input,
      error,
      signal: effectiveSignal,
      context: effectiveContext as object,
      runtime: runtime!,
      program: program!,
      caller,
      ...effectivePipelineState,
    });
    const errorResult = runErrorChain(lifecycleInterceptors(), ctx, error);
    return thenMaybe(errorResult, (er) => {
      if (er.error !== undefined) {
        const s = runShutdown(er.error);
        return thenMaybe(s as void | Promise<void>, () => {
          throw er.error;
        });
      }
      const wrapped = wrapErrorResult ? wrapErrorResult(er.result) : (er.result as T);
      const s = runShutdown(undefined, wrapped);
      return thenMaybe(s as void | Promise<void>, () => wrapped);
    });
  };

  const handleSuccess = (result: T): T | Promise<T> => {
    const s = runShutdown(undefined, result);
    if (s instanceof Promise) return s.then(() => result);
    return result;
  };

  const startCtx: InterceptorStartContext = withEmit({
    command,
    signal: effectiveSignal,
    context: effectiveContext as object,
    runtime: runtime!,
    program: program!,
    input,
    caller,
  });
  let result: T | Promise<T>;
  try {
    result = (
      hasStart
        ? runInterceptorChain('start', interceptors, startCtx, (ctx) => {
            // Capture overrides from start-phase interceptors so downstream phases see them.
            effectiveSignal = ctx.signal;
            effectiveContext = ctx.context;
            return pipeline(ctx.signal, ctx.context);
          })
        : pipeline(effectiveSignal, effectiveContext)
    ) as T | Promise<T>;
  } catch (e) {
    return runError(e);
  }

  if (result instanceof Promise) {
    return result.then(handleSuccess, runError);
  }

  return handleSuccess(result);
}

/**
 * Wraps a command-level pipeline (validate + execute) with error → shutdown lifecycle hooks.
 * Unlike `wrapWithLifecycle`, this has no `start` phase and uses the resolved command context.
 * Only interceptors exclusive to the command chain (not in root) should be passed here.
 */
export function wrapWithCommandLifecycle<T>(
  interceptors: ResolvedInterceptor[],
  command: AnyPadroneCommand,
  input: PadroneInput | undefined,
  pipeline: () => T | Promise<T>,
  wrapErrorResult: ((result: unknown) => T) | undefined,
  signal: AbortSignal,
  context: unknown,
  runtime: ResolvedPadroneRuntime,
  program: AnyPadroneProgram,
  caller: PadroneCaller,
  pipelineState: { phase: InterceptorPipelinePhase; rawArgs?: Record<string, unknown>; positionalArgs?: string[]; args?: unknown },
): T | Promise<T> {
  const hasError = interceptors.some((p) => p.error);
  const hasShutdown = interceptors.some((p) => p.shutdown);

  if (!hasError && !hasShutdown) return pipeline();

  const runShutdown = (error?: unknown, result?: unknown) => {
    if (!hasShutdown) return;
    const ctx: InterceptorShutdownContext = withEmit({
      command,
      input,
      error,
      result,
      signal,
      context: context as object,
      runtime,
      program,
      caller,
      ...pipelineState,
    });
    return runInterceptorChain('shutdown', interceptors, ctx, () => {});
  };

  const runError = (error: unknown): T | Promise<T> => {
    if (!hasError) {
      const s = runShutdown(error);
      if (s instanceof Promise)
        return s.then(() => {
          throw error;
        });
      throw error;
    }
    const ctx: InterceptorErrorContext = withEmit({
      command,
      input,
      error,
      signal,
      context: context as object,
      runtime,
      program,
      caller,
      ...pipelineState,
    });
    const errorResult = runErrorChain(interceptors, ctx, error);
    return thenMaybe(errorResult, (er) => {
      if (er.error !== undefined) {
        const s = runShutdown(er.error);
        return thenMaybe(s as void | Promise<void>, () => {
          throw er.error;
        });
      }
      const wrapped = wrapErrorResult ? wrapErrorResult(er.result) : (er.result as T);
      const s = runShutdown(undefined, wrapped);
      return thenMaybe(s as void | Promise<void>, () => wrapped);
    });
  };

  const handleSuccess = (result: T): T | Promise<T> => {
    const s = runShutdown(undefined, result);
    if (s instanceof Promise) return s.then(() => result);
    return result;
  };

  let result: T | Promise<T>;
  try {
    result = pipeline();
  } catch (e) {
    return runError(e);
  }

  if (result instanceof Promise) {
    return result.then(handleSuccess, runError);
  }

  return handleSuccess(result);
}

/**
 * Checks the `requires` ids of the interceptors that apply to a command against the ones registered (and enabled) on its chain.
 * Throws a `PadroneError` naming the first missing one.
 */
export function checkInterceptorRequirements(registered: readonly RegisteredInterceptor[]): void {
  const lastById = new Map<string, InterceptorMeta>();
  for (const { meta } of registered) if (meta.id) lastById.set(meta.id, meta);
  const active = (meta: InterceptorMeta) => !meta.disabled && (!meta.id || lastById.get(meta.id) === meta);
  const available = new Set([...lastById.values()].filter((meta) => !meta.disabled).map((meta) => meta.id!));
  for (const { meta } of registered) {
    if (!meta.requires?.length || !active(meta)) continue;
    const missing = meta.requires.find((id) => !available.has(id));
    if (missing)
      throw new PadroneError(`Interceptor "${meta.name}" requires "${missing}", which isn't registered on this command or its parents`);
  }
}
