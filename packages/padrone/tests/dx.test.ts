import { describe, expect, expectTypeOf, it, spyOn } from 'bun:test';
import type { InferArgsOutput, InferCommand } from 'padrone';
import {
  ActionError,
  createPadrone,
  defineCommand,
  defineEvent,
  defineInterceptor,
  padroneConfig,
  padroneConfirm,
  padroneEnv,
  padroneFormat,
  padroneJson,
  padroneLogger,
  padroneTiming,
  ValidationError,
} from 'padrone';
import { padroneServe } from 'padrone/serve';
import { testCli } from 'padrone/test';
import * as z from 'zod/v4';
import { createDefaultRuntime } from '../src/core/default-runtime.ts';
import { renderTable, stringifyCell } from '../src/output/primitives.ts';
import { createTextLayout, createTextStyler } from '../src/output/styling.ts';

type Store = { items: number[] };

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };

describe('defineCommand', () => {
  it('registers under the name it is given, for run(), api() and find()', () => {
    const remove = defineCommand((c) => c.arguments(z.object({ ids: z.array(z.number()) })).action((args) => args.ids.length));
    const program = createPadrone('app')
      .runtime(quiet)
      .command('list', (c) => c.arguments(z.object({ tag: z.string().optional() })).action((args) => args.tag ?? 'all'))
      .command(['remove', 'rm'], remove);

    const removed = program.run('remove', { ids: [1, 2] });
    expectTypeOf(removed.result).toEqualTypeOf<number | undefined>();
    expect(removed.result).toBe(2);
    expect(program.run('rm', { ids: [1] }).result).toBe(1);
    // A command added with defineCommand() doesn't make other names resolve to it
    expectTypeOf(program.run('list', { tag: 'x' }).result).toEqualTypeOf<string | undefined>();

    const api = program.api();
    expectTypeOf<Parameters<typeof api.remove>[0]>().toEqualTypeOf<{ ids: number[] }>();
    expect(api.remove({ ids: [1, 2, 3] })).toBe(3);
    expect(program.find('remove')?.path).toBe('remove');
  });

  it('takes the parent context type with defineCommand<Context>()(fn)', () => {
    const count = defineCommand<{ store: Store }>()((c) =>
      c.arguments(z.object({ min: z.number().default(0) })).action((args, ctx) => ctx.context.store.items.filter((i) => i >= args.min)),
    );
    const program = createPadrone('app').runtime(quiet).context<{ store: Store }>().command('count', count);
    const result = program.run('count', {}, { context: { store: { items: [1, 2, 3] } } });
    expectTypeOf(result.result).toEqualTypeOf<number[] | undefined>();
    expect(result.result).toEqual([1, 2, 3]);
  });

  it('keeps the subcommands of a command group', () => {
    const items = defineCommand((c) => c.command('add', (s) => s.arguments(z.object({ item: z.string() })).action((args) => args.item)));
    const program = createPadrone('app').runtime(quiet).command('items', items);
    expect(program.run('items add', { item: 'x' }).result).toBe('x');
    expect(program.api().items.add({ item: 'y' })).toBe('y');
  });

  it('rejects an explicit type argument with a callback, which would lose the command type', () => {
    // @ts-expect-error pass the context with defineCommand<Context>()((c) => ...)
    defineCommand<{ store: Store }>((c) => c.action(() => 1));
  });
});

