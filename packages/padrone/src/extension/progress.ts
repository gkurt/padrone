import { defineInterceptor } from '../core/interceptors.ts';
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
export type PadroneProgressDefaults = Pick<PadroneProgressConfig, 'message' | 'spinner' | 'bar' | 'time' | 'eta' | 'renderer' | 'silent'>;

/** Builder/program type after applying `padroneProgress()`. Adds `{ progress: PadroneProgress }` to the command context. */
export type WithProgress<T> = WithInterceptor<T, { progress: PadroneProgress }>;

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

type ProgressPhaseContext = Pick<InterceptorExecuteContext, 'context' | 'runtime'>;

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

  function resolveSettings(context: unknown) {
    const ctxCfg = (context as { progressConfig?: PadroneProgressDefaults } | undefined)?.progressConfig;
    // Constructor values win; undefined means "not set by caller"
    const spinner = (isObj ? config.spinner : undefined) ?? ctxCfg?.spinner;
    const bar = (isObj ? config.bar : undefined) ?? ctxCfg?.bar;
    const time = (isObj ? config.time : undefined) ?? ctxCfg?.time;
    const eta = (isObj ? config.eta : undefined) ?? ctxCfg?.eta;
    const options: PadroneProgressOptions | undefined =
      spinner !== undefined || bar !== undefined || time !== undefined || eta !== undefined ? { spinner, bar, time, eta } : undefined;
    return {
      silent: (isObj ? config.silent : undefined) ?? ctxCfg?.silent ?? false,
      renderer: (isObj ? config.renderer : undefined) ?? ctxCfg?.renderer ?? createTerminalProgress,
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

      const resolve = (ctx: { context?: unknown }) => (settings ??= resolveSettings(ctx.context));

      /** Creates the indicator and routes runtime output through pause/resume. No-op if already started or silent. */
      const start = (ctx: ProgressPhaseContext, message: string) => {
        const { silent, renderer, options } = resolve(ctx);
        if (silent || indicator) return;
        const active = renderer(message, options);
        indicator = active;

        const { runtime } = ctx;
        const originalOutput = runtime.output;
        const originalError = runtime.error;
        runtime.output = (...args: unknown[]) => {
          active.pause();
          originalOutput(...args);
          active.resume();
        };
        runtime.error = (text: string) => {
          active.pause();
          originalError(text);
          active.resume();
        };
        restoreOutput = () => {
          runtime.output = originalOutput;
          runtime.error = originalError;
        };
      };

      /** Stops the indicator with the configured success/error message. Runs at most once. */
      const finish = (isError: boolean, value: unknown) => {
        const active = indicator;
        if (!active) return;
        restoreOutput?.();
        indicator = undefined;
        restoreOutput = undefined;
        try {
          cleanup(active, settings!.msgs, isError, value);
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
          if (silent) return next({ context: { progress: noopIndicator } });

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
          const settle = (r: InterceptorExecuteResult): InterceptorExecuteResult => {
            if (!(r.result instanceof Promise)) {
              finish(false, r.result);
              return r;
            }
            const result = r.result.then((value: unknown) => {
              finish(false, value);
              return value;
            }, onError);
            return { ...r, result };
          };

          let result: InterceptorExecuteResult | Promise<InterceptorExecuteResult>;
          try {
            result = next({ context: { progress: indicator ?? noopIndicator } });
          } catch (err) {
            return onError(err);
          }
          return result instanceof Promise ? result.then(settle, onError) : settle(result);
        },

        shutdown(ctx) {
          // Safety net: if validate/execute cleanup paths were bypassed (e.g., outer interceptor
          // threw during execute before reaching this interceptor's execute handler), stop the indicator.
          finish(!!ctx.error, ctx.error ?? ctx.result);
        },
      };
    })
    .provides<{ progress: PadroneProgress }>();
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
 * Provides `{ progress: PadroneProgress }` on the command context.
 * Access it in action handlers as `ctx.context.progress`.
 *
 * Uses the built-in terminal renderer by default. Pass a custom `renderer` for non-terminal
 * environments (web UIs, testing, etc).
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
