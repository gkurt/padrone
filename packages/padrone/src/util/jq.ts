/**
 * A dependency-free subset of jq for `--jq` and `--template`:
 * - paths: `.`, `.a.b`, `."a-b"`, `.["a"]`, `.[0]`, `.[-1]`, `.[2:4]`, `.[]`, `.a[]`, optional `?`
 * - pipes `|`, comma `,`, alternative `//`, `and` / `or`, comparisons `== != < <= > >=`, arithmetic `+ - * / %`
 * - `if … then … elif … else … end`, variables (`. as $x | …`, `$x`, `{$x}`)
 * - literals, arrays `[...]`, objects `{a, b: .c, "d": 1, (.k): .v}`, parentheses
 * - builtins: `select(f)`, `map(f)`, `sort_by(f)`, `group_by(f)`, `unique_by(f)`, `min_by(f)`, `max_by(f)`, `has(k)`,
 *   `join(s)`, `split(s)`, `ltrimstr(s)`, `rtrimstr(s)`, `startswith(s)`, `endswith(s)`, `test(re; flags)`,
 *   `sub(re; str; flags)`, `gsub(re; str; flags)`, `keys`, `length`, `not`, `empty`, `type`, `tostring`, `tonumber`,
 *   `tojson`, `fromjson`, `first`, `last`, `add`, `sort`, `reverse`, `unique`, `min`, `max`, `to_entries`,
 *   `from_entries`, `ascii_downcase`, `ascii_upcase`
 * - formats: `@text`, `@json`, `@csv`, `@tsv`, `@html`, `@uri`, `@base64`
 */

import type { JqFilter } from './jq-builtins.ts';
import {
  arithmetic,
  BUILTINS,
  compareValues,
  describe,
  FORMATS,
  index,
  iterate,
  JqError,
  product,
  slice,
  truthy,
  typeOf,
} from './jq-builtins.ts';

export type { JqFilter } from './jq-builtins.ts';
export { JqError } from './jq-builtins.ts';

// ── Tokenizer ───────────────────────────────────────────────────────────

type Token =
  | { type: 'field'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'variable'; value: string }
  | { type: 'format'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'punct'; value: string };

