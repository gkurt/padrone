import { SignalError, signalExitCode } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import type { PadroneSignal } from '../core/runtime.ts';
import type { AnyPadroneBuilder, CommandTypesBase } from '../types/index.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

const signalMeta = { id: 'padrone:signal', name: 'padrone:signal', order: -2000 } as const;

const signalInterceptor = defineInterceptor(signalMeta, () => {
  const abortController = new AbortController();
  let receivedSignal: PadroneSignal | undefined;
  let lastSignalTime = 0;
  let unsubscribe: (() => void) | undefined;
  const DOUBLE_SIGINT_MS = 2000;

  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  const attachSignalInfo = <T>(result: T): T => {
    if (receivedSignal && result && typeof result === 'object') {
      (result as any).signal = receivedSignal;
      (result as any).exitCode = signalExitCode(receivedSignal);
    }
    return result;
  };

  return {
    start(ctx, next) {
      const runtimeExit = ctx.runtime.exit;
      // Follow the caller's signal (`eval(input, { signal })`) as well as process signals
      const upstream = ctx.signal;
      const onUpstreamAbort = () => abortController.abort(upstream.reason);
      if (upstream.aborted) onUpstreamAbort();
      else upstream.addEventListener('abort', onUpstreamAbort, { once: true });
      const unsubscribeProcess = ctx.runtime.onSignal?.((sig) => {
        const elapsed = Date.now() - lastSignalTime;
        lastSignalTime = Date.now();
        if (abortController.signal.aborted) {
          // A second SIGINT within 2s, or a repeated SIGTERM/SIGHUP, force-exits a command that ignores the abort.
          // The same signal twice in one millisecond is a duplicate delivery, which some runtimes do.
          if (elapsed > 0 && (sig !== 'SIGINT' || elapsed < DOUBLE_SIGINT_MS)) runtimeExit?.(signalExitCode(sig));
          return;
        }
        receivedSignal = sig;
        // A `SignalError` reason, so `signal.throwIfAborted()` or an aborted fetch exits with the signal's code
        abortController.abort(new SignalError(sig));
      });
      unsubscribe = () => {
        unsubscribeProcess?.();
        upstream.removeEventListener('abort', onUpstreamAbort);
      };

      const result = next({ signal: abortController.signal });
      return thenMaybe(result, (r) => {
        cleanup();
        return attachSignalInfo(r);
      });
    },
    error(_ctx, next) {
      return thenMaybe(next(), (er) => {
        if (receivedSignal && er.error !== undefined && !(er.error instanceof SignalError)) {
          er.error = new SignalError(receivedSignal, { cause: er.error });
        }
        return er;
      });
    },
    shutdown(_ctx, next) {
      cleanup();
      return next();
    },
  };
});

// ── Extension ───────────────────────────────────────────────────────────

/**
 * Extension that wires process signal handling (SIGINT, SIGTERM, SIGHUP) into the interceptor lifecycle.
 *
 * - Creates an `AbortController` whose signal is propagated to all downstream phases.
 * - Follows the caller's `signal` (`eval()`/`cli()` preferences), aborting when it aborts.
 * - Subscribes to `runtime.onSignal` to forward OS signals to the abort controller.
 * - Aborts with a `SignalError` as the signal's `reason`.
 * - Implements SIGINT double-tap: two SIGINTs within 2 seconds force-exits the process; so does a repeated SIGTERM or SIGHUP.
 * - Attaches `signal` and `exitCode` to results and errors when interrupted.
 * - Cleans up the signal subscription on completion or failure.
 *
 * Included in the default extensions. Runs at order `-2000` (outermost).
 */
export function padroneSignalHandling(options?: { disabled?: boolean }): <T extends CommandTypesBase>(builder: T) => T {
  const interceptor = options?.disabled ? defineInterceptor({ ...signalMeta, disabled: true }, () => ({})) : signalInterceptor;
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
