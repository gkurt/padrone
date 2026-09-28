import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PadroneLogger, PadroneLoggerConfig, PadroneProgress, PadroneProgressContext, PadroneSignal, PadroneTaskState } from 'padrone';
import { createPadrone, createSimpleTaskList, createTerminalTaskList, padroneLogger, padroneProgress, padroneTiming } from 'padrone';
import { createDefaultRuntime } from '../src/core/default-runtime.ts';
import { systemOpenCommand } from '../src/feature/system.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replaces `target[key]` for the duration of `fn`. */
async function withProperty<T extends object>(target: T, key: string, value: unknown, fn: () => unknown | Promise<unknown>) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  try {
    await fn();
  } finally {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete (target as Record<string, unknown>)[key];
  }
}

/** Sets environment variables (`undefined` unsets) for the duration of `fn`. */
async function withEnv(env: Record<string, string | undefined>, fn: () => unknown | Promise<unknown>) {
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  set(env);
  try {
    await fn();
  } finally {
    set(original);
  }
}

/** Records what's written to `process.stderr`, optionally as a color terminal. */
async function captureStderr(fn: () => unknown | Promise<unknown>, tty = false): Promise<string> {
  const writes: string[] = [];
  const stderr = process.stderr as unknown as Record<string, unknown>;
  const write = stderr.write;
  stderr.write = (chunk: string) => writes.push(String(chunk)) > 0;
  try {
    if (tty) await withEnv({ CI: undefined, TERM: 'xterm' }, () => withProperty(process.stderr, 'isTTY', true, fn));
    else await withProperty(process.stderr, 'isTTY', false, fn);
  } finally {
    stderr.write = write;
  }
  return writes.join('');
}

// ── Logger ──────────────────────────────────────────────────────────────

function logLines(config: PadroneLoggerConfig, fn: (logger: PadroneLogger) => void) {
  const errors: string[] = [];
  const output: string[] = [];
  const program = createPadrone('tool')
    .extend(padroneLogger({ level: 'trace', ...config }))
    .command('a', (c) => c.action((_args, ctx) => fn(ctx.context.logger)));
  program.eval('a', { runtime: { output: (text) => output.push(String(text)), error: (text) => errors.push(text) } });
  return { errors, output };
}

const jsonLines = (config: PadroneLoggerConfig, fn: (logger: PadroneLogger) => void) =>
  logLines({ format: 'json', ...config }, fn).errors.map((line) => JSON.parse(line) as Record<string, any>);

describe('logger redact', () => {
  it('censors paths in the fields object, with wildcards and array indexes', () => {
    const user = { name: 'ada', password: 'secret' };
    const [line] = jsonLines({ redact: ['user.password', '*.token', 'items[*].key', 'headers["x-api-key"]'] }, (logger) =>
      logger.info(
        {
          user,
          auth: { token: 't' },
          other: { token: 'u' },
          items: [{ key: 1 }, { key: 2 }],
          headers: { 'x-api-key': 'k', accept: '*/*' },
        },
        'signed in',
      ),
    );
    expect(line!.user).toEqual({ name: 'ada', password: '[Redacted]' });
    expect(line!.auth.token).toBe('[Redacted]');
    expect(line!.other.token).toBe('[Redacted]');
    expect(line!.items).toEqual([{ key: '[Redacted]' }, { key: '[Redacted]' }]);
    expect(line!.headers).toEqual({ 'x-api-key': '[Redacted]', accept: '*/*' });
    expect(line!.msg).toBe('signed in');
    // The logged object isn't changed
    expect(user.password).toBe('secret');
  });

  it('uses a custom censor and leaves missing paths alone', () => {
    const [line] = jsonLines({ redact: { paths: ['password', 'missing.key'], censor: '***' } }, (logger) => logger.info({ password: 'x' }));
    expect(line!.password).toBe('***');
    expect('missing' in line!).toBe(false);
  });

  it('censors object arguments in text lines and child bindings', () => {
    const { errors } = logLines({ redact: ['password', 'token'] }, (logger) => {
      logger.info('login', { user: 'ada', password: 'x' });
      logger.child({ token: 'abc', requestId: 'r1' }).info('request');
    });
    expect(errors[0]).toBe('[INFO] login {"user":"ada","password":"[Redacted]"}');
    expect(errors[1]).toBe('[INFO] request token=[Redacted] requestId=r1');
  });
});

