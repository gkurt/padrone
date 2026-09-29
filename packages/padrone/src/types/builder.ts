import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Tool } from 'ai';
import type { PadroneRuntime } from '../core/runtime.ts';
import type { PadroneLogger } from '../extension/logger.ts';
import type { PadroneProgressContext } from '../extension/progress.ts';
import type { PadroneTracer } from '../extension/tracing.ts';
import type { CompletionScriptOptions } from '../feature/completion.ts';
import type { PadroneMcpPreferences } from '../feature/mcp.ts';
import type { PadroneServePreferences } from '../feature/serve.ts';
import type { WrapConfig, WrapResult } from '../feature/wrap.ts';
import type { HelpPreferences } from '../output/help.ts';
import type { PadroneDirs } from '../util/dirs.ts';
import type {
  FindDirectChild,
  FlattenCommands,
  FullCommandName,
  HasInteractive,
  MaybePromise,
  OrAsync,
  OrAsyncMeta,
  PickCommandByName,
  PickCommandByPossibleCommands,
  PossibleCommands,
  RepathCommands,
  ReplaceOrAppendCommand,
  SafeString,
  WithGlobalArgs,
} from '../util/type-utils.ts';
import type { PadroneArgsSchemaMeta, PadroneGlobalArgsMeta } from './args-meta.ts';
import type {
  AnyPadroneCommand,
  CommandTypesBase,
  GetArgsMeta,
  PadroneActionContext,
  PadroneCommand,
  PadroneCommandConfig,
  PadroneHookContext,
  PadroneProgramMeta,
} from './command.ts';
import type {
  ExtractInterceptorContext,
  InterceptorFactory,
  InterceptorMeta,
  InterceptorRequiresCheck,
  InterceptorRequiresError,
  PadroneContextInterceptor,
  PadroneEmit,
  PadroneInterceptorFn,
} from './interceptor.ts';
import type { PadroneCliPreferences, PadroneEvalPreferences, PadroneReplPreferences, PadroneToolPreferences } from './preferences.ts';
import type {
  GetArguments,
  MaybePromiseCommandResult,
  PadroneAPI,
  PadroneCommandResult,
  PadroneDrainResult,
  PadroneParseResult,
} from './result.ts';
import type { PadroneSchema } from './schema.ts';

/**
 * Helper type to set aliases on a command type.
 * Uses intersection to override just the aliases while preserving all other type information.
 */
type WithAliases<TCommand extends AnyPadroneCommand, TAliases extends string[]> = Omit<TCommand, 'aliases' | '~types'> & {
  aliases?: TAliases;
  '~types': Omit<TCommand['~types'], 'aliases'> & { aliases: TAliases };
};

/**
 * Resolves aliases for a command override: if new aliases are provided (non-empty), use them;
 * otherwise, preserve the existing command's aliases.
 */
type ResolvedAliases<
  TCommands extends [...AnyPadroneCommand[]],
  TNameNested extends string,
  TAliases extends string[],
> = TAliases extends []
  ? FindDirectChild<TCommands, TNameNested> extends infer E extends AnyPadroneCommand
    ? E['~types']['aliases']
    : []
  : TAliases;

/** The commands after `.command()` adds (or replaces) `TNameNested`, keeping an overridden command's aliases unless new ones are given. */
type AddCommand<
  TCommands extends [...AnyPadroneCommand[]],
  TNameNested extends string,
  TAliases extends string[],
  TCommand extends AnyPadroneCommand,
> = TCommands extends []
  ? [WithAliases<TCommand, TAliases>]
  : AnyPadroneCommand[] extends TCommands
    ? [WithAliases<TCommand, TAliases>]
    : ReplaceOrAppendCommand<TCommands, TNameNested, WithAliases<TCommand, ResolvedAliases<TCommands, TNameNested, TAliases>>>;

/**
 * A command built without a known name (by `defineCommand()`, whose builder is typed with `string` names)
 * takes the name and parent path it's registered under, so `run()`, `api()` and `find()` can look it up,
 * and the global args of its new parent (`TGlobals`), which it accepts at runtime.
 */
type NamedSubcommand<
  TCommand extends AnyPadroneCommand,
  TNameNested extends string,
  TParentPath extends string,
  TGlobals extends PadroneSchema = PadroneSchema<void>,
> = string extends TCommand['~types']['name']
  ? PadroneCommand<
      TNameNested,
      TParentPath,
      WithGlobalArgs<TCommand['~types']['argsSchema'], TGlobals>,
      TCommand['~types']['result'],
      RepathCommands<TCommand['~types']['commands'], FullCommandName<TNameNested, TParentPath>, TGlobals>,
      TCommand['~types']['aliases'],
      OrAsync<TCommand['~types']['async'], TGlobals>,
      TCommand['~types']['context'],
      TCommand['~types']['contextProvided']
    >
  : TCommand;

/** A program mounted as `TNameNested` under `TParentPath`: its root command and subcommands, with the parent's global args. */
type MountedCommand<
  TProgram extends CommandTypesBase,
  TNameNested extends string,
  TParentPath extends string,
  TContext,
  TGlobals extends PadroneSchema,
