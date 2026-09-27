/**
 * A dependency-free subset of jq for `--jq` and `--template`:
 * - paths: `.`, `.a.b`, `."a-b"`, `.["a"]`, `.[0]`, `.[-1]`, `.[2:4]`, `.[]`, `.a[]`, optional `?`
 * - pipes `|`, comma `,`, alternative `//`, `and` / `or`, comparisons `== != < <= > >=`
 * - literals, arrays `[...]`, objects `{a, b: .c, "d": 1, (.k): .v}`, parentheses
 * - builtins: `select(f)`, `map(f)`, `sort_by(f)`, `has(k)`, `join(s)`, `test(re)`, `startswith(s)`, `endswith(s)`,
 *   `keys`, `length`, `not`, `empty`, `type`, `tostring`, `tonumber`, `first`, `last`, `add`, `sort`, `reverse`,
 *   `unique`, `to_entries`, `from_entries`, `ascii_downcase`, `ascii_upcase`
 */

/** A compiled filter: every output it produces for an input. */
export type JqFilter = (input: unknown) => unknown[];

export class JqError extends Error {
  override name = 'JqError';
}

// ── Values ──────────────────────────────────────────────────────────────

type JqType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

function typeOf(value: unknown): JqType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type === 'boolean' || type === 'number' || type === 'string') return type;
  return 'object';
}

const truthy = (value: unknown) => value !== false && value !== null && value !== undefined;

const TYPE_ORDER: JqType[] = ['null', 'boolean', 'number', 'string', 'array', 'object'];

/** jq's total order: null < false < true < numbers < strings < arrays < objects. */
function compareValues(a: unknown, b: unknown): number {
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

function index(value: unknown, key: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof key === 'number' && Array.isArray(value)) {
    const i = Math.floor(key);
    return value[i < 0 ? value.length + i : i] ?? null;
  }
  if (typeof key === 'string' && typeOf(value) === 'object') {
    return Object.hasOwn(value as object, key) ? ((value as Record<string, unknown>)[key] ?? null) : null;
  }
  throw new JqError(`Cannot index ${typeOf(value)} with ${JSON.stringify(key)}`);
}

function iterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeOf(value) === 'object') return Object.values(value as object);
  throw new JqError(`Cannot iterate over ${typeOf(value)}`);
}

function slice(value: unknown, from: unknown, to: unknown): unknown {
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

function add(value: unknown): unknown {
  const items = iterate(value).filter((item) => item !== null && item !== undefined);
  if (items.length === 0) return null;
  const first = items[0];
  if (Array.isArray(first)) {
    const result: unknown[] = [];
    for (const item of items) {
      if (!Array.isArray(item)) throw new JqError(`array and ${typeOf(item)} cannot be added`);
      result.push(...item);
    }
    return result;
  }
  if (typeOf(first) === 'object') {
    const result: Record<string, unknown> = {};
    for (const item of items) {
      if (typeOf(item) !== 'object') throw new JqError(`object and ${typeOf(item)} cannot be added`);
      Object.assign(result, item);
    }
    return result;
  }
  return items.reduce((acc, item) => {
    if (typeof acc === 'number' && typeof item === 'number') return acc + item;
    if (typeof acc === 'string' && typeof item === 'string') return acc + item;
    throw new JqError(`${typeOf(acc)} and ${typeOf(item)} cannot be added`);
  });
}

/** jq's number syntax: no surrounding whitespace, hex or `Infinity` (unlike `Number()`). */
const DECIMAL_NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new JqError(`${name} requires a string, got ${typeOf(value)}`);
  return value;
};

