/** The tokenizer of the jq subset in `jq.ts`. */

import { JqError } from './jq-builtins.ts';

export type Token =
  | { type: 'field'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'variable'; value: string }
  | { type: 'format'; value: string }
  | { type: 'string'; value: string }
  /** A string with interpolations: literal text and the tokens of each `\(…)`; `value` is its source. */
  | { type: 'template'; value: string; parts: (string | Token[])[] }
  | { type: 'number'; value: number }
  | { type: 'punct'; value: string };

/** Longest first, so `==` isn't read as `=` `=`. */
const PUNCT = '== != <= >= // .. < > . [ ] { } ( ) | , : ; ? + - * / %'.split(' ');

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Names after a prefix: `.field`, `$variable`, `@format`. */
const PREFIXED = { '.': 'field', $: 'variable', '@': 'format' } as const;

function decodeString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    throw new JqError(`Invalid string literal "${raw}"`);
  }
}

/** A string literal starting at `start` (its opening quote): the token and the index after its closing quote. */
function tokenizeString(source: string, start: number): { token: Token; end: number } {
  const parts: (string | Token[])[] = [];
  let segment = start + 1;
  let j = segment;
  while (source[j] !== '"') {
    if (j >= source.length) throw new JqError('Unterminated string');
    if (source[j] === '\\' && source[j + 1] === '(') {
      parts.push(decodeString(source.slice(segment, j)));
      const inner = tokenize(source, j + 2, true);
      parts.push(inner.tokens);
      j = segment = inner.end + 1;
      continue;
    }
    j += source[j] === '\\' ? 2 : 1;
  }
  parts.push(decodeString(source.slice(segment, j)));
  const token: Token =
    parts.length === 1 ? { type: 'string', value: parts[0] as string } : { type: 'template', value: source.slice(start, j + 1), parts };
  return { token, end: j + 1 };
}

/** Tokens from `start`; `nested` (inside `\(…)`) stops at the unmatched `)`, returning its index as `end`. */
export function tokenize(source: string, start = 0, nested = false): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let depth = 0;
  let i = start;
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
      const { token, end } = tokenizeString(source, i);
      tokens.push(token);
      i = end;
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
    if (nested && punct === '(') depth++;
    if (nested && punct === ')' && depth-- === 0) return { tokens, end: i };
    tokens.push({ type: 'punct', value: punct });
    i += punct.length;
  }
  if (nested) throw new JqError('Unterminated string interpolation');
  return { tokens, end: i };
}