> = PadroneCommand<
  TNameNested,
  TParentPath,
  WithGlobalArgs<TProgram['~types']['command']['~types']['argsSchema'], TGlobals>,
  TProgram['~types']['command']['~types']['result'],
  RepathCommands<TProgram['~types']['command']['~types']['commands'], FullCommandName<TNameNested, TParentPath>, TGlobals>,
  [],
  OrAsync<TProgram['~types']['command']['~types']['async'], TGlobals>,
  TContext
>;

/**
 * The trailing preferences parameter of `cli()`, `eval()`, `run()`, `repl()`, `api()`, `tool()`, `serve()` and `mcp()`: optional, unless the program
 * declares a context (`.context<T>()`) that the caller has to pass.
 */
type PrefsParam<TContext, TPrefs> = unknown extends TContext
  ? [prefs?: TPrefs & { context?: TContext }]
  : [prefs: TPrefs & { context: TContext }];

/** The args `run()` takes for a command, or an error naming a literal command name that isn't one (`run('lsit', {})`). */
type KnownCommandArgs<TCommand extends AnyPadroneCommand, TName> = [TCommand] extends [never]
  ? string extends TName
    ? GetArguments<'in', TCommand>
    : `Unknown command "${TName & string}"`
  : GetArguments<'in', TCommand>;

/** Options for the `mount()` method. */
type MountOptions<TContext, TNewContext> = { context: (ctx: TContext) => TNewContext };

/**
 * Resolves the initial builder type for a `.command()` call.
 * If TNameNested already exists in TCommands, the builder starts pre-populated with that command's types.
 * Otherwise, a fresh builder with default types is used.
 */
type InitialCommandBuilder<
  TProgramName extends string,
  TNameNested extends string,
  TParentPath extends string,
  TParentArgs extends PadroneSchema,
  TCommands extends [...AnyPadroneCommand[]],
  TParentContext,
  TParentGlobals extends PadroneSchema = PadroneSchema<void>,
> = [FindDirectChild<TCommands, TNameNested>] extends [never]
  ? PadroneBuilder<
      TProgramName,
      TNameNested,
      TParentPath,
      PadroneSchema<void>,
      void,
      [],
      TParentArgs,
      OrAsync<false, TParentGlobals>,
      TParentContext,
      unknown,
      TParentGlobals
    >
  : FindDirectChild<TCommands, TNameNested> extends infer E extends AnyPadroneCommand
    ? PadroneBuilder<
        TProgramName,
        TNameNested,
        TParentPath,
        E['~types']['argsSchema'],
        E['~types']['result'],
        E['~types']['commands'],
        TParentArgs,
        E['~types']['async'],
        E['~types']['context'],
        E['~types']['contextProvided'],
        TParentGlobals
      >
    : PadroneBuilder<
        TProgramName,
        TNameNested,
        TParentPath,
        PadroneSchema<void>,
        void,
        [],
        TParentArgs,
        OrAsync<false, TParentGlobals>,
        TParentContext,
        unknown,
        TParentGlobals
      >;

export type AnyPadroneBuilder = InitialCommandBuilder<string, string, string, PadroneSchema, [...AnyPadroneCommand[]], unknown, any>;

/**
 * Like InitialCommandBuilder but uses `any` for args in the fresh case.
 * Used as the default for TBuilder when no builderFn is provided.
 */
type DefaultCommandBuilder<
  TProgramName extends string,
  TNameNested extends string,
  TParentPath extends string,
  TParentArgs extends PadroneSchema,
  TCommands extends [...AnyPadroneCommand[]],
  TParentContext,
  TParentGlobals extends PadroneSchema = PadroneSchema<void>,
> = [FindDirectChild<TCommands, TNameNested>] extends [never]
  ? PadroneBuilder<
      TProgramName,
      TNameNested,
      TParentPath,
      any,
      void,
      [],
      TParentArgs,
      OrAsync<false, TParentGlobals>,
      TParentContext,
      unknown,
      TParentGlobals
    >
  : FindDirectChild<TCommands, TNameNested> extends infer E extends AnyPadroneCommand
    ? PadroneBuilder<
        TProgramName,
        TNameNested,
        TParentPath,
        E['~types']['argsSchema'],
        E['~types']['result'],
        E['~types']['commands'],
        TParentArgs,
        E['~types']['async'],
        E['~types']['context'],
        E['~types']['contextProvided'],
        TParentGlobals
      >
    : PadroneBuilder<
        TProgramName,
        TNameNested,
        TParentPath,
        any,
        void,
        [],
        TParentArgs,
        OrAsync<false, TParentGlobals>,
        TParentContext,
        unknown,
        TParentGlobals
      >;

/** Global args that prompt (interactive meta) make every command in their subtree async, like an async schema. */
type GlobalArgsWithAsync<TGlobals extends PadroneSchema, TMeta> =
  HasInteractive<TMeta> extends true ? TGlobals & { '~async': true } : TGlobals;

/**
 * Conditional type that returns either PadroneBuilder or PadroneProgram based on TReturn.
 * Used to avoid repetition in PadroneBuilderMethods return types.
 */
