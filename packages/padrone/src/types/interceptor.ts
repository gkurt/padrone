import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { AnyPadroneProgram } from './builder.ts';
import type { AnyPadroneCommand, PadroneActionContext } from './command.ts';

// ---------------------------------------------------------------------------
// Interceptor system
// ---------------------------------------------------------------------------

/**
 * Raw CLI input: a command line to tokenize (`eval()`, the REPL), or argv entries already
 * tokenized by the shell (`cli()`), each taken as exactly one token.
 */
export type PadroneInput = string | string[];

/** Base context shared across all interceptor phases within a single execution. */
export type InterceptorBaseContext<TContext = object> = {
  /** The resolved command for this execution. In the parse phase, this is the root program. */
  command: AnyPadroneCommand;
  /** The raw CLI input: a string from `eval()`/REPL, or the argv array from `cli()` (undefined when invoked without input). */
  input: PadroneInput | undefined;
  /** Cancellation signal that fires when the process receives a termination signal. */
  signal: AbortSignal;
  /** User-defined context object, resolved through the command's parent chain. */
  context: TContext;
  /** The resolved runtime for this execution. Interceptors can override this before calling `next()`. */
  runtime: ResolvedPadroneRuntime;
  /** The program instance. Available for extensions that need program-level methods. */
  program: AnyPadroneProgram;
  /** The invocation method that triggered this execution (e.g. 'cli', 'eval', 'run'). */
  caller: PadroneActionContext['caller'];
};

/** Context for the parse phase. */
export type InterceptorParseContext<TContext = object> = InterceptorBaseContext<TContext>;

/** Result returned by the parse phase's `next()`. */
export type InterceptorParseResult = {
  command: AnyPadroneCommand;
  rawArgs: Record<string, unknown>;
  positionalArgs: string[];
};

/** Context for the route phase. Runs after the target command is resolved, before validation. */
export type InterceptorRouteContext<TContext = object> = InterceptorBaseContext<TContext> & {
  /** Raw named arguments extracted by the parser. */
  rawArgs: Record<string, unknown>;
  /** Positional argument strings extracted by the parser. */
  positionalArgs: string[];
};

/** Context for the validate phase. */
export type InterceptorValidateContext<TContext = object> = InterceptorBaseContext<TContext> & {
  /** Raw named arguments extracted by the parser. Mutable — modify before `next()` to inject/override values. */
  rawArgs: Record<string, unknown>;
  /** Positional argument strings extracted by the parser. */
  positionalArgs: string[];
  /** Interactive mode override (set by the interactive extension when `--interactive` / `-i` flag is used). */
  interactive?: boolean;
  /** Interactive mode preference from eval/cli options. Available for the interactive extension. */
  evalInteractive?: boolean;
};

/** Result returned by the validate phase's `next()`. */
export type InterceptorValidateResult<TArgs = unknown> = {
  args: TArgs;
  argsResult: StandardSchemaV1.Result<TArgs>;
};

/** Context for the execute phase. Includes validate context fields (rawArgs, positionalArgs). */
export type InterceptorExecuteContext<TArgs = unknown, TContext = object> = InterceptorValidateContext<TContext> & {
  /** Validated arguments that will be passed to the action. Mutable — modify before `next()` to override. */
  args: TArgs;
};

/** Result returned by the execute phase's `next()`. */
export type InterceptorExecuteResult<TResult = unknown> = {
  result: TResult;
};

/** Context for the start phase. Runs before parsing, wraps the entire pipeline. */
export type InterceptorStartContext<TContext = object> = InterceptorBaseContext<TContext>;

/** The pipeline phase that was executing when an error was thrown or the pipeline completed. */
export type InterceptorPipelinePhase = 'start' | 'parse' | 'route' | 'validate' | 'execute';

/** Context for the error phase. Called when the pipeline throws. Includes pipeline state accumulated before the error. */
export type InterceptorErrorContext<TContext = object> = InterceptorBaseContext<TContext> & {
  /** The error that was thrown. */
  error: unknown;
  /** The pipeline phase that was executing when the error was thrown. */
  phase: InterceptorPipelinePhase;
  /** Raw named arguments (available if parse completed). */
  rawArgs?: Record<string, unknown>;
  /** Positional argument strings (available if parse completed). */
  positionalArgs?: string[];
  /** Validated arguments (available if validate completed). */
  args?: unknown;
};

/** Result returned by the error phase's `next()`. */
export type InterceptorErrorResult<TResult = unknown> = {
  /** The error (possibly transformed). Set to `undefined` to suppress the error. */
  error?: unknown;
  /** A replacement result when suppressing the error. */
  result?: TResult;
};

/** Context for the shutdown phase. Always runs after the pipeline (success or failure). Includes pipeline state accumulated before completion. */
export type InterceptorShutdownContext<TResult = unknown, TContext = object> = InterceptorBaseContext<TContext> & {
  /** The error, if the pipeline failed (after error phase processing). */
  error?: unknown;
  /** The pipeline result, if it succeeded. */
  result?: TResult;
  /** The last pipeline phase that was reached before completion or failure. */
  phase: InterceptorPipelinePhase;
  /** Raw named arguments (available if parse completed). */
  rawArgs?: Record<string, unknown>;
  /** Positional argument strings (available if parse completed). */
  positionalArgs?: string[];
  /** Validated arguments (available if validate completed). */
  args?: unknown;
};

