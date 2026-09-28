import { ActionError, PadroneError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import {
  checkCredentialName,
  fileCredentialBackend,
  type PadroneCommandRunner,
  type PadroneCredentialBackend,
  platformKeychainBackend,
  spawnCommandRunner,
} from '../feature/credentials.ts';
import type { AnyPadroneBuilder, CommandTypesBase } from '../types/index.ts';
import { getProgramDirs } from '../util/dirs.ts';
import type { WithInterceptor } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import { isRemoteCaller } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** Stored secrets (tokens, API keys) of the program, as `ctx.context.credentials`. */
export type PadroneCredentials = {
  /** The secret stored under `name`, or `undefined`. */
  get(name: string): Promise<string | undefined>;
  /** Stores `secret` under `name`, replacing any previous one. */
  set(name: string, secret: string): Promise<void>;
  /** Removes the secret stored under `name`, if any. */
  delete(name: string): Promise<void>;
  /** The names of the stored secrets. Fails for a custom backend without `list`. */
  list(): Promise<string[]>;
  /** The backend in use: `'keychain'` (macOS), `'secret-service'` (Linux), `'file'`, or a custom backend's name. */
  backend(): Promise<string>;
};

export type PadroneCredentialsOptions = {
  /** Keychain service the secrets are stored under. Defaults to the program name. */
  service?: string;
  /**
   * Where secrets are stored. Defaults to `'auto'`: the OS keychain when its tool works (macOS `security`, Linux `secret-tool`),
   * else the file. `'keychain'` fails where there's none (Windows, or no Secret Service), `'file'` always uses the file.
   * A `PadroneCredentialBackend` object stores them elsewhere.
   */
  backend?: 'auto' | 'keychain' | 'file' | PadroneCredentialBackend;
  /** The file backend's JSON file. Defaults to `credentials.json` in the program's data directory (`program.dirs.data`). */
  file?: string;
  /**
   * Whether remote callers (`serve`, `mcp`, `tool`) can use the credentials. Defaults to `false`: their calls reject, so a
   * command that reads a token can't hand it to an HTTP client or an AI model.
   */
  remote?: boolean;
  /** Runs `security` / `secret-tool` (argv, no shell). For tests and custom environments; defaults to spawning them. */
  runner?: PadroneCommandRunner;
  /** The platform deciding the keychain backend and the data directory. Defaults to `process.platform`. */
  platform?: string;
};

export type WithCredentials<T> = WithInterceptor<T, { credentials: PadroneCredentials }>;

// ── Interceptor ─────────────────────────────────────────────────────────

function createCredentialsInterceptor(options: PadroneCredentialsOptions) {
  const platform = options.platform ?? globalThis.process?.platform;
  const keychain = platformKeychainBackend(platform, options.runner ?? spawnCommandRunner);
  let keychainWorks: Promise<boolean> | undefined;
  const probeKeychain = (backend: PadroneCredentialBackend) =>
    (keychainWorks ??= Promise.resolve(backend.available?.() ?? true).catch(() => false));

  const fileBackend = (programName: string, runtime: ResolvedPadroneRuntime) => {
    const dirs = getProgramDirs(programName, runtime.env(), platform);
    return fileCredentialBackend(options.file ?? `${dirs.data}${platform === 'win32' ? '\\' : '/'}credentials.json`);
  };

  const resolveBackend = async (programName: string, runtime: ResolvedPadroneRuntime): Promise<PadroneCredentialBackend> => {
    const choice = options.backend ?? 'auto';
    if (typeof choice === 'object') return choice;
    if (choice === 'file') return fileBackend(programName, runtime);
    if (choice === 'auto') return keychain && (await probeKeychain(keychain)) ? keychain : fileBackend(programName, runtime);
    if (!keychain) throw new PadroneError(`No OS keychain is supported on ${platform}: use padroneCredentials({ backend: 'file' })`);
    if (!(await probeKeychain(keychain))) {
      const tool = keychain.name === 'keychain' ? 'security' : 'secret-tool (with a running Secret Service)';
      throw new PadroneError(`The OS keychain isn't available: ${tool} is needed`);
    }
    return keychain;
  };

  return defineInterceptor({ id: 'padrone:credentials', name: 'padrone:credentials' }, () => ({
    execute(ctx, next) {
      const programName = getRootCommand(ctx.command).name;
      const service = options.service ?? programName;
      let backend: Promise<PadroneCredentialBackend> | undefined;
      const use = async <T>(name: string | undefined, fn: (backend: PadroneCredentialBackend) => Promise<T>): Promise<T> => {
        if (isRemoteCaller(ctx.caller) && !options.remote) {
          throw new ActionError(`Credentials aren't available to "${ctx.caller}" calls`, {
            command: ctx.command.path || ctx.command.name,
          });
        }
        checkCredentialName('service', service);
        if (name !== undefined) checkCredentialName('name', name);
        return fn(await (backend ??= resolveBackend(programName, ctx.runtime)));
      };
      const credentials: PadroneCredentials = {
        get: (name) => use(name, (b) => b.get(service, name)),
        set: (name, secret) => {
          if (typeof secret !== 'string') return Promise.reject(new PadroneError('A credential secret must be a string'));
          return use(name, (b) => b.set(service, name, secret));
        },
        delete: (name) => use(name, (b) => b.delete(service, name)),
        list: () =>
          use(undefined, async (b) => {
            if (!b.list) throw new PadroneError(`The "${b.name}" credential backend can't list credentials`);
            return b.list(service);
          }),
        backend: () => use(undefined, async (b) => b.name),
      };
      return next({ context: { credentials } });
    },
  }));
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that stores secrets for the program, like `gh auth` or keytar: actions get `ctx.context.credentials`
 * with async `get(name)`, `set(name, secret)`, `delete(name)`, `list()` and `backend()`.
 *
 * - `backend: 'auto'` (default) uses the OS keychain through its CLI tool: macOS `security` (secrets go through
 *   `security -i` on stdin, not argv) or Linux `secret-tool` (libsecret; secrets on stdin). Tools are spawned with argv, never a shell.
 * - Without one (Windows, no `secret-tool`, no Secret Service), a JSON file in `program.dirs.data` with mode `0600`.
 * - Remote callers (`serve`, `mcp`, `tool`) are refused unless `remote: true`.
 *
 * ```ts
 * createPadrone('my-cli')
 *   .extend(padroneCredentials())
 *   .command('login', (c) =>
 *     c.action(async (_, ctx) => {
 *       const token = await ctx.prompt.password('GitHub token');
 *       await ctx.context.credentials.set('github', token);
 *     }),
 *   )
 * ```
 */
export function padroneCredentials<T extends CommandTypesBase>(
  options: PadroneCredentialsOptions = {},
): (builder: T) => WithCredentials<T> {
  return ((builder: AnyPadroneBuilder) => builder.intercept(createCredentialsInterceptor(options))) as any;
}
