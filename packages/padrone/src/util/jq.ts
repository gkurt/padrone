/**
 * A dependency-free subset of jq for `--jq` and `--template`, evaluated lazily (so `limit`, `first(f)` and `any` stop early):
 * - paths: `.`, `.a.b`, `."a-b"`, `.["a"]`, `.[0]`, `.[-1]`, `.[2:4]`, `.[]`, `.a[]`, `..`, optional `?`
 * - pipes `|`, comma `,`, alternative `//`, `and` / `or`, comparisons `== != < <= > >=`, arithmetic `+ - * / %`
 * - `if … then … elif … else … end`, variables (`. as $x | …`, `$x`, `{$x}`, `$ENV`)
 * - literals, string interpolation (`"\(.a) and \(.b)"`, `@sh "echo \(.name)"`), arrays `[...]`,
 *   objects `{a, b: .c, "d": 1, (.k): .v}`, parentheses
 * - builtins: `select(f)`, `map(f)`, `sort_by(f)`, `group_by(f)`, `unique_by(f)`, `min_by(f)`, `max_by(f)`, `has(k)`,
 *   `join(s)`, `split(s)`, `ltrimstr(s)`, `rtrimstr(s)`, `startswith(s)`, `endswith(s)`, `test(re; flags)`,
 *   `sub(re; str; flags)`, `gsub(re; str; flags)`, `keys`, `length`, `not`, `empty`, `type`, `tostring`, `tonumber`,
 *   `tojson`, `fromjson`, `first`, `last`, `add`, `sort`, `reverse`, `unique`, `min`, `max`, `to_entries`,
 *   `from_entries`, `with_entries(f)`, `ascii_downcase`, `ascii_upcase`, `range(n)`, `range(a; b; step)`, `limit(n; f)`,
 *   `first(f)`, `last(f)`, `any`, `all`, `any(f)`, `all(f)`, `any(gen; f)`, `all(gen; f)`, `values`, `nulls`, `scalars`
 *   (and the other type selectors), `recurse`, `recurse(f)`, `paths`, `paths(f)`, `leaf_paths`, `getpath(p)`,
 *   `setpath(p; v)`, `delpaths(ps)`, `tostream`, `env`
 * - formats: `@text`, `@json`, `@csv`, `@tsv`, `@html`, `@uri`, `@sh`, `@base64`, `@base64d`
 *
 * Every run has a step budget (`maxSteps`), so runaway expressions like `[range(1e9)]` fail fast with a `JqLimitError`.
 */

import type { Builtin, JqFilter } from './jq-builtins.ts';
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
  rethrowLimit,
  runEnv,
  slice,
  tick,
  tostring,
  truthy,
  typeOf,
  withRun,
} from './jq-builtins.ts';
import { GENERATOR_BUILTINS } from './jq-generators.ts';
import type { Token } from './jq-tokenize.ts';
import { tokenize } from './jq-tokenize.ts';

export { JqError, JqLimitError } from './jq-builtins.ts';

const ALL_BUILTINS: Record<string, Builtin> = { ...BUILTINS, ...GENERATOR_BUILTINS };

// ── Parser ──────────────────────────────────────────────────────────────

const COMPARE: Record<string, (c: number) => boolean> = {
  '==': (c) => c === 0,
  '!=': (c) => c !== 0,
  '<': (c) => c < 0,
  '<=': (c) => c <= 0,
  '>': (c) => c > 0,
  '>=': (c) => c >= 0,
};

/** A variable's current value: set while the body of its `as` binding runs. */
type Slot = { value: unknown };

/** `$ENV`, unless a binding shadows it. */
const ENV_SLOT: Slot = {
  get value() {
    return runEnv();
  },
};

/** The outputs of `f` up to its first error, which is suppressed (as `f?` does); budget errors still go through. */
function* suppressErrors(f: JqFilter, x: unknown): Generator<unknown> {
  try {
    yield* f(x);
  } catch (err) {
    rethrowLimit(err);
  }
}

/** Yields every output of `f`, counting each against the budget. */
function* counted(f: JqFilter, x: unknown): Generator<unknown> {
  for (const value of f(x)) {
    tick();
    yield value;
  }
}

class Parser {
  private i = 0;
  private scope: Map<string, Slot>[] = [];
  constructor(private tokens: Token[]) {}

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

