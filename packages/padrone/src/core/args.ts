import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { PadroneFieldGroups, PadroneFieldMeta } from '../types/args-meta.ts';
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

/** Behavioral rules declared per field, via `.meta()` or the `fields` config (which takes precedence). */
export interface FieldRules {
  /** Fields that count repeated flags (`-vvv` → 3). */
  counts: Set<string>;
  /** Array fields that take every following value up to the next option (`--tag a b c`). */
  variadic: Set<string>;
  /** Fields whose command-line values can be read from a file (`@path`) or stdin (`-`). */
  fromFile: Set<string>;
  /** Field → the fields it can't be combined with. */
  conflicts: Record<string, string[]>;
  /** Field → the values it implies for other fields. */
  implies: Record<string, Record<string, unknown>>;
  /** Field → the fields that must be provided along with it. */
  requires: Record<string, string[]>;
  /** Field → the value conditions (any of them) under which it's required. */
  requiredIf: Record<string, Record<string, unknown>[]>;
  /** Field → the fields of which one must be provided when it isn't. */
  requiredUnless: Record<string, string[]>;
  /** Groups of fields of which exactly one must be provided. */
  exactlyOne: string[][];
  /** Groups of fields of which at least one must be provided. */
  atLeastOne: string[][];
}

export function extractFieldRules(
  schema: StandardJSONSchemaV1 | undefined,
  fields?: Record<string, PadroneFieldMeta | undefined>,
  groups?: { exactlyOne?: PadroneFieldGroups; atLeastOne?: PadroneFieldGroups },
): FieldRules {
  const rules: FieldRules = {
    counts: new Set(),
    variadic: new Set(),
    fromFile: new Set(),
    conflicts: {},
    implies: {},
    requires: {},
    requiredIf: {},
    requiredUnless: {},
    exactlyOne: toGroups(groups?.exactlyOne),
    atLeastOne: toGroups(groups?.atLeastOne),
  };
  let properties: Record<string, any> = {};
  if (schema) {
    try {
      const jsonSchema = getJsonSchema(schema);
      if (jsonSchema.type === 'object' && jsonSchema.properties) properties = jsonSchema.properties;
    } catch {}
  }

  for (const key of new Set([...Object.keys(properties), ...Object.keys(fields ?? {})])) {
    const meta = fields?.[key];
    const prop = properties[key];
    if (meta?.count ?? prop?.count) rules.counts.add(key);
    if (meta?.variadic ?? prop?.variadic) rules.variadic.add(key);
    if (meta?.fromFile ?? prop?.fromFile) rules.fromFile.add(key);
    const conflicts = toList(meta?.conflicts ?? prop?.conflicts);
    if (conflicts) rules.conflicts[key] = conflicts;
    const implies = meta?.implies ?? prop?.implies;
    if (implies && typeof implies === 'object') rules.implies[key] = implies;
    const requires = toList(meta?.requires ?? prop?.requires);
    if (requires) rules.requires[key] = requires;
    const requiredUnless = toList(meta?.requiredUnless ?? prop?.requiredUnless);
    if (requiredUnless) rules.requiredUnless[key] = requiredUnless;
    const requiredIf = meta?.requiredIf ?? prop?.requiredIf;
    const conditions = (Array.isArray(requiredIf) ? requiredIf : [requiredIf]).filter(
      (c: unknown): c is Record<string, unknown> => isPlainObject(c) && Object.keys(c).length > 0,
    );
    if (conditions.length) rules.requiredIf[key] = conditions;
  }
  return rules;
}

function toList(value: unknown): string[] | undefined {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  return list.length ? list : undefined;
}

/** What sensitive values are replaced with wherever they'd be shown. */
export const REDACTED = '[redacted]';

/** Whether a field holds a secret: `sensitive: true` in the `fields` config or the schema's `.meta()`. */
export function isSensitiveField(meta: PadroneFieldMeta | undefined, prop: Record<string, any> | undefined): boolean {
  return !!(meta?.sensitive ?? prop?.sensitive);
}

/** JSON schema properties with the sensitive ones (nested too) marked `writeOnly`, and their `default` and `examples` dropped. */
export function markSensitiveProperties(
  properties: Record<string, any>,
  fields?: Record<string, PadroneFieldMeta | undefined>,
): Record<string, any> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, prop]) => {
      if (!prop || typeof prop !== 'object') return [key, prop];
      if (isSensitiveField(fields?.[key], prop)) {
        const { default: _default, examples: _examples, ...rest } = prop;
        return [key, { ...rest, writeOnly: true }];
      }
      return [key, prop.properties ? { ...prop, properties: markSensitiveProperties(prop.properties) } : prop];
    }),
  );
}

