import { padroneAutoOutput } from '../extension/auto-output.ts';
import { padroneColor } from '../extension/color.ts';
import type { HelpCommand, PadroneHelpOptions } from '../extension/help.ts';
import { padroneHelp } from '../extension/help.ts';
import { padroneInteractive } from '../extension/interactive.ts';
import { padroneRepl } from '../extension/repl.ts';
import { padroneSignalHandling } from '../extension/signal.ts';
import { padroneStdin } from '../extension/stdin.ts';
import { padroneSuggestions } from '../extension/suggestions.ts';
import type { VersionCommand } from '../extension/version.ts';
import { padroneVersion } from '../extension/version.ts';
import { createWrapHandler } from '../feature/wrap.ts';
import type {
  AnyPadroneCommand,
  AnyPadroneProgram,
  CommandTypesBase,
  DefineCommandBuilder,
  DefineCommandContext,
  InterceptorFactory,
  InterceptorMeta,
  PadroneBuilder,
  PadroneCommand,
  PadroneInput,
  PadroneInterceptorFn,
  PadroneProgram,
  PadroneSchema,
  RegisteredInterceptor,
} from '../types/index.ts';
import { commandSymbol, findCommandByName, lazyResolver, mergeCommands, repathCommandTree, resolveCommand } from './commands.ts';
import { RoutingError } from './errors.ts';
import type { ExecContext } from './exec.ts';
import { collectInterceptors, errorResultWithSignal, execCommand } from './exec.ts';
import { toRegisteredInterceptor } from './interceptors.ts';
import { createProgramMethods } from './program-methods.ts';
import { hasInteractiveConfig, isAsyncBranded, makeThenable, noop, withPromiseDrain } from './results.ts';
import { parseCommand } from './validate.ts';

export { buildReplCompleter } from './commands.ts';
export { asyncSchema } from './results.ts';

/**
 * Options for configuring which built-in extensions are applied by default.
 */
export type PadroneBuiltins = {
  /** Enable `help` command, `--help` / `-h` flags, and default help display. Defaults to `true`. Pass options to configure it. */
  help?: boolean | PadroneHelpOptions;
  /** Enable `version` command and `--version` / `-v` / `-V` flags. Defaults to `true`. */
  version?: boolean;
  /** Enable `repl` command and `--repl` flag. Defaults to `true`. */
  repl?: boolean;
  /** Enable `--color` / `--no-color` flag support. Defaults to `true`. */
  color?: boolean;
  /** Enable "Did you mean?" suggestions for unknown commands and options. Defaults to `true`. */
  suggestions?: boolean;
  /** Enable signal handling (SIGINT, SIGTERM, SIGHUP). Defaults to `true`. */
  signal?: boolean;
  /** Enable automatic result output for `cli()`. Defaults to `true`. */
  autoOutput?: boolean;
  /** Enable stdin piping support. Defaults to `true`. */
  stdin?: boolean;
  /** Enable interactive prompting for missing arguments. Defaults to `true`. */
  interactive?: boolean;
};

export type PadroneOptions = { builtins?: PadroneBuiltins };

// biome-ignore lint/complexity/noBannedTypes: empty object signals "all defaults enabled"
type DefaultBuiltins = {};

type BuiltinCommands<B> = [...(B extends { help: false } ? [] : [HelpCommand]), ...(B extends { version: false } ? [] : [VersionCommand])];

export function createPadrone<TProgramName extends string, const TBuiltins extends PadroneBuiltins = DefaultBuiltins>(
  name: TProgramName,
  options?: { builtins?: TBuiltins },
): PadroneProgram<TProgramName, '', '', PadroneSchema<void>, void, BuiltinCommands<TBuiltins>> {
  let builder: any = createPadroneBuilder({ name, path: '', commands: [] } as any);

  const b = options?.builtins;
  if (b?.help !== false) builder = builder.extend(padroneHelp(typeof b?.help === 'object' ? b.help : undefined));
  if (b?.version !== false) builder = builder.extend(padroneVersion());
  if (b?.repl !== false) builder = builder.extend(padroneRepl());
  if (b?.color !== false) builder = builder.extend(padroneColor());
  if (b?.suggestions !== false) builder = builder.extend(padroneSuggestions());
  if (b?.signal !== false) builder = builder.extend(padroneSignalHandling());
  if (b?.autoOutput !== false) builder = builder.extend(padroneAutoOutput());
  if (b?.stdin !== false) builder = builder.extend(padroneStdin());
  if (b?.interactive !== false) builder = builder.extend(padroneInteractive());

  return builder as any;
}

