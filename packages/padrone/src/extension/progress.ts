import { defineInterceptor } from '../core/interceptors.ts';
import { isAsyncIterator, isIterator } from '../core/results.ts';
import type { PadroneBarConfig, PadroneProgress, PadroneProgressOptions, PadroneSpinnerConfig } from '../core/runtime.ts';
import type {
  AnyPadroneBuilder,
  CommandTypesBase,
  InterceptorExecuteContext,
  InterceptorExecuteResult,
  InterceptorValidateResult,
} from '../types/index.ts';
import type { WithInterceptor } from '../util/type-utils.ts';
import type { PadroneProgressRenderer } from './progress-renderer.ts';
import { createTerminalProgress } from './progress-renderer.ts';
import type { PadroneTaskListRenderer, PadroneTaskState, PadroneTasksFn } from './progress-tasks.ts';
import { createTerminalTaskList, noopTaskRenderer, runTaskList } from './progress-tasks.ts';
import { isRemoteCaller } from './utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A progress message value: a plain string, `null` to suppress, or an object with a message and custom indicator icon. */
export type PadroneProgressMessage = string | null | { message?: string | null; indicator?: string };

/** Per-phase message configuration for progress indicators. */
export type PadroneProgressMessages<TRes = unknown> = {
  /** Message shown during validation. Defaults to the `progress` message. */
  validation?: string;
  /** Message shown while the command's action is running. */
  progress?: string;
  /** Message shown when the command succeeds. `null` to suppress. Defaults to the `progress` message. */
  success?: PadroneProgressMessage | ((result: TRes) => PadroneProgressMessage);
  /** Message shown when the command fails. `null` to suppress. Defaults to the error message. */
  error?: PadroneProgressMessage | ((error: unknown) => PadroneProgressMessage);
};

/**
 * Progress indicator configuration with messages, visual options, and renderer.
 */
export type PadroneProgressConfig<TRes = unknown> = {
  /** Per-phase messages. A string sets the `progress` message; an object configures individual phases. */
  message?: string | PadroneProgressMessages<TRes>;
  /** Spinner configuration. Default `show` is `'auto'` (visible when bar is not shown). `true` forces spinner to always show (even alongside a bar). */
  spinner?: PadroneSpinnerConfig;
  /** Enable a progress bar. `true` for defaults (`show: 'always'`), or a `PadroneBarConfig` object. `false` to disable entirely. When omitted, bar defaults to `show: 'auto'`. */
  bar?: boolean | PadroneBarConfig;
  /** Show elapsed time since the indicator started. Can also be started on demand via `update({ time: true })`. */
  time?: boolean;
  /** Show estimated time remaining based on progress rate. Requires numeric `update()` calls. */
  eta?: boolean;
  /**
   * Custom renderer factory. Called to create the progress indicator.
   * Defaults to the built-in terminal renderer (`createTerminalProgress`).
   */
  renderer?: PadroneProgressRenderer;
  /** Renderer for task lists run with `progress.tasks()`. Defaults to the built-in terminal renderer (`createTerminalTaskList`). */
  taskRenderer?: PadroneTaskListRenderer;
  /** Suppress all progress output. The `progress` interface is still provided on the context as a no-op. */
  silent?: boolean;
};

/**
 * Shared progress defaults that can be provided via context instead of repeating
 * at each call site. Per-instance message fields are excluded — those always come
 * from the constructor argument.
 *
 * Provide via context as `{ progressConfig: PadroneProgressDefaults }`.
 */
export type PadroneProgressDefaults = Pick<
  PadroneProgressConfig,
  'message' | 'spinner' | 'bar' | 'time' | 'eta' | 'renderer' | 'taskRenderer' | 'silent'
>;

/**
 * The progress handle on the command context: the indicator, plus `tasks()` to run a list of tasks, like listr2:
 *
 * ```ts
 * await ctx.context.progress.tasks([
 *   { title: 'Install', task: () => install() },
 *   { title: 'Build', task: (t) => t.tasks([{ title: 'Types', task: tsc }, { title: 'Bundle', task: bundle }], { concurrent: true }) },
 *   { title: 'Deploy', skip: () => !process.env.TOKEN && 'no token', task: deploy },
 * ]);
 * ```
 */