const PUNCT = ['==', '!=', '<=', '>=', '//', '<', '>', '.', '[', ']', '{', '}', '(', ')', '|', ',', ':', ';', '?', '+', '-', '*', '/', '%'];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Names after a prefix: `.field`, `$variable`, `@format`. */
const PREFIXED = { '.': 'field', $: 'variable', '@': 'format' } as const;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch in PREFIXED) {
      const name = source.slice(i + 1).match(NAME)?.[0];
      if (name) {
        tokens.push({ type: PREFIXED[ch as keyof typeof PREFIXED], value: name });
        i += name.length + 1;
        continue;
      }
      if (ch !== '.') throw new JqError(`Expected a name after "${ch}" at ${i}`);
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
    const ident = source.slice(i).match(NAME);
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

const COMPARE: Record<string, (c: number) => boolean> = {
  '==': (c) => c === 0,
  '!=': (c) => c !== 0,
  '<': (c) => c < 0,
  '<=': (c) => c <= 0,
  '>': (c) => c > 0,
  '>=': (c) => c >= 0,
};

/** A variable's current value: set while the body of its `as` binding runs (filters run eagerly). */
type Slot = { value: unknown };

class Parser {
  private i = 0;
  private scope: Map<string, Slot>[] = [];
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
  private expectIdent(value: string): void {
    if (!this.isIdent(value)) throw new JqError(`Expected "${value}"${this.describeNext()}`);
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
    const left = this.parseComma();
    if (!this.isPunct('|')) return left;
    this.i++;
    const right = this.parsePipe();
    return (x) => left(x).flatMap(right);
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
    const left = this.parseArithmetic(0);
    const token = this.peek();
    if (token?.type !== 'punct' || !COMPARE[token.value]) return left;
    this.i++;
    const test = COMPARE[token.value]!;
    const right = this.parseArithmetic(0);
    // jq loops over the right side's outputs outermost
    return (x) => product([right, left], x).map(([b, a]) => test(compareValues(a, b)));
  }

  /** `+ -` (level 0) and `* / %` (level 1), left-associative. */
  private parseArithmetic(level: 0 | 1): JqFilter {
    const operators = level === 0 ? ['+', '-'] : ['*', '/', '%'];
    const operand = () => (level === 0 ? this.parseArithmetic(1) : this.parseTerm());
    let left = operand();
    while (operators.some((op) => this.isPunct(op))) {
      const op = (this.tokens[this.i++] as { value: string }).value;
      const l = left;
      const r = operand();
      left = (x) => product([r, l], x).map(([b, a]) => arithmetic(op, a, b));
    }
    return left;
  }

  /** A postfix term, negated by a leading `-`, or `term as $name | body`. */
  private parseTerm(): JqFilter {
    if (this.isPunct('-')) {
      this.i++;
      const operand = this.parseTerm();
      return (x) =>
        operand(x).map((v) => {
          if (typeof v !== 'number') throw new JqError(`${describe(v)} cannot be negated`);
          return -v;
        });
    }
    const term = this.parsePostfix();
    if (!this.isIdent('as')) return term;
    this.i++;
    const variable = this.peek();
    if (variable?.type !== 'variable') throw new JqError(`Expected a $variable after "as"${this.describeNext()}`);
    this.i++;
    this.expect('|');
    const slot: Slot = { value: null };
    this.scope.push(new Map([[variable.value, slot]]));
    const body = this.parsePipe();
    this.scope.pop();
    return (x) =>
      term(x).flatMap((value) => {
        const previous = slot.value;
        slot.value = value;
        try {
          return body(x);
        } finally {
          slot.value = previous;
        }
      });
  }

  private lookup(name: string): Slot {
    for (let i = this.scope.length - 1; i >= 0; i--) {
      const slot = this.scope[i]!.get(name);
      if (slot) return slot;
    }
    throw new JqError(`$${name} is not defined`);
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
    if (token.type === 'variable') {
      const slot = this.lookup(token.value);
      return () => [slot.value];
    }
    if (token.type === 'format') {
      const format = FORMATS[token.value];
      if (!format) throw new JqError(`${token.value} is not a valid format`);
      return (x) => [format(x)];
    }

    if (token.type === 'ident') {
      if (token.value === 'true' || token.value === 'false') return () => [token.value === 'true'];
      if (token.value === 'null') return () => [null];
      if (token.value === 'if') return this.parseIf();
      const args: JqFilter[] = [];
      if (this.isPunct('(')) {
        do {
          this.i++;
          args.push(this.parsePipe());
        } while (this.isPunct(';'));
        this.expect(')');
      }
      const builtin = BUILTINS[`${token.value}/${args.length}`];
      if (!builtin) throw new JqError(`Unknown function ${token.value}/${args.length}`);
      return args.length ? (x) => builtin(x, ...args) : builtin;
    }

    switch (token.value) {
      case '.':
        if (this.peek()?.type === 'string') {
          const key = (this.tokens[this.i++] as { value: string }).value;
          return (x) => [index(x, key)];
        }
        return (x) => [x];
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

  /** After `if`: `cond then a (elif cond then b)* (else c)? end`; without `else`, the input passes through. */
  private parseIf(): JqFilter {
    const condition = this.parsePipe();
    this.expectIdent('then');
    const then = this.parsePipe();
    let otherwise: JqFilter = (x) => [x];
    if (this.isIdent('elif')) {
      this.i++;
      otherwise = this.parseIf();
    } else {
      if (this.isIdent('else')) {
        this.i++;
        otherwise = this.parsePipe();
      }
      this.expectIdent('end');
    }
    return (x) => condition(x).flatMap((c) => (truthy(c) ? then(x) : otherwise(x)));
  }

  private parseObject(): JqFilter {
    const entries: [JqFilter, JqFilter][] = [];
    while (!this.isPunct('}')) {
      const token = this.peek();
      let key: JqFilter;
      let shorthand: JqFilter | undefined;
      if (token?.type === 'ident' || token?.type === 'string') {
        this.i++;
        key = () => [token.value];
        shorthand = (x) => [index(x, token.value)];
      } else if (token?.type === 'variable') {
        this.i++;
        const slot = this.lookup(token.value);
        key = () => [token.value];
        shorthand = () => [slot.value];
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
      } else if (shorthand) {
        value = shorthand;
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
