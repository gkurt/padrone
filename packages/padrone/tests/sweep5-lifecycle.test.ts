import { describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InteractivePromptConfig, PadroneSignal } from 'padrone';
import { createPadrone, defineEvent, defineInterceptor } from 'padrone';
import * as z from 'zod/v4';

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };

function mockReadLine(inputs: (string | null)[]) {
  let i = 0;
  return async () => (i < inputs.length ? inputs[i++]! : null);
}

describe('a throwing command-level shutdown', () => {
  it('still runs the root shutdown handlers', async () => {
    const rootShutdown = mock();
    const program = createPadrone('tool')
      .runtime(quiet)
      .intercept(
        defineInterceptor({ name: 'root' }, () => ({
          shutdown(ctx, next) {
            rootShutdown(ctx.error);
            return next();
          },
        })),
      )
      .command('fail', (c) =>
        c
          .intercept(
            defineInterceptor({ name: 'cmd' }, () => ({
              shutdown() {
                throw new Error('shutdown failed');
              },
            })),
          )
          .action(() => {
            throw new Error('boom');
          }),
      )
      .command('failAsync', (c) =>
        c
          .intercept(
            defineInterceptor({ name: 'cmd' }, () => ({
              async shutdown() {
                throw new Error('shutdown failed');
              },
            })),
          )
          .async()
          .action(async () => {
            throw new Error('boom');
          }),
      );
    expect((program.eval('fail').error as Error).message).toBe('shutdown failed');
    expect(rootShutdown).toHaveBeenCalledTimes(1);
    expect((rootShutdown.mock.calls[0]![0] as Error).message).toBe('boom');
    expect(((await program.eval('failAsync')).error as Error).message).toBe('shutdown failed');
    expect(rootShutdown).toHaveBeenCalledTimes(2);
  });
});

describe('REPL history file', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-sweep5-'));

  it('is only readable by the user', async () => {
    const file = path.join(tmp(), 'history');
    const program = createPadrone('tool')
      .runtime({ ...quiet, readLine: mockReadLine(['greet', null]) })
      .command('greet', (c) => c.action(() => 'hi'));
    await program.repl({ historyFile: file, greeting: false, hint: false }).drain();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps nothing with historySize 0', async () => {
    const file = path.join(tmp(), 'history');
    fs.writeFileSync(file, 'old1\nold2\n');
    const program = createPadrone('tool')
      .runtime({ ...quiet, readLine: mockReadLine(['.history', null]), output: mock() })
      .command('greet', (c) => c.action(() => 'hi'));
    const output = mock();
    await program.repl({ historyFile: file, historySize: 0, greeting: false, hint: false, runtime: { output } }).drain();
    expect(output.mock.calls.flat().join('\n')).not.toContain('old1');
  });
});

describe('interactive prompts for sensitive fields', () => {
  it('keeps the given value when a forced prompt is left blank', async () => {
    let asked = 0;
    const prompt = mock(async (_config: InteractivePromptConfig) => {
      if (++asked > 5) throw new Error('asked again');
      return '';
    });
    const program = createPadrone('tool')
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('login', (c) =>
        c
          .arguments(z.object({ user: z.string(), token: z.string() }), {
            interactive: true,
            fields: { token: { sensitive: true } },
          })
          .action((args) => args),
      );
    const result = await program.eval('login --user me --token secret -i');
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ user: 'me', token: 'secret' });
  });

  it('masks a sensitive key of an object field', async () => {
    const configs: InteractivePromptConfig[] = [];
    const prompt = mock(async (config: InteractivePromptConfig) => {
      configs.push(config);
      return 'x';
    });
    const program = createPadrone('tool')
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('connect', (c) =>
        c
          .arguments(z.object({ db: z.object({ host: z.string(), password: z.string().meta({ sensitive: true }) }) }), {
            interactive: true,
          })
          .action((args) => args),
      );
    await program.eval('connect --db.host h --db.password hunter2 -i');
    const password = configs.find((c) => c.name === 'db.password');
    expect(password?.type).toBe('password');
    expect(password?.default).toBeUndefined();
  });
});

describe('signal handling in a REPL', () => {
  const create = () => {
    const listeners = new Set<(signal: PadroneSignal) => void>();
    const program = createPadrone('tool')
      .runtime({
        ...quiet,
        readLine: mockReadLine(['slow', null]),
        onSignal: (cb: (signal: PadroneSignal) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      })
      .command('slow', (c) =>
        c.async().action(async (_args, ctx) => {
          for (const cb of [...listeners]) cb('SIGINT');
          return ctx.signal.aborted ? 'stopped' : 'ran';
        }),
      );
    return { program, listeners };
  };

  it.each([['--repl'], ['repl']])('a Ctrl+C interrupts the command, not the session started by %s', async (argv) => {
    const { program, listeners } = create();
    const result = await program.cli({ runtime: { argv: () => [argv] } });
    expect(result.error).toBeUndefined();
    expect((result as { exitCode?: number }).exitCode).toBeUndefined();
    expect((result as { signal?: string }).signal).toBeUndefined();
    expect(listeners.size).toBe(0);
  });

  it('the command still sees the abort', async () => {
    const { program } = create();
    const results = await program.repl({ greeting: false, hint: false }).drain();
    expect(results.value?.map((r) => r.result)).toEqual(['stopped']);
  });
});

describe('builder calls after a subtree is built', () => {
  const event = defineEvent<string>('test:ping');
  const listener = (handler: () => void) => defineInterceptor({ name: 'listener', on: { [event.id]: handler } }, () => ({}));

  it("a mounted program's commands emit to interceptors added to the program afterwards", async () => {
    const handler = mock();
    const db = createPadrone('db').command('migrate', (c) => c.async().action(async (_args, ctx) => ctx.emit(event, 'x')));
    const program = createPadrone('tool').runtime(quiet).mount('db', db).intercept(listener(handler));
    expect((await program.eval('db migrate')).error).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('commands resolved before the call walk up to the new root', async () => {
    const handler = mock();
    const base = createPadrone('tool')
      .runtime(quiet)
      .command('a', (c) => c.command('b', (b) => b.async().action(async (_args, ctx) => ctx.emit(event, 'x'))));
    base.help('a b');
    const program = base.intercept(listener(handler));
    await program.eval('a b');
    expect(handler).toHaveBeenCalledTimes(1);
    await base.eval('a b');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('a process signal after the caller aborted the run', () => {
  const create = (signals: PadroneSignal[]) => {
    const listeners = new Set<(signal: PadroneSignal) => void>();
    const exit = mock((_code: number) => undefined as never);
    const controller = new AbortController();
    const program = createPadrone('tool')
      .runtime({
        ...quiet,
        exit,
        onSignal: (cb: (signal: PadroneSignal) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      })
      .command('slow', (c) =>
        c.async().action(async () => {
          controller.abort();
          for (const signal of signals) {
            await Bun.sleep(2);
            for (const cb of [...listeners]) cb(signal);
          }
        }),
      );
    return { run: () => program.eval('slow', { signal: controller.signal }), exit };
  };

  it("counts as the first one, so a single SIGTERM doesn't force-exit", async () => {
    const { run, exit } = create(['SIGTERM']);
    const result = await run();
    expect(exit).not.toHaveBeenCalled();
    expect((result as { exitCode?: number }).exitCode).toBe(143);
  });

  it('a repeated one still force-exits', async () => {
    const { run, exit } = create(['SIGTERM', 'SIGTERM']);
    await run();
    expect(exit).toHaveBeenCalledWith(143);
  });
});
