import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { PadroneFieldMeta } from '../types/args-meta.ts';
import { camelToKebab } from '../util/shell-utils.ts';
import { asyncStreamRegistry } from '../util/stream.ts';
import type { OptionArity } from './parse.ts';

export type { PadroneArgsSchemaMeta, PadroneFieldMeta, SingleChar, StdinConfig } from '../types/args-meta.ts';

/** Extract the JSON schema from a Standard Schema, returning it as a plain record. */
export function getJsonSchema(schema: StandardJSONSchemaV1): Record<string, any> {
  return schema['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
    libraryOptions: { unrepresentable: 'any' },
  }) as Record<string, any>;
}

function getFieldJsonSchema(schema: StandardJSONSchemaV1 | undefined, field: string): Record<string, any> | undefined {
  if (!schema) return undefined;
  try {
    const jsonSchema = getJsonSchema(schema);
    if (jsonSchema.type === 'object' && jsonSchema.properties) return jsonSchema.properties[field];
  } catch {}
  return undefined;
}

/**
 * Checks if a field in the schema is an array type (e.g. `z.string().array()`).
 */
export function isArrayField(schema: StandardJSONSchemaV1 | undefined, field: string): boolean {
  return getFieldJsonSchema(schema, field)?.type === 'array';
}

/**
 * Checks if a field is an async stream (marked with `asyncStream()` metadata).
 * Returns the item schema if provided, or `true` if it's a plain string stream.
 */
export function isAsyncStreamField(schema: StandardJSONSchemaV1 | undefined, field: string): { itemSchema?: StandardSchemaV1 } | false {
  const prop = getFieldJsonSchema(schema, field);
  const asyncStreamId = prop?.asyncStream;
  if (asyncStreamId && asyncStreamRegistry.has(asyncStreamId)) {
    const meta = asyncStreamRegistry.get(asyncStreamId);
    return { itemSchema: meta?.itemSchema };
  }

  return false;
}

/**
 * Parse positional configuration to extract names and variadic info.
 */
export function parsePositionalConfig(positional: readonly string[]): { name: string; variadic: boolean }[] {
  return positional.map((p) => {
    const variadic = p.startsWith('...');
    const name = variadic ? p.slice(3) : p;
    return { name, variadic };
  });
}

/**
 * Result type for extractSchemaMetadata function.
 */
interface SchemaMetadataResult {
  /** Single-char flags: maps flag char → full arg name (e.g. `{ v: 'verbose' }`) */
  flags: Record<string, string>;
  /** Multi-char aliases: maps alias → full arg name (e.g. `{ 'dry-run': 'dryRun' }`) */
  aliases: Record<string, string>;
  /** Negative keywords: maps keyword → target arg name (e.g. `{ remote: 'local' }`) */
  negatives: Record<string, string>;
  /** Args that have custom negation set (even if empty), disabling the `--no-` prefix */
  customNegation: Set<string>;
}

function addEntries(target: Record<string, string>, key: string, items: string | readonly string[], filter?: (item: string) => boolean) {
  const list = typeof items === 'string' ? [items] : items;
  for (const item of list) {
    if (typeof item === 'string' && item && item !== key && !(item in target) && (!filter || filter(item))) {
      target[item] = key;
    }
  }
}

/**
 * Extract all arg metadata from schema and meta in a single pass.
 * Returns flags (single-char, stackable) and aliases (multi-char, long names) separately.
 * When `autoAlias` is true (default), camelCase property names automatically get kebab-case aliases.
 */
export function extractSchemaMetadata(
  schema: StandardJSONSchemaV1,
  meta?: Record<string, PadroneFieldMeta | undefined>,
  autoAlias?: boolean,
): SchemaMetadataResult {
  const flags: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  const negatives: Record<string, string> = {};
  const customNegation = new Set<string>();

  // Extract from meta object
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (!value) continue;

      if (value.flags) {
        addEntries(flags, key, value.flags, (item) => item.length === 1);
      }
      if (value.alias) {
        addEntries(aliases, key, value.alias, (item) => item.length > 1);
      }
      if (value.negative !== undefined) {
        customNegation.add(key);
        addEntries(negatives, key, value.negative);
      }
    }
  }

  // Extract from JSON schema properties
  try {
    const jsonSchema = getJsonSchema(schema) as Record<string, any>;
    if (jsonSchema.type === 'object' && jsonSchema.properties) {
      for (const [propertyName, propertySchema] of Object.entries(jsonSchema.properties as Record<string, any>)) {
        if (!propertySchema) continue;

        // Extract flags from schema `.meta({ flags: ... })`
        const propFlags = propertySchema.flags;
        if (propFlags) {
          addEntries(flags, propertyName, propFlags, (item) => item.length === 1);
        }

        // Extract aliases from schema `.meta({ alias: ... })`
        const propAlias = propertySchema.alias;
        if (propAlias) {
          const list = typeof propAlias === 'string' ? [propAlias] : propAlias;
          if (Array.isArray(list)) {
            addEntries(aliases, propertyName, list, (item) => item.length > 1);
          }
        }

        // Extract negative keywords from schema `.meta({ negative: ... })`
        const propNegative = propertySchema.negative;
        if (propNegative !== undefined && !customNegation.has(propertyName)) {
          customNegation.add(propertyName);
          const list = typeof propNegative === 'string' ? [propNegative] : propNegative;
          if (Array.isArray(list)) {
            addEntries(negatives, propertyName, list);
          }
        }

        // Auto-generate kebab-case alias for camelCase property names
        if (autoAlias !== false) {
          const kebab = camelToKebab(propertyName);
          if (kebab && !(kebab in aliases)) {
            aliases[kebab] = propertyName;
          }
        }
      }
    }
  } catch {
    // Ignore errors from JSON schema generation
  }

  return { flags, aliases, negatives, customNegation };
}

