import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPadrone,
  createTerminalProgress,
  detectInstaller,
  type PadroneLoggerConfig,
  type PadroneProgress,
  type PadroneProgressDefaults,
  type PadroneProgressRenderer,
  padroneAutoOutput,
  padroneLogger,
  padroneProgress,
  padroneUpdateCheck,
  padroneUpgrade,
} from 'padrone';
import type { PadroneOutputIndicator } from '#src/output/output-indicator.ts';
import { createUpdateChecker, isNewerVersion } from '../src/feature/update-check.ts';

const quiet = { output: () => {}, error: () => {} };

function createCapture() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: { output: (...args: unknown[]) => output.push(args.map(String).join(' ')), error: (text: string) => errors.push(text) },
  };
}

function createMockProgress() {
  const indicators: { message: string; calls: string[] }[] = [];
  const factory: PadroneProgressRenderer = (message) => {
    const calls: string[] = [];
    indicators.push({ message, calls });
    const indicator: PadroneProgress = {
      update: () => {},
      succeed: (msg) => calls.push(`succeed:${msg ?? ''}`),
      fail: (msg) => calls.push(`fail:${msg ?? ''}`),
      stop: () => calls.push('stop'),
      eta: { start() {}, stop() {}, reset() {} },
      pause: () => {},
      resume: () => {},
    };
    return indicator;
  };
  return { factory, indicators };
}

describe('logger', () => {
  const run = (argv: string) => {
    const { errors, runtime } = createCapture();
    createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger())
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.trace('t');
          ctx.context.logger.debug('d');
        }),
      )
      .eval(argv);
    return errors;
  };

  it('treats --verbose=false and --verbose=0 as off, and --verbose=2 as trace', () => {
    expect(run('test --verbose=false')).toEqual([]);
    expect(run('test --verbose=0')).toEqual([]);
    expect(run('test --verbose')).toEqual(['[DEBUG] d']);
    expect(run('test --verbose=2')).toEqual(['[TRACE] t', '[DEBUG] d']);
  });

  it('stringifies objects for %s and prints NaN for a symbol with %d/%i/%f', () => {
    const { errors, runtime } = createCapture();
    const result = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger())
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.info('%s', { a: 1 });
          ctx.context.logger.info('%d %i %f', Symbol('x'), Symbol('y'), Symbol('z'));
        }),
      )
      .eval('test');
    expect(result.error).toBeUndefined();
    expect(errors).toEqual(['[INFO] {"a":1}', '[INFO] NaN NaN NaN']);
  });

  it('falls back to the context prefix', () => {
    const { errors, runtime } = createCapture();
    createPadrone('app')
      .runtime(runtime)
      .context<{ loggerConfig: PadroneLoggerConfig }>()
      .extend(padroneLogger())
      .command('test', (c) => c.action((_args, ctx) => ctx.context.logger.info('hi')))
      .eval('test', { context: { loggerConfig: { prefix: '[app]' } } });
    expect(errors).toEqual(['[INFO] [app] hi']);
  });
});

describe('auto-output', () => {
  it('skips the return value when an async action used output.*', async () => {
    const outputs: unknown[] = [];
    const program = createPadrone('test')
      .runtime({ output: (...args: unknown[]) => outputs.push(...args) })
      .command('cmd', (c) =>
        c.action(async (_args, ctx) => {
          await Promise.resolve();
          (ctx.context as { output: PadroneOutputIndicator }).output.raw('manual');
          return 'returned';
        }),
      );
    await program.eval('cmd');
    expect(outputs).toEqual(['manual']);
  });

  it('closes a stream when outputting an item throws', async () => {
    let closed = 0;
    const output = () => {
      throw new Error('EPIPE');
    };
    const program = createPadrone('test')
      .runtime({ output, error: () => {} })
      .command('sync', (c) =>
        c.action(function* () {
          try {
            yield 1;
            yield 2;
          } finally {
            closed++;
          }
        }),
      )
      .command('async', (c) =>
        c.action(async function* () {
          try {
            yield 1;
            yield 2;
          } finally {
            closed++;
          }
        }),
      );
    expect((program.eval('sync').error as Error).message).toBe('EPIPE');
    expect(((await program.eval('async')).error as Error).message).toBe('EPIPE');
    expect(closed).toBe(2);
  });
});

