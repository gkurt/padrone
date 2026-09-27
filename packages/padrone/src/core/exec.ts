import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  AnyPadroneCommand,
  AnyPadroneProgram,
  InterceptorExecuteContext,
  InterceptorExecuteResult,
  InterceptorParseContext,
  InterceptorParseResult,
  InterceptorPipelinePhase,
  InterceptorRouteContext,
  InterceptorValidateContext,
  InterceptorValidateResult,
  PadroneActionContext,
  PadroneEvalPreferences,
  PadroneInput,
  RegisteredInterceptor,
  ResolvedInterceptor,
} from '../types/index.ts';
import { getCommandRuntime } from './commands.ts';
import { RoutingError, SignalError, ValidationError } from './errors.ts';
import { withEmit } from './events.ts';
import { readFileValues } from './from-file.ts';
import {
  checkInterceptorRequirements,
  resolveRegisteredInterceptors,
  runInterceptorChain,
  wrapWithCommandLifecycle,
  wrapWithLifecycle,
} from './interceptors.ts';
import { errorResult, noop, thenMaybe, warnIfUnexpectedAsync, withDrain } from './results.ts';
import { buildCommandArgs, formatIssueMessages, getDeprecationWarnings, takeDryRunFlag, validateCommandArgs } from './validate.ts';

export type ExecContext = {
  rootCommand: AnyPadroneCommand;
  builder: AnyPadroneProgram;
  parseCommandFn: (input: PadroneInput | undefined) => {
    command: AnyPadroneCommand;
    rawArgs: Record<string, unknown>;
    args: string[];
    unmatchedTerms: string[];
    issues?: StandardSchemaV1.Issue[];
  };
  collectInterceptorsFn: (cmd: AnyPadroneCommand) => RegisteredInterceptor[];
};

/**
 * Collects registered interceptors from the command's parent chain (root → ... → target).
 * Root/program interceptors come first (outermost), target command's interceptors last (innermost).
 */
export function collectInterceptors(cmd: AnyPadroneCommand, rootCommand: AnyPadroneCommand): RegisteredInterceptor[] {
  const chain: RegisteredInterceptor[][] = [];
  let current: AnyPadroneCommand | undefined = cmd;
  while (current) {
    const isTarget = current === cmd;
    if (!current.parent) {
      if (rootCommand.interceptors?.length) {
        const isRootTarget = cmd === rootCommand || !cmd.parent;
        chain.unshift(isRootTarget ? rootCommand.interceptors : rootCommand.interceptors.filter((i) => i.meta.inherit !== false));
      }
    } else {
      if (current.interceptors?.length) {
        chain.unshift(isTarget ? current.interceptors : current.interceptors.filter((i) => i.meta.inherit !== false));
      }
    }
    current = current.parent;
  }
  return chain.flat();
}

/** Wraps an error into a result, preserving any signal info from the pipeline. */
export function errorResultWithSignal(err: unknown) {
  const result = errorResult(err);
  if (err instanceof SignalError) {
    (result as any).signal = err.signal;
    (result as any).exitCode = err.exitCode;
  }
  return result;
}

/** Resolve context by walking the command parent chain and applying transforms from root to target. */
function resolveContext(command: AnyPadroneCommand, initialContext: unknown): unknown {
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
}

/** Validate parse result — reject unmatched terms when the command doesn't accept positional args. */
function validateParseResult(
  parseResult: { command: AnyPadroneCommand; rawArgs: Record<string, unknown>; args: string[]; unmatchedTerms: string[] },
  rootCommand: AnyPadroneCommand,
): InterceptorParseResult {
  const { command, rawArgs, args, unmatchedTerms } = parseResult;

  if (unmatchedTerms.length > 0) {
    const hasPositionalConfig = command.meta?.positional && command.meta.positional.length > 0;
    if (!hasPositionalConfig) {
      const isRootCommand = command === rootCommand;
      const commandDisplayName = command.name || command.aliases?.[0] || command.path || '(default)';
      const errorMsg = isRootCommand
        ? `Unknown command: ${unmatchedTerms[0]}`
        : `Unexpected arguments for '${commandDisplayName}': ${unmatchedTerms.join(' ')}`;

      throw new RoutingError(errorMsg, { command: command.path || command.name });
    }
  }

  return { command, rawArgs, positionalArgs: args };
}

