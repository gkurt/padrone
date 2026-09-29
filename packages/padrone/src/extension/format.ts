import { ValidationError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import type { OptionArity } from '../core/parse.ts';
import type { ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { HelpArgumentInfo } from '../output/formatter.ts';
import { renderTable, sanitizeValue, stringifyCell } from '../output/primitives.ts';
import { resolveOutputFormat } from '../output/styling.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, PadroneActionContext, PadroneInput } from '../types/index.ts';
import { safeJsonStringify } from '../util/json.ts';
import { toYaml } from '../util/yaml.ts';
import type { OutputRenderer } from './utils.ts';
import { frameworkFlags, getOutputRenderer, isRemoteCaller, parseWithFallback, setOutputRenderer } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type PadroneOutputFormat = 'text' | 'json' | 'yaml' | 'csv' | 'tsv' | 'table';

export type PadroneFormatOptions = {
  /** The formats `--output` accepts. Defaults to all of them. */
  formats?: readonly PadroneOutputFormat[];
  /** The format without `--output`. Defaults to `'text'` (the result as auto-output prints it). */
  default?: PadroneOutputFormat;
  /** Names of the format flag: long names and single-character flags. Defaults to `['output', 'o']`. */
  flags?: readonly string[];
  /** Add `--columns a,b` (pick and order columns), `--sort <column>` (`-column` for descending) and `--no-header` for the table, csv and tsv formats. */
  tableFlags?: boolean;
  /**
   * The columns of the table, csv and tsv formats, in order, with their header labels: `{ id: 'ID', createdAt: 'Created' }`.
   * Or a function giving them for a command. Without them (or `undefined`), every key of the rows, labeled by its name.
   * `--columns` can still pick any key of the rows.
   */
  columns?: PadroneFormatColumns | ((command: AnyPadroneCommand) => PadroneFormatColumns | undefined);
  /**
   * What `-o table` prints when stdout isn't a terminal (piped or redirected): `'tsv'` prints tab-separated rows instead,
   * like `gh`, so scripts get one line per row. Defaults to `'table'` (the table, wherever it goes).
   */
  pipedTable?: 'table' | 'tsv';
  /** Line ending of `-o csv`: `'crlf'` for RFC 4180 (`\r\n`). Defaults to `'lf'`. */
  csvLineEnding?: 'lf' | 'crlf';
  /**
   * Strip terminal escape sequences (colors, cursor moves, OSC titles and links) and control characters from the values
   * printed by the yaml, csv, tsv and table formats, like go-gh's asciisanitizer, for data that may not be trusted.
   * Tabs and line breaks stay (table cells get spaces for tabs). Defaults to `false`.
   */
  sanitize?: boolean;
  /**
   * Guard csv and tsv output against formula injection (OWASP CSV injection): cells starting with `=`, `+`, `-`, `@`,
   * a tab or a carriage return get a leading `'`, so spreadsheets read them as text. Numbers like `-5` or `+3.2` are left alone.
   * Defaults to `false`.
   */
  csvFormulaEscape?: boolean;
};

/** Column key → header label, in display order. */
export type PadroneFormatColumns = Record<string, string>;

const ALL_FORMATS: readonly PadroneOutputFormat[] = ['text', 'json', 'yaml', 'csv', 'tsv', 'table'];

type TableFlags = { columns?: string[]; sort?: string; header: boolean };

/** How the table, csv and tsv formats lay out rows: the flags, plus the columns, csv line ending and escaping from the options. */
type TableLayout = TableFlags & { defaults?: PadroneFormatColumns; crlf: boolean; sanitize: boolean; formulaEscape: boolean };

// ── Rendering ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** An object as one row, an array of objects as rows; anything else isn't tabular. */
function toRows(value: unknown): Row[] | undefined {
  if (isRow(value)) return [value];
  if (Array.isArray(value) && value.every(isRow)) return value;
  return undefined;
}

function columnsOf(rows: Row[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) keys.add(key);
  return [...keys];
}

/** Throws when a name given to `flag` isn't one of the rows' columns. */
function checkColumns(flag: 'columns' | 'sort', names: string[], rows: Row[], available: string[]): void {
  const missing = rows.length ? names.filter((n) => !available.includes(n)) : [];
  if (!missing.length) return;
  const message = `Unknown column${missing.length > 1 ? 's' : ''}: ${missing.map((n) => `"${n}"`).join(', ')}. Available columns: ${available.join(', ')}`;
  throw new ValidationError(message, [{ path: [flag], message }]);
}

function compareCells(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** The rows sorted and the columns to print, checked against the columns the rows have. */
function layout(rows: Row[], flags: TableLayout): { rows: Row[]; columns: string[] } {
  const available = columnsOf(rows);
  if (flags.columns) checkColumns('columns', flags.columns, rows, available);
  const columns = flags.columns ?? (flags.defaults ? Object.keys(flags.defaults) : available);
  if (!flags.sort) return { rows, columns };

  const descending = flags.sort.startsWith('-');
  const key = descending ? flags.sort.slice(1) : flags.sort;
  checkColumns('sort', [key], rows, available);
  // Missing values last, either way
  const sorted = [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null || y == null) return (x == null ? 1 : 0) - (y == null ? 1 : 0);
    return descending ? compareCells(y, x) : compareCells(x, y);
  });
  return { rows: sorted, columns };
}

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A cell a spreadsheet would read as a formula, with a leading `'`; numbers stay numbers. */
const escapeFormula = (text: string) => (FORMULA_START.test(text) && !NUMBER.test(text) ? `'${text}` : text);

const csvCell = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

const TSV_ESCAPES: Record<string, string> = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
const tsvCell = (text: string) => text.replace(/[\\\t\n\r]/g, (c) => TSV_ESCAPES[c]!);

/** Renders results in a non-JSON format; `text` is left to auto-output. */
function createRenderer(
  format: Exclude<PadroneOutputFormat, 'text' | 'json'>,
  flags: TableLayout,
  runtime: ResolvedPadroneRuntime,
  caller: PadroneActionContext['caller'],
): OutputRenderer {
  const headers = flags.defaults;
  const label = (column: string) => headers?.[column] ?? column;
  // Each csv line ends with `\r` for CRLF: the runtime's output adds the `\n`
  const eol = format === 'csv' && flags.crlf ? '\r' : '';
  const lines = (rows: Row[], columns: string[], header: boolean): string[] => {
    if (!columns.length) return [];
    const [quote, separator] = format === 'csv' ? [csvCell, ','] : [tsvCell, '\t'];
    const cell = (value: unknown) => {
      const text = stringifyCell(value);
      return quote(flags.formulaEscape ? escapeFormula(text) : text);
    };
    const line = (cells: string[]) => cells.join(separator) + eol;
    const body = rows.map((row) => line(columns.map((column) => cell(row[column]))));
    return header ? [line(columns.map((column) => cell(label(column)))), ...body] : body;
  };
  const table = (value: Row[]): string[] => {
    const { rows, columns } = layout(value, flags);
    if (format !== 'table') return [lines(rows, columns, flags.header).join('\n')].filter(Boolean);
    const rendered = renderTable(
      rows,
      { columns, headers, header: flags.header, sanitize: flags.sanitize },
      resolveOutputFormat(runtime, caller),
    );
    return rendered ? [rendered] : [];
  };

  // Streamed items: a table (or sorted rows) waits for the stream to end; csv/tsv print a row per item, the header from the first
  const buffer: Row[] = [];
  const buffered = format === 'table' || !!flags.sort;
  let streamColumns: string[] | undefined;

  return {
    render(value, item) {
      // Text (e.g. help or the version) prints as text in every format
      if (typeof value === 'string') return undefined;
      const json = JSON.parse(safeJsonStringify(value) ?? 'null');
      const plain = flags.sanitize ? sanitizeValue(json) : json;
      if (format === 'yaml') return [item ? `---\n${toYaml(plain)}` : toYaml(plain)];
      const rows = toRows(plain);
      if (!rows) return undefined;
      if (!item) return table(rows);
      if (buffered) {
        buffer.push(...rows);
        return [];
      }
      const first = !streamColumns;
      streamColumns ??= layout(rows, flags).columns;
      return lines(rows, streamColumns, first && flags.header);
    },
    end: () => (buffer.length ? table(buffer.splice(0)) : []),
  };
}

// ── Interceptor ─────────────────────────────────────────────────────────

/** A value option read from the raw input, for when parsing failed: `--output json`, `--output=json`, `-o json`, `-ojson`. */
function rawInputValue(input: PadroneInput | undefined, names: readonly string[]): string | undefined {
  const tokens = typeof input === 'string' ? input.split(/\s+/) : (input ?? []);
  let value: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--') break;
    for (const name of names) {
      const flag = name.length > 1 ? `--${name}` : `-${name}`;
      if (token === flag) value = tokens[i + 1];
      else if (token.startsWith(`${flag}=`)) value = token.slice(flag.length + 1);
      else if (name.length === 1 && !token.startsWith('--') && token.startsWith(flag)) value = token.slice(2);
    }
  }
  return value;
}

