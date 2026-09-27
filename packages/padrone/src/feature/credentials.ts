import { ConfigError, PadroneError } from '../core/errors.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** Result of a command run by a `PadroneCommandRunner`. `code` is 127 when the program isn't installed. */
export type PadroneCommandRunResult = { code: number; stdout: string; stderr: string };

/**
 * Runs a program with argv (never through a shell), writing `input` to its stdin. Injected into keychain backends so tests
 * and custom environments never touch the real keychain. The default spawns with `node:child_process`.
 */
export type PadroneCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { input?: string },
) => Promise<PadroneCommandRunResult>;

/** Where secrets are kept. `service` scopes them (the program name by default); `name` is the credential's name. */
export type PadroneCredentialBackend = {
  /** Shown by `credentials.backend()`, e.g. `'keychain'`, `'secret-service'`, `'file'`. */
  readonly name: string;
  get(service: string, name: string): Promise<string | undefined>;
  set(service: string, name: string, secret: string): Promise<void>;
  delete(service: string, name: string): Promise<void>;
  /** Whether the backend works here (its tool is installed and reachable). Assumed when missing. */
  available?(): Promise<boolean>;
};

// ── Runner ───────────────────────────────────────────────────────────────

/** Spawns `command` with argv and no shell, writes `input` to stdin, and collects its output. */
export const spawnCommandRunner: PadroneCommandRunner = async (command, args, options) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: PadroneCommandRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child.stdout.setEncoding('utf-8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf-8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err: NodeJS.ErrnoException) => settle({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: err.message }));
    child.on('close', (code) => settle({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(options?.input ?? '');
  });
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Names and services must be non-empty and free of control characters (they end up in keychain commands). */
export function checkCredentialName(kind: 'service' | 'name', value: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value))
    throw new PadroneError(`Invalid credential ${kind}: ${JSON.stringify(value)}`);
}

const failure = (tool: string, action: string, result: PadroneCommandRunResult) =>
  new PadroneError(`${tool} could not ${action} the credential: ${result.stderr.trim() || `exit code ${result.code}`}`);

// ── macOS Keychain ───────────────────────────────────────────────────────

/** Secrets that aren't printable ASCII are stored base64-encoded behind this prefix, as `security -w` prints others in hex. */
const ENCODED_PREFIX = 'padrone-base64:';
/** `security -i` reads commands of up to this many bytes. */
const SECURITY_LINE_LIMIT = 4096;

/**
 * The macOS login keychain through `/usr/bin/security` (generic passwords: `-s <service> -a <name>`).
 * Secrets are written through `security -i` on stdin (hex-encoded with `-X`), so they never appear in `ps`; names do.
 */
