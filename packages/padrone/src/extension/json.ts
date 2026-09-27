import { ValidationError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { OptionArity } from '../core/parse.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
import { compileJq, compileTemplate, formatJqOutput } from '../util/jq.ts';
import { safeJsonStringify } from '../util/json.ts';
import type { JsonOutputFilter } from './utils.ts';
import { frameworkFlags, parseWithFallback, rawInputFlag, setJsonOutputFilter, setOutputRenderer, toFlag } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** A full jq implementation to use for `--jq` instead of the built-in subset: every output for the input. Must be synchronous. */
export type PadroneJqFunction = (input: unknown, expression: string) => unknown[];

export type PadroneJsonOptions = {
  /**
   * Add `--jq <expression>` to filter the JSON result, like `gh --jq`: each output is printed on its own line,
   * strings raw, other values as compact JSON (indented when stdout is a terminal). The built-in engine supports a subset of jq (paths, `[]`, pipes, `select`, `map`, object
   * construction, common builtins); pass a function to plug in a full implementation. Defaults to `true`.
   */
  jq?: boolean | PadroneJqFunction;
  /**
   * Add `--template <template>` to print the result through a template with `{{ jq expression }}` placeholders,
   * e.g. `--template '{{.name}}: {{.status}}'`. Arrays and streamed items print one line per item. Defaults to `true`.
   */
  template?: boolean;
  /**
   * Let `--json` take a comma-separated list of fields, like `gh --json name,url`: only those keys of the result are printed
   * (of each item, for arrays and streamed items), and `--jq` / `--template` apply to what's left.
   * - `true`: the list is attached with `=` (`--json=name,url`), so `--json` never takes the next argument; bare `--json` prints everything.
   * - `'required'`: `--json name,url` or `--json=name,url`; bare `--json` fails, listing the available fields.
   *
   * The available fields are `availableFields` (checked before the command runs), or else the keys of the result.
   */
  fields?: boolean | 'required';
  /** The fields `--json` accepts, or a function giving them for a command (`undefined`: the keys of its result). */
  availableFields?: readonly string[] | ((command: AnyPadroneCommand) => readonly string[] | undefined);
};

// ── Interceptor ─────────────────────────────────────────────────────────

/** Arrays print one line per item; each item through `render`. */
const perItem =
  (render: (value: unknown) => string): JsonOutputFilter =>
  (value) =>
    (Array.isArray(value) ? value : [value]).map(render);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** The keys of an object result, or of the objects in an array result. */
function fieldsOf(value: unknown): string[] {
  const keys = new Set<string>();
  for (const item of Array.isArray(value) ? value : [value]) if (isRecord(item)) for (const key of Object.keys(item)) keys.add(key);
  return [...keys];
}

function selectFields(value: unknown, fields: readonly string[]): unknown {
  const pick = (item: unknown) => (isRecord(item) ? Object.fromEntries(fields.filter((f) => f in item).map((f) => [f, item[f]])) : item);
  return Array.isArray(value) ? value.map(pick) : pick(value);
}

const BOOLEAN_WORD = /^(true|false|yes|no|on|off|1|0)$/i;

/** `--json=a,b` → `['a', 'b']`; `undefined` for a bare (or boolean) `--json`. */
function parseFieldList(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || BOOLEAN_WORD.test(raw)) return undefined;
  const fields = raw
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  return fields.length ? fields : undefined;
}

function fieldsError(message: string, command: AnyPadroneCommand): ValidationError {
  return new ValidationError(message, [{ path: ['json'], message }], { command: command.path || command.name });
}

const missingFieldsError = (available: readonly string[], command: AnyPadroneCommand) =>
  fieldsError(`Specify one or more comma-separated fields for \`--json\`: ${available.join(', ')}`, command);