/** Overrides passable to `next()`. Provides autocomplete for common fields; accepts any phase-specific fields. */
export type InterceptorNextOverrides = Partial<InterceptorBaseContext> & Record<string, unknown>;

/**
 * A phase handler function for the interceptor middleware chain.
 *
 * - `TCtx` — the context object available to the handler.
 * - `TNextResult` — the typed result returned by `next()`, giving the handler type-safe access to downstream output.
 * - `TReturn` — the type the handler itself returns. Defaults to `TNextResult` but can be wider,
 *   allowing interceptors to transform or replace the result (e.g., error-recovery interceptors returning a different type).
 */
type InterceptorPhaseHandler<TCtx, TNextResult, TReturn = TNextResult> = (
  ctx: TCtx,
  next: (overrides?: InterceptorNextOverrides) => TNextResult | Promise<TNextResult>,
) => TReturn | Promise<TReturn>;

// ---------------------------------------------------------------------------
// Interceptor meta, phases, and factory
// ---------------------------------------------------------------------------

/** Static metadata for an interceptor. Always available at registration time without calling the factory. */
export type InterceptorMeta = {
  /** Display name for this interceptor. Used for identification in logs and debugging. */
  name: string;
  /**
   * Optional unique identifier for deduplication. When multiple interceptors share the same `id`,
   * only the last one registered is kept. Useful for allowing downstream code to override
   * an interceptor without accumulating duplicates.
   */
  id?: string;
  /**
   * Ordering hint. Lower values run as outer layers (earlier before `next()`, later after).
   * Interceptors with the same order preserve registration order. Defaults to `0`.
   */
  order?: number;
  /**
   * When `true`, the interceptor is skipped during execution. Combined with `id`-based deduplication,
   * this lets downstream code disable an interceptor by re-registering it with `disabled: true`.
   */
  disabled?: boolean;
  /**
   * When `false`, the interceptor applies only to the command it was registered on
   * and is not inherited by subcommands. Defaults to `true`.
   */
  inherit?: boolean;
};

/**
 * Phase handler definitions returned by an interceptor factory.
 * The factory's closure provides typed, scoped cross-phase state.
 *
 * Type parameters:
 * - `TArgs` — the validated arguments type (output of the args schema).
 * - `TResult` — the command's return type.
 */
export type InterceptorPhases<TArgs = unknown, TResult = unknown, TContext = object> = {
  /**
   * Runs before the pipeline (parse → validate → execute). `next()` proceeds to the pipeline.
   * Root interceptors only. Use for startup tasks like telemetry, update checks, or global config loading.
   */
  start?: InterceptorPhaseHandler<InterceptorStartContext<TContext>, unknown>;
  /** Intercepts command routing and raw argument extraction. */
  parse?: InterceptorPhaseHandler<InterceptorParseContext<TContext>, InterceptorParseResult>;
  /**
   * Runs after the target command is resolved (post-parse), before validation.
   * Use for per-command setup: authorization, resource loading, logging, etc.
   * Root and command-level interceptors both participate.
   */
  route?: InterceptorPhaseHandler<InterceptorRouteContext<TContext>, void>;
  /** Intercepts argument preprocessing and schema validation. Interactive prompting is handled by the interactive extension. */
  validate?: InterceptorPhaseHandler<InterceptorValidateContext<TContext>, InterceptorValidateResult<TArgs>, InterceptorValidateResult>;
  /** Intercepts handler execution. */
  execute?: InterceptorPhaseHandler<
    InterceptorExecuteContext<TArgs, TContext>,
    InterceptorExecuteResult<TResult>,
    InterceptorExecuteResult
  >;
  /**
   * Called when the pipeline throws an error. `next()` passes to the next error handler
   * (innermost returns `{ error }` unchanged). Return `{ result }` without `error` to suppress.
   */
  error?: InterceptorPhaseHandler<InterceptorErrorContext<TContext>, InterceptorErrorResult<TResult>, InterceptorErrorResult>;
  /**
   * Always runs after the pipeline completes (success or failure). `next()` calls the next shutdown handler.
   * Use for cleanup: closing connections, flushing logs, etc.
   */
  shutdown?: InterceptorPhaseHandler<InterceptorShutdownContext<TResult, TContext>, void>;
};

/**
 * Factory function that creates phase handlers for an interceptor.
 * Called once per command execution — the closure provides typed, scoped cross-phase state across phases.
 */
export type InterceptorFactory<TArgs = unknown, TResult = unknown, TContext = object> = () => InterceptorPhases<TArgs, TResult, TContext>;

/**
 * A self-contained interceptor value: a factory function with static metadata as own properties.
 * Created via `defineInterceptor(meta, factory)`. This is the distributable form — a single
 * importable value that packages can export.
 *
 * Also accepted directly by `.intercept()` as the single-argument form.
 * Call `.provides<T>()` to brand it as a context-providing interceptor.
 */
