import { defineInterceptor } from '#src/core/interceptors.ts';
import { thenMaybe } from '#src/core/results.ts';
import type { ResolvedPadroneRuntime } from '#src/core/runtime.ts';
import { getKnownOptionNames } from '#src/core/validate.ts';
import type { AnsiStyle } from '#src/output/colorizer.ts';
import { makeStyleFn } from '#src/output/colorizer.ts';
import { shouldUseAnsi } from '#src/output/styling.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '#src/types/index.ts';
import { safeJsonStringify } from '#src/util/json.ts';
import type { WithInterceptor } from '#src/util/type-utils.ts';
import type { PadroneTracer } from './tracing.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Log level values ordered by severity. */
export type PadroneLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Logger instance injected into the command context. */
export type PadroneLogger = {
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** The current effective log level. */
  level: PadroneLogLevel;
  /** Create a child logger with a prefix label. */
  child: (label: string) => PadroneLogger;
};

/** Configuration for the logger extension. */
export type PadroneLoggerConfig = {
  /** Minimum log level to output. Defaults to `'info'`. */
  level?: PadroneLogLevel;
  /** Prefix prepended to every log message. */
  prefix?: string;
  /** Include timestamps in log output. Defaults to `false`. JSON lines always have a `time`. */
  timestamps?: boolean;
  /**
   * `'json'` writes one JSON object per line, like pino: `{"time":"…","level":"info","msg":"…"}`.
   * A plain object as the first argument adds its fields (`logger.info({ userId }, 'signed in')`),
   * errors are written as `err: { name, message, stack }`, and child labels as `name`. Defaults to `'text'`.
   */
  format?: 'text' | 'json';
  /**
   * Environment variable that sets the level (e.g. `'MYAPP_LOG_LEVEL'`). CLI flags take precedence over it,
   * and it takes precedence over `level`. Invalid values are ignored.
   */
  env?: string;
  /**
   * Add `-v` (repeatable: `-v` debug, `-vv` trace) and `-q` (silent) next to the long flags. Defaults to `false`.
   * `-v` takes precedence over the version builtin's `-v`; keep `--version` / `-V` for the version.
   */
  shortFlags?: boolean;
  /**
   * Write `trace`, `debug` and `info` to the runtime's `output` (stdout); `warn` and `error` stay on `error` (stderr).
   * Defaults to `false`: every level goes to stderr, keeping stdout for command results (and piping) clean.
   * Ignored under JSON output (`--json`), so stdout stays valid JSON.
   */
  stdout?: boolean;
};

/** Builder/program type after applying `padroneLogger()`. Adds `{ logger: PadroneLogger }` to the command context. */
export type WithLogger<T> = WithInterceptor<T, { logger: PadroneLogger }>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<PadroneLogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, silent: 5 };
const LEVEL_LABELS: Record<Exclude<PadroneLogLevel, 'silent'>, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};
const VALID_LEVELS = new Set<string>(Object.keys(LEVEL_ORDER));
const LEVEL_STYLES: Record<Exclude<PadroneLogLevel, 'silent'>, AnsiStyle[]> = {
  trace: ['gray'],
  debug: ['cyan'],
  info: ['green'],
  warn: ['yellow'],
  error: ['red', 'bold'],
};
const LEVEL_COLORS = Object.fromEntries(Object.entries(LEVEL_STYLES).map(([level, styles]) => [level, makeStyleFn(styles)])) as Record<
  Exclude<PadroneLogLevel, 'silent'>,
  (text: string) => string
>;

/** Whether log lines get colored level labels: follows `--color` / `--no-color`, `NO_COLOR`/`FORCE_COLOR` and the terminal. */
function colorsEnabled(runtime: ResolvedPadroneRuntime): boolean {
  if (runtime.format === 'ansi') return true;
  if (runtime.format !== 'auto' && runtime.format !== 'console') return false;
  return shouldUseAnsi(runtime.env(), runtime.terminal?.isTTY);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const errorJson = (error: Error) => ({ name: error.name, message: error.message, stack: error.stack });

/** One JSON log line: a leading plain object's fields, the first error as `err`, the rest as `msg`. */
function formatJsonLine(level: Exclude<PadroneLogLevel, 'silent'>, names: string[], prefix: string, args: unknown[]): string {
  const fields = isPlainObject(args[0]) ? args[0] : undefined;
  const rest = fields ? args.slice(1) : args;
  const error = rest.find((arg): arg is Error => arg instanceof Error);
  const msgArgs = rest.map((arg) => (error && arg === error ? error.message : arg));
  const line: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    ...(prefix && { prefix }),
    ...(names.length > 0 && { name: names.join('.') }),
    ...(msgArgs.length > 0 && { msg: formatArgs(msgArgs) }),
    ...(fields && Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? errorJson(v) : v]))),
    ...(error && { err: errorJson(error) }),
  };
  return safeJsonStringify(line) ?? JSON.stringify({ time: line.time, level, msg: String(line.msg ?? '') });
}

