import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPadrone } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import { generateDocs } from 'padrone/docs';
import * as z from 'zod/v4';

const createProgram = () =>
  createPadrone('app')
    .extend(padroneCompletion())
    .command('deploy', (c) =>
      c
        .configure({ description: 'Deploy the application' })
        .arguments(
          z.object({
            force: z.boolean().optional(),
            dryRun: z.boolean().optional(),
            region: z.string().optional(),
            oldRegion: z.string().optional(),
            verbose: z.boolean().optional(),
          }),
          {
            fields: {
              force: { flags: 'f', description: 'Skip checks' },
              verbose: { flags: 'v' },
              oldRegion: { deprecated: 'Use --region' },
            },
          },
        )
        .action(() => {}),
    )
    .command('destroy', (c) => c.configure({ deprecated: true }).action(() => {}))
    .command('db', (c) =>
      c
        .configure({ description: 'Database tools' })
        .command(['migrate', 'mig'], (m) => m.configure({ description: 'Run migrations' }).action(() => 1))
        .command('seed', (m) => m.configure({ description: 'Fill the database with sample data' }).action(() => 2)),
    );

const complete = async (...words: string[]) => {
  const { result } = await createProgram().eval(['__complete', ...words], { runtime: { output: () => {} } });
  return result as unknown as string[];
};

describe('completion: short flags', () => {
  it('offers short flags for `-`, next to the long names', async () => {
    expect(await complete('deploy', '-')).toEqual(['-f', '--force', '--dry-run', '--region', '-v', '--verbose', '-h', '--help']);
  });

  it('completes `-x` to the matching short flag, and `--` to long names only', async () => {
    expect(await complete('deploy', '-v')).toEqual(['-v']);
    expect(await complete('deploy', '--')).toEqual(['--force', '--dry-run', '--region', '--verbose', '--help']);
  });
});

describe('completion: deprecated commands and options', () => {
  it('hides them', async () => {
    expect(await complete('')).toEqual(['deploy', 'db']);
    expect(await complete('d')).toEqual(['deploy', 'db']);
    expect(await complete('deploy', '--')).not.toContain('--old-region');
  });

  it('still completes a prefix only they match', async () => {
    expect(await complete('des')).toEqual(['destroy']);
    expect(await complete('deploy', '--old')).toEqual(['--old-region']);
  });

  it('leaves them out of the static scripts', async () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell'] as const) {
      const script = await createPadrone('app')
        .command('destroy', (c) => c.configure({ deprecated: true }).action(() => {}))
        .command('deploy', (c) =>
          c.arguments(z.object({ oldRegion: z.string().optional() }), { fields: { oldRegion: { deprecated: true } } }).action(() => {}),
        )
        .completion(shell);
      expect(script).not.toContain('destroy');
      expect(script).not.toMatch(/old-?[rR]egion['\]\s]/);
    }
  });
});

describe('completion: camelCase options', () => {
  it('offers only the kebab-case name, as help shows it', async () => {
    expect(await complete('deploy', '--d')).toEqual(['--dry-run']);
  });

  it('still takes the camelCase name when typed', async () => {
    const program = createPadrone('app')
      .extend(padroneCompletion())
      .command('go', (c) => c.arguments(z.object({ logLevel: z.enum(['debug', 'info']).optional() })).action(() => {}));
    const { result } = await program.eval(['__complete', 'go', '--logLevel', ''], { runtime: { output: () => {} } });
    expect(result as unknown).toEqual(['debug', 'info']);
  });

  it('offers the kebab-case name in static scripts too', async () => {
    const program = createPadrone('app').command('go', (c) => c.arguments(z.object({ dryRun: z.boolean().optional() })).action(() => {}));
    const bash = await program.completion('bash');
    expect(bash).toContain('--dry-run');
    expect(bash).not.toContain('--dryRun');
  });
});

