import { extractSchemaMetadata, getJsonSchema, isSensitiveField, parsePositionalConfig, REDACTED } from '../core/args.ts';
import { getGlobalArgs } from '../core/commands.ts';
import { getKnownOptionNames } from '../core/validate.ts';
import type { AnyPadroneCommand, PadroneFieldMeta, PadroneInput, PadroneSchema } from '../types/index.ts';

/**
 * Access to the framework flags an extension reads from `rawArgs` (`--color`, `--version`, …).
 * A command's own option of the same name always wins: such keys read as absent and are never deleted.
 */
export function frameworkFlags(rawArgs: Record<string, unknown>, command: AnyPadroneCommand) {
  const owned = new Set(getKnownOptionNames(command));
  const get = (key: string) => (owned.has(key) ? undefined : rawArgs[key]);
  return {
    has: (key: string) => !owned.has(key) && key in rawArgs,
    get,
    /** A boolean flag's value: `--yes` → `true`, `--no-yes`, `--yes=false` / `0` / `no` / `off` → `false`, absent → `undefined`. */
    flag: (key: string): boolean | undefined => toFlag(get(key)),
    delete: (...keys: string[]) => {
      for (const key of keys) if (!owned.has(key)) delete rawArgs[key];
    },
  };
}

const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/** A raw boolean flag value (`true`, `'false'`, `'off'`, …) as a boolean; `undefined` stays `undefined`. */
export function toFlag(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return !FALSE_WORDS.has(value.toLowerCase());
  return value !== false;
}

/**
 * A framework flag read from the raw input, for when parsing failed (e.g. an unknown command) so there are no `rawArgs`:
 * `--name` → `true`, `--name=value` → `'value'`, `--no-name` → `false`, absent → `undefined`. The last occurrence wins.
 */
export function rawInputFlag(input: PadroneInput | undefined, name: string): unknown {
  const tokens = typeof input === 'string' ? input.split(/\s+/) : (input ?? []);
  let value: unknown;
  for (const token of tokens) {
    if (token === '--') break;
    if (token === `--${name}`) value = true;
    else if (token === `--no-${name}`) value = false;
    else if (token.startsWith(`--${name}=`)) value = token.slice(name.length + 3);
  }
  return value;
}

/**
 * Runs a parse handler's `next()`: `handle` gets the parse result, and `onError` runs before a parse failure
 * (sync or async) is rethrown, so flags can still be read from the raw input.
 */
export function parseWithFallback<T>(next: () => T | Promise<T>, handle: (res: T) => T, onError: () => void): T | Promise<T> {
  const fail = (err: unknown): never => {
    onError();
    throw err;
  };
  let parsed: T | Promise<T>;
  try {
    parsed = next();
  } catch (err) {
    return fail(err);
  }
  return parsed instanceof Promise ? parsed.then(handle, fail) : handle(parsed);
}

/** Turns a result (or one streamed item, `item: true`) into the lines printed under JSON output, e.g. from `--jq`. */
export type JsonOutputFilter = (value: unknown, item?: boolean) => string[];

const jsonOutputFilters = new WeakMap<object, JsonOutputFilter>();

/** Sets how auto-output prints results under JSON output for this run (the runtime is created per run). */
export function setJsonOutputFilter(runtime: object, filter: JsonOutputFilter): void {
  jsonOutputFilters.set(runtime, filter);
}

export function getJsonOutputFilter(runtime: object): JsonOutputFilter | undefined {
  return jsonOutputFilters.get(runtime);
}

/**
 * Prints results in a format of its own when the output isn't JSON (e.g. `-o csv`). `render` gets the result, or one
 * streamed item (`item: true`), and returns the lines to print, or `undefined` to print it as text; `end` runs after a stream.
 */
export type OutputRenderer = { render(value: unknown, item: boolean): string[] | undefined; end?(): string[] };

const outputRenderers = new WeakMap<object, OutputRenderer>();

/** Sets how auto-output prints results for this run, unless JSON output applies (which takes precedence). */
export function setOutputRenderer(runtime: object, renderer: OutputRenderer): void {
  outputRenderers.set(runtime, renderer);
}

