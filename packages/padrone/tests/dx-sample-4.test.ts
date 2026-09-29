import { describe, expect, expectTypeOf, it } from 'bun:test';
import {
  ActionError,
  createPadrone,
  defineArgsMeta,
  defineCommand,
  defineEvent,
  defineInterceptor,
  padroneConfig,
  padroneConfirm,
  padroneCredentials,
  padroneFormat,
  padroneJson,
  ValidationError,
} from 'padrone';
import { testCli } from 'padrone/test';
import * as z from 'zod/v4';

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };

describe('async action results', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .command('count', (c) => c.arguments(z.object({ n: z.number().default(1) })).action(async (args) => args.n))
    .command('boom', (c) =>
      c.action(async () => {
        throw new Error('kaboom');
      }),
    );

  it('run() and eval() resolve them, typed as the awaited value', async () => {
    const run = program.run('count', { n: 2 });
    expect(run).toBeInstanceOf(Promise);
    expectTypeOf(run).toExtend<Promise<unknown>>();
    const ran = await run;
    expect(ran.result).toBe(2);
    expectTypeOf(ran.result).toEqualTypeOf<number | undefined>();

    const evaluated = await program.eval('count --n 3');
    expect(evaluated.result).toBe(3);
    expectTypeOf(evaluated.result).toEqualTypeOf<number | undefined>();
  });

  it('run() reports a failing async action in error, like eval()', async () => {
    const ran = await program.run('boom');
    expect((ran.error as Error).message).toBe('kaboom');
  });

  it('do so when the program validates asynchronously', async () => {
    const withConfig = program.extend(padroneConfig({ files: 'missing.json' }));
    const ran = await withConfig.run('count', {});
    expect(ran.result).toBe(1);
  });

  it('keep sync commands sync', () => {
    const sync = createPadrone('app')
      .runtime(quiet)
      .command('five', (c) => c.action(() => 5));
    expect(sync.run('five').result).toBe(5);
    expect(sync.eval('five').result).toBe(5);
  });
});

describe('defineCommand().requires<T>()', () => {
  it('is a type error where the program provides no such context', () => {
    const logout = defineCommand().requires<{ credentials: { delete: (name: string) => Promise<void> } }>()((c) =>
      c.action((_args, ctx) => ctx.context.credentials.delete('x')),
    );
    createPadrone('app').extend(padroneCredentials()).command('logout', logout);
    createPadrone('app').context<{ credentials: { delete: (name: string) => Promise<void> } }>().command('logout', logout);
    // @ts-expect-error nothing provides `credentials`
    createPadrone('app').command('logout', logout);
  });
});

describe('running another command from an action', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .context<{ base: number }>()
    .command('add', (c) =>
      c
        .context((ctx) => ({ ...ctx, offset: 100 }))
        .arguments(z.object({ n: z.number(), async: z.boolean().default(false) }))
        .action((args, ctx) =>
          args.async ? Promise.resolve(ctx.context.base + ctx.context.offset + args.n) : ctx.context.base + ctx.context.offset + args.n,
        ),
    )
    .command('twice', (c) =>
      c.arguments(z.object({ n: z.number() }), { positional: ['n'] }).action(async (args, ctx) => {
        const first = await ctx.run('add', { n: args.n });
        const second = await ctx.run('add', { n: args.n, async: true });
        return [first, second];
      }),
    )
    .command('invalid', (c) => c.action((_args, ctx) => ctx.run('add', { n: 'x' })))
    .command('fail', (c) =>
      c.action(() => {
        throw new Error('nope');
      }),
    )
    .command('relay', (c) => c.action((_args, ctx) => ctx.run('fail')))
    .command('legacy', (c) => c.action((_args, ctx) => ctx.program.run('add', { n: 1 }, { context: { base: 0 } })));

  const context = { base: 1 };

  it('ctx.run() resolves to the result, with the caller context going through the target command', async () => {
    expect((await program.eval('twice 2', { context })).result).toEqual([103, 103]);
    expect((await program.run('twice', { n: 3 }, { context })).result).toEqual([104, 104]);
  });

  it('ctx.run() rejects with the error of the target, or a ValidationError for invalid args', async () => {
    expect((await program.eval('invalid', { context })).error).toBeInstanceOf(ValidationError);
    expect(((await program.eval('relay', { context })).error as Error).message).toBe('nope');
  });

  it('hooks get ctx.run() too', async () => {
    const seen: unknown[] = [];
    const hooked = program.hook('postAction', async (ctx) => {
      if (ctx.command.name === 'fail') seen.push(await ctx.run('add', { n: 0 }));
    });
    await hooked.eval('fail', { context });
    expect(seen).toEqual([]);
    const withHook = program.hook('preAction', async (ctx) => {
      if (ctx.command.name === 'twice') seen.push(await ctx.run('add', { n: 0 }));
    });
    await withHook.eval('twice 1', { context });
    expect(seen).toEqual([101]);
  });

  it('ctx.program.run() takes any args', async () => {
    expect(((await program.eval('legacy', { context })).result as { result: unknown }).result).toBe(101);
  });
});

