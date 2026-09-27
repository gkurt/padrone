import { ConfigError } from '../core/errors.ts';

// ── File resolution ─────────────────────────────────────────────────────

/** Returns ordered list of `.env` file names to load (no fs access). */
export function resolveEnvFiles(modes: string[] = [], local = true, base = true): string[] {
  const files: string[] = [];
  if (base) {
    files.push('.env');
    if (local) files.push('.env.local');
  }
  for (const mode of modes) {
    files.push(`.env.${mode}`);
    if (local) files.push(`.env.${mode}.local`);
  }
  return files;
}

// ── Parser ──────────────────────────────────────────────────────────────

/** Parse a `.env` file string into key-value pairs. */
export function parseEnvFile(content: string): Record<string, string> {
  return Object.fromEntries(parseEnvEntries(content).map(({ key, value }) => [key, value]));
}

type EnvEntry = { key: string; value: string; literal: boolean };

/** Entries in file order; single-quoted values are `literal` (not expanded). */
function parseEnvEntries(content: string): EnvEntry[] {
  const result: EnvEntry[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    // Only the start is trimmed: the end of the line may be inside a multiline value
    const line = lines[i]!.trimStart();
    i++;

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    // Strip optional `export ` prefix
    const stripped = line.startsWith('export ') ? line.slice(7) : line;

    const eqIndex = stripped.indexOf('=');
    if (eqIndex === -1) continue;

    const key = stripped.slice(0, eqIndex).trim();
    let raw = stripped.slice(eqIndex + 1);

    // Detect quoted values
    const trimmedRaw = raw.trimStart();
    const quote = trimmedRaw[0];
    const quoted = quote === '"' || quote === "'" || quote === '`' ? readQuoted(lines, i, trimmedRaw.slice(1), quote) : undefined;

    if (quoted) {
      i = quoted.next;
      result.push({ key, value: quote === '"' ? unescapeDoubleQuoted(quoted.value) : quoted.value, literal: quote === "'" });
    } else {
      // Unquoted (or a quote that is never closed): strip inline comments, trim
      const commentIndex = raw.search(/\s#/);
      if (commentIndex !== -1) raw = raw.slice(0, commentIndex);
      result.push({ key, value: raw.trim(), literal: false });
    }
  }

  return result;
}

/**
 * A quoted value whose first line (after the opening quote) is `first`, continuing on the lines from `next` until the
 * closing quote, and the index of the line after it. `undefined` when the quote is never closed.
 */
function readQuoted(lines: readonly string[], next: number, first: string, quote: string): { value: string; next: number } | undefined {
  const parts: string[] = [];
  for (let line = first; ; line = lines[next++]!) {
    const close = findClosingQuote(line, quote);
    if (close !== -1) return { value: [...parts, line.slice(0, close)].join('\n'), next };
    if (next >= lines.length) return undefined;
    parts.push(line);
  }
}

function findClosingQuote(s: string, quote: string): number {
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && quote === '"') {
      i += 2; // skip escaped char
      continue;
    }
    if (s[i] === quote) return i;
    i++;
  }
  return -1;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/** One pass, so `\\n` is a backslash and `n`; other escapes (like `\$`) are kept for variable expansion. */
