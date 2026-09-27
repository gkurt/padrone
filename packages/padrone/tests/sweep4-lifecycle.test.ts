import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PadroneLogger, PadroneProgress, PadroneSignal } from 'padrone';
import {
  createPadrone,
  createTerminalProgress,
  createTerminalTaskList,
  defineInterceptor,
  detectInstaller,
  padroneConfirm,
  padroneLogger,
  padroneProgress,
  padroneTiming,
  padroneUpdateCheck,
  padroneUpgrade,
} from 'padrone';

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };

/** Makes stderr a TTY that records writes, with the given environment variables set (`undefined` unsets). */
async function withTerminal(env: Record<string, string | undefined>, fn: (writes: string[]) => void | Promise<void>) {
  const writes: string[] = [];
  const stderr = process.stderr as unknown as Record<string, unknown>;
  const original = { isTTY: stderr.isTTY, write: stderr.write };
  const originalEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  Object.defineProperty(stderr, 'isTTY', { value: true, configurable: true, writable: true });
  stderr.write = (chunk: string) => writes.push(String(chunk)) > 0;
  setEnv(env);
  try {
    await fn(writes);
  } finally {
    setEnv(originalEnv);
    Object.defineProperty(stderr, 'isTTY', { value: original.isTTY, configurable: true, writable: true });
    stderr.write = original.write;
  }
}

describe('upgrade --check is read-only', () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ version: '2.0.0' }) });
  });
  afterAll(() => server.stop(true));

  const create = () => {
    const exec = mock(async (_command: readonly string[]) => 0);
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .extend(padroneConfirm())
      .extend(padroneUpgrade({ registry: server.url.href, installer: 'npm', exec }));
    return { program, exec };
  };

  it("doesn't ask for confirmation", async () => {
    const { program, exec } = create();
    const result = await program.cli({ runtime: { ...quiet, argv: () => ['upgrade', '--check'], interactive: 'disabled' } });
    expect(result.error).toBeUndefined();
    expect(result.result as unknown).toBe('Update available: 1.0.0 → 2.0.0');
    expect(exec).not.toHaveBeenCalled();
  });

  it('still asks before upgrading', async () => {
    const { program, exec } = create();
    const result = await program.cli({ runtime: { ...quiet, argv: () => ['upgrade'], interactive: 'disabled' } });
    expect((result.error as Error).message).toContain('needs confirmation');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports the check under --dry-run', async () => {
    const { program } = create();
    expect((await program.eval('upgrade --check --dry-run')).result as unknown).toBe('Update available: 1.0.0 → 2.0.0');
  });
});

describe('upgrade detects a Windows yarn global install', () => {
  it('reads Yarn\\Data\\global as yarn', () => {
    expect(detectInstaller(['C:\\Users\\u\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\tool\\cli.js'])).toBe('yarn');
  });
});

