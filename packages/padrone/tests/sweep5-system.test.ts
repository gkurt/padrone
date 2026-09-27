import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPadrone, padroneUpdateCheck } from 'padrone';
import * as z from 'zod/v4';
import { runInit } from '../src/cli/init.ts';
import { getCommand } from '../src/core/commands.ts';
import { generateDocs } from '../src/docs/index.ts';
import { checkForUpdate } from '../src/extension/update-check.ts';
import { openInEditor } from '../src/feature/system.ts';
import { createUpdateChecker, fetchLatestVersion } from '../src/feature/update-check.ts';
import { writeToRcFile } from '../src/util/shell-utils.ts';

const tmp = (prefix = 'padrone-sweep5-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe('static completion scripts quote enum values', () => {
  const create = (values: [string, ...string[]]) =>
    createPadrone('app').command('run', (c) =>
      c.arguments(z.object({ mode: z.enum(values).optional().describe('Mode') })).action(() => {}),
    );

  it('bash: completes values with quotes and spaces literally, never running them', async () => {
    const dir = tmp();
    const marker = path.join(dir, 'pwned');
    const script = await create(["it's", 'a b', `$(touch ${marker})`]).completion('bash');
    const file = path.join(dir, 'app.bash');
    fs.writeFileSync(file, script);
    const run = Bun.spawnSync([
      'bash',
      '-c',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a bash script
      'source "$1"; COMP_WORDS=(app run --mode ""); COMP_CWORD=3; _app_completion; printf "%s\\n" "${COMPREPLY[@]}"',
      '_',
      file,
    ]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(run.stdout.toString().trimEnd().split('\n')).toEqual(["it's", 'a b', `$(touch ${marker})`]);
  });

  it('zsh: escapes values for the eval of the (...) action inside the quoted spec', async () => {
    const script = await create(["it's", 'a b', '$(x)', 'k:v']).completion('zsh');
    expect(script).toContain(String.raw`--mode[Mode]: :(it\'\''s a\ b \$\(x\) k\:v)'`);
  });

  it('fish: quotes values, which -a evaluates at completion time', async () => {
    const script = await create(["it's", 'a b', '(x)']).completion('fish');
    expect(script).toContain(String.raw`-xa '\'it\\\'s\' \'a b\' \'(x)\''`);
    expect(await create(['json', 'yaml']).completion('fish')).toContain("-xa 'json yaml'");
  });

  it('powershell: doubles single quotes, including typographic ones', async () => {
    const script = await create(["it's", 'rock’n’roll']).completion('powershell');
    expect(script).toContain("@('it''s', 'rock’’n’’roll')");
  });
});

describe('man pages', () => {
  it('never starts a line with a control character after a description ending in a newline', () => {
    const program = createPadrone('app').command('run', (c) =>
      c.arguments(z.object({ port: z.number().default(3).describe('The port\n') })).action(() => {}),
    );
    const page = generateDocs(program, { format: 'man', date: '2026-01-01' }).pages.find((p) => p.path === 'run.1')!;
    expect(page.content).not.toMatch(/^\. /m);
    expect(page.content).toContain('\\&. Default: 3');
  });
});

describe('padrone init', () => {
  it('writes valid code and JSON for names and descriptions with quotes', async () => {
    const dir = path.join(tmp(), "bob's-cli");
    const errors: string[] = [];
    const ctx = { runtime: { output: () => {}, error: (text: string) => errors.push(text) } } as never;
    await runInit({ dir, description: 'Bob\'s "great" CLI\\', version: '0.1.0' }, ctx);
    expect(errors).toEqual([]);
    const source = fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf-8');
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(source)).not.toThrow();
    expect(source).toContain(`createPadrone(${JSON.stringify("bob's-cli")})`);
    expect(source).toContain(`description: ${JSON.stringify('Bob\'s "great" CLI\\')}`);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).name).toBe("bob's-cli");
  });
});