export function macosKeychainBackend(runner: PadroneCommandRunner = spawnCommandRunner): PadroneCredentialBackend {
  const quote = (kind: string, value: string) => {
    if (/["\\]/.test(value)) throw new PadroneError(`Credential ${kind}s stored in the macOS keychain can't contain quotes or backslashes`);
    return `"${value}"`;
  };
  return {
    name: 'keychain',
    async available() {
      return (await runner('security', ['list-keychains'])).code === 0;
    },
    async get(service, name) {
      const result = await runner('security', ['find-generic-password', '-s', service, '-a', name, '-w']);
      if (result.code === 44) return undefined;
      if (result.code !== 0) throw failure('security', 'read', result);
      const value = result.stdout.replace(/\n$/, '');
      return value.startsWith(ENCODED_PREFIX) ? Buffer.from(value.slice(ENCODED_PREFIX.length), 'base64').toString('utf-8') : value;
    },
    async set(service, name, secret) {
      const plain = /^[\x20-\x7e]*$/.test(secret) && !secret.startsWith(ENCODED_PREFIX);
      const stored = plain ? secret : `${ENCODED_PREFIX}${Buffer.from(secret, 'utf-8').toString('base64')}`;
      const hex = Buffer.from(stored, 'utf-8').toString('hex');
      const line = `add-generic-password -U -s ${quote('service', service)} -a ${quote('name', name)} -X ${hex}\n`;
      if (Buffer.byteLength(line) > SECURITY_LINE_LIMIT) throw new PadroneError('The secret is too long for the macOS keychain');
      const result = await runner('security', ['-i'], { input: line });
      if (result.code !== 0 || result.stderr.trim()) throw failure('security', 'store', result);
    },
    async delete(service, name) {
      const result = await runner('security', ['delete-generic-password', '-s', service, '-a', name]);
      if (result.code !== 0 && result.code !== 44) throw failure('security', 'delete', result);
    },
  };
}

// ── Secret Service (libsecret) ───────────────────────────────────────────

/**
 * The Secret Service (GNOME Keyring, KWallet) through libsecret's `secret-tool`, with the `service` and `account`
 * attributes keytar uses. Secrets go through stdin, never argv.
 */
export function secretServiceBackend(runner: PadroneCommandRunner = spawnCommandRunner): PadroneCredentialBackend {
  const attributes = (service: string, name: string) => ['service', service, 'account', name];
  return {
    name: 'secret-service',
    async available() {
      // A lookup that finds nothing exits 1 quietly; without a reachable Secret Service (no D-Bus session) it prints an error
      const result = await runner('secret-tool', ['lookup', 'padrone-probe', '1']);
      return result.code === 0 || (result.code === 1 && !result.stderr.trim());
    },
    async get(service, name) {
      const result = await runner('secret-tool', ['lookup', ...attributes(service, name)]);
      if (result.code === 0) return result.stdout;
      if (result.code === 1 && !result.stderr.trim()) return undefined;
      throw failure('secret-tool', 'read', result);
    },
    async set(service, name, secret) {
      const result = await runner('secret-tool', ['store', '--label', `${service} (${name})`, ...attributes(service, name)], {
        input: secret,
      });
      if (result.code !== 0) throw failure('secret-tool', 'store', result);
    },
    async delete(service, name) {
      const result = await runner('secret-tool', ['clear', ...attributes(service, name)]);
      if (result.code !== 0 && result.stderr.trim()) throw failure('secret-tool', 'delete', result);
    },
  };
}

// ── File ─────────────────────────────────────────────────────────────────

type CredentialFile = Record<string, Record<string, string>>;

/**
 * A JSON file of `{ [service]: { [name]: secret } }`, written atomically with mode `0600` in a `0700` directory.
 * The secrets are stored in plain text, readable by the user's own processes (like `gh`'s `hosts.yml`); on Windows the modes don't apply.
 */
export function fileCredentialBackend(file: string): PadroneCredentialBackend {
  const read = async (): Promise<CredentialFile> => {
    const fs = await import('node:fs');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch (err) {
      throw new ConfigError(`Invalid credentials file ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    throw new ConfigError(`Invalid credentials file ${file}: must be an object`);
  };
  const write = async (data: CredentialFile) => {
    const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${globalThis.process?.pid ?? 0}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  };
  return {
    name: 'file',
    async get(service, name) {
      const secret = (await read())[service]?.[name];
      return typeof secret === 'string' ? secret : undefined;
    },
    async set(service, name, secret) {
      const data = await read();
      data[service] = { ...data[service], [name]: secret };
      await write(data);
    },
    async delete(service, name) {
      const data = await read();
      const entries = data[service];
      if (!entries || !Object.hasOwn(entries, name)) return;
      const { [name]: _, ...rest } = entries;
      if (Object.keys(rest).length) data[service] = rest;
      else delete data[service];
      await write(data);
    },
  };
}

/** The platform's keychain backend, if Padrone has one for it (Windows has none). */
export function platformKeychainBackend(platform: string | undefined, runner: PadroneCommandRunner): PadroneCredentialBackend | undefined {
  if (platform === 'darwin') return macosKeychainBackend(runner);
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return secretServiceBackend(runner);
  return undefined;
}
