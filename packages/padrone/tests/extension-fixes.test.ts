import { describe, expect, it, mock } from 'bun:test';
import type { PadroneProgress } from 'padrone';
import {
  createPadrone,
  defineInterceptor,
  padroneAutoOutput,
  padroneConfig,
  padroneConfirm,
  padroneEnv,
  padroneJson,
  padroneLogger,
  padroneProgress,
} from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol } from '../src/core/commands.ts';
import { getCompletions } from '../src/feature/complete.ts';
import { createMcpHandler } from '../src/feature/mcp.ts';
import { createServeHandler } from '../src/feature/serve.ts';

const capture = () => {
  const output: unknown[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: {
      output: (...args: unknown[]) => output.push(args.length === 1 ? args[0] : args.join(' ')),
      error: (t: string) => errors.push(t),
    },
  };
};

describe('MCP and serve arguments', () => {
  const program = createPadrone('app')
    .arguments(z.object({ text: z.string().optional() }))
    .action((args) => `root:${args.text ?? ''}`)
    .command('echo', (c) =>
      c
        .arguments(
          z.object({
            text: z.string().optional(),
            tag: z.string().array().optional(),
            db: z.object({ host: z.string(), port: z.coerce.number() }).optional(),
            local: z.boolean().optional(),
          }),
          { fields: { local: { negative: 'remote' } } },
        )
        .action((args) => args),
    )
    .command('one', (c) => c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => args.name));
  const root = (program as any)[commandSymbol];

  it('passes values with spaces and quotes, arrays, objects and custom negatives intact over MCP', async () => {
    const handler = createMcpHandler(root, program.eval.bind(program) as any);
    const arguments_ = { text: 'say "hi" now', tag: ['a b', 'c'], db: { host: 'h', port: 5 }, local: false };
    const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: arguments_ } });
    const content = (res?.result as { content: { text: string }[]; isError: boolean }).content;
    expect((res?.result as { isError: boolean }).isError).toBe(false);
    // The result once, not also the auto-output copy
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0]!.text)).toEqual(arguments_);
  });

  it('names the root tool after the program and answers no notifications', async () => {
    const handler = createMcpHandler(root, program.eval.bind(program) as any);
    const list = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (list?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain('app');
    expect(names).not.toContain('');
    const call = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'app', arguments: { text: 'x' } } });
    expect((call?.result as { content: { text: string }[] }).content[0]!.text).toBe('root:x');
    expect(await handler({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'app', arguments: {} } })).toBeUndefined();
  });

  it('serve routes under a basePath without a trailing slash and 404s outside it', async () => {
    const handler = createServeHandler(root, program.eval.bind(program) as any, { basePath: '/api' });
    const ok = await handler(new Request('http://localhost/api/echo?text=hello%20world'));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { text: string } }).result.text).toBe('hello world');
    expect((await handler(new Request('http://localhost/echo'))).status).toBe(404);
  });

  it('serve maps bad input to 400, validation errors through onError, and an empty POST body to no args', async () => {
    const onError = mock((error: unknown) => Response.json({ custom: (error as Error).message }, { status: 422 }));
    const handler = createServeHandler(root, program.eval.bind(program) as any, { onError });
    const extra = await handler(new Request('http://localhost/one?_=a&_=b'));
    expect(extra.status).toBe(422);
    const invalid = await handler(new Request('http://localhost/one', { method: 'POST', body: '{}' }));
    expect(invalid.status).toBe(422);
    expect(onError).toHaveBeenCalledTimes(2);
    const plain = createServeHandler(root, program.eval.bind(program) as any);
    expect((await plain(new Request('http://localhost/one?_=a&_=b'))).status).toBe(400);
    const empty = await plain(new Request('http://localhost/echo', { method: 'POST' }));
    expect(empty.status).toBe(200);
  });

  it('serve answers 500 when onRequest throws', async () => {
    const handler = createServeHandler(root, program.eval.bind(program) as any, {
      onRequest: () => {
        throw new Error('boom');
      },
    });
    const res = await handler(new Request('http://localhost/echo'));
    expect(res.status).toBe(500);
  });

  it('tool() returns the result without a duplicate in logs', async () => {
    const tool = program.tool();
    const res = (await tool.execute!({ command: 'one x' }, {} as any)) as { result: unknown; logs: string };
    expect(res.result).toBe('x');
    expect(res.logs).toBe('');
  });
});

