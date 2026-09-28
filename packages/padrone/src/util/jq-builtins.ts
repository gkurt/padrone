/** Values, operators, builtins, `@formats` and the run budget of the jq subset in `jq.ts`. */

/** A compiled filter: every output it produces for an input, lazily. */
export type JqFilter = (input: unknown) => Iterable<unknown>;

export class JqError extends Error {
  override name = 'JqError';
}

/** A run went over its step budget. `?` and `//` never suppress it. */
export class JqLimitError extends JqError {
  override name = 'JqLimitError';
}

// ── Run state ───────────────────────────────────────────────────────────

/** What a program run gets: its step budget and the variables `$ENV` / `env` see. */
export type JqRunOptions = { maxSteps: number; env: Record<string, string> };

let run: (JqRunOptions & { steps: number }) | undefined;

/** Counts `count` steps of work against the running program's budget. */
export function tick(count = 1): void {
  if (!run) return;
  run.steps += count;
  if (!(run.steps <= run.maxSteps)) throw new JqLimitError(`The expression exceeded its budget of ${run.maxSteps} steps`);
}

export const runEnv = (): Record<string, string> => run?.env ?? {};

/** Runs `fn` with `options` as the current run (filters run synchronously, so it's set for the whole evaluation). */
export function withRun<T>(options: JqRunOptions, fn: () => T): T {
  const previous = run;
  run = { ...options, steps: 0 };
  try {
    return fn();
  } finally {
    run = previous;
  }
}

/** Rethrows budget errors, which suppressing operators must let through. */
export function rethrowLimit(err: unknown): void {
  if (err instanceof JqLimitError) throw err;
}

// ── Values ──────────────────────────────────────────────────────────────

type JqType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

export function typeOf(value: unknown): JqType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type === 'boolean' || type === 'number' || type === 'string') return type;
  return 'object';
}

export const truthy = (value: unknown) => value !== false && value !== null && value !== undefined;

export const isObject = (value: unknown): value is Record<string, unknown> => typeOf(value) === 'object';

/** A value in an error message, like jq: `string ("abc")`, JSON cut to 11 characters. */
export function describe(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return `${typeOf(value)} (${json.length > 14 ? `${json.slice(0, 11)}...` : json})`;
}

const TYPE_ORDER: JqType[] = ['null', 'boolean', 'number', 'string', 'array', 'object'];

/** By code point, as jq compares UTF-8 bytes (`<` on JavaScript strings compares UTF-16 code units). */
function compareStrings(a: string, b: string): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

const sortedKeys = (object: object) => Object.keys(object).sort(compareStrings);

/** jq's total order: null < false < true < numbers < strings < arrays < objects. */
export function compareValues(a: unknown, b: unknown): number {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return TYPE_ORDER.indexOf(ta) - TYPE_ORDER.indexOf(tb);
  if (ta === 'null') return 0;
  if (ta === 'boolean' || ta === 'number') return Number(a) - Number(b);
  if (ta === 'string') return compareStrings(a as string, b as string);
  if (ta === 'array') {
    const x = a as unknown[];
    const y = b as unknown[];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const c = compareValues(x[i], y[i]);
      if (c !== 0) return c;
    }
    return x.length - y.length;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = compareValues(sortedKeys(x), sortedKeys(y));
  if (keys !== 0) return keys;
  for (const key of sortedKeys(x)) {
    const c = compareValues(x[key], y[key]);
    if (c !== 0) return c;
  }
  return 0;
}

export function index(value: unknown, key: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof key === 'number' && Array.isArray(value)) {
    const i = Math.floor(key);
    return value[i < 0 ? value.length + i : i] ?? null;
  }
  if (typeof key === 'string' && isObject(value)) return Object.hasOwn(value, key) ? (value[key] ?? null) : null;
  throw new JqError(`Cannot index ${typeOf(value)} with ${JSON.stringify(key)}`);
}

export function iterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.values(value);
  throw new JqError(`Cannot iterate over ${typeOf(value)}`);
}

