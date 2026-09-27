import { describe, expect, it } from 'bun:test';
import type { PadroneSignal } from 'padrone';
import { createPadrone, defineInterceptor, SignalError } from 'padrone';

describe('signal handling', () => {
  /** Creates a runtime with a controllable onSignal. */
  const createSignalRuntime = () => {
    let signalCallback: ((signal: PadroneSignal) => void) | undefined;
    return {
      runtime: {
        onSignal: (cb: (signal: PadroneSignal) => void) => {
          signalCallback = cb;
          return () => {
            signalCallback = undefined;
          };
        },
      },
      sendSignal: (signal: PadroneSignal) => signalCallback?.(signal),
      isSubscribed: () => signalCallback !== undefined,
    };
  };

  describe('AbortSignal in action context', () => {
    it('should provide an AbortSignal to action handlers', () => {
      let receivedSignal: AbortSignal | undefined;
      const program = createPadrone('test').command('cmd', (c) =>
        c.action((_args, ctx) => {
          receivedSignal = ctx.signal;
          return 'ok';
        }),
      );

      program.eval('cmd');
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal!.aborted).toBe(false);
    });

    it('should abort the signal when a process signal is received', async () => {
      const { runtime, sendSignal } = createSignalRuntime();
      let receivedSignal: AbortSignal | undefined;

      const program = createPadrone('test')
        .runtime(runtime)
        .command('cmd', (c) =>
          c.action((_args, ctx) => {
            receivedSignal = ctx.signal;
            sendSignal('SIGINT');
            return 'ok';
          }),
        );

      const result = await program.eval('cmd');
      expect(receivedSignal!.aborted).toBe(true);
      expect(receivedSignal!.reason).toBeInstanceOf(SignalError);
      expect(receivedSignal!.reason.signal).toBe('SIGINT');
      expect(result.signal).toBe('SIGINT');
      expect(result.exitCode).toBe(130);
    });

    it('should ignore duplicate signal delivery', async () => {
      const { runtime, sendSignal } = createSignalRuntime();
      let abortCount = 0;

      const program = createPadrone('test')
        .runtime(runtime)
        .command('cmd', (c) =>
          c.action((_args, ctx) => {
            ctx.signal.addEventListener('abort', () => abortCount++);
            // Simulate duplicate SIGINT delivery (some runtimes do this)
            sendSignal('SIGINT');
            sendSignal('SIGINT');
            return 'ok';
          }),
        );

      const result = await program.eval('cmd');
      expect(abortCount).toBe(1);
      expect(result.signal).toBe('SIGINT');
    });

    it('should set correct exit codes for different signals', async () => {
      for (const [sig, code] of [
        ['SIGINT', 130],
        ['SIGTERM', 143],
        ['SIGHUP', 129],
      ] as const) {
        const { runtime, sendSignal } = createSignalRuntime();

        const program = createPadrone('test')
          .runtime(runtime)
          .command('cmd', (c) =>
            c.action((_args, _ctx) => {
              sendSignal(sig);
              return 'ok';
            }),
          );

        const result = await program.eval('cmd');
        expect(result.signal).toBe(sig);
        expect(result.exitCode).toBe(code);
      }
    });
  });

  describe('AbortSignal in interceptor contexts', () => {
    it('should provide signal to all interceptor phases', async () => {
      const { runtime, sendSignal: _sendSignal } = createSignalRuntime();
      const signals: Record<string, AbortSignal> = {};

      const interceptor = defineInterceptor({ name: 'signal-checker' }, () => ({
        start: (ctx, next) => {
          signals.start = ctx.signal;
          return next();
        },
        parse: (ctx, next) => {
          signals.parse = ctx.signal;
          return next();
        },
        validate: (ctx, next) => {
          signals.validate = ctx.signal;
          return next();
        },
        execute: (ctx, next) => {
          signals.execute = ctx.signal;
          return next();
        },
        shutdown: (ctx, next) => {
          signals.shutdown = ctx.signal;
          return next();
        },
      }));

      const program = createPadrone('test')
        .runtime(runtime)
        .intercept(interceptor)
        .command('cmd', (c) => c.action(() => 'ok'));

      await program.eval('cmd');

      expect(signals.start).toBeInstanceOf(AbortSignal);
      expect(signals.parse).toBeInstanceOf(AbortSignal);
      expect(signals.validate).toBeInstanceOf(AbortSignal);
      expect(signals.execute).toBeInstanceOf(AbortSignal);
      expect(signals.shutdown).toBeInstanceOf(AbortSignal);

      // All should be the same signal instance
      expect(signals.start).toBe(signals.parse);
      expect(signals.parse).toBe(signals.validate);
      expect(signals.validate).toBe(signals.execute);
      expect(signals.execute).toBe(signals.shutdown);
    });
  });

  describe('signal cleanup', () => {
    it('should unsubscribe from signals after execution completes', () => {
      const { runtime, isSubscribed } = createSignalRuntime();

      const program = createPadrone('test')
        .runtime(runtime)
        .command('cmd', (c) => c.action(() => 'ok'));

      program.eval('cmd');
      expect(isSubscribed()).toBe(false);
    });

    it('should unsubscribe from signals after async execution completes', async () => {
      const { runtime, isSubscribed } = createSignalRuntime();

      const program = createPadrone('test')
        .runtime(runtime)
        .async()
        .command('cmd', (c) => c.action(() => 'ok'));

      await program.eval('cmd');
      expect(isSubscribed()).toBe(false);
    });

    it('should unsubscribe from signals for builtin commands', () => {
      const { runtime, isSubscribed } = createSignalRuntime();

      const program = createPadrone('test')
        .runtime(runtime)
        .configure({ version: '1.0.0' })
        .command('cmd', (c) => c.action(() => 'ok'));

      program.eval('--help');
      expect(isSubscribed()).toBe(false);

      program.eval('--version');
      expect(isSubscribed()).toBe(false);
    });
  });

  describe('shutdown interceptor integration', () => {
    it('should run shutdown interceptors when action throws after signal', async () => {
      const { runtime, sendSignal } = createSignalRuntime();
      let shutdownRan = false;
      let shutdownError: unknown;

      const program = createPadrone('test')
        .runtime(runtime)
        .intercept({ name: 'shutdown-tracker' }, () => ({
          shutdown: (ctx, next) => {
            shutdownRan = true;
            shutdownError = ctx.error;
            return next();
          },
        }))
        .command('cmd', (c) =>
          c.action((_args, ctx) => {
            sendSignal('SIGTERM');
            // Simulate an action that checks the signal
            if (ctx.signal.aborted) throw new Error('aborted');
            return 'ok';
          }),
        );

      const result = await program.eval('cmd');
      expect(shutdownRan).toBe(true);
      expect(shutdownError).toBeInstanceOf(Error);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.signal).toBe('SIGTERM');
      expect(result.exitCode).toBe(143);
    });
  });

  describe('SignalError', () => {
    it('should create SignalError with correct properties', () => {
      const err = new SignalError('SIGINT');
      expect(err.name).toBe('SignalError');
      expect(err.signal).toBe('SIGINT');
      expect(err.exitCode).toBe(130);
      expect(err.message).toBe('Process interrupted by SIGINT');
    });
  });

  describe('no signal runtime', () => {
    it('should work without onSignal (signal stays non-aborted)', () => {
      let receivedSignal: AbortSignal | undefined;

      const program = createPadrone('test')
        .runtime({ onSignal: undefined })
        .command('cmd', (c) =>
          c.action((_args, ctx) => {
            receivedSignal = ctx.signal;
            return 'ok';
          }),
        );

      const result = program.eval('cmd');
      expect(result.result).toBe('ok');
      expect(receivedSignal!.aborted).toBe(false);
      expect(result.signal).toBeUndefined();
    });
  });
});