describe('help and errors', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .globalArgs(z.object({ verbose: z.boolean().optional().describe('More output') }))
    .extend(padroneJson(), padroneFormat(), padroneConfirm())
    .command('send', (c) =>
      c
        .configure({ mutation: true })
        .arguments(
          z.object({
            query: z.record(z.string(), z.string()).default({}).describe('Query'),
            tags: z.array(z.string()).default(['a', 'b']).describe('Tags'),
            limits: z.object({ max: z.number() }).default({ max: 5 }).describe('Limits'),
            body: z.string().optional().describe('Body'),
            header: z.array(z.string().regex(/:/, 'Expected "Name: value"')).default([]),
          }),
          { stdin: 'body', fields: { body: { fromFile: true } } },
        )
        .action(() => 1),
    );
  const lines = program.help('send').split('\n');
  const line = (name: string) => lines.find((l) => l.includes(`--${name} `)) ?? '';

  it('shows object and list defaults as values, and leaves empty ones out', () => {
    expect(line('limits')).toContain('(default: {"max":5})');
    expect(line('tags')).toContain('(default: a, b)');
    expect(line('query')).not.toContain('default');
  });

  it('lists the options extensions add to every command under Global Options, after the global args', () => {
    const globals = lines.slice(lines.indexOf('Global Options:'));
    expect(
      globals.map((l) =>
        l
          .trim()
          .split(/\s+/)
          .find((w) => w.startsWith('--')),
      ),
    ).toEqual([undefined, '--verbose', '--json', '--jq', '--template', '--output', undefined]);
    // --yes is only listed on the commands that ask
    expect(lines.slice(0, lines.indexOf('Global Options:')).some((l) => l.includes('--yes'))).toBe(true);
  });

  it('says once that the stdin field reads stdin', () => {
    expect(line('body')).toContain('(@file, - or piped stdin)');
    expect(lines.some((l) => l.trim() === '(stdin)')).toBe(false);
  });

  it('names the option and the value of an invalid list item', async () => {
    const { argsResult } = await program.eval('send --header nocolon --body x');
    expect(argsResult?.issues?.[0]?.message).toBe('Invalid value "nocolon" for "--header": Expected "Name: value"');
  });
});

describe('stdin', () => {
  it('reads as empty once an earlier run in the process read it to the end', async () => {
    const script = `
      import { createPadrone } from 'padrone';
      import * as z from 'zod/v4';
      const program = createPadrone('app')
        .runtime({ output: () => {}, error: () => {} })
        .command('x', (c) => c.arguments(z.object({ data: z.string().optional() }), { stdin: 'data' }).action((args) => args.data));
      for (let i = 0; i < 2; i++) {
        const { result, error } = await program.eval('x');
        console.log(JSON.stringify({ result, error: error && String(error) }));
      }
    `;
    const child = Bun.spawn(['bun', '--conditions=padrone@dev', '-e', script], {
      cwd: import.meta.dir,
      stdin: new TextEncoder().encode('piped'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(child.stdout).text();
    await child.exited;
    expect(
      out
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ result: 'piped' }, {}]);
  });
});

describe('optional positionals before required ones', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .command('request', (c) =>
      c
        .arguments(z.object({ method: z.enum(['GET', 'POST']).default('GET'), url: z.string() }), { positional: ['method', 'url'] })
        .action((args) => `${args.method} ${args.url}`),
    )
    .command('pick', (c) =>
      c
        .arguments(z.object({ a: z.string().optional(), b: z.string().optional(), c: z.string() }), { positional: ['a', 'b', 'c'] })
        .action((args) => args),
    );

  it('leave the value to the required positional when there is only enough for it', () => {
    expect(program.eval('request https://x').result).toBe('GET https://x');
    expect(program.eval('request POST https://x').result).toBe('POST https://x');
    expect(program.eval('pick 1').args).toMatchObject({ c: '1' });
    expect(program.eval('pick 1 2').args).toMatchObject({ a: '1', c: '2' });
    expect(program.eval('pick 1 2 3').args).toMatchObject({ a: '1', b: '2', c: '3' });
  });

  it('still report a missing required positional', () => {
    expect(program.eval('request').argsResult?.issues?.[0]?.message).toBe('Missing required argument');
  });
});