export function slice(value: unknown, from: unknown, to: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && !Array.isArray(value)) throw new JqError(`Cannot slice ${typeOf(value)}`);
  const start = from === null || from === undefined ? undefined : Math.floor(Number(from));
  const end = to === null || to === undefined ? undefined : Math.ceil(Number(to));
  // Strings by code point, as `length` counts them
  return typeof value === 'string' ? [...value].slice(start, end).join('') : value.slice(start, end);
}

function length(value: unknown): number {
  const type = typeOf(value);
  if (type === 'null') return 0;
  if (type === 'number') return Math.abs(value as number);
  if (type === 'string') return [...(value as string)].length;
  if (type === 'array') return (value as unknown[]).length;
  if (type === 'object') return Object.keys(value as object).length;
  throw new JqError('boolean has no length');
}

// ── Arithmetic ──────────────────────────────────────────────────────────

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const merged = Object.entries(b).map(([key, value]) => {
    const current = Object.hasOwn(a, key) ? a[key] : undefined;
    return [key, isObject(current) && isObject(value) ? deepMerge(current, value) : value];
  });
  // Spread defines own properties, so a "__proto__" key is a key
  return { ...a, ...Object.fromEntries(merged) };
}

function split(value: unknown, separator: unknown): string[] {
  if (typeof value !== 'string' || typeof separator !== 'string') throw new JqError('split input and separator must be strings');
  if (value === '') return [];
  return separator === '' ? [...value] : value.split(separator);
}

/** `a <op> b` with jq's semantics for numbers, strings, arrays, objects and null. */
export function arithmetic(op: string, a: unknown, b: unknown): unknown {
  const fail = (verb: string): never => {
    throw new JqError(`${describe(a)} and ${describe(b)} cannot be ${verb}`);
  };
  const numbers = typeof a === 'number' && typeof b === 'number';
  switch (op) {
    case '+':
      if (a === null || a === undefined) return b;
      if (b === null || b === undefined) return a;
      if (numbers) return a + b;
      if (typeof a === 'string' && typeof b === 'string') {
        tick(a.length + b.length);
        return a + b;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        tick(a.length + b.length);
        return [...a, ...b];
      }
      if (isObject(a) && isObject(b)) {
        tick(Object.keys(a).length + Object.keys(b).length);
        return { ...a, ...b };
      }
      return fail('added');
    case '-':
      if (numbers) return a - b;
      if (Array.isArray(a) && Array.isArray(b)) {
        tick(a.length * b.length);
        return a.filter((x) => !b.some((y) => compareValues(x, y) === 0));
      }
      return fail('subtracted');
    case '*': {
      if (numbers) return a * b;
      const [text, times] = typeof a === 'string' ? [a, b] : [b, a];
      if (typeof text === 'string' && typeof times === 'number') {
        if (times < 0) return null;
        if (text === '') return '';
        tick(text.length * Math.floor(times));
        return text.repeat(Math.floor(times));
      }
      if (isObject(a) && isObject(b)) {
        tick(Object.keys(a).length + Object.keys(b).length);
        return deepMerge(a, b);
      }
      return fail('multiplied');
    }
    case '/':
      if (numbers) return b === 0 ? fail('divided because the divisor is zero') : a / b;
      if (typeof a === 'string' && typeof b === 'string') return split(a, b);
      return fail('divided');
    default: {
      if (!numbers) return fail('divided (remainder)');
      const divisor = Math.trunc(b);
      if (divisor === 0) return fail('divided (remainder) because the divisor is zero');
      return Math.trunc(a) % divisor || 0;
    }
  }
}

function add(value: unknown): unknown {
  return iterate(value).reduce((acc, item) => arithmetic('+', acc, item), null);
}

// ── Builtins ────────────────────────────────────────────────────────────

/** jq's number syntax: no surrounding whitespace, hex or `Infinity` (unlike `Number()`). */
const DECIMAL_NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new JqError(`${name} requires a string, got ${typeOf(value)}`);
  return value;
};

export const tostring = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? null));

/** Every combination of one output from each filter, the first filter varying slowest. */
export function* product(filters: JqFilter[], input: unknown, combo: unknown[] = []): Generator<unknown[]> {
  if (combo.length === filters.length) return yield combo;
  for (const value of filters[combo.length]!(input)) yield* product(filters, input, [...combo, value]);
}