function checkFields(selected: readonly string[], available: readonly string[], command: AnyPadroneCommand): void {
  const unknown = selected.filter((f) => !available.includes(f));
  if (!unknown.length || !available.length) return;
  const names = unknown.map((f) => `"${f}"`).join(', ');
  throw fieldsError(`Unknown JSON field${unknown.length > 1 ? 's' : ''}: ${names}. Available fields: ${available.join(', ')}`, command);
}

/** The JSON output of a value: pretty-printed, or one line for a streamed item. */
const toJsonLines = (value: unknown, item?: boolean) => [safeJsonStringify(value, item ? undefined : 2) ?? String(value)];

function createJsonInterceptor(options: PadroneJsonOptions) {
  const jqEnabled = options.jq !== false;
  const templateEnabled = options.template !== false;
  const flagOptions: Record<string, OptionArity> = {
    json: options.fields === 'required' ? 'optional' : 'flag',
    ...(jqEnabled && { jq: 'value' as const }),
    ...(templateEnabled && { template: 'value' as const }),
  };

  /** Compiled up front, so a bad expression fails before the command runs. `--jq` outputs are indented on a terminal, one line each otherwise. */
  const outputFilter = (jq: unknown, template: unknown, runtime: ResolvedPadroneRuntime): JsonOutputFilter | undefined => {
    try {
      if (typeof jq === 'string') {
        const space = runtime.terminal?.isTTY === true ? 2 : undefined;
        const run = typeof options.jq === 'function' ? options.jq : undefined;
        const filter = run ? (input: unknown) => run(input, jq) : compileJq(jq);
        // The filter sees the value as JSON (bigints as strings, no functions)
        return (value) => filter(JSON.parse(safeJsonStringify(value) ?? 'null')).map((v) => formatJqOutput(v, space));
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

  /** Field selection before `filter`; fields not declared are checked against the first result (or streamed item). */
  const withFields = (
    filter: JsonOutputFilter | undefined,
    fields: readonly string[],
    declared: boolean,
    command: AnyPadroneCommand,
  ): JsonOutputFilter => {
    let checked = declared;
    return (value, item) => {
      if (!checked) checkFields(fields, fieldsOf(value), command);
      checked = true;
      const selected = selectFields(value, fields);
      return filter ? filter(selected, item) : toJsonLines(selected, item);
    };
  };

  const availableFor = (command: AnyPadroneCommand) =>
    typeof options.availableFields === 'function' ? options.availableFields(command) : options.availableFields;

  return defineInterceptor({ id: 'padrone:json', name: 'padrone:json', order: -1101, options: flagOptions }, () => {
    const read = (rawArgs: Record<string, unknown>, command: AnyPadroneCommand, runtime: ResolvedPadroneRuntime) => {
      const flags = frameworkFlags(rawArgs, command);
      const jq = jqEnabled ? flags.get('jq') : undefined;
      const template = templateEnabled ? flags.get('template') : undefined;
      const rawJson = flags.get('json');
      flags.delete(...Object.keys(flagOptions));
      const fields = options.fields ? parseFieldList(rawJson) : undefined;
      const available = options.fields ? availableFor(command) : undefined;

      // Bare `--json` when fields are required fails listing them (as text): before running when they're declared
      if (options.fields === 'required' && !fields && toFlag(rawJson)) {
        if (available) throw missingFieldsError(available, command);
        setOutputRenderer(runtime, {
          render(value, item) {
            const found = fieldsOf(value);
            if (found.length) throw missingFieldsError(found, command);
            return toJsonLines(value, item);
          },
        });
        return;
      }

      // JSON first, so an invalid expression or field is reported as JSON too
      if (fields || toFlag(rawJson) || typeof jq === 'string' || typeof template === 'string') runtime.format = 'json';
      if (fields && available) checkFields(fields, available, command);
      const filter = outputFilter(jq, template, runtime);
      if (fields) setJsonOutputFilter(runtime, withFields(filter, fields, !!available, command));
      else if (filter) setJsonOutputFilter(runtime, filter);
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
 * - With `fields`, `--json name,url` prints only those fields of the result.
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
