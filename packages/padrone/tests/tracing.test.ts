import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneLogger } from 'padrone';
import type { OtelSpan, OtelTracer, OtelTracerProvider } from 'padrone/tracing';
import { padroneTracing } from 'padrone/tracing';

// ---------------------------------------------------------------------------
// Mock OTEL primitives
// ---------------------------------------------------------------------------

type SpanEvent = { name: string; attributes?: Record<string, string | number | boolean> };

function createMockSpan(name: string) {
  const attributes: Record<string, string | number | boolean> = {};
  const events: SpanEvent[] = [];
  let status: { code: number; message?: string } | undefined;
  let exception: unknown;
  let ended = false;

  const span: OtelSpan & {
    _name: string;
    _attributes: typeof attributes;
    _events: typeof events;
    _status: typeof status;
    _exception: typeof exception;
    _ended: boolean;
  } = {
    _name: name,
    _attributes: attributes,
    _events: events,
    _status: status,
    _exception: exception,
    _ended: ended,
    setAttribute(key, value) {
      attributes[key] = value;
      return this;
    },
    addEvent(evtName, attrs) {
      events.push({ name: evtName, attributes: attrs });
      return this;
    },
    setStatus(s) {
      status = s;
      span._status = s;
      return this;
    },
    recordException(err) {
      exception = err;
      span._exception = err;
      return this;
    },
    end() {
      ended = true;
      span._ended = true;
    },
    spanContext() {
      return { traceId: 'abc123', spanId: 'def456' };
    },
  };

  return span;
}

function createMockProvider() {
  const spans: ReturnType<typeof createMockSpan>[] = [];
  let tracerName: string | undefined;

  const tracer: OtelTracer = {
    startSpan(name: string) {
      const span = createMockSpan(name);
      spans.push(span);
      return span;
    },
  };

  const provider: OtelTracerProvider = {
    getTracer(name: string) {
      tracerName = name;
      return tracer;
    },
  };

  return { provider, spans, getTracerName: () => tracerName };
}

