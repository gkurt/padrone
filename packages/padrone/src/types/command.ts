import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PadroneRuntime, ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { PadroneHelpConfig, PadroneHelpTransform } from '../output/formatter.ts';
import type { FullCommandName } from '../util/type-utils.ts';
import type { PadroneArgsSchemaMeta, PadroneGlobalArgsMeta } from './args-meta.ts';
import type { AnyPadroneProgram } from './builder.ts';
import type { RegisteredInterceptor } from './interceptor.ts';
import type { PadroneSchema } from './schema.ts';

type UnknownRecord = Record<string, unknown>;
type DefaultArgs = UnknownRecord | void;

/**
 * Read-only metadata about a Padrone program.
 * Returned by `program.info` to expose program-level properties without leaking internal command internals.
 */
export type PadroneProgramMeta<TName extends string = string> = {
  /** The program name (CLI binary name). */
  name: TName;
  /** Display title shown in help output. */
  title?: string;
  /** Program description. */
  description?: string;
  /** Program version string. */
  version?: string;
  /** Usage examples shown in help output. */
  examples?: string[];
  /** Whether the program is deprecated. */
  deprecated?: boolean | string;
  /** Names of registered subcommands. */
  commands: string[];
};

/**
 * Context object passed as the second argument to command action handlers.
 * Contains the resolved runtime, the executing command, and the program instance.
 */
export type PadroneActionContext<TContext = unknown> = {
  /** The resolved runtime for this command (I/O, env, config, etc.). */
  runtime: ResolvedPadroneRuntime;
  /** The command being executed. */
  command: AnyPadroneCommand;
  /** The root program instance. */
  program: AnyPadroneProgram;
  /**
   * Cancellation signal that fires when the process receives SIGINT, SIGTERM, or SIGHUP.
   * Use with `fetch()`, child processes, or any API that accepts `AbortSignal`.
   * Check `signal.aborted` to test if cancellation was requested.
   * The `signal.reason` is a `PadroneSignal` string ('SIGINT', 'SIGTERM', or 'SIGHUP').
   */
  signal: AbortSignal;
  /** User-defined context object. Set via `.context()` on the builder and provided at `cli()`/`eval()` time. */
  context: TContext;
  /** Which API entry point triggered this execution. */
  caller: 'cli' | 'eval' | 'run' | 'repl' | 'serve' | 'mcp' | 'tool';
};

/**
 * Configuration for a command.
 */
export type PadroneCommandConfig = {
  /** A short title for the command, displayed in help. */
  title?: string;
  /** A longer description of what the command does. */
  description?: string;
  /** The version of the command. */
  version?: string;
  /** Whether the command is deprecated, or a message explaining the deprecation. */
  deprecated?: boolean | string;
  /** Whether the command should be hidden from help output. */
  hidden?: boolean;
  /** Group name for organizing this command under a labeled section in help output. */
  group?: string;
  /** Usage examples shown in help output. Each entry is a command-line invocation string. */
  examples?: string[];
  /**
   * Whether this command performs a mutation (create, update, delete).
   * - In `serve()`: mutation commands accept POST only; non-mutation commands accept GET and POST.
   * - In `mcp()`: sets `annotations.destructiveHint` on the tool definition.
   * - In `tool()`: defaults `needsApproval` to `true` when not explicitly set.
   */
  mutation?: boolean;
  /**
   * Customize this command's help: a declarative `{ usage, before, after }` (this command only), or a function
   * receiving the generated help info that returns modified info or the final string (this command and its subcommands).
   */
  help?: PadroneHelpConfig | PadroneHelpTransform;
};

export type PadroneCommand<
  TName extends string = string,
  TParentName extends string = '',
  TArgs extends PadroneSchema = PadroneSchema<DefaultArgs>,
  TRes = void,
  TCommands extends [...AnyPadroneCommand[]] = [],
  TAliases extends string[] = string[],
  TAsync extends boolean = false,
  TContext = unknown,
  TContextProvided = unknown,
> = {
  name: TName;
  path: FullCommandName<TName, TParentName>;
  title?: string;
  description?: string;
  version?: string;
  /** Alternative names that can be used to invoke this command. Derived from the names passed to command(). */
  aliases?: TAliases;
  deprecated?: boolean | string;
  hidden?: boolean;
  /** Group name for organizing this command under a labeled section in help output. */
  group?: string;
  /** Whether this command performs a mutation (create, update, delete). Affects HTTP method in serve (POST-only) and MCP tool annotations (destructiveHint). */
  mutation?: boolean;
  needsApproval?: boolean | ((args: TArgs) => Promise<boolean> | boolean);
  /** Usage examples shown in help output. Each entry is a command-line invocation string. */
  examples?: string[];
  /** Help customization, set by `.configure({ help })`. */
  help?: PadroneHelpConfig | PadroneHelpTransform;
  /** @internal Flags that invoke this built-in command (e.g. `['help', 'h']` for `--help`/`-h`). */
  flagNames?: readonly string[];
  argsSchema?: TArgs;
  meta?: GetArgsMeta<TArgs>;
  /**
   * Options accepted by this command and every subcommand below it, anywhere on the command line.
   * Their values are merged into each command's args; a command's own field of the same name wins. Set by `.globalArgs()`.
   */
  globalArgsSchema?: PadroneSchema;
  globalArgsMeta?: PadroneGlobalArgsMeta;
  action?: (args: StandardSchemaV1.InferOutput<TArgs>, ctx: PadroneActionContext<TContext & TContextProvided>) => TRes;
  /** Runs instead of `action` under `--dry-run` / `-n`; the flag only exists on commands that have one. Set by `.dryRun()`. */
  dryRun?: (args: StandardSchemaV1.InferOutput<TArgs>, ctx: PadroneActionContext<TContext & TContextProvided>) => unknown;
  /** Runtime flag indicating this command uses async validation. Set by `.async()` or `asyncSchema()`. */
  isAsync?: boolean;
  /** Runtime configuration for I/O abstraction. */
  runtime?: PadroneRuntime;

  /** Transform function that maps parent context to this command's context. Set by `.context(transform)`. */
  contextTransform?: (ctx: unknown) => unknown;

  /** Interceptors registered on this command. Collected from the parent chain at execution time. */
  interceptors?: RegisteredInterceptor[];

  parent?: AnyPadroneCommand;
  commands?: TCommands;

  /** @deprecated Internal use only */
  '~types': {
    name: TName;
    parentName: TParentName;
    path: FullCommandName<TName, TParentName>;
    aliases: TAliases;
    argsSchema: TArgs;
    argsInput: StandardSchemaV1.InferInput<TArgs>;
    argsOutput: StandardSchemaV1.InferOutput<TArgs>;
    result: TRes;
    commands: TCommands;
    async: TAsync;
    context: TContext;
    contextProvided: TContextProvided;
  };
};

export type AnyPadroneCommand = PadroneCommand<string, any, any, any, [...AnyPadroneCommand[]], string[], any, any, any>;

/**
 * Base type for extracting command information from builder or program.
 * Both PadroneBuilder and PadroneProgram share this structure.
 */
export type CommandTypesBase = {
  '~types': {
    command: AnyPadroneCommand;
  };
};

export type GetArgsMeta<TArgs extends PadroneSchema> = PadroneArgsSchemaMeta<NonNullable<StandardSchemaV1.InferInput<TArgs>>>;
