import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPadrone, padroneAliases } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import * as z from 'zod/v4';
import { commandSymbol, getCommand } from '../src/core/commands.ts';
import { getCompletions } from '../src/feature/complete.ts';
import { detectShellFromEnv, generateCompletion } from '../src/feature/completion.ts';

const quiet = { output: () => {}, error: () => {} };

const capture = (argv: string[]) => {
  const errors: string[] = [];
  const output: unknown[] = [];
  return { errors, output, runtime: { output: (v: unknown) => output.push(v), error: (t: string) => errors.push(t), argv: () => argv } };
};

describe('--repl from remote callers', () => {
  const program = createPadrone('app').action(() => 'root');

  it('does not start a REPL, and reports --repl as an unknown option', async () => {
    const repl = mock(() => {
      throw new Error('REPL started');
    });
    for (const caller of ['serve', 'mcp', 'tool'] as const) {
      const result = await program.eval(['--repl'], { caller, runtime: { ...quiet, readLine: repl } } as any);
      expect(repl).not.toHaveBeenCalled();
      expect(result.argsResult?.issues).toEqual([{ path: ['repl'], message: 'Unknown option: "repl"' }]);
    }
  });

  it('still strips --no-repl for local callers', () => {
    expect(program.eval('--no-repl', { runtime: quiet }).result as unknown).toBe('root');
  });
});

describe('--color', () => {
  const create = () =>
    createPadrone('app')
      .arguments(z.object({ name: z.string().optional() }), { positional: ['name'] })
      .action((args, ctx) => ({ name: args.name, format: ctx.runtime.format, theme: ctx.runtime.theme }));
  const run = (...argv: string[]) => create().eval(argv, { runtime: { ...quiet, format: 'auto' } }).result as any;

  it('a bare --color does not take the next word', () => {
    expect(run('--color', 'hello')).toMatchObject({ name: 'hello', format: 'ansi' });
    expect(run('--color')).toMatchObject({ name: undefined, format: 'ansi' });
  });

  it('takes values after =', () => {
    expect(run('--color=never', 'x')).toMatchObject({ name: 'x', format: 'text' });
    expect(run('--color=dracula', 'x')).toMatchObject({ name: 'x', format: 'ansi', theme: 'dracula' });
    expect(run('--no-color', 'x')).toMatchObject({ name: 'x', format: 'text' });
    expect(run('--color=auto')).toMatchObject({ format: 'auto' });
  });

  it('treats off/no/false/0 as off and on/yes/true/1 as on', () => {
    for (const value of ['off', 'no', 'false', '0', 'OFF']) expect(run(`--color=${value}`)).toMatchObject({ format: 'text' });
    for (const value of ['on', 'yes', 'true', '1', 'always']) {
      expect(run(`--color=${value}`)).toMatchObject({ format: 'ansi' });
      expect(run(`--color=${value}`).theme).toBeUndefined();
    }
  });
});

describe('dynamic completion', () => {
  const program = createPadrone('app')
    .command('db', (c) => c.command('migrate', (m) => m.action(() => {})))
    .command('deploy', (c) =>
      c
        .arguments(
          z.object({
            env: z.enum(['prod', 'dev']).optional(),
            force: z.boolean().optional(),
            target: z.enum(['web', 'api']).optional(),
          }),
          { positional: ['target'] },
        )
        .action(() => {}),
    );
  const root = (program as any)[commandSymbol];

  it("completes positionals after bash's split --opt=value", async () => {
    expect(await getCompletions(root, ['deploy', '--env', '=', 'prod', ''])).toEqual(['web', 'api']);
    expect(await getCompletions(root, ['deploy', '--force', '=', 'true', ''])).toEqual(['web', 'api']);
    expect(await getCompletions(root, ['deploy', '--env', '=', 'p'])).toEqual(['prod']);
    expect(await getCompletions(root, ['deploy', '--env', '='])).toEqual(['prod', 'dev']);
  });

  it('offers no subcommands after --', async () => {
    expect(await getCompletions(root, ['--', ''])).toEqual([]);
    expect(await getCompletions(root, ['db', '--', ''])).toEqual([]);
  });

  it('offers the help flags the program has', async () => {
    expect(await getCompletions(root, ['deploy', '--h'])).toEqual(['--help']);
    const noHelp = createPadrone('app', { builtins: { help: false } }).command('x', (c) => c.action(() => {}));
    expect(await getCompletions((noHelp as any)[commandSymbol], ['--'])).toEqual([]);
    const renamed = createPadrone('app', { builtins: { help: { flags: ['usage', 'u'] } } }).command('x', (c) => c.action(() => {}));
    expect(await getCompletions((renamed as any)[commandSymbol], ['--'])).toEqual(['--usage']);
  });
});