export function getOutputRenderer(runtime: object): OutputRenderer | undefined {
  return outputRenderers.get(runtime);
}

/** Callers that return results through their own transport (HTTP, MCP, AI tool calls): no terminal, no stdin. */
const REMOTE_CALLERS = new Set<string>(['serve', 'mcp', 'tool']);

export function isRemoteCaller(caller: string): boolean {
  return REMOTE_CALLERS.has(caller);
}

type PassthroughType = 'string' | 'string[]' | 'boolean';
type PassthroughField = PassthroughType | { type: PassthroughType; description?: string; enum?: readonly string[] };
type SchemaShape = Record<string, PassthroughField>;

type InferPassthroughType<T> = T extends 'string' ? string : T extends 'string[]' ? string[] : T extends 'boolean' ? boolean : never;
type InferPassthroughSchema<T extends SchemaShape> = {
  [K in keyof T]: InferPassthroughType<T[K] extends { type: infer U } ? U : T[K]>;
};

const PASSTHROUGH_JSON_TYPES = {
  string: { type: 'string' },
  'string[]': { type: 'array', items: { type: 'string' } },
  boolean: { type: 'boolean' },
} as const;

function passthroughFieldJsonSchema(field: PassthroughField): Record<string, unknown> {
  if (typeof field === 'string') return PASSTHROUGH_JSON_TYPES[field];
  return {
    ...PASSTHROUGH_JSON_TYPES[field.type],
    ...(field.description && { description: field.description }),
    ...(field.enum && { enum: field.enum }),
  };
}

/**
 * Minimal Standard Schema for built-in commands. Its JSON Schema lists the fields,
 * so help shows them and boolean fields parse as flags (`--setup bash` doesn't take `bash` as its value).
 * Values are passed through without validation.
 */
export function passthroughSchema<TShape extends SchemaShape>(fields: TShape): PadroneSchema<InferPassthroughSchema<TShape>> {
  const jsonSchema = () => ({
    type: 'object',
    properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, passthroughFieldJsonSchema(field)])),
  });
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'padrone' as const,
      jsonSchema: { input: jsonSchema, output: jsonSchema },
      validate: (value) => {
        const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const result: Record<string, unknown> = {};
        for (const [name, field] of Object.entries(fields)) {
          const type = typeof field === 'string' ? field : field.type;
          const v = input[name];
          if (v === undefined) continue;
          if (type === 'string[]') {
            if (Array.isArray(v)) result[name] = v.map(String);
            else if (typeof v === 'string') result[name] = [v];
          } else if (type === 'string') {
            if (typeof v === 'string') result[name] = v;
            else if (Array.isArray(v) && v.length > 0) result[name] = String(v[0]);
          } else if (type === 'boolean') {
            result[name] = v === true || v === 'true';
          }
        }
        return { value: result as InferPassthroughSchema<TShape> };
      },
    },
  };
}

/** Find a command by space-separated name in the command tree. */
export function findCommandInTree(name: string, rootCommand: AnyPadroneCommand): AnyPadroneCommand | undefined {
  const parts = name.split(' ').filter(Boolean);
  let current = rootCommand;
  for (const part of parts) {
    const found = current.commands?.find((c) => c.name === part || c.aliases?.includes(part));
    if (!found) return undefined;
    current = found;
  }
  return current;
}

const reportedErrors = new WeakSet<object>();

/** Marks an error as already printed, so later error handlers (e.g. auto-output) don't print it again. */
export function markErrorReported(error: unknown): void {
  if (error && typeof error === 'object') reportedErrors.add(error);
}

/** Whether an error was already printed by an extension. */
export function isErrorReported(error: unknown): boolean {
  return !!error && typeof error === 'object' && reportedErrors.has(error);
}

/** Whether a positional value lands in `field` (a variadic positional before it may take them all, so this errs toward yes). */
export function isProvidedPositionally(command: AnyPadroneCommand, field: string, positionalArgs: readonly string[]): boolean {
  const positional = command.meta?.positional;
  const index = positional ? parsePositionalConfig(positional).findIndex((p) => p.name === field) : -1;
  return index >= 0 && positionalArgs.length > index;
}