describe('logger child bindings', () => {
  it('adds bindings to text lines', () => {
    const { errors } = logLines({}, (logger) => {
      const request = logger.child({ requestId: 'abc' });
      request.info('start');
      request.child('db').child({ query: 'select 1' }).debug('run');
    });
    expect(errors).toEqual(['[INFO] start requestId=abc', '[DEBUG] [db] run requestId=abc query="select 1"']);
  });

  it('adds bindings as JSON fields, which call fields override', () => {
    const lines = jsonLines({}, (logger) => {
      const request = logger.child({ requestId: 'abc', user: 'ada' });
      request.info('one');
      request.child('db').info({ user: 'bob' }, 'two');
    });
    expect(lines[0]).toMatchObject({ level: 'info', requestId: 'abc', user: 'ada', msg: 'one' });
    expect(lines[1]).toMatchObject({ name: 'db', requestId: 'abc', user: 'bob', msg: 'two' });
  });
});

describe('logger destination', () => {
  it('writes lines to a function instead of the runtime', () => {
    const lines: string[] = [];
    const { errors, output } = logLines({ destination: (line) => lines.push(line), stdout: true }, (logger) => {
      logger.info('one');
      logger.error('two');
    });
    expect(lines).toEqual(['[INFO] one', '[ERROR] two']);
    expect(errors).toEqual([]);
    expect(output).toEqual([]);
  });

  it('writes lines with a newline to a stream-like writer', () => {
    const chunks: string[] = [];
    logLines({ destination: { write: (chunk) => chunks.push(chunk) }, format: 'json' }, (logger) => logger.warn('careful'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.endsWith('\n')).toBe(true);
    expect(JSON.parse(chunks[0]!)).toMatchObject({ level: 'warn', msg: 'careful' });
  });

  it('appends to a file, without colors', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-log-')), 'app.log');
    fs.writeFileSync(file, 'existing\n');
    const errors: string[] = [];
    const program = createPadrone('tool')
      .extend(padroneLogger({ destination: file }))
      .command('a', (c) => c.action((_args, ctx) => ctx.context.logger.child({ id: 1 }).info('hello')));
    program.eval('a', { runtime: { format: 'ansi', error: (text) => errors.push(text), output: () => {} } });
    expect(fs.readFileSync(file, 'utf-8')).toBe('existing\n[INFO] hello id=1\n');
    expect(errors).toEqual([]);
  });
});

describe('logger colors follow the stream a line goes to', () => {
  const run = (terminal: { isTTY?: boolean; stderrIsTTY?: boolean }, stdout = false) => {
    const errors: string[] = [];
    const output: string[] = [];
    const program = createPadrone('tool')
      .extend(padroneLogger({ stdout }))
      .command('a', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.info('info');
          ctx.context.logger.warn('warn');
        }),
      );
    program.eval('a', {
      runtime: { env: () => ({}), terminal, error: (text) => errors.push(text), output: (text) => output.push(String(text)) },
    });
    return { errors, output };
  };
  const colored = (line?: string) => line?.includes('\x1b[') ?? false;

  it('colors stderr lines when stderr is a terminal, even with stdout piped', () => {
    const { errors } = run({ isTTY: false, stderrIsTTY: true });
    expect(errors.every(colored)).toBe(true);
  });

  it("doesn't color stderr lines when stderr is piped, even with stdout a terminal", () => {
    const { errors } = run({ isTTY: true, stderrIsTTY: false });
    expect(errors.some(colored)).toBe(false);
  });

  it('falls back to isTTY without stderrIsTTY', () => {
    expect(run({ isTTY: true }).errors.every(colored)).toBe(true);
  });

  it('with stdout: true, lines routed to stdout follow stdout', () => {
    const { errors, output } = run({ isTTY: false, stderrIsTTY: true }, true);
    expect(colored(output[0])).toBe(false);
    expect(colored(errors[0])).toBe(true);
  });

  it('the default runtime reports whether stderr is a terminal', () => {
    const terminal = createDefaultRuntime().terminal!;
    expect(terminal.stderrIsTTY).toBe(process.stderr.isTTY === true);
  });
});