export function createPadroneBuilder<TBuilder extends PadroneProgram = PadroneProgram>(
  inputCommand: AnyPadroneCommand,
): TBuilder & { [commandSymbol]: AnyPadroneCommand } {
  // Re-parent direct subcommands so getCommandRuntime walks to the current root,
  // not a stale parent from before .runtime()/.configure()/etc.
  const existingCommand =
    inputCommand.commands?.length && inputCommand.commands.some((c) => c.parent && c.parent !== inputCommand)
      ? {
          ...inputCommand,
          commands: inputCommand.commands.map((c) => (c.parent && c.parent !== inputCommand ? { ...c, parent: inputCommand } : c)),
        }
      : inputCommand;

  const parseCommandFn = (input: PadroneInput | undefined) => parseCommand(input, existingCommand, findCommandByName);
  const collectInterceptorsFn = (cmd: AnyPadroneCommand) => collectInterceptors(cmd, existingCommand);

  // Execution context shared by exec and program methods.
  // `builder` is assigned after the builder object is created (forward ref resolved at runtime only).
  const execCtx: ExecContext = {
    rootCommand: existingCommand,
    builder: undefined as any,
    parseCommandFn,
    collectInterceptorsFn,
  };

  const evalCommand: AnyPadroneProgram['eval'] = (input, evalOptions) => {
    try {
      const result = execCommand(input as string, execCtx, evalOptions, 'soft', evalOptions?.caller ?? 'eval');
      if (result instanceof Promise) return withPromiseDrain(result.catch((err: unknown) => errorResultWithSignal(err))) as any;
      return makeThenable(result);
    } catch (err) {
      return makeThenable(errorResultWithSignal(err)) as any;
    }
  };

  const programMethods = createProgramMethods(execCtx, evalCommand);

  const builder = {
    extend(extension: (builder: any) => any) {
      return extension(builder);
    },
    configure(config) {
      return createPadroneBuilder({ ...existingCommand, ...config }) as any;
    },
    runtime(runtimeConfig) {
      return createPadroneBuilder({ ...existingCommand, runtime: { ...existingCommand.runtime, ...runtimeConfig } }) as any;
    },
    async() {
      return createPadroneBuilder({ ...existingCommand, isAsync: true }) as any;
    },
    context(transform?: (ctx: unknown) => unknown) {
      if (!transform) return createPadroneBuilder({ ...existingCommand }) as any;
      const existing = existingCommand.contextTransform;
      const composed = existing ? (ctx: unknown) => transform(existing(ctx)) : transform;
      return createPadroneBuilder({ ...existingCommand, contextTransform: composed }) as any;
    },
    arguments(schema?: unknown, meta?: AnyPadroneCommand['meta']) {
      // A subcommand extends its parent's schema; the root extends its own earlier schema.
      const baseSchema = existingCommand.parent ? existingCommand.parent.argsSchema : existingCommand.argsSchema;
      const resolvedArgs = (typeof schema === 'function' ? schema(baseSchema) : schema) as PadroneSchema | undefined;
      const isAsync = existingCommand.isAsync || isAsyncBranded(resolvedArgs) || hasInteractiveConfig(meta);
      return createPadroneBuilder({ ...existingCommand, argsSchema: resolvedArgs, meta, isAsync }) as any;
    },
    action(handler = noop) {
      const baseHandler = existingCommand.action ?? noop;
      return createPadroneBuilder({
        ...existingCommand,
        action: (args: any, ctx: any) => (handler as any)(args, ctx, baseHandler),
      }) as any;
    },
    wrap(config) {
      const handler = createWrapHandler(config, existingCommand.argsSchema as any, existingCommand.meta?.positional);
      return createPadroneBuilder({ ...existingCommand, action: handler }) as any;
    },
    command(nameOrNames: string | readonly string[], builderFn?: (builder: any) => any) {
      const name = Array.isArray(nameOrNames) ? nameOrNames[0] : nameOrNames;
      const aliases = Array.isArray(nameOrNames) && nameOrNames.length > 1 ? (nameOrNames.slice(1) as string[]) : undefined;

      const existingSubcommand = existingCommand.commands?.find((c) => c.name === name) as AnyPadroneCommand | undefined;
      if (existingSubcommand) resolveCommand(existingSubcommand);

      const initialCommand: AnyPadroneCommand = existingSubcommand
        ? { ...existingSubcommand, aliases: aliases ?? existingSubcommand.aliases, parent: existingCommand }
        : ({
            name,
            path: existingCommand.path ? `${existingCommand.path} ${name}` : name,
            aliases,
            parent: existingCommand,
            '~types': {} as any,
          } satisfies PadroneCommand);

      if (builderFn) {
        const lazyCmd: AnyPadroneCommand = { ...initialCommand };
        (lazyCmd as any)[lazyResolver] = (target: AnyPadroneCommand) => {
          const savedParent = target.parent;
          const b = createPadroneBuilder(target);
          const commandObj = ((builderFn(b as any) as unknown as typeof b)?.[commandSymbol] as AnyPadroneCommand) ?? target;
          const mergedCommandObj = existingSubcommand ? mergeCommands(existingSubcommand, commandObj) : commandObj;
          Object.assign(target, mergedCommandObj);
          // Restore parent: mergeCommands copies the existing command's parent which may be stale
          // (e.g. when an extension is applied twice, the merged parent predates re-parenting).
          target.parent = savedParent;
        };

        const commands = existingCommand.commands || [];
        const existingIndex = commands.findIndex((c) => c.name === name);
        const updatedCommands =
          existingIndex >= 0
            ? [...commands.slice(0, existingIndex), lazyCmd, ...commands.slice(existingIndex + 1)]
            : [...commands, lazyCmd];

        return createPadroneBuilder({ ...existingCommand, commands: updatedCommands }) as any;
      }

      const commands = existingCommand.commands || [];
      const existingIndex = commands.findIndex((c) => c.name === name);
      const updatedCommands =
        existingIndex >= 0
          ? [...commands.slice(0, existingIndex), initialCommand, ...commands.slice(existingIndex + 1)]
          : [...commands, initialCommand];

      return createPadroneBuilder({ ...existingCommand, commands: updatedCommands }) as any;
    },

    mount(nameOrNames: string | readonly string[], program: unknown, options?: { context?: (ctx: unknown) => unknown }) {
      const name = Array.isArray(nameOrNames) ? nameOrNames[0] : nameOrNames;
      const aliases = Array.isArray(nameOrNames) && nameOrNames.length > 1 ? (nameOrNames.slice(1) as string[]) : undefined;

      const programCommand = (program as any)[commandSymbol] as AnyPadroneCommand | undefined;
      if (!programCommand) throw new RoutingError('Cannot mount: not a valid Padrone program');

      const remounted = repathCommandTree(programCommand, name, existingCommand.path || '', existingCommand);
      remounted.aliases = aliases;

      if (options?.context) {
        const existing = remounted.contextTransform;
        remounted.contextTransform = existing ? (ctx: unknown) => existing(options.context!(ctx)) : options.context;
      }

      const existingSubcommand = existingCommand.commands?.find((c) => c.name === name) as AnyPadroneCommand | undefined;
      const mergedCommandObj = existingSubcommand ? mergeCommands(existingSubcommand, remounted) : remounted;

      const commands = existingCommand.commands || [];
      const existingIndex = commands.findIndex((c) => c.name === name);
      const updatedCommands =
        existingIndex >= 0
          ? [...commands.slice(0, existingIndex), mergedCommandObj, ...commands.slice(existingIndex + 1)]
          : [...commands, mergedCommandObj];

      return createPadroneBuilder({ ...existingCommand, commands: updatedCommands }) as any;
    },

    intercept(metaOrFn: InterceptorMeta | PadroneInterceptorFn<any, any, any>, factory?: InterceptorFactory<any, any, any>) {
      const registered: RegisteredInterceptor = toRegisteredInterceptor(metaOrFn, factory);
      return createPadroneBuilder({
        ...existingCommand,
        interceptors: [...(existingCommand.interceptors ?? []), registered],
      }) as any;
    },

    ...programMethods,

    get info() {
      return {
        name: existingCommand.name,
        title: existingCommand.title,
        description: existingCommand.description,
        version: existingCommand.version,
        examples: existingCommand.examples,
        deprecated: existingCommand.deprecated,
        commands: (existingCommand.commands ?? []).map((c) => c.name),
      };
    },

    '~types': {} as any,

    [commandSymbol]: existingCommand,
  } satisfies AnyPadroneProgram & { [commandSymbol]: AnyPadroneCommand } as any;

  // Fix forward reference: execCtx.builder needs to reference the builder after it's created
  execCtx.builder = builder;

  return builder as TBuilder & { [commandSymbol]: AnyPadroneCommand };
}

