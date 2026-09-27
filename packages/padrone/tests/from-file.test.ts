import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createPadrone, padroneEnv, padroneResponseFiles } from 'padrone';
import { testCli } from 'padrone/test';
import * as z from 'zod/v4';

const dir = mkdtempSync(join(tmpdir(), 'padrone-from-file-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const notes = file('notes.md', '# Notes\nline two\n');
const tagA = file('a.txt', 'alpha');
const tagB = file('b.txt', 'beta');
const missing = join(dir, 'missing.txt');
const quiet = { output: () => {} };

describe('fromFile field meta', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .command('issue', (c) =>
      c
        .arguments(
          z.object({
            title: z.string(),
            body: z.string().optional(),
            tags: z.string().array().optional(),
            name: z.string().optional(),
          }),
          { positional: ['title'], fields: { title: { fromFile: true }, body: { fromFile: true }, tags: { fromFile: true } } },
        )
        .action((args) => args),
    );

  it('reads @path values from the file', async () => {
    const result = await program.eval(`issue t --body @${notes}`);
    expect(result.argsResult?.issues).toBeUndefined();
    expect(result.result).toEqual({ title: 't', body: '# Notes\nline two\n' });
  });

  it('stays sync when only files are read', () => {
    const result = program.eval(['issue', 't', '--body', `@${notes}`]);
    expect(result instanceof Promise).toBe(false);
    expect((result as any).result.body).toBe('# Notes\nline two\n');
  });

  it('resolves relative paths against cwd', async () => {
    const result = await program.eval(['issue', 't', '--body', `@${relative(process.cwd(), notes)}`]);
    expect((result.result as any)?.body).toBe('# Notes\nline two\n');
  });

  it('passes @@text as @text and other values as given', async () => {
    const result = await program.eval(['issue', '@@home', '--body', '@@mention', '--name', '@name']);
    expect(result.result).toEqual({ title: '@home', body: '@mention', name: '@name' });
  });

  it('reads positionals and each array item', async () => {
    const result = await program.eval(['issue', `@${tagA}`, '--tags', `@${tagA}`, '--tags', 'plain', '--tags', `@${tagB}`]);
    expect(result.result).toEqual({ title: 'alpha', tags: ['alpha', 'plain', 'beta'] });
  });

  it('reports a missing file as a validation issue naming the option and path', async () => {
    const result = await program.eval(['issue', 't', '--body', `@${missing}`]);
    expect(result.argsResult?.issues).toEqual([{ path: ['body'], message: `Cannot read "${missing}": file not found` }]);
  });

  it('reports a bare @', async () => {
    const result = await program.eval(['issue', 't', '--body', '@']);
    expect(result.argsResult?.issues?.[0]?.message).toBe('Expected a file path after "@"');
  });

  it('reads - from stdin', async () => {
    const result = await testCli(program).stdin('from stdin').run('issue t --body -');
    expect(result.result).toEqual({ title: 't', body: 'from stdin' });
  });

  it('reads @- from stdin', async () => {
    const result = await testCli(program).stdin('piped').run('issue t --body @-');
    expect(result.result).toEqual({ title: 't', body: 'piped' });
  });

  it('rejects reading stdin twice', async () => {
    const result = await testCli(program).stdin('x').run('issue - --body -');
    expect(result.issues?.[0]?.message).toBe('Only one value can be read from stdin ("-")');
  });

  it('never reads files or stdin for remote callers', async () => {
    for (const caller of ['serve', 'mcp', 'tool'] as const) {
      const result = await program.eval(['issue', '-', '--body', `@${notes}`], { caller });
      expect(result.result).toEqual({ title: '-', body: `@${notes}` });
    }
  });

  it('takes env values as given', async () => {
    const withEnv = createPadrone('app')
      .extend(padroneEnv({ vars: { body: 'BODY' } }))
      .command('post', (c) =>
        c.arguments(z.object({ body: z.string() }), { fields: { body: { fromFile: true } } }).action((args) => args.body),
      );
    const fromEnv = await testCli(withEnv)
      .env({ BODY: `@${notes}` })
      .run('post');
    expect(fromEnv.result).toBe(`@${notes}`);
    const fromFlag = await testCli(withEnv).env({ BODY: 'env' }).run(`post --body @${notes}`);
    expect(fromFlag.result).toBe('# Notes\nline two\n');
  });

  it('reads the flag set in schema meta', async () => {
    const schemaMeta = createPadrone('app').command('post', (c) =>
      c.arguments(z.object({ body: z.string().meta({ fromFile: true }) })).action((args) => args.body),
    );
    const result = await schemaMeta.eval(['post', '--body', `@${tagB}`]);
    expect(result.result).toBe('beta');
  });

  it('conflicts with the command reading stdin into another field', async () => {
    const stdinProgram = createPadrone('app').command('post', (c) =>
      c
        .arguments(z.object({ body: z.string().optional(), data: z.string().optional() }), {
          stdin: 'data',
          fields: { body: { fromFile: true } },
        })
        .action((args) => args),
    );
    const conflict = await testCli(stdinProgram).stdin('x').run('post --body -');
    expect(conflict.issues?.[0]?.message).toBe('Cannot read stdin ("-"): the command reads stdin into "data"');
    const given = await testCli(stdinProgram).stdin('x').run('post --body - --data d');
    expect(given.result).toEqual({ body: 'x', data: 'd' });
  });

  it('notes the option in help', () => {
    const help = program.help('issue', { format: 'text' }) as string;
    expect(help).toMatch(/--body.*@file or - for stdin/);
  });
});

describe('padroneResponseFiles', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .extend(padroneResponseFiles())
    .command('deploy', (c) =>
      c
        .arguments(z.object({ env: z.string().optional(), tags: z.string().array().optional(), rest: z.string().array().optional() }), {
          positional: ['...rest'],
        })
        .action((args) => args),
    );

  const args = file('args.txt', '# deploy options\n\n--env "staging eu"\n  --tags a --tags b\n');
  const nested = file('nested.txt', `deploy @${args}\n`);
  const loop = file('loop.txt', '');
  writeFileSync(loop, `@${loop}`);

  it('expands @file into its arguments', async () => {
    const result = await program.eval(['deploy', `@${args}`, 'x']);
    expect(result.result).toEqual({ env: 'staging eu', tags: ['a', 'b'], rest: ['x'] });
  });

  it('expands nested response files', async () => {
    const result = await program.eval([`@${nested}`]);
    expect((result.result as any)?.env).toBe('staging eu');
  });

  it('expands in a string input after the program name', async () => {
    const result = await program.eval(`app deploy @${args}`);
    expect((result.result as any)?.env).toBe('staging eu');
  });

  it('passes @@text as @text and leaves tokens after -- alone', async () => {
    const result = await program.eval(['deploy', '@@scope/pkg', '--', `@${args}`, '@@x']);
    expect((result.result as any)?.rest).toEqual(['@scope/pkg', `@${args}`, '@@x']);
  });

  it('errors on a missing file', async () => {
    const result = await program.eval(['deploy', `@${missing}`]);
    expect((result.error as Error).message).toBe(
      `Cannot read response file "${missing}": file not found (write @@${missing} for a literal "@${missing}")`,
    );
  });

  it('errors on a bare @ and on nesting too deep', async () => {
    expect(((await program.eval(['deploy', '@'])).error as Error).message).toBe('Expected a response file path after "@"');
    expect(((await program.eval(['deploy', `@${loop}`])).error as Error).message).toContain('nested more than 10 levels');
  });

  it('expands argv in cli()', async () => {
    const result = await program.cli({ runtime: { argv: () => ['deploy', `@${args}`], output: () => {} } });
    expect((result.result as any)?.env).toBe('staging eu');
  });

  it('never expands for remote callers', async () => {
    const result = await program.eval(['deploy', `@${args}`], { caller: 'serve' });
    expect((result.result as any)?.rest).toEqual([`@${args}`]);
  });

  it('leaves --option=@file to fromFile fields', async () => {
    const both = createPadrone('app')
      .runtime(quiet)
      .extend(padroneResponseFiles())
      .command('post', (c) => c.arguments(z.object({ body: z.string() }), { fields: { body: { fromFile: true } } }).action((a) => a.body));
    expect((await both.eval(['post', `--body=@${tagA}`])).result).toBe('alpha');
    expect((await both.eval(['post', '--body', `@@@${tagA}`])).result).toBe(`@${tagA}`);
  });

  it('supports a custom prefix', async () => {
    const custom = createPadrone('app')
      .runtime(quiet)
      .extend(padroneResponseFiles({ prefix: '+' }))
      .command('deploy', (c) => c.arguments(z.object({ env: z.string().optional() })).action((a) => a.env));
    const envOnly = file('env-only.txt', '--env prod');
    expect((await custom.eval(['deploy', `+${envOnly}`])).result).toBe('prod');
  });
});
