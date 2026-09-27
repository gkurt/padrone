import { defineInterceptor } from '#src/core/interceptors.ts';
import { thenMaybe } from '#src/core/results.ts';
import type {
  AnyPadroneBuilder,
  AnyPadroneCommand,
  CommandTypesBase,
  InterceptorExecuteResult,
  InterceptorRouteContext,
} from '#src/types/index.ts';
import type { WithInterceptor } from '#src/util/type-utils.ts';
import { getRootCommand } from '#src/util/utils.ts';

// ---------------------------------------------------------------------------
// Types — minimal OTEL-compatible interfaces so we don't hard-depend on
// `@opentelemetry/api`. Users pass their real Tracer / Span instances.
// ---------------------------------------------------------------------------

/** Minimal subset of OTEL `SpanStatusCode`. */
type SpanStatusCode = 0 | 1 | 2;

/** Minimal subset of OTEL `SpanStatus`. */
type SpanStatus = { code: SpanStatusCode; message?: string };

/** Minimal subset of OTEL `Span`. */
export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): this;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): this;
  setStatus(status: SpanStatus): this;
  recordException(error: unknown): this;
  end(): void;
  spanContext(): { traceId: string; spanId: string };
}

/** Minimal subset of OTEL `Tracer`. */
export interface OtelTracer {
  startSpan(name: string): OtelSpan;
}

/** Minimal subset of OTEL `TracerProvider`. */
export interface OtelTracerProvider {
  getTracer(name: string, version?: string): OtelTracer;
}

/**
 * Minimal subset of the OTEL context API: pass `{ context, trace }` from `@opentelemetry/api`.
 * Makes the root span the active span while the action runs, so `tracing.span()` children and
 * auto-instrumented calls (HTTP, databases) are parented to it.
 */
export interface OtelContextApi {
  context: { active(): unknown; with<T>(context: unknown, fn: () => T): T };
  // `never`: accepts OTEL's `setSpan(context, span: Span)`, whose Span has more members than `OtelSpan`
  trace: { setSpan(context: unknown, span: never): unknown };
}

/** Tracing handle injected into the command context. */
export type PadroneTracer = {
  /** The underlying OTEL tracer. */
  tracer: OtelTracer;
  /** Root span covering the full command execution. */
  rootSpan: OtelSpan;
  /** Run `fn` inside a child span that is automatically ended when `fn` returns (or rejects). */
  span: <T>(name: string, fn: (span: OtelSpan) => T) => T;
};

/** Configuration for the tracing extension. */
export type PadroneTracingConfig = {
  /** OTEL `TracerProvider`. Required — there is no global fallback. */
  provider: OtelTracerProvider;
  /** Service / tracer name. Defaults to the CLI program name. */
  serviceName?: string;
  /**
   * The OTEL context API (`{ context, trace }` from `@opentelemetry/api`). Without it, `tracing.span()` children
   * and spans from instrumented libraries aren't parented to the root span.
   */
  api?: OtelContextApi;
};

/** Builder/program type after applying `padroneTracing()`. Adds `{ tracing: PadroneTracer }` to the command context. */
export type WithTracing<T> = WithInterceptor<T, { tracing: PadroneTracer }>;

// ---------------------------------------------------------------------------
// Interceptor
// ---------------------------------------------------------------------------

const OTEL_ERROR: SpanStatusCode = 2;

type ResolvedTracingConfig = { provider: OtelTracerProvider; serviceName: string | undefined; api: OtelContextApi | undefined };