describe('static completion scripts', () => {
  const build = (builtins?: any) =>
    createPadrone('app', { builtins }).command('run', (c) =>
      c
        .configure({ description: 'Runs C:\\' })
        .arguments(z.object({ path: z.string().optional().describe('A path like C:\\') }))
        .action(() => {}),
    );

  it('escapes backslashes in fish descriptions', () => {
    const fish = generateCompletion(getCommand(build()), 'fish');
    expect(fish).toContain("-d 'Runs C:\\\\'");
    expect(fish).toContain("-d 'A path like C:\\\\'");
  });

  it('lists the built-in flags the program has', () => {
    const scripts = (builtins: any) =>
      (['bash', 'zsh', 'fish', 'powershell'] as const).map((shell) => {
        const program = createPadrone('app', { builtins }).command('run', (c) => c.action(() => {}));
        return generateCompletion(getCommand(program), shell);
      });
    for (const script of scripts(undefined)) {
      expect(script).toMatch(/--help|-l help/);
      expect(script).toMatch(/--version|-l version/);
    }
    for (const script of scripts({ help: false, version: false })) {
      expect(script).not.toMatch(/--help|-l help/);
      expect(script).not.toMatch(/--version|-l version/);
    }
    for (const script of scripts({ help: { flags: ['usage'] } })) {
      expect(script).toMatch(/--usage|-l usage/);
      expect(script).not.toMatch(/--help|-l help/);
    }
  });
});

describe('shell detection', () => {
  it("uses the runtime's environment", async () => {
    expect(await detectShellFromEnv({ SHELL: '/usr/bin/fish' })).toBe('fish');
    expect(await detectShellFromEnv({ PSModulePath: 'x' })).toBe('powershell');
    expect(await detectShellFromEnv({})).toBeUndefined();
  });

  it('`completion` without a shell detects it from the runtime', async () => {
    const program = createPadrone('app').extend(padroneCompletion());
    const result = await program.eval('completion', { runtime: { ...quiet, env: () => ({ SHELL: '/bin/zsh' }) } });
    expect(String(result.result)).toStartWith('# Detected shell: zsh');
  });
});

describe('help <unknown command>', () => {
  const create = (argv: string[]) => {
    const c = capture(argv);
    const program = createPadrone('app')
      .runtime(c.runtime)
      .command('db', (d) => d.command('migrate', (m) => m.action(() => 'm')).command('seed', (m) => m.action(() => 's')))
      .command('deploy', (d) => d.action(() => 'd'));
    return { program, errors: c.errors };
  };

  it('suggests similar commands and lists only visible ones', async () => {
    const { program, errors } = create(['help', 'dbb']);
    await program.cli();
    expect(errors).toEqual([
      'Unknown command: dbb\n\n  Did you mean "db"?',
      '\nAvailable commands: db, deploy',
      '\nRun "app --help" for usage.',
    ]);
  });

  it('lists the subcommands of the deepest known command', async () => {
    const { program, errors } = create(['help', 'db', 'migrat']);
    await program.cli();
    expect(errors).toEqual([
      'Unknown command: db migrat\n\n  Did you mean "migrate"?',
      '\nAvailable commands: migrate, seed',
      '\nRun "app db --help" for usage.',
    ]);
  });

  it("the tree a subcommand's parent leads to is the program's own", () => {
    const program = createPadrone('app').command('a', (c) => c.action(() => 'a'));
    const root = (program as any)[commandSymbol];
    for (const child of root.commands) expect(child.parent).toBe(root);
  });
});

describe('alias command', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'padrone-sweep3-aliases-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const create = () =>
    createPadrone('git')
      .runtime(quiet)
      .extend(padroneAliases({ file: join(dir, 'aliases.json') }))
      .command('checkout', (c) =>
        c.arguments(z.object({ branch: z.string().array().optional() }), { positional: ['...branch'] }).action((args) => args.branch),
      );

  it('marks set and delete as mutations', () => {
    const root: any = getCommand(create());
    const alias = root.commands.find((c: any) => c.name === 'alias');
    const byName = (name: string) => alias.commands.find((c: any) => c.name === name);
    expect(byName('set').mutation).toBe(true);
    expect(byName('delete').mutation).toBe(true);
    expect(byName('list').mutation).toBeFalsy();
  });

  it('keeps a word with spaces as one word', async () => {
    const program = create();
    await program.cli({ runtime: { argv: () => ['alias', 'set', 'co', 'checkout', 'my branch'] } });
    expect(JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf-8'))).toEqual({ co: 'checkout "my branch"' });
    expect((await program.cli({ runtime: { argv: () => ['co', 'x'] } })).result).toEqual(['my branch', 'x']);
  });

  it('keeps a single quoted expansion as typed', async () => {
    const program = create();
    await program.cli({ runtime: { argv: () => ['alias', 'set', 'co', 'checkout main'] } });
    expect(JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf-8'))).toEqual({ co: 'checkout main' });
    expect((await program.cli({ runtime: { argv: () => ['co'] } })).result).toEqual(['main']);
  });
});

describe('suggestions run: prompt', () => {
  const create = () => {
    const prompt = mock(async () => true);
    const program = createPadrone('app', { builtins: { suggestions: { run: 'prompt' } } })
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('deploy', (c) => c.arguments(z.object({ tag: z.string().optional() })).action((args) => `deployed ${args.tag ?? ''}`));
    return { program, prompt };
  };

  it('replaces the mistyped command, not an option value spelled the same', async () => {
    const { program, prompt } = create();
    const result = await program.cli({ runtime: { argv: () => ['--tag', 'dploy', 'dploy'] } });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.result).toBe('deployed dploy');
  });

  it('keeps the rest of a string input as it was tokenized', async () => {
    const { program, prompt } = create();
    const result = await program.eval('--tag "dploy x" dploy', { caller: 'repl' });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.result as unknown).toBe('deployed dploy x');
  });
});