/** Handle validation issues based on error mode: throw (hard) or return result with issues (soft). */
function handleValidationIssues(argsResult: StandardSchemaV1.FailureResult, command: AnyPadroneCommand, errorMode: 'soft' | 'hard') {
  if (errorMode === 'hard') {
    const issueMessages = formatIssueMessages(argsResult.issues);
    throw new ValidationError(`Validation error:\n${issueMessages}`, argsResult.issues as any, {
      command: command.path || command.name,
    });
  }

  return withDrain({
    command: command as any,
    args: undefined,
    argsResult,
    result: undefined,
  });
}

/**
 * Core execution logic shared by eval() and cli().
 * errorMode controls validation error behavior:
 * - 'soft': return result with issues (eval behavior)
 * - 'hard': print error + help and throw (cli-without-input behavior)
 */
export function execCommand(
  resolvedInput: PadroneInput | undefined,
  ctx: ExecContext,
  evalOptions?: PadroneEvalPreferences,
  errorMode: 'soft' | 'hard' = 'soft',
  caller: PadroneActionContext['caller'] = 'eval',
) {
  const { rootCommand, parseCommandFn, collectInterceptorsFn } = ctx;
  const baseRuntime = getCommandRuntime(rootCommand);
  const runtime = evalOptions?.runtime
    ? Object.assign({}, baseRuntime, Object.fromEntries(Object.entries(evalOptions.runtime).filter(([, v]) => v !== undefined)))
    : baseRuntime;

  // The caller's signal, or an inert one. The signal extension replaces it via next({ signal }) in the start phase,
  // with a signal that also follows this one.
  const baseSignal = evalOptions?.signal ?? new AbortController().signal;

  // Pipeline state accumulated as phases complete — propagated to error/shutdown contexts.
  const pipelineState: { phase: InterceptorPipelinePhase; rawArgs?: Record<string, unknown>; positionalArgs?: string[]; args?: unknown } = {
    phase: 'start',
  };

  const initialContext = evalOptions?.context;

  // Factory resolution cache — ensures each factory is called at most once per execution,
  // so root interceptor closures are shared when they appear in both root and command chains.
  const factoryCache = new Map<RegisteredInterceptor, ResolvedInterceptor>();
  const rootRegistered = rootCommand.interceptors ?? [];
  const rootInterceptors = resolveRegisteredInterceptors(rootRegistered, factoryCache);
  const rootInterceptorSet = new Set(rootInterceptors);

  const runPipeline = (signal: AbortSignal, pipelineContext: unknown) => {
    // ── Phase 1: Parse ──────────────────────────────────────────────────
    const parseCtx: InterceptorParseContext = withEmit({
      input: resolvedInput,
      command: rootCommand,
      signal,
      context: pipelineContext as object,
      runtime,
      program: ctx.builder,
      caller,
    });

    // Tokenizer issues (e.g. an option missing its value) surface as validation issues of the parsed command.
    let parseIssues: { command: AnyPadroneCommand; issues: StandardSchemaV1.Issue[] } | undefined;
    const coreParse = (parseCtx: InterceptorParseContext): InterceptorParseResult => {
      const parseResult = parseCommandFn(parseCtx.input);
      if (parseResult.issues) parseIssues = { command: parseResult.command, issues: parseResult.issues };
      // Warn people typing commands; programmatic callers already see `deprecated` in help and types.
      if (caller === 'cli' || caller === 'repl') {
        for (const warning of getDeprecationWarnings(parseResult.command, parseResult.rawArgs)) parseCtx.runtime.error(warning);
      }
      return validateParseResult(parseResult, rootCommand);
    };

    const parsedOrPromise = runInterceptorChain('parse', rootInterceptors, parseCtx, coreParse);

    // ── Phases 2 & 3 chained after parse ────────────────────────────────
    const continueAfterParse = (parsed: InterceptorParseResult) => {
      const { command } = parsed;
      pipelineState.phase = 'parse';
      pipelineState.rawArgs = parsed.rawArgs;
      pipelineState.positionalArgs = parsed.positionalArgs;
      const registered = collectInterceptorsFn(command);
      checkInterceptorRequirements(registered);
      const commandInterceptors = resolveRegisteredInterceptors(registered, factoryCache);
      const commandOnlyInterceptors = commandInterceptors.filter((i) => !rootInterceptorSet.has(i));
      const context = resolveContext(command, pipelineContext);

      // ── Phase 2: Route ──────────────────────────────────────────────
      const routeCtx: InterceptorRouteContext = withEmit({
        ...parseCtx,
        command,
        rawArgs: parsed.rawArgs,
        positionalArgs: parsed.positionalArgs,
        context: context as object,
      });

      const routedOrPromise = runInterceptorChain('route', commandInterceptors, routeCtx, () => {});

      const continueAfterRoute = () => {
        pipelineState.phase = 'route';
        // Taken before validation so it isn't an unknown option; only commands with a dry-run handler have it
        const dryRun = takeDryRunFlag(command, parsed.rawArgs);
        const runValidateAndExecute = () => {
          // ── Phase 3: Validate ───────────────────────────────────────────
          const validateCtx: InterceptorValidateContext = withEmit({
            ...parseCtx,
            command,
            rawArgs: parsed.rawArgs,
            positionalArgs: parsed.positionalArgs,
            context: context as object,
            evalInteractive: evalOptions?.interactive,
          });
          // What validate interceptors passed to `next()` (e.g. a runtime with `.env` variables) carries into execute
          let validatedCtx = validateCtx;

          const coreValidate = (
            validateCtx: InterceptorValidateContext,
          ): InterceptorValidateResult | Promise<InterceptorValidateResult> => {
            validatedCtx = validateCtx;
            if (parseIssues?.command === validateCtx.command) return { args: undefined, argsResult: { issues: parseIssues.issues } as any };
            const { args: preprocessedArgs, issues } = buildCommandArgs(
              validateCtx.command,
              validateCtx.rawArgs,
              validateCtx.positionalArgs,
            );
            if (issues) return { args: undefined, argsResult: { issues } as any };
            const validated = validateCommandArgs(validateCtx.command, preprocessedArgs);
            return thenMaybe(validated, (v) => v as InterceptorValidateResult);
          };

          const validatedOrPromise = runInterceptorChain('validate', commandInterceptors, validateCtx, coreValidate);

          // ── Phase 3: Execute (or handle validation errors) ──────────────
          const continueAfterValidate = (v: InterceptorValidateResult) => {
            pipelineState.phase = 'validate';
            pipelineState.args = v.args;
            if (v.argsResult?.issues) return handleValidationIssues(v.argsResult as StandardSchemaV1.FailureResult, command, errorMode);

            const executeCtx: InterceptorExecuteContext = withEmit({
              ...validatedCtx,
              args: v.args,
              ...(dryRun && { dryRun }),
            });

            const coreExecute = (executeCtx: InterceptorExecuteContext): InterceptorExecuteResult => {
              // Under --dry-run the action never runs
              const handler = (dryRun ? command.dryRun : command.action) ?? noop;
              const effectiveRuntime = executeCtx.runtime;
              const actionCtx: PadroneActionContext = withEmit({
                runtime: effectiveRuntime,
                command: executeCtx.command,
                program: ctx.builder as any,
                signal: executeCtx.signal,
                context: executeCtx.context,
                caller,
              });
              const result = handler(executeCtx.args as any, actionCtx);
              return { result };
            };

            pipelineState.phase = 'execute';
            const executedOrPromise = runInterceptorChain('execute', commandInterceptors, executeCtx, coreExecute);

            return thenMaybe(executedOrPromise, (e) => {
              const finalize = (result: unknown) =>
                withDrain({
                  command: command as any,
                  args: v.args,
                  argsResult: v.argsResult,
                  result,
                });

              if (e.result instanceof Promise) return e.result.then(finalize);
              return finalize(e.result);
            });
          };

          return thenMaybe(warnIfUnexpectedAsync(validatedOrPromise, command), continueAfterValidate) as any;
        };

        // `fromFile` values typed on the command line are read before validate interceptors add env and config values
        const readFilesThenValidate = () =>
          thenMaybe(readFileValues(command, parsed.rawArgs, parsed.positionalArgs, runtime, caller), (issues) => {
            if (issues) parseIssues = { command, issues: [...(parseIssues?.command === command ? parseIssues.issues : []), ...issues] };
            return runValidateAndExecute();
          });

        return wrapWithCommandLifecycle(
          commandOnlyInterceptors,
          command,
          resolvedInput,
          readFilesThenValidate,
          (result) => withDrain({ command: command as any, args: undefined, argsResult: undefined, result }),
          signal,
          context,
          runtime,
          ctx.builder,
          caller,
          pipelineState,
        );
      };

      return thenMaybe(routedOrPromise, continueAfterRoute) as any;
    };

    return thenMaybe(parsedOrPromise, continueAfterParse) as any;
  };

  return wrapWithLifecycle(
    rootInterceptors,
    rootCommand,
    resolvedInput,
    runPipeline,
    (result) => withDrain({ command: rootCommand, args: undefined, argsResult: undefined, result }),
    baseSignal,
    initialContext,
    runtime,
    ctx.builder,
    caller,
    pipelineState,
  ) as any;
}