describe('context typing', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .context<{ store: Store }>()
    .command('size', (c) => c.action((_args, ctx) => ctx.context.store.items.length));

  it('requires the context the program declares', () => {
    const context = { store: { items: [1] } };
    expect(program.eval('size', { context }).result).toBe(1);
    expect(program.run('size', undefined, { context }).result).toBe(1);
    expect(program.api({ context }).size()).toBe(1);
    if (false as boolean) {
      // @ts-expect-error context is required
      program.eval('size');
      // @ts-expect-error context is required
      program.cli();
      // @ts-expect-error context is required
      program.run('size', undefined);
      // @ts-expect-error context is required
      program.api();
    }
  });

  it("doesn't ask callers for a context the program creates itself", () => {
    const own = createPadrone('app')
      .runtime(quiet)
      .context(() => ({ store: { items: [1, 2] } }))
      .command('size', (c) => c.action((_args, ctx) => ctx.context.store.items.length));
    expect(own.eval('size').result).toBe(2);
    expect(own.api().size()).toBe(2);
  });

  it('infers commands of a program with a context', () => {
    type Size = InferCommand<typeof program, 'size'>;
    expectTypeOf<Size['~types']['name']>().toEqualTypeOf<'size'>();
    const withArgs = program.command('grow', (c) => c.arguments(z.object({ by: z.number().default(1) })));
    expectTypeOf<InferArgsOutput<InferCommand<typeof withArgs, 'grow'>>>().toEqualTypeOf<{ by: number }>();
  });
});

describe('defineInterceptor(meta).provides<T>()', () => {
  it('checks the context passed to next() and adds it to commands', () => {
    const clock = defineInterceptor({ name: 'clock' })
      .provides<{ now: () => number }>()
      .factory(() => ({ start: (_ctx, next) => next({ context: { now: () => 42 } }) }));
    const program = createPadrone('app')
      .runtime(quiet)
      .intercept(clock)
      .command('now', (c) => c.action((_args, ctx) => ctx.context.now()));
    expect(program.eval('now').result).toBe(42);

    defineInterceptor({ name: 'clock' })
      .provides<{ now: () => number }>()
      // @ts-expect-error `now` must be a function
      .factory(() => ({ start: (_ctx, next) => next({ context: { now: 42 } }) }));
  });
});

describe('run() and api()', () => {
  const printed: unknown[] = [];
  const program = createPadrone('app')
    .runtime({ ...quiet, output: (...args) => printed.push(...args) })
    .command('list', (c) =>
      c.arguments(z.object({ limit: z.number().default(20), tags: z.array(z.string()).default([]) })).action((args) => args),
    );

  it('apply schema defaults', () => {
    expect(program.run('list', {}).result).toEqual({ limit: 20, tags: [] });
    expect(program.api().list({ tags: ['a'] })).toEqual({ limit: 20, tags: ['a'] });
  });

  it('stringify() takes args without their defaults', () => {
    expect(program.stringify('list', { tags: ['a'] })).toBe('list --tags=a');
  });

  it("don't print results", () => {
    printed.length = 0;
    program.run('list', {});
    program.api().list({});
    expect(printed).toEqual([]);
  });

  it('report invalid args: run() in argsResult, api() by throwing', () => {
    const result = program.run('list', { limit: 'x' as never });
    expect(result.result).toBeUndefined();
    expect(result.argsResult?.issues?.[0]?.path).toEqual(['limit']);
    expect(() => program.api().list({ limit: 'x' as never })).toThrow(ValidationError);
  });

  it('api() throws what the action throws', () => {
    const failing = createPadrone('app')
      .runtime(quiet)
      .command('boom', (c) =>
        c.action(() => {
          throw new ActionError('kaboom');
        }),
      );
    expect(() => failing.api().boom()).toThrow('kaboom');
  });
});

describe('builder shorthands', () => {
  it('.extend() takes several extensions, applied in order', () => {
    const lines: unknown[] = [];
    const program = createPadrone('app')
      .runtime({ ...quiet, output: (value) => lines.push(value) })
      .extend(padroneJson(), padroneFormat(), padroneConfirm())
      .command('x', (c) => c.action(() => ({ a: 1 })));
    program.eval('x -o yaml');
    program.eval('x --json');
    expect(lines).toEqual(['a: 1', '{\n  "a": 1\n}']);
  });

  it('.describe() sets the description', () => {
    const program = createPadrone('app')
      .describe('My app')
      .command('x', (c) => c.describe('Do x').action(() => 1));
    expect(program.help()).toContain('My app');
    expect(program.help()).toMatch(/x {2}Do x/);
    expect(program.find('x')?.description).toBe('Do x');
  });
});