describe('auto-output', () => {
  it('prints iterables such as Set or Uint8Array as values, not item by item', () => {
    const { output, runtime } = capture();
    const program = createPadrone('app')
      .runtime(runtime)
      .command('set', (c) => c.action(() => new Set([1, 2])))
      .command('bytes', (c) => c.action(() => new Uint8Array([104, 105])));
    expect(program.eval('set').result).toBeInstanceOf(Set);
    program.eval('bytes');
    expect(output).toHaveLength(2);
  });

  it('applies --jq before a declarative output format', async () => {
    const { output, runtime } = capture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneJson())
      .command('users', (c) => c.extend(padroneAutoOutput({ output: 'table' })).action(() => [{ name: 'a' }, { name: 'b' }]));
    await program.cli({ runtime: { argv: () => ['users', '--jq', '.[].name'] } });
    expect(output).toEqual(['a', 'b']);
  });
});

describe('boolean framework flags', () => {
  it('--yes=false still asks, and --json=false keeps text output', async () => {
    const prompt = mock(async () => false);
    const ran = mock(() => 'dropped');
    const { output, runtime } = capture();
    const program = createPadrone('db')
      .runtime({ ...runtime, prompt, interactive: 'supported', setExitCode: () => {} })
      .extend(padroneConfirm())
      .extend(padroneJson())
      .command('drop', (c) => c.configure({ mutation: true }).action(ran))
      .command('obj', (c) => c.action(() => 'text'));
    await program.cli({ runtime: { argv: () => ['drop', '--yes=false'] } });
    expect(prompt).toHaveBeenCalled();
    expect(ran).not.toHaveBeenCalled();
    await program.cli({ runtime: { argv: () => ['obj', '--json=false'] } });
    expect(output.at(-1)).toBe('text');
  });

  it('--help=false and --no-version are consumed without showing help or the version', () => {
    const program = createPadrone('app')
      .configure({ version: '1.0.0' })
      .command('run', (c) => c.action(() => 'ran'));
    expect(program.eval('run --help=false').result).toBe('ran');
    expect(program.eval('run --no-version').result).toBe('ran');
  });
});

describe('signal', () => {
  it('exits with the signal code when the action throws the abort reason', async () => {
    let send: ((sig: 'SIGINT') => void) | undefined;
    const setExitCode = mock((_code: number) => {});
    const program = createPadrone('app')
      .runtime({
        output: () => {},
        error: () => {},
        setExitCode,
        onSignal: (cb) => {
          send = cb;
          return () => {};
        },
      })
      .command('wait', (c) =>
        c.action((_args, ctx) => {
          send?.('SIGINT');
          ctx.signal.throwIfAborted();
        }),
      );
    const result = await program.cli({ runtime: { argv: () => ['wait'] } });
    expect(result.exitCode).toBe(130);
    expect(setExitCode).toHaveBeenCalledWith(130);
  });
});