const BUILTINS_0: Record<string, (input: unknown) => unknown[]> = {
  keys: (x) => {
    if (Array.isArray(x)) return [x.map((_, i) => i)];
    if (typeOf(x) === 'object') return [Object.keys(x as object).sort()];
    throw new JqError(`${typeOf(x)} has no keys`);
  },
  length: (x) => [length(x)],
  not: (x) => [!truthy(x)],
  empty: () => [],
  type: (x) => [typeOf(x)],
  tostring: (x) => [typeof x === 'string' ? x : JSON.stringify(x ?? null)],
  tonumber: (x) => {
    if (typeof x === 'number') return [x];
    if (!DECIMAL_NUMBER.test(requireString(x, 'tonumber'))) throw new JqError(`Cannot parse ${JSON.stringify(x)} as a number`);
    return [Number(x)];
  },
  first: (x) => [index(x, 0)],
  last: (x) => [index(x, -1)],
  add: (x) => [add(x)],
  sort: (x) => [[...iterate(x)].sort(compareValues)],
  reverse: (x) => [typeof x === 'string' ? [...x].reverse().join('') : [...iterate(x)].reverse()],
  unique: (x) => [[...iterate(x)].sort(compareValues).filter((v, i, all) => i === 0 || compareValues(all[i - 1], v) !== 0)],
  to_entries: (x) => {
    if (Array.isArray(x)) return [x.map((value, key) => ({ key, value }))];
    if (typeOf(x) === 'object') return [Object.entries(x as object).map(([key, value]) => ({ key, value }))];
    throw new JqError(`${typeOf(x)} has no keys`);
  },
  from_entries: (x) => [
    Object.fromEntries(
      iterate(x).map((entry) => {
        const e = entry as Record<string, unknown>;
        return [String(e.key ?? e.name ?? e.k), e.value ?? e.v ?? null];
      }),
    ),
  ],
  ascii_downcase: (x) => [requireString(x, 'ascii_downcase').replace(/[A-Z]/g, (c) => c.toLowerCase())],
  ascii_upcase: (x) => [requireString(x, 'ascii_upcase').replace(/[a-z]/g, (c) => c.toUpperCase())],
};

/** Builtins with one argument: `arg` is the compiled argument, applied to whatever the builtin needs. */
const BUILTINS_1: Record<string, (input: unknown, arg: JqFilter) => unknown[]> = {
  select: (x, f) =>
    f(x)
      .filter(truthy)
      .map(() => x),
  map: (x, f) => [iterate(x).flatMap(f)],
  sort_by: (x, f) => [
    iterate(x)
      .map((item) => ({ item, key: f(item) }))
      .sort((a, b) => compareValues(a.key, b.key))
      .map(({ item }) => item),
  ],
  has: (x, f) =>
    f(x).map((key) => {
      if (Array.isArray(x) && typeof key === 'number') return key >= 0 && key < x.length;
      if (typeOf(x) === 'object' && typeof key === 'string') return Object.hasOwn(x as object, key);
      throw new JqError(`Cannot check whether ${typeOf(x)} has a ${typeOf(key)} key`);
    }),
  join: (x, f) =>
    f(x).map((sep) =>
      iterate(x)
        .map((item) => (item === null || item === undefined ? '' : String(item)))
        .join(requireString(sep, 'join')),
    ),
  test: (x, f) => f(x).map((re) => new RegExp(requireString(re, 'test')).test(requireString(x, 'test'))),
  startswith: (x, f) => f(x).map((s) => requireString(x, 'startswith').startsWith(requireString(s, 'startswith'))),
  endswith: (x, f) => f(x).map((s) => requireString(x, 'endswith').endsWith(requireString(s, 'endswith'))),
};

// ── Tokenizer ───────────────────────────────────────────────────────────

type Token =
  | { type: 'field'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'punct'; value: string };

const PUNCT = ['==', '!=', '<=', '>=', '//', '<', '>', '.', '[', ']', '{', '}', '(', ')', '|', ',', ':', '?', '-'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '.' && /[A-Za-z_]/.test(source[i + 1] ?? '')) {
      const name = source.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)![0];
      tokens.push({ type: 'field', value: name });
      i += name.length + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < source.length && source[j] !== '"'; j++) {
        if (source[j] === '\\') {
          if (source[j + 1] === '(') throw new JqError('String interpolation is not supported');
          j++;
        }
      }
      if (j >= source.length) throw new JqError('Unterminated string');
      tokens.push({ type: 'string', value: JSON.parse(source.slice(i, j + 1)) as string });
      i = j + 1;
      continue;
    }
    const number = source.slice(i).match(/^\d+(\.\d+)?([eE][+-]?\d+)?/);
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const ident = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (ident) {
      tokens.push({ type: 'ident', value: ident[0] });
      i += ident[0].length;
      continue;
    }
    const punct = PUNCT.find((p) => source.startsWith(p, i));
    if (!punct) throw new JqError(`Unexpected character ${JSON.stringify(ch)} at ${i}`);
    if (punct === '.' && source[i + 1] === '.') throw new JqError('Recursive descent (..) is not supported');
    tokens.push({ type: 'punct', value: punct });
    i += punct.length;
  }
  return tokens;
}

// ── Parser ──────────────────────────────────────────────────────────────

/** Every combination of one output from each filter. */
function product(filters: JqFilter[], input: unknown): unknown[][] {
  return filters.reduce<unknown[][]>((combos, f) => combos.flatMap((combo) => f(input).map((value) => [...combo, value])), [[]]);
}

