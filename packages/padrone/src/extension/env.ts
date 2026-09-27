import type { StandardSchemaV1 } from '@standard-schema/spec';
import { applyValues, getOptionArity, isPlainObject } from '../core/args.ts';
import { getGlobalArgs, isBuiltinCommand } from '../core/commands.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import { getKnownOptionNames } from '../core/validate.ts';
import type {
  AnyPadroneBuilder,
  AnyPadroneCommand,
  CommandTypesBase,
  InterceptorValidateContext,
  InterceptorValidateResult,
} from '../types/index.ts';
import type { LoadEnvFilesOptions } from '../util/dotenv.ts';
import { loadEnvFiles } from '../util/dotenv.ts';
import type { WithAsync } from '../util/type-utils.ts';
import { addedPaths, schemaProperties, valuesForCommand, withIssueSources } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

/**
 * `.env` files are loaded when any of `modes`, `local`, `dir`, `override` or `base` is set
 * (e.g. `{ dir: '.' }` or `{ modes: [] }` loads just `.env` and `.env.local`).
 */
export type PadroneEnvOptions = {
  /** Env modes to load (e.g. `['production']`). Loads `.env.{mode}` files. */
  modes?: string[];
  /** Whether to load `.env.local` and `.env.{mode}.local` files. @default true */
  local?: boolean;
  /** Directory to search for `.env` files. @default process.cwd() */
  dir?: string;
  /** When `true`, file values override `process.env` values. @default false */
  override?: boolean;
  /** When `false`, the base `.env` (and `.env.local`) files are not loaded. @default true */
  base?: boolean;
  /**
   * Map args to environment variables directly, e.g. `{ port: 'APP_PORT', token: ['API_TOKEN', 'TOKEN'] }`
   * (the first variable that is set wins); a dotted key sets a nested value (`{ 'db.host': 'DB_HOST' }`).
   * Values are strings, coerced by the command's schema like CLI input. These variables are shown in help.
   * Can be combined with an env schema.
   */
  vars?: Record<string, string | readonly string[]>;
  /**
   * Read every option from a prefixed variable, like yargs' `.env('MY_APP')`: with `prefix: 'MY_APP'`,
   * `--dry-run` / `dryRun` reads `MY_APP_DRY_RUN`, and a double underscore (`nestedSeparator`) reaches into objects
   * (`MY_APP_DB__HOST` → `db.host`). Variables named in `vars` take precedence. Shown in help.
   */
  prefix?: string;
  /** What separates the keys of a nested value in a prefixed variable name (`MY_APP_DB__HOST` → `db.host`). @default '__' */
  nestedSeparator?: string;
  /**
   * What splits a variable for an array option into items, like viper's string slices: `MY_APP_TAGS=a,b` → `['a', 'b']`
   * (items are trimmed, empty ones dropped). A value in brackets is read as a JSON array (`["a,b", "c"]`), and arrays of
   * objects always take JSON. `false` keeps the value as one item. @default ','
   */
  arraySeparator?: string | false;
  /** Read variables set to an empty string (`APP_PORT=`) as empty values; by default they count as unset. @default false */
  allowEmpty?: boolean;
  /** Also fill the options of built-in commands (`help`, `version`, `config`, `serve`, …). @default false */
  builtins?: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────

function isSchema(value: unknown): value is StandardSchemaV1 {
  return value != null && typeof value === 'object' && '~standard' in value;
}

/** `MY_APP` + `dryRun` → `MY_APP_DRY_RUN`. */
function prefixedEnvName(prefix: string, arg: string): string {
  const name = arg
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase();
  return prefix && !prefix.endsWith('_') ? `${prefix}_${name}` : `${prefix}${name}`;
}

type EnvVarNames = (arg: string) => string | readonly string[] | undefined;
/** Values read from variables, and (at the same paths) the variable each one came from. */
type EnvValues = { values: Record<string, unknown>; sources: Record<string, unknown> };

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Sets `value` at `path` (and the variable it came from in `sources`), unless a value is already there. */
function setEnvValue({ values, sources }: EnvValues, path: readonly string[], value: string, name: string): void {
  if (path.some((key) => UNSAFE_KEYS.has(key))) return;
  let target = values;
  let names = sources;
  for (const key of path.slice(0, -1)) {
    if (target[key] === undefined) {
      target[key] = {};
      names[key] = {};
    }
    if (typeof target[key] !== 'object') return;
    target = target[key] as Record<string, unknown>;
    names = names[key] as Record<string, unknown>;
  }
  const last = path.at(-1)!;
  if (target[last] !== undefined) return;
  target[last] = value;
  names[last] = name;
}

/** Reads each arg (a dotted one into nested objects) from the first of its variables that is set. */
function readEnvVars(env: Record<string, string | undefined>, args: readonly string[], namesOf: EnvVarNames, into: EnvValues): void {
  for (const arg of args) {
    const names = namesOf(arg);
    if (!names) continue;
    const name = (typeof names === 'string' ? [names] : names).find((n) => env[n] !== undefined);
    if (name) setEnvValue(into, arg.split('.'), env[name]!, name);
  }
}

/** The properties of a command's options, its global ones included. */
function commandProperties(command: AnyPadroneCommand): Record<string, any> {
  return { ...schemaProperties(getGlobalArgs(command)?.schema), ...schemaProperties(command.argsSchema) };
}

/** Nested values from prefixed variables with `separator` between the keys: `MY_APP_DB__MAX_CONNS` → `db.maxConns`. */
function readNestedEnvVars(
  env: Record<string, string | undefined>,
  prefix: string,
  separator: string,
  command: AnyPadroneCommand,
  into: EnvValues,
): void {
  const head = prefixedEnvName(prefix, '');
  const properties = commandProperties(command);
  const options = getKnownOptionNames(command);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith(head) || !name.includes(separator)) continue;
    const [first, ...rest] = name.slice(head.length).split(separator);
    const option = options.find((o) => prefixedEnvName('', o) === first);
    if (!option || rest.some((segment) => !segment)) continue;
    let prop = properties[option];
    const path = [option];
    for (const segment of rest) {
      const nested: Record<string, any> = prop?.properties ?? {};
      const key = Object.keys(nested).find((k) => prefixedEnvName('', k) === segment) ?? segment.toLowerCase();
      path.push(key);
      prop = nested[key];
    }
    setEnvValue(into, path, value, name);
  }
}

