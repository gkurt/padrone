import { afterAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InteractivePromptConfig } from 'padrone';
import { createPadrone, padroneAliases, padroneConfirm, padroneJson, padroneResponseFiles } from 'padrone';
import { testCli } from 'padrone/test';
import * as z from 'zod/v4';

const dir = mkdtempSync(join(tmpdir(), 'padrone-input-additions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };
const message = (result: { error?: unknown }) => (result.error as Error | undefined)?.message;
const issueMessages = (result: { argsResult?: { issues?: readonly { message: string }[] } }) =>
  result.argsResult?.issues?.map((i) => i.message);

describe('suggestions', () => {
  it('suggests program and user aliases for an unknown command', async () => {
    const aliasesFile = file('suggest-aliases.json', JSON.stringify({ stats: 'status --short' }));
    const program = createPadrone('git')
      .runtime(quiet)
      .extend(padroneAliases({ file: aliasesFile, aliases: { publish: 'push --tags' } }))
      .command('push', (c) => c.arguments(z.object({ tags: z.boolean().optional() })).action(() => 'pushed'))
      .command('status', (c) => c.arguments(z.object({ short: z.boolean().optional() })).action(() => 'status'));
    const cli = (...argv: string[]) => program.cli({ runtime: { argv: () => argv } });
    expect(message(await cli('publsh'))).toContain('Did you mean "publish" or "push"?');
    expect(message(await cli('stat'))).toContain('Did you mean "stats" or "status"?');
  });

  it('suggests options that extensions declare, but not help-only ones', async () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .extend(padroneJson())
      .extend(padroneConfirm())
      .command('build', (c) => c.arguments(z.object({ out: z.string().optional() }), { interactive: true }).action(() => 'built'));
    expect(issueMessages(await program.eval('build --jsno'))).toEqual(['Unknown option: "jsno". Did you mean "--json"?']);
    expect(issueMessages(await program.eval('build --yse'))).toEqual(['Unknown option: "yse". Did you mean "--yes"?']);
    expect(issueMessages(await program.eval('build --interactiv'))).toEqual([
      'Unknown option: "interactiv". Did you mean "--interactive"?',
    ]);
    expect(issueMessages(await program.eval('build --detial'))).toEqual(['Unknown option: "detial"']);
  });

  it("doesn't suggest a default command's empty name", () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('', (c) => c.action(() => 'default'))
      .command('db', (c) => c.action(() => 'db'));
    expect(message(program.eval('b'))).toBe('Unknown command: b\n\n  Did you mean "db"?');
  });
});

describe('padroneAliases', () => {
  const create = (aliases: Record<string, string>, fileName = 'aliases.json') =>
    createPadrone('git')
      .runtime(quiet)
      .extend(padroneResponseFiles())
      .extend(padroneAliases({ file: join(dir, fileName), aliases }))
      .command('run', (c) =>
        c
          .arguments(z.object({ all: z.boolean().optional(), verbose: z.boolean().optional(), rest: z.string().array().optional() }), {
            positional: ['...rest'],
          })
          .action((args) => args),
      )
      .command('checkout', (c) =>
        c
          .arguments(z.object({ branch: z.string(), force: z.boolean().optional(), paths: z.string().array().optional() }), {
            positional: ['branch', '...paths'],
          })
          .action((args) => args),
      );
  const cli = (program: ReturnType<typeof create>, ...argv: string[]) => program.cli({ runtime: { argv: () => argv } });

  it('expands $@ into the words no $N takes', async () => {
    const program = create({ each: 'run --all $@ --verbose', pick: 'checkout $1 -- $@', none: 'run $@' });
    expect((await cli(program, 'each', 'a', 'b')).result).toEqual({ all: true, verbose: true, rest: ['a', 'b'] });
    expect((await cli(program, 'pick', 'main', 'x', '--y')).result).toEqual({ branch: 'main', paths: ['x', '--y'] });
    expect((await cli(program, 'none')).result).toEqual({});
  });

  it('still appends the words no placeholder takes without $@', async () => {
    const program = create({ co: 'checkout $1 --force' });
    expect((await cli(program, 'co', 'main', 'a')).result).toEqual({ branch: 'main', force: true, paths: ['a'] });
  });

  it('expands response files in an alias', async () => {
    const args = file('alias.args', '--all\n--verbose\n');
    const loop = file('alias-loop.args', '');
    writeFileSync(loop, `loop @${loop}`);
    const program = create({ full: `run @${args}`, loop: `run @${loop}`, again: `@${file('again.args', 'again x')}` });
    expect((await cli(program, 'full', '@@x')).result).toEqual({ all: true, verbose: true, rest: ['@x'] });
    expect(message(await cli(program, 'loop'))).toContain('nested more than 10 levels');
    expect(message(await cli(program, 'again'))).toContain('Unknown command: again');
  });

  it('takes every word after the name as the expansion in `alias set`', async () => {
    const program = create({}, 'set-aliases.json');
    const stored = () => JSON.parse(readFileSync(join(dir, 'set-aliases.json'), 'utf-8'));
    expect((await cli(program, 'alias', 'set', 'co', 'checkout', '--force')).error).toBeUndefined();
    expect(stored()).toEqual({ co: 'checkout --force' });
    await cli(program, 'alias', 'set', 'up', '--', 'run', '--all');
    expect(stored()).toEqual({ co: 'checkout --force', up: 'run --all' });
    expect((await program.eval('alias set ci checkout -f')).error).toBeUndefined();
    expect(stored().ci).toBe('checkout -f');
    expect((await cli(program, 'co', 'main')).result).toEqual({ branch: 'main', force: true });
  });
});

