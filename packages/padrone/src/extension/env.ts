import type { StandardSchemaV1 } from '@standard-schema/spec';
import { applyValues } from '../core/args.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import type { AnyPadroneBuilder, CommandTypesBase, InterceptorValidateContext, InterceptorValidateResult } from '../types/index.ts';
import type { LoadEnvFilesOptions } from '../util/dotenv.ts';
import { loadEnvFiles } from '../util/dotenv.ts';
import type { WithAsync } from '../util/type-utils.ts';

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
};

// ── Helpers ──────────────────────────────────────────────────────────────

function isSchema(value: unknown): value is StandardSchemaV1 {
  return value != null && typeof value === 'object' && '~standard' in value;
}

/** Reads `vars` from the env: each arg gets the value of the first of its variables that is set. */
function readEnvVars(env: Record<string, string | undefined>, vars: Record<string, string | readonly string[]>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [arg, names] of Object.entries(vars)) {
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

  const interceptor = defineInterceptor({ id: 'padrone:env', name: 'padrone:env', order: -1000, ...(vars && { env: vars }) }, () => ({
    validate(ctx: InterceptorValidateContext, next) {
      const processEnv = ctx.runtime.env();

      const applyEnv = (envFromFiles: Record<string, string>) => {
        const rawEnv = override ? { ...processEnv, ...envFromFiles } : { ...envFromFiles, ...processEnv };
        const rawArgs = vars ? applyValues(ctx.rawArgs, readEnvVars(rawEnv, vars)) : ctx.rawArgs;
        const proceed = () => (vars ? next({ rawArgs }) : next());

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
            return next({ rawArgs: applyValues(rawArgs, result.value as Record<string, unknown>) });
          });
        }

        // No schema — merge file env values directly into rawArgs (unless `vars` picks what to read)
        if (vars) return proceed();
        if (Object.keys(envFromFiles).length > 0) {
          return next({ rawArgs: applyValues(ctx.rawArgs, envFromFiles) });
        }
        return next();
      };

      if (hasFiles) {
        const loaded = loadEnvFiles(fileOptions!, processEnv);
        return thenMaybe(loaded, applyEnv);
      }

      return applyEnv({});
    },
  }));

  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