describe('command-line output', () => {
  const run = async (program: { cli: (prefs: never) => unknown }, ...argv: string[]) => {
    const errors: string[] = [];
    const lines: string[] = [];
    await program.cli({
      runtime: { argv: () => argv, error: (text: string) => errors.push(text), output: (v: unknown) => lines.push(String(v)) },
    } as never);
    return { errors: errors.join('\n'), output: lines.join('\n') };
  };

  it('prints the suggestions of an error', async () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('x', (c) =>
        c.action(() => {
          throw new ActionError('Nothing to do', { suggestions: ['Run `app list` first'] });
        }),
      );
    expect((await run(program, 'x')).errors).toBe('Nothing to do\n\n  Run `app list` first');
  });

  it('words missing and mistyped values for the command line', async () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('add', (c) =>
        c.arguments(z.object({ url: z.string(), port: z.number(), limit: z.number().optional() }), { positional: ['url'] }).action(() => 1),
      );
    const issues = (await program.eval('add --limit abc')).argsResult?.issues?.map((i) => i.message);
    expect(issues).toEqual(['Missing required argument', 'Missing required option', 'Expected number, got "abc"']);
    expect((await program.eval('add x --port 1 --limt 2')).argsResult?.issues?.[0]?.message).toBe(
      'Unknown option "--limt". Did you mean "--limit"?',
    );
  });

  it('lists variadic positionals, --yes, own options before global ones, and env variables inline', () => {
    const program = createPadrone('app')
      .extend(padroneConfirm(), padroneEnv({ prefix: 'APP' }))
      .globalArgs(z.object({ verbose: z.boolean().optional() }))
      .command('rm', (c) =>
        c
          .configure({ mutation: true })
          .arguments(z.object({ ids: z.array(z.string()), force: z.boolean().optional().describe('Force') }), { positional: ['...ids'] })
          .action(() => 1),
      )
      .command('bare', (c) => c.action(() => 1));
    const help = program.help('rm');
    expect(help).toContain('Usage: app rm <ids...>');
    expect(help).toContain('--yes');
    expect(help).toContain('Force (env: APP_FORCE)');
    expect(help.indexOf('Options:')).toBeLessThan(help.indexOf('Global Options:'));
    expect(program.help('bare')).not.toContain('--yes');
    expect(
      program
        .help()
        .split('\n')
        .filter((line) => line.endsWith(' ')),
    ).toEqual([]);
  });

  it('joins lists of plain values in table cells', () => {
    expect(stringifyCell(['js', 'runtime'])).toBe('js, runtime');
    expect(stringifyCell([{ a: 1 }])).toBe('[{"a":1}]');
  });

  it('prints objects as JSON when stdout is not a terminal', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const isTTY = process.stdout.isTTY;
    try {
      process.stdout.isTTY = false;
      createDefaultRuntime().output({ a: [1] }, 'text');
      expect(log).toHaveBeenLastCalledWith('{\n  "a": [\n    1\n  ]\n}', 'text');
      process.stdout.isTTY = true;
      createDefaultRuntime().output({ a: [1] });
      expect(log).toHaveBeenLastCalledWith({ a: [1] });
    } finally {
      process.stdout.isTTY = isTTY;
      log.mockRestore();
    }
  });
});