type BuilderOrProgram<
  TReturn extends 'builder' | 'program',
  TProgramName extends string,
  TName extends string,
  TParentName extends string,
  TArgs extends PadroneSchema,
  TRes,
  TCommands extends [...AnyPadroneCommand[]],
  TParentArgs extends PadroneSchema,
  TAsync extends boolean,
  TContext,
  TContextProvided = unknown,
  TGlobals extends PadroneSchema = PadroneSchema<void>,
> = TReturn extends 'builder'
  ? PadroneBuilder<TProgramName, TName, TParentName, TArgs, TRes, TCommands, TParentArgs, TAsync, TContext, TContextProvided, TGlobals>
  : PadroneProgram<TProgramName, TName, TParentName, TArgs, TRes, TCommands, TParentArgs, TAsync, TContext, TContextProvided, TGlobals>;

/**
 * Base builder methods shared between PadroneBuilder and PadroneProgram.
 * These methods are used for defining command structure (arguments, action, subcommands).
 */
export type PadroneBuilderMethods<
  TProgramName extends string,
  TName extends string,
  TParentName extends string,
  TArgs extends PadroneSchema,
  TRes,
  TCommands extends [...AnyPadroneCommand[]],
  TParentArgs extends PadroneSchema,
  TAsync extends boolean,
  TContext,
  TContextProvided,
  /** The global args in effect for this command (its own `.globalArgs()` or the nearest ancestor's) */
  TGlobals extends PadroneSchema,
  /** The return type for builder methods - either PadroneBuilder or PadroneProgram */
  TReturn extends 'builder' | 'program',