/** One group (`['a', 'b']`) or several (`[['a', 'b'], ['c', 'd']]`) as a list of groups with two or more fields. */
function toGroups(groups: PadroneFieldGroups | undefined): string[][] {
  if (!groups?.length) return [];
  const list = groups.every((g) => typeof g === 'string') ? [groups as readonly string[]] : (groups as readonly (readonly string[])[]);
  return list.map((group) => [...new Set(group)]).filter((group) => group.length >= 2);
}

/**
 * Applies `implies` and checks `conflicts`, `exactlyOne` and `atLeastOne` on the args the user provided (before defaults).
 * Conflicts are checked first, so implied values never conflict.
 */
export function applyFieldRules(data: Record<string, unknown>, rules: FieldRules): { args: Record<string, unknown>; issues: string[] } {
  const provided = (key: string) => data[key] !== undefined;
  // A value another given option implies isn't a conflict (args passed on again, e.g. after prompting, already hold it)
  const implied = (key: string) =>
    Object.entries(rules.implies).some(
      ([source, values]) =>
        source !== key && provided(source) && data[source] !== false && key in values && sameValue(values[key], data[key]),
    );
  const issues: string[] = [];
  const reported = new Set<string>();

  for (const [key, others] of Object.entries(rules.conflicts)) {
    if (!provided(key) || implied(key)) continue;
    for (const other of others) {
      const pair = [key, other].sort().join('\0');
      if (!provided(other) || implied(other) || reported.has(pair)) continue;
      reported.add(pair);
      issues.push(`Option "--${optionDisplayName(key)}" cannot be used with "--${optionDisplayName(other)}"`);
    }
  }

  const list = (group: string[]) => group.map((key) => `"--${optionDisplayName(key)}"`).join(', ');
  for (const group of rules.exactlyOne) {
    const given = group.filter(provided);
    if (given.length === 0) issues.push(`Exactly one of ${list(group)} is required`);
    else if (given.length > 1) issues.push(`Only one of ${list(given)} can be used`);
  }
  for (const group of rules.atLeastOne) {
    if (!group.some(provided)) issues.push(`At least one of ${list(group)} is required`);
  }

  const args = { ...data };
  for (const [key, implied] of Object.entries(rules.implies)) {
    if (!provided(key) || data[key] === false) continue;
    for (const [target, value] of Object.entries(implied)) {
      if (args[target] === undefined) args[target] = value;
    }
  }
  return { args, issues };
}