  /** Parses the tokens of an interpolation, with the variables in scope here. */
  private parseTokens(tokens: Token[]): JqFilter {
    const [saved, position] = [this.tokens, this.i];
    this.tokens = tokens;
    this.i = 0;
    try {
      return this.parse();
    } finally {
      this.tokens = saved;
      this.i = position;
    }
  }

  private parsePipe(): JqFilter {
    const left = this.parseComma();
    if (!this.isPunct('|')) return left;
    this.i++;
    const right = this.parsePipe();
    return function* (x) {
      for (const value of counted(left, x)) yield* right(value);
    };
  }

  private parseComma(): JqFilter {
    let left = this.parseAlternative();
    while (this.isPunct(',')) {
      this.i++;
      const l = left;
      const r = this.parseAlternative();
      left = function* (x) {
        yield* counted(l, x);
        yield* counted(r, x);
      };
    }
    return left;
  }

  /** `a // b`: the truthy outputs of `a` (its errors suppressed), or else the outputs of `b`. */
  private parseAlternative(): JqFilter {
    let left = this.parseOr();
    while (this.isPunct('//')) {
      this.i++;
      const l = left;
      const r = this.parseOr();
      left = function* (x) {
        let found = false;
        for (const value of suppressErrors(l, x)) {
          if (!truthy(value)) continue;
          found = true;
          yield value;
        }
        if (!found) yield* r(x);
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
      left = function* (x) {
        for (const a of l(x)) {
          if (truthy(a)) yield true;
          else for (const b of r(x)) yield truthy(b);
        }
      };
    }
    return left;
  }

  private parseAnd(): JqFilter {
    let left = this.parseCompare();
    while (this.isIdent('and')) {
      this.i++;
      const l = left;
      const r = this.parseCompare();
      left = function* (x) {
        for (const a of l(x)) {
          if (!truthy(a)) yield false;
          else for (const b of r(x)) yield truthy(b);
        }
      };
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
    return function* (x) {
      for (const [b, a] of product([right, left], x)) yield test(compareValues(a, b));
    };
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
      left = function* (x) {
        for (const [b, a] of product([r, l], x)) yield arithmetic(op, a, b);
      };
    }
    return left;
  }

  /** A postfix term, negated by a leading `-`, or `term as $name | body`. */
  private parseTerm(): JqFilter {
    if (this.isPunct('-')) {
      this.i++;
      const operand = this.parseTerm();
      return function* (x) {
        for (const v of operand(x)) {
          if (typeof v !== 'number') throw new JqError(`${describe(v)} cannot be negated`);
          yield -v;
        }
      };
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
    // The slot holds the value while the body runs, including while it's suspended at a `yield`
    return function* (x) {
      for (const value of counted(term, x)) {
        const previous = slot.value;
        slot.value = value;
        try {
          yield* body(x);
        } finally {
          slot.value = previous;
        }
      }
    };
  }

  private lookup(name: string): Slot {
    for (let i = this.scope.length - 1; i >= 0; i--) {
      const slot = this.scope[i]!.get(name);
      if (slot) return slot;
    }
    if (name === 'ENV') return ENV_SLOT;
    throw new JqError(`$${name} is not defined`);
  }

  private parsePostfix(): JqFilter {
    let filter = this.parsePrimary();
    while (true) {
      const token = this.peek();
      const base = filter;
      if (token?.type === 'field') {
        this.i++;
        filter = function* (x) {
          for (const v of base(x)) yield index(v, token.value);
        };
      } else if (this.isPunct('.') && this.peek(1)?.type === 'string') {
        this.i++;
        const key = (this.tokens[this.i++] as { value: string }).value;
        filter = function* (x) {
          for (const v of base(x)) yield index(v, key);
        };
      } else if (this.isPunct('.') && this.isPunct('[', 1)) {
        this.i++;
      } else if (this.isPunct('[')) {
        filter = this.parseBracket(base);
      } else if (this.isPunct('?')) {
        this.i++;
        filter = (x) => suppressErrors(base, x);
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
      return function* (x) {
        for (const v of base(x)) yield* counted(iterate, v);
      };
    }
    const from: JqFilter = this.isPunct(':') ? () => [null] : this.parsePipe();
    if (this.isPunct(':')) {
      this.i++;
      const to: JqFilter = this.isPunct(']') ? () => [null] : this.parsePipe();
      this.expect(']');
      return function* (x) {
        for (const v of base(x)) for (const [a, b] of product([from, to], x)) yield slice(v, a, b);
      };
    }
    this.expect(']');
    return function* (x) {
      for (const v of base(x)) for (const key of from(x)) yield index(v, key);
    };
  }

  /**
   * A string with interpolations: each value as `format` renders it (strings raw and anything else as JSON without one).
   * Later interpolations vary slowest, as in jq.
   */
  private parseTemplate(parts: (string | Token[])[], format: (x: unknown) => string = tostring): JqFilter {
    const filters = parts.filter((part) => typeof part !== 'string').map((tokens) => this.parseTokens(tokens));
    const reversed = [...filters].reverse();
    return function* (x) {
      for (const values of product(reversed, x)) {
        let n = values.length;
        yield parts.map((part) => (typeof part === 'string' ? part : format(values[--n]))).join('');
      }
    };
  }

  private parsePrimary(): JqFilter {
    const token = this.peek();
    if (!token) throw new JqError('Unexpected end of expression');
    this.i++;

    if (token.type === 'field') return (x) => [index(x, token.value)];
    if (token.type === 'string' || token.type === 'number') return () => [token.value];
    if (token.type === 'template') return this.parseTemplate(token.parts);
    if (token.type === 'variable') {
      const slot = this.lookup(token.value);
      return () => [slot.value];
    }
    if (token.type === 'format') {
      const format = FORMATS[token.value];
      if (!format) throw new JqError(`${token.value} is not a valid format`);
      // `@sh "echo \(.name)"`: the format applies to each interpolated value
      const next = this.peek();
      if (next?.type === 'string' || next?.type === 'template') {
        this.i++;
        return this.parseTemplate(next.type === 'string' ? [next.value] : next.parts, format);
      }
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
      const builtin = ALL_BUILTINS[`${token.value}/${args.length}`];
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
      case '..':
        return ALL_BUILTINS['recurse/0']!;
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
        return (x) => [Array.from(inner(x))];
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
    return function* (x) {
      for (const c of condition(x)) yield* truthy(c) ? then(x) : otherwise(x);
    };
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
      } else if (token?.type === 'template') {
        this.i++;
        key = this.parseTemplate(token.parts);
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
    return function* (x) {
      for (const values of product(filters, x)) {
        const pairs: [string, unknown][] = [];
        for (let i = 0; i < values.length; i += 2) {
          const key = values[i];
          if (typeof key !== 'string') throw new JqError(`Object keys must be strings, got ${typeOf(key)}`);
          pairs.push([key, values[i + 1]]);
        }
        // Defines own properties, so a "__proto__" key is a key
        yield Object.fromEntries(pairs);
      }
    };
  }
}

// ── API ─────────────────────────────────────────────────────────────────

/** The step budget of a run when `maxSteps` isn't given. */
export const DEFAULT_JQ_MAX_STEPS = 10_000_000;

export type JqOptions = {
  /**
   * How much work one run may do, in steps: each value a generator, pipe or iteration produces, and each character or item
   * a string or array concatenation copies. Going over fails the run with a `JqLimitError`. Defaults to `DEFAULT_JQ_MAX_STEPS`.
   */
  maxSteps?: number;
  /** The variables `$ENV` and `env` see. Defaults to none. */
  env?: Record<string, string | undefined>;
};

/** A compiled jq program: every output for an input. */
export type JqProgram = (input: unknown) => unknown[];

/** Compiles a jq expression. Throws a `JqError` for syntax errors; the program throws one for runtime errors. */
export function compileJq(expression: string, options: JqOptions = {}): JqProgram {
  const filter = new Parser(tokenize(expression).tokens).parse();
  const env = Object.fromEntries(Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const run = { maxSteps: options.maxSteps ?? DEFAULT_JQ_MAX_STEPS, env };
  return (input) => withRun(run, () => Array.from(filter(input), (value) => (value === undefined ? null : value)));
}

/** Formats a jq output the way `jq -r` does: strings raw, everything else as JSON. */
export function formatJqOutput(value: unknown, space?: number): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, space);
}

/**
 * Compiles a template with `{{ expression }}` placeholders, e.g. `{{.name}} ({{.id}})`.
 * Each placeholder is a jq expression; strings are inserted raw, `null` as nothing, other values as JSON.
 */
export function compileTemplate(template: string, options?: JqOptions): (value: unknown) => string {
  const parts: (string | JqProgram)[] = [];
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
    parts.push(compileJq(rest.slice(open + 2, close), options));
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
