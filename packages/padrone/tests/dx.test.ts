import { describe, expect, expectTypeOf, it, spyOn } from 'bun:test';
import type { InferArgsOutput, InferCommand } from 'padrone';
import {
  ActionError,
  createPadrone,
  defineCommand,
  defineInterceptor,
  padroneConfirm,
  padroneEnv,
  padroneFormat,
  padroneJson,
  padroneLogger,
  padroneTiming,
  ValidationError,
} from 'padrone';
import * as z from 'zod/v4';
import { createDefaultRuntime } from '../src/core/default-runtime.ts';
import { stringifyCell } from '../src/output/primitives.ts';

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
      'Unknown option: "limt". Did you mean "--limit"?',
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