describe('progress', () => {
  it('succeeds only once the caller consumed the stream', async () => {
    const { factory, indicators } = createMockProgress();
    const program = createPadrone('test')
      .runtime(quiet)
      .command('cmd', (c) =>
        c
          .extend(padroneAutoOutput({ disabled: true }))
          .extend(padroneProgress({ message: 'Streaming', renderer: factory }))
          .action(async function* () {
            yield 1;
            yield 2;
          }),
      );
    const { result } = await program.eval('cmd');
    expect(indicators[0]!.calls).toEqual([]);
    const items: unknown[] = [];
    for await (const item of result as AsyncIterable<unknown>) items.push(item);
    expect(items).toEqual([1, 2]);
    expect(indicators[0]!.calls).toEqual(['succeed:']);
  });

  it('stops the indicator when the consumer breaks early', async () => {
    const { factory, indicators } = createMockProgress();
    const program = createPadrone('test')
      .runtime(quiet)
      .command('async', (c) =>
        c
          .extend(padroneAutoOutput({ disabled: true }))
          .extend(padroneProgress({ message: 'Streaming', renderer: factory }))
          .action(async function* () {
            yield 1;
            yield 2;
          }),
      )
      .command('sync', (c) =>
        c
          .extend(padroneAutoOutput({ disabled: true }))
          .extend(padroneProgress({ message: 'Streaming', renderer: factory }))
          .action(function* () {
            yield 1;
            yield 2;
          }),
      );
    for await (const _ of (await program.eval('async')).result as AsyncIterable<unknown>) break;
    for (const _ of program.eval('sync').result as Iterable<unknown>) break;
    expect(indicators.map((i) => i.calls)).toEqual([['stop'], ['stop']]);
  });

  it('applies context messages when called without arguments', () => {
    const { factory, indicators } = createMockProgress();
    createPadrone('test')
      .runtime(quiet)
      .context<{ progressConfig: PadroneProgressDefaults }>()
      .command('cmd', (c) => c.extend(padroneProgress()).action(() => 'ok'))
      .eval('cmd', { context: { progressConfig: { renderer: factory, message: { progress: 'Building', success: 'Built' } } } });
    expect(indicators).toEqual([{ message: 'Building', calls: ['succeed:Built'] }]);
  });

  it('falls back to "Working..." without any message', () => {
    const { factory, indicators } = createMockProgress();
    createPadrone('test')
      .runtime(quiet)
      .command('cmd', (c) => c.extend(padroneProgress({ renderer: factory })).action(() => 'ok'))
      .eval('cmd');
    expect(indicators[0]!.message).toBe('Working...');
  });

  it('estimates the ETA from the first and latest samples only', () => {
    const stderr = process.stderr as unknown as Record<string, unknown>;
    const original = { isTTY: stderr.isTTY, write: stderr.write, now: Date.now };
    const lastLine = (times: number[]) => {
      const writes: string[] = [];
      stderr.write = (chunk: string) => writes.push(String(chunk)) > 0;
      Date.now = () => 0;
      const progress = createTerminalProgress('x', { eta: true, spinner: false, bar: false });
      for (const t of times) {
        Date.now = () => t * 1000;
        progress.update(t / 200);
      }
      const line = writes.filter((w) => w.includes('ETA')).at(-1);
      progress.stop();
      return line;
    };
    Object.defineProperty(stderr, 'isTTY', { value: true, configurable: true, writable: true });
    // The renderer doesn't animate in CI or on a dumb terminal
    const env = { CI: process.env.CI, TERM: process.env.TERM };
    delete process.env.CI;
    delete process.env.TERM;
    try {
      const many = lastLine(Array.from({ length: 100 }, (_, i) => i + 1));
      expect(many).toContain('ETA');
      expect(many).toBe(lastLine([1, 100]));
    } finally {
      for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
      Object.defineProperty(stderr, 'isTTY', { value: original.isTTY, configurable: true, writable: true });
      stderr.write = original.write;
      Date.now = original.now;
    }
  });
});

