import type {
  AnyPadroneCommand,
  InterceptorMeta,
  PadroneCaller,
  PadroneEmit,
  PadroneEvent,
  PadroneEventContext,
  PadroneEventHandler,
} from '../types/index.ts';
import { getRootCommand } from '../util/utils.ts';
import { collectInterceptors } from './exec.ts';

/**
 * Defines a custom event that interceptors handle with `.on(event, handler)` and code emits with `ctx.emit(event, payload)`.
 * The id should be namespaced (`'myapp:deployed'`).
 */
export function defineEvent<TPayload = void>(id: string): PadroneEvent<TPayload> {
  return { id };
}

/** Whether an interceptor runs for this caller (`callers` meta). */
export function runsForCaller(meta: Pick<InterceptorMeta, 'callers'>, caller: PadroneCaller | undefined): boolean {
  return !meta.callers || (caller !== undefined && meta.callers.includes(caller));
}

/** Handlers for `id` of the interceptors that apply to `command` for `caller`, in interceptor order. */
function eventHandlers(command: AnyPadroneCommand, caller: PadroneCaller, id: string): PadroneEventHandler[] {
  const registered = collectInterceptors(command, getRootCommand(command));
  const lastById = new Map<string, InterceptorMeta>();
  for (const { meta } of registered) if (meta.id) lastById.set(meta.id, meta);
  return registered
    .map(({ meta }) => meta)
    .filter((meta) => meta.on && Object.hasOwn(meta.on, id) && !meta.disabled && (!meta.id || lastById.get(meta.id) === meta))
    .filter((meta) => runsForCaller(meta, caller))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((meta) => meta.on![id]!);
}

/** Gives `ctx` an `emit` that runs the handlers of the interceptors on its command's chain, with `ctx` as the source. */
export function withEmit<T extends Omit<PadroneEventContext, 'emit'>>(ctx: T): T & { emit: PadroneEmit } {
  const target = ctx as T & { emit: PadroneEmit };
  target.emit = (async (event: PadroneEvent<unknown>, payload?: unknown) => {
    const { command, signal, context, runtime, program, caller, emit } = target;
    const eventCtx: PadroneEventContext = { command, signal, context, runtime, program, caller, emit };
    for (const handler of eventHandlers(command, caller, event.id)) await handler(payload, eventCtx);
  }) as PadroneEmit;
  return target;
}
