/**
 * How an option consumes values:
 * - `flag`: takes the next token only if it is a boolean word (`true`, `no`, `off`, …); `=` attaches any value.
 * - `value`: always takes a value — attached (`--out=x`, `-ox`) or the next token, even one starting with `-`.
 * - `optional`: takes the next token only when it doesn't look like an option (e.g. `z.union([z.boolean(), z.string()])`).
 * - `array`: like `value`, and also accepts the `--tags=[a,b]` bracket syntax.
 */
export type OptionArity = 'flag' | 'value' | 'optional' | 'array';

/**
 * Supplies the command-aware knowledge the tokenizer needs. Without one, every option is treated
 * as unknown: it takes the next token when that token doesn't look like an option.
 */
export interface ParseResolver {
  /** Arity of an option by its key path (long form) or single character (`short`). `undefined` when unknown. */
  arity(key: string[], short: boolean): OptionArity | undefined;
  /** Whether a bare term names a subcommand of the current command, without descending into it. */
  isCommand(term: string): boolean;
  /** Called for each routing term, in order, so the resolver can descend into matching subcommands. */
  enter(term: string): void;
}

type ParseParts = {
  /**
   * An alphanumeric term representing a command, subcommand, or positional argument.
   * Note that a term can be ambiguous until fully matched within the command hierarchy.
   * We cannot fully distinguish between a nested command or a positional argument until
   * the command structure is known.
   */
  term: {
    type: 'term';
    value: string;
  };
  /**
   * A positional argument provided to the command.
   * Unlike `term`, this is definitively an argument. This can be determined when
   * the argument is non-alphanumeric, like a path or a number.
   */
  arg: {
    type: 'arg';
    value: string;
  };
  /**
   * An arg provided to the command, prefixed with `--`.
   * If the arg has an `=` sign, the value after it is used as the arg's value.
   * Otherwise, the value is obtained from the next part or set to `true` if no value is provided.
   * The key is an array representing the path for nested args (e.g., `--user.id=123` becomes `['user', 'id']`).
   * `missing` marks an option that requires a value but had none.
   */
  named: {
    type: 'named';
    key: string[];
    value?: string | string[];
    negated?: boolean;
    missing?: boolean;
  };
  /**
   * An alias arg provided to the command, prefixed with `-`.
   * Which arg it maps to cannot be determined until the command structure is known.
   * Aliases cannot be nested, so the key is always a single-element array.
   */
  alias: {
    type: 'alias';
    key: string[];
    value?: string | string[];
    missing?: boolean;
  };
};

export type ParsePart = ParseParts[keyof ParseParts];

type QuoteChar = '"' | "'" | '`';

/**
 * Split a string by a delimiter, respecting quoted segments and optional bracket nesting.
 * Handles escape sequences within quotes (\\" and \\\\). A quoted empty segment (`""`) is kept as an empty token.
 */
function splitQuoteAware(input: string, delimiter: ' ' | ',', opts?: { brackets?: boolean; trim?: boolean }): string[] {
  const results: string[] = [];
  let current = '';
  let quoted = false;
  let inQuote: QuoteChar | null = null;
  let bracketDepth = 0;
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (inQuote) {
      if (char === '\\' && i + 1 < input.length) {
        const nextChar = input[i + 1];
        if (nextChar === inQuote || nextChar === '\\') {
          current += nextChar;
          i += 2;
          continue;
        }
      }
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (opts?.brackets && char === '[') {
      bracketDepth++;
      current += char;
    } else if (opts?.brackets && char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
    } else if (bracketDepth > 0) {
      current += char;
    } else if (char === '"' || char === "'" || char === '`') {
      inQuote = char;
      quoted = true;
    } else if (char === delimiter || (delimiter === ' ' && char === '\t')) {
      if (delimiter === ' ' ? current || quoted : true) {
        results.push(opts?.trim ? current.trim() : current);
        current = '';
        quoted = false;
      }
    } else {
      current += char;
    }
    i++;
  }

  if (delimiter === ' ' ? current || quoted : current || results.length > 0) {
    results.push(opts?.trim ? current.trim() : current);
  }

  return results;
}

const TERM_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const NEGATIVE_NUMBER = /^-(\d|\.\d)/;
/** Words a boolean flag accepts as a separate value (`--verbose false`); anything else stays positional. */
const BOOLEAN_WORD = /^(true|false|yes|no|on|off)$/i;

/** Splits a string (from `eval()` or the REPL) into tokens, honoring quotes and `[...]` groups. */
export function tokenizeInput(input: string | readonly string[]): readonly string[] {
  return typeof input === 'string' ? splitQuoteAware(input.trim(), ' ', { brackets: true }) : input;
}

/**
 * Parses CLI input into parts. A string (from `eval()` or the REPL) is tokenized first, honoring quotes;
 * an array (argv, already tokenized by the shell) is taken as is — each entry is exactly one token.
 *
 * With a `resolver`, value consumption follows each option's arity: `--verbose file.txt` keeps `file.txt`
 * positional when `verbose` is a boolean, and `-n5` reads `5` as the value of `-n`.
 */