describe('JSON log lines keep their own time, level and msg', () => {
  const lines = (fn: (logger: PadroneLogger) => void) => {
    const errors: string[] = [];
    const program = createPadrone('tool')
      .extend(padroneLogger({ format: 'json', level: 'trace' }))
      .command('a', (c) => c.action((_args, ctx) => fn(ctx.context.logger)));
    program.eval('a', { runtime: { output: () => {}, error: (text) => errors.push(text) } });
    return errors.map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("fields don't overwrite the level, time or message", () => {
    const [line] = lines((logger) => logger.info({ level: 'debug', time: 1, msg: 'field', user: 'ada' }, 'signed in'));
    expect(line!.level).toBe('info');
    expect(typeof line!.time).toBe('string');
    expect(line!.msg).toBe('signed in');
    expect(line!.user).toBe('ada');
  });

  it('uses a msg field when there is no message', () => {
    const [line] = lines((logger) => logger.warn({ msg: 'from field' }));
    expect(line!.msg).toBe('from field');
    expect(line!.level).toBe('warn');
  });
});

describe('a throwing error-phase interceptor', () => {
  it('still runs shutdown, so signal listeners are removed', async () => {
    let subscribed = 0;
    const shutdown = mock();
    const program = createPadrone('tool')
      .runtime({
        onSignal: (_cb: (signal: PadroneSignal) => void) => {
          subscribed++;
          return () => subscribed--;
        },
      })
      .intercept(
        defineInterceptor({ name: 'rethrow', order: -3000 }, () => ({
          error() {
            throw new Error('rethrown');
          },
          shutdown(ctx, next) {
            shutdown(ctx.error);
            return next();
          },
        })),
      )
      .command('sync', (c) =>
        c.action(() => {
          throw new Error('boom');
        }),
      )
      .command('async', (c) =>
        c.async().action(async () => {
          throw new Error('boom');
        }),
      );

    expect((program.eval('sync').error as Error).message).toBe('rethrown');
    expect(((await program.eval('async')).error as Error).message).toBe('rethrown');
    expect(subscribed).toBe(0);
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect((shutdown.mock.calls[0]![0] as Error).message).toBe('rethrown');
  });

  it('still runs command-level shutdown', () => {
    const shutdown = mock();
    const program = createPadrone('tool').command('sync', (c) =>
      c
        .intercept(
          defineInterceptor({ name: 'rethrow' }, () => ({
            error() {
              throw new Error('rethrown');
            },
            shutdown(_ctx, next) {
              shutdown();
              return next();
            },
          })),
        )
        .action(() => {
          throw new Error('boom');
        }),
    );
    expect((program.eval('sync').error as Error).message).toBe('rethrown');
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('timing rounds durations before choosing the unit', () => {
  const report = async (elapsed: number) => {
    const errors: string[] = [];
    const now = performance.now;
    let t = 0;
    performance.now = () => t;
    try {
      const program = createPadrone('tool')
        .runtime({ error: (text) => errors.push(text) })
        .extend(padroneTiming({ enabled: true }))
        .command('a', (c) =>
          c.action(() => {
            t = elapsed;
          }),
        );
      await program.eval('a');
    } finally {
      performance.now = now;
    }
    return errors[0];
  };

  it('never shows 1000ms or 60.00s', async () => {
    expect(await report(999.6)).toBe('\nDone in 1.00s');
    expect(await report(59_999.6)).toBe('\nDone in 1m 0.00s');
    expect(await report(119_999.6)).toBe('\nDone in 2m 0.00s');
    expect(await report(61_500)).toBe('\nDone in 1m 1.50s');
    expect(await report(12.4)).toBe('\nDone in 12ms');
  });
});

describe('update check in CI', () => {
  const run = async (env: Record<string, string>) => {
    const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-update-')), 'cache.json');
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now(), latestVersion: '2.0.0' }));
    const errors: string[] = [];
    const program = createPadrone('test')
      .configure({ version: '1.0.0' })
      .extend(padroneUpdateCheck({ cache }))
      .runtime({ output: () => {}, error: (text) => errors.push(text), env: () => env, terminal: { isTTY: true } })
      .command('hello', (c) => c.action(() => 'hello'));
    program.cli({ runtime: { argv: () => ['hello'] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return errors.join('');
  };

  it('treats CI=false and CI=0 as not CI', async () => {
    expect(await run({ CI: 'false' })).toContain('Update available');
    expect(await run({ CI: '0' })).toContain('Update available');
    expect(await run({ CI: 'true' })).toBe('');
    expect(await run({ CONTINUOUS_INTEGRATION: '1' })).toBe('');
  });
});

describe('progress: a manual pause() holds through output', () => {
  it("doesn't redraw the indicator when output is written while paused", async () => {
    const calls: string[] = [];
    const renderer = (): PadroneProgress => ({
      update: () => {},
      eta: { start() {}, stop() {}, reset() {} },
      succeed: () => calls.push('succeed'),
      fail: () => calls.push('fail'),
      stop: () => calls.push('stop'),
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
    });
    const output: string[] = [];
    const program = createPadrone('tool').command('a', (c) =>
      c.extend(padroneProgress({ message: 'Working', renderer })).action((_args, ctx) => {
        ctx.context.progress.pause();
        ctx.runtime.output('one');
        calls.push('output');
        ctx.runtime.output('two');
        ctx.context.progress.resume();
        ctx.runtime.output('three');
      }),
    );
    await program.eval('a', { runtime: { output: (text) => output.push(String(text)) } });
    expect(output).toEqual(['one', 'two', 'three']);
    expect(calls).toEqual(['pause', 'output', 'resume', 'pause', 'resume', 'succeed']);
  });
});

describe('terminal renderers without an interactive terminal', () => {
  for (const env of [{ TERM: 'dumb', CI: undefined }, { CI: 'true' }]) {
    it(`don't animate with ${JSON.stringify(env)}`, async () => {
      await withTerminal(env, (writes) => {
        const progress = createTerminalProgress('Working');
        progress.update('Almost');
        progress.succeed();
        const list = createTerminalTaskList([{ title: 'Build', status: 'done', subtasks: [] }]);
        list.update();
        list.done();
        expect(writes).toEqual(['✔ Almost\n', '✔ Build\n']);
      });
    });
  }
});

describe('update check without a program version', () => {
  it("doesn't compare against the version of the project being worked on", async () => {
    const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-update-')), 'cache.json');
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now(), latestVersion: '2.0.0' }));
    const errors: string[] = [];
    const program = createPadrone('test')
      .extend(padroneUpdateCheck({ cache }))
      .runtime({ output: () => {}, error: (text) => errors.push(text), env: () => ({}), terminal: { isTTY: true } })
      .command('hello', (c) => c.action(() => 'hello'));
    // Set by npm/bun scripts to the version of the project in the working directory, not of this program
    const original = process.env.npm_package_version;
    process.env.npm_package_version = '1.0.0';
    try {
      program.cli({ runtime: { argv: () => ['hello'] } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      if (original === undefined) delete process.env.npm_package_version;
      else process.env.npm_package_version = original;
    }
    expect(errors).toEqual([]);
  });
});