function splitList(value: unknown): string[] | undefined {
  const items = (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string').flatMap((v) => v.split(','));
  const list = items.map((v) => v.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function createFormatInterceptor(options: PadroneFormatOptions) {
  const formats = options.formats ?? ALL_FORMATS;
  const defaultFormat = options.default ?? 'text';
  const flagNames = options.flags ?? ['output', 'o'];
  const flagOptions: Record<string, OptionArity> = {
    ...Object.fromEntries(flagNames.map((name) => [name, 'value' as const])),
    ...(options.tableFlags && { columns: 'value' as const, sort: 'value' as const, header: 'flag' as const }),
  };

  const [long, ...short] = [...flagNames].sort((a, b) => b.length - a.length);
  const helpOptions: HelpArgumentInfo[] = [
    {
      name: long!,
      flags: short.filter((name) => name.length === 1),
      aliases: short.filter((name) => name.length > 1),
      type: 'string',
      enum: [...formats],
      valueName: 'format',
      optional: true,
      ...(defaultFormat !== 'text' && { default: defaultFormat }),
      description: 'Output format',
    },
    ...(options.tableFlags
      ? [
          { name: 'columns', type: 'string', valueName: 'list', optional: true, description: 'Columns to print, comma-separated' },
          {
            name: 'sort',
            type: 'string',
            valueName: 'column',
            optional: true,
            description: 'Sort rows by a column (-column for descending)',
          },
          { name: 'no-header', optional: true, description: 'Leave out the header row' },
        ]
      : []),
  ];

  return defineInterceptor({ id: 'padrone:format', name: 'padrone:format', order: -1102, options: flagOptions, helpOptions }, () => {
    let applied = false;

    const read = (
      rawArgs: Record<string, unknown>,
      command: AnyPadroneCommand,
      runtime: ResolvedPadroneRuntime,
      caller: PadroneActionContext['caller'],
    ) => {
      const flags = frameworkFlags(rawArgs, command);
      const given = flagNames.map((name) => flags.get(name)).find((v) => v !== undefined);
      const table: TableLayout = {
        columns: options.tableFlags ? splitList(flags.get('columns')) : undefined,
        sort: options.tableFlags ? splitList(flags.get('sort'))?.[0] : undefined,
        header: !options.tableFlags || flags.flag('header') !== false,
        defaults: typeof options.columns === 'function' ? options.columns(command) : options.columns,
        crlf: options.csvLineEnding === 'crlf',
        sanitize: !!options.sanitize,
        formulaEscape: !!options.csvFormulaEscape,
      };
      flags.delete(...Object.keys(flagOptions));
      // Registered on the program, the parse phase has already read the flags
      if (applied && given === undefined) return;
      applied = true;
      if (isRemoteCaller(caller)) return;

      const format = given ?? defaultFormat;
      if (typeof format !== 'string' || !formats.includes(format as PadroneOutputFormat)) {
        const message = `Invalid output format${typeof format === 'string' ? ` "${format}"` : ''}. Expected one of: ${formats.join(', ')}`;
        throw new ValidationError(message, [{ path: [flagNames[0]!], message }], { command: command.path || command.name });
      }
      if (format === 'json') runtime.format = 'json';
      // A renderer that's already set (bare `--json` listing its fields) wins
      else if (format !== 'text' && !getOutputRenderer(runtime)) {
        const piped = format === 'table' && options.pipedTable === 'tsv' && runtime.terminal?.isTTY !== true;
        const renderAs = piped ? 'tsv' : (format as Exclude<PadroneOutputFormat, 'text' | 'json'>);
        setOutputRenderer(runtime, createRenderer(renderAs, table, runtime, caller));
      }
    };

    return {
      // Registered on the program: read in parse, so routing errors are printed as JSON under `-o json` too
      parse(ctx, next) {
        return parseWithFallback(
          next,
          (res) => {
            read(res.rawArgs, res.command, ctx.runtime, ctx.caller);
            return res;
          },
          () => {
            if (isRemoteCaller(ctx.caller)) return;
            if ((rawInputValue(ctx.input, flagNames) ?? defaultFormat) === 'json') ctx.runtime.format = 'json';
          },
        );
      },
      // Registered on a command: its parse handler doesn't run
      validate(ctx, next) {
        read(ctx.rawArgs, ctx.command, ctx.runtime, ctx.caller);
        return next();
      },
    };
  });
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds `--output` / `-o <format>` to pick how results are printed:
 * - `text` (the default): the result as auto-output prints it.
 * - `json`: like `--json` — the result, and errors, as JSON.
 * - `yaml`: the result as YAML (streamed items as `---` separated documents).
 * - `csv` / `tsv`: an object or an array of objects as rows with a header (streamed items one row each).
 * - `table`: the same rows through the table primitive (tab-separated when piped, with `pipedTable: 'tsv'`).
 *
 * `columns` sets the columns and their header labels; `csvLineEnding: 'crlf'` ends csv lines with `\r\n`; `sanitize` strips
 * terminal escape sequences from untrusted values; `csvFormulaEscape` guards csv/tsv cells against formula injection.
 *
 * String results (e.g. help) are printed as text under every format but json, and other non-objects under csv, tsv and table. `--json`, `--jq` and
 * `--template` take precedence over `--output`. Serve, MCP and tool calls are unaffected.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneFormat({ tableFlags: true }))
 * // my-cli users list -o csv --columns id,name --sort -createdAt --no-header
 * ```
 */
export function padroneFormat(options: PadroneFormatOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const interceptor = createFormatInterceptor(options);
  return ((builder: AnyPadroneBuilder) => builder.intercept(interceptor)) as any;
}