describe('padroneUpgrade', () => {
  let server: ReturnType<typeof Bun.serve>;
  let latest = '2.0.0';
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ 'dist-tags': { latest } }) });
  });
  afterAll(() => server.stop(true));

  const create = (options: Parameters<typeof padroneUpgrade>[0] = {}) => {
    const exec = mock(async (_command: readonly string[]) => 0);
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .runtime(quiet)
      .extend(padroneUpgrade({ registry: server.url.href, installer: 'bun', exec, ...options }));
    return { program, exec };
  };

  it('decides from the script path before the runtime path', () => {
    expect(detectInstaller(['/opt/homebrew/lib/node_modules/tool/cli.js', '/opt/homebrew/bin/node'])).toBe('npm');
    expect(detectInstaller(['/home/u/.local/share/pnpm/global/5/node_modules/tool/cli.js', '/home/u/.bun/bin/bun'])).toBe('pnpm');
    expect(detectInstaller(['/home/u/.config/yarn/global/node_modules/tool/cli.js', '/home/u/.bun/bin/bun'])).toBe('yarn');
    expect(detectInstaller(['/$bunfs/root/tool', '/opt/homebrew/Cellar/tool/1.0.0/bin/tool'])).toBe('brew');
    expect(detectInstaller(['/$bunfs/root/tool', '/home/u/.bun/bin/tool'])).toBe('bun');
    expect(detectInstaller(['/home/u/proj/cli.js', '/opt/homebrew/Cellar/node/22.0.0/bin/node'])).toBe('npm');
    expect(detectInstaller(['/home/u/proj/cli.js', '/home/u/.bun/bin/bun'])).toBe('npm');
    expect(detectInstaller([undefined, undefined])).toBe('npm');
  });

  it('rejects --to and --channel with Homebrew', async () => {
    const { program, exec } = create({ installer: 'brew' });
    expect(((await program.eval('upgrade --to 1.5.0')).error as Error).name).toBe('ActionError');
    expect(((await program.eval('upgrade --channel next')).error as Error).name).toBe('ActionError');
    expect(((await program.eval('upgrade --to 1.5.0 --dry-run')).error as Error).name).toBe('ActionError');
    expect(exec).not.toHaveBeenCalled();
    expect((await program.eval('upgrade')).result as unknown).toBe('Upgraded tool to 2.0.0');
    expect(exec).toHaveBeenCalledWith(['brew', 'upgrade', 'tool']);
  });

  it('rejects versions and tags that are not plain identifiers', async () => {
    const { program, exec } = create();
    expect(((await program.eval(['upgrade', '--to', '2.0.0&calc'])).error as Error).message).toBe('Invalid version "2.0.0&calc"');
    expect(((await program.eval(['upgrade', '--channel', 'a b'])).error as Error).message).toBe('Invalid channel "a b"');
    latest = '2.0.0|calc';
    try {
      expect(((await program.eval('upgrade')).error as Error).message).toBe('Invalid version "2.0.0|calc"');
    } finally {
      latest = '2.0.0';
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('treats a leading v as the same version', async () => {
    const { program, exec } = create();
    expect((await program.eval('upgrade --to v1.0.0')).result as unknown).toBe('tool is up to date (1.0.0)');
    await program.eval('upgrade --to v1.5.0');
    expect(exec).toHaveBeenCalledWith(['bun', 'add', '-g', 'tool@1.5.0']);
  });
});

describe('update check', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('does not print the notice after the upgrade command', async () => {
    const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-update-')), 'cache.json');
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now(), latestVersion: '2.0.0' }));
    const errors: string[] = [];
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .extend(padroneUpdateCheck({ cache }))
      .extend(padroneUpgrade({ installer: 'bun', exec: async () => 0 }))
      .runtime({ output: () => {}, error: (text) => errors.push(text), env: () => ({}), terminal: { isTTY: true } })
      .command('hello', (c) => c.action(() => 'hello'));
    await program.cli({ runtime: { argv: () => ['upgrade', '--to', '2.0.0'] } });
    await settle();
    expect(errors.join('')).not.toContain('Update available');
    await program.cli({ runtime: { argv: () => ['hello'] } });
    await settle();
    expect(errors.join('')).toContain('Update available');
  });

  it('ignores build metadata when comparing versions', () => {
    expect(isNewerVersion('1.0.0', '1.0.0+build.5')).toBe(false);
    expect(isNewerVersion('1.0.0+build.5', '1.0.1')).toBe(true);
    expect(isNewerVersion('1.0.0-beta.1+sha', '1.0.0')).toBe(true);
  });

  it('only expands ~ and ~/ in the cache path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-cache-'));
    fs.writeFileSync(path.join(dir, '~cache.json'), JSON.stringify({ lastCheck: Date.now(), latestVersion: '2.0.0' }));
    const errors: string[] = [];
    const runtime = { error: (text: string) => errors.push(text), env: () => ({}), terminal: { isTTY: true } };
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const { notify } = await createUpdateChecker(
        'tool',
        '1.0.0',
        { cache: '~cache.json', registry: 'http://127.0.0.1:9/' },
        runtime as never,
      );
      notify();
    } finally {
      process.chdir(cwd);
    }
    expect(errors.join('')).toContain('Update available: 1.0.0 → 2.0.0');
  });
});
