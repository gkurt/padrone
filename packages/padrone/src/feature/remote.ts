import type { IncomingHttpHeaders } from 'node:http';
import type { CollectedEndpoint } from '../core/commands.ts';
import { exposeRefusal } from '../core/commands.ts';
import type { AnyPadroneCommand, PadroneCaller } from '../types/index.ts';

/**
 * Commands to offer: paths (`'db migrate'` or `'db.migrate'`) and globs over them (`*` any part of one name, `**` any number
 * of names, so `'db.**'` is `db` and everything under it; the root program's path is empty, matched by `'**'`),
 * or a predicate.
 */
export type PadroneCommandFilter = readonly string[] | ((command: AnyPadroneCommand) => boolean);

/** Options `serve()` and `mcp()` share (for `mcp()`, `auth`, `bearer` and `allowedHosts` apply to the HTTP transport). */
export type PadroneRemotePreferences = {
  /**
   * Authenticates each request (the CORS preflight and serve's `/_health` excepted): return who made it, available to actions
   * and interceptors as `ctx.auth`, or a falsy value to refuse it with 401. Runs after `bearer` when both are set.
   */
  auth?: (req: Request) => unknown;
  /** Accepted bearer tokens (`Authorization: Bearer <token>`); other requests get 401. `ctx.auth` is `{ token }`. */
  bearer?: string | readonly string[];
  /**
   * `Host` names answered besides loopback ones and the bound host (`.example.com` also allows its subdomains), so a server
   * bound to a LAN or public address is protected from DNS rebinding too; others get 403. `true` / `'all'` allows any host.
   * Default: loopback names only when bound to a loopback host, any host otherwise.
   */
  allowedHosts?: readonly string[] | true | 'all';
  /** Only offer these commands (see `PadroneCommandFilter`). Others are neither listed nor run. */
  include?: PadroneCommandFilter;
  /** Never offer these commands (see `PadroneCommandFilter`). */
  exclude?: PadroneCommandFilter;
  /** Longest a command may run, in ms: then its signal is aborted and the request fails (serve: 504). Default: no limit. */
  timeout?: number;
  /** Most commands running at once; a request over it fails right away (serve: 503). Default: no limit. */
  maxConcurrent?: number;
  /** The context each call's command receives, like `eval()`'s `context`. The `serve`/`mcp` commands pass on the one given to `cli()`. */
  context?: unknown;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathParts = (path: string) => path.split(/[\s.]+/).filter(Boolean);

function matchParts(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === '**') return matchParts(rest, path) || (path.length > 0 && matchParts(pattern, path.slice(1)));
  const regex = new RegExp(`^${head.split('*').map(escapeRegExp).join('.*')}$`);
  return path.length > 0 && regex.test(path[0]!) && matchParts(rest, path.slice(1));
}

/** Whether a command path (`db migrate`) matches a pattern of `PadroneCommandFilter`. */
export function matchesCommandPattern(pattern: string, path: string): boolean {
  return matchParts(pathParts(pattern), pathParts(path));
}

/** The `include` / `exclude` preferences as one predicate of a command and its path (`db.migrate`, `''` for the root). */
export function createCommandFilter(prefs: Pick<PadroneRemotePreferences, 'include' | 'exclude'> | undefined) {
  const matches = (filter: PadroneCommandFilter, command: AnyPadroneCommand, path: string) =>
    typeof filter === 'function' ? filter(command) : filter.some((pattern) => matchesCommandPattern(pattern, path));
  return (command: AnyPadroneCommand, path: string) =>
    (!prefs?.include || matches(prefs.include, command, path)) && !(prefs?.exclude && matches(prefs.exclude, command, path));
}

/**
 * The command tree as a remote caller may see it, for help output: the offered commands, the groups leading to them and the
 * built-ins it can run, so help doesn't list what `include` / `exclude` / `expose` withhold (or hidden commands).
 * `of(command)` is the copy of a command in the view.
 */