describe('global args of commands defined elsewhere', () => {
  const globals = z.object({ verbose: z.boolean().default(false) });
  const echo = defineCommand((c) => c.arguments(z.object({ a: z.string() })).action((args) => args));
  const group = defineCommand((c) => c.command('sub', (s) => s.arguments(z.object({ b: z.number() })).action((args) => args)));
  const command = defineCommand<{ db: string }, typeof globals>();
  const status = command((c) => c.action((args, ctx) => `${ctx.context.db}:${args.verbose}`));
  const child = createPadrone('child').command('run', (c) => c.action((args) => args));
  const program = createPadrone('app')
    .runtime(quiet)
    .context<{ db: string }>()
    .globalArgs(globals)
    .command('echo', echo)
    .command('group', group)
    .command('status', status)
    .mount('child', child);
  const context = { db: 'main' };

  it('types the globals into their args for run() and api()', () => {
    const api = program.api({ context });
    expect(api.echo({ a: 'x', verbose: true })).toMatchObject({ verbose: true });
    expect(api.group.sub({ b: 1, verbose: true })).toMatchObject({ verbose: true });
    expect(api.child.run({ verbose: true })).toMatchObject({ verbose: true });
    expect(program.run('echo', { a: 'x', verbose: true }, { context }).result).toMatchObject({ verbose: true });
    type SubArgs = InferArgsOutput<InferCommand<typeof program, 'group sub'>>;
    expectTypeOf<SubArgs['verbose']>().toEqualTypeOf<boolean>();
    expectTypeOf<SubArgs['b']>().toEqualTypeOf<number>();
    // @ts-expect-error unknown option
    if (false as boolean) api.echo({ a: 'x', other: 1 });
  });

  it('types them inside the command with defineCommand<Context, typeof globals>()', () => {
    expect(program.eval('status --verbose', { context }).result).toBe('main:true');
    expectTypeOf(program.run('status', {}, { context }).result).toEqualTypeOf<string | undefined>();
  });
});

describe('help for extension options', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .extend(padroneFormat({ tableFlags: true }), padroneJson(), padroneLogger(), padroneTiming())
    .command('ls', (c) => c.action(() => []))
    .command('export', (c) => c.arguments(z.object({ out: z.string().optional() }), { fields: { out: { flags: 'o' } } }).action(() => 1));

  it('lists the flags of --output, --json, the logger and timing, in the order the extensions were added', () => {
    const help = program.help('ls');
    const names = ['--output', '--columns', '--sort', '--no-header', '--json', '--jq', '--template', '--log-level', '--quiet', '--timing'];
    const positions = names.map((name) => help.indexOf(name));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(help).toContain('-o, --output');
    expect(help).toContain('(choices: text, json, yaml, csv, tsv, table)');
  });

  it("leaves a command's own short flag to it", () => {
    const lines = program.help('export').split('\n');
    expect(lines.filter((line) => line.includes('-o,'))).toEqual([expect.stringContaining('--out')]);
    expect(lines.some((line) => /^\s+--output/.test(line))).toBe(true);
  });
});

describe('suggestions', () => {
  it('names a mistyped command once, not also by its aliases', async () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command(['list', 'ls'], (c) => c.action(() => 1));
    expect((await program.eval('lst')).error).toMatchObject({ suggestions: ['Did you mean "list"?'] });
  });

  it('puts the subcommand help hint after the options', () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('tags', (c) => c.arguments(z.object({ all: z.boolean().optional() })).command('list', (s) => s.action(() => 1)));
    const help = program.help('tags');
    expect(help.indexOf('Run "app tags [command] --help"')).toBeGreaterThan(help.indexOf('--all'));
  });
});