export type PadroneProgressContext = PadroneProgress & { tasks: PadroneTasksFn };

/** Builder/program type after applying `padroneProgress()`. Adds `{ progress: PadroneProgress }` to the command context. */
export type WithProgress<T> = WithInterceptor<T, { progress: PadroneProgressContext }>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const noopEta = { start() {}, stop() {}, reset() {} };
const noopIndicator: PadroneProgress = {
  update() {},
  eta: noopEta,
  succeed() {},
  fail() {},
  stop() {},
  pause() {},
  resume() {},
};

function resolveMessage(field: unknown, value: unknown, fallback?: string): { message: string | null | undefined; indicator?: string } {
  const raw = typeof field === 'function' ? (field as (v: unknown) => unknown)(value) : field;
  if (raw === undefined) return { message: fallback };
  if (raw === null || typeof raw === 'string') return { message: raw };
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as { message?: string | null; indicator?: string };
    return { message: obj.message, indicator: obj.indicator };
  }
  return { message: fallback };
}

type Finish = (isError: boolean, value: unknown, dryRun?: boolean) => void;

/** Wraps an async iterator so `finish` runs when it's exhausted, fails, or is closed early. */
async function* finishAfterAsyncIteration(iterable: AsyncIterable<unknown>, finish: Finish, dryRun?: boolean) {
  const items: unknown[] = [];
  try {
    for await (const item of iterable) {
      items.push(item);
      yield item;
    }
  } catch (err) {
    finish(true, err);
    throw err;
  }
  finish(false, items, dryRun);
}

function* finishAfterIteration(iterable: Iterable<unknown>, finish: Finish, dryRun?: boolean) {
  const items: unknown[] = [];
  try {
    for (const item of iterable) {
      items.push(item);
      yield item;
    }
  } catch (err) {
    finish(true, err);
    throw err;
  }
  finish(false, items, dryRun);
}

function cleanup(indicator: PadroneProgress, msgs: ResolvedMessages, isError: boolean, value: unknown) {
  if (isError) {
    const fallback = value instanceof Error ? value.message : String(value);
    const { message, indicator: icon } = resolveMessage(msgs.error, value, fallback);
    indicator.fail(message, icon !== undefined ? { indicator: icon } : undefined);
  } else {
    const { message, indicator: icon } = resolveMessage(msgs.success, value);
    indicator.succeed(message, icon !== undefined ? { indicator: icon } : undefined);
  }
}

// ---------------------------------------------------------------------------
// Interceptor
// ---------------------------------------------------------------------------

type ResolvedMessages = { progress: string; validation: string; success: unknown; error: unknown };

type ProgressPhaseContext = Pick<InterceptorExecuteContext, 'context' | 'runtime' | 'caller'>;

function resolveMessages(raw: string | PadroneProgressMessages | undefined): ResolvedMessages {
  if (!raw || typeof raw === 'string') {
    return { progress: raw || 'Working...', validation: '', success: undefined, error: undefined };
  }
  return {
    progress: raw.progress ?? 'Working...',
    validation: raw.validation ?? '',
    success: raw.success,
    error: raw.error,
  };
}

function mergeMessages(
  cmd: ResolvedMessages,
  ctx: ResolvedMessages,
  cmdRaw: string | PadroneProgressMessages | undefined,
): ResolvedMessages {
  // String shorthand: all fields come from the string, no context fallback for individual fields
  if (typeof cmdRaw === 'string') return cmd;
  // Object: per-field fallback to context
  const obj = (typeof cmdRaw === 'object' ? cmdRaw : undefined) as PadroneProgressMessages | undefined;
  return {
    progress: obj?.progress !== undefined ? cmd.progress : (ctx.progress ?? cmd.progress),
    validation: obj?.validation !== undefined ? cmd.validation : ctx.validation || cmd.validation,
    success: obj?.success !== undefined ? cmd.success : (ctx.success ?? cmd.success),
    error: obj?.error !== undefined ? cmd.error : (ctx.error ?? cmd.error),
  };
}

