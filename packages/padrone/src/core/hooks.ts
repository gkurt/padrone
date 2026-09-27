import { createPrompt } from '../feature/prompt.ts';
import type { InterceptorExecuteContext, PadroneHookContext, PadroneHookName, RegisteredInterceptor } from '../types/index.ts';
import { withEmit } from './events.ts';
import { isNotFoundCommand } from './not-found.ts';
import { thenMaybe } from './results.ts';

/** Inside every other execute interceptor (e.g. `padroneConfirm()` asks first), right around the action. */
const HOOK_ORDER = 10_000;

type HookHandler = (ctx: PadroneHookContext, result?: unknown) => unknown;

function hookContext(ctx: InterceptorExecuteContext): PadroneHookContext {
  const { runtime, command, program, signal, context, caller, args, dryRun } = ctx;
  return withEmit({ runtime, command, program, signal, context, caller, args, prompt: createPrompt(ctx), ...(dryRun && { dryRun }) });
}

/**
 * The interceptor behind `.hook(name, handler)`: an execute handler on the command, inherited by its subcommands, so an
 * ancestor's `preAction` runs before a descendant's and its `postAction` after. An async hook makes the result a promise,
 * as an async action does, instead of making the run async.
 */
export function hookInterceptor(name: PadroneHookName, handler: HookHandler): RegisteredInterceptor {
  return {
    meta: { name: `padrone:${name}`, order: HOOK_ORDER },
    factory: () => ({
      execute(ctx, next) {
        if (isNotFoundCommand(ctx.command)) return next();
        if (name === 'preAction') {
          const pending = handler(hookContext(ctx));
          if (!(pending instanceof Promise)) return next();
          return { result: pending.then(() => thenMaybe(next(), (e) => e.result)) };
        }
        return thenMaybe(next(), (e) => {
          const after = (result: unknown) => thenMaybe(handler(hookContext(ctx), result), () => result);
          return { result: e.result instanceof Promise ? e.result.then(after) : after(e.result) };
        });
      },
    }),
  };
}