describe('response files and fromFile options', () => {
  const body = file('body.md', '# Body\n');
  const program = createPadrone('app')
    .runtime(quiet)
    .extend(padroneResponseFiles())
    .command('post', (c) =>
      c
        .arguments(z.object({ body: z.string().optional(), env: z.string().optional(), tags: z.string().array().optional() }), {
          fields: { body: { fromFile: true, flags: 'b' }, tags: { fromFile: true } },
        })
        .action((args) => args),
    );

  it('leaves the value of a fromFile option to fromFile', async () => {
    expect((await program.eval(['post', '--body', `@${body}`])).result).toEqual({ body: '# Body\n' });
    expect((await program.eval(['post', '-b', `@${body}`])).result).toEqual({ body: '# Body\n' });
    expect((await program.eval(['post', '--tags', `@${body}`])).result).toEqual({ tags: ['# Body\n'] });
  });

  it('still expands response files elsewhere', async () => {
    const args = file('post.args', '--env prod');
    expect((await program.eval(['post', '--body', `@${body}`, `@${args}`])).result).toEqual({ body: '# Body\n', env: 'prod' });
  });
});

describe('interactive prompts', () => {
  const create = (prompt: (config: InteractivePromptConfig) => Promise<unknown>) =>
    createPadrone('app')
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('init', (c) =>
        c
          .arguments(
            z.object({
              name: z.string(),
              db: z.object({ host: z.string().describe('Database host'), port: z.number(), user: z.string().optional() }),
              hosts: z.object({ name: z.string() }).array().optional(),
            }),
            { interactive: true },
          )
          .action((args) => args),
      );

  it('prompts object fields key by key', async () => {
    const answers: Record<string, string> = { name: 'app', 'db.host': 'localhost', 'db.port': '5432' };
    const prompt = mock(async (config: InteractivePromptConfig) => answers[config.name]);
    const result = await create(prompt).eval('init');
    expect(prompt.mock.calls.map(([config]) => [config.name, config.message])).toEqual([
      ['name', 'name'],
      ['db.host', 'Database host'],
      ['db.port', 'db.port'],
    ]);
    expect(result.result).toEqual({ name: 'app', db: { host: 'localhost', port: 5432 } });
  });

  it('prompts only the missing keys of an object', async () => {
    const prompt = mock(async (config: InteractivePromptConfig) => (config.name === 'db.port' ? '1' : 'x'));
    const result = await create(prompt).eval('init --name a --db.host h');
    expect(prompt.mock.calls.map(([config]) => config.name)).toEqual(['db.port']);
    expect(result.result).toEqual({ name: 'a', db: { host: 'h', port: 1 } });
  });

  it('asks again after a blank answer to a required field', async () => {
    const errors: string[] = [];
    const answers = ['', '  ', 'app'];
    const prompt = mock(async () => answers.shift());
    const program = createPadrone('app')
      .runtime({ ...quiet, error: (text) => errors.push(text), prompt, interactive: 'supported' })
      .command('init', (c) => c.arguments(z.object({ name: z.string() }), { interactive: true }).action((args) => args.name));
    const result = await program.eval('init');
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(result.result).toBe('app');
    expect(errors).toEqual(['A value for "name" is required', 'A value for "name" is required']);
  });
});