function createCapture() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: {
      output: (...args: unknown[]) => output.push(args.map(String).join(' ')),
      error: (text: string) => errors.push(text),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tracing', () => {
  it('should inject tracing into context', () => {
    const { provider } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          expect(ctx.context.tracing).toBeDefined();
          expect(typeof ctx.context.tracing.span).toBe('function');
          expect(ctx.context.tracing.tracer).toBeDefined();
          expect(ctx.context.tracing.rootSpan).toBeDefined();
          return 'ok';
        }),
      );

    const result = program.eval('test');
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('ok');
  });

  it('should create a root span with the command name', () => {
    const { provider, spans } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('deploy', (c) => c.action(() => 'done'));

    program.eval('deploy');
    expect(spans[0]!._name).toBe('cli deploy');
  });

  it('should end root span on shutdown', () => {
    const { provider, spans } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('test', (c) => c.action(() => 'ok'));

    program.eval('test');
    expect(spans[0]!._ended).toBe(true);
  });

  it('should record error and set error status on failure', () => {
    const { provider, spans } = createMockProvider();
    const { runtime } = createCapture();
    const error = new Error('boom');
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('fail', (c) =>
        c.action(() => {
          throw error;
        }),
      );

    const result = program.eval('fail');
    expect(result.error).toBeDefined();
    const rootSpan = spans[0]!;
    expect(rootSpan._exception).toBe(error);
    expect(rootSpan._status).toEqual({ code: 2 });
    expect(rootSpan._ended).toBe(true);
  });

  it('should record errors thrown while parsing in a root span', () => {
    const { provider, spans } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('test', (c) => c.action(() => 'ok'));

    const result = program.eval('nope');
    expect(result.error).toBeDefined();
    expect(spans).toHaveLength(1);
    expect(spans[0]!._name).toBe('cli app');
    expect(spans[0]!._exception).toBe(result.error);
    expect(spans[0]!._ended).toBe(true);
  });

  it('should allow creating child spans via tracing.span()', () => {
    const { provider, spans } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.tracing.span('child-work', (span) => {
            span.setAttribute('key', 'value');
          });
          return 'ok';
        }),
      );

    program.eval('test');
    const childSpan = spans.find((s) => s._name === 'child-work');
    expect(childSpan).toBeDefined();
    expect(childSpan!._attributes.key).toBe('value');
    expect(childSpan!._ended).toBe(true);
  });

  it('should end child span and record exception on sync throw', () => {
    const { provider, spans } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          try {
            ctx.context.tracing.span('bad', () => {
              throw new Error('child-error');
            });
          } catch {
            // swallow
          }
          return 'ok';
        }),
      );

    program.eval('test');
    const child = spans.find((s) => s._name === 'bad');
    expect(child).toBeDefined();
    expect(child!._exception).toBeInstanceOf(Error);
    expect(child!._status).toEqual({ code: 2 });
    expect(child!._ended).toBe(true);
  });

  it('should handle async child spans', async () => {
    const { provider, spans } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('test', (c) =>
        c.action(async (_args, ctx) => {
          const val = await ctx.context.tracing.span('async-work', async (span) => {
            span.setAttribute('async', true);
            return 42;
          });
          return val;
        }),
      );

    const result = await program.eval('test');
    expect(await result.result).toBe(42);
    const child = spans.find((s) => s._name === 'async-work');
    expect(child).toBeDefined();
    expect(child!._attributes.async).toBe(true);
    expect(child!._ended).toBe(true);
  });

  it('should handle async child span rejection', async () => {
    const { provider, spans } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('test', (c) =>
        c.action(async (_args, ctx) => {
          try {
            await ctx.context.tracing.span('async-bad', async () => {
              throw new Error('async-fail');
            });
          } catch {
            // swallow
          }
          return 'recovered';
        }),
      );

    const result = await program.eval('test');
    expect(await result.result).toBe('recovered');
    const child = spans.find((s) => s._name === 'async-bad');
    expect(child!._exception).toBeInstanceOf(Error);
    expect(child!._status).toEqual({ code: 2 });
    expect(child!._ended).toBe(true);
  });

  it('should use custom serviceName for tracer', () => {
    const { provider, getTracerName } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider, serviceName: 'my-service' }))
      .command('test', (c) => c.action(() => 'ok'));

    program.eval('test');
    expect(getTracerName()).toBe('my-service');
  });

  it('should default serviceName to program name', () => {
    const { provider, getTracerName } = createMockProvider();
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneTracing({ provider }))
      .command('test', (c) => c.action(() => 'ok'));

    program.eval('test');
    expect(getTracerName()).toBe('app');
  });

  describe('logger bridge', () => {
    it('should add span events for logger calls when logger is present', () => {
      const { provider, spans } = createMockProvider();
      const { runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneTracing({ provider }))
        .extend(padroneLogger({ level: 'trace' }))
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('hello world');
            ctx.context.logger.warn('be careful');
            return 'ok';
          }),
        );

      program.eval('test');
      const rootSpan = spans[0]!;
      const logEvents = rootSpan._events.filter((e) => e.name === 'log');
      expect(logEvents).toHaveLength(2);
      expect(logEvents[0]!.attributes).toEqual({ 'log.level': 'info', 'log.message': 'hello world' });
      expect(logEvents[1]!.attributes).toEqual({ 'log.level': 'warn', 'log.message': 'be careful' });
    });

    it('should still output to runtime when bridged', () => {
      const { provider } = createMockProvider();
      const { output, errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneTracing({ provider }))
        .extend(padroneLogger({ level: 'info' }))
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('visible');
            ctx.context.logger.error('also visible');
          }),
        );

      program.eval('test');
      expect(output).toEqual([]);
      expect(errors).toEqual(['[INFO] visible', '[ERROR] also visible']);
    });

    it('should bridge child logger calls', () => {
      const { provider, spans } = createMockProvider();
      const { runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneTracing({ provider }))
        .extend(padroneLogger({ level: 'info' }))
        .command('test', (c) =>
          c.action((_args, ctx) => {
            const child = ctx.context.logger.child('db');
            child.info('connected');
          }),
        );

      program.eval('test');
      const rootSpan = spans[0]!;
      const logEvents = rootSpan._events.filter((e) => e.name === 'log');
      expect(logEvents).toHaveLength(1);
      expect(logEvents[0]!.attributes!['log.message']).toBe('connected');
    });

    it('should not bridge when tracing is not registered', () => {
      const { runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger({ level: 'info' }))
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('no tracing');
            return 'ok';
          }),
        );

      const result = program.eval('test');
      expect(result.result).toBe('ok');
    });

    it('should work without logger extension', () => {
      const { provider, spans } = createMockProvider();
      const { runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneTracing({ provider }))
        .command('test', (c) => c.action(() => 'ok'));

      const result = program.eval('test');
      expect(result.result).toBe('ok');
      const rootSpan = spans[0]!;
      expect(rootSpan._events).toHaveLength(0);
    });
  });
});