> = {
  /**
   * Apply build-time extensions that transform this builder/program, in order: `.extend(padroneJson(), padroneFormat())`.
   * @category Builder
   */
  extend: {
    <R1 extends CommandTypesBase>(
      e1: PadroneExtension<
        BuilderOrProgram<
          TReturn,
          TProgramName,
          TName,
          TParentName,
          TArgs,
          TRes,
          TCommands,
          TParentArgs,
          TAsync,
          TContext,
          TContextProvided,
          TGlobals
        >,
        R1
      >,
    ): R1;
    <R1 extends CommandTypesBase, R2 extends CommandTypesBase>(
      e1: PadroneExtension<
        BuilderOrProgram<
          TReturn,
          TProgramName,
          TName,
          TParentName,
          TArgs,
          TRes,
          TCommands,
          TParentArgs,
          TAsync,
          TContext,
          TContextProvided,
          TGlobals
        >,
        R1
      >,
      e2: PadroneExtension<R1, R2>,
    ): R2;
    <R1 extends CommandTypesBase, R2 extends CommandTypesBase, R3 extends CommandTypesBase>(
      e1: PadroneExtension<
        BuilderOrProgram<
          TReturn,
          TProgramName,
          TName,
          TParentName,
          TArgs,
          TRes,
          TCommands,
          TParentArgs,
          TAsync,
          TContext,
          TContextProvided,
          TGlobals
        >,
        R1
      >,
      e2: PadroneExtension<R1, R2>,
      e3: PadroneExtension<R2, R3>,
    ): R3;
    <R1 extends CommandTypesBase, R2 extends CommandTypesBase, R3 extends CommandTypesBase, R4 extends CommandTypesBase>(
      e1: PadroneExtension<
        BuilderOrProgram<
          TReturn,
          TProgramName,
          TName,
          TParentName,
          TArgs,
          TRes,
          TCommands,
          TParentArgs,
          TAsync,
          TContext,
          TContextProvided,
          TGlobals
        >,
        R1
      >,
      e2: PadroneExtension<R1, R2>,
      e3: PadroneExtension<R2, R3>,
      e4: PadroneExtension<R3, R4>,
    ): R4;
    <
      R1 extends CommandTypesBase,
      R2 extends CommandTypesBase,
      R3 extends CommandTypesBase,
      R4 extends CommandTypesBase,
      R5 extends CommandTypesBase,
    >(
      e1: PadroneExtension<
        BuilderOrProgram<
          TReturn,
          TProgramName,
          TName,
          TParentName,
          TArgs,
          TRes,
          TCommands,
          TParentArgs,
          TAsync,
          TContext,
          TContextProvided,
          TGlobals
        >,
        R1
      >,
      e2: PadroneExtension<R1, R2>,
      e3: PadroneExtension<R2, R3>,
      e4: PadroneExtension<R3, R4>,
      e5: PadroneExtension<R4, R5>,
    ): R5;
  };

  /** Set the description shown in help (shorthand for `.configure({ description })`). @category Builder */
  describe: (
    description: string,
  ) => BuilderOrProgram<
    TReturn,
    TProgramName,
    TName,
    TParentName,
    TArgs,
    TRes,
    TCommands,
    TParentArgs,
    TAsync,
    TContext,
    TContextProvided,
    TGlobals
  >;

  /** Register a runtime interceptor for lifecycle phases (parse, validate, execute, etc.). @category Builder */
  intercept: {
    /** Context-providing interceptor — extends context type. Rejects if required context is not satisfied. */
    <TInterceptor extends PadroneContextInterceptor<any, StandardSchemaV1.InferOutput<TArgs>, TRes, any>>(
      interceptor: TInterceptor,
    ): InterceptorRequiresCheck<TInterceptor, TContext & TContextProvided> extends true
      ? BuilderOrProgram<
          TReturn,
          TProgramName,
          TName,
          TParentName,
          TArgs,
          TRes,
          TCommands,
          TParentArgs,
          TAsync,
          TContext,
          TContextProvided & ExtractInterceptorContext<TInterceptor>,
          TGlobals
        >
      : InterceptorRequiresError;
    /** Plain interceptor — no context change. Rejects if required context is not satisfied. */
    <TInterceptor extends PadroneInterceptorFn<StandardSchemaV1.InferOutput<TArgs>, TRes, any>>(
      interceptor: TInterceptor,
    ): InterceptorRequiresCheck<TInterceptor, TContext & TContextProvided> extends true
      ? BuilderOrProgram<
          TReturn,
          TProgramName,
          TName,
          TParentName,
          TArgs,
          TRes,
          TCommands,
          TParentArgs,
          TAsync,
          TContext,
          TContextProvided,
          TGlobals
        >
      : InterceptorRequiresError;
    /** Register an interceptor with static metadata and a factory function. Context is strongly typed. */
    (
      meta: InterceptorMeta,
      factory: InterceptorFactory<StandardSchemaV1.InferOutput<TArgs>, TRes, TContext & TContextProvided>,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      TCommands,
      TParentArgs,
      TAsync,
      TContext,
      TContextProvided,
      TGlobals
    >;
  };

  /** Set command metadata like title, description, version, hidden, deprecated, etc. @category Builder */
  configure: (
    config: PadroneCommandConfig<StandardSchemaV1.InferOutput<WithGlobalArgs<TArgs, TGlobals>>>,
  ) => BuilderOrProgram<
    TReturn,
    TProgramName,
    TName,
    TParentName,
    TArgs,
    TRes,
    TCommands,
    TParentArgs,
    TAsync,
    TContext,
    TContextProvided,
    TGlobals
  >;

  /** Override the runtime adapter (process, IO, environment). @category Builder */
  runtime: (
    runtime: PadroneRuntime,
  ) => BuilderOrProgram<
    TReturn,
    TProgramName,
    TName,
    TParentName,
    TArgs,
    TRes,
    TCommands,
    TParentArgs,
    TAsync,
    TContext,
    TContextProvided,
    TGlobals
  >;

  /** Mark this command as async, forcing all return types to be `Promise`-wrapped. @category Builder */
  async: () => BuilderOrProgram<
    TReturn,
    TProgramName,
    TName,
    TParentName,
    TArgs,
    TRes,
    TCommands,
    TParentArgs,
    true,
    TContext,
    TContextProvided,
    TGlobals
  >;

  /**
   * Declare or transform the user-defined context type for this command.
   *
   * - Without a callback: narrows the context type (type-only, no runtime transform).
   * - With a callback: transforms the parent/current context into a new type. Chainable — multiple calls compose.
   *
   * Interceptor-provided context (`TContextProvided`) is preserved across `.context()` calls.
   * @category Builder
   */
  context: {
    <TNewContext>(): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      TCommands,
      TParentArgs,
      TAsync,
      TNewContext,
      TContextProvided,
      TGlobals
    >;
    // A transform of no context (e.g. `.context(() => ({ db }))` on the program) provides the context itself:
    // callers don't pass one, so it's typed as provided context rather than the context callers must give.
    <TNewContext>(
      transform: (ctx: TContext) => TNewContext,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      TCommands,
      TParentArgs,
      TAsync,
      unknown extends TContext ? unknown : TNewContext,
      unknown extends TContext ? TContextProvided & TNewContext : TContextProvided,
      TGlobals
    >;
  };

  /**
   * Define the argument/option schema for this command. Accepts a Standard Schema, or a function that receives
   * the parent command's schema to extend it: `.arguments((parent) => parent.extend({ file: z.string() }))`.
   * @category Builder
   */
  arguments: {
    // The function form is a separate overload whose `meta` doesn't depend on the schema type: otherwise `meta`
    // would fix the schema type before the function's return type is inferred.
    <TNewArgs extends PadroneSchema, const TMeta extends PadroneArgsSchemaMeta = PadroneArgsSchemaMeta>(
      schema: (parentSchema: TParentArgs) => TNewArgs,
      meta?: TMeta,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TNewArgs,
      TRes,
      TCommands,
      TParentArgs,
      OrAsyncMeta<OrAsync<TAsync, TNewArgs>, TMeta>,
      TContext,
      TContextProvided,
      TGlobals
    >;
    <TNewArgs extends PadroneSchema = PadroneSchema<void>, TMeta extends GetArgsMeta<TNewArgs, TGlobals> = GetArgsMeta<TNewArgs, TGlobals>>(
      schema?: TNewArgs,
      meta?: TMeta,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TNewArgs,
      TRes,
      TCommands,
      TParentArgs,
      OrAsyncMeta<OrAsync<TAsync, TNewArgs>, TMeta>,
      TContext,
      TContextProvided,
      TGlobals
    >;
  };

  /**
   * Define options accepted by this command and every subcommand below it, before or after the subcommand name.
   * Their values are merged into each command's `args`. A subcommand can override a global by defining a field
   * of the same name in its own `.arguments()`, or extend the globals for its subtree with the function form:
   * `.globalArgs((inherited) => inherited.extend({ ... }))`.
   * @category Builder
   */
  globalArgs: {
    <TNewGlobals extends PadroneSchema, const TMeta extends PadroneGlobalArgsMeta = PadroneGlobalArgsMeta>(
      schema: (inherited: TGlobals) => TNewGlobals,
      meta?: TMeta,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      TCommands,
      TParentArgs,
      OrAsyncMeta<OrAsync<TAsync, TNewGlobals>, TMeta>,
      TContext,
      TContextProvided,
      GlobalArgsWithAsync<TNewGlobals, TMeta>
    >;
    <
      TNewGlobals extends PadroneSchema,
      const TMeta extends PadroneGlobalArgsMeta<NonNullable<StandardSchemaV1.InferInput<TNewGlobals>>> = Record<never, never>,
    >(
      schema: TNewGlobals,
      meta?: TMeta,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      TCommands,
      TParentArgs,
      OrAsyncMeta<OrAsync<TAsync, TNewGlobals>, TMeta>,
      TContext,
      TContextProvided,
      GlobalArgsWithAsync<TNewGlobals, TMeta>
    >;
  };

  /** Set the handler function that runs when this command is executed. @category Builder */
  action: <TNewRes>(
    handler?: (
      args: StandardSchemaV1.InferOutput<WithGlobalArgs<TArgs, TGlobals>>,
      ctx: PadroneActionContext<TContext & TContextProvided>,
      base: (
        args: StandardSchemaV1.InferOutput<WithGlobalArgs<TArgs, TGlobals>>,
        ctx: PadroneActionContext<TContext & TContextProvided>,
      ) => TRes,
    ) => TNewRes,
  ) => BuilderOrProgram<
    TReturn,
    TProgramName,
    TName,
    TParentName,
    TArgs,
    TNewRes,
    TCommands,
    TParentArgs,
    TAsync,
    TContext,
    TContextProvided,
    TGlobals
  >;

  /**
   * Set a dry-run handler. The command then accepts `--dry-run` / `-n`, and under that flag this handler runs
   * instead of the action (the action never runs), after validation and with the same context. Return what would
   * change: it's printed like an action's result (JSON under `--json`). Execute interceptors run too, with `ctx.dryRun` set.
   * Commands without a dry-run handler reject `--dry-run` as an unknown option, so it can't be silently ignored.
   *
   * Ideally return the action's type (e.g. `{ deleted: string[] }` from both), so callers handle one shape; a different
   * type extends the command's result type to a union. Call it after `.action()`, which sets the result type.
   * @category Builder
   */
  dryRun: <TDryRes = TRes>(
    handler: (
      args: StandardSchemaV1.InferOutput<WithGlobalArgs<TArgs, TGlobals>>,
      ctx: PadroneActionContext<TContext & TContextProvided>,
    ) => TDryRes,
  ) => BuilderOrProgram<
    TReturn,
    TProgramName,
    TName,
    TParentName,
    TArgs,
    TRes | TDryRes,
    TCommands,
    TParentArgs,
    TAsync,
    TContext,
    TContextProvided,
    TGlobals
  >;

  /**
   * Register a lifecycle hook for this command and every subcommand below it, like cobra's `PersistentPreRun` or
   * commander's `hook('preAction')`: `preAction` runs before the action (after validation and interceptors such as
   * `padroneConfirm()`), `postAction` after it succeeds, with its result (awaited when it's a promise). An ancestor's
   * `preAction` runs before a descendant's, and its `postAction` after. A hook can be async: the action then waits for it,
   * and the result is a promise, as with an async action. Hooks also run for dry runs (`ctx.dryRun`) and `run()`.
   * @category Builder
   */
  hook: {
    (
      name: 'preAction',
      handler: (
        ctx: PadroneHookContext<StandardSchemaV1.InferOutput<WithGlobalArgs<TArgs, TGlobals>>, TContext & TContextProvided>,
      ) => unknown,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      TCommands,
      TParentArgs,
      TAsync,
      TContext,
      TContextProvided,
      TGlobals
    >;
    (
      name: 'postAction',
      handler: (
        ctx: PadroneHookContext<StandardSchemaV1.InferOutput<WithGlobalArgs<TArgs, TGlobals>>, TContext & TContextProvided>,
        result: unknown,
      ) => unknown,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      TCommands,
      TParentArgs,
      TAsync,
      TContext,
      TContextProvided,
      TGlobals
    >;
  };

  /** Wrap an external CLI tool, delegating execution to a shell command. @category Builder */
  wrap: <TWrapArgs extends PadroneSchema = TArgs>(
    config: WrapConfig<TArgs, TWrapArgs>,
  ) => BuilderOrProgram<
    TReturn,
    TProgramName,
    TName,
    TParentName,
    TArgs,
    Promise<WrapResult>,
    TCommands,
    TParentArgs,
    TAsync,
    TContext,
    TContextProvided,
    TGlobals
  >;

  /** Add or override a subcommand. Pass a builder function to define its schema, action, and nested commands. @category Builder */
  command: {
    <
      const TNameNested extends string,
      const TAliases extends string[] = [],
      TBuilder extends CommandTypesBase = DefaultCommandBuilder<
        TProgramName,
        TNameNested,
        FullCommandName<TName, TParentName>,
        TArgs,
        TCommands,
        TContext & TContextProvided,
        TGlobals
      >,
    >(
      name: TNameNested | readonly [TNameNested, ...TAliases],
      builderFn?: (
        builder: InitialCommandBuilder<
          TProgramName,
          TNameNested,
          FullCommandName<TName, TParentName>,
          TArgs,
          TCommands,
          TContext & TContextProvided,
          TGlobals
        >,
      ) => TBuilder,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      AddCommand<
        TCommands,
        TNameNested,
        TAliases,
        NamedSubcommand<TBuilder['~types']['command'], TNameNested, FullCommandName<TName, TParentName>, TGlobals>
      >,
      TParentArgs,
      TAsync,
      TContext,
      TContextProvided,
      TGlobals
    >;
    // Overload for defineCommand.requires() branded callbacks — validates context requirements
    <
      const TNameNested extends string,
      const TAliases extends string[] = [],
      TBuilder extends CommandTypesBase = CommandTypesBase,
      TReq = unknown,
    >(
      name: TNameNested | readonly [TNameNested, ...TAliases],
      builderFn: ((builder: any) => TBuilder) & { '~contextRequires': (ctx: TReq) => void },
    ): TContext & TContextProvided extends TReq
      ? BuilderOrProgram<
          TReturn,
          TProgramName,
          TName,
          TParentName,
          TArgs,
          TRes,
          AddCommand<
            TCommands,
            TNameNested,
            TAliases,
            NamedSubcommand<TBuilder['~types']['command'], TNameNested, FullCommandName<TName, TParentName>, TGlobals>
          >,
          TParentArgs,
          TAsync,
          TContext,
          TContextProvided,
          TGlobals
        >
      : DefineCommandRequiresError;
    // Fallback overload: accepts DefineCommand-typed callbacks where the builder type is not structurally compatible
    // (e.g., DefineCommand with unknown context used in a parent with specific context)
    <const TNameNested extends string, const TAliases extends string[] = [], TBuilder extends CommandTypesBase = CommandTypesBase>(
      name: TNameNested | readonly [TNameNested, ...TAliases],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      builderFn?: (builder: any) => TBuilder,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      AddCommand<
        TCommands,
        TNameNested,
        TAliases,
        NamedSubcommand<TBuilder['~types']['command'], TNameNested, FullCommandName<TName, TParentName>, TGlobals>
      >,
      TParentArgs,
      TAsync,
      TContext,
      TContextProvided,
      TGlobals
    >;
  };

  /** Mount an existing program as a subcommand, optionally transforming the context. @category Builder */
  mount: {
    <const TNameNested extends string, const TAliases extends string[] = [], TProgram extends CommandTypesBase = CommandTypesBase>(
      name: TNameNested | readonly [TNameNested, ...TAliases],
      program: TProgram,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      AddCommand<
        TCommands,
        TNameNested,
        TAliases,
        MountedCommand<TProgram, TNameNested, FullCommandName<TName, TParentName>, TContext & TContextProvided, TGlobals>
      >,
      TParentArgs,
      TAsync,
      TContext,
      TContextProvided,
      TGlobals
    >;

    <
      const TNameNested extends string,
      const TAliases extends string[] = [],
      TProgram extends CommandTypesBase = CommandTypesBase,
      TNewContext = unknown,
    >(
      name: TNameNested | readonly [TNameNested, ...TAliases],
      program: TProgram,
      options: MountOptions<TContext & TContextProvided, TNewContext>,
    ): BuilderOrProgram<
      TReturn,
      TProgramName,
      TName,
      TParentName,
      TArgs,
      TRes,
      AddCommand<
        TCommands,
        TNameNested,
        TAliases,
        MountedCommand<TProgram, TNameNested, FullCommandName<TName, TParentName>, TNewContext, TGlobals>
      >,
      TParentArgs,
      TAsync,
      TContext,
      TContextProvided,
      TGlobals
    >;
  };

  /** @deprecated Internal use only */
  '~types': {
    programName: TProgramName;
    name: TName;
    parentName: TParentName;
    path: FullCommandName<TName, TParentName>;
    aliases: [];
    argsSchema: TArgs;
    result: TRes;
    commands: TCommands;
    async: TAsync;
    context: TContext;
    contextProvided: TContextProvided;
    globals: TGlobals;
    command: PadroneCommand<TName, TParentName, WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands, [], TAsync, TContext, TContextProvided>;
  };
};

export type PadroneBuilder<
  TProgramName extends string = '',
  TName extends string = string,
  TParentName extends string = '',
  TArgs extends PadroneSchema = PadroneSchema<DefaultArgs>,
  TRes = void,
  TCommands extends [...AnyPadroneCommand[]] = [],
  TParentArgs extends PadroneSchema = PadroneSchema<void>,
  TAsync extends boolean = false,
  TContext = unknown,
  TContextProvided = unknown,
  TGlobals extends PadroneSchema = PadroneSchema<void>,
> = PadroneBuilderMethods<
  TProgramName,
  TName,
  TParentName,
  TArgs,
  TRes,
  TCommands,
  TParentArgs,
  TAsync,
  TContext,
  TContextProvided,
  TGlobals,
  'builder'
>;

export type PadroneProgram<
  TProgramName extends string = '',
  TName extends string = string,
  TParentName extends string = '',
  TArgs extends PadroneSchema = PadroneSchema<DefaultArgs>,
  TRes = void,
  TCommands extends [...AnyPadroneCommand[]] = [],
  TParentArgs extends PadroneSchema = PadroneSchema<void>,
  TAsync extends boolean = false,
  TContext = unknown,
  TContextProvided = unknown,
  TGlobals extends PadroneSchema = PadroneSchema<void>,
> = PadroneBuilderMethods<
  TProgramName,
  TName,
  TParentName,
  TArgs,
  TRes,
  TCommands,
  TParentArgs,
  TAsync,
  TContext,
  TContextProvided,
  TGlobals,
  'program'
> & {
  /** Execute a command by name with pre-validated args (skips parsing and validation). @category Execution */
  run: <const TCommand extends PossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], true, true>>(
    name: TCommand | SafeString,
    args: NoInfer<
      KnownCommandArgs<PickCommandByName<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], TCommand>, TCommand>
    >,
    ...prefs: PrefsParam<TContext, { signal?: AbortSignal }>
  ) => PadroneCommandResult<PickCommandByName<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], TCommand>>;

  /**
   * Emit a custom event (see `defineEvent()`) to the root's interceptors, outside any execution; handlers get `caller: 'run'`.
   * Inside an action or interceptor, use `ctx.emit()` to reach the interceptors on the running command's chain. @category Execution
   */
  emit: PadroneEmit;

  /**
   * Parse and execute input through the full interceptor pipeline. A string is tokenized (honoring quotes);
   * an array is taken as already-tokenized argv, one entry per argument. @category Execution
   */
  eval: <const TCommand extends PossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], true, true>>(
    input: TCommand | SafeString | readonly string[],
    ...prefs: PrefsParam<TContext, PadroneEvalPreferences>
  ) => MaybePromiseCommandResult<
    PickCommandByPossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], TCommand>,
    PickCommandByPossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], TCommand>['~types']['async']
  >;

  /** Parse and execute from `process.argv` through the full interceptor pipeline. @category Execution */
  cli: (
    ...prefs: PrefsParam<TContext, PadroneCliPreferences>
  ) => MaybePromiseCommandResult<FlattenCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>]>, TAsync>;

  /** Parse and validate input (a string, or argv as an array) without executing the action. @category Execution */
  parse: <const TCommand extends PossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], true, false>>(
    input?: TCommand | SafeString | readonly string[],
  ) => MaybePromise<
    PadroneParseResult<PickCommandByPossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], TCommand>>,
    PickCommandByPossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], TCommand>['~types']['async']
  >;

  /** Serialize args back into a CLI string. @category Utility */
  stringify: <
    const TCommand extends PossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], false, true>,
  >(
    command?: TCommand | SafeString,
    args?: GetArguments<
      'in',
      PickCommandByPossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], TCommand>
    >,
  ) => string;

  /** Look up a command definition by name. @category Utility */
  find: <const TFind extends PossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], false, true>>(
    command: TFind | SafeString,
  ) => PickCommandByPossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], TFind> | undefined;

  /**
   * Commands as typed functions (`api().db.migrate({ ... })`): each validates its args (applying defaults), runs the
   * action and returns its result, and throws on invalid args or a failing action. Pass `context` when the program declares one.
   * @category Utility
   */
  api: (
    ...prefs: PrefsParam<TContext, { signal?: AbortSignal }>
  ) => PadroneAPI<PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>>;

  /** Start an interactive REPL session. @category Execution */
  repl: (
    ...options: PrefsParam<
      TContext,
      PadroneReplPreferences<PossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>]>>
    >
  ) => AsyncIterable<PadroneCommandResult<FlattenCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>]>>> & {
    drain: () => Promise<
      PadroneDrainResult<
        PadroneCommandResult<FlattenCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>]>>[]
      >
    >;
  };

  /** Export as an AI SDK tool. @category Utility */
  tool: (...prefs: PrefsParam<TContext, PadroneToolPreferences>) => Tool<{ command: string }>;

  /** Generate help text for a command. @category Utility */
  help: <const TCommand extends PossibleCommands<[PadroneCommand<'', '', WithGlobalArgs<TArgs, TGlobals>, TRes, TCommands>], false, true>>(
    command?: TCommand,
    prefs?: HelpPreferences,
  ) => string;

  /** Generate a shell completion script: `options.mode` picks a static or dynamic one, `options.descriptions: false` leaves descriptions out. @category Utility */
  completion: (shell?: 'bash' | 'zsh' | 'fish' | 'powershell', options?: CompletionScriptOptions) => Promise<string>;

  /** Start a Model Context Protocol server. @category Server */
  mcp: (...prefs: PrefsParam<TContext, PadroneMcpPreferences>) => Promise<void>;

  /** Start a REST HTTP server with OpenAPI docs. @category Server */
  serve: (...prefs: PrefsParam<TContext, PadroneServePreferences>) => Promise<void>;

  /** Read-only metadata about the program (name, version, description, commands, etc.). @category Utility */
  info: PadroneProgramMeta<TProgramName>;

  /**
   * The standard per-user directories for this program (`config`, `cache`, `data`, `state`, `log`), following
   * XDG on Linux and platform conventions on macOS and Windows. Named after the program; the directories aren't created.
   * @category Utility
   */
  dirs: PadroneDirs;
};