// ── Task lists ──────────────────────────────────────────────────────────

describe('task list renderers', () => {
  const tree = (status: PadroneTaskState['status']): PadroneTaskState[] => [
    {
      title: 'Build',
      status,
      subtasks: [
        { title: 'Types', status: 'done', subtasks: [] },
        { title: 'Bundle', status: 'done', subtasks: [] },
      ],
    },
  ];
  const lastFrame = (written: string) => written.split('\x1b[2K\r').at(-1)!;

  it('collapseSubtasks hides the subtasks of a finished task in the live list', async () => {
    const collapsed = await captureStderr(() => {
      const list = createTerminalTaskList(tree('done'), { collapseSubtasks: true });
      list.done();
    }, true);
    expect(lastFrame(collapsed)).toBe('✔ Build\n');

    const expanded = await captureStderr(() => {
      const list = createTerminalTaskList(tree('done'));
      list.done();
    }, true);
    expect(lastFrame(expanded)).toBe('✔ Build\n  ✔ Types\n  ✔ Bundle\n');
  });

  it('keeps the subtasks of a running task', async () => {
    const written = await captureStderr(() => {
      const list = createTerminalTaskList(tree('running'), { collapseSubtasks: true });
      list.done();
    }, true);
    expect(lastFrame(written)).toContain('  ✔ Types');
  });

  it('prints start and finish lines in CI', async () => {
    const written = await captureStderr(
      () =>
        withEnv({ CI: 'true' }, () =>
          withProperty(process.stderr, 'isTTY', true, () => {
            const states: { title: string; status: PadroneTaskState['status']; subtasks: never[]; message?: string }[] = [
              { title: 'Build', status: 'running', subtasks: [] },
            ];
            const list = createTerminalTaskList(states);
            list.update();
            states[0]!.message = 'compiling';
            list.update();
            states[0]!.status = 'done';
            states[0]!.message = undefined;
            list.done();
          }),
        ),
      false,
    );
    expect(written).toBe('❯ Build\n  › compiling\n✔ Build\n');
  });
});

