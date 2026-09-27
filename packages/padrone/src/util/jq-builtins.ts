/** Values, operators and builtins of the jq subset in `jq.ts`. */

/** A compiled filter: every output it produces for an input. */
export type JqFilter = (input: unknown) => unknown[];

export class JqError extends Error {
  override name = 'JqError';
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

const isObject = (value: unknown): value is Record<string, unknown> => typeOf(value) === 'object';

/** A value in an error message, like jq: `string ("abc")`, JSON cut to 11 characters. */
export function describe(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return `${typeOf(value)} (${json.length > 14 ? `${json.slice(0, 11)}...` : json})`;
}

const TYPE_ORDER: JqType[] = ['null', 'boolean', 'number', 'string', 'array', 'object'];

/** jq's total order: null < false < true < numbers < strings < arrays < objects. */
export function compareValues(a: unknown, b: unknown): number {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return TYPE_ORDER.indexOf(ta) - TYPE_ORDER.indexOf(tb);
  if (ta === 'null') return 0;
  if (ta === 'boolean' || ta === 'number') return Number(a) - Number(b);
  if (ta === 'string') return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
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
  const keys = compareValues(Object.keys(x).sort(), Object.keys(y).sort());
  if (keys !== 0) return keys;
  for (const key of Object.keys(x).sort()) {
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
  const start = from === null || from === undefined ? undefined : Number(from);
  const end = to === null || to === undefined ? undefined : Number(to);
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
  const result = { ...a };
  for (const [key, value] of Object.entries(b))
    result[key] = isObject(result[key]) && isObject(value) ? deepMerge(result[key], value) : value;
  return result;
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
      if (numbers || (typeof a === 'string' && typeof b === 'string')) return (a as number) + (b as number);
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      if (isObject(a) && isObject(b)) return { ...a, ...b };
      return fail('added');
    case '-':
      if (numbers) return a - b;
      if (Array.isArray(a) && Array.isArray(b)) return a.filter((x) => !b.some((y) => compareValues(x, y) === 0));
      return fail('subtracted');
    case '*': {
      if (numbers) return a * b;
      const [text, times] = typeof a === 'string' ? [a, b] : [b, a];
      if (typeof text === 'string' && typeof times === 'number') return times < 0 ? null : text.repeat(Math.floor(times));
      if (isObject(a) && isObject(b)) return deepMerge(a, b);
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

const tostring = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? null));

/** Every combination of one output from each filter, the first filter varying slowest. */
export function product(filters: JqFilter[], input: unknown): unknown[][] {
  return filters.reduce<unknown[][]>((combos, f) => combos.flatMap((combo) => f(input).map((value) => [...combo, value])), [[]]);
}

/** Items with their `[f]` keys, sorted by key (stably). */
const sortedByKey = (x: unknown, f: JqFilter) =>
  iterate(x)
    .map((item) => ({ item, key: f(item) }))
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
    const key = f(item);
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
    replacement(captures).forEach((insert, i) => {
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

/** `@name` formats: each takes the input and returns a string. */
export const FORMATS: Record<string, (x: unknown) => string> = {
  text: tostring,
  json: (x) => JSON.stringify(x ?? null),
  csv: (x) => row(x, 'csv'),
  tsv: (x) => row(x, 'tsv'),
  html: (x) => tostring(x).replace(/[<>&'"]/g, (c) => HTML_ESCAPES[c]!),
  uri: (x) => encodeURIComponent(tostring(x)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  base64: (x) => btoa(Array.from(new TextEncoder().encode(tostring(x)), (byte) => String.fromCharCode(byte)).join('')),
};

type Builtin = (input: unknown, ...args: JqFilter[]) => unknown[];

/** Builtins by `name/arity`; the arguments are compiled filters, applied to whatever the builtin needs. */
export const BUILTINS: Record<string, Builtin> = {
  'keys/0': (x) => {
    if (Array.isArray(x)) return [x.map((_, i) => i)];
    if (isObject(x)) return [Object.keys(x).sort()];
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
  'reverse/0': (x) => [typeof x === 'string' ? [...x].reverse().join('') : [...iterate(x)].reverse()],
  'unique/0': (x) => [groupBy(x, (v) => [v]).map((group) => group[0])],
  'min/0': (x) => [extremeBy(x, (v) => [v], false)],
  'max/0': (x) => [extremeBy(x, (v) => [v], true)],
  'to_entries/0': (x) => {
    if (Array.isArray(x)) return [x.map((value, key) => ({ key, value }))];
    if (isObject(x)) return [Object.entries(x).map(([key, value]) => ({ key, value }))];
    throw new JqError(`${typeOf(x)} has no keys`);
  },
  'from_entries/0': (x) => [
    Object.fromEntries(
      iterate(x).map((entry) => {
        const e = entry as Record<string, unknown>;
        return [String(e.key ?? e.name ?? e.k), e.value ?? e.v ?? null];
      }),
    ),
  ],
  'ascii_downcase/0': (x) => [requireString(x, 'ascii_downcase').replace(/[A-Z]/g, (c) => c.toLowerCase())],
  'ascii_upcase/0': (x) => [requireString(x, 'ascii_upcase').replace(/[a-z]/g, (c) => c.toUpperCase())],

  'select/1': (x, f) =>
    f(x)
      .filter(truthy)
      .map(() => x),
  'map/1': (x, f) => [iterate(x).flatMap(f)],
  'sort_by/1': (x, f) => [sortedByKey(x, f).map(({ item }) => item)],
  'group_by/1': (x, f) => [groupBy(x, f)],
  'unique_by/1': (x, f) => [groupBy(x, f).map((group) => group[0])],
  'min_by/1': (x, f) => [extremeBy(x, f, false)],
  'max_by/1': (x, f) => [extremeBy(x, f, true)],
  'has/1': (x, f) =>
    f(x).map((key) => {
      if (Array.isArray(x) && typeof key === 'number') return key >= 0 && key < x.length;
      if (isObject(x) && typeof key === 'string') return Object.hasOwn(x, key);
      throw new JqError(`Cannot check whether ${typeOf(x)} has a ${typeOf(key)} key`);
    }),
  'join/1': (x, f) => f(x).map((separator) => joinItems(x, separator)),
  'split/1': (x, f) => f(x).map((separator) => split(x, separator)),
  'ltrimstr/1': (x, f) => f(x).map((s) => (typeof x === 'string' && typeof s === 'string' && x.startsWith(s) ? x.slice(s.length) : x)),
  'rtrimstr/1': (x, f) =>
    f(x).map((s) => (typeof x === 'string' && typeof s === 'string' && s && x.endsWith(s) ? x.slice(0, -s.length) : x)),
  'startswith/1': (x, f) => f(x).map((s) => requireString(x, 'startswith').startsWith(requireString(s, 'startswith'))),
  'endswith/1': (x, f) => f(x).map((s) => requireString(x, 'endswith').endsWith(requireString(s, 'endswith'))),
  'test/1': (x, re) => re(x).map((r) => testRegex(x, r)),
  'test/2': (x, re, flags) => product([re, flags], x).map(([r, f]) => testRegex(x, r, f)),
  'sub/2': (x, re, str) => re(x).flatMap((r) => substitute(x, r, str, null, false)),
  'sub/3': (x, re, str, flags) => product([re, flags], x).flatMap(([r, f]) => substitute(x, r, str, f, false)),
  'gsub/2': (x, re, str) => re(x).flatMap((r) => substitute(x, r, str, null, true)),
  'gsub/3': (x, re, str, flags) => product([re, flags], x).flatMap(([r, f]) => substitute(x, r, str, f, true)),
};