describe('key=value for object options', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .command('get', (c) =>
      c
        .arguments(
          z.object({
            query: z.record(z.string(), z.string()).default({}),
            db: z.object({ host: z.string(), port: z.number().default(5432) }).optional(),
          }),
          { fields: { query: { flags: 'q' } } },
        )
        .action((args) => args),
    );

  it('sets one key per value, merged with repeats, dotted keys and JSON', () => {
    expect(program.eval('get -q page=2 -q x.y=a=b').args?.query).toEqual({ page: '2', 'x.y': 'a=b' });
    expect(program.eval(`get --query page=2 --query '{"sort":"asc"}'`).args?.query).toEqual({ page: '2', sort: 'asc' });
    expect(program.eval('get --db host=h --db port=1').args?.db).toEqual({ host: 'h', port: 1 });
    expect(program.eval('get --db.host h').args?.db).toEqual({ host: 'h', port: 5432 });
  });

  it('says so when a value is neither', () => {
    expect(program.eval('get -q page').argsResult?.issues?.[0]?.message).toBe('Expected key=value or JSON, got "page"');
  });

  it('shows <key=value> in help', () => {
    expect(program.help('get')).toMatch(/-q, --query +<key=value>/);
  });
});

describe('event handlers', () => {
  type Store = { sent: string[] };
  const sent = defineEvent<{ url: string }>('app:sent');

  it("type ctx.context by the interceptor's .requires<T>()", async () => {
    const history = defineInterceptor({ name: 'history' })
      .requires<{ store: Store }>()
      .on(sent, (event, ctx) => {
        expectTypeOf(ctx.context).toEqualTypeOf<{ store: Store }>();
        ctx.context.store.sent.push(event.url);
      });
    const later = defineInterceptor({ name: 'later' }, () => ({}))
      .requires<{ store: Store }>()
      .on(sent, (event, ctx) => {
        expectTypeOf(ctx.context).toExtend<{ store: Store }>();
        ctx.context.store.sent.push(`later ${event.url}`);
      });
    const program = createPadrone('app')
      .runtime(quiet)
      .context<{ store: Store }>()
      .intercept(history)
      .intercept(later)
      .command('send', (c) => c.action((_args, ctx) => ctx.emit(sent, { url: 'x' })));
    const store: Store = { sent: [] };
    await program.eval('send', { context: { store } });
    expect(store.sent).toEqual(['x', 'later x']);
  });
});

describe('testCli', () => {
  const program = createPadrone('app')
    .extend(padroneConfirm())
    .command('rm', (c) =>
      c
        .configure({ mutation: true })
        .arguments(z.object({ name: z.string() }), { positional: ['name'] })
        .action((args) => `removed ${args.name}`),
    )
    .command('fail', (c) =>
      c.action(() => {
        throw new ActionError('bad', { exitCode: 4 });
      }),
    );

  it('.cli() runs like cli(): confirmation, printed errors and the exit code', async () => {
    const refused = await testCli(program).cli('rm a');
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr[0]).toContain('needs confirmation: pass --yes');

    const confirmed = await testCli(program).prompt({ confirm: true }).cli('rm a');
    expect(confirmed).toMatchObject({ exitCode: 0, result: 'removed a', stdout: ['removed a'] });

    const missing = await testCli(program).cli('rm');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr[0]).toContain('Missing required argument');
  });

  it('reports the exit code for .run() too', async () => {
    expect((await testCli(program).run('fail')).exitCode).toBe(4);
    expect((await testCli(program).run('rm')).exitCode).toBe(1);
    expect((await testCli(program).run('rm a')).exitCode).toBe(0);
    expect((await testCli(program).cli('fail')).exitCode).toBe(4);
  });
});

describe('arguments meta and .configure()', () => {
  it('defineArgsMeta() types a meta kept apart from .arguments() / .globalArgs()', () => {
    const globals = z.object({ verbose: z.number().default(0) });
    const globalsMeta = defineArgsMeta(globals, { fields: { verbose: { flags: 'v', count: true } } });
    const program = createPadrone('app')
      .runtime(quiet)
      .globalArgs(globals, globalsMeta)
      .command('x', (c) => c.action((args) => args.verbose));
    expect(program.eval('x -vv').result).toBe(2);

    const args = z.object({ url: z.string() });
    // @ts-expect-error not a field of the schema
    defineArgsMeta(args, { fields: { nope: { flags: 'n' } } });
    // @ts-expect-error short flags are one character
    defineArgsMeta(args, { fields: { url: { flags: 'uu' } } });
  });

  it('.configure() callbacks before .arguments() say where to call it', () => {
    createPadrone('app').command('rm', (c) =>
      c
        // @ts-expect-error the command's own args aren't known yet: call .configure() after .arguments()
        .configure({ confirm: (args) => `Remove ${args.names}?` })
        .arguments(z.object({ names: z.array(z.string()) })),
    );
    createPadrone('app').command('rm', (c) =>
      c.arguments(z.object({ names: z.array(z.string()) })).configure({ confirm: (args) => `Remove ${args.names.join(', ')}?` }),
    );
  });
});