describe('task retry and rollback', () => {
  const runTasks = async (fn: (progress: PadroneProgressContext) => Promise<unknown>) => {
    const snapshots: PadroneTaskState[][] = [];
    const taskRenderer = (states: readonly PadroneTaskState[]) => ({
      update: () => snapshots.push(structuredClone(states) as PadroneTaskState[]),
      pause() {},
      resume() {},
      done() {},
    });
    const program = createPadrone('app').command('run', (c) =>
      c.extend(padroneProgress({ renderer: mockRenderer, taskRenderer })).action((_args, ctx) => fn(ctx.context.progress)),
    );
    const result = await program.eval('run');
    return { error: result.error as Error | undefined, snapshots, final: snapshots.at(-1)! };
  };

  it('retries a failing task', async () => {
    const attempts: { count: number; error?: string }[] = [];
    const { error, snapshots, final } = await runTasks((progress) =>
      progress.tasks([
        {
          title: 'Fetch',
          retry: 2,
          task: (t) => {
            attempts.push({ count: t.retry.count, error: (t.retry.error as Error | undefined)?.message });
            if (attempts.length < 3) throw new Error(`attempt ${attempts.length}`);
          },
        },
      ]),
    );
    expect(error).toBeUndefined();
    expect(attempts).toEqual([{ count: 0 }, { count: 1, error: 'attempt 1' }, { count: 2, error: 'attempt 2' }]);
    expect(snapshots.some((s) => s[0]!.retry?.count === 2 && s[0]!.retry.tries === 2 && s[0]!.message === 'attempt 2')).toBe(true);
    expect(final[0]).toMatchObject({ status: 'done' });
    expect(final[0]!.retry).toBeUndefined();
  });

  it('fails with the last error once retries are used up, waiting between attempts', async () => {
    let attempts = 0;
    const started = Date.now();
    const { error, final } = await runTasks((progress) =>
      progress.tasks([
        {
          title: 'Fetch',
          retry: { tries: 2, delay: 15 },
          task: () => {
            throw new Error(`attempt ${++attempts}`);
          },
        },
      ]),
    );
    expect(attempts).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(error?.message).toBe('attempt 3');
    expect(final[0]).toMatchObject({ status: 'failed', message: 'attempt 3' });
  });

  it('rolls back a failed task and still fails', async () => {
    const rolledBack: string[] = [];
    const { error, snapshots, final } = await runTasks((progress) =>
      progress.tasks([
        {
          title: 'Migrate',
          task: () => {
            throw new Error('migration failed');
          },
          rollback: (t, err) => {
            t.update('reverting');
            rolledBack.push((err as Error).message);
          },
        },
        { title: 'Next', task: () => {} },
      ]),
    );
    expect(rolledBack).toEqual(['migration failed']);
    expect(error?.message).toBe('migration failed');
    expect(snapshots.some((s) => s[0]!.status === 'rolling-back')).toBe(true);
    expect(final[0]).toMatchObject({ status: 'rolled-back', message: 'migration failed' });
    expect(final[1]!.status).toBe('pending');
  });

  it('a failing rollback replaces the error', async () => {
    const { error, final } = await runTasks((progress) =>
      progress.tasks([
        {
          title: 'Migrate',
          task: () => {
            throw new Error('migration failed');
          },
          rollback: () => {
            throw new Error('rollback failed');
          },
        },
      ]),
    );
    expect(error?.message).toBe('rollback failed');
    expect(final[0]).toMatchObject({ status: 'failed', message: 'rollback failed' });
  });

  it('the simple renderer prints retries and rollbacks', async () => {
    let attempts = 0;
    const written = await captureStderr(async () => {
      const program = createPadrone('app').command('run', (c) =>
        c.extend(padroneProgress({ renderer: mockRenderer, taskRenderer: createSimpleTaskList })).action((_args, ctx) =>
          ctx.context.progress.tasks([
            {
              title: 'Deploy',
              retry: 1,
              task: () => {
                throw new Error(`attempt ${++attempts}`);
              },
              rollback: () => {},
            },
          ]),
        ),
      );
      await program.eval('run');
    });
    expect(written).toBe('❯ Deploy\n↻ Deploy [retry 1/1]: attempt 1\n↩ Deploy [rolling back]\n↩ Deploy [rolled back]: attempt 2\n');
  });
});

// ── Progress ────────────────────────────────────────────────────────────

const mockRenderer = (): PadroneProgress => ({
  update() {},
  eta: { start() {}, stop() {}, reset() {} },
  succeed() {},
  fail() {},
  stop() {},
  pause() {},
  resume() {},
});