describe('caller signal', () => {
  it('aborts the action signal when the eval() signal aborts', async () => {
    const controller = new AbortController();
    let actionSignal: AbortSignal | undefined;
    const program = createPadrone('test').command('wait', (c) =>
      c.async().action(async (_args, ctx) => {
        actionSignal = ctx.signal;
        controller.abort('stop');
        return ctx.signal.aborted;
      }),
    );

    const result = await program.eval('wait', { signal: controller.signal, runtime: { output: () => {} } });
    expect(await result.result).toBe(true);
    expect(actionSignal!.reason).toBe('stop');
  });

  it('starts aborted when the signal already is', () => {
    const program = createPadrone('test').command('check', (c) => c.action((_args, ctx) => ctx.signal.aborted));
    expect(program.eval('check', { signal: AbortSignal.abort(), runtime: { output: () => {} } }).result).toBe(true);
  });

  it('is passed to run()', () => {
    const program = createPadrone('test').command('check', (c) => c.action((_args, ctx) => ctx.signal.aborted));
    expect(program.run('check', undefined, { signal: AbortSignal.abort() }).result).toBe(true);
  });

  it('is used as is when the signal builtin is disabled', () => {
    const signal = AbortSignal.abort();
    const program = createPadrone('test', { builtins: { signal: false } }).command('check', (c) => c.action((_args, ctx) => ctx.signal));
    expect(program.eval('check', { signal, runtime: { output: () => {} } }).result).toBe(signal);
  });
});