describe('progress', () => {
  const renderer = () => {
    const calls: string[] = [];
    const indicator: PadroneProgress = {
      update: () => {},
      succeed: (msg) => calls.push(`succeed:${msg ?? ''}`),
      fail: (msg) => calls.push(`fail:${msg ?? ''}`),
      stop: () => calls.push('stop'),
      eta: { start() {}, stop() {}, reset() {} },
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
    };
    return { calls, factory: () => indicator };
  };

  it('lets shutdown handlers inside it run', async () => {
    const shutdown = mock(() => {});
    const { factory } = renderer();
    const program = createPadrone('app')
      .runtime({ output: () => {}, error: () => {} })
      .extend(padroneProgress({ message: 'Working', renderer: factory }))
      .intercept(
        defineInterceptor({ name: 'after', order: 10 }, () => ({
          shutdown: (_ctx, next) => {
            shutdown();
            return next();
          },
        })),
      )
      .command('run', (c) => c.action(() => 'ok'));
    await program.eval('run');
    expect(shutdown).toHaveBeenCalled();
  });

  it('succeeds once a streamed result is consumed, and fails when the stream throws', async () => {
    const { calls, factory } = renderer();
    const program = createPadrone('app')
      .runtime({ output: () => calls.push('output'), error: () => {} })
      .command('stream', (c) =>
        c.extend(padroneProgress({ message: 'Streaming', renderer: factory })).action(async function* () {
          yield 1;
          throw new Error('broke');
        }),
      );
    await program.eval('stream');
    expect(calls.indexOf('fail:broke')).toBeGreaterThan(calls.indexOf('output'));
    expect(calls).not.toContain('succeed:Streaming');
  });

  it('marks a task failed when its skip() throws', async () => {
    let states: { title: string; status: string }[] = [];
    const program = createPadrone('app')
      .runtime({ output: () => {}, error: () => {} })
      .command('tasks', (c) =>
        c
          .extend(
            padroneProgress({
              message: 'Tasks',
              silent: false,
              renderer: renderer().factory,
              taskRenderer: (s) => {
                states = s as never;
                return { update() {}, pause() {}, resume() {}, done() {} };
              },
            }),
          )
          .async()
          .action(async (_args, ctx) => {
            await ctx.context.progress.tasks(
              [
                {
                  title: 'bad',
                  skip: () => {
                    throw new Error('nope');
                  },
                  task: () => {},
                },
                { title: 'good', task: () => {} },
              ],
              { exitOnError: false },
            );
          }),
      );
    const result = await program.eval('tasks');
    expect((result.error as Error).message).toBe('nope');
    expect(states.map((s) => s.status)).toEqual(['failed', 'done']);
  });
});

describe('logger', () => {
  const program = createPadrone('app')
    .runtime({ output: () => {}, error: () => {} })
    .extend(padroneLogger())
    .command('run', (c) => c.action((_args, ctx) => ctx.context.logger.level));

  it('accepts --log-level in any case and rejects unknown levels', () => {
    expect(program.eval('run --log-level WARN').result).toBe('warn');
    expect((program.eval('run --log-level=bogus').error as Error).message).toContain('Invalid log level "bogus"');
  });
});