describe('stdin', () => {
  it('trims stdin with trim: true', async () => {
    const program = createPadrone('app').command('login', (c) =>
      c.arguments(z.object({ token: z.string() }), { stdin: { field: 'token', trim: true } }).action((args) => args.token),
    );
    expect((await testCli(program).stdin('  secret\n').run('login')).result).toBe('secret');
  });

  it('keeps stdin text as is by default', async () => {
    const program = createPadrone('app').command('cat', (c) =>
      c.arguments(z.object({ text: z.string() }), { stdin: 'text' }).action((args) => args.text),
    );
    expect((await testCli(program).stdin('a\n').run('cat')).result).toBe('a\n');
  });

  it('trims the newline for number and boolean fields', async () => {
    const program = createPadrone('app')
      .command('double', (c) => c.arguments(z.object({ n: z.number() }), { stdin: 'n' }).action((args) => args.n * 2))
      .command('flip', (c) => c.arguments(z.object({ on: z.boolean() }), { stdin: 'on' }).action((args) => !args.on));
    expect((await testCli(program).stdin('21\n').run('double')).result).toBe(42);
    expect((await testCli(program).stdin('true\n').run('flip')).result).toBe(false);
  });

  it('reads stdin for a lone "-"', async () => {
    const program = createPadrone('app')
      .command('cat', (c) =>
        c.arguments(z.object({ text: z.string(), n: z.number().optional() }), { stdin: 'text', positional: ['text'] }).action((a) => a),
      )
      .command('count', (c) =>
        c.arguments(z.object({ lines: z.string().array() }), { stdin: 'lines', positional: ['...lines'] }).action((a) => a.lines),
      );
    const tty = (text: string) => ({ isTTY: true, text: async () => text, lines: async function* () {} });
    expect((await testCli(program).stdin('piped').run('cat -')).result).toEqual({ text: 'piped' });
    expect((await testCli(program).stdin('piped').run('cat --text -')).result).toEqual({ text: 'piped' });
    expect((await program.eval('cat -', { runtime: { stdin: tty('typed') } } as never)).result).toEqual({ text: 'typed' });
    expect((await testCli(program).stdin('a\nb\n').run('count -')).result).toEqual(['a', 'b']);
    expect((await program.eval('cat -', { caller: 'serve' } as never)).result).toEqual({ text: '-' });
  });
});

describe('padroneConfirm env', () => {
  const create = (env: Record<string, string>, options?: Parameters<typeof padroneConfirm>[0]) => {
    const ran = mock(() => 'dropped');
    const program = createPadrone('my-db')
      .runtime({ ...quiet, env: () => env, interactive: 'unsupported' })
      .extend(padroneConfirm(options))
      .command('drop', (c) => c.configure({ mutation: true }).action(ran));
    return { ran, cli: () => program.cli({ runtime: { argv: () => ['drop'] } }) };
  };

  it('answers yes when <PROGRAM>_YES is set', async () => {
    const { ran, cli } = create({ MY_DB_YES: '1' });
    expect((await cli()).result).toBe('dropped');
    expect(ran).toHaveBeenCalled();
  });

  it('ignores a false value and mentions the variable', async () => {
    const { ran, cli } = create({ MY_DB_YES: '0' });
    expect(message(await cli())).toBe('"drop" needs confirmation: pass --yes (or set MY_DB_YES=1) to run it without a prompt');
    expect(ran).not.toHaveBeenCalled();
  });

  it('takes a custom variable, or none', async () => {
    expect((await create({ DB_ASSUME_YES: 'true' }, { env: 'DB_ASSUME_YES' }).cli()).result).toBe('dropped');
    expect(message(await create({ MY_DB_YES: '1' }, { env: 'DB_ASSUME_YES' }).cli())).toContain('needs confirmation');
    expect(message(await create({ MY_DB_YES: '1' }, { env: false }).cli())).toBe(
      '"drop" needs confirmation: pass --yes to run it without a prompt',
    );
  });
});