export function parseCliInputToParts(input: string | readonly string[], resolver?: ParseResolver): ParsePart[] {
  const literal = typeof input !== 'string';
  const tokens = tokenizeInput(input);
  const result: ParsePart[] = [];

  // Once a non-term positional arg appears, all subsequent bare values become args
  let allowTerm = true;
  let afterDoubleDash = false;
  let i = 0;

  const looksLikeOption = (token: string) => token.startsWith('-') && token.length > 1 && !isNegativeNumber(token);
  const isNegativeNumber = (token: string) => NEGATIVE_NUMBER.test(token) && resolver?.arity([token[1]!], true) === undefined;

  /** Takes the next token as the value of an option with the given arity, if it should. */
  const takeNext = (arity: OptionArity | undefined): string | undefined => {
    const next = tokens[i + 1];
    if (next === undefined || next === '--') return undefined;
    if (arity === 'flag' && !BOOLEAN_WORD.test(next)) return undefined;
    if (arity !== 'value' && arity !== 'array') {
      if (looksLikeOption(next) || resolver?.isCommand(next)) return undefined;
    }
    i++;
    return next;
  };

  const attachValue = (part: ParseParts['named'] | ParseParts['alias'], arity: OptionArity | undefined, inline: string | undefined) => {
    if (inline !== undefined) {
      part.value = parseInlineValue(inline, literal, arity);
      return;
    }
    part.value = takeNext(arity);
    if (part.value === undefined && (arity === 'value' || arity === 'array')) part.missing = true;
  };

  for (; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (afterDoubleDash) {
      result.push({ type: 'arg', value: token });
      continue;
    }

    // Bare `--` separator: everything after is a literal positional arg
    if (token === '--') {
      afterDoubleDash = true;
      allowTerm = false;
      continue;
    }

    if (token.startsWith('--')) {
      const [keyStr, inline] = splitAtEquals(token.slice(2));
      const key = keyStr.split('.');
      const arity = resolver?.arity(key, false);

      // Negated boolean arg (--no-verbose or --no-config.debug), unless `no-…` is itself a known option
      if (keyStr.startsWith('no-') && keyStr.length > 3 && inline === undefined && arity === undefined) {
        result.push({ type: 'named', key: keyStr.slice(3).split('.'), value: undefined, negated: true });
        continue;
      }

      const part: ParseParts['named'] = { type: 'named', key, value: undefined };
      result.push(part);
      attachValue(part, arity, inline);
      continue;
    }

    if (looksLikeOption(token)) {
      // Short flag(s). Supports stacking (-abc → -a -b -c) and attached values (-n5, -ofile, -o=file):
      // the first flag in a stack that takes a value consumes the rest of the token.
      const [chars, inline] = splitAtEquals(token.slice(1));
      for (let ci = 0; ci < chars.length; ci++) {
        const char = chars[ci]!;
        const arity = resolver?.arity([char], true);
        const part: ParseParts['alias'] = { type: 'alias', key: [char], value: undefined };
        result.push(part);

        const rest = chars.slice(ci + 1);
        if (rest && arity !== undefined && arity !== 'flag') {
          part.value = inline === undefined ? rest : `${rest}=${inline}`;
          break;
        }
        if (!rest) attachValue(part, arity, inline);
      }
      continue;
    }

    if (allowTerm && TERM_PATTERN.test(token)) {
      result.push({ type: 'term', value: token });
      resolver?.enter(token);
      continue;
    }

    result.push({ type: 'arg', value: token });
    allowTerm = false;
  }
  return result;
}

/** Splits `key=value` at the first `=`; the value is `undefined` when there is no `=`. */
function splitAtEquals(str: string): [string, string | undefined] {
  const eqIndex = str.indexOf('=');
  return eqIndex === -1 ? [str, undefined] : [str.slice(0, eqIndex), str.slice(eqIndex + 1)];
}

/**
 * Parses a value attached with `=`. From a string input, surrounding quotes are removed
 * (an argv token keeps them: the shell has already removed its own).
 * The `[a,b,c]` array syntax applies to array options, and to unknown ones.
 */
function parseInlineValue(value: string, literal: boolean, arity: OptionArity | undefined): string | string[] {
  if (
    !literal &&
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('`') && value.endsWith('`')))
  ) {
    return value.slice(1, -1);
  }

  if ((arity === 'array' || arity === undefined) && value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1);
    if (inner === '') return [];
    return splitQuoteAware(inner, ',', { trim: true });
  }

  return value;
}

/** Keys that must never be written through, to keep user input from reaching object prototypes. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Sets a value at a nested path in an object.
 * For example: setNestedValue(obj, ['user', 'profile', 'name'], 'John')
 * Creates intermediate objects as needed. A path through `__proto__`, `constructor` or `prototype`
 * is stored as a single flat own key (e.g. `"__proto__.x"`) instead, so it is reported as an unknown option.
 */
export function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.some((part) => UNSAFE_KEYS.has(part))) {
    Object.defineProperty(obj, path.join('.'), { value, enumerable: true, writable: true, configurable: true });
    return;
  }

  let current: Record<string, unknown> = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i]!;
    if (!Object.hasOwn(current, part) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = path[path.length - 1]!;
  current[lastPart] = value;
}

/**
 * Gets a value at a nested path in an object, reading own properties only.
 * Returns undefined if the path doesn't exist.
 */
export function getNestedValue(obj: Record<string, unknown>, path: string[]): unknown {
  if (path.some((part) => UNSAFE_KEYS.has(part))) return Object.hasOwn(obj, path.join('.')) ? obj[path.join('.')] : undefined;

  let current: unknown = obj;

  for (const part of path) {
    if (current === null || current === undefined || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
