import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Schema } from 'ai';
import type { ShellType } from '../feature/completion.ts';
import { createPrompt } from '../feature/prompt.ts';
import { createCallLimiter, linkedController } from '../feature/remote.ts';
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
import { outputValueToText } from '../util/json.ts';
import { parsePositionalConfig } from './args.ts';
import {
  exposeRefusal,
  findCommandByName,
  getCommandRuntime,
  getGlobalArgs,
  resolveAllCommands,
  resolveContext,
  serializeArgsToFlags,
} from './commands.ts';
import { ActionError, RoutingError, ValidationError } from './errors.ts';
import { withEmit } from './events.ts';
import type { ExecContext } from './exec.ts';
import { collectInterceptors, errorResultWithSignal, execCommand } from './exec.ts';
import { checkInterceptorRequirements, resolveRegisteredInterceptors, runInterceptorChain } from './interceptors.ts';
import { errorResult, finalizeResult, makeThenable, thenMaybe, warnIfUnexpectedAsync, withPromiseDrain } from './results.ts';
import { coreValidateForParse, formatIssueMessages, takeDryRunFlag, validateCommandArgs } from './validate.ts';

/** The exit code an error asks for: its own `exitCode` (as `PadroneError` carries), or 1. */
function errorExitCode(error: unknown): number {
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === 'number' ? code : 1;
}

/**
 * Finalizes a `cli()` result, setting the process exit code when it ended with an error or a signal,
 * or when an error only surfaces as it is drained. Successful runs leave it untouched.
 */
function finalizeCliResult<T extends { error?: unknown; exitCode?: number }>(
  result: T,
  setExitCode: ((code: number) => void) | undefined,
): T {
  if (!setExitCode) return finalizeResult(result);
  const code = result.exitCode ?? (result.error !== undefined ? errorExitCode(result.error) : undefined);
  if (code) setExitCode(code);
  return finalizeResult(result, (error) => setExitCode(result.exitCode ?? errorExitCode(error)));
}

/** What an `api()` function returns for a `run()` result: the action's result, or a throw for invalid args or a failing action. */
function unwrapApiResult(result: { error?: unknown; result?: unknown; argsResult?: StandardSchemaV1.Result<unknown> }): unknown {
  if (result.error !== undefined) throw result.error;
  const issues = result.argsResult?.issues;
  if (issues) throw new ValidationError(`Validation error:\n${formatIssueMessages(issues)}`, issues as any);
  return result.result;
}