describe('progress isActive / isPaused', () => {
  it('follows the indicator', async () => {
    const seen: Record<string, boolean>[] = [];
    let handle: PadroneProgressContext | undefined;
    const program = createPadrone('app').command('run', (c) =>
      c.extend(padroneProgress({ renderer: mockRenderer })).action(async (_args, ctx) => {
        handle = ctx.context.progress;
        const snap = () => seen.push({ active: handle!.isActive, paused: handle!.isPaused });
        snap();
        handle.pause();
        snap();
        ctx.runtime.output('while paused');
        snap();
        handle.resume();
        snap();
        await handle.tasks([{ title: 'Task', task: snap }]);
      }),
    );
    await program.eval('run', { runtime: { output: () => {} } });
    expect(seen).toEqual([
      { active: true, paused: false },
      { active: true, paused: true },
      { active: true, paused: true },
      { active: true, paused: false },
      { active: true, paused: false },
    ]);
    expect(handle!.isActive).toBe(false);
  });

  it('is never active when silent', async () => {
    let active: boolean | undefined;
    const program = createPadrone('app').command('run', (c) =>
      c.extend(padroneProgress({ silent: true })).action((_args, ctx) => {
        active = ctx.context.progress.isActive;
      }),
    );
    await program.eval('run');
    expect(active).toBe(false);
  });
});

// ── Signal ──────────────────────────────────────────────────────────────

describe('signal force exit', () => {
  const run = async (builtins: { signal?: { forceExitMs?: number; onForceExit?: (signal: PadroneSignal) => void } }, gap = 5) => {
    const events: string[] = [];
    let send: ((signal: PadroneSignal) => void) | undefined;
    const program = createPadrone('tool', { builtins })
      .runtime({
        onSignal: (cb: (signal: PadroneSignal) => void) => {
          send = cb;
          return () => {
            send = undefined;
          };
        },
        exit: ((code: number) => {
          events.push(`exit ${code}`);
        }) as (code: number) => never,
      })
      .command('slow', (c) =>
        c.async().action(async () => {
          send?.('SIGINT');
          await sleep(gap);
          send?.('SIGINT');
        }),
      );
    await program.eval('slow');
    return events;
  };

  it('force-exits on a second Ctrl+C within the window, after onForceExit', async () => {
    const events = await run({});
    expect(events).toEqual(['exit 130']);
    const hooked: string[] = [];
    const withHook = await run({ signal: { onForceExit: (sig) => hooked.push(`cleanup ${sig}`) } });
    expect(hooked).toEqual(['cleanup SIGINT']);
    expect(withHook).toEqual(['exit 130']);
  });

  it('forceExitMs sets the window; 0 turns the double-tap off', async () => {
    expect(await run({ signal: { forceExitMs: 10 } }, 30)).toEqual([]);
    expect(await run({ signal: { forceExitMs: 100 } }, 30)).toEqual(['exit 130']);
    expect(await run({ signal: { forceExitMs: 0 } })).toEqual([]);
  });

  it('exits even when onForceExit throws', async () => {
    const events = await run({
      signal: {
        onForceExit: () => {
          throw new Error('cleanup failed');
        },
      },
    });
    expect(events).toEqual(['exit 130']);
  });
});

// ── Timing ──────────────────────────────────────────────────────────────

