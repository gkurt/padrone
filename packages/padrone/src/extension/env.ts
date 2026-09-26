import type { StandardSchemaV1 } from '@standard-schema/spec';
import { applyValues } from '../core/args.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { thenMaybe } from '../core/results.ts';
import type { AnyPadroneBuilder, CommandTypesBase, InterceptorValidateContext, InterceptorValidateResult } from '../types/index.ts';
import type { LoadEnvFilesOptions } from '../util/dotenv.ts';
import { loadEnvFiles } from '../util/dotenv.ts';
import type { WithAsync } from '../util/type-utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

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
};

// ── Helpers ──────────────────────────────────────────────────────────────

function isSchema(value: unknown): value is StandardSchemaV1 {
  return value != null && typeof value === 'object' && '~standard' in value;
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
  const hasFiles = options?.modes !== undefined;
  const fileOptions: LoadEnvFilesOptions | undefined = hasFiles ? options : undefined;
  const override = options?.override ?? false;

  const interceptor = defineInterceptor({ id: 'padrone:env', name: 'padrone:env', order: -1000 }, () => ({
    validate(ctx: InterceptorValidateContext, next) {
      const processEnv = ctx.runtime.env();

      const applyEnv = (envFromFiles: Record<string, string>) => {
        const rawEnv = override ? { ...processEnv, ...envFromFiles } : { ...envFromFiles, ...processEnv };

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
              if (invalid.length === 0) return next();
              return {
                args: undefined,
                argsResult: {
                  issues: invalid.map((issue) => ({ ...issue, message: `Invalid environment variable: ${issue.message}` })),
                },
              } as InterceptorValidateResult;
            }
            if (!result.value) return next();
            return next({ rawArgs: applyValues(ctx.rawArgs, result.value as Record<string, unknown>) });
          });
        }

        // No schema — merge file env values directly into rawArgs
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