const COMPARE: Record<string, (c: number) => boolean> = {
  '==': (c) => c === 0,
  '!=': (c) => c !== 0,
  '<': (c) => c < 0,
  '<=': (c) => c <= 0,
  '>': (c) => c > 0,
  '>=': (c) => c >= 0,
};

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }
  private isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.type === 'punct' && token.value === value;
  }
  private isIdent(value: string): boolean {
    const token = this.peek();
    return token?.type === 'ident' && token.value === value;
  }
  private expect(value: string): void {
    if (!this.isPunct(value)) throw new JqError(`Expected "${value}"${this.describeNext()}`);
    this.i++;
  }
  private describeNext(): string {
    const token = this.peek();
    return token ? ` before ${JSON.stringify(token.value)}` : ' at the end';
  }

  parse(): JqFilter {
    const filter = this.parsePipe();
    if (this.i < this.tokens.length) throw new JqError(`Unexpected ${JSON.stringify(this.peek()!.value)}`);
    return filter;
  }

  private parsePipe(): JqFilter {
    let left = this.parseComma();
    while (this.isPunct('|')) {
      this.i++;
      const l = left;
      const r = this.parseComma();
      left = (x) => l(x).flatMap(r);
    }
    return left;
  }

  private parseComma(): JqFilter {
    let left = this.parseAlternative();
    while (this.isPunct(',')) {
      this.i++;
      const l = left;
      const r = this.parseAlternative();
      left = (x) => [...l(x), ...r(x)];
    }
    return left;
  }

  private parseAlternative(): JqFilter {
    let left = this.parseOr();
    while (this.isPunct('//')) {
      this.i++;
      const l = left;
      const r = this.parseOr();
      left = (x) => {
        let values: unknown[];
        try {
          values = l(x).filter(truthy);
        } catch {
          values = [];
        }
        return values.length > 0 ? values : r(x);
      };
    }
    return left;
  }

  private parseOr(): JqFilter {
    let left = this.parseAnd();
    while (this.isIdent('or')) {
      this.i++;
      const l = left;
      const r = this.parseAnd();
      left = (x) => l(x).flatMap((a) => (truthy(a) ? [true] : r(x).map(truthy)));
    }
    return left;
  }

  private parseAnd(): JqFilter {
    let left = this.parseCompare();
    while (this.isIdent('and')) {
      this.i++;
      const l = left;
      const r = this.parseCompare();
      left = (x) => l(x).flatMap((a) => (truthy(a) ? r(x).map(truthy) : [false]));
    }
    return left;
  }

  private parseCompare(): JqFilter {
    const left = this.parsePostfix();
    const token = this.peek();
    if (token?.type !== 'punct' || !COMPARE[token.value]) return left;
    this.i++;
    const test = COMPARE[token.value]!;
    const right = this.parsePostfix();
    // jq loops over the right side's outputs outermost
    return (x) => product([right, left], x).map(([b, a]) => test(compareValues(a, b)));
  }

  private parsePostfix(): JqFilter {
    let filter = this.parsePrimary();
    while (true) {
      const token = this.peek();
      const base = filter;
      if (token?.type === 'field') {
        this.i++;
        filter = (x) => base(x).map((v) => index(v, token.value));
      } else if (this.isPunct('.') && this.peek(1)?.type === 'string') {
        this.i++;
        const key = (this.tokens[this.i++] as { value: string }).value;
        filter = (x) => base(x).map((v) => index(v, key));
      } else if (this.isPunct('.') && this.isPunct('[', 1)) {
        this.i++;
      } else if (this.isPunct('[')) {
        filter = this.parseBracket(base);
      } else if (this.isPunct('?')) {
        this.i++;
        filter = (x) => {
          try {
            return base(x);
          } catch {
            return [];
          }
        };
      } else {
        return filter;
      }
    }
  }

  /** `[]`, `[e]` or `[a:b]` after `base`; the index expressions see the same input as `base`. */
  private parseBracket(base: JqFilter): JqFilter {
    this.expect('[');
    if (this.isPunct(']')) {
      this.i++;
      return (x) => base(x).flatMap(iterate);
    }
    const from: JqFilter = this.isPunct(':') ? () => [null] : this.parsePipe();
    if (this.isPunct(':')) {
      this.i++;
      const to: JqFilter = this.isPunct(']') ? () => [null] : this.parsePipe();
      this.expect(']');
      return (x) => base(x).flatMap((v) => product([from, to], x).map(([a, b]) => slice(v, a, b)));
    }
    this.expect(']');
    return (x) => base(x).flatMap((v) => from(x).map((key) => index(v, key)));
  }

  private parsePrimary(): JqFilter {
    const token = this.peek();
    if (!token) throw new JqError('Unexpected end of expression');
    this.i++;

    if (token.type === 'field') return (x) => [index(x, token.value)];
    if (token.type === 'string' || token.type === 'number') return () => [token.value];

    if (token.type === 'ident') {
      if (token.value === 'true' || token.value === 'false') return () => [token.value === 'true'];
      if (token.value === 'null') return () => [null];
      if (this.isPunct('(')) {
        const builtin = BUILTINS_1[token.value];
        if (!builtin) throw new JqError(`Unknown function ${token.value}/1`);
        this.i++;
        const arg = this.parsePipe();
        this.expect(')');
        return (x) => builtin(x, arg);
      }
      const builtin = BUILTINS_0[token.value];
      if (!builtin) throw new JqError(`Unknown function ${token.value}/0`);
      return builtin;
    }

    switch (token.value) {
      case '.':
        if (this.peek()?.type === 'string') {
          const key = (this.tokens[this.i++] as { value: string }).value;
          return (x) => [index(x, key)];
        }
        return (x) => [x];
      case '-': {
        const number = this.peek();
        if (number?.type !== 'number') throw new JqError('Only negative number literals are supported');
        this.i++;
        return () => [-number.value];
      }
      case '(': {
        const inner = this.parsePipe();
        this.expect(')');
        return inner;
      }
      case '[': {
        if (this.isPunct(']')) {
          this.i++;
          return () => [[]];
        }
        const inner = this.parsePipe();
        this.expect(']');
        return (x) => [inner(x)];
      }
      case '{':
        return this.parseObject();
    }
    throw new JqError(`Unexpected ${JSON.stringify(token.value)}`);
  }

  private parseObject(): JqFilter {
    const entries: [JqFilter, JqFilter][] = [];
    while (!this.isPunct('}')) {
      const token = this.peek();
      let key: JqFilter;
      let shorthand: string | undefined;
      if (token?.type === 'ident' || token?.type === 'string') {
        this.i++;
        key = () => [token.value];
        shorthand = token.value;
      } else if (this.isPunct('(')) {
        this.i++;
        key = this.parsePipe();
        this.expect(')');
      } else {
        throw new JqError(`Expected an object key${this.describeNext()}`);
      }
      let value: JqFilter;
      if (this.isPunct(':')) {
        this.i++;
        value = this.parseAlternative();
      } else if (shorthand !== undefined) {
        const name = shorthand;
        value = (x) => [index(x, name)];
      } else {
        throw new JqError('Computed object keys need a value');
      }
      entries.push([key, value]);
      if (!this.isPunct(',')) break;
      this.i++;
    }
    this.expect('}');
    const filters = entries.flat();
    return (x) =>
      product(filters, x).map((values) => {
        const object: Record<string, unknown> = {};
        for (let i = 0; i < values.length; i += 2) {
          const key = values[i];
          if (typeof key !== 'string') throw new JqError(`Object keys must be strings, got ${typeOf(key)}`);
          object[key] = values[i + 1];
        }
        return object;
      });
  }
}