describe('completion: bash scripts read candidates without glob expansion', () => {
  it('reads lines with a read loop in the dynamic script', async () => {
    const script = await createProgram().completion('bash');
    expect(script).toContain('while IFS= read -r line');
    expect(script).not.toMatch(/=\(\$\(/);
  });

  it('reads compgen output with a read loop in the static script', async () => {
    const script = await createPadrone('app')
      .command('go', (c) =>
        c
          .arguments(z.object({ mode: z.enum(['a*', 'b']).optional(), out: z.string().optional() }), {
            fields: { out: { hint: 'dir' } },
          })
          .action(() => {}),
      )
      .completion('bash');
    expect(script).not.toMatch(/=\(\$\(/);
  });

  // A stand-in `app` prints the candidates, so the script's handling of them is all that's tested
  it.skipIf(!Bun.which('bash'))('keeps a `*` candidate as typed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'padrone-glob-'));
    try {
      mkdirSync(join(dir, 'src'));
      for (const file of ['a.json', 'b.json', 'src/c.ts']) writeFileSync(join(dir, file), '');
      writeFileSync(join(dir, 'app'), `#!/bin/sh\nprintf '*.json\\nsrc/*\\tSources\\n:nofiles\\n'\n`, { mode: 0o755 });
      writeFileSync(join(dir, 'completion.bash'), await createPadrone('app').extend(padroneCompletion()).completion('bash'));
      const script = `source completion.bash
COMP_WORDS=(app ''); COMP_CWORD=1; COMPREPLY=(); _app_completion; printf '%s\\n' "\${COMPREPLY[@]}"`;
      const proc = Bun.spawnSync(['bash', '-c', script], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
      expect(proc.stdout.toString().trim().split('\n')).toEqual(['\\*.json', 'src/\\*']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('completion: PowerShell empty arguments', () => {
  it('passes `""` for the word being typed, as Windows PowerShell 5.1 drops empty arguments', async () => {
    const script = await createProgram().completion('powershell');
    expect(script).toContain(`$words += '""'`);
  });

  it('takes a `""` last word as an empty one', async () => {
    expect(await complete('deploy', '""')).toEqual(await complete('deploy', ''));
    expect(await complete('""')).toEqual(['deploy', 'db']);
  });
});

describe('completion --instructions', () => {
  it('prints the install instructions for a named shell', async () => {
    const { result } = await createProgram().eval('completion fish --instructions', { runtime: { output: () => {}, env: () => ({}) } });
    expect(result).toContain('app completion fish > ~/.config/fish/completions/app.fish');
    expect(result).not.toContain('complete -c app');
  });

  it('prints them for the detected shell without a name, and says how to name one otherwise', async () => {
    const detected = await createProgram().eval('completion --instructions', {
      runtime: { output: () => {}, env: () => ({ SHELL: '/bin/zsh' }) },
    });
    expect(detected.result).toContain('app completion zsh >> ~/.zshrc');
    const unknown = await createProgram().eval('completion --instructions', { runtime: { output: () => {}, env: () => ({}) } });
    expect(unknown.result).toContain('app completion <shell>');
  });

  it('comments out the instructions printed above a detected shell’s script', async () => {
    const { result } = await createProgram().eval('completion', { runtime: { output: () => {}, env: () => ({ SHELL: '/bin/bash' }) } });
    const lines = String(result).split('\n');
    expect(lines).not.toContain('app completion bash >> ~/.bashrc');
    expect(lines).toContain('# app completion bash >> ~/.bashrc');
  });
});

describe('REPL: suggestions', () => {
  const runRepl = async (inputs: string[], scope?: string) => {
    const queue = [...inputs];
    const errors: string[] = [];
    const program = createProgram().runtime({
      readLine: async () => queue.shift() ?? null,
      output: () => {},
      error: (text) => errors.push(String(text)),
    });
    const { value } = await program.repl({ greeting: false, hint: false, scope }).drain();
    return { errors, results: value ?? [] };
  };

  it('suggests a command for a mistyped `.scope`', async () => {
    const { errors } = await runRepl(['.scope dbb']);
    expect(errors).toEqual(['Unknown command: dbb\n\n  Did you mean "db"?']);
  });

  it('suggests within the current scope', async () => {
    const { errors } = await runRepl(['.scope db', '.scope migrat']);
    expect(errors).toEqual(['Unknown command: migrat\n\n  Did you mean "migrate"?']);
  });

  it('runs `help <command>` for the current scope, with suggestions', async () => {
    const { errors, results } = await runRepl(['help mgirate', 'help migrate'], 'db');
    expect(errors[0]).toContain('Unknown command: db mgirate');
    expect(errors[0]).toContain('Did you mean "migrate"?');
    expect(String(results.at(-1)?.result)).toContain('Run migrations');
  });
});

describe('REPL: historyFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'padrone-history-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runRepl = async (inputs: string[], prefs: { historyFile: string | boolean; historySize?: number }) => {
    const queue = [...inputs];
    const output: string[] = [];
    const program = createProgram().runtime({
      readLine: async () => queue.shift() ?? null,
      output: (text) => output.push(String(text)),
      error: () => {},
      env: () => ({ XDG_STATE_HOME: join(dir, 'state'), HOME: dir }),
    });
    await program.repl({ greeting: false, hint: false, ...prefs }).drain();
    return output;
  };

  it('saves entries to the file and loads them in the next session', async () => {
    const file = join(dir, 'history');
    await runRepl(['db migrate', 'db seed', 'db seed'], { historyFile: file });
    expect(readFileSync(file, 'utf-8')).toBe('db migrate\ndb seed\n');
    const output = await runRepl(['.history'], { historyFile: file });
    expect(output.at(-1)).toBe('1  db migrate\n2  db seed');
  });

  it('keeps at most historySize entries', async () => {
    const file = join(dir, 'small');
    await runRepl(['db migrate', 'db seed', 'deploy'], { historyFile: file, historySize: 2 });
    expect(readFileSync(file, 'utf-8')).toBe('db seed\ndeploy\n');
  });

  it('defaults to a file in the state directory with `true`', async () => {
    await runRepl(['deploy'], { historyFile: true });
    const file = join(dir, 'state', 'app', 'repl_history');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('deploy\n');
  });
});

describe('help --search', () => {
  const program = createProgram();
  const search = async (input: string) => String((await program.eval(input, { runtime: { output: () => {}, format: 'text' } })).result);

  it('lists commands whose name, alias or description match', async () => {
    const result = await search('help --search data');
    expect(result).toContain('db');
    expect(result).toContain('db seed');
    expect(result).not.toContain('db migrate');
    expect(await search('help -s mig')).toContain('db migrate');
  });

  it('matches every word, case-insensitively, and says when nothing matches', async () => {
    expect(await search('help --search "SAMPLE fill"')).toContain('db seed');
    expect(await search('help --search nothing-here')).toBe('No commands or help topics match "nothing-here".');
  });

  it('searches help topics too', async () => {
    const withTopics = createPadrone('app', {
      builtins: { help: { topics: { environment: { description: 'Variables the app reads', content: 'APP_TOKEN' } } } },
    }).command('run', (c) => c.action(() => {}));
    const { result } = await withTopics.eval('help --search token', { runtime: { output: () => {}, format: 'text' } });
    expect(String(result)).toContain('environment');
  });
});

describe('man pages', () => {
  const program = createPadrone('app')
    .configure({ version: '1.2.3' })
    .command('db', (c) => c.command('migrate', (m) => m.action(() => {})).command('seed', (m) => m.action(() => {})));
  const page = (command: string, options: { date?: string } = { date: '2026-01-02' }) =>
    generateDocs(program, { format: 'man', ...options }).pages.find((p) => p.command === command)!.content;

  it('puts the date and version in .TH', () => {
    expect(page('db')).toStartWith('.TH "APP\\-DB" "1" "2026\\-01\\-02" "app 1.2.3" ""\n');
  });

  it('takes the date from SOURCE_DATE_EPOCH', () => {
    const withEpoch = program.runtime({ env: () => ({ SOURCE_DATE_EPOCH: '0' }) });
    const content = generateDocs(withEpoch, { format: 'man' }).pages[0]!.content;
    expect(content).toStartWith('.TH "APP" "1" "1970\\-01\\-01" "app 1.2.3" ""\n');
  });

  it('links the parent and subcommand pages in SEE ALSO', () => {
    expect(page('db')).toContain('.SH SEE ALSO\n\\fBapp\\fR(1), \\fBapp\\-db\\-migrate\\fR(1), \\fBapp\\-db\\-seed\\fR(1)\n');
    expect(page('db migrate')).toContain('.SH SEE ALSO\n\\fBapp\\-db\\fR(1)\n');
  });
});
