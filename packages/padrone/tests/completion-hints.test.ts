import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPadrone } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import * as z from 'zod/v4';
import { generateDocs } from '../src/docs/index.ts';

const deployArgs = z.object({
  target: z.string().optional(),
  config: z.string().optional(),
  out: z.string().optional(),
  shell: z.string().optional(),
  url: z.string().optional(),
  log: z.string().optional(),
  env: z.enum(['dev', 'prod']).optional(),
  region: z.union([z.literal('eu').describe('Europe'), z.literal('us')]).optional(),
  force: z.boolean().optional(),
});

const createProgram = () =>
  createPadrone('hintcli')
    .command('deploy', (c) =>
      c
        .configure({ description: 'Deploy the app' })
        .arguments(deployArgs, {
          positional: ['target'],
          fields: {
            target: { complete: () => [{ value: 'web', description: 'Web\tfrontend\nsecond line' }, 'api'], valueName: 'TARGET' },
            config: { description: 'Config file', hint: { ext: ['json', '.yaml'] }, valueName: 'FILE' },
            out: { description: 'Output directory', hint: 'dir', valueName: 'DIR' },
            shell: { hint: 'command' },
            url: { hint: 'url' },
            env: { hint: 'file' },
          },
        })
        .action(() => {}),
    )
    .command('copy', (c) =>
      c
        .arguments(z.object({ from: z.string(), to: z.string() }), { positional: ['from', 'to'], fields: { to: { hint: 'none' } } })
        .action(() => {}),
    )
    .command('build', (c) => c.configure({ title: 'Build it' }).action(() => {}));

describe('__complete2 protocol', () => {
  const program = createProgram().extend(padroneCompletion());
  const complete = async (...words: string[]) => {
    const output: string[] = [];
    const { result } = await program.eval(['__complete2', ...words], { runtime: { output: (text) => output.push(String(text)) } });
    return { lines: output.join('\n').split('\n'), result: result as any };
  };

  it('prints subcommands with their descriptions (title first), then a directive', async () => {
    expect((await complete('')).lines).toEqual(['deploy\tDeploy the app', 'copy', 'build\tBuild it', ':nofiles']);
  });

  it('prints option names with their descriptions, without file fallback', async () => {
    expect((await complete('deploy', '--c')).lines).toEqual(['--config\tConfig file', ':nofiles']);
    expect((await complete('deploy', '--h')).lines).toEqual(['--help\tShow help information', ':nofiles']);
  });

  it('prints complete() items and their descriptions on one line, dropping tabs and newlines', async () => {
    const { lines, result } = await complete('deploy', '');
    expect(lines).toEqual(['web\tWeb frontend', 'api', ':nofiles']);
    expect(result).toEqual({
      items: [{ value: 'web', description: 'Web\tfrontend\nsecond line' }, { value: 'api' }],
      directive: 'nofiles',
    });
  });

  it('prints enum values, with the descriptions of literal unions', async () => {
    expect((await complete('deploy', '--region', '')).lines).toEqual(['eu\tEurope', 'us', ':nofiles']);
    expect((await complete('deploy', '--region=')).lines).toEqual(['--region=eu\tEurope', '--region=us', ':nofiles']);
  });

  it('turns hints into directives', async () => {
    const directive = async (...words: string[]) => (await complete(...words)).lines.at(-1);
    expect(await directive('deploy', '--config', '')).toBe(':ext:json,yaml');
    expect(await directive('deploy', '--config=')).toBe(':ext:json,yaml');
    expect(await directive('deploy', '--config', '=', '')).toBe(':ext:json,yaml');
    expect(await directive('deploy', '--out', '')).toBe(':dirs');
    expect(await directive('deploy', '--shell', '')).toBe(':commands');
    expect(await directive('deploy', '--url', '')).toBe(':nofiles');
    expect(await directive('copy', 'a', '')).toBe(':nofiles');
  });

  it('falls back to files for values without a hint or candidates, and for an explicit file hint', async () => {
    const directive = async (...words: string[]) => (await complete(...words)).lines.at(-1);
    expect(await directive('deploy', '--log', '')).toBe(':files');
    expect(await directive('copy', '')).toBe(':files');
    expect(await directive('deploy', '--env', '')).toBe(':files');
    expect((await complete('deploy', '--env', '')).lines).toEqual(['dev', 'prod', ':files']);
  });

  it('offers nothing to fall back to after the positionals are filled', async () => {
    expect((await complete('deploy', 'web', '')).lines).toEqual([':nofiles']);
  });

  it('keeps __complete for older scripts: values only, one per line', async () => {
    const output: string[] = [];
    const { result } = await program.eval(['__complete', 'deploy', ''], { runtime: { output: (text) => output.push(String(text)) } });
    expect(output).toEqual(['web\napi']);
    expect(result as unknown).toEqual(['web', 'api']);
  });
});