function isLooseSchema(schema: PadroneSchema | undefined): boolean {
  if (!schema) return false;
  try {
    const json = getJsonSchema(schema);
    return json.type !== 'object' || !json.properties || (json.additionalProperties !== undefined && json.additionalProperties !== false);
  } catch {
    return true;
  }
}

/**
 * Values from an outside source (a config file, environment variables) keyed for the command, before they fill `rawArgs`:
 * aliases and kebab-case names (`dry-run`) map to option names, keys the command doesn't know are dropped (unless its schema
 * allows extra keys), `null` means unset, and positionals already given on the command line are left to the command line.
 */
export function valuesForCommand(
  command: AnyPadroneCommand,
  values: Record<string, unknown>,
  positionalArgs: readonly string[],
): Record<string, unknown> {
  const known = new Set(getKnownOptionNames(command));
  const aliases: Record<string, string> = {};
  const collect = (schema: PadroneSchema | undefined, meta: { fields?: any; autoAlias?: boolean } | undefined) => {
    if (!schema) return;
    try {
      const metadata = extractSchemaMetadata(schema, meta?.fields, meta?.autoAlias);
      Object.assign(aliases, metadata.flags, metadata.aliases);
    } catch {}
  };
  const globals = getGlobalArgs(command);
  if (globals) collect(globals.schema, globals.meta);
  collect(command.argsSchema, command.meta);
  const loose = command.argsSchema ? isLooseSchema(command.argsSchema) : false;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    const name = known.has(key) ? key : Object.hasOwn(aliases, key) ? aliases[key] : undefined;
    if (name === undefined) {
      if (loose && key !== '__proto__') result[key] = value;
      continue;
    }
    if (isProvidedPositionally(command, name, positionalArgs)) continue;
    // The option's own name wins over an alias given alongside it
    if (!Object.hasOwn(result, name) || name === key) result[name] = value;
  }
  return result;
}

/** A token written so that tokenizing an input string gives it back as one token (`my branch` → `"my branch"`). */
export function quoteToken(token: string): string {
  return token === '' || /[\s"'`]/.test(token) ? `"${token.replace(/[\\"]/g, '\\$&')}"` : token;
}

function schemaProperties(schema: PadroneSchema | undefined): Record<string, any> {
  if (!schema) return {};
  try {
    const json = getJsonSchema(schema);
    return json.type === 'object' && json.properties ? json.properties : {};
  } catch {
    return {};
  }
}

function redactValue(value: unknown, prop: Record<string, any> | undefined): unknown {
  if (Array.isArray(value)) return prop?.items?.properties ? value.map((item) => redactValue(item, prop.items)) : value;
  if (!value || typeof value !== 'object' || !prop?.properties) return value;
  return redactObject(value as Record<string, unknown>, prop.properties);
}

function redactObject(
  values: Record<string, unknown>,
  properties: Record<string, any>,
  fields?: Record<string, PadroneFieldMeta | undefined>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const prop = Object.hasOwn(properties, key) ? properties[key] : undefined;
    const fieldMeta = fields && Object.hasOwn(fields, key) ? fields[key] : undefined;
    result[key] = value !== undefined && isSensitiveField(fieldMeta, prop) ? REDACTED : redactValue(value, prop);
  }
  return result;
}

/**
 * A copy of a command's args with sensitive fields (`sensitive: true`, nested and global ones too) replaced by `'[redacted]'`,
 * for extensions that log or record args.
 */
export function redactArgs<T>(command: AnyPadroneCommand, args: T): T {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const own = schemaProperties(command.argsSchema);
  const globalArgs = getGlobalArgs(command);
  const globalOnly = ([key]: [string, unknown]) => !Object.hasOwn(own, key);
  const properties = { ...Object.fromEntries(Object.entries(schemaProperties(globalArgs?.schema)).filter(globalOnly)), ...own };
  const fields = { ...Object.fromEntries(Object.entries(globalArgs?.meta?.fields ?? {}).filter(globalOnly)), ...command.meta?.fields };
  return redactObject(args as Record<string, unknown>, properties, fields) as T;
}