/** Every output of `f` for `input`, as an array. */
export const outputs = (f: JqFilter, input: unknown): unknown[] => Array.from(f(input));

/** Items with their `[f]` keys, sorted by key (stably). */
const sortedByKey = (x: unknown, f: JqFilter) =>
  iterate(x)
    .map((item) => ({ item, key: outputs(f, item) }))
    .sort((a, b) => compareValues(a.key, b.key));

function groupBy(x: unknown, f: JqFilter): unknown[][] {
  const groups: { key: unknown; items: unknown[] }[] = [];
  for (const { item, key } of sortedByKey(x, f)) {
    const last = groups.at(-1);
    if (last && compareValues(last.key, key) === 0) last.items.push(item);
    else groups.push({ key, items: [item] });
  }
  return groups.map((group) => group.items);
}

/** The item with the smallest (first one) or largest (last one) `[f]` key, or `null`. */
function extremeBy(x: unknown, f: JqFilter, max: boolean): unknown {
  let best: { item: unknown; key: unknown[] } | undefined;
  for (const item of iterate(x)) {
    const key = outputs(f, item);
    const c = best ? compareValues(key, best.key) : 0;
    if (!best || (max ? c >= 0 : c < 0)) best = { item, key };
  }
  return best ? best.item : null;
}

function joinItems(x: unknown, separator: unknown): string {
  const text = (item: unknown) =>
    item === null || item === undefined ? '' : typeof item === 'boolean' || typeof item === 'number' ? String(item) : item;
  return iterate(x).reduce<string>(
    (acc, item, i) => arithmetic('+', i === 0 ? '' : acc + requireString(separator, 'join'), text(item)) as string,
    '',
  );
}

/** A jq regex (Oniguruma flags `g i x n s p l`) as a JavaScript one; `global` for `g`, `skipEmpty` for `n`. */
function toRegExp(re: unknown, flags: unknown = null): { regex: RegExp; global: boolean; skipEmpty: boolean } {
  if (flags !== null && (typeof flags !== 'string' || /[^gixnspl]/.test(flags))) {
    throw new JqError(`${tostring(flags)} is not a valid modifier string`);
  }
  const f = (flags as string | null) ?? '';
  let source = requireString(re, 'regex');
  if (f.includes('x')) source = source.replace(/\\.|\s+|#[^\n]*/g, (m) => (m.startsWith('\\') ? m : ''));
  try {
    return {
      regex: new RegExp(source, `g${f.includes('i') ? 'i' : ''}${f.includes('p') ? 's' : ''}`),
      global: f.includes('g'),
      skipEmpty: f.includes('n'),
    };
  } catch (err) {
    throw new JqError(`${source} is not a valid regex: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const matchInput = (value: unknown): string => {
  if (typeof value !== 'string') throw new JqError(`${describe(value)} cannot be matched, as it is not a string`);
  return value;
};

function testRegex(x: unknown, re: unknown, flags?: unknown): boolean {
  const { regex, skipEmpty } = toRegExp(re, flags);
  const input = matchInput(x);
  return [...input.matchAll(regex)].some((m) => !skipEmpty || m[0] !== '');
}

/**
 * `sub` / `gsub` as jq 1.7 defines them: `replacement` sees each match's named captures, and its n-th output
 * replaces every match in the n-th result.
 */
function substitute(x: unknown, re: unknown, replacement: JqFilter, flags: unknown, global: boolean): string[] {
  const input = matchInput(x);
  const options = toRegExp(re, flags);
  let matches = [...input.matchAll(options.regex)].filter((m) => !options.skipEmpty || m[0] !== '');
  if (!global && !options.global) matches = matches.slice(0, 1);
  const results: string[] = [];
  let previous = 0;
  for (const match of matches) {
    const gap = input.slice(previous, match.index);
    const captures = Object.fromEntries(Object.entries(match.groups ?? {}).map(([name, value]) => [name, value ?? null]));
    outputs(replacement, captures).forEach((insert, i) => {
      results[i] = arithmetic('+', results[i] ?? null, arithmetic('+', gap, insert)) as string;
    });
    previous = match.index + match[0].length;
  }
  const rest = input.slice(previous);
  return results.length ? results.map((r) => r + rest) : [input];
}

function row(x: unknown, format: 'csv' | 'tsv'): string {
  if (!Array.isArray(x)) throw new JqError(`${describe(x)} cannot be ${format}-formatted, only array`);
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value !== 'string') throw new JqError(`${describe(value)} is not valid in a ${format} row`);
    if (format === 'csv') return `"${value.replace(/"/g, '""')}"`;
    return value.replace(/[\\\t\n\r]/g, (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[c]!);
  };
  return x.map(cell).join(format === 'csv' ? ',' : '\t');
}

const HTML_ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };

/** `@sh`: strings single-quoted for POSIX shells, other scalars as they are; an array gives space-separated words. */
function shellQuote(x: unknown): string {
  const word = (value: unknown) => {
    if (typeof value === 'string') return `'${value.replace(/'/g, "'\\''")}'`;
    if (typeOf(value) === 'array' || typeOf(value) === 'object') throw new JqError(`${describe(value)} can not be escaped for shell`);
    return JSON.stringify(value ?? null);
  };
  return Array.isArray(x) ? x.map(word).join(' ') : word(x);
}

/** `@base64d`: padding optional; the bytes decoded as UTF-8. */
function base64Decode(x: unknown): string {
  const text = tostring(x);
  const data = text.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(data)) throw new JqError(`${describe(x)} is not valid base64 data`);
  if (data.length % 4 === 1) throw new JqError(`${describe(x)} trailing base64 byte found`);
  const bytes = Uint8Array.from(atob(data.padEnd(Math.ceil(data.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** `@name` formats: each takes the input and returns a string. */
export const FORMATS: Record<string, (x: unknown) => string> = {
  text: tostring,
  json: (x) => JSON.stringify(x ?? null),
  csv: (x) => row(x, 'csv'),
  tsv: (x) => row(x, 'tsv'),
  html: (x) => tostring(x).replace(/[<>&'"]/g, (c) => HTML_ESCAPES[c]!),
  uri: (x) => encodeURIComponent(tostring(x)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  base64: (x) => btoa(Array.from(new TextEncoder().encode(tostring(x)), (byte) => String.fromCharCode(byte)).join('')),
  base64d: base64Decode,
  sh: shellQuote,
};

export type Builtin = (input: unknown, ...args: JqFilter[]) => Iterable<unknown>;

/** Builtins by `name/arity`; the arguments are compiled filters, applied to whatever the builtin needs. */
export const BUILTINS: Record<string, Builtin> = {
  'keys/0': (x) => {
    if (Array.isArray(x)) return [x.map((_, i) => i)];
    if (isObject(x)) return [sortedKeys(x)];
    throw new JqError(`${typeOf(x)} has no keys`);
  },
  'length/0': (x) => [length(x)],
  'not/0': (x) => [!truthy(x)],
  'empty/0': () => [],
  'type/0': (x) => [typeOf(x)],
  'tostring/0': (x) => [tostring(x)],
  'tojson/0': (x) => [JSON.stringify(x ?? null)],
  'fromjson/0': (x) => {
    try {
      return [JSON.parse(requireString(x, 'fromjson'))];
    } catch (err) {
      throw new JqError(`${JSON.stringify(x)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
  'tonumber/0': (x) => {
    if (typeof x === 'number') return [x];
    if (!DECIMAL_NUMBER.test(requireString(x, 'tonumber'))) throw new JqError(`Cannot parse ${JSON.stringify(x)} as a number`);
    return [Number(x)];
  },
  'first/0': (x) => [index(x, 0)],
  'last/0': (x) => [index(x, -1)],
  'add/0': (x) => [add(x)],
  'sort/0': (x) => [[...iterate(x)].sort(compareValues)],
  'reverse/0': (x) => [typeof x === 'string' ? [...x].reverse().join('') : x === null ? [] : [...iterate(x)].reverse()],
  'unique/0': (x) => [groupBy(x, (v) => [v]).map((group) => group[0])],
  'min/0': (x) => [extremeBy(x, (v) => [v], false)],
  'max/0': (x) => [extremeBy(x, (v) => [v], true)],
  'to_entries/0': (x) => {
    if (Array.isArray(x)) return [x.map((value, key) => ({ key, value }))];
    if (isObject(x)) return [Object.entries(x).map(([key, value]) => ({ key, value }))];
    throw new JqError(`${typeOf(x)} has no keys`);
  },
  // jq 1.7.1: `key`, else the first truthy of `k name Name K Key`, as a string; `value` if present, else `v`
  'from_entries/0': (x) => [
    Object.fromEntries(
      iterate(x).map((entry) => {
        if (!isObject(entry)) throw new JqError(`Cannot use ${describe(entry)} as an entry`);
        const key = index(entry, 'key') ?? ['k', 'name', 'Name', 'K', 'Key'].map((k) => index(entry, k)).find(truthy) ?? null;
        return [typeof key === 'string' ? key : JSON.stringify(key), index(entry, Object.hasOwn(entry, 'value') ? 'value' : 'v')];
      }),
    ),
  ],
  'ascii_downcase/0': (x) => [requireString(x, 'ascii_downcase').replace(/[A-Z]/g, (c) => c.toLowerCase())],
  'ascii_upcase/0': (x) => [requireString(x, 'ascii_upcase').replace(/[a-z]/g, (c) => c.toUpperCase())],

  *'select/1'(x, f) {
    for (const value of f(x)) if (truthy(value)) yield x;
  },
  'map/1': (x, f) => [iterate(x).flatMap((item) => outputs(f, item))],
  'sort_by/1': (x, f) => [sortedByKey(x, f).map(({ item }) => item)],
  'group_by/1': (x, f) => [groupBy(x, f)],
  'unique_by/1': (x, f) => [groupBy(x, f).map((group) => group[0])],
  'min_by/1': (x, f) => [extremeBy(x, f, false)],
  'max_by/1': (x, f) => [extremeBy(x, f, true)],
  'has/1': (x, f) =>
    outputs(f, x).map((key) => {
      if (Array.isArray(x) && typeof key === 'number') return key >= 0 && key < x.length;
      if (isObject(x) && typeof key === 'string') return Object.hasOwn(x, key);
      throw new JqError(`Cannot check whether ${typeOf(x)} has a ${typeOf(key)} key`);
    }),
  'join/1': (x, f) => outputs(f, x).map((separator) => joinItems(x, separator)),
  'split/1': (x, f) => outputs(f, x).map((separator) => split(x, separator)),
  'ltrimstr/1': (x, f) =>
    outputs(f, x).map((s) => (typeof x === 'string' && typeof s === 'string' && x.startsWith(s) ? x.slice(s.length) : x)),
  'rtrimstr/1': (x, f) =>
    outputs(f, x).map((s) => (typeof x === 'string' && typeof s === 'string' && s && x.endsWith(s) ? x.slice(0, -s.length) : x)),
  'startswith/1': (x, f) => outputs(f, x).map((s) => requireString(x, 'startswith').startsWith(requireString(s, 'startswith'))),
  'endswith/1': (x, f) => outputs(f, x).map((s) => requireString(x, 'endswith').endsWith(requireString(s, 'endswith'))),
  'test/1': (x, re) => outputs(re, x).map((r) => testRegex(x, r)),
  'test/2': (x, re, flags) => Array.from(product([re, flags], x)).map(([r, f]) => testRegex(x, r, f)),
  'sub/2': (x, re, str) => outputs(re, x).flatMap((r) => substitute(x, r, str, null, false)),
  'sub/3': (x, re, str, flags) => Array.from(product([re, flags], x)).flatMap(([r, f]) => substitute(x, r, str, f, false)),
  'gsub/2': (x, re, str) => outputs(re, x).flatMap((r) => substitute(x, r, str, null, true)),
  'gsub/3': (x, re, str, flags) => Array.from(product([re, flags], x)).flatMap(([r, f]) => substitute(x, r, str, f, true)),
};
