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