export type PadroneInterceptorFn<TArgs = unknown, TResult = unknown, TContext = object> = InterceptorFactory<TArgs, TResult, TContext> &
  InterceptorMeta & {
    /** Brand this interceptor as providing additional context of type `TProvides`. No-op at runtime; purely a type-level cast. */
    provides: <TProvides>() => PadroneContextInterceptor<TProvides, TArgs, TResult, TContext>;
    /**
     * Brand this interceptor as requiring context of type `TRequires` to be available.
     * `.intercept()` will produce a compile error if the required context is not satisfied.
     * Use optional properties for soft requirements: `.requires<{ db: DB; logger?: Logger }>()`.
     * No-op at runtime; purely a type-level cast.
     */
    requires: <TRequires>() => PadroneInterceptorFn<TArgs, TResult, TContext> & InterceptorRequiresBrand<TRequires>;
  };

/**
 * A Padrone interceptor in its single-value distributable form.
 * Alias for `PadroneInterceptorFn` — this is the primary public type.
 *
 * Create with `defineInterceptor(meta, factory)` or pass `(meta, factory)` directly to `.intercept()`.
 */
export type PadroneInterceptor<TArgs = unknown, TResult = unknown, TContext = object> = PadroneInterceptorFn<TArgs, TResult, TContext>;

/**
 * A context-providing interceptor. Carries a phantom `'~context'` brand declaring what it adds
 * to the command context. When registered via `.intercept()`, the builder's context type is
 * intersected with `TProvides`.
 *
 * Created by calling `.provides<T>()` on a `PadroneInterceptorFn`.
 * Chain `.requires<T>()` to also declare context dependencies.
 */
export type PadroneContextInterceptor<TProvides = unknown, TArgs = unknown, TResult = unknown, TContext = object> = Omit<
  PadroneInterceptorFn<TArgs, TResult, TContext>,
  'requires'
> &
  InterceptorFactory<TArgs, TResult, TContext> & {
    /** Phantom brand — declares the context type this interceptor provides. */
    '~context': TProvides;
    /** Like `.requires()` on `PadroneInterceptorFn` but preserves the `'~context'` brand. */
    requires: <TRequires>() => PadroneContextInterceptor<TProvides, TArgs, TResult, TContext> & InterceptorRequiresBrand<TRequires>;
  };

/**
 * Phantom brand for context requirements. Uses a contravariant function type so that
 * `.intercept()` overloads can check `TAvailableContext extends TRequires` via assignability.
 */
type InterceptorRequiresBrand<TRequires> = { '~contextRequires': (ctx: TRequires) => void };

/** Extracts the provided context type from a context-providing interceptor, or `unknown` if not branded. */
export type ExtractInterceptorContext<T> = T extends { '~context': infer C } ? C : unknown;

/** Extracts the required context type from an interceptor, or `unknown` if no requirements. */
export type ExtractInterceptorRequires<T> = T extends { '~contextRequires': (ctx: infer R) => void } ? R : unknown;

/**
 * Checks whether an interceptor's context requirements are satisfied by the available context.
 * Returns `true` if the interceptor has no requirements or if the available context extends the requirements.
 */
export type InterceptorRequiresCheck<TInterceptor, TAvailableContext> = TInterceptor extends {
  '~contextRequires': (ctx: infer TReq) => void;
}
  ? TAvailableContext extends TReq
    ? true
    : false
  : true;

/** Error brand returned by `.intercept()` when the interceptor's required context is not satisfied. */
export type InterceptorRequiresError = {
  readonly '~error': 'Required context not satisfied. Ensure required interceptors are registered before this one.';
};

/**
 * Builder returned by `defineInterceptor(meta)` (single-arg form).
 * Call `.requires<T>()` to declare (and type) the context dependency, then `.factory()` to provide the phase handlers.
 */
export type InterceptorDefBuilder<TContext = unknown, TBrand = unknown> = {
  /** Declare the context type this interceptor requires. Sets `TContext` for phase handler typing. */
  requires: <TRequires>() => InterceptorDefBuilder<TRequires, InterceptorRequiresBrand<TRequires>>;
  /** Provide the interceptor factory. Phase handlers receive the typed `TContext` from `.requires()`. */
  factory: <TArgs = unknown, TResult = unknown>(
    factory: InterceptorFactory<TArgs, TResult, TContext>,
  ) => PadroneInterceptorFn<TArgs, TResult, TContext> & TBrand;
};

/**
 * Internal stored form on command objects. Separates static metadata from the factory
 * so that deduplication and sorting can happen without calling the factory.
 */
export type RegisteredInterceptor = {
  meta: InterceptorMeta;
  factory: InterceptorFactory<any, any, any>;
};

/**
 * Resolved interceptor: metadata merged with phase handlers after the factory has been called.
 * Used internally by the runtime chain runner.
 */
export type ResolvedInterceptor = InterceptorMeta & InterceptorPhases<any, any, any>;
