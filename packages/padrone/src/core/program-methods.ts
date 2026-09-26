import type { Schema } from 'ai';
import type { ShellType } from '../feature/completion.ts';
import { createReplIterator } from '../feature/repl-loop.ts';
import { generateHelp } from '../output/help.ts';
import type {
  AnyPadroneCommand,
  AnyPadroneProgram,
  InterceptorExecuteContext,
  InterceptorExecuteResult,
  PadroneActionContext,
  PadroneAPI,
  PadroneReplPreferences,
} from '../types/index.ts';
import { extractSchemaMetadata, parsePositionalConfig } from './args.ts';
import { findCommandByName, getCommandRuntime, resolveAllCommands } from './commands.ts';
import { RoutingError } from './errors.ts';
import type { ExecContext } from './exec.ts';
import { collectInterceptors, errorResultWithSignal, execCommand } from './exec.ts';
import { resolveRegisteredInterceptors, runInterceptorChain } from './interceptors.ts';
import { errorResult, makeThenable, thenMaybe, warnIfUnexpectedAsync, withDrain, withPromiseDrain } from './results.ts';
import { coreValidateForParse } from './validate.ts';

/** The exit code an error asks for: its own `exitCode` (as `PadroneError` carries), or 1. */
function errorExitCode(error: unknown): number {
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === 'number' ? code : 1;
}

/**
 * Sets the process exit code for a `cli()` result that ended with an error or a signal —
 * and for an error that only surfaces when the result is drained. Successful runs leave it untouched.
 */
function reportExitCode<T extends { error?: unknown; exitCode?: number; drain: () => Promise<{ error?: unknown }> }>(
  result: T,
  setExitCode: ((code: number) => void) | undefined,
): T {
  if (!setExitCode) return result;
  const code = result.exitCode ?? (result.error !== undefined ? errorExitCode(result.error) : undefined);
  if (code) setExitCode(code);
  const drain = result.drain;
  result.drain = async () => {
    const drained = await drain();
    if (drained.error !== undefined && result.error === undefined) setExitCode(result.exitCode ?? errorExitCode(drained.error));
    return drained;
  };
  return result;
}