describe('config', () => {
  const load = (data: Record<string, unknown>) => padroneConfig({ files: ['app.json'], loadConfig: () => data });

  it('applies only the keys a command has options for, by name, alias or kebab-case', () => {
    const program = createPadrone('app')
      .extend(load({ port: 1, token: 't', 'dry-run': true }))
      .command('serve', (c) => c.arguments(z.object({ port: z.number(), dryRun: z.boolean().optional() })).action((args) => args))
      .command('login', (c) => c.arguments(z.object({ token: z.string() })).action((args) => args))
      .command('noargs', (c) => c.action(() => 'ok'));
    expect(program.eval('serve').result).toEqual({ port: 1, dryRun: true });
    expect(program.eval('login').result).toEqual({ token: 't' });
    expect(program.eval('noargs').result).toBe('ok');
  });

  it('treats null as unset, fills nested objects key by key, and leaves positionals to the command line', () => {
    const program = createPadrone('app')
      .extend(load({ port: null, db: { host: 'cfg', port: 5 }, name: 'cfg' }))
      .command('run', (c) =>
        c
          .arguments(
            z.object({ name: z.string(), port: z.number().default(3), db: z.object({ host: z.string(), port: z.coerce.number() }) }),
            { positional: ['name'] },
          )
          .action((args) => args),
      );
    expect(program.eval('run bob --db.host=cli').result).toEqual({ name: 'bob', port: 3, db: { host: 'cli', port: 5 } });
  });

  it('applies config before interactive prompts', async () => {
    const prompt = mock(async () => 'prompted');
    const program = createPadrone('app')
      .runtime({ output: () => {}, error: () => {}, prompt, interactive: 'supported' })
      .extend(load({ name: 'cfg' }))
      .command('run', (c) => c.arguments(z.object({ name: z.string() }), { interactive: true }).action((args) => args.name));
    expect((await program.eval('run')).result).toBe('cfg');
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('env', () => {
  it('leaves positionals typed on the command line to the command line', () => {
    const program = createPadrone('app')
      .runtime({ env: () => ({ APP_NAME: 'env' }) })
      .extend(padroneEnv({ prefix: 'APP' }))
      .command('greet', (c) => c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => args.name));
    expect(program.eval('greet bob').result).toBe('bob');
    expect(program.eval('greet').result).toBe('env');
  });
});

describe('help and version', () => {
  it('reports `help <unknown>` as an unknown command', async () => {
    const { errors, runtime } = capture();
    const program = createPadrone('app')
      .runtime({ ...runtime, setExitCode: () => {} })
      .command('deploy', (c) => c.action(() => 'ok'));
    const result = await program.cli({ runtime: { argv: () => ['help', 'nope'] } });
    expect((result.error as Error).message).toBe('Unknown command: nope');
    expect(errors.join('\n')).toContain('deploy');
  });

  it('lists only the built-ins that are registered', () => {
    const program = createPadrone('app', { builtins: { version: false, repl: false } }).command('run', (c) => c.action(() => {}));
    const help = program.help(undefined, { format: 'text', all: true } as never) as string;
    expect(help).toContain('help [command]');
    expect(help).not.toContain('completion [shell]');
    expect(help).not.toContain('--repl');
    expect(help).not.toContain('version,');
  });

  it('keeps extension flags with --version', async () => {
    const { output, runtime } = capture();
    const program = createPadrone('app').configure({ version: '1.2.3' }).runtime(runtime).extend(padroneJson());
    await program.cli({ runtime: { argv: () => ['--json', '--version'] } });
    expect(output).toEqual(['"1.2.3"']);
  });

  it('suggests option names as help shows them', () => {
    const program = createPadrone('app').command('build', (c) => c.arguments(z.object({ outDir: z.string().optional() })).action(() => {}));
    const issues = program.eval('build --outdir x').argsResult?.issues ?? [];
    expect(issues[0]?.message).toContain('--out-dir');
  });
});

describe('repl', () => {
  it('ignores --no-repl and --repl=false', () => {
    const program = createPadrone('app').command('run', (c) => c.action(() => 'ran'));
    expect(program.eval('run --no-repl').result).toBe('ran');
    expect(program.eval('run --repl=false').result).toBe('ran');
  });

  it('uses the runtime given to cli() and returns nothing to print from the repl command', async () => {
    const lines = ['run', null];
    const output: unknown[] = [];
    const program = createPadrone('app').command('run', (c) => c.action(() => 'ran'));
    const result = await program.cli({
      runtime: {
        argv: () => ['repl'],
        readLine: async () => lines.shift() ?? null,
        output: (...args: unknown[]) => output.push(args[0]),
        error: () => {},
      },
    });
    expect(result.result).toBeUndefined();
    expect(output).toContain('ran');
  });
});

describe('dynamic completion', () => {
  it('skips the value of an option an extension declares', async () => {
    const program = createPadrone('app')
      .extend(padroneConfig({ files: ['app.json'], loadConfig: () => undefined }))
      .command('build', (c) => c.action(() => {}));
    const root = (program as any)[commandSymbol];
    expect(await getCompletions(root, ['-c', 'x.json', 'bu'])).toEqual(['build']);
    expect(await getCompletions(root, ['-c', ''])).toEqual([]);
  });
});
