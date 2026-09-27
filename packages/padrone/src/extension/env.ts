import type { StandardSchemaV1 } from '@standard-schema/spec';
import { applyValues } from '../core/args.ts';
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
import { valuesForCommand } from './utils.ts';

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
   * (the first variable that is set wins). Values are strings, coerced by the command's schema like CLI input.
   * These variables are shown in help. Can be combined with an env schema.
   */
  vars?: Record<string, string | readonly string[]>;
  /**
   * Read every option from a prefixed variable, like yargs' `.env('MY_APP')`: with `prefix: 'MY_APP'`,
   * `--dry-run` / `dryRun` reads `MY_APP_DRY_RUN`. Variables named in `vars` take precedence. Shown in help.
   */
  prefix?: string;
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

/** Reads each arg from the first of its variables that is set. */
function readEnvVars(env: Record<string, string | undefined>, args: readonly string[], namesOf: EnvVarNames): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const arg of args) {
    const names = namesOf(arg);
    if (!names) continue;
    const name = (typeof names === 'string' ? [names] : names).find((n) => env[n] !== undefined);
    if (name) values[arg] = env[name];
  }
  return values;
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
 * // Every option from MY_APP_* variables (`--dry-run` ← MY_APP_DRY_RUN)
 * .extend(padroneEnv({ prefix: 'MY_APP' }))
 * ```
 *
 * Env values have lower precedence than CLI args and stdin, but higher than config files.
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
  const mapsArgs = !!vars || prefix !== undefined;
  const envVarNames: EnvVarNames = (arg) =>
    (vars && Object.hasOwn(vars, arg) ? vars[arg] : undefined) ?? (prefix !== undefined ? prefixedEnvName(prefix, arg) : undefined);
  const argsToRead = (command: AnyPadroneCommand) =>
    prefix !== undefined ? [...new Set([...Object.keys(vars ?? {}), ...getKnownOptionNames(command)])] : Object.keys(vars ?? {});

  const interceptor = defineInterceptor(
    {
      id: 'padrone:env',
      name: 'padrone:env',
      order: -1000,
      async: hasFiles,
      ...(mapsArgs && { env: prefix !== undefined ? envVarNames : vars }),
    },
    () => ({
      validate(ctx: InterceptorValidateContext, next) {
        const processEnv = ctx.runtime.env();

        const applyEnv = (envFromFiles: Record<string, string>) => {
          const rawEnv = override ? { ...processEnv, ...envFromFiles } : { ...envFromFiles, ...processEnv };
          const forCommand = (values: Record<string, unknown>) => valuesForCommand(ctx.command, values, ctx.positionalArgs);
          const rawArgs = mapsArgs
            ? applyValues(ctx.rawArgs, forCommand(readEnvVars(rawEnv, argsToRead(ctx.command), envVarNames)))
            : ctx.rawArgs;
          // Variables from `.env` files are visible to `runtime.env()` downstream (e.g. in the action)
          const runtime = hasFiles ? { ...ctx.runtime, env: () => rawEnv } : ctx.runtime;
          const proceed = (args = rawArgs) => next({ rawArgs: args, runtime });

          if (schema) {
            const envValidated = schema['~standard'].validate(rawEnv);
            return thenMaybe(envValidated, (result) => {
              if (result.issues) {
                // A variable that is set but invalid is an error; a missing one leaves the arg to the CLI or its default.
                const invalid = result.issues.filter((issue) => {
                  const name = issue.path?.[0];
                  const key = typeof name === 'object' ? name.key : name;
                  return key !== undefined && rawEnv[String(key)] !== undefined;
                });
                if (invalid.length === 0) return proceed();
                return {
                  args: undefined,
                  argsResult: {
                    issues: invalid.map((issue) => ({ ...issue, message: `Invalid environment variable: ${issue.message}` })),
                  },
                } as InterceptorValidateResult;
              }
              if (!result.value) return proceed();
              return proceed(applyValues(rawArgs, forCommand(result.value as Record<string, unknown>)));
            });
          }

          // No schema — file variables named like the command's options fill them (unless `vars` or `prefix` picks what to read)
          if (mapsArgs) return proceed();
          return proceed(applyValues(ctx.rawArgs, forCommand(envFromFiles)));
        };

        if (hasFiles) {
          const loaded = loadEnvFiles(fileOptions!, processEnv);
          return thenMaybe(loaded, applyEnv);
        }

        return applyEnv({});
      },
    }),
  );

  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