export type AnyPadroneProgram = PadroneProgram<string, string, string, any, any, [...AnyPadroneCommand[]]>;

/**
 * A build-time extension that transforms a builder/program.
 * Extensions can add commands, arguments, interceptors, configure settings, etc.
 *
 * Use with `.extend(extension)`:
 * ```ts
 * const withAuth = (b) => b.arguments(authSchema).command('login', ...)
 * program.extend(withAuth)
 * ```
 */
export type PadroneExtension<TIn extends CommandTypesBase = CommandTypesBase, TOut extends CommandTypesBase = TIn> = (builder: TIn) => TOut;

/**
 * Default context type for commands defined with `defineCommand()`.
 * Includes optional context properties provided by common extensions (logger, tracing, progress).
 *
 * Override globally via module augmentation to add your application's context:
 * ```ts
 * declare module 'padrone' {
 *   interface DefineCommandContext {
 *     db: Database;
 *   }
 * }
 * ```
 */
export interface DefineCommandContext {
  logger?: PadroneLogger;
  tracing?: PadroneTracer;
  progress?: PadroneProgressContext;
}

/** Error brand returned by `.command()` when a `defineCommand.requires()` context requirement is not satisfied. */
export type DefineCommandRequiresError = {
  readonly '~error': 'Required context not satisfied. Ensure required interceptors are registered on the program.';
};