describe('static scripts follow hints', () => {
  const program = createProgram();

  it('bash completes directories, extensions and commands for hinted options', async () => {
    const script = await program.completion('bash');
    expect(script).toContain(`--out) directive=':dirs' ;;`);
    expect(script).toContain(`--config) directive=':ext:json,yaml' ;;`);
    expect(script).toContain('compgen -d -- "$cur"');
  });

  it('zsh uses the value name as the label and the hint as the action', async () => {
    const script = await program.completion('zsh');
    expect(script).toContain(`'--out[Output directory]:DIR:_files -/'`);
    expect(script).toContain(`'--config[Config file]:FILE:_files -g "*.(json|yaml)"'`);
    expect(script).toContain(`'--shell[]: :_command_names -e'`);
    expect(script).toContain(`'--url[]: : '`);
    expect(script).toContain(`'--log[]: :_files'`);
    expect(script).toMatch(/'--force\[\]'$/m);
  });

  it('fish takes values for hinted and value options', async () => {
    const script = await program.completion('fish');
    expect(script).toContain(`-l out -d 'Output directory' -x -a '(__fish_complete_directories)'`);
    expect(script).toContain(`-l config -d 'Config file' -x -a '(__hintcli_complete_ext json yaml)'`);
    expect(script).toContain('function __hintcli_complete_ext');
    expect(script).toContain(`-l log -d '' -r`);
    expect(script).toMatch(/-l force -d ''$/m);
  });

  it('powershell sets the directive for hinted options', async () => {
    const script = await program.completion('powershell');
    expect(script).toContain(`'--out' { $directive = ':dirs' }`);
    expect(script).toContain('Get-ChildItem -Directory');
  });
});

describe('valueName in help and docs', () => {
  const program = createProgram();

  it('replaces the type placeholder of options and the name of positionals', () => {
    const help = program.help('deploy', { format: 'text' }) as string;
    expect(help).toContain('Usage: hintcli deploy [TARGET] [options]');
    expect(help).toMatch(/--out\s+\[DIR\]/);
    expect(help).toMatch(/--config\s+\[FILE\]/);
    expect(help).toMatch(/--log\s+\[string\]/);
    expect(help).toMatch(/^ {2}TARGET\s/m);
  });

  it('is part of the JSON help', () => {
    const info = JSON.parse(program.help('deploy', { format: 'json' }) as string);
    expect(info.positionals[0]).toMatchObject({ name: 'target', valueName: 'TARGET' });
    expect(info.arguments.find((a: any) => a.name === 'out')).toMatchObject({ valueName: 'DIR' });
  });

  it('shows in markdown, html and man docs', () => {
    const page = (format: 'markdown' | 'html' | 'man') =>
      generateDocs(program, { format }).pages.find((p) => p.command === 'deploy')!.content;
    expect(page('markdown')).toContain('hintcli deploy [TARGET] [options]');
    expect(page('markdown')).toContain('#### `--out <DIR>`');
    expect(page('html')).toContain('<span class="type">DIR</span>');
    expect(page('man')).toContain('\\fIDIR\\fR');
    expect(page('man')).toContain('[\\fITARGET\\fR]');
  });
});

