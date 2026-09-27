import { describe, expect, it } from 'bun:test';
import { createPadrone, defineEvent, defineInterceptor, LOCAL_CALLERS, REMOTE_CALLERS } from 'padrone';
import * as z from 'zod/v4';

const quiet = { output: () => {}, error: () => {} };

describe('interceptor callers', () => {
  const makeProgram = (seen: string[], callers: Parameters<typeof defineInterceptor>[0]['callers']) =>
    createPadrone('app')
      .runtime(quiet)
      .intercept(
        defineInterceptor({ name: 'only', callers }, () => ({
          execute(ctx, next) {
            seen.push(ctx.caller);
            return next();
          },
        })),
      )
      .action(() => 'done');

  it('runs the interceptor only for the listed callers', async () => {
    const seen: string[] = [];
    const program = makeProgram(seen, ['cli']);
    program.eval('');
    program.run('', undefined);
    await program.cli({ runtime: { argv: () => [], setExitCode: () => {} } });
    expect(seen).toEqual(['cli']);
  });

  it('takes LOCAL_CALLERS and REMOTE_CALLERS', () => {
    const local: string[] = [];
    const remote: string[] = [];
    makeProgram(local, LOCAL_CALLERS).eval('', { caller: 'serve' });
    makeProgram(local, LOCAL_CALLERS).eval('');
    makeProgram(remote, REMOTE_CALLERS).eval('', { caller: 'mcp' });
    makeProgram(remote, REMOTE_CALLERS).eval('');
    expect(local).toEqual(['eval']);
    expect(remote).toEqual(['mcp']);
  });

  it('works with the (meta, factory) form of .intercept()', () => {
    const seen: string[] = [];
    const program = createPadrone('app')
      .runtime(quiet)
      .intercept({ name: 'repl-only', callers: ['repl'] }, () => ({
        execute(_ctx, next) {
          seen.push('ran');
          return next();
        },
      }))
      .action(() => 'done');
    program.eval('');
    program.eval('', { caller: 'repl' });
    expect(seen).toEqual(['ran']);
  });

  it('still counts as registered for requires', () => {
    const logger = defineInterceptor({ id: 'my:logger', name: 'logger', callers: ['cli'] }, () => ({}));
    const needsLogger = defineInterceptor({ name: 'needs', requires: ['my:logger'] }, () => ({}));
    const program = createPadrone('app')
      .runtime(quiet)
      .intercept(logger)
      .intercept(needsLogger)
      .action(() => 'ok');
    expect(program.eval('').result).toBe('ok');
  });
});