/**
 * Type for a command builder callback used with `.command()`.
 * Use this when defining commands in separate files where full return type inference isn't needed.
 *
 * For full type preservation at the parent, use `defineCommand()` instead.
 *
 * @example
 * ```ts
 * // my-command.ts
 * export const myCommand: DefineCommand = (c) =>
 *   c.arguments(z.object({ name: z.string() }))
 *    .action((args) => console.log(args.name));
 *
 * // cli.ts
 * createPadrone('test').command('my-command', myCommand)
 * ```
 */
export type DefineCommand<TContext = unknown, TParentArgs extends PadroneSchema = PadroneSchema> = (
  builder: PadroneBuilder<string, string, string, PadroneSchema<void>, void, [], TParentArgs, false, TContext, DefineCommandContext>,
) => CommandTypesBase;

/** A command builder callback typed for `defineCommand()`. */
type DefineCommandFn<TContext, TContextProvided, TOut extends CommandTypesBase, TGlobals extends PadroneSchema = PadroneSchema<void>> = (
  builder: PadroneBuilder<
    string,
    string,
    string,
    PadroneSchema<void>,
    void,
    [],
    any,
    OrAsync<false, TGlobals>,
    TContext,
    TContextProvided,
    TGlobals
  >,
) => TOut;

/**
 * Builder returned by `defineCommand()` (no-arg form). Call it with the command builder callback, after
 * `.requires<T>()` to declare context that interceptors must provide. It can be kept and reused for every command
 * of a program: `export const command = defineCommand<Context, typeof globals>()`.
 *
 * @example
 * ```ts
 * const listCommand = defineCommand<{ db: Database }>()((c) => c.action((_args, ctx) => ctx.context.db.list()));
 *
 * // With the program's global args (the schema passed to `.globalArgs()`)
 * const statusCommand = defineCommand<{ db: Database }, typeof globals>()((c) => c.action((args) => args.verbose));
 *
 * const adminCommand = defineCommand()
 *   .requires<{ adminDb: AdminDB }>()
 *   .define((c) => c.action((_args, ctx) => ctx.context.adminDb.query(...)));
 * ```
 */
export type DefineCommandBuilder<
  TContextProvided = DefineCommandContext,
  TBrand = unknown,
  TContext = unknown,
  TGlobals extends PadroneSchema = PadroneSchema<void>,
> = {
  /** Provide the command builder callback. */
  <TOut extends CommandTypesBase>(
    fn: DefineCommandFn<TContext, TContextProvided, TOut, TGlobals>,
  ): DefineCommandFn<TContext, TContextProvided, TOut, TGlobals> & TBrand;
  /** Declare context types this command requires. Purely type-level — no runtime effect. */
  requires: <TRequires>() => DefineCommandBuilder<
    TContextProvided & TRequires,
    { '~contextRequires': (ctx: TRequires) => void },
    TContext,
    TGlobals
  >;
  /** Provide the command builder callback (same as calling the builder). */
  define: <TOut extends CommandTypesBase>(
    fn: DefineCommandFn<TContext, TContextProvided, TOut, TGlobals>,
  ) => DefineCommandFn<TContext, TContextProvided, TOut, TGlobals> & TBrand;
};

type DefaultArgs = Record<string, unknown> | void;
