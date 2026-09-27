import { ValidationError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { OptionArity } from '../core/parse.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
import { compileJq, compileTemplate, formatJqOutput } from '../util/jq.ts';
import { safeJsonStringify } from '../util/json.ts';
import type { JsonOutputFilter } from './utils.ts';
import { frameworkFlags, parseWithFallback, rawInputFlag, setJsonOutputFilter, toFlag } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** A full jq implementation to use for `--jq` instead of the built-in subset: every output for the input. Must be synchronous. */
export type PadroneJqFunction = (input: unknown, expression: string) => unknown[];

export type PadroneJsonOptions = {
  /**
   * Add `--jq <expression>` to filter the JSON result, like `gh --jq`: each output is printed on its own line,
   * strings raw. The built-in engine supports a subset of jq (paths, `[]`, pipes, `select`, `map`, object
   * construction, common builtins); pass a function to plug in a full implementation. Defaults to `true`.
   */
  jq?: boolean | PadroneJqFunction;
  /**
   * Add `--template <template>` to print the result through a template with `{{ jq expression }}` placeholders,
   * e.g. `--template '{{.name}}: {{.status}}'`. Arrays and streamed items print one line per item. Defaults to `true`.
   */
  template?: boolean;
};

// ── Interceptor ─────────────────────────────────────────────────────────

/** Arrays print one line per item; each item through `render`. */
const perItem =
  (render: (value: unknown) => string): JsonOutputFilter =>
  (value) =>
    (Array.isArray(value) ? value : [value]).map(render);

function createJsonInterceptor(options: PadroneJsonOptions) {
  const jqEnabled = options.jq !== false;
  const templateEnabled = options.template !== false;
  const flagOptions: Record<string, OptionArity> = {
    json: 'flag',
    ...(jqEnabled && { jq: 'value' as const }),
    ...(templateEnabled && { template: 'value' as const }),
  };

  /** Compiled up front, so a bad expression fails before the command runs. */
  const outputFilter = (jq: unknown, template: unknown): JsonOutputFilter | undefined => {
    try {
      if (typeof jq === 'string') {
        if (typeof options.jq === 'function') {
          const run = options.jq;
          return (value) => run(JSON.parse(safeJsonStringify(value) ?? 'null'), jq).map((v) => formatJqOutput(v, 2));
        }
        const filter = compileJq(jq);
        // The filter sees the value as JSON (bigints as strings, no functions)
        return (value) => filter(JSON.parse(safeJsonStringify(value) ?? 'null')).map((v) => formatJqOutput(v, 2));
      }
      if (typeof template === 'string') {
        const render = compileTemplate(template);
        return perItem((value) => render(JSON.parse(safeJsonStringify(value) ?? 'null')));
      }
    } catch (err) {
      const flag = typeof jq === 'string' ? 'jq' : 'template';
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Invalid --${flag}: ${message}`, [{ path: [flag], message }], { cause: err });
    }
    return undefined;
  };

  return defineInterceptor({ id: 'padrone:json', name: 'padrone:json', order: -1101, options: flagOptions }, () => {
    const read = (rawArgs: Record<string, unknown>, command: AnyPadroneCommand, runtime: ResolvedPadroneRuntime) => {
      const flags = frameworkFlags(rawArgs, command);
      const jq = jqEnabled ? flags.get('jq') : undefined;
      const template = templateEnabled ? flags.get('template') : undefined;
      const json = flags.flag('json');
      flags.delete(...Object.keys(flagOptions));

      // JSON first, so an invalid expression is reported as JSON too
      if (json || typeof jq === 'string' || typeof template === 'string') runtime.format = 'json';
      const filter = outputFilter(jq, template);
      if (filter) setJsonOutputFilter(runtime, filter);
    };

    return {
      // Registered on the program: read in parse, so routing errors are printed as JSON too
      parse(ctx, next) {
        return parseWithFallback(
          next,
          (res) => {
            read(res.rawArgs, res.command, ctx.runtime);
            return res;
          },
          // Parsing failed (e.g. an unknown command), so the flag is only in the raw input
          () => {
            // `--jq` / `--template` take a value (any value), so being given at all implies JSON
            const given = (name: string) => {
              const value = rawInputFlag(ctx.input, name);
              return value !== undefined && value !== false;
            };
            const json = toFlag(rawInputFlag(ctx.input, 'json'));
            if (json || (jqEnabled && given('jq')) || (templateEnabled && given('template'))) ctx.runtime.format = 'json';
          },
        );
      },
      // Registered on a command: its parse handler doesn't run
      validate(ctx, next) {
        read(ctx.rawArgs, ctx.command, ctx.runtime);
        return next();
      },
    };
  });
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds a `--json` flag, like oclif's `enableJsonFlag` or `gh --json`. It sets the output format to JSON:
 * - The command's result is printed as JSON (iterator items as one JSON value per line), and output
 *   primitives (`ctx.context.output.table()` etc.) render JSON.
 * - In `cli()`, errors are printed to stdout as `{ "error": { "name", "message", ... } }`
 *   (validation errors include their `issues`) instead of text.
 * - `--jq <expression>` filters the result (like `gh --jq`), and `--template <template>` formats it
 *   with `{{ expression }}` placeholders. Both imply `--json`.
 *
 * Apply to the program for every command, or inside `.command()` for one command.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneJson())
 * // my-cli users list --json
 * // my-cli users list --jq '.[] | select(.admin) | .name'
 * // my-cli users list --template '{{.id}}: {{.name}}'
 * ```
 */
export function padroneJson(options: PadroneJsonOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const interceptor = createJsonInterceptor(options);
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
