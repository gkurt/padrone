import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AnyPadroneProgram, InterceptorExecuteContext, PadroneRunCommand } from '../types/index.ts';
import { ValidationError } from './errors.ts';
import { thenMaybe } from './results.ts';
import { formatIssueMessages } from './validate.ts';

/** The context the execution's caller passed (before the command's transforms), kept on its execute context for `ctx.run()`. */
export const callerContextKey: unique symbol = Symbol('padrone:caller-context');

type WithCallerContext = { [callerContextKey]?: unknown };

/** What an `api()` function returns for a `run()` result: the action's result, or a throw for invalid args or a failing action. */
export function unwrapApiResult(result: { error?: unknown; result?: unknown; argsResult?: StandardSchemaV1.Result<unknown> }): unknown {
  if (result.error !== undefined) throw result.error;
  const issues = result.argsResult?.issues;
  if (issues) throw new ValidationError(`Validation error:\n${formatIssueMessages(issues)}`, issues as any);
  return result.result;
}

export function withCallerContext<T extends object>(ctx: T, callerContext: unknown): T {
  return Object.assign(ctx, { [callerContextKey]: callerContext });
}

/**
 * `ctx.run(name, args)`: runs another command of the program like `program.run()`, with the context this execution's caller
 * passed (so the target's own context transforms apply) and its signal, and resolves to the result like an `api()` call.
 */
export function createNestedRun(program: AnyPadroneProgram, ctx: InterceptorExecuteContext): PadroneRunCommand {
  const context = (ctx as WithCallerContext)[callerContextKey];
  return (name, args) =>
    new Promise((resolve) => resolve(thenMaybe(program.run(name, args as never, { context, signal: ctx.signal }), unwrapApiResult)));
}