describe('custom events', () => {
  const deployed = defineEvent<{ env: string; version: string }>('app:deployed');
  const pinged = defineEvent('app:pinged');

  const makeProgram = (log: string[]) => {
    const slack = defineInterceptor({ name: 'slack' }, () => ({})).on(deployed, async (payload, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`slack ${payload.env}@${payload.version} from ${ctx.command.name} (${ctx.caller})`);
    });
    const audit = defineInterceptor({ name: 'audit', order: -10 }, () => ({}))
      .on(deployed, (payload) => {
        log.push(`audit ${payload.env}`);
      })
      .on(pinged, () => {
        log.push('audit pinged');
      });
    return createPadrone('app')
      .runtime(quiet)
      .intercept(slack)
      .intercept(audit)
      .command('deploy', (c) =>
        c
          .arguments(z.object({ env: z.string() }), { positional: ['env'] })
          .intercept(
            defineInterceptor({ name: 'local', on: { [deployed.id]: () => log.push('command-level') } }, () => ({
              async execute(ctx, next) {
                await ctx.emit(pinged);
                log.push('interceptor emitted');
                return next();
              },
            })),
          )
          .action(async (args, ctx) => {
            await ctx.emit(deployed, { env: args.env, version: '1.0' });
            log.push('action done');
            return 'deployed';
          }),
      )
      .command('other', (c) => c.action(() => 'other'));
  };

  it('runs the handlers on the command chain in interceptor order, and waits for them', async () => {
    const log: string[] = [];
    const result = await makeProgram(log).eval('deploy prod');
    expect(result.result as unknown).toBe('deployed');
    expect(log).toEqual([
      'audit pinged',
      'interceptor emitted',
      'audit prod',
      'slack prod@1.0 from deploy (eval)',
      'command-level',
      'action done',
    ]);
  });

  it('runs root handlers for program.emit() outside an execution', async () => {
    const log: string[] = [];
    await makeProgram(log).emit(deployed, { env: 'staging', version: '2.0' });
    expect(log).toEqual(['audit staging', 'slack staging@2.0 from app (run)']);
  });

  it('propagates handler errors to emit()', async () => {
    const failing = defineInterceptor({ name: 'failing' }, () => ({})).on(pinged, () => {
      throw new Error('handler failed');
    });
    const program = createPadrone('app')
      .runtime(quiet)
      .intercept(failing)
      .action((_args, ctx) => ctx.emit(pinged));
    const result = await program.eval('');
    expect((result.error as Error).message).toBe('handler failed');
    expect(program.emit(pinged)).rejects.toThrow('handler failed');
  });

  it('skips disabled, replaced, non-inherited and caller-filtered interceptors', async () => {
    const log: string[] = [];
    const handler = (name: string) => () => {
      log.push(name);
    };
    const program = createPadrone('app')
      .runtime(quiet)
      .intercept(defineInterceptor({ name: 'disabled', disabled: true }, () => ({})).on(pinged, handler('disabled')))
      .intercept(defineInterceptor({ id: 'dup', name: 'first' }, () => ({})).on(pinged, handler('first')))
      .intercept(defineInterceptor({ id: 'dup', name: 'second' }, () => ({})).on(pinged, handler('second')))
      .intercept(defineInterceptor({ name: 'cli-only', callers: ['cli'] }, () => ({})).on(pinged, handler('cli-only')))
      .intercept(defineInterceptor({ name: 'root-only', inherit: false }, () => ({})).on(pinged, handler('root-only')))
      .command('sub', (c) => c.action((_args, ctx) => ctx.emit(pinged)));
    await program.eval('sub');
    expect(log).toEqual(['second']);
  });

  it('runs every handler .on() adds for the same event, and reaches run()', async () => {
    const log: string[] = [];
    const twice = defineInterceptor({ name: 'twice' }, () => ({}))
      .on(pinged, () => {
        log.push('one');
      })
      .on(pinged, () => {
        log.push('two');
      });
    const program = createPadrone('app')
      .intercept(twice)
      .command('go', (c) => c.action((_args, ctx) => ctx.emit(pinged)));
    await program.run('go', undefined).result;
    expect(log).toEqual(['one', 'two']);
  });

  it('types payloads', () => {
    const typed = defineInterceptor({ name: 'typed' }, () => ({})).on(deployed, (payload) => {
      const env: string = payload.env;
      // @ts-expect-error not in the payload
      payload.missing;
      return env;
    });
    const program = createPadrone('app').intercept(typed);
    // Type checks only
    const _unused = () => {
      // @ts-expect-error the payload is required
      program.emit(deployed);
      // @ts-expect-error wrong payload
      program.emit(deployed, { env: 1, version: '1' });
      program.emit(pinged);
    };
    expect(typed.name).toBe('typed');
  });

  it('keeps the context brand of .provides() interceptors', () => {
    const provider = defineInterceptor({ name: 'provider' }, () => ({
      execute: (_ctx, next) => next({ context: { user: 'ana' } }),
    }))
      .provides<{ user: string }>()
      .on(pinged, () => {});
    const program = createPadrone('app')
      .intercept(provider)
      .action((_args, ctx) => ctx.context.user);
    expect(program.eval('', { runtime: quiet }).result).toBe('ana');
  });
});
