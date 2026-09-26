import { describe, expect, it } from 'bun:test';
import type { PadroneInput } from 'padrone';
import { createPadrone, defineInterceptor } from 'padrone';
import * as z from 'zod/v4';

describe('interceptors', () => {
  const makeProgram = () =>
    createPadrone('test')
      .command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      )
      .command('add', (c) => c.arguments(z.object({ a: z.coerce.number(), b: z.coerce.number() })).action((args) => args.a + args.b));

  describe('registration and chaining', () => {
    it('should return a new program for chaining (immutable builder)', () => {
      const program = makeProgram();
      const result = program.intercept({ name: 'test' }, () => ({}));
      expect(result).not.toBe(program);
      // Should still be usable
      expect(result.eval('greet World').result).toBe('Hello, World!');
    });

    it('should allow multiple interceptors via chaining', () => {
      const log: string[] = [];
      const result = makeProgram()
        .intercept({ name: 'a' }, () => ({
          execute: (_ctx, next) => {
            log.push('a');
            return next();
          },
        }))
        .intercept({ name: 'b' }, () => ({
          execute: (_ctx, next) => {
            log.push('b');
            return next();
          },
        }));

      result.eval('greet World');
      expect(log).toEqual(['a', 'b']);
    });
  });

  describe('execute phase', () => {
    it('should intercept handler execution', () => {
      const log: string[] = [];
      const interceptor = defineInterceptor({ name: 'logger' }, () => ({
        execute: (ctx, next) => {
          log.push(`before:${ctx.command.path}`);
          const result = next();
          log.push('after');
          return result;
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet World');

      expect(result.result).toBe('Hello, World!');
      expect(log).toEqual(['before:greet', 'after']);
    });

    it('should allow short-circuiting (not calling next)', () => {
      const interceptor = defineInterceptor({ name: 'blocker' }, () => ({
        execute: (_ctx, _next) => {
          return { result: 'blocked' };
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet World');

      expect(result.result).toBe('blocked');
    });

    it('should allow transforming the result', () => {
      const interceptor = defineInterceptor({ name: 'upper' }, () => ({
        execute: (_ctx, next) => {
          const result = next();
          if (result instanceof Promise) return result;
          return { result: String(result.result).toUpperCase() };
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet World');

      expect(result.result).toBe('HELLO, WORLD!');
    });

    it('should allow error handling via try/catch', () => {
      const errorProgram = createPadrone('test')
        .command('fail', (c) =>
          c.action(() => {
            throw new Error('boom');
          }),
        )
        .intercept({ name: 'error-handler' }, () => ({
          execute: (_ctx, next) => {
            try {
              return next();
            } catch {
              return { result: 'caught' };
            }
          },
        }));

      const result = errorProgram.eval('fail');
      expect(result.result! as string).toBe('caught');
    });
  });

  describe('parse phase', () => {
    it('should provide input and root command in context', () => {
      let capturedInput: PadroneInput | undefined;
      let capturedCommandName: string | undefined;

      const interceptor = defineInterceptor({ name: 'parse-spy' }, () => ({
        parse: (ctx, next) => {
          capturedInput = ctx.input;
          capturedCommandName = ctx.command.name;
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(capturedInput).toBe('greet World');
      expect(capturedCommandName).toBe('test');
    });

    it('should allow modifying input before routing', () => {
      const interceptor = defineInterceptor({ name: 'alias' }, () => ({
        parse: (ctx, next) => {
          // Rewrite input
          if (ctx.input === 'hi World') {
            ctx.input = 'greet World';
          }
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('hi World');

      expect(result.result! as string).toBe('Hello, World!');
    });
  });

  describe('validate phase', () => {
    it('should provide resolved command and raw args in context', () => {
      let capturedCommandPath: string | undefined;
      let capturedRawArgs: Record<string, unknown> | undefined;

      const interceptor = defineInterceptor({ name: 'validate-spy' }, () => ({
        validate: (ctx, next) => {
          capturedCommandPath = ctx.command.path;
          capturedRawArgs = { ...ctx.rawArgs };
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.eval('add --a=2 --b=3');

      expect(capturedCommandPath).toBe('add');
      expect(capturedRawArgs).toEqual({ a: '2', b: '3' });
    });

    it('should allow injecting args before validation', () => {
      const interceptor = defineInterceptor({ name: 'default-name' }, () => ({
        validate: (ctx, next) => {
          if (ctx.command.path === 'greet' && !ctx.rawArgs.name && ctx.positionalArgs.length === 0) {
            ctx.positionalArgs = ['DefaultUser'];
          }
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet');

      expect(result.result).toBe('Hello, DefaultUser!');
    });
  });

  describe('ordering', () => {
    it('should execute first-registered as outermost (before others, after others on return)', () => {
      const log: string[] = [];

      const interceptorA = defineInterceptor({ name: 'A' }, () => ({
        execute: (_ctx, next) => {
          log.push('A:before');
          const result = next();
          log.push('A:after');
          return result;
        },
      }));

      const interceptorB = defineInterceptor({ name: 'B' }, () => ({
        execute: (_ctx, next) => {
          log.push('B:before');
          const result = next();
          log.push('B:after');
          return result;
        },
      }));

      const program = makeProgram().intercept(interceptorA).intercept(interceptorB);
      program.eval('greet World');

      expect(log).toEqual(['A:before', 'B:before', 'B:after', 'A:after']);
    });

    it('should respect order parameter (lower = outermost)', () => {
      const log: string[] = [];

      const innerInterceptor = defineInterceptor({ name: 'inner', order: 10 }, () => ({
        execute: (_ctx, next) => {
          log.push('inner:before');
          const result = next();
          log.push('inner:after');
          return result;
        },
      }));

      const outerInterceptor = defineInterceptor({ name: 'outer', order: -10 }, () => ({
        execute: (_ctx, next) => {
          log.push('outer:before');
          const result = next();
          log.push('outer:after');
          return result;
        },
      }));

      // Register inner first, but outer has lower order so it should be outermost
      const program = makeProgram().intercept(innerInterceptor).intercept(outerInterceptor);
      program.eval('greet World');

      expect(log).toEqual(['outer:before', 'inner:before', 'inner:after', 'outer:after']);
    });

    it('should preserve registration order for same order value', () => {
      const log: string[] = [];

      const makeInterceptor = (name: string) =>
        defineInterceptor({ name, order: 0 }, () => ({
          execute: (_ctx, next) => {
            log.push(`${name}:before`);
            const result = next();
            log.push(`${name}:after`);
            return result;
          },
        }));

      const program = makeProgram().intercept(makeInterceptor('A')).intercept(makeInterceptor('B')).intercept(makeInterceptor('C'));
      program.eval('greet World');

      expect(log).toEqual(['A:before', 'B:before', 'C:before', 'C:after', 'B:after', 'A:after']);
    });
  });

  describe('command filtering', () => {
    it('should allow interceptors to skip based on command path', () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'greet-only' }, () => ({
        execute: (ctx, next) => {
          if (ctx.command.path !== 'greet') return next();
          log.push(`intercepted:${ctx.command.path}`);
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);

      program.eval('greet World');
      program.eval('add --a=1 --b=2');

      expect(log).toEqual(['intercepted:greet']);
    });
  });

  describe('run() integration', () => {
    it('should apply execute interceptors to run()', () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'run-spy' }, () => ({
        execute: (ctx, next) => {
          log.push(`execute:${ctx.command.path}`);
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.run('greet', { name: 'World' });

      expect(result.result).toBe('Hello, World!');
      expect(log).toEqual(['execute:greet']);
    });
  });

  describe('parse() integration', () => {
    it('should not run interceptors during parse()', () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'parse-spy' }, () => ({
        parse: (ctx, next) => {
          log.push(`parse:${ctx.input}`);
          return next();
        },
        validate: (ctx, next) => {
          log.push(`validate:${ctx.command.path}`);
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.parse('greet World');

      expect(log).toEqual([]);
    });
  });

  describe('sync preservation', () => {
    it('should stay sync when all interceptors are sync', () => {
      const interceptor = defineInterceptor({ name: 'sync-interceptor' }, () => ({
        execute: (_ctx, next) => next(),
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet World');

      // Should not be a Promise
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.result).toBe('Hello, World!');
    });

    it('should become async when an interceptor returns a Promise', async () => {
      const interceptor = defineInterceptor({ name: 'async-interceptor' }, () => ({
        execute: async (_ctx, next) => {
          const result = await next();
          return result;
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const resultOrPromise = program.eval('greet World');

      expect(resultOrPromise).toBeInstanceOf(Promise);
      const result = await resultOrPromise;
      expect(result.result).toBe('Hello, World!');
    });
  });

  describe('no interceptors (passthrough)', () => {
    it('should work normally without any interceptors', () => {
      const program = makeProgram();
      const result = program.eval('greet World');
      expect(result.result).toBe('Hello, World!');
    });

    it('should work with interceptors that have no handlers for the phase', () => {
      const interceptor = defineInterceptor({ name: 'empty' }, () => ({
        // No parse, validate, or execute handlers
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet World');
      expect(result.result).toBe('Hello, World!');
    });
  });

  describe('multiple phases in one interceptor', () => {
    it('should intercept all configured phases', () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'full-lifecycle' }, () => ({
        parse: (ctx, next) => {
          log.push(`parse:${ctx.input}`);
          return next();
        },
        validate: (ctx, next) => {
          log.push(`validate:${ctx.command.path}`);
          return next();
        },
        execute: (ctx, next) => {
          log.push(`execute:${ctx.command.path}`);
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(log).toEqual(['parse:greet World', 'validate:greet', 'execute:greet']);
    });
  });

  describe('args mutation in execute context', () => {
    it('should allow modifying args before handler runs', () => {
      const interceptor = defineInterceptor({ name: 'args-mutator' }, () => ({
        execute: (ctx, next) => {
          (ctx.args as Record<string, unknown>).name = 'Overridden';
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet World');

      expect(result.result).toBe('Hello, Overridden!');
    });
  });

  describe('start phase', () => {
    it('should run before parse phase', () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'lifecycle' }, () => ({
        start: (_ctx, next) => {
          log.push('start');
          return next();
        },
        parse: (_ctx, next) => {
          log.push('parse');
          return next();
        },
        execute: (_ctx, next) => {
          log.push('execute');
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(log).toEqual(['start', 'parse', 'execute']);
    });

    it('should provide input and root command in context', () => {
      let capturedInput: PadroneInput | undefined;
      let capturedCommandName: string | undefined;

      const interceptor = defineInterceptor({ name: 'start-spy' }, () => ({
        start: (ctx, next) => {
          capturedInput = ctx.input;
          capturedCommandName = ctx.command.name;
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(capturedInput).toBe('greet World');
      expect(capturedCommandName).toBe('test');
    });

    it('should allow short-circuiting the pipeline', () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'blocker' }, () => ({
        start: (_ctx, _next) => {
          log.push('start:blocked');
          return { command: {}, result: 'blocked' };
        },
        parse: (_ctx, next) => {
          log.push('parse');
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet World');

      expect(result.result).toBe('blocked');
      expect(log).toEqual(['start:blocked']);
    });

    it('should share closure state with other phases', () => {
      const stateLog: Record<string, unknown>[] = [];

      const interceptor = defineInterceptor({ name: 'state-test' }, () => {
        let initialized = false;
        return {
          start: (_ctx, next) => {
            initialized = true;
            return next();
          },
          execute: (_ctx, next) => {
            stateLog.push({ initialized });
            return next();
          },
        };
      });

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(stateLog).toEqual([{ initialized: true }]);
    });

    it('should support async start hooks', async () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'async-start' }, () => ({
        start: async (_ctx, next) => {
          log.push('async-start');
          const result = await next();
          log.push('async-start:after');
          return result;
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = await program.eval('greet World');

      expect(result.result).toBe('Hello, World!');
      expect(log).toEqual(['async-start', 'async-start:after']);
    });

    it('should not run for parse() calls', () => {
      let startCalled = false;

      const interceptor = defineInterceptor({ name: 'start-spy' }, () => ({
        start: (_ctx, next) => {
          startCalled = true;
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.parse('greet World');

      expect(startCalled).toBe(false);
    });

    it('should not run for run() calls', () => {
      let startCalled = false;

      const interceptor = defineInterceptor({ name: 'start-spy' }, () => ({
        start: (_ctx, next) => {
          startCalled = true;
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.run('greet', { name: 'World' });

      expect(startCalled).toBe(false);
    });
  });

  describe('error phase', () => {
    it('should catch errors from the pipeline', () => {
      const errorProgram = createPadrone('test')
        .command('fail', (c) =>
          c.action(() => {
            throw new Error('boom');
          }),
        )
        .intercept({ name: 'error-handler' }, () => ({
          error: (ctx) => {
            return { error: undefined, result: `caught: ${(ctx.error as Error).message}` };
          },
        }));

      const result = errorProgram.eval('fail');
      expect(result.result! as string).toBe('caught: boom');
    });

    it('should allow transforming errors', () => {
      const errorProgram = createPadrone('test')
        .command('fail', (c) =>
          c.action(() => {
            throw new Error('original');
          }),
        )
        .intercept({ name: 'transformer' }, () => ({
          error: (ctx, _next) => {
            return { error: new Error(`transformed: ${(ctx.error as Error).message}`) };
          },
        }));

      const result = errorProgram.eval('fail');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('transformed: original');
    });

    it('should pass to next error handler via next()', () => {
      const log: string[] = [];

      const errorProgram = createPadrone('test')
        .command('fail', (c) =>
          c.action(() => {
            throw new Error('boom');
          }),
        )
        .intercept({ name: 'outer' }, () => ({
          error: (_ctx, next) => {
            log.push('outer:before');
            const result = next();
            log.push('outer:after');
            return result;
          },
        }))
        .intercept({ name: 'inner' }, () => ({
          error: (_ctx, _next) => {
            log.push('inner:suppress');
            return { error: undefined, result: 'suppressed' };
          },
        }));

      const result = errorProgram.eval('fail');
      expect(result.result! as string).toBe('suppressed');
      expect(log).toEqual(['outer:before', 'inner:suppress', 'outer:after']);
    });

    it('should re-throw if no error handler suppresses', () => {
      const log: string[] = [];

      const errorProgram = createPadrone('test')
        .command('fail', (c) =>
          c.action(() => {
            throw new Error('boom');
          }),
        )
        .intercept({ name: 'logger' }, () => ({
          error: (ctx, next) => {
            log.push(`logged: ${(ctx.error as Error).message}`);
            return next();
          },
        }));

      const result = errorProgram.eval('fail');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('boom');
      expect(log).toEqual(['logged: boom']);
    });

    it('should not run when pipeline succeeds', () => {
      let errorCalled = false;

      const program = makeProgram().intercept({ name: 'error-spy' }, () => ({
        error: (_ctx, next) => {
          errorCalled = true;
          return next();
        },
      }));

      program.eval('greet World');
      expect(errorCalled).toBe(false);
    });

    it('should handle async errors', async () => {
      const errorProgram = createPadrone('test')
        .command('fail', (c) =>
          c.action(async () => {
            throw new Error('async-boom');
          }),
        )
        .intercept({ name: 'error-handler' }, () => ({
          error: (ctx, _next) => {
            return { error: undefined, result: `caught: ${(ctx.error as Error).message}` };
          },
        }));

      const result = await errorProgram.eval('fail');
      expect(result.result as unknown as string).toBe('caught: async-boom');
    });
  });

  describe('shutdown phase', () => {
    it('should run after successful execution', () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'shutdown-spy' }, () => ({
        execute: (_ctx, next) => {
          log.push('execute');
          return next();
        },
        shutdown: (ctx, next) => {
          log.push(`shutdown:result=${(ctx.result as any)?.result}`);
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(log).toEqual(['execute', 'shutdown:result=Hello, World!']);
    });

    it('should run after errors (with error in context)', () => {
      const log: string[] = [];

      const errorProgram = createPadrone('test')
        .command('fail', (c) =>
          c.action(() => {
            throw new Error('boom');
          }),
        )
        .intercept({ name: 'lifecycle' }, () => ({
          shutdown: (ctx, next) => {
            log.push(`shutdown:error=${(ctx.error as Error)?.message}`);
            return next();
          },
        }));

      const result = errorProgram.eval('fail');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('boom');
      expect(log).toEqual(['shutdown:error=boom']);
    });

    it('should run after error phase suppresses an error', () => {
      const log: string[] = [];

      const errorProgram = createPadrone('test')
        .command('fail', (c) =>
          c.action(() => {
            throw new Error('boom');
          }),
        )
        .intercept({ name: 'lifecycle' }, () => ({
          error: (_ctx, _next) => {
            log.push('error:suppress');
            return { error: undefined, result: 'recovered' };
          },
          shutdown: (ctx, next) => {
            log.push(`shutdown:error=${ctx.error}:result=${(ctx.result as any)?.result}`);
            return next();
          },
        }));

      const result = errorProgram.eval('fail');
      expect(result.result! as string).toBe('recovered');
      expect(log).toEqual(['error:suppress', 'shutdown:error=undefined:result=recovered']);
    });

    it('should respect onion ordering', () => {
      const log: string[] = [];

      const program = makeProgram()
        .intercept({ name: 'outer' }, () => ({
          shutdown: (_ctx, next) => {
            log.push('outer:before');
            next();
            log.push('outer:after');
          },
        }))
        .intercept({ name: 'inner' }, () => ({
          shutdown: (_ctx, next) => {
            log.push('inner');
            next();
          },
        }));

      program.eval('greet World');
      expect(log).toEqual(['outer:before', 'inner', 'outer:after']);
    });

    it('should support async shutdown', async () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'async-shutdown' }, () => ({
        shutdown: async (_ctx, next) => {
          log.push('shutdown');
          await next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      const result = await program.eval('greet World');

      expect(result.result).toBe('Hello, World!');
      expect(log).toEqual(['shutdown']);
    });
  });

  describe('route phase', () => {
    it('should run after parse and before validate', () => {
      const log: string[] = [];

      const program = makeProgram().intercept({ name: 'spy' }, () => ({
        parse: (_ctx, next) => {
          log.push('parse');
          return next();
        },
        route: (_ctx, next) => {
          log.push('route');
          return next();
        },
        validate: (_ctx, next) => {
          log.push('validate');
          return next();
        },
      }));

      program.eval('greet World');
      expect(log).toEqual(['parse', 'route', 'validate']);
    });

    it('should receive the resolved command', () => {
      let routedCommand: string | undefined;

      const program = createPadrone('test')
        .command('deploy', (c) => c.action(() => 'deployed'))
        .command('build', (c) => c.action(() => 'built'))
        .intercept({ name: 'route-spy' }, () => ({
          route: (ctx, next) => {
            routedCommand = ctx.command.name;
            return next();
          },
        }));

      program.eval('deploy');
      expect(routedCommand).toBe('deploy');

      program.eval('build');
      expect(routedCommand).toBe('build');
    });

    it('should receive rawArgs and positionalArgs', () => {
      let capturedRawArgs: Record<string, unknown> | undefined;
      let capturedPositionalArgs: string[] | undefined;

      const program = makeProgram().intercept({ name: 'route-spy' }, () => ({
        route: (ctx, next) => {
          capturedRawArgs = ctx.rawArgs;
          capturedPositionalArgs = ctx.positionalArgs;
          return next();
        },
      }));

      program.eval('greet World');
      expect(capturedRawArgs).toBeDefined();
      expect(capturedPositionalArgs).toContain('World');
    });

    it('should run for both root and command-level interceptors', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('cmd', (c) =>
          c
            .action(() => 'ok')
            .intercept({ name: 'cmd-route' }, () => ({
              route: (_ctx, next) => {
                log.push('cmd-route');
                return next();
              },
            })),
        )
        .intercept({ name: 'root-route' }, () => ({
          route: (_ctx, next) => {
            log.push('root-route');
            return next();
          },
        }));

      program.eval('cmd');
      // Root is outermost, command is innermost
      expect(log).toEqual(['root-route', 'cmd-route']);
    });

    it('should not run on parse failure', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('cmd', (c) => c.action(() => 'ok'))
        .intercept({ name: 'spy' }, () => ({
          route: (_ctx, next) => {
            log.push('route');
            return next();
          },
        }));

      program.eval('unknown-command');
      expect(log).toEqual([]);
    });

    it('should abort pipeline when route handler throws', () => {
      const log: string[] = [];

      const program = makeProgram().intercept({ name: 'auth' }, () => ({
        route: () => {
          log.push('route:throw');
          throw new Error('unauthorized');
        },
        validate: (_ctx, next) => {
          log.push('validate');
          return next();
        },
      }));

      const result = program.eval('greet World');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('unauthorized');
      expect(log).toEqual(['route:throw']);
    });

    it('should support async route handlers', async () => {
      const log: string[] = [];

      const program = makeProgram().intercept({ name: 'async-route' }, () => ({
        route: async (_ctx, next) => {
          log.push('route:start');
          await next();
          log.push('route:end');
        },
      }));

      const result = await program.eval('greet World');
      expect(result.result).toBe('Hello, World!');
      expect(log).toEqual(['route:start', 'route:end']);
    });
  });

  describe('full lifecycle', () => {
    it('should run all phases in order: start -> parse -> route -> validate -> execute -> shutdown', () => {
      const log: string[] = [];

      const interceptor = defineInterceptor({ name: 'full' }, () => ({
        start: (_ctx, next) => {
          log.push('start');
          return next();
        },
        parse: (_ctx, next) => {
          log.push('parse');
          return next();
        },
        route: (_ctx, next) => {
          log.push('route');
          return next();
        },
        validate: (_ctx, next) => {
          log.push('validate');
          return next();
        },
        execute: (_ctx, next) => {
          log.push('execute');
          return next();
        },
        shutdown: (_ctx, next) => {
          log.push('shutdown');
          return next();
        },
      }));

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(log).toEqual(['start', 'parse', 'route', 'validate', 'execute', 'shutdown']);
    });

    it('should run start -> error -> shutdown on pipeline failure', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('fail', (c) =>
          c.action(() => {
            throw new Error('boom');
          }),
        )
        .intercept({ name: 'full' }, () => ({
          start: (_ctx, next) => {
            log.push('start');
            return next();
          },
          error: (ctx, _next) => {
            log.push(`error:${(ctx.error as Error).message}`);
            return { error: undefined, result: 'recovered' };
          },
          shutdown: (_ctx, next) => {
            log.push('shutdown');
            return next();
          },
        }));

      const result = program.eval('fail');
      expect(result.result! as string).toBe('recovered');
      expect(log).toEqual(['start', 'error:boom', 'shutdown']);
    });

    it('should preserve sync when all hooks are sync', () => {
      const interceptor = defineInterceptor({ name: 'sync-lifecycle' }, () => ({
        start: (_ctx, next) => next(),
        shutdown: (_ctx, next) => next(),
      }));

      const program = makeProgram().intercept(interceptor);
      const result = program.eval('greet World');

      expect(result).not.toBeInstanceOf(Promise);
      expect(result.result).toBe('Hello, World!');
    });
  });

  describe('subcommand interceptors', () => {
    it('should apply subcommand interceptor only to that command', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('greet', (c) =>
          c
            .arguments(z.object({ name: z.string() }), { positional: ['name'] })
            .action((args) => `Hello, ${args.name}!`)
            .intercept({ name: 'greet-only' }, () => ({
              execute: (ctx, next) => {
                log.push(`greet-interceptor:${ctx.command.path}`);
                return next();
              },
            })),
        )
        .command('add', (c) => c.arguments(z.object({ a: z.coerce.number(), b: z.coerce.number() })).action((args) => args.a + args.b));

      program.eval('greet World');
      program.eval('add --a=1 --b=2');

      expect(log).toEqual(['greet-interceptor:greet']);
    });

    it('should inherit program interceptors and compose with subcommand interceptors', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('greet', (c) =>
          c
            .arguments(z.object({ name: z.string() }), { positional: ['name'] })
            .action((args) => `Hello, ${args.name}!`)
            .intercept({ name: 'sub-interceptor' }, () => ({
              execute: (_ctx, next) => {
                log.push('sub:before');
                const r = next();
                log.push('sub:after');
                return r;
              },
            })),
        )
        .intercept({ name: 'root-interceptor' }, () => ({
          execute: (_ctx, next) => {
            log.push('root:before');
            const r = next();
            log.push('root:after');
            return r;
          },
        }));

      program.eval('greet World');

      // Root interceptor is outermost, subcommand interceptor is innermost
      expect(log).toEqual(['root:before', 'sub:before', 'sub:after', 'root:after']);
    });

    it('should not inherit interceptor with inherit: false to subcommands', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
        )
        .intercept({ name: 'local-only', inherit: false }, () => ({
          execute: (_ctx, next) => {
            log.push('local-only');
            return next();
          },
        }))
        .action(() => 'root');

      // Root command — interceptor should run
      program.eval('');
      expect(log).toEqual(['local-only']);

      // Subcommand — interceptor should NOT run
      log.length = 0;
      program.eval('greet World');
      expect(log).toEqual([]);
    });

    it('should still run inherit: false interceptor on the command it was registered on', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('greet', (c) =>
          c
            .arguments(z.object({ name: z.string() }), { positional: ['name'] })
            .action((args) => `Hello, ${args.name}!`)
            .intercept({ name: 'sub-local', inherit: false }, () => ({
              execute: (_ctx, next) => {
                log.push('sub-local');
                return next();
              },
            })),
        )
        .intercept({ name: 'root-interceptor' }, () => ({
          execute: (_ctx, next) => {
            log.push('root');
            return next();
          },
        }));

      program.eval('greet World');
      // Both should run — root inherits normally, sub-local is on the target command
      expect(log).toEqual(['root', 'sub-local']);
    });

    it('should apply subcommand validate interceptor', () => {
      let intercepted = false;

      const program = createPadrone('test').command('greet', (c) =>
        c
          .arguments(z.object({ name: z.string() }), { positional: ['name'] })
          .action((args) => `Hello, ${args.name}!`)
          .intercept({ name: 'validate-spy' }, () => ({
            validate: (ctx, next) => {
              intercepted = true;
              expect(ctx.command.path).toBe('greet');
              return next();
            },
          })),
      );

      const result = program.eval('greet World');
      expect(result.result).toBe('Hello, World!');
      expect(intercepted).toBe(true);
    });

    it('should not apply subcommand parse interceptor (parse is root-only)', () => {
      let parseCalled = false;

      const program = createPadrone('test').command('greet', (c) =>
        c
          .arguments(z.object({ name: z.string() }), { positional: ['name'] })
          .action((args) => `Hello, ${args.name}!`)
          .intercept({ name: 'sub-parse' }, () => ({
            parse: (_ctx, next) => {
              parseCalled = true;
              return next();
            },
          })),
      );

      const result = program.eval('greet World');
      expect(result.result).toBe('Hello, World!');
      expect(parseCalled).toBe(false);
    });

    it('should work with nested subcommands', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('db', (c) =>
          c
            .intercept({ name: 'db-interceptor' }, () => ({
              execute: (_ctx, next) => {
                log.push('db');
                return next();
              },
            }))
            .command('migrate', (sub) =>
              sub
                .action(() => 'migrated')
                .intercept({ name: 'migrate-interceptor' }, () => ({
                  execute: (_ctx, next) => {
                    log.push('migrate');
                    return next();
                  },
                })),
            ),
        )
        .intercept({ name: 'root-interceptor' }, () => ({
          execute: (_ctx, next) => {
            log.push('root');
            return next();
          },
        }));

      const result = program.eval('db migrate');
      expect(result.result).toBe('migrated');
      // Root -> db -> migrate (outermost to innermost)
      expect(log).toEqual(['root', 'db', 'migrate']);
    });
  });

  describe('id deduplication', () => {
    it('should keep the last interceptor when multiple share the same id', () => {
      const log: string[] = [];

      const program = makeProgram()
        .intercept({ name: 'first', id: 'auth' }, () => ({
          execute: (_ctx, next) => {
            log.push('first');
            return next();
          },
        }))
        .intercept({ name: 'second', id: 'auth' }, () => ({
          execute: (_ctx, next) => {
            log.push('second');
            return next();
          },
        }));

      program.eval('greet World');
      expect(log).toEqual(['second']);
    });

    it('should not affect interceptors without an id', () => {
      const log: string[] = [];

      const program = makeProgram()
        .intercept({ name: 'a' }, () => ({
          execute: (_ctx, next) => {
            log.push('a');
            return next();
          },
        }))
        .intercept({ name: 'b' }, () => ({
          execute: (_ctx, next) => {
            log.push('b');
            return next();
          },
        }));

      program.eval('greet World');
      expect(log).toEqual(['a', 'b']);
    });

    it('should mix interceptors with and without ids correctly', () => {
      const log: string[] = [];

      const program = makeProgram()
        .intercept({ name: 'no-id-1' }, () => ({
          execute: (_ctx, next) => {
            log.push('no-id-1');
            return next();
          },
        }))
        .intercept({ name: 'first-auth', id: 'auth' }, () => ({
          execute: (_ctx, next) => {
            log.push('first-auth');
            return next();
          },
        }))
        .intercept({ name: 'no-id-2' }, () => ({
          execute: (_ctx, next) => {
            log.push('no-id-2');
            return next();
          },
        }))
        .intercept({ name: 'second-auth', id: 'auth' }, () => ({
          execute: (_ctx, next) => {
            log.push('second-auth');
            return next();
          },
        }));

      program.eval('greet World');
      expect(log).toEqual(['no-id-1', 'no-id-2', 'second-auth']);
    });

    it('should deduplicate across parent chain (subcommand overrides parent)', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('greet', (c) =>
          c
            .arguments(z.object({ name: z.string() }), { positional: ['name'] })
            .action((args) => `Hello, ${args.name}!`)
            .intercept({ name: 'sub-auth', id: 'auth' }, () => ({
              execute: (_ctx, next) => {
                log.push('sub-auth');
                return next();
              },
            })),
        )
        .intercept({ name: 'root-auth', id: 'auth' }, () => ({
          execute: (_ctx, next) => {
            log.push('root-auth');
            return next();
          },
        }));

      program.eval('greet World');
      // Subcommand interceptor comes after root in collected chain, so it wins
      expect(log).toEqual(['sub-auth']);
    });

    it('should deduplicate per phase independently', () => {
      const log: string[] = [];

      const program = makeProgram()
        .intercept({ name: 'first', id: 'logger' }, () => ({
          validate: (_ctx, next) => {
            log.push('validate:first');
            return next();
          },
          execute: (_ctx, next) => {
            log.push('execute:first');
            return next();
          },
        }))
        .intercept({ name: 'second', id: 'logger' }, () => ({
          execute: (_ctx, next) => {
            log.push('execute:second');
            return next();
          },
          // no validate — but dedup still removes the first interceptor entirely
        }));

      program.eval('greet World');
      // The second interceptor replaced the first (same id), so first's validate is gone too
      expect(log).toEqual(['execute:second']);
    });
  });

  describe('closure-based cross-phase state', () => {
    it('should allow factory closure to share typed state across phases', () => {
      let capturedUser: string | undefined;

      const interceptor = defineInterceptor({ name: 'auth' }, () => {
        let user: string | undefined;

        return {
          parse: (_ctx, next) => {
            const result = next();
            user = 'admin';
            return result;
          },
          execute: (_ctx, next) => {
            capturedUser = user;
            return next();
          },
        };
      });

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(capturedUser).toBe('admin');
    });

    it('should create fresh closure per execution', () => {
      const counters: number[] = [];

      const interceptor = defineInterceptor({ name: 'counter' }, () => {
        let count = 0;

        return {
          parse: (_ctx, next) => {
            count++;
            return next();
          },
          execute: (_ctx, next) => {
            counters.push(count);
            return next();
          },
        };
      });

      const program = makeProgram().intercept(interceptor);
      program.eval('greet A');
      program.eval('greet B');

      // Each execution gets a fresh closure, so count starts at 0 each time
      expect(counters).toEqual([1, 1]);
    });

    it('should allow timing across phases via closure', () => {
      let duration: number | undefined;

      const interceptor = defineInterceptor({ name: 'timer' }, () => {
        let startTime: number;

        return {
          start: (_ctx, next) => {
            startTime = Date.now();
            return next();
          },
          shutdown: (_ctx, next) => {
            duration = Date.now() - startTime;
            return next();
          },
        };
      });

      const program = makeProgram().intercept(interceptor);
      program.eval('greet World');

      expect(duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('command-level error/shutdown', () => {
    it('should run command-level shutdown on success', () => {
      const log: string[] = [];

      const program = createPadrone('test').command('cmd', (c) =>
        c
          .action(() => 'ok')
          .intercept({ name: 'cmd-shutdown' }, () => ({
            shutdown: (ctx, next) => {
              log.push(`cmd-shutdown:result=${(ctx.result as any)?.result}`);
              return next();
            },
          })),
      );

      program.eval('cmd');
      expect(log).toEqual(['cmd-shutdown:result=ok']);
    });

    it('should run command-level shutdown on error', () => {
      const log: string[] = [];

      const program = createPadrone('test').command('cmd', (c) =>
        c
          .action(() => {
            throw new Error('boom');
          })
          .intercept({ name: 'cmd-shutdown' }, () => ({
            shutdown: (ctx, next) => {
              log.push(`cmd-shutdown:error=${(ctx.error as Error)?.message}`);
              return next();
            },
          })),
      );

      const result = program.eval('cmd');
      expect(result.error).toBeInstanceOf(Error);
      expect(log).toEqual(['cmd-shutdown:error=boom']);
    });

    it('should run command-level error handler that can suppress errors', () => {
      const log: string[] = [];

      const program = createPadrone('test').command('cmd', (c) =>
        c
          .action(() => {
            throw new Error('boom');
          })
          .intercept({ name: 'cmd-error' }, () => ({
            error: (ctx, _next) => {
              log.push(`cmd-error:${(ctx.error as Error).message}`);
              return { error: undefined, result: 'recovered' };
            },
            shutdown: (ctx, next) => {
              log.push(`cmd-shutdown:error=${ctx.error}:result=${(ctx.result as any)?.result}`);
              return next();
            },
          })),
      );

      const result = program.eval('cmd');
      expect(result.result! as string).toBe('recovered');
      expect(log).toEqual(['cmd-error:boom', 'cmd-shutdown:error=undefined:result=recovered']);
    });

    it('should run command-level shutdown before root-level shutdown', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('cmd', (c) =>
          c
            .action(() => 'ok')
            .intercept({ name: 'cmd-lifecycle' }, () => ({
              shutdown: (_ctx, next) => {
                log.push('cmd-shutdown');
                return next();
              },
            })),
        )
        .intercept({ name: 'root-lifecycle' }, () => ({
          shutdown: (_ctx, next) => {
            log.push('root-shutdown');
            return next();
          },
        }));

      program.eval('cmd');
      expect(log).toEqual(['cmd-shutdown', 'root-shutdown']);
    });

    it('should not double-run root interceptor shutdown', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('cmd', (c) => c.action(() => 'ok'))
        .intercept({ name: 'root-lifecycle' }, () => ({
          shutdown: (_ctx, next) => {
            log.push('root-shutdown');
            return next();
          },
        }));

      program.eval('cmd');
      // Root shutdown runs once (via root lifecycle), not twice
      expect(log).toEqual(['root-shutdown']);
    });

    it('should not run command-level error/shutdown on parse failure', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .command('cmd', (c) =>
          c
            .action(() => 'ok')
            .intercept({ name: 'cmd-lifecycle' }, () => ({
              error: (ctx, next) => {
                log.push(`cmd-error:${(ctx.error as Error).message}`);
                return next();
              },
              shutdown: (_ctx, next) => {
                log.push('cmd-shutdown');
                return next();
              },
            })),
        )
        .intercept({ name: 'root-lifecycle' }, () => ({
          shutdown: (_ctx, next) => {
            log.push('root-shutdown');
            return next();
          },
        }));

      const result = program.eval('unknown-command');
      expect(result.error).toBeDefined();
      // Only root shutdown runs; command-level handlers are never reached
      expect(log).toEqual(['root-shutdown']);
    });

    it('should run command-level shutdown when outer interceptor throws in execute', () => {
      const log: string[] = [];

      const program = createPadrone('test')
        .intercept({ name: 'failing-outer' }, () => ({
          execute: () => {
            throw new Error('outer boom');
          },
        }))
        .command('cmd', (c) =>
          c
            .action(() => 'ok')
            .intercept({ name: 'cmd-lifecycle' }, () => ({
              shutdown: (ctx, next) => {
                log.push(`cmd-shutdown:error=${(ctx.error as Error)?.message}`);
                return next();
              },
            })),
        );

      const result = program.eval('cmd');
      expect(result.error).toBeInstanceOf(Error);
      expect(log).toEqual(['cmd-shutdown:error=outer boom']);
    });

    it('should support async command-level shutdown', async () => {
      const log: string[] = [];

      const program = createPadrone('test').command('cmd', (c) =>
        c
          .action(() => 'ok')
          .intercept({ name: 'async-cmd-shutdown' }, () => ({
            shutdown: async (_ctx, next) => {
              log.push('cmd-shutdown');
              await next();
            },
          })),
      );

      const result = await program.eval('cmd');
      expect(result.result).toBe('ok');
      expect(log).toEqual(['cmd-shutdown']);
    });
  });
});
