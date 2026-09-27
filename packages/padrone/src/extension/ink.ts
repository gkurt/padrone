import { defineInterceptor } from '../core/interceptors.ts';
import type { AnyPadroneBuilder, CommandTypesBase } from '../types/index.ts';
import type { InterceptorExecuteResult } from '../types/interceptor.ts';
import { isRemoteCaller } from './utils.ts';

// ── React element detection ─────────────────────────────────────────────

const reactElement = Symbol.for('react.element');
const reactTransitional = Symbol.for('react.transitional.element');

/** Checks whether a value is a React element (JSX) by inspecting its `$$typeof` symbol. */
export function isReactElement(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const tag = (value as Record<string | symbol, unknown>).$$typeof;
  return tag === reactElement || tag === reactTransitional;
}

// ── Types ───────────────────────────────────────────────────────────────

export type InkOptions = {
  /** Whether to wait for the Ink app to unmount before resolving. Defaults to `true`. */
  waitUntilExit?: boolean;
  /** Options forwarded to Ink's `render()`. */
  render?: import('ink').RenderOptions;
  /**
   * What serve, MCP and `tool()` calls (no terminal) get as the result:
   * - `'first-frame'` (default): the element's first frame as text (Ink's `renderToString`).
   * - `'exit'`: the app is mounted headlessly and its last frame is returned once it calls `exit()`
   *   (or after `remoteTimeout`), so components that load data return their final output.
   */
  remote?: 'first-frame' | 'exit';
  /** With `remote: 'exit'`, how long to wait for the app to exit before returning its current frame. Defaults to 10 seconds. */
  remoteTimeout?: number;
};

// ── Interceptor ─────────────────────────────────────────────────────────

const inkMeta = { id: 'padrone:ink', name: 'padrone:ink', order: -1050 } as const;

/** Mounts an element on in-memory streams in non-interactive mode, which writes only the final frame, and returns that frame. */
async function renderHeadless(ink: typeof import('ink'), element: unknown, signal: AbortSignal, timeout: number): Promise<string> {
  signal.throwIfAborted();
  const { PassThrough, Writable } = await import('node:stream');
  let frame = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        frame += String(chunk);
        callback();
      },
    }),
    { isTTY: false, columns: 80, rows: 24 },
  );
  // A TTY-like stdin that never sends input, so components using `useInput` render instead of failing on raw mode
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
  const instance = ink.render(element as import('react').ReactElement, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    interactive: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  // A render error is the call's error: Ink's error box (with source lines) isn't a result to send to a remote caller
  let renderError: { error: unknown } | undefined;
  const exited = instance.waitUntilExit().catch((error: unknown) => {
    renderError = { error };
  });
  const stop = () => instance.unmount();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
    instance.unmount();
    await exited;
    if (renderError) throw renderError.error;
    signal.throwIfAborted();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    stdin.destroy();
  }
  return frame.replace(/\n+$/, '');
}

function createInkInterceptor(rawOptions?: InkOptions) {
  return defineInterceptor(inkMeta)
    .requires<{ inkConfig?: InkOptions }>()
    .factory(() => ({
      execute(ctx, next) {
        const ctxCfg = (ctx.context as Record<string, unknown> | undefined)?.inkConfig as InkOptions | undefined;
        const options: InkOptions = { ...ctxCfg, ...rawOptions };
        const { waitUntilExit = true } = options;

        const renderElement = async (element: unknown): Promise<unknown> => {
          const ink = await import('ink');
          // Serve, MCP and tool calls have no terminal: they get the output as text
          if (isRemoteCaller(ctx.caller)) {
            if (options.remote === 'exit') return renderHeadless(ink, element, ctx.signal, options.remoteTimeout ?? 10_000);
            const { renderToString } = ink as { renderToString?: (node: unknown, options?: { columns?: number }) => string };
            if (!renderToString)
              throw new Error('Returning Ink elements from serve, MCP or tool calls needs an Ink version with renderToString');
            return renderToString(element);
          }
          ctx.signal.throwIfAborted();
          const instance = ink.render(element as import('react').ReactElement, options.render);

          // Unmount on abort so Ink cleans up stdin/stdout
          const onAbort = () => instance.unmount();
          ctx.signal.addEventListener('abort', onAbort, { once: true });
          if (!waitUntilExit) {
            instance.waitUntilExit().finally(() => ctx.signal.removeEventListener('abort', onAbort));
            return undefined;
          }
          try {
            await instance.waitUntilExit();
          } finally {
            ctx.signal.removeEventListener('abort', onAbort);
          }
          // Undefined so auto-output skips this result
          return undefined;
        };

        // Sync commands stay sync unless they return an element
        const handleResult = (e: InterceptorExecuteResult): InterceptorExecuteResult => {
          if (e.result instanceof Promise) return { result: e.result.then((v) => (isReactElement(v) ? renderElement(v) : v)) };
          return isReactElement(e.result) ? { result: renderElement(e.result) } : e;
        };

        const executedOrPromise = next();
        if (executedOrPromise instanceof Promise) return executedOrPromise.then(handleResult);
        return handleResult(executedOrPromise);
      },
    }));
}

// ── Extension ───────────────────────────────────────────────────────────

/**
 * Extension that renders React (Ink) components returned from command actions.
 *
 * When a command's action returns a React element (JSX), this extension
 * renders it using Ink instead of passing it to the normal output path.
 * For serve, MCP and `tool()` calls, which have no terminal, the result is the element's first frame
 * as text (Ink's `renderToString`), or its last frame with `remote: 'exit'`.
 *
 * Requires `ink` and `react` as peer dependencies.
 *
 * ```ts
 * import { createPadrone } from 'padrone';
 * import { padroneInk } from 'padrone/ink';
 *
 * const program = createPadrone('my-tui')
 *   .extend(padroneInk())
 *   .command('dashboard', (c) =>
 *     c.action(() => <Dashboard />)
 *   );
 * ```
 */
export function padroneInk(options?: InkOptions): <T extends CommandTypesBase>(builder: T) => T {
  const interceptor = createInkInterceptor(options);
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