function preprocessMappings(data: Record<string, unknown>, mappings: Record<string, string>): Record<string, unknown> {
  const result = { ...data };

  for (const [mappedKey, fullArgName] of Object.entries(mappings)) {
    if (mappedKey in data && mappedKey !== fullArgName) {
      const mappedValue = data[mappedKey];
      // Prefer full arg name if it exists
      if (!(fullArgName in result)) result[fullArgName] = mappedValue;
      delete result[mappedKey];
    }
  }

  return result;
}

/**
 * Apply values to arguments using "set if not present" semantics.
 * Existing values take precedence — only fills in undefined or missing keys.
 */
export function applyValues(data: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };

  for (const [key, value] of Object.entries(values)) {
    if (key in result && result[key] !== undefined) continue;
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

/** Applies flag and alias mappings to raw arguments. */
export function preprocessArgs(
  data: Record<string, unknown>,
  ctx: { flags?: Record<string, string>; aliases?: Record<string, string> },
): Record<string, unknown> {
  let result = { ...data };

  if (ctx.flags && Object.keys(ctx.flags).length > 0) {
    result = preprocessMappings(result, ctx.flags);
  }
  if (ctx.aliases && Object.keys(ctx.aliases).length > 0) {
    result = preprocessMappings(result, ctx.aliases);
  }

  return result;
}

/**
 * Walk a JSON schema fragment and collect the set of allowed primitive types,
 * descending into `anyOf` / `oneOf` (used for unions). For variants whose type
 * is `array`, item types are collected separately into `itemTypes`.
 */
function collectAllowedTypes(prop: Record<string, any> | undefined, types: Set<string>, itemTypes: Set<string>): void {
  if (!prop) return;

  if (prop.type !== undefined) {
    const list = Array.isArray(prop.type) ? prop.type : [prop.type];
    for (const t of list) {
      if (typeof t === 'string') types.add(t);
    }
    if (list.includes('array') && prop.items) {
      collectAllowedTypes(prop.items, itemTypes, new Set());
    }
  }

  const variants = prop.anyOf ?? prop.oneOf;
  if (Array.isArray(variants)) {
    for (const variant of variants) collectAllowedTypes(variant, types, itemTypes);
  }
}

/** Resolves the JSON schema of a (possibly nested) property path, e.g. `['user', 'id']`. */
function getPropertySchema(properties: Record<string, any>, path: readonly string[]): Record<string, any> | undefined {
  let prop: Record<string, any> | undefined = properties[path[0]!];
  for (const segment of path.slice(1)) {
    if (!prop) return undefined;
    const nested: Record<string, any> | undefined =
      prop.properties?.[segment] ?? (prop.anyOf ?? prop.oneOf)?.find((v: any) => v?.properties?.[segment])?.properties[segment];
    prop = nested ?? (prop.additionalProperties && typeof prop.additionalProperties === 'object' ? prop.additionalProperties : undefined);
  }
  return prop;
}

/** How a schema property consumes CLI values, derived from its allowed types. */
export function getOptionArity(prop: Record<string, any> | undefined): OptionArity | undefined {
  if (!prop) return undefined;
  const types = new Set<string>();
  collectAllowedTypes(prop, types, new Set());
  types.delete('null');
  if (types.has('array')) return 'array';
  if (types.has('boolean')) return types.size === 1 ? 'flag' : 'optional';
  if (types.size === 0) return 'optional';
  return 'value';
}

/**
 * Builds the option lookup for a command: maps a long name, alias, negative keyword or short flag
 * to its arity, following nested paths (`--user.id`).
 */
export function createOptionArityLookup(
  schema: StandardJSONSchemaV1 | undefined,
  metadata: Pick<SchemaMetadataResult, 'flags' | 'aliases' | 'negatives'>,
): (key: string[], short: boolean) => OptionArity | undefined {
  let properties: Record<string, any> = {};
  if (schema) {
    try {
      const jsonSchema = getJsonSchema(schema);
      if (jsonSchema.type === 'object' && jsonSchema.properties) properties = jsonSchema.properties;
    } catch {}
  }

  return (key, short) => {
    const [head, ...rest] = key;
    if (head === undefined) return undefined;
    if (short) {
      const target = metadata.flags[head];
      return target ? getOptionArity(properties[target]) : undefined;
    }
    if (rest.length === 0 && metadata.negatives[head]) return 'flag';
    const target = Object.hasOwn(properties, head) ? head : metadata.aliases[head];
    return target ? getOptionArity(getPropertySchema(properties, [target, ...rest])) : undefined;
  };
}

const DECIMAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Coerce a single CLI string to a primitive based on the set of allowed types. */
function coerceScalar(value: unknown, allowedTypes: Set<string>): unknown {
  if (typeof value !== 'string') return value;

  if (allowedTypes.has('boolean')) {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  }

  // Decimal notation only: `Number()` alone would also accept '0x10', 'Infinity' and ' 5 '.
  if ((allowedTypes.has('number') || allowedTypes.has('integer')) && DECIMAL_NUMBER.test(value)) return Number(value);

  return value;
}

/**
 * Auto-coerce CLI string values to match the expected schema types.
 * Handles: string → number, string → boolean for primitive schema fields.
 * Arrays of primitives are also coerced element-wise.
 * Union types (`anyOf` / `oneOf`) are coerced to the most specific matching
 * primitive — e.g. `--test true` for `z.union([z.boolean(), z.string()])`
 * becomes the boolean `true` rather than the string "true".
 */
export function coerceArgs(data: Record<string, unknown>, schema: StandardJSONSchemaV1): Record<string, unknown> {
  let properties: Record<string, any>;
  try {
    const jsonSchema = getJsonSchema(schema) as Record<string, any>;
    if (jsonSchema.type !== 'object' || !jsonSchema.properties) return data;
    properties = jsonSchema.properties;
  } catch {
    return data;
  }

  return coerceProperties(data, properties);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Coerces each value against its property schema, descending into nested objects (`--user.id=7`). */
function coerceProperties(data: Record<string, unknown>, properties: Record<string, any>): Record<string, unknown> {
  const result = { ...data };

  for (const [key, value] of Object.entries(result)) {
    const prop = properties[key];
    if (!prop) continue;

    if (isPlainObject(value)) {
      if (prop.properties) result[key] = coerceProperties(value, prop.properties);
      continue;
    }

    const types = new Set<string>();
    const itemTypes = new Set<string>();
    collectAllowedTypes(prop, types, itemTypes);

    const isArrayValue = Array.isArray(value);
    const allowsArray = types.has('array');
    const allowsScalar = types.has('string') || types.has('boolean') || types.has('number') || types.has('integer');

    if (isArrayValue && allowsArray) {
      result[key] = value.map((v) => coerceScalar(v, itemTypes));
    } else if (!isArrayValue && allowsArray && !allowsScalar) {
      // Wrap single value into an array when only array shapes are allowed
      result[key] = [coerceScalar(value, itemTypes)];
    } else if (!isArrayValue) {
      result[key] = coerceScalar(value, types);
    }
  }

  return result;
}

/**
 * Detect unknown keys in the args that don't match any schema property.
 * Returns an array of { key } for each unknown key.
 * Framework-reserved keys (--config, -c) are always allowed.
 */
export function detectUnknownArgs(
  data: Record<string, unknown>,
  schema: StandardJSONSchemaV1,
  flags: Record<string, string>,
  aliases: Record<string, string>,
  negatives?: Record<string, string>,
): { key: string }[] {
  let properties: Record<string, any>;
  let isLoose = false;
  try {
    const jsonSchema = getJsonSchema(schema) as Record<string, any>;
    if (jsonSchema.type !== 'object' || !jsonSchema.properties) return [];
    properties = jsonSchema.properties;
    // If additionalProperties is set (true, {}, or a schema), the schema allows extra keys
    if (jsonSchema.additionalProperties !== undefined && jsonSchema.additionalProperties !== false) isLoose = true;
  } catch {
    return [];
  }

  if (isLoose) return [];

  const knownKeys = new Set<string>([
    ...Object.keys(properties),
    ...Object.keys(flags),
    ...Object.values(flags),
    ...Object.keys(aliases),
    ...Object.values(aliases),
    ...(negatives ? Object.keys(negatives) : []),
    ...(negatives ? Object.values(negatives) : []),
  ]);
  const unknowns: { key: string }[] = [];

  for (const key of Object.keys(data)) {
    if (!knownKeys.has(key)) {
      unknowns.push({ key });
    }
  }

  return unknowns;
}