function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\([nrt"\\])/g, (_, ch: string) => ESCAPES[ch]!);
}

// ── Variable expansion ──────────────────────────────────────────────────

/** The `}` that closes a `${` whose body starts at `start`, past nested `${...}` in a default. */
function findClosingBrace(value: string, start: number): number {
  let depth = 0;
  for (let i = start; i < value.length; i++) {
    if (value[i] === '$' && value[i + 1] === '{') {
      depth++;
      i++;
    } else if (value[i] === '}' && depth-- === 0) {
      return i;
    }
  }
  return -1;
}

/** A variable's value; the names of `Object.prototype` members (`$toString`) aren't variables. */
function variable(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
}

/** Thrown by `${VAR:?message}` and `${VAR?message}` when the variable is missing. */
export class MissingVariableError extends Error {
  constructor(
    readonly variable: string,
    readonly detail: string,
  ) {
    super(`${variable}: ${detail}`);
    this.name = 'MissingVariableError';
  }
}

/**
 * Expand `$VAR`, `${VAR}` and the shell's operators in a string: `${VAR:-default}` (unset or empty) and `${VAR-default}`
 * (unset) substitute a default, `${VAR:+alt}` (set and non-empty) and `${VAR+alt}` (set) substitute `alt`, and
 * `${VAR:?message}` (unset or empty) and `${VAR?message}` (unset) throw a `MissingVariableError`. Defaults, alternatives
 * and messages are expanded too. Escaped `\$` produces a literal `$`. Undefined variables resolve to `""`.
 */
export function expandVariables(value: string, env: Record<string, string | undefined>): string {
  let result = '';
  let i = 0;

  while (i < value.length) {
    if (value[i] === '\\' && value[i + 1] === '$') {
      result += '$';
      i += 2;
      continue;
    }

    if (value[i] === '$') {
      i++;
      if (i >= value.length) {
        result += '$';
        break;
      }

      if (value[i] === '{') {
        i++;
        const closeIdx = findClosingBrace(value, i);
        if (closeIdx === -1) {
          result += `\${${value.slice(i)}`;
          break;
        }

        const expr = value.slice(i, closeIdx);
        i = closeIdx + 1;

        // The operator right after the name, so a default may hold other operators (`${A-${B:-x}}`)
        const [, varName = '', operator] = /^(\w*)(:?[-+?])?/.exec(expr)!;
        if (!operator) {
          result += variable(env, expr) ?? '';
          continue;
        }
        const word = expr.slice(varName.length + operator.length);
        const val = variable(env, varName);
        // With `:`, an empty value counts as unset
        const set = operator.startsWith(':') ? !!val : val !== undefined;
        const kind = operator.at(-1);
        if (kind === '-') result += set ? val : expandVariables(word, env);
        else if (kind === '+') result += set ? expandVariables(word, env) : '';
        else if (set) result += val;
        else {
          const detail = expandVariables(word, env) || (operator === ':?' ? 'is not set or empty' : 'is not set');
          throw new MissingVariableError(varName, detail);
        }
      } else {
        // $VAR — collect word chars
        let varName = '';
        while (i < value.length && /[\w]/.test(value[i]!)) {
          varName += value[i];
          i++;
        }
        if (varName) {
          result += variable(env, varName) ?? '';
        } else {
          result += '$';
        }
      }
      continue;
    }

    result += value[i];
    i++;
  }

  return result;
}

// ── File loading ────────────────────────────────────────────────────────

export type LoadEnvFilesOptions = {
  dir?: string;
  modes?: string[];
  local?: boolean;
  override?: boolean;
  base?: boolean;
};

/**
 * Load and merge `.env` files, returning the combined key-value map.
 * Variable expansion uses the merged file values + process env as lookup.
 *
 * Returns synchronously when `node:fs`/`node:path` are already cached (typical),
 * or a Promise on the very first call.
 */
export function loadEnvFiles(
  options: LoadEnvFilesOptions,
  processEnv: Record<string, string | undefined>,
): Record<string, string> | Promise<Record<string, string>> {
  if (typeof process === 'undefined') return {};

  // A missing required variable (`${VAR:?message}`) is an error; anything else (no file system) loads nothing
  const fallback = (err: unknown): Record<string, string> => {
    if (err instanceof ConfigError) throw err;
    return {};
  };
  try {
    if (_fs && _path) return loadEnvFilesSync(_fs, _path, options, processEnv);
    return initNodeModules()
      .then(() => loadEnvFilesSync(_fs!, _path!, options, processEnv))
      .catch(fallback);
  } catch (err) {
    return fallback(err);
  }
}

// ── Internals ───────────────────────────────────────────────────────────

let _fs: typeof import('node:fs') | undefined;
let _path: typeof import('node:path') | undefined;

async function initNodeModules(): Promise<void> {
  if (_fs && _path) return;
  _fs = await import('node:fs');
  _path = await import('node:path');
}

if (typeof process !== 'undefined') initNodeModules();

function loadEnvFilesSync(
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
  options: LoadEnvFilesOptions,
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  const dir = options.dir ?? process.cwd();
  const fileNames = resolveEnvFiles(options.modes, options.local ?? true, options.base ?? true);
  // Later files win; values are expanded after merging, so `.env` can use a variable `.env.local` overrides
  const entries = new Map<string, EnvEntry & { file: string }>();
  for (const name of fileNames) {
    const filePath = path.resolve(dir, name);
    if (!fs.existsSync(filePath)) continue;
    for (const entry of parseEnvEntries(fs.readFileSync(filePath, 'utf-8'))) entries.set(entry.key, { ...entry, file: filePath });
  }
  const displayPath = (file: string) => {
    const relative = path.relative(process.cwd(), file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
  };

  // Expanded on demand, so chained and forward references work; processEnv wins in the lookup unless `override`.
  // A reference back to a variable being expanded (`PATH=$PATH:/bin`) reads processEnv.
  const expanded = new Map<string, string>();
  const expanding = new Set<string>();
  const expand = (key: string): string | undefined => {
    const entry = entries.get(key);
    if (!entry) return processEnv[key];
    if (expanded.has(key)) return expanded.get(key);
    if (expanding.has(key)) return processEnv[key] ?? '';
    expanding.add(key);
    try {
      const value = entry.literal ? entry.value : expandVariables(entry.value, lookup);
      expanded.set(key, value);
      return value;
    } catch (err) {
      if (!(err instanceof MissingVariableError)) throw err;
      throw new ConfigError(`${displayPath(entry.file)}: ${key} needs ${err.variable}: ${err.detail}`, { cause: err });
    } finally {
      expanding.delete(key);
    }
  };
  const lookup = new Proxy({} as Record<string, string | undefined>, {
    get: (_, key) => {
      if (typeof key !== 'string') return undefined;
      return options.override || processEnv[key] === undefined ? expand(key) : processEnv[key];
    },
  });

  const merged: Record<string, string> = {};
  for (const key of entries.keys()) {
    try {
      merged[key] = expand(key)!;
    } catch (err) {
      // A value the process environment overrides is never used, so neither is the variable it's missing
      if (options.override || processEnv[key] === undefined) throw err;
      merged[key] = processEnv[key];
    }
  }
  return merged;
}