export function createProgramMethods(ctx: ExecContext, evalCommand: AnyPadroneProgram['eval']) {
  const { rootCommand } = ctx;

  // A never-aborted signal for contexts that don't need signal handling (parse, run).
  const inertSignal = new AbortController().signal;

  const stringify: AnyPadroneProgram['stringify'] = (command = '' as any, args) => {
    const commandObj = typeof command === 'string' ? findCommandByName(command, rootCommand.commands) : (command as AnyPadroneCommand);
    if (!commandObj) throw new RoutingError(`Command "${command ?? ''}" not found`);

    const parts: string[] = [];

    if (commandObj.path) parts.push(commandObj.path);

    const positionalConfig = commandObj.meta?.positional ? parsePositionalConfig(commandObj.meta.positional) : [];
    const positionalNames = new Set(positionalConfig.map((p) => p.name));

    // Build reverse map: arg name → first negative keyword (for stringify)
    const negativeKeyword: Record<string, string> = {};
    if (commandObj.argsSchema) {
      const { negatives } = extractSchemaMetadata(commandObj.argsSchema, commandObj.meta?.fields, commandObj.meta?.autoAlias);
      for (const [keyword, argName] of Object.entries(negatives)) {
        if (!(argName in negativeKeyword)) negativeKeyword[argName] = keyword;
      }
    }

    if (args && typeof args === 'object') {
      for (const { name, variadic } of positionalConfig) {
        const value = (args as Record<string, unknown>)[name];
        if (value === undefined) continue;

        if (variadic && Array.isArray(value)) {
          for (const v of value) {
            const vStr = String(v);
            if (vStr.includes(' ')) parts.push(`"${vStr}"`);
            else parts.push(vStr);
          }
        } else {
          const argStr = String(value);
          if (argStr.includes(' ')) parts.push(`"${argStr}"`);
          else parts.push(argStr);
        }
      }

      const stringifyValue = (key: string, value: unknown) => {
        if (value === undefined) return;

        if (typeof value === 'boolean') {
          if (value) parts.push(`--${key}`);
          else if (negativeKeyword[key]) parts.push(`--${negativeKeyword[key]}`);
          else parts.push(`--no-${key}`);
        } else if (Array.isArray(value)) {
          for (const v of value) {
            const vStr = String(v);
            if (vStr.includes(' ')) parts.push(`--${key}="${vStr}"`);
            else parts.push(`--${key}=${vStr}`);
          }
        } else if (typeof value === 'object' && value !== null) {
          for (const [nestedKey, nestedValue] of Object.entries(value)) {
            stringifyValue(`${key}.${nestedKey}`, nestedValue);
          }
        } else if (typeof value === 'string') {
          if (value.includes(' ')) parts.push(`--${key}="${value}"`);
          else parts.push(`--${key}=${value}`);
        } else {
          parts.push(`--${key}=${value}`);
        }
      };

      for (const [key, value] of Object.entries(args)) {
        if (value === undefined || positionalNames.has(key)) continue;
        stringifyValue(key, value);
      }
    }

    return parts.join(' ');
  };

  const resolveContext = (command: AnyPadroneCommand, initialContext: unknown): unknown => {
    const chain: AnyPadroneCommand[] = [];
    let current: AnyPadroneCommand | undefined = command;
    while (current) {
      chain.unshift(current);
      current = current.parent;
    }
    let resolved = initialContext;
    for (const cmd of chain) {
      if (cmd.contextTransform) resolved = cmd.contextTransform(resolved);
    }
    return resolved;
  };

  const run: AnyPadroneProgram['run'] = (command, args, prefs?: { context?: unknown; signal?: AbortSignal }) => {
    try {
      const commandObj = typeof command === 'string' ? findCommandByName(command, rootCommand.commands) : (command as AnyPadroneCommand);
      if (!commandObj) throw new RoutingError(`Command "${command ?? ''}" not found`);
      if (!commandObj.action) throw new RoutingError(`Command "${commandObj.path}" has no action`, { command: commandObj.path });

      const resolvedCtx = resolveContext(commandObj, prefs?.context);
      const commandRuntime = getCommandRuntime(commandObj);
      const executeCtx: InterceptorExecuteContext = {
        command: commandObj,
        input: undefined,
        rawArgs: {},
        positionalArgs: [],
        args,
        signal: prefs?.signal ?? inertSignal,
        context: resolvedCtx as object,
        runtime: commandRuntime,
        program: ctx.builder as any,
        caller: 'run',
      };

      const coreExecute = (executeCtx: InterceptorExecuteContext): InterceptorExecuteResult => {
        const actionCtx: PadroneActionContext = {
          runtime: executeCtx.runtime,
          command: executeCtx.command,
          program: ctx.builder as any,
          signal: executeCtx.signal,
          context: executeCtx.context,
          caller: 'run',
        };
        const result = commandObj.action!(executeCtx.args as any, actionCtx);
        return { result };
      };

      const commandInterceptors = resolveRegisteredInterceptors(collectInterceptors(commandObj, rootCommand), new Map());
      const executedOrPromise = runInterceptorChain('execute', commandInterceptors, executeCtx, coreExecute);

      const toResult = (e: InterceptorExecuteResult) => withDrain({ command: commandObj as any, args: args as any, result: e.result });

      if (executedOrPromise instanceof Promise) {
        return executedOrPromise.then(toResult).catch((err: unknown) => errorResult(err, { command: commandObj, args })) as any;
      }
      return toResult(executedOrPromise);
    } catch (err) {
      return errorResult(err) as any;
    }
  };

  const tool: AnyPadroneProgram['tool'] = () => {
    resolveAllCommands(rootCommand);
    const helpText = generateHelp(rootCommand, undefined, { format: 'text' });

    const description = `Run a command. Pass the full command string including arguments. Use "help <command>" for detailed usage.\n\n${helpText}`;

    return {
      type: 'function',
      name: rootCommand.name,
      strict: true,
      title: rootCommand.description,
      description,
      inputExamples: [{ input: { command: '<command> [positionals...] [arguments...]' } }],
      inputSchema: {
        [Symbol.for('vercel.ai.schema') as keyof Schema & symbol]: true,
        jsonSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          additionalProperties: false,
        },
        _type: undefined as unknown as { command: string },
        validate: (value) => {
          const command = (value as any)?.command;
          if (typeof command === 'string') return { success: true, value: { command } };
          return { success: false, error: new Error('Expected an object with command property as string.') };
        },
      } satisfies Schema<{ command: string }> as Schema<{ command: string }>,
      needsApproval: async (input) => {
        const parsed = await parse(input.command);
        if (typeof parsed.command.needsApproval === 'function') return parsed.command.needsApproval(parsed.args);
        if (parsed.command.needsApproval != null) return !!parsed.command.needsApproval;
        return !!parsed.command.mutation;
      },
      execute: async (input) => {
        const output: string[] = [];
        const errors: string[] = [];
        const result = await evalCommand(input.command, {
          caller: 'tool',
          runtime: {
            output: (...args) => output.push(args.map(String).join(' ')),
            error: (text) => errors.push(text),
            interactive: 'unsupported',
            format: 'text',
          },
        });
        return { result: result.result, logs: output.join('\n'), error: errors.join('\n') };
      },
    };
  };

  const replActiveRef = { value: false };
  const replFn = (options?: PadroneReplPreferences) =>
    createReplIterator({ existingCommand: rootCommand, evalCommand, replActiveRef }, options);

  const cli: AnyPadroneProgram['cli'] = (cliOptions) => {
    const runtime = getCommandRuntime(rootCommand);
    const setExitCode = cliOptions?.runtime?.setExitCode ?? runtime.setExitCode;
    const withExitCode = (result: any) => reportExitCode(result, setExitCode);
    try {
      // argv is already tokenized by the shell: pass it through as is, one token per entry.
      const argv = (cliOptions?.runtime?.argv ?? runtime.argv)();
      const result = execCommand(argv.length ? argv : undefined, ctx, cliOptions, 'hard', 'cli');

      if (result instanceof Promise)
        return withPromiseDrain(result.catch((err: unknown) => errorResultWithSignal(err)).then(withExitCode)) as any;
      return makeThenable(withExitCode(result));
    } catch (err) {
      return makeThenable(withExitCode(errorResultWithSignal(err))) as any;
    }
  };

  const find: AnyPadroneProgram['find'] = (command) => {
    if (typeof command !== 'string') return findCommandByName(command.path, rootCommand.commands) as any;
    return findCommandByName(command, rootCommand.commands) as any;
  };

  const parse: AnyPadroneProgram['parse'] = (input) => {
    const { command, rawArgs, args, issues } = ctx.parseCommandFn(input as string | undefined);

    const validatedOrPromise = issues ? { args: undefined, argsResult: { issues } } : coreValidateForParse(command, rawArgs, args);

    return makeThenable(
      warnIfUnexpectedAsync(
        thenMaybe(validatedOrPromise, (v: any) => ({ command: command as any, args: v.args, argsResult: v.argsResult })),
        command,
      ),
    ) as any;
  };

  const help: AnyPadroneProgram['help'] = (command, prefs) => {
    resolveAllCommands(rootCommand);
    const commandObj = !command
      ? rootCommand
      : typeof command === 'string'
        ? findCommandByName(command, rootCommand.commands)
        : (command as AnyPadroneCommand);
    if (!commandObj) throw new RoutingError(`Command "${command ?? ''}" not found`);
    const runtime = getCommandRuntime(rootCommand);
    return generateHelp(rootCommand, commandObj, {
      ...prefs,
      format: prefs?.format ?? runtime.format,
      theme: prefs?.theme ?? runtime.theme,
      terminal: prefs?.terminal ?? runtime.terminal,
      env: prefs?.env ?? runtime.env(),
    });
  };

  const api: AnyPadroneProgram['api'] = () => {
    resolveAllCommands(rootCommand);
    function buildApi(command: AnyPadroneCommand) {
      const runCommand = ((args) => run(command, args).result) as PadroneAPI<AnyPadroneCommand>;
      if (!command.commands) return runCommand;
      for (const cmd of command.commands) runCommand[cmd.name] = buildApi(cmd);
      return runCommand;
    }
    return buildApi(rootCommand);
  };

  const completion: AnyPadroneProgram['completion'] = async (shell) => {
    resolveAllCommands(rootCommand);
    const { generateCompletionOutput } = await import('../feature/completion.ts');
    return generateCompletionOutput(rootCommand, shell as ShellType | undefined);
  };

  const mcp: AnyPadroneProgram['mcp'] = async (prefs) => {
    resolveAllCommands(rootCommand);
    const { startMcpServer } = await import('../feature/mcp.ts');
    return startMcpServer(ctx.builder as any, rootCommand, evalCommand, prefs);
  };

  const serve: AnyPadroneProgram['serve'] = async (prefs) => {
    resolveAllCommands(rootCommand);
    const { startServeServer } = await import('../feature/serve.ts');
    return startServeServer(ctx.builder as any, rootCommand, evalCommand, prefs);
  };

  return {
    find,
    parse,
    stringify,
    run,
    eval: evalCommand,
    cli,
    tool,
    repl: replFn,
    api,
    help,
    completion,
    mcp,
    serve,
  };
}