/** The string values of array options (in nested objects too) split into items: a JSON array as is, else on `separator`. */
function splitArrays(values: Record<string, unknown>, properties: Record<string, any>, separator: string): Record<string, unknown> {
  const result = { ...values };
  for (const [key, value] of Object.entries(values)) {
    const prop = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!prop) continue;
    if (isPlainObject(value) && prop.properties) result[key] = splitArrays(value, prop.properties, separator);
    if (typeof value !== 'string' || getOptionArity(prop) !== 'array') continue;
    const json = value.trim().startsWith('[') ? jsonArray(value) : undefined;
    result[key] = json ?? value.split(separator).flatMap((item) => item.trim() || []);
  }
  return result;
}

function jsonArray(text: string): unknown[] | undefined {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The variable the value at `path` (or the value it's inside, like an array's item) came from. */
function sourceIn(sources: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = sources;
  for (const key of path) {
    if (typeof current === 'string') break;
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that reads environment variables, validates them against a schema,
 * and merges the transformed values into command arguments.
 *
 * Supports loading `.env` files with mode-based overrides and variable expansion.
 *
 * ```ts
 * // Schema only (reads process.env)
 * .extend(padroneEnv(
 *   z.object({ PORT: z.string() }).transform(e => ({ port: Number(e.PORT) }))
 * ))
 *
 * // Schema + .env file loading
 * .extend(padroneEnv(
 *   z.object({ PORT: z.string() }).transform(e => ({ port: Number(e.PORT) })),
 *   { modes: ['production'] }
 * ))
 *
 * // .env file loading only (no schema validation)
 * .extend(padroneEnv({ modes: ['production'] }))
 *
 * // Every option from MY_APP_* variables (`--dry-run` ← MY_APP_DRY_RUN, `--db.host` ← MY_APP_DB__HOST)
 * .extend(padroneEnv({ prefix: 'MY_APP' }))
 * ```
 *
 * Env values have lower precedence than CLI args and stdin, but higher than config files. Variables set to an empty
 * string count as unset (unless `allowEmpty`), built-in commands (`help`, `config`, `serve`, …) aren't filled
 * (unless `builtins`), and a validation error about a value from a variable names it: `… (from MY_APP_PORT)`.
 */
export function padroneEnv(schema: StandardSchemaV1): <T extends CommandTypesBase>(builder: T) => WithAsync<T>;
export function padroneEnv(schema: StandardSchemaV1, options: PadroneEnvOptions): <T extends CommandTypesBase>(builder: T) => WithAsync<T>;
export function padroneEnv(options: PadroneEnvOptions): <T extends CommandTypesBase>(builder: T) => WithAsync<T>;
export function padroneEnv(
  schemaOrOptions: StandardSchemaV1 | PadroneEnvOptions,
  maybeOptions?: PadroneEnvOptions,
): <T extends CommandTypesBase>(builder: T) => WithAsync<T> {
  const schema = isSchema(schemaOrOptions) ? schemaOrOptions : undefined;
  const options = isSchema(schemaOrOptions) ? maybeOptions : schemaOrOptions;
  // Any file option opts into loading `.env` files
  const hasFiles = (options?.modes ?? options?.local ?? options?.dir ?? options?.override ?? options?.base) !== undefined;
  const fileOptions: LoadEnvFilesOptions | undefined = hasFiles ? options : undefined;
  const override = options?.override ?? false;

  const vars = options?.vars;
  const prefix = options?.prefix;
  const nestedSeparator = options?.nestedSeparator || '__';
  const arraySeparator = options?.arraySeparator === undefined ? ',' : options.arraySeparator || false;
  const mapsArgs = !!vars || prefix !== undefined;
  const envVarNames: EnvVarNames = (arg) =>
    (vars && Object.hasOwn(vars, arg) ? vars[arg] : undefined) ?? (prefix !== undefined ? prefixedEnvName(prefix, arg) : undefined);
  const fills = (command: AnyPadroneCommand) => options?.builtins || !isBuiltinCommand(command);
  const argsToRead = (command: AnyPadroneCommand) =>
    prefix !== undefined ? [...new Set([...Object.keys(vars ?? {}), ...getKnownOptionNames(command)])] : Object.keys(vars ?? {});

  const interceptor = defineInterceptor(
    {
      id: 'padrone:env',
      name: 'padrone:env',
      order: -1000,
      async: hasFiles,
      ...(mapsArgs && { env: (arg: string, command: AnyPadroneCommand) => (fills(command) ? envVarNames(arg) : undefined) }),
    },
    () => ({
      validate(ctx: InterceptorValidateContext, next) {
        const processEnv = ctx.runtime.env();
        const applyEnv = (envFromFiles: Record<string, string>) => {
          const rawEnv = override ? { ...processEnv, ...envFromFiles } : { ...envFromFiles, ...processEnv };
          // Variables from `.env` files are visible to `runtime.env()` downstream (e.g. in the action)
          const runtime = hasFiles ? { ...ctx.runtime, env: () => rawEnv } : ctx.runtime;
          if (!fills(ctx.command)) return next({ runtime });

          const env = options?.allowEmpty ? rawEnv : Object.fromEntries(Object.entries(rawEnv).filter(([, value]) => value !== ''));
          const read: EnvValues = { values: {}, sources: {} };
          if (mapsArgs) readEnvVars(env, argsToRead(ctx.command), envVarNames, read);
          if (prefix !== undefined) readNestedEnvVars(env, prefix, nestedSeparator, ctx.command, read);
          // Without `vars`, `prefix` or a schema: file variables named like the command's options fill them, with process env values
          // winning unless `override`
          if (!mapsArgs && !schema)
            for (const key of Object.keys(envFromFiles)) if (env[key] !== undefined) setEnvValue(read, [key], env[key]!, key);

          const forCommand = (values: Record<string, unknown>) => valuesForCommand(ctx.command, values, ctx.positionalArgs);
          const sources = forCommand(read.sources);
          const proceed = (rawArgs: Record<string, unknown>) =>
            thenMaybe(next({ rawArgs, runtime }), (result) =>
              withIssueSources(result, addedPaths(ctx.rawArgs, rawArgs), (path) => sourceIn(sources, path) ?? 'environment'),
            );
          const fromVars = forCommand(read.values);
          const rawArgs = applyValues(
            ctx.rawArgs,
            arraySeparator === false ? fromVars : splitArrays(fromVars, commandProperties(ctx.command), arraySeparator),
          );
          if (!schema) return proceed(rawArgs);

          return thenMaybe(schema['~standard'].validate(env), (result) => {
            if (result.issues) {
              // A variable that is set but invalid is an error; a missing one leaves the arg to the CLI or its default.
              const invalid = result.issues.filter((issue) => {
                const name = issue.path?.[0];
                const key = typeof name === 'object' ? name.key : name;
                return key !== undefined && env[String(key)] !== undefined;
              });
              if (invalid.length === 0) return proceed(rawArgs);
              return {
                args: undefined,
                argsResult: {
                  issues: invalid.map((issue) => ({ ...issue, message: `Invalid environment variable: ${issue.message}` })),
                },
              } as InterceptorValidateResult;
            }
            if (!result.value) return proceed(rawArgs);
            return proceed(applyValues(rawArgs, forCommand(result.value as Record<string, unknown>)));
          });
        };

        if (hasFiles) return thenMaybe(loadEnvFiles(fileOptions!, processEnv), applyEnv);
        return applyEnv({});
      },
    }),
  );

  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