// ── API ─────────────────────────────────────────────────────────────────

/** Compiles a jq expression. Throws a `JqError` for syntax errors; the filter throws one for runtime errors. */
export function compileJq(expression: string): JqFilter {
  const filter = new Parser(tokenize(expression)).parse();
  return (input) => filter(input).map((value) => (value === undefined ? null : value));
}

/** Formats a jq output the way `jq -r` does: strings raw, everything else as JSON. */
export function formatJqOutput(value: unknown, space?: number): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, space);
}

/**
 * Compiles a template with `{{ expression }}` placeholders, e.g. `{{.name}} ({{.id}})`.
 * Each placeholder is a jq expression; strings are inserted raw, `null` as nothing, other values as JSON.
 */
export function compileTemplate(template: string): (value: unknown) => string {
  const parts: (string | JqFilter)[] = [];
  let rest = template;
  while (rest) {
    const open = rest.indexOf('{{');
    if (open === -1) {
      parts.push(rest);
      break;
    }
    const close = rest.indexOf('}}', open + 2);
    if (close === -1) throw new JqError('Unclosed "{{" in template');
    if (open > 0) parts.push(rest.slice(0, open));
    parts.push(compileJq(rest.slice(open + 2, close)));
    rest = rest.slice(close + 2);
  }
  return (value) =>
    parts
      .map((part) =>
        typeof part === 'string'
          ? part
          : part(value)
              .filter((v) => v !== null)
              .map((v) => formatJqOutput(v))
              .join(' '),
      )
      .join('');
}
