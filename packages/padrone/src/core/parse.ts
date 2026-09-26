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
   */
  named: {
    type: 'named';
    key: string[];
    value?: string | string[];
    negated?: boolean;
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
  };
};

type ParsePart = ParseParts[keyof ParseParts];

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

/**
 * Parses CLI input into parts. A string (from `eval()` or the REPL) is tokenized first, honoring quotes;
 * an array (argv, already tokenized by the shell) is taken as is — each entry is exactly one token.
 */
export function parseCliInputToParts(input: string | readonly string[]): ParsePart[] {
  const literal = typeof input !== 'string';
  const parts = literal ? input : splitQuoteAware(input.trim(), ' ', { brackets: true });
  const result: ParsePart[] = [];

  // Index into `result` of the last part that can accept a pending value (-1 = none)
  let pendingIdx = -1;
  // Once a non-term positional arg appears, all subsequent bare values become args
  let allowTerm = true;
  let afterDoubleDash = false;

  for (const part of parts) {
    // Bare `--` separator: everything after is a literal positional arg
    if (part === '--' && !afterDoubleDash) {
      pendingIdx = -1;
      afterDoubleDash = true;
      allowTerm = false;
      continue;
    }

    if (afterDoubleDash) {
      result.push({ type: 'arg', value: part });
      continue;
    }

    const hadPending = pendingIdx;
    pendingIdx = -1;

    if (part.startsWith('--no-') && part.length > 5) {
      // Negated boolean arg (--no-verbose or --no-config.debug)
      const key = part.slice(5).split('.');
      result.push({ type: 'named', key, value: undefined, negated: true });
    } else if (part.startsWith('--')) {
      const [keyStr = '', value] = splitNamedArgValue(part.slice(2), literal);
      const key = keyStr.split('.');
      result.push({ type: 'named', key, value });
      if (typeof value === 'undefined') pendingIdx = result.length - 1;
    } else if (part.startsWith('-') && part.length > 1 && !/^-\d/.test(part)) {
      // Short flag(s) (but not negative numbers like -5)
      // Supports flag stacking: -abc → -a -b -c (last flag can take a value)
      const [keyStr = '', value] = splitNamedArgValue(part.slice(1), literal);

      if (keyStr.length > 1 && typeof value === 'undefined') {
        // Flag stacking: -abc → -a, -b, -c (all set to true except last which can take next arg's value)
        for (let ci = 0; ci < keyStr.length - 1; ci++) {
          result.push({ type: 'alias', key: [keyStr[ci]!], value: undefined });
        }
        result.push({ type: 'alias', key: [keyStr[keyStr.length - 1]!], value: undefined });
        pendingIdx = result.length - 1;
      } else if (keyStr.length > 1 && typeof value !== 'undefined') {
        // -abc=val → -a, -b, -c=val (stacked with value on last)
        for (let ci = 0; ci < keyStr.length - 1; ci++) {
          result.push({ type: 'alias', key: [keyStr[ci]!], value: undefined });
        }
        result.push({ type: 'alias', key: [keyStr[keyStr.length - 1]!], value });
      } else {
        // Single char: -v or -v=value
        result.push({ type: 'alias', key: [keyStr], value });
        if (typeof value === 'undefined') pendingIdx = result.length - 1;
      }
    } else if (hadPending >= 0) {
      result[hadPending]!.value = part;
    } else if (/^[a-zA-Z0-9_-]+$/.test(part) && allowTerm) {
      result.push({ type: 'term', value: part });
    } else {
      result.push({ type: 'arg', value: part });
      allowTerm = false;
    }
  }
  return result;
}

/**
 * Split named arg key and value, handling quoted values after =.
 * `literal` (an argv token) keeps quotes as typed: the shell has already removed its own.
 */
function splitNamedArgValue(str: string, literal: boolean): [string, string | string[] | undefined] {
  const eqIndex = str.indexOf('=');
  if (eqIndex === -1) return [str, undefined];

  const key = str.slice(0, eqIndex);
  let value = str.slice(eqIndex + 1);

  // Remove surrounding quotes from value if present
  if (
    !literal &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('`') && value.endsWith('`')))
  ) {
    value = value.slice(1, -1);
    return [key, value];
  }

  // Handle array syntax: [a,b,c] -> ['a', 'b', 'c']
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1);
    if (inner === '') return [key, []];
    return [key, splitQuoteAware(inner, ',', { trim: true })];
  }

  return [key, value];
}

/**
 * Sets a value at a nested path in an object.
 * For example: setNestedValue(obj, ['user', 'profile', 'name'], 'John')
 * Creates intermediate objects as needed.
 */
export function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i]!;
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = path[path.length - 1]!;
  current[lastPart] = value;
}

/**
 * Gets a value at a nested path in an object.
 * Returns undefined if the path doesn't exist.
 */
export function getNestedValue(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;

  for (const part of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
