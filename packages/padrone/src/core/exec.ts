import type { StandardSchemaV1 } from '@standard-schema/spec';
import { createPrompt } from '../feature/prompt.ts';
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
import { exposeRefusal, getCommandRuntime, resolveContext } from './commands.ts';
import { ActionError, RoutingError, SignalError, ValidationError } from './errors.ts';
import { withEmit } from './events.ts';
import { readFileValues } from './from-file.ts';
import {
  checkInterceptorRequirements,
  resolveRegisteredInterceptors,
  runInterceptorChain,
  wrapWithCommandLifecycle,
  wrapWithLifecycle,
} from './interceptors.ts';
import { emitCommandNotFound, isNotFoundCommand } from './not-found.ts';
import { errorResult, noop, thenMaybe, warnIfUnexpectedAsync } from './results.ts';
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

/** Where a program keeps its `ExecContext`, so a start interceptor's `next({ program })` can run the pipeline on another program. */
export const execContextKey: unique symbol = Symbol('padrone:exec-context');

/** How many times `commandNotFound` handlers may reroute one run, so two handlers can't bounce an input forever. */
const MAX_REROUTES = 5;

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

  return {
    command: command as any,
    args: undefined,
    argsResult,
    result: undefined,
  };
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
  const { rootCommand } = ctx;
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
  const auth = evalOptions?.auth;

  // Factory resolution cache — ensures each factory is called at most once per execution,
  // so root interceptor closures are shared when they appear in both root and command chains.
  const factoryCache = new Map<RegisteredInterceptor, ResolvedInterceptor>();
  const rootRegistered = rootCommand.interceptors ?? [];
  const rootInterceptors = resolveRegisteredInterceptors(rootRegistered, factoryCache);
  const rootInterceptorSet = new Set(rootInterceptors);
  // Root interceptors whose id a command-level one reuses: the command's wins for error/shutdown too
  const overridden = new Set<ResolvedInterceptor>();

  const runPipeline = (signal: AbortSignal, pipelineContext: unknown, program?: AnyPadroneProgram) => {
    // A start interceptor's `next({ program })` (e.g. with plugins loaded) routes and runs on that program; the lifecycle stays this one's
    const active = (program !== ctx.builder && (program as { [execContextKey]?: ExecContext } | undefined)?.[execContextKey]) || ctx;
    const { rootCommand, parseCommandFn, collectInterceptorsFn } = active;
    const pipelineRootInterceptors =
      active === ctx ? rootInterceptors : resolveRegisteredInterceptors(rootCommand.interceptors ?? [], factoryCache);

    // ── Phase 1: Parse ──────────────────────────────────────────────────
    const parseCtx: InterceptorParseContext = withEmit({
      input: resolvedInput,
      command: rootCommand,
      signal,
      context: pipelineContext as object,
      runtime,
      program: active.builder,
      caller,
      auth,
    });

    // Tokenizer issues (e.g. an option missing its value) surface as validation issues of the parsed command.
    let parseIssues: { command: AnyPadroneCommand; issues: StandardSchemaV1.Issue[] } | undefined;
    const coreParse = (parseCtx: InterceptorParseContext, reroutes = 0): InterceptorParseResult | Promise<InterceptorParseResult> => {
      const parseResult = parseCommandFn(parseCtx.input);
      if (parseResult.issues) parseIssues = { command: parseResult.command, issues: parseResult.issues };
      // Warn people typing commands; programmatic callers already see `deprecated` in help and types.
      if (caller === 'cli' || caller === 'repl') {
        for (const warning of getDeprecationWarnings(parseResult.command, parseResult.rawArgs)) parseCtx.runtime.error(warning);
      }
      // An unknown command goes to the `commandNotFound` handlers first (only when there are any, so this stays sync otherwise)
      const notFound = reroutes < MAX_REROUTES ? emitCommandNotFound(parseResult, rootCommand, parseCtx) : undefined;
      if (!notFound) return validateParseResult(parseResult, rootCommand);
      return notFound.then((outcome) => {
        if (outcome && 'input' in outcome) return coreParse({ ...parseCtx, input: outcome.input }, reroutes + 1);
        if (outcome) return { command: outcome.command, rawArgs: {}, positionalArgs: [] };
        return validateParseResult(parseResult, rootCommand);
      });
    };

    const parsedOrPromise = runInterceptorChain('parse', pipelineRootInterceptors, parseCtx, (c) => coreParse(c));

    // ── Phases 2 & 3 chained after parse ────────────────────────────────
    const continueAfterParse = (parsed: InterceptorParseResult) => {
      const { command } = parsed;
      pipelineState.phase = 'parse';
      // `.configure({ expose })`: e.g. built-in commands that act on the host refuse serve, MCP and tool() calls
      const refusal = exposeRefusal(command, caller);
      if (refusal) throw new ActionError(refusal, { command: command.path || command.name });
      pipelineState.rawArgs = parsed.rawArgs;
      pipelineState.positionalArgs = parsed.positionalArgs;
      const registered = collectInterceptorsFn(command);
      checkInterceptorRequirements(registered);
      const commandInterceptors = resolveRegisteredInterceptors(registered, factoryCache);
      const commandOnlyInterceptors = commandInterceptors.filter((i) => !rootInterceptorSet.has(i));
      const commandIds = new Set(commandOnlyInterceptors.map((i) => i.id).filter(Boolean));
      for (const i of rootInterceptors) if (i.id && commandIds.has(i.id)) overridden.add(i);
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
            // A `commandNotFound` handler's stand-in has nothing to validate
            if (isNotFoundCommand(validateCtx.command)) return { args: undefined, argsResult: { value: undefined } };
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
                program: active.builder as any,
                signal: executeCtx.signal,
                context: executeCtx.context,
                caller,
                prompt: createPrompt(executeCtx),
                auth: executeCtx.auth,
              });
              const result = handler(executeCtx.args as any, actionCtx);
              return { result };
            };

            pipelineState.phase = 'execute';
            const executedOrPromise = runInterceptorChain('execute', commandInterceptors, executeCtx, coreExecute);

            return thenMaybe(executedOrPromise, (e) => {
              const toResult = (result: unknown) => ({ command: command as any, args: v.args, argsResult: v.argsResult, result });

              if (e.result instanceof Promise) return e.result.then(toResult);
              return toResult(e.result);
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
          (result) => ({ command: command as any, args: undefined, argsResult: undefined, result }),
          signal,
          context,
          runtime,
          active.builder,
          caller,
          pipelineState,
          auth,
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
    (result) => ({ command: rootCommand, args: undefined, argsResult: undefined, result }),
    baseSignal,
    initialContext,
    runtime,
    ctx.builder,
    caller,
    pipelineState,
    overridden,
    auth,
  ) as any;
}
