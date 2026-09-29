import { describe, expect, it, mock } from 'bun:test';
import { buildReplCompleter, createPadrone } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol } from '../src/core/commands.ts';
import { generateDocs } from '../src/docs/index.ts';
import { getCompletions } from '../src/feature/complete.ts';

function mockReadLine(inputs: (string | null)[]): (prompt: string) => Promise<string | null> {
  let index = 0;
  return mock(async (_prompt: string) => (index < inputs.length ? (inputs[index++] ?? null) : null));
}

describe('dynamic completion', () => {
  const program = createPadrone('app')
    .command('build', (c) =>
      c
        .arguments(
          z.object({
            files: z.array(z.enum(['a.ts', 'b.ts'])).optional(),
            target: z.enum(['web', 'node']).optional(),
          }),
          { positional: ['target'], fields: { files: { variadic: true } } },
        )
        .action(() => {}),
    )
    .command(['db', 'd'], (c) =>
      c
        .command('migrate', (m) => m.action(() => {}))
        .command('seed', (m) => m.action(() => {}))
        .command('schema', (s) => s.command('diff', (d) => d.action(() => {}))),
    );
  const root = (program as any)[commandSymbol];

  it('keeps completing the values of a variadic option after its first value', async () => {
    expect(await getCompletions(root, ['build', '--files', 'a.ts', ''])).toEqual(['a.ts', 'b.ts']);
    expect(await getCompletions(root, ['build', '--files', 'a.ts', 'b'])).toEqual(['b.ts']);
    // An option or `--` ends the values
    expect(await getCompletions(root, ['build', '--files', 'a.ts', '--', ''])).toEqual(['web', 'node']);
    expect(await getCompletions(root, ['build', '--files=a.ts', ''])).toEqual(['web', 'node']);
  });

  it("offers the default command's options without a subcommand, as they route to it", async () => {
    const withDefault = createPadrone('app')
      .command(['run', ''], (c) =>
        c.arguments(z.object({ fast: z.boolean().optional(), mode: z.enum(['x', 'y']).optional() })).action(() => {}),
      )
      .command('db', (c) => c.action(() => {}));
    const defaultRoot = (withDefault as any)[commandSymbol];
    expect(await getCompletions(defaultRoot, ['--'])).toEqual(['--fast', '--mode', '--help']);
    expect(await getCompletions(defaultRoot, ['--mode', ''])).toEqual(['x', 'y']);
    expect(await getCompletions(defaultRoot, ['db', '--'])).toEqual(['--help']);
    // Not the built-in help command's (it runs when nothing else does)
    expect(await getCompletions(root, ['--'])).toEqual(['--help']);
  });

  it('completes the subcommands of the command typed after `help`', async () => {
    expect(await getCompletions(root, ['help', 'db', ''])).toEqual(['migrate', 'seed', 'schema']);
    expect(await getCompletions(root, ['help', 'd', 'schema', ''])).toEqual(['diff']);
    expect(await getCompletions(root, ['help', 'db', 'm'])).toEqual(['migrate']);
    expect(await getCompletions(root, ['help', 'nope', ''])).toEqual([]);
  });
});

describe('help', () => {
  it('shows no empty default for a variadic positional', async () => {
    const program = createPadrone('app').command('build', (c) =>
      c.arguments(z.object({ files: z.array(z.string()).default([]) }), { positional: ['...files'] }).action(() => {}),
    );
    const help = program.help('build', { format: 'text' });
    expect(help).toContain('files...');
    expect(help).not.toContain('(default: )');
  });
});

describe('docs', () => {
  const program = createPadrone('app').command('build', (c) =>
    c
      .arguments(
        z.object({
          files: z.array(z.string()).default([]),
          tags: z.array(z.string()).default([]),
          force: z.boolean().optional(),
        }),
        { positional: ['...files'] },
      )
      .action(() => {}),
  );
  const page = (format: 'markdown' | 'html' | 'man') => generateDocs(program, { format }).pages.find((p) => p.command === 'build')!.content;

  it('leaves out empty defaults', () => {
    expect(page('markdown')).not.toContain('default: ``');
    expect(page('markdown')).not.toContain('**Default:** ``');
    expect(page('html')).not.toContain('Default: <code></code>');
    expect(page('man')).not.toMatch(/Default: $/m);
  });

  it('keeps a description with pipes and line breaks in its Markdown table row', () => {
    const tree = createPadrone('app').command('db', (c) =>
      c
        .command('build', (b) => b.configure({ description: 'Build a | b\nthen more' }).action(() => {}))
        .command('test', (t) => t.action(() => {})),
    );
    const db = generateDocs(tree, { format: 'markdown' }).pages.find((p) => p.command === 'db')!.content;
    expect(db).toContain('| `build` |  | Build a \\| b then more |');
  });

  it('shows no value placeholder for boolean options in man pages', () => {
    expect(page('man')).toContain('\\fB\\-\\-force\\fR\n');
  });
});

describe('REPL', () => {
  const createProgram = (readLine: (prompt: string) => Promise<string | null>, errors: string[] = []) =>
    createPadrone('test', { builtins: { help: { flags: ['usage'] } } })
      .globalArgs(z.object({ profile: z.string().optional() }))
      .runtime({ readLine, output: () => {}, error: (e) => errors.push(e) })
      .command('db', (c) =>
        c.command('schema', (s) => s.command('diff', (d) => d.action(() => 'diffed'))).command('seed', (s) => s.action(() => {})),
      )
      .command('greet', (c) => c.arguments(z.object({ name: z.string().optional() })).action(() => 'hi'));

  it('scopes into a nested command path with `.scope a b`', async () => {
    const readLine = mockReadLine(['.scope db schema', 'diff', '..', 'seed', null]);
    const errors: string[] = [];
    const results: unknown[] = [];
    for await (const r of createProgram(readLine, errors).repl({ greeting: false, hint: false })) results.push(r.result);
    expect(errors).toEqual([]);
    expect(results).toEqual(['diffed', undefined]);
    expect((readLine as any).mock.calls.map((c: string[]) => c[0])).toEqual([
      'test ❯ ',
      'test/db/schema ❯ ',
      'test/db/schema ❯ ',
      'test/db ❯ ',
      'test/db ❯ ',
    ]);
  });

  it('reports a `.scope` path that does not lead to a command group', async () => {
    const errors: string[] = [];
    for await (const _ of createProgram(mockReadLine(['.scope db nope', '.scope db seed', null]), errors).repl({
      greeting: false,
      hint: false,
    })) {
      // consume
    }
    expect(errors).toEqual(['Unknown command: db nope', '"db seed" has no subcommands to scope into.']);
  });

  it('completes the global options and the help flags the program has', () => {
    const root = createProgram(mockReadLine([])).parse([] as any).command;
    const [hits] = buildReplCompleter(root as any, {})('greet -');
    expect(hits).toEqual(['--name', '--profile', '--usage']);
  });

  it("doesn't offer the empty alias of a default command", () => {
    const program = createPadrone('test').command(['run', ''], (c) => c.action(() => {}));
    const [hits] = buildReplCompleter((program as any)[commandSymbol], {})('');
    expect(hits).toContain('run');
    expect(hits).not.toContain('');
  });
});