function progressInterceptor(config: string | PadroneProgressConfig) {
  const isObj = typeof config === 'object';
  const rawMessage = typeof config === 'string' ? config : isObj ? config.message : undefined;

  function resolveSettings(context: unknown, caller: string) {
    const ctxCfg = (context as { progressConfig?: PadroneProgressDefaults } | undefined)?.progressConfig;
    // Constructor values win; undefined means "not set by caller"
    const spinner = (isObj ? config.spinner : undefined) ?? ctxCfg?.spinner;
    const bar = (isObj ? config.bar : undefined) ?? ctxCfg?.bar;
    const time = (isObj ? config.time : undefined) ?? ctxCfg?.time;
    const eta = (isObj ? config.eta : undefined) ?? ctxCfg?.eta;
    const options: PadroneProgressOptions | undefined =
      spinner !== undefined || bar !== undefined || time !== undefined || eta !== undefined ? { spinner, bar, time, eta } : undefined;
    return {
      // Serve, MCP and tool calls have no terminal to draw on
      silent: isRemoteCaller(caller) || ((isObj ? config.silent : undefined) ?? ctxCfg?.silent ?? false),
      renderer: (isObj ? config.renderer : undefined) ?? ctxCfg?.renderer ?? createTerminalProgress,
      taskRenderer: (isObj ? config.taskRenderer : undefined) ?? ctxCfg?.taskRenderer ?? createTerminalTaskList,
      options,
      msgs: mergeMessages(resolveMessages(rawMessage), resolveMessages(ctxCfg?.message), rawMessage),
    };
  }

  return defineInterceptor({ id: 'padrone:progress', name: 'padrone:progress' })
    .requires<{ progressConfig?: PadroneProgressDefaults }>()
    .factory(() => {
      let settings: ReturnType<typeof resolveSettings> | undefined;
      let indicator: PadroneProgress | undefined;
      let restoreOutput: (() => void) | undefined;
      let activeTaskList: ReturnType<PadroneTaskListRenderer> | undefined;

      /** `progress.tasks()`: hides the indicator while the list is drawn. */
      const tasksFor =
        (signal: AbortSignal): PadroneTasksFn =>
        async (tasks, options) => {
          const { silent, taskRenderer } = settings!;
          const states: PadroneTaskState[] = [];
          const list = silent ? noopTaskRenderer(states) : taskRenderer(states);
          const outer = activeTaskList;
          (outer ?? indicator)?.pause();
          activeTaskList = list;
          try {
            await runTaskList(tasks, options ?? {}, states as never, () => list.update(), signal);
          } finally {
            list.done();
            activeTaskList = outer;
            (outer ?? indicator)?.resume();
          }
        };

      const resolve = (ctx: { context?: unknown; caller: string }) => (settings ??= resolveSettings(ctx.context, ctx.caller));

      /** Creates the indicator and routes runtime output through pause/resume. No-op if already started or silent. */
      const start = (ctx: ProgressPhaseContext, message: string) => {
        const { silent, renderer, options } = resolve(ctx);
        if (silent || indicator) return;
        const active = renderer(message, options);
        indicator = active;

        const { runtime } = ctx;
        const originalOutput = runtime.output;
        const originalError = runtime.error;
        const originals = { prompt: runtime.prompt, editor: runtime.editor, page: runtime.page };
        // While a task list is drawn, output pauses the list instead of the (already hidden) indicator
        const drawn = () => activeTaskList ?? active;
        runtime.output = (...args: unknown[]) => {
          const current = drawn();
          current.pause();
          originalOutput(...args);
          current.resume();
        };
        runtime.error = (text: string) => {
          const current = drawn();
          current.pause();
          originalError(text);
          current.resume();
        };
        // Prompts (e.g. `padroneConfirm()`), the editor and the pager take over the terminal: the indicator is hidden meanwhile
        const hiddenDuring =
          <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>) =>
          async (...args: TArgs): Promise<TResult> => {
            const current = drawn();
            current.pause();
            try {
              return await fn.apply(runtime, args);
            } finally {
              current.resume();
            }
          };
        if (originals.prompt) runtime.prompt = hiddenDuring(originals.prompt);
        runtime.editor = hiddenDuring(originals.editor);
        runtime.page = hiddenDuring(originals.page);
        restoreOutput = () => {
          runtime.output = originalOutput;
          runtime.error = originalError;
          Object.assign(runtime, originals);
        };
      };

      /** Stops the indicator with the configured success/error message (none for a dry run). Runs at most once. */
      const finish = (isError: boolean, value: unknown, dryRun = false) => {
        const active = indicator;
        if (!active) return;
        restoreOutput?.();
        indicator = undefined;
        restoreOutput = undefined;
        try {
          if (dryRun && !isError) active.stop();
          else cleanup(active, settings!.msgs, isError, value);
        } catch (err) {
          active.stop();
          throw err;
        }
      };

      return {
        validate(ctx, next) {
          const { msgs } = resolve(ctx);
          start(ctx, msgs.validation || msgs.progress);

          const checkResult = (result: InterceptorValidateResult) => {
            if (result.argsResult?.issues) finish(true, new Error('Validation failed'));
            return result;
          };
          const onError = (err: unknown): never => {
            finish(true, err);
            throw err;
          };

          let result: InterceptorValidateResult | Promise<InterceptorValidateResult>;
          try {
            result = next();
          } catch (err) {
            return onError(err);
          }
          return result instanceof Promise ? result.then(checkResult, onError) : checkResult(result);
        },

        execute(ctx, next) {
          const { silent, msgs } = resolve(ctx);
          if (silent) return next({ context: { progress: { ...noopIndicator, tasks: tasksFor(ctx.signal) } } });

          // `run()` skips validation, so the indicator may not exist yet
          if (indicator) {
            if (msgs.validation) indicator.update(msgs.progress);
          } else {
            start(ctx, msgs.progress);
          }

          const onError = (err: unknown): never => {
            finish(true, err);
            throw err;
          };
          // A streamed result succeeds once it's fully consumed (by auto-output or the caller)
          const settleValue = (value: unknown): unknown => {
            if (isAsyncIterator(value)) return finishAfterAsyncIteration(value as unknown as AsyncIterable<unknown>, finish, ctx.dryRun);
            if (isIterator(value) && !Array.isArray(value))
              return finishAfterIteration(value as unknown as Iterable<unknown>, finish, ctx.dryRun);
            finish(false, value, ctx.dryRun);
            return value;
          };
          const settle = (r: InterceptorExecuteResult): InterceptorExecuteResult => {
            if (!(r.result instanceof Promise)) return { ...r, result: settleValue(r.result) };
            return { ...r, result: r.result.then(settleValue, onError) };
          };

          let result: InterceptorExecuteResult | Promise<InterceptorExecuteResult>;
          try {
            result = next({ context: { progress: { ...(indicator ?? noopIndicator), tasks: tasksFor(ctx.signal) } } });
          } catch (err) {
            return onError(err);
          }
          return result instanceof Promise ? result.then(settle, onError) : settle(result);
        },

        shutdown(ctx, next) {
          // Safety net: if validate/execute cleanup paths were bypassed (e.g., outer interceptor
          // threw during execute before reaching this interceptor's execute handler), stop the indicator.
          finish(!!ctx.error, ctx.error ?? ctx.result);
          return next();
        },
      };
    })
    .provides<{ progress: PadroneProgressContext }>();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Extension that adds an auto-managed progress indicator to the command pipeline.
 *
 * - `string` — a single message used for all states.
 * - `PadroneProgressConfig` — separate messages for validation, progress, success, and error.
 *
 * The indicator is automatically started before validation (or before the action for `run()`),
 * updated at each phase transition, and stopped on success (`.succeed()`) or failure (`.fail()`).
 *
 * Provides `{ progress: PadroneProgressContext }` on the command context.
 * Access it in action handlers as `ctx.context.progress`; `progress.tasks([...])` runs a list of tasks
 * (sequential or concurrent, with subtasks and skips), drawn as a live list like listr2.
 *
 * Uses the built-in terminal renderer by default. Pass a custom `renderer` for non-terminal
 * environments (web UIs, testing, etc). Serve, MCP and `tool()` calls get a no-op indicator.
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli')
 *   .command('sync', (c) =>
 *     c.extend(padroneProgress('Syncing...'))
 *       .action((_args, ctx) => {
 *         ctx.context.progress.update('halfway');
 *       })
 *   )
 * ```
 */
export function padroneProgress<T extends CommandTypesBase>(config?: string | PadroneProgressConfig): (builder: T) => WithProgress<T> {
  return ((builder: AnyPadroneBuilder) => builder.intercept(progressInterceptor(config ?? 'Working...'))) as any;
}