describe('padroneTracing with run() and nested commands', () => {
  it('traces run(), which has no start or shutdown phase', async () => {
    const { provider, spans, getTracerName } = createMockProvider();
    const program = createPadrone('test-cli')
      .extend(padroneTracing({ provider }))
      .command('deploy', (c) => c.action(() => 'done'));

    const result = await program.run('deploy', undefined);
    expect(result.result).toBe('done');
    expect(getTracerName()).toBe('test-cli');
    expect(spans[0]!._name).toBe('cli deploy');
    expect(spans[0]!._ended).toBe(true);
  });

  it('records a failing run() on the root span', async () => {
    const { provider, spans } = createMockProvider();
    const program = createPadrone('test-cli')
      .extend(padroneTracing({ provider }))
      .command('deploy', (c) =>
        c.action(() => {
          throw new Error('nope');
        }),
      );

    const result = await program.run('deploy', undefined);
    expect((result.error as Error).message).toBe('nope');
    expect(spans[0]!._status).toEqual({ code: 2 });
    expect(spans[0]!._ended).toBe(true);
  });

  it('names the root span by the command path', async () => {
    const { provider, spans } = createMockProvider();
    const program = createPadrone('test-cli')
      .extend(padroneTracing({ provider }))
      .command('db', (c) => c.command('migrate', (m) => m.action(() => 'ok')));

    await program.eval('db migrate');
    expect(spans[0]!._name).toBe('cli db migrate');
    expect(spans[0]!._attributes).toEqual({ 'padrone.command': 'db migrate', 'padrone.caller': 'eval' });
  });
});

describe('padroneTracing context propagation', () => {
  // A synchronous stand-in for the OTEL context manager: `with` makes a context active while `fn` runs
  function createContextApi() {
    type Ctx = { span?: OtelSpan };
    let active: Ctx = {};
    return {
      context: {
        active: () => active,
        with<T>(ctx: unknown, fn: () => T): T {
          const previous = active;
          active = ctx as Ctx;
          try {
            return fn();
          } finally {
            active = previous;
          }
        },
      },
      trace: { setSpan: (ctx: unknown, span: never) => ({ ...(ctx as Ctx), span }) },
      activeSpan: () => active.span,
    };
  }

  it('parents child spans to the root span, and nested spans to their parent', async () => {
    const api = createContextApi();
    const parents = new Map<string, string | undefined>();
    const provider: OtelTracerProvider = {
      getTracer: () => ({
        startSpan(name: string) {
          parents.set(name, (api.activeSpan() as { _name?: string } | undefined)?._name);
          const span = {
            _name: name,
            setAttribute: () => span,
            addEvent: () => span,
            setStatus: () => span,
            recordException: () => span,
            end() {},
            spanContext: () => ({ traceId: 't', spanId: name }),
          };
          return span as unknown as OtelSpan;
        },
      }),
    };

    const program = createPadrone('test-cli')
      .extend(padroneTracing({ provider, api }))
      .command('deploy', (c) =>
        c.action((_args, ctx) => {
          ctx.context.tracing.span('build', () => ctx.context.tracing.span('compile', () => 'ok'));
          return 'done';
        }),
      );

    await program.eval('deploy');
    expect(parents.get('cli deploy')).toBeUndefined();
    expect(parents.get('build')).toBe('cli deploy');
    expect(parents.get('compile')).toBe('build');
  });
});