export function createOfferedView(root: AnyPadroneCommand, endpoints: readonly CollectedEndpoint[], caller: PadroneCaller) {
  const offered = new Set<AnyPadroneCommand>(endpoints.map((endpoint) => endpoint.command));
  const copies = new Map<AnyPadroneCommand, AnyPadroneCommand>();
  const keep = (command: AnyPadroneCommand): boolean =>
    offered.has(command) || (!!command.builtin && !exposeRefusal(command, caller)) || !!command.commands?.some(keep);
  const copy = (command: AnyPadroneCommand, parent: AnyPadroneCommand | undefined): AnyPadroneCommand => {
    const clone = { ...command, parent };
    copies.set(command, clone);
    clone.commands = command.commands?.filter(keep).map((sub) => copy(sub, clone));
    return clone;
  };
  const view = copy(root, root.parent);
  return { root: view, of: (command: AnyPadroneCommand) => copies.get(command) ?? view };
}

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Compares digests in constant time, so response timing doesn't tell how much of a token was right. */
async function isSameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * The request authenticator for `auth` / `bearer`, or `undefined` when neither is set. It resolves to who made the request,
 * or a falsy value when it's refused.
 */
export function createAuthenticator(prefs: Pick<PadroneRemotePreferences, 'auth' | 'bearer'> | undefined) {
  const tokens = prefs?.bearer === undefined ? undefined : [prefs.bearer].flat();
  const auth = prefs?.auth;
  if (!tokens && !auth) return undefined;
  return async (req: Request): Promise<unknown> => {
    let identity: unknown;
    if (tokens) {
      const token = /^bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim();
      if (!token) return undefined;
      const matches = await Promise.all(tokens.map((accepted) => isSameSecret(token, accepted)));
      if (!matches.includes(true)) return undefined;
      identity = { token };
    }
    return auth ? auth(req) : identity;
  };
}

/** How a limited call ended: its value, refused over `maxConcurrent`, or aborted after `timeout`. */
export type LimitedCall<T> = { status: 'done'; value: T } | { status: 'busy' } | { status: 'timeout' };

/**
 * Runs calls within `timeout` and `maxConcurrent`. A call that times out has its controller aborted (with a `TimeoutError`)
 * and keeps its slot until it actually settles.
 */
export function createCallLimiter(prefs: Pick<PadroneRemotePreferences, 'timeout' | 'maxConcurrent'> | undefined) {
  let running = 0;
  const { timeout, maxConcurrent } = prefs ?? {};
  return async <T>(controller: AbortController, run: () => T | PromiseLike<T>): Promise<LimitedCall<T>> => {
    if (maxConcurrent !== undefined && running >= maxConcurrent) return { status: 'busy' };
    running++;
    let started: Promise<T>;
    try {
      // Started right away: a cancellation that comes next finds it running
      started = Promise.resolve(run());
    } catch (error) {
      started = Promise.reject(error);
    }
    const call = started.finally(() => running--);
    const done = call.then((value): LimitedCall<T> => ({ status: 'done', value }));
    if (timeout === undefined) return done;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<LimitedCall<T>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException(`Timed out after ${timeout} ms`, 'TimeoutError'));
        resolve({ status: 'timeout' });
      }, timeout);
    });
    try {
      return await Promise.race([done, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** An abort controller that also aborts when `signal` does; `dispose()` stops following it. */
export function linkedController(signal: AbortSignal | undefined): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const follow = () => controller.abort(signal?.reason);
  if (signal?.aborted) follow();
  else signal?.addEventListener('abort', follow, { once: true });
  return { controller, dispose: () => signal?.removeEventListener('abort', follow) };
}

/** A Node request's headers as fetch `Headers`. */
export function toFetchHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value) result.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return result;
}

/** The URL origin of a server bound to `host` (IPv6 hosts need brackets). */
export function serverBaseUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}