describe('recommendations from the sample program', () => {
  it('words unknown options as typed, without repeating their name', async () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('list', (c) => c.arguments(z.object({ limit: z.number().optional() })).action(() => 1));
    const errors: string[] = [];
    await program.cli({ runtime: { argv: () => ['list', '--limt', '2', '-x'], error: (text: string) => errors.push(text) } } as never);
    expect(errors.join('\n')).toContain('  - Unknown option "--limt". Did you mean "--limit"?\n  - Unknown option "-x"');
  });

  it('shows <value> for options that take one, [value] where it can be left out, and marks required options', () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('x', (c) =>
        c
          .arguments(z.object({ env: z.string(), tag: z.string().optional(), color: z.union([z.boolean(), z.string()]).optional() }))
          .action(() => 1),
      );
    const help = program.help('x');
    expect(help).toMatch(/--env\s+<string>\s+\(required\)/);
    expect(help).toMatch(/--tag\s+<string>\n/);
    expect(help).toMatch(/--color\s+\[string\]/);
  });

  it("reads a command's own options from command-scoped variables with padroneEnv({ scope: 'command' })", async () => {
    const env = { BM_LIST_LIMIT: '3', BM_LIMIT: '9', BM_VERBOSE: '1', BM_LIST_DB__HOST: 'h', BM_TAGS_RENAME_DRY_RUN: 'true' };
    const program = createPadrone('bm')
      .runtime({ ...quiet, env: () => env })
      .extend(padroneEnv({ prefix: 'BM', scope: 'command' }))
      .globalArgs(z.object({ verbose: z.coerce.number().default(0) }))
      .command('list', (c) =>
        c.arguments(z.object({ limit: z.number().default(20), db: z.object({ host: z.string() }).optional() })).action((args) => args),
      )
      .command('tags', (c) => c.command('rename', (s) => s.arguments(z.object({ dryRun: z.boolean().default(false) })).action((a) => a)));
    expect((await program.eval('list')).result).toEqual({ limit: 3, verbose: 1, db: { host: 'h' } });
    expect((await program.eval('tags rename')).result).toEqual({ dryRun: true, verbose: 1 });
    expect(program.help('list')).toContain('(env: BM_LIST_LIMIT)');
    expect(program.help('list')).toContain('(env: BM_VERBOSE)');
  });

  it('applies config sections by default', async () => {
    const program = createPadrone('bm')
      .runtime(quiet)
      .extend(padroneConfig({ files: 'bm.json', loadConfig: () => ({ limit: 5, list: { limit: 1 } }) }))
      .command('list', (c) => c.arguments(z.object({ limit: z.number().default(20) })).action((args) => args.limit))
      .command('search', (c) => c.arguments(z.object({ limit: z.number().default(20) })).action((args) => args.limit));
    expect((await program.eval('list')).result).toBe(1);
    expect((await program.eval('search')).result).toBe(5);
  });

  it('types the options field rules name', () => {
    const schema = z.object({ json: z.boolean().optional(), table: z.boolean().optional(), out: z.string().optional() });
    createPadrone('app')
      .globalArgs(z.object({ quiet: z.boolean().optional() }))
      .command('ok', (c) => c.arguments(schema, { fields: { json: { conflicts: ['table', 'quiet'], implies: { out: '-' } } } }));
    // @ts-expect-error no option "tabel"
    createPadrone('app').command('typo', (c) => c.arguments(schema, { fields: { json: { conflicts: 'tabel' } } }));
    // @ts-expect-error no option "ot"
    createPadrone('app').command('typo', (c) => c.arguments(schema, { fields: { json: { implies: { ot: '-' } } } }));
  });

  it('types testCli() results by the command the input names, and its context', async () => {
    const program = createPadrone('app')
      .context<{ store: Store }>()
      .command('list', (c) =>
        c.arguments(z.object({ min: z.number().default(0) })).action((args, ctx) => ctx.context.store.items.filter((i) => i >= args.min)),
      )
      .command('db', (c) => c.command('migrate', (s) => s.action(async () => ({ ok: true as const }))));
    const store = { items: [1, 2, 3] };
    const listed = await testCli(program).context({ store }).run('list --min 2');
    expectTypeOf(listed.result).toEqualTypeOf<number[] | undefined>();
    expectTypeOf(listed.args).toEqualTypeOf<{ min: number } | undefined>();
    expect(listed.result).toEqual([2, 3]);
    const migrated = await testCli(program).context({ store }).args('db migrate').run();
    expectTypeOf(migrated.result).toEqualTypeOf<{ ok: true } | undefined>();
    expectTypeOf((await testCli(program).context({ store }).run('__complete l')).result).toBeUnknown();
    // @ts-expect-error the program's context
    testCli(program).context({ db: 1 });
  });

  it('ends no table line in blanks', () => {
    const ctx = { format: 'text' as const, styler: createTextStyler(), layout: createTextLayout() };
    const data = [
      { id: 1, title: 'Bun' },
      { id: 22, title: 'Zod validation' },
    ];
    for (const border of [true, false]) {
      expect(
        renderTable(data, { border }, ctx)
          .split('\n')
          .filter((line) => line.endsWith(' ')),
      ).toEqual([]);
    }
  });
});