const sameValue = (a: unknown, b: unknown) =>
  Object.is(a, b) || (typeof a === 'object' && a !== null && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

/**
 * Checks `requires`, `requiredIf` and `requiredUnless` on the args after `implies` and coercion, so implied values count as
 * provided and `requiredIf` compares typed values (schema defaults aren't applied yet). Each issue's path is the missing option.
 */
export function checkFieldRequirements(args: Record<string, unknown>, rules: FieldRules): { path: string[]; message: string }[] {
  const provided = (key: string) => args[key] !== undefined;
  const option = (key: string) => `"--${optionDisplayName(key)}"`;
  const issues: { path: string[]; message: string }[] = [];

  for (const [key, others] of Object.entries(rules.requires)) {
    if (!provided(key)) continue;
    for (const other of others) {
      if (!provided(other)) issues.push({ path: [other], message: `Option ${option(key)} requires ${option(other)}` });
    }
  }
  for (const [key, conditions] of Object.entries(rules.requiredIf)) {
    if (provided(key)) continue;
    const match = conditions.find((condition) => Object.entries(condition).every(([other, value]) => sameValue(args[other], value)));
    if (!match) continue;
    const when = Object.entries(match).map(([other, value]) => `${option(other)} is ${JSON.stringify(value) ?? String(value)}`);
    issues.push({ path: [key], message: `Option ${option(key)} is required when ${when.join(' and ')}` });
  }
  for (const [key, others] of Object.entries(rules.requiredUnless)) {
    if (provided(key) || others.some(provided)) continue;
    const unless = others.length === 1 ? option(others[0]!) : `one of ${others.map(option).join(', ')}`;
    issues.push({ path: [key], message: `Option ${option(key)} is required unless ${unless} is used` });
  }
  return issues;
}

/** The kebab-case form users type for a field name (`dryRun` → `dry-run`). */
export function optionDisplayName(key: string): string {
  return camelToKebab(key) ?? key;
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
 * Existing values take precedence — only fills in undefined or missing keys. Nested objects are filled key by key,
 * so `--db.host=x` keeps `db.port` from a config file.
 */
export function applyValues(data: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || key === '__proto__') continue;
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (isPlainObject(existing) && isPlainObject(value)) result[key] = applyValues(existing, value);
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

/** Objects and records (not string unions) take their command-line value as JSON. */
const takesJson = (types: Set<string>) => types.has('object') && !types.has('string');

/** How a schema property consumes CLI values, derived from its allowed types. */
export function getOptionArity(prop: Record<string, any> | undefined): OptionArity | undefined {
  if (!prop) return undefined;
  const types = new Set<string>();
  const itemTypes = new Set<string>();
  collectAllowedTypes(prop, types, itemTypes);
  types.delete('null');
  if (types.has('array')) return takesJson(itemTypes) && !types.has('string') ? 'json' : 'array';
  if (types.has('boolean')) return types.size === 1 ? 'flag' : 'optional';
  if (takesJson(types)) return 'json';
  if (types.size === 0) return 'optional';
  return 'value';
}

/** Whether a schema property accepts an array, so its command-line values accumulate (`--tag a --tag b`). */
export function acceptsArray(prop: Record<string, any> | undefined): boolean {
  const types = new Set<string>();
  collectAllowedTypes(prop, types, new Set());
  return types.has('array');
}

/** Parses the JSON object or array given to an option that takes JSON (`--db '{"host":"x"}'`); other values stay as they are. */
export function parseJsonArg(value: unknown): { value: unknown } | { error: string } {
  if (typeof value !== 'string') return { value };
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return { value };
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const jsonOrValue = (value: unknown) => {
  const parsed = parseJsonArg(value);
  return 'value' in parsed ? parsed.value : value;
};

/** `source` merged into `target` key by key (nested objects too), `source` winning. */
export function mergeObjects(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__') continue;
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? mergeObjects(existing, value) : value;
  }
  return result;
}

/**
 * Builds the option lookup for a command: maps a long name, alias, negative keyword or short flag
 * to its arity, following nested paths (`--user.id`).
 */
export function createOptionArityLookup(
  schema: StandardJSONSchemaV1 | undefined,
  metadata: Pick<SchemaMetadataResult, 'flags' | 'aliases' | 'negatives'>,
  rules: Pick<FieldRules, 'counts' | 'variadic'> = { counts: new Set(), variadic: new Set() },
): (key: string[], short: boolean) => OptionArity | undefined {
  const fieldArity = (target: string, prop: Record<string, any> | undefined): OptionArity | undefined => {
    if (rules.counts.has(target)) return 'count';
    const arity = getOptionArity(prop);
    return arity === 'array' && rules.variadic.has(target) ? 'variadic' : arity;
  };

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
      return target ? fieldArity(target, properties[target]) : undefined;
    }
    if (rest.length === 0 && metadata.negatives[head]) return 'flag';
    const target = Object.hasOwn(properties, head) ? head : metadata.aliases[head];
    if (!target) return undefined;
    if (rest.length === 0) return fieldArity(target, properties[target]);
    return getOptionArity(getPropertySchema(properties, [target, ...rest]));
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Coerces each value against its property schema, descending into nested objects (`--user.id=7`) and records.
 * Options that take JSON parse a JSON string (e.g. a file's text read for `fromFile`, or an env value).
 */
function coerceProperties(data: Record<string, unknown>, properties: Record<string, any>): Record<string, unknown> {
  const result = { ...data };

  for (const [key, raw] of Object.entries(result)) {
    const prop = key === '__proto__' || !Object.hasOwn(properties, key) ? undefined : properties[key];
    if (!prop) continue;

    const json = getOptionArity(prop) === 'json';
    const value = json ? jsonOrValue(raw) : raw;
    result[key] = value;
    const types = new Set<string>();
    const itemTypes = new Set<string>();
    collectAllowedTypes(prop, types, itemTypes);

    if (isPlainObject(value)) {
      const additional = prop.additionalProperties;
      if (prop.properties) result[key] = coerceProperties(value, prop.properties);
      else if (additional && typeof additional === 'object')
        result[key] = coerceProperties(value, Object.fromEntries(Object.keys(value).map((k) => [k, additional])));
      else if (types.has('array') && !types.has('object')) result[key] = [value];
      continue;
    }

    const isArrayValue = Array.isArray(value);
    const allowsArray = types.has('array');
    const allowsScalar = types.has('string') || types.has('boolean') || types.has('number') || types.has('integer');

    if (isArrayValue && allowsArray) {
      result[key] = value.map((v) => (json ? jsonOrValue(v) : coerceScalar(v, itemTypes)));
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