describe('timing', () => {
  const fail = () => {
    throw new Error('boom');
  };

  it('says "Failed after" when the command fails', async () => {
    const errors: string[] = [];
    const program = createPadrone('tool')
      .extend(padroneTiming({ enabled: true }))
      .command('a', (c) => c.action(fail));
    await program.eval('a', { runtime: { error: (text) => errors.push(text) } });
    expect(errors.at(-1)).toMatch(/^\nFailed after \d+ms$/);
  });

  it('takes a format callback', async () => {
    const errors: string[] = [];
    const infos: unknown[] = [];
    const program = createPadrone('tool')
      .extend(
        padroneTiming({
          enabled: true,
          format: (info) => {
            infos.push(info);
            return info.failed ? null : `took ${info.duration}`;
          },
        }),
      )
      .command('ok', (c) => c.action(() => {}))
      .command('bad', (c) => c.action(fail));
    await program.eval('ok', { runtime: { error: (text) => errors.push(text) } });
    await program.eval('bad', { runtime: { error: (text) => errors.push(text) } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^took \d+ms$/);
    expect(infos[0]).toMatchObject({ failed: false });
    expect(typeof (infos[0] as { elapsed: number }).elapsed).toBe('number');
    expect(infos[1]).toMatchObject({ failed: true, error: expect.any(Error) });
  });

  for (const where of ['root', 'command'] as const) {
    it(`registered on the ${where}, prints the error before the timing line`, async () => {
      const errors: string[] = [];
      const base = createPadrone('tool');
      const program =
        where === 'root'
          ? base.extend(padroneTiming({ enabled: true })).command('a', (c) => c.action(fail))
          : base.command('a', (c) => c.extend(padroneTiming({ enabled: true })).action(fail));
      await program.cli({ runtime: { argv: () => ['a'], error: (text) => errors.push(text), output: () => {}, setExitCode: () => {} } });
      expect(errors).toHaveLength(2);
      expect(errors[0]).toBe('boom');
      expect(errors[1]).toMatch(/^\nFailed after \d+ms$/);
    });
  }

  it('registered on a command, still runs its shutdown once for a sync failure', () => {
    const errors: string[] = [];
    const program = createPadrone('tool').command('a', (c) => c.extend(padroneTiming({ enabled: true })).action(fail));
    program.cli({ runtime: { argv: () => ['a'], error: (text) => errors.push(text), output: () => {}, setExitCode: () => {} } });
    expect(errors[0]).toBe('boom');
    expect(errors[1]).toMatch(/^\nFailed after/);
    expect(errors).toHaveLength(2);
  });
});

// ── System ──────────────────────────────────────────────────────────────

describe('systemOpenCommand', () => {
  it('uses open and xdg-open with the target as one argument', () => {
    expect(systemOpenCommand('/tmp/my file.txt', 'darwin')).toEqual(['open', ['/tmp/my file.txt']]);
    expect(systemOpenCommand('/tmp/my file.txt', 'linux')).toEqual(['xdg-open', ['/tmp/my file.txt']]);
  });

  it('keeps a leading dash from being read as an option and refuses control characters', () => {
    expect(systemOpenCommand('-a evil', 'darwin')).toEqual(['open', ['./-a evil']]);
    expect(systemOpenCommand('--manual', 'linux')).toEqual(['xdg-open', ['./--manual']]);
    expect(() => systemOpenCommand('http://x/\ncalc', 'win32')).toThrow();
  });

  it('quotes paths with spaces for cmd start on Windows', () => {
    expect(systemOpenCommand('C:\\My Files\\a.txt', 'win32')).toEqual(['cmd', ['/d', '/s', '/c', '"start "" ^"C:\\My^ Files\\a.txt^""']]);
  });

  it('escapes cmd metacharacters and encodes quotes', () => {
    const [, args] = systemOpenCommand('https://example.com/?a=1&b=%PATH%|x"y', 'win32');
    expect(args.at(-1)).toBe('"start "" ^"https://example.com/^?a=1^&b=^%PATH^%^|x^%22y^""');
  });
});

// ── Interactive mode ────────────────────────────────────────────────────

describe('default interactive mode', () => {
  const detect = async (env: Record<string, string | undefined>) => {
    let mode: string | undefined;
    await withEnv({ CI: undefined, CONTINUOUS_INTEGRATION: undefined, ...env }, () =>
      withProperty(process.stdout, 'isTTY', true, () =>
        withProperty(process.stdin, 'isTTY', true, () => {
          mode = createDefaultRuntime().interactive;
        }),
      ),
    );
    return mode;
  };

  it('treats CI=false and CI=0 as not CI', async () => {
    expect(await detect({ CI: 'false' })).toBe('supported');
    expect(await detect({ CI: '0' })).toBe('supported');
    expect(await detect({})).toBe('supported');
    expect(await detect({ CI: 'true' })).toBe('disabled');
    expect(await detect({ CONTINUOUS_INTEGRATION: '1' })).toBe('disabled');
  });
});