/**
 * Identity helper that contextually types a command builder callback while preserving its full return type.
 * Use this when defining commands in separate files — the parent program retains exact type information
 * about the subcommand's args, result, and nested commands.
 *
 * The builder's context includes `DefineCommandContext` by default (optional `logger`, `tracing`, `progress`).
 * Override globally via module augmentation on `DefineCommandContext`, or per-command via `.requires()`.
 *
 * @example Direct form (most common)
 * ```ts
 * export const myCommand = defineCommand((c) =>
 *   c.arguments(z.object({ name: z.string() }))
 *    .action((args) => console.log(args.name))
 * );
 * ```
 *
 * @example With required interceptor context
 * ```ts
 * export const adminCommand = defineCommand()
 *   .requires<{ adminDb: AdminDB }>()
 *   .define((c) => c.action((_args, ctx) => ctx.context.adminDb.query(...)));
 * ```
 */
export function defineCommand<TContext = unknown, TOut extends CommandTypesBase = CommandTypesBase>(
  fn: (builder: PadroneBuilder<string, string, string, PadroneSchema<void>, void, [], any, false, TContext, DefineCommandContext>) => TOut,
): typeof fn;
export function defineCommand(): DefineCommandBuilder;
export function defineCommand(fn?: any): any {
  if (fn) return fn;
  const builder: DefineCommandBuilder = {
    requires: () => builder as any,
    define: (f: any) => f,
  };
  return builder;
}