describe('recommendations from the third sample program', () => {
  it('keeps the aliases of subcommands in a defineCommand() group, so eval() and parse() still infer the command', () => {
    const tags = defineCommand((c) =>
      c.command(['remove', 'rm'], (s) => s.arguments(z.object({ tags: z.array(z.string()) })).action((args) => args.tags)),
    );
    const program = createPadrone('app')
      .runtime(quiet)
      .command('list', (c) => c.arguments(z.object({ tag: z.string().optional() })).action((args) => args.tag ?? 'all'))
      .command('tag', tags);
    const listed = program.eval('list --tag x');
    expectTypeOf(listed.result).toEqualTypeOf<string | undefined>();
    expect(listed.result).toBe('x');
    expectTypeOf(program.parse('tag rm --tags a').args).toEqualTypeOf<{ tags: string[] } | undefined>();
    expect(program.run('tag rm', { tags: ['a'] }).result).toEqual(['a']);
  });

  it('rejects a literal name run() has no command for, and takes any string variable', () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('list', (c) => c.action(() => 'all'));
    // @ts-expect-error a typo
    expect(program.run('lsit', {}).error).toBeInstanceOf(Error);
    const name: string = 'list';
    expect(program.run(name, {}).result as unknown).toBe('all');
  });

  it('passes a context to tool(), serve() and mcp() calls, and requires it when the program declares one', async () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .context<{ user: string }>()
      .command('whoami', (c) => c.action((_args, ctx) => ctx.context.user));
    const tool = program.tool({ context: { user: 'ada' } });
    expect(((await tool.execute!({ command: 'whoami' }, {} as never)) as { result: unknown }).result).toBe('ada');
    // @ts-expect-error the program's context
    program.tool();
    // @ts-expect-error the program's context
    void program.serve({ port: 0 });
  });

  it('serve passes on the context given to cli()', async () => {
    const logs: string[] = [];
    const listeners: ((signal: 'SIGTERM') => void)[] = [];
    const program = createPadrone('app')
      .runtime({
        output: () => {},
        error: (text) => logs.push(text),
        onSignal: (cb) => {
          listeners.push(cb);
          return () => {};
        },
      })
      .context<{ user: string }>()
      .extend(padroneServe())
      .command('whoami', (c) => c.context((ctx) => ({ ...ctx, greeting: `hi ${ctx.user}` })).action((_args, ctx) => ctx.context.greeting));
    const running = program.eval('serve --port 0', { context: { user: 'ada' } });
    let port: string | undefined;
    for (let i = 0; i < 100 && !port; i++) {
      port = logs.join('\n').match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      if (!port) await new Promise((r) => setTimeout(r, 10));
    }
    try {
      const res = (await (await fetch(`http://127.0.0.1:${port}/whoami`)).json()) as { result: unknown };
      // The command's transform runs on the context cli() was given
      expect(res.result).toBe('hi ada');
    } finally {
      for (const listener of listeners) listener('SIGTERM');
      await running;
    }
  });

  it('defines an interceptor that only handles an event with defineInterceptor(meta).on()', async () => {
    const added = defineEvent<{ name: string }>('app:added');
    const seen: string[] = [];
    const audit = defineInterceptor({ name: 'audit' }).on(added, (payload) => {
      seen.push(payload.name);
    });
    const program = createPadrone('app')
      .runtime(quiet)
      .intercept(audit)
      .command('add', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action(async (args, ctx) => {
          await ctx.emit(added, { name: args.name });
        }),
      );
    await program.eval('add x');
    expect(seen).toEqual(['x']);
  });

  it('leaves the path out of an issue that names the option by its short flag', async () => {
    const errors: string[] = [];
    const program = createPadrone('app')
      .runtime({ ...quiet, argv: () => ['add', '-l'], error: (text) => errors.push(text) })
      .command('add', (c) => c.arguments(z.object({ lang: z.string().meta({ flags: 'l' }) })).action(() => {}));
    program.cli();
    expect(errors.join('\n')).toContain('  - Option "-l" requires a value');
  });
});