/** Format specifier pattern: matches %s, %d, %i, %f, %o, %O, %j, %% */
const FORMAT_PATTERN = /%%|%[sdifjoO]/g;

/** Renders a value for a log line: errors by stack, and values JSON can't serialize (cycles, bigints) without throwing. */
function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'bigint') return `${value}n`;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return String(value);
  return safeJsonStringify(value) ?? String(value);
}

/**
 * Applies printf-style format specifiers to args, following the WHATWG Console Standard
 * and Node.js `util.format` conventions. Remaining args are appended space-separated.
 */
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  if (typeof args[0] !== 'string' || !FORMAT_PATTERN.test(args[0])) {
    return args.map(stringifyValue).join(' ');
  }

  const template = args[0];
  let argIndex = 1;
  const result = template.replace(FORMAT_PATTERN, (token) => {
    if (token === '%%') return '%';
    if (argIndex >= args.length) return token;
    const val = args[argIndex++];
    switch (token) {
      case '%s':
        return String(val);
      case '%d':
      case '%i':
        return String(Math.trunc(Number(val)));
      case '%f':
        return String(Number(val));
      case '%j':
        return typeof val === 'string' ? JSON.stringify(val) : stringifyValue(val);
      case '%o':
      case '%O':
        return stringifyValue(val);
      default:
        return token;
    }
  });

  // Append remaining args that weren't consumed by specifiers
  const remaining = args.slice(argIndex);
  if (remaining.length === 0) return result;
  const tail = remaining.map(stringifyValue).join(' ');
  return `${result} ${tail}`;
}

/**
 * Reads the log-level flags from `rawArgs`, removing the ones it consumes.
 * Flags the command defines itself (e.g. its own `--verbose`) are left for the command.
 */
function resolveCliLevel(
  rawArgs: Record<string, unknown>,
  ownOptions: ReadonlySet<string>,
  shortFlags: boolean,
): PadroneLogLevel | undefined {
  const take = (key: string): { value: unknown } | undefined => {
    if (!(key in rawArgs) || ownOptions.has(key)) return undefined;
    const value = rawArgs[key];
    delete rawArgs[key];
    return { value };
  };
  const enabled = (flag: { value: unknown } | undefined) => !!flag && flag.value !== false;
  // Counting flags: `--verbose` / `-v` once is 1, `-vv` is 2, `--no-verbose` is 0
  const count = (flag: { value: unknown } | undefined) =>
    !flag ? 0 : typeof flag.value === 'number' ? flag.value : flag.value === false ? 0 : Number(flag.value) || 1;

  // Every flag is consumed even when an earlier one already decided the level
  const trace = take('trace');
  const verbosity = count(take('verbose')) + (shortFlags ? count(take('v')) : 0);
  const debug = take('debug');
  const silent = take('silent');
  const quiet = take('quiet');
  const q = shortFlags ? take('q') : undefined;
  const logLevel = take('log-level');

  if (enabled(trace) || verbosity >= 2) return 'trace';
  if (verbosity === 1 || enabled(debug)) return 'debug';
  if (enabled(silent) || enabled(quiet) || enabled(q)) return 'silent';
  if (typeof logLevel?.value === 'string' && VALID_LEVELS.has(logLevel.value)) return logLevel.value as PadroneLogLevel;
  return undefined;
}

function createLogger(
  runtime: ResolvedPadroneRuntime,
  level: PadroneLogLevel,
  config: ResolvedLoggerConfig,
  tracing?: PadroneTracer,
): PadroneLogger {
  const threshold = LEVEL_ORDER[level];

  function formatText(lvl: Exclude<PadroneLogLevel, 'silent'>, names: string[], args: unknown[]): string {
    const parts: string[] = [];
    if (config.timestamps) parts.push(new Date().toISOString());
    const label = `[${LEVEL_LABELS[lvl]}]`;
    parts.push(colorsEnabled(runtime) ? LEVEL_COLORS[lvl](label) : label);
    if (config.prefix) parts.push(config.prefix);
    for (const name of names) parts.push(`[${name}]`);
    parts.push(formatArgs(args));
    return parts.join(' ');
  }

  function makeLogger(names: string[]): PadroneLogger {
    const emit = (lvl: Exclude<PadroneLogLevel, 'silent'>, args: unknown[]) => {
      if (LEVEL_ORDER[lvl] < threshold) return;
      const message = config.format === 'json' ? formatJsonLine(lvl, names, config.prefix, args) : formatText(lvl, names, args);
      tracing?.rootSpan.addEvent('log', {
        'log.level': lvl,
        'log.message': formatArgs(args),
      });
      const toStdout = config.stdout && lvl !== 'error' && lvl !== 'warn' && runtime.format !== 'json';
      if (toStdout) runtime.output(message);
      else runtime.error(message);
    };

    return {
      trace: (...args) => emit('trace', args),
      debug: (...args) => emit('debug', args),
      info: (...args) => emit('info', args),
      warn: (...args) => emit('warn', args),
      error: (...args) => emit('error', args),
      level,
      child: (label) => makeLogger([...names, label]),
    };
  }

  return makeLogger([]);
}