function tracingInterceptor(config: ResolvedTracingConfig) {
  return defineInterceptor({ id: 'padrone:tracing', name: 'padrone:tracing', order: -1 }, () => {
    let rootSpan: OtelSpan | undefined;
    let tracer: OtelTracer | undefined;

    const { api } = config;
    /** Runs `fn` with `span` as the active span (a no-op without the context API). */
    const withSpan = <T>(span: OtelSpan, fn: () => T): T =>
      api ? api.context.with(api.trace.setSpan(api.context.active(), span as never), fn) : fn();

    const getTracer = (command: AnyPadroneCommand) =>
      (tracer ??= config.provider.getTracer(config.serviceName ?? getRootCommand(command).name));

    // Started once the command is known: in the route phase, right before the action for `run()`,
    // or in the error phase when parsing failed (named after the root command)
    const startRootSpan = (ctx: Pick<InterceptorRouteContext, 'command' | 'caller'>) => {
      if (rootSpan) return rootSpan;
      rootSpan = getTracer(ctx.command).startSpan(`cli ${ctx.command.path || ctx.command.name}`);
      rootSpan.setAttribute('padrone.command', ctx.command.path || ctx.command.name);
      rootSpan.setAttribute('padrone.caller', ctx.caller);
      return rootSpan;
    };

    return {
      route(ctx, next) {
        startRootSpan(ctx);
        return next();
      },

      execute(ctx, next) {
        const span = startRootSpan(ctx);
        const activeTracer = getTracer(ctx.command);

        const padroneTracer: PadroneTracer = {
          tracer: activeTracer,
          rootSpan: span,
          span(name, fn) {
            const child = activeTracer.startSpan(name);
            try {
              const result = withSpan(child, () => fn(child));
              if (result != null && typeof (result as any).then === 'function') {
                return (result as any).then(
                  (v: any) => {
                    child.end();
                    return v;
                  },
                  (err: unknown) => {
                    child.recordException(err);
                    child.setStatus({ code: OTEL_ERROR });
                    child.end();
                    throw err;
                  },
                );
              }
              child.end();
              return result;
            } catch (err) {
              child.recordException(err);
              child.setStatus({ code: OTEL_ERROR });
              child.end();
              throw err;
            }
          },
        };

        const runAction = () => withSpan(span, () => next({ context: { tracing: padroneTracer } }));
        if (ctx.caller !== 'run') return runAction();

        // `run()` has no error/shutdown phases: settle the root span here
        const fail = (err: unknown): never => {
          span.recordException(err);
          span.setStatus({ code: OTEL_ERROR });
          span.end();
          throw err;
        };
        const settle = (r: InterceptorExecuteResult): InterceptorExecuteResult => {
          if (!(r.result instanceof Promise)) {
            span.end();
            return r;
          }
          return {
            result: r.result.then((value: unknown) => {
              span.end();
              return value;
            }, fail),
          };
        };
        let result: InterceptorExecuteResult | Promise<InterceptorExecuteResult>;
        try {
          result = runAction();
        } catch (err) {
          return fail(err);
        }
        return result instanceof Promise ? result.then(settle, fail) : settle(result);
      },

      error(ctx, next) {
        const span = startRootSpan(ctx);
        span.recordException(ctx.error);
        span.setStatus({ code: OTEL_ERROR });
        return next();
      },

      shutdown(_ctx, next) {
        return thenMaybe(next(), (res) => {
          rootSpan?.end();
          return res;
        });
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Extension that adds OpenTelemetry tracing to command execution.
 *
 * Creates a root span for each command invocation and provides a `PadroneTracer`
 * on the command context for creating child spans in action handlers.
 *
 * When used with `padroneLogger()`, the logger automatically emits span events
 * for each log call — no extra configuration needed. The logger detects the
 * tracing context and bridges log output to span events.
 *
 * Uses minimal OTEL-compatible interfaces — pass any `TracerProvider` that
 * implements `getTracer()`. Works with `@opentelemetry/api` or compatible
 * libraries.
 *
 * Provides `{ tracing: PadroneTracer }` on the command context.
 * Access it in action handlers as `ctx.context.tracing`.
 *
 * Usage:
 * ```ts
 * import { context, trace } from '@opentelemetry/api';
 * import { createPadrone, padroneLogger } from 'padrone';
 * import { padroneTracing } from 'padrone/tracing';
 *
 * createPadrone('my-cli')
 *   .extend(padroneTracing({ provider: trace.getTracerProvider(), api: { context, trace } }))
 *   .extend(padroneLogger())
 *   .command('deploy', (c) =>
 *     c.action((_args, ctx) => {
 *       ctx.context.logger.info('deploying');  // also emits a span event
 *       ctx.context.tracing.span('build', (span) => {
 *         span.setAttribute('target', 'production');
 *       });
 *     })
 *   )
 * ```
 */
export function padroneTracing<T extends CommandTypesBase>(config: PadroneTracingConfig): (builder: T) => WithTracing<T> {
  const resolved: ResolvedTracingConfig = {
    provider: config.provider,
    serviceName: config.serviceName,
    api: config.api,
  };
  return ((builder: AnyPadroneBuilder) => builder.intercept(tracingInterceptor(resolved))) as any;
}