describe('update check: registry versions', () => {
  const state = { body: {} as unknown, hits: 0 };
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => {
        state.hits++;
        return Response.json(state.body);
      },
    });
  });
  afterAll(() => server.stop(true));
  const runtime = (errors: string[] = []) => ({ error: (text: string) => errors.push(text), env: () => ({}), terminal: { isTTY: true } });

  it('ignores a version that is not a version, so no terminal escapes are printed', async () => {
    state.body = { version: '9.0.0\u001b]8;;https://evil.example\u0007' };
    const root = createPadrone('tool').extend(padroneUpdateCheck({ registry: server.url.href }));
    expect(await checkForUpdate(getCommand(root), '1.0.0')).toEqual({ latest: undefined, updateAvailable: false });
  });

  it('ignores a non-string dist-tag instead of throwing', async () => {
    state.body = { 'dist-tags': { latest: 2 } };
    expect(await fetchLatestVersion('tool', server.url.href)).toBeUndefined();
  });

  it('ignores a poisoned version in the cache file', async () => {
    const cache = path.join(tmp(), 'cache.json');
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now(), latestVersion: '9.0.0\u001b[2J' }));
    const errors: string[] = [];
    const check = await createUpdateChecker('tool', '1.0.0', { cache, registry: 'http://127.0.0.1:9/' }, runtime(errors) as never);
    check.notify();
    expect(errors.join('')).not.toContain('\u001b');
  });

  it('refreshes a cache whose last check is in the future (a clock that was wrong)', async () => {
    state.body = { version: '2.0.0' };
    state.hits = 0;
    const cache = path.join(tmp(), 'cache.json');
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now() + 365 * 86_400_000, latestVersion: '1.0.0' }));
    const check = await createUpdateChecker('tool', '1.0.0', { cache, registry: server.url.href }, runtime() as never);
    await check.refresh;
    expect(JSON.parse(fs.readFileSync(cache, 'utf-8')).latestVersion).toBe('2.0.0');
  });
});

describe('openInEditor', () => {
  it('passes the file to the editor literally, even with shell characters in the temp directory', async () => {
    const base = path.join(tmp(), 'dir-$HOME-`x`');
    fs.mkdirSync(base);
    const original = process.env.TMPDIR;
    process.env.TMPDIR = base;
    try {
      const text = await openInEditor('draft', { ...process.env, EDITOR: `sh -c 'printf saved > "$0"'` });
      expect(text).toBe('saved');
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
  });
});

describe('padrone link', () => {
  const cli = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
  const link = (cwd: string, home: string, ...args: string[]) =>
    Bun.spawnSync(['bun', '--conditions=padrone@dev', cli, 'link', ...args], { cwd, env: { ...process.env, HOME: home } });

  it('writes shims that run the entry from a directory with shell characters', () => {
    const home = tmp();
    const dir = path.join(tmp(), 'proj-$HOME-`x`');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'main.ts'), "console.log('ran')");
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'shim-tool', bin: 'src/main.ts', scripts: { start: 'bun src/main.ts' } }),
    );
    expect(link(dir, home).exitCode).toBe(0);
    const shim = path.join(home, '.padrone', 'bin', 'shim-tool');
    expect(Bun.spawnSync(['sh', shim]).stdout.toString()).toBe('ran\n');

    expect(link(dir, home, '--script', 'start', '--name', 'shim-script', '--pm', 'bun').exitCode).toBe(0);
    const script = fs.readFileSync(path.join(home, '.padrone', 'bin', 'shim-script'), 'utf-8');
    const words = Bun.spawnSync(['sh', '-c', `set -- ${script.split('\n')[2]!.replace(/ -- "\$@"$/, '')}; printf '%s\\n' "$@"`]);
    expect(words.stdout.toString().split('\n').slice(0, 4)).toEqual(['bun', `--cwd=${dir}`, 'run', 'start']);
  });
});

describe('writeToRcFile', () => {
  it('replaces a block with a snippet containing $ patterns literally', async () => {
    const rc = path.join(tmp(), '.bashrc');
    fs.writeFileSync(rc, 'before\n#begin\nold\n#end\nafter\n');
    const snippet = '#begin\nprintf $\'a\\n\' "$&"\n#end';
    await writeToRcFile(rc, snippet, '#begin', '#end');
    expect(fs.readFileSync(rc, 'utf-8')).toBe(`before\n${snippet}\nafter\n`);
  });
});