/** Quotes a token for `eval()`'s tokenizer when it has spaces or quotes (JSON values do), escaping `\` and the quote. */
function quoteToken(text: string): string {
  if (!/[\s"'`]/.test(text)) return text;
  const quote = text.includes('"') && !text.includes("'") ? "'" : '"';
  return `${quote}${text.replace(/[\\"']/g, (c) => (c === '\\' || c === quote ? `\\${c}` : c))}${quote}`;
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

    if (args && typeof args === 'object') {
      for (const { name, variadic } of positionalConfig) {
        const value = (args as Record<string, unknown>)[name];
        if (value === undefined) continue;

        if (variadic && Array.isArray(value)) for (const v of value) parts.push(quoteToken(String(v)));
        else parts.push(quoteToken(String(value)));
      }

      const named = Object.fromEntries(Object.entries(args).filter(([key]) => !positionalNames.has(key)));
      for (const token of serializeArgsToFlags(named, commandObj)) {
        const eq = token.startsWith('--') ? token.indexOf('=') : -1;
        parts.push(eq === -1 ? quoteToken(token) : `${token.slice(0, eq + 1)}${quoteToken(token.slice(eq + 1))}`);
      }
    }

    return parts.join(' ');
  };

  const run: AnyPadroneProgram['run'] = (command, args?: unknown, prefs?: { context?: unknown; signal?: AbortSignal }) => {
    try {
      const commandObj = typeof command === 'string' ? findCommandByName(command, rootCommand.commands) : (command as AnyPadroneCommand);
      if (!commandObj) throw new RoutingError(`Command "${command ?? ''}" not found`);
      if (!commandObj.action) throw new RoutingError(`Command "${commandObj.path}" has no action`, { command: commandObj.path });
      const refusal = exposeRefusal(commandObj, 'run');
      if (refusal) throw new ActionError(refusal, { command: commandObj.path });

      // Like eval(), an action without arguments gets {}
      if (!commandObj.argsSchema && !getGlobalArgs(commandObj)) return executeValidated(commandObj, args ?? {}, prefs);
      // Args are checked against the schema, which applies its defaults and transforms (the validate phase doesn't run)
      const validatedOrPromise = validateCommandArgs(commandObj, (args ?? {}) as Record<string, unknown>);
      const execute = (validated: { args: unknown; argsResult: StandardSchemaV1.Result<unknown> }) => {
        if (validated.argsResult.issues) {
          return finalizeResult({ command: commandObj as any, args: undefined, argsResult: validated.argsResult, result: undefined });
        }
        return executeValidated(commandObj, validated.args, prefs);
      };
      if (validatedOrPromise instanceof Promise) {
        return validatedOrPromise
          .then(execute)
          .catch((err: unknown) => finalizeResult(errorResult(err, { command: commandObj, args }))) as any;
      }
      return execute(validatedOrPromise) as any;
    } catch (err) {
      return finalizeResult(errorResult(err)) as any;
    }
  };

  const executeValidated = (commandObj: AnyPadroneCommand, args: unknown, prefs?: { context?: unknown; signal?: AbortSignal }) => {
    try {
      const resolvedCtx = resolveContext(commandObj, prefs?.context);
      const commandRuntime = getCommandRuntime(commandObj);
      const executeCtx: InterceptorExecuteContext = withEmit({
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
      });

      const coreExecute = (executeCtx: InterceptorExecuteContext): InterceptorExecuteResult => {
        const actionCtx: PadroneActionContext = withEmit({
          runtime: executeCtx.runtime,
          command: executeCtx.command,
          program: ctx.builder as any,
          signal: executeCtx.signal,
          context: executeCtx.context,
          caller: 'run',
          prompt: createPrompt(executeCtx),
        });
        const result = commandObj.action!(executeCtx.args as any, actionCtx);
        return { result };
      };

      const registered = collectInterceptors(commandObj, rootCommand);
      checkInterceptorRequirements(registered);
      const commandInterceptors = resolveRegisteredInterceptors(registered, new Map());
      const executedOrPromise = runInterceptorChain('execute', commandInterceptors, executeCtx, coreExecute);

      const toResult = (e: InterceptorExecuteResult) => finalizeResult({ command: commandObj as any, args: args as any, result: e.result });

      if (executedOrPromise instanceof Promise) {
        return executedOrPromise
          .then(toResult)
          .catch((err: unknown) => finalizeResult(errorResult(err, { command: commandObj, args }))) as any;
      }
      return toResult(executedOrPromise);
    } catch (err) {
      return finalizeResult(errorResult(err, { command: commandObj, args })) as any;
    }
  };

  /** Outside an execution: the root's interceptors handle the event, as for `run()` on the root. */
  const emit: AnyPadroneProgram['emit'] = (event, ...payload) =>
    withEmit({
      command: rootCommand,
      signal: inertSignal,
      context: resolveContext(rootCommand, undefined) as object,
      runtime: getCommandRuntime(rootCommand),
      program: ctx.builder,
      caller: 'run',
    }).emit(event, ...payload);

  const tool: AnyPadroneProgram['tool'] = (prefs) => {
    resolveAllCommands(rootCommand);
    const limit = createCallLimiter(prefs);
    const helpText = generateHelp(rootCommand, undefined, { format: 'text' });

    const description = `Run a command. Pass the full command string including arguments. Use "help <command>" for detailed usage.\n\n${helpText}`;

    return {
      type: 'function',
      name: rootCommand.name,
      strict: true,
      title: rootCommand.title ?? rootCommand.name,
      description,
      inputExamples: [{ input: { command: '<command> [positionals...] [arguments...]' } }],
      inputSchema: {
        [Symbol.for('vercel.ai.schema') as keyof Schema & symbol]: true,
        jsonSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
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
        // A dry run changes nothing
        if (parsed.dryRun) return false;
        // Without valid args the approval function can't decide (values from env or config aren't applied here): ask
        if (typeof parsed.command.needsApproval === 'function')
          return parsed.argsResult?.issues ? true : parsed.command.needsApproval(parsed.args);
        if (parsed.command.needsApproval != null) return !!parsed.command.needsApproval;
        return !!parsed.command.mutation;
      },
      execute: async (input, options) => {
        const printed: { text: string; stderr?: boolean }[] = [];
        const { controller, dispose } = linkedController(options?.abortSignal);
        const call = await limit(controller, () =>
          evalCommand(input.command, {
            caller: 'tool',
            signal: controller.signal,
            context: prefs?.context,
            runtime: {
              output: (...args) => printed.push({ text: args.map(outputValueToText).join(' ') }),
              error: (text) => printed.push({ text, stderr: true }),
              interactive: 'unsupported',
              format: 'text',
            },
          }),
        ).finally(dispose);
        const timedOut = { error: new Error(`Timed out after ${prefs?.timeout} ms`), result: undefined, argsResult: undefined };
        const result = call.status === 'done' ? call.value : timedOut;
        // Failures come back in `error` for the model to read; auto-output only prints errors in `cli()`
        const failure =
          result.error !== undefined
            ? result.error instanceof Error
              ? result.error.message
              : String(result.error)
            : result.argsResult?.issues
              ? `Validation error:\n${formatIssueMessages(result.argsResult.issues)}`
              : undefined;
        const lines = (keep: (line: { stderr?: boolean }) => boolean) => printed.filter(keep).map((line) => line.text);
        // What a successful command wrote to stderr (warnings, logs) is part of its logs, not an error
        if (failure === undefined) return { result: result.result, logs: lines(() => true).join('\n'), error: '' };
        const error = [...lines((line) => !!line.stderr), failure].join('\n');
        return { result: result.result, logs: lines((line) => !line.stderr).join('\n'), error };
      },
    };
  };

  const replActiveRef = { value: false };
  const replFn = (options?: PadroneReplPreferences) =>
    createReplIterator({ existingCommand: rootCommand, evalCommand, replActiveRef }, options);

  const cli: AnyPadroneProgram['cli'] = (cliOptions) => {
    const runtime = getCommandRuntime(rootCommand);
    const setExitCode = cliOptions?.runtime?.setExitCode ?? runtime.setExitCode;
    const withExitCode = (result: any) => finalizeCliResult(result, setExitCode);
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
    const dryRun = takeDryRunFlag(command, rawArgs);

    const validatedOrPromise = issues ? { args: undefined, argsResult: { issues } } : coreValidateForParse(command, rawArgs, args);

    return makeThenable(
      warnIfUnexpectedAsync(
        thenMaybe(validatedOrPromise, (v: any) => ({
          command: command as any,
          args: v.args,
          argsResult: v.argsResult,
          ...(dryRun && { dryRun }),
        })),
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
      extraCommands: prefs?.extraCommands ?? true,
    });
  };

  const api: AnyPadroneProgram['api'] = (prefs) => {
    resolveAllCommands(rootCommand);
    function buildApi(command: AnyPadroneCommand) {
      const runCommand = ((args) => thenMaybe(run(command, args, prefs), unwrapApiResult)) as PadroneAPI<AnyPadroneCommand>;
      if (!command.commands) return runCommand;
      for (const cmd of command.commands) runCommand[cmd.name] = buildApi(cmd);
      return runCommand;
    }
    return buildApi(rootCommand);
  };

  const completion: AnyPadroneProgram['completion'] = async (shell, options) => {
    resolveAllCommands(rootCommand);
    const { generateCompletionOutput } = await import('../feature/completion.ts');
    return generateCompletionOutput(rootCommand, shell as ShellType | undefined, getCommandRuntime(rootCommand).env(), options);
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
    emit,
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