// The generated scripts, run in real shells against the program as a subprocess
describe('shell integration', () => {
  let dir = '';
  let env: Record<string, string> = {};
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'padrone-hints-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(join(dir, 'work', 'sub'), { recursive: true });
    for (const file of ['a.json', 'b.yaml', 'c.txt']) writeFileSync(join(dir, 'work', file), '');
    const fixture = join(import.meta.dir, 'fixtures/completion-hints-program.ts');
    writeFileSync(join(bin, 'hintcli'), `#!/bin/sh\nexec "${process.execPath}" --conditions=padrone@dev "${fixture}" "$@"\n`);
    chmodSync(join(bin, 'hintcli'), 0o755);
    env = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}`, HOME: dir };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (shell: string, script: string) => {
    const proc = Bun.spawnSync([shell, '-c', script], { cwd: join(dir, 'work'), env });
    const lines = proc.stdout.toString().trim().split('\n');
    return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(' =>')), line.slice(line.indexOf(' =>') + 3).trim()]));
  };

  const bashCases = `
run() { COMP_WORDS=("$@"); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1)); COMPREPLY=(); _hintcli_completion; echo "$* => \${COMPREPLY[*]}"; }
run hintcli ''
run hintcli deploy ''
run hintcli deploy --config ''
run hintcli deploy --config = ''
run hintcli deploy --out ''
run hintcli deploy --shell hintc
run hintcli deploy --url ''
run hintcli deploy --log ''
run hintcli deploy --f`;

  it.skipIf(!Bun.which('bash'))('bash: dynamic script', () => {
    expect(run('bash', `eval "$(hintcli completion bash)"${bashCases}`)).toEqual({
      'hintcli ': 'deploy build',
      'hintcli deploy ': 'web api',
      'hintcli deploy --config ': 'sub a.json b.yaml',
      'hintcli deploy --config = ': 'sub a.json b.yaml',
      'hintcli deploy --out ': 'sub',
      'hintcli deploy --shell hintc': 'hintcli',
      'hintcli deploy --url ': '',
      // Left to `complete -o default`
      'hintcli deploy --log ': '',
      'hintcli deploy --f': '--force',
    });
  });

  it.skipIf(!Bun.which('bash'))('bash: static script', async () => {
    writeFileSync(join(dir, 'static.bash'), await createProgram().completion('bash'));
    expect(run('bash', `source ${join(dir, 'static.bash')}${bashCases}`)).toMatchObject({
      'hintcli deploy --config ': 'sub a.json b.yaml',
      'hintcli deploy --out ': 'sub',
      'hintcli deploy --shell hintc': 'hintcli',
      'hintcli deploy --url ': '',
    });
  });

  // Zsh's completion builtins only work inside a completion widget: stub them to see what the script asks for
  it.skipIf(!Bun.which('zsh'))('zsh: dynamic script', () => {
    const script = `compdef() { :; }
_describe() { print -rn -- "\${(@P)4}"; }
_files() { print -rn -- "_files $*"; }
_command_names() { print -rn -- "_command_names $*"; }
compset() { print -rn -- "compset $* | "; }
eval "$(hintcli completion zsh)"
run() { words=("$@"); CURRENT=$#; print -rn -- "$* => "; _hintcli_completion; print }
run hintcli ''
run hintcli deploy ''
run hintcli deploy --config ''
run hintcli deploy --config=
run hintcli deploy --out ''
run hintcli deploy --url ''
run hintcli deploy --log ''
run hintcli deploy --shell ''`;
    expect(run('zsh', script)).toEqual({
      'hintcli ': 'deploy:Deploy the app build:Build it',
      'hintcli deploy ': 'web:Web frontend api',
      'hintcli deploy --config ': '_files -g *.(json|yaml)',
      'hintcli deploy --config=': 'compset -P *= | _files -g *.(json|yaml)',
      'hintcli deploy --out ': '_files -/',
      'hintcli deploy --url ': '',
      'hintcli deploy --log ': '_files',
      'hintcli deploy --shell ': '_command_names -e',
    });
  });

  const fishCases = `
for c in 'hintcli ' 'hintcli deploy ' 'hintcli deploy --config ' 'hintcli deploy --config=' 'hintcli deploy --out ' 'hintcli deploy --url ' 'hintcli deploy --log ' 'hintcli deploy --f'
  echo "$c =>" (complete -C "$c" | string join ' | ')
end`;

  it.skipIf(!Bun.which('fish'))('fish: dynamic script', () => {
    expect(run('fish', `hintcli completion fish | source${fishCases}`)).toEqual({
      'hintcli ': 'build\tBuild it | deploy\tDeploy the app',
      'hintcli deploy ': 'api | web\tWeb frontend',
      'hintcli deploy --config ': 'a.json | b.yaml | sub/',
      'hintcli deploy --config=': '--config=a.json | --config=b.yaml | --config=sub/',
      'hintcli deploy --out ': 'sub/\tDirectory',
      'hintcli deploy --url ': '',
      'hintcli deploy --log ': 'a.json | b.yaml | c.txt | sub/',
      'hintcli deploy --f': '--force',
    });
  });

  it.skipIf(!Bun.which('fish'))('fish: static script', async () => {
    writeFileSync(join(dir, 'static.fish'), await createProgram().completion('fish'));
    expect(run('fish', `source ${join(dir, 'static.fish')}${fishCases}`)).toMatchObject({
      'hintcli deploy --config ': 'a.json | b.yaml | sub/',
      'hintcli deploy --out ': 'sub/\tDirectory',
      'hintcli deploy --url ': '',
    });
  });
});
