/**
 * A dependency-free YAML emitter for plain data (what JSON can represent, plus bigints and dates).
 * Strings are double-quoted (JSON style) only when a plain scalar would read back as something else.
 */
export function toYaml(value: unknown): string {
  return yamlLines(value).join('\n');
}

/** Plain scalars that read back as something other than the string: booleans, null, numbers like `.5`, the document end `...`. */
const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~|\.inf|-\.inf|\+\.inf|\.nan|\.\.\.|\.\d.*)$/i;
const PLAIN = /^[A-Za-z_/.(][\w ./@+()~:,=-]*$/;

function yamlString(text: string): string {
  const plain = PLAIN.test(text) && text === text.trim() && !RESERVED.test(text) && !text.includes(': ') && !text.endsWith(':');
  return plain ? text : JSON.stringify(text);
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '.nan';
    if (!Number.isFinite(value)) return value > 0 ? '.inf' : '-.inf';
    return String(value);
  }
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'null' : JSON.stringify(value.toISOString());
  return yamlString(String(value));
}

/** Array items or object entries (a value with `toJSON` as what it serializes to), or `undefined` for a scalar. */
function entriesOf(value: unknown): [string, unknown][] | undefined {
  if (value === null || typeof value !== 'object' || value instanceof Date) return undefined;
  const toJSON = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof toJSON === 'function') return entriesOf(toJSON.call(value));
  if (Array.isArray(value)) return value.map((item) => ['', item]);
  return Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol');
}

/**
 * Reads a flat YAML mapping of strings, like `toYaml` writes for one: `key: value` lines with plain, `'single'` or
 * `"double"` (JSON-style) quoted keys and values, blank lines and `#` comments. Throws on anything else (nesting, lists).
 */
export function parseFlatYaml(text: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '{}') return;
    const fail = (): never => {
      throw new Error(`Line ${index + 1}: expected "key: value", got "${trimmed}"`);
    };
    if (/^\s/.test(line)) fail();
    const [key, rest] = readScalar(trimmed, true) ?? fail();
    const [value, trailing] = !rest || rest.startsWith('#') ? [null, ''] : (readScalar(rest, false) ?? fail());
    if (trailing && !trailing.startsWith('#')) fail();
    if (key !== '__proto__') result[key] = value;
  });
  return result;
}

/** A scalar at the start of `text` and what follows it (after `: ` for a key); `undefined` when there isn't one. */
function readScalar(text: string, isKey: boolean): [string, string] | undefined {
  const after = (rest: string): string | undefined => {
    if (!isKey) return rest.trim();
    const match = /^\s*:(?:\s+|$)/.exec(rest);
    return match ? rest.slice(match[0].length) : undefined;
  };
  if (text.startsWith('"')) {
    const end = /^"(?:[^"\\]|\\.)*"/.exec(text)?.[0];
    if (!end) return undefined;
    const rest = after(text.slice(end.length));
    return rest === undefined ? undefined : [JSON.parse(end) as string, rest];
  }
  if (text.startsWith("'")) {
    const end = /^'(?:[^']|'')*'/.exec(text)?.[0];
    if (!end) return undefined;
    const rest = after(text.slice(end.length));
    return rest === undefined ? undefined : [end.slice(1, -1).replaceAll("''", "'"), rest];
  }
  if (isKey) {
    const match = /:(?:\s+|$)/.exec(text);
    return match ? [text.slice(0, match.index).trim(), text.slice(match.index + match[0].length)] : undefined;
  }
  const comment = text.search(/\s#/);
  return [(comment === -1 ? text : text.slice(0, comment)).trim(), ''];
}

function yamlLines(value: unknown): string[] {
  const entries = entriesOf(value);
  if (!entries) {
    const toJSON = (value as { toJSON?: () => unknown } | null)?.toJSON;
    return [yamlScalar(typeof toJSON === 'function' && !(value instanceof Date) ? toJSON.call(value) : value)];
  }
  const isArray = Array.isArray(value);
  if (entries.length === 0) return [isArray ? '[]' : '{}'];

  const lines: string[] = [];
  for (const [key, item] of entries) {
    const nested = yamlLines(item);
    if (isArray) lines.push(`- ${nested[0]}`, ...nested.slice(1).map((line) => `  ${line}`));
    else if (entriesOf(item)?.length) lines.push(`${yamlString(key)}:`, ...nested.map((line) => `  ${line}`));
    else lines.push(`${yamlString(key)}: ${nested[0]}`);
  }
  return lines;
}