// ---------------------------------------------------------------------------
// Interceptor
// ---------------------------------------------------------------------------

type ResolvedLoggerConfig = { level: PadroneLogLevel; prefix: string; timestamps: boolean; stdout: boolean; format: 'text' | 'json' };

function loggerInterceptor(rawConfig?: PadroneLoggerConfig) {
  return defineInterceptor({
    id: 'padrone:logger',
    name: 'padrone:logger',
    options: {
      trace: 'flag',
      verbose: 'count',
      debug: 'flag',
      silent: 'flag',
      quiet: 'flag',
      'log-level': 'value',
      ...(rawConfig?.shortFlags && { v: 'count' as const, q: 'flag' as const }),
    },
  })
    .requires<{ tracing?: PadroneTracer; loggerConfig?: PadroneLoggerConfig }>()
    .factory(() => {
      let cliLevel: PadroneLogLevel | undefined;
      let flagsRead = false;
      const readFlags = (rawArgs: Record<string, unknown>, command: AnyPadroneCommand) => {
        flagsRead = true;
        cliLevel = resolveCliLevel(rawArgs, new Set(getKnownOptionNames(command)), !!rawConfig?.shortFlags);
      };

      return {
        parse(_ctx, next) {
          return thenMaybe(next(), (res) => {
            readFlags(res.rawArgs, res.command);
            return res;
          });
        },

        // Registered on a command: its parse handler doesn't run
        validate(ctx, next) {
          if (!flagsRead) readFlags(ctx.rawArgs, ctx.command);
          return next();
        },

        execute(ctx, next) {
          const ctxCfg = (ctx.context as Record<string, unknown> | undefined)?.loggerConfig as PadroneLoggerConfig | undefined;
          const envName = rawConfig?.env ?? ctxCfg?.env;
          const envLevel = envName ? ctx.runtime.env()[envName]?.toLowerCase() : undefined;
          const resolved: ResolvedLoggerConfig = {
            level:
              cliLevel ??
              (envLevel && VALID_LEVELS.has(envLevel) ? (envLevel as PadroneLogLevel) : undefined) ??
              rawConfig?.level ??
              ctxCfg?.level ??
              'info',
            prefix: rawConfig?.prefix ?? '',
            timestamps: rawConfig?.timestamps ?? ctxCfg?.timestamps ?? false,
            stdout: rawConfig?.stdout ?? ctxCfg?.stdout ?? false,
            format: rawConfig?.format ?? ctxCfg?.format ?? 'text',
          };
          const logger = createLogger(ctx.runtime, resolved.level, resolved, ctx.context?.tracing);
          return next({ context: { logger } });
        },
      };
    });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Extension that injects a structured logger into the command context.
 *
 * The logger respects a configurable log level threshold, supports prefixed
 * child loggers, and writes through the runtime's `error` function (stderr), so it
 * works in any environment (terminal, test, web) and never mixes with command results.
 * Level labels are colored on color terminals; `format: 'json'` writes JSON lines.
 *
 * Supports CLI flags for runtime level overrides:
 * - `--trace` → sets level to `trace`
 * - `--verbose` or `--debug` → sets level to `debug`; `--verbose --verbose` → `trace`
 * - `-v` / `-vv` / `-q` with `shortFlags: true` (debug / trace / silent)
 * - `--silent` or `--quiet` → sets level to `silent`
 * - `--log-level=<level>` → sets an explicit level (`trace`, `debug`, `info`, `warn`, `error`, `silent`)
 *
 * CLI flags take precedence over the `env` variable, which takes precedence over the programmatic config.
 *
 * Provides `{ logger: PadroneLogger }` on the command context.
 * Access it in action handlers as `ctx.context.logger`.
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli')
 *   .extend(padroneLogger({ level: 'info' }))
 *   .command('sync', (c) =>
 *     c.action((_args, ctx) => {
 *       ctx.context.logger.info('starting sync');
 *       const db = ctx.context.logger.child('db');
 *       db.debug('connecting...');
 *     })
 *   )
 * ```
 *
 * Then run:
 * ```sh
 * my-cli sync --verbose      # debug level
 * my-cli sync --quiet        # silent
 * my-cli sync --log-level=warn
 * ```
 */
export function padroneLogger<T extends CommandTypesBase>(config?: PadroneLoggerConfig): (builder: T) => WithLogger<T> {
  return ((builder: AnyPadroneBuilder) => builder.intercept(loggerInterceptor(config))) as any;
}
