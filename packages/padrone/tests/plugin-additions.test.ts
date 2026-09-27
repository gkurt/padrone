import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPadrone,
  defineInterceptor,
  detectInstaller,
  getProgramDirs,
  padroneAliases,
  padroneConfig,
  padroneLogger,
  padroneUpgrade,
} from 'padrone';
import * as z from 'zod/v4';
import { openInEditor } from '../src/feature/system.ts';

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };

describe('exactlyOne / atLeastOne', () => {
  const program = createPadrone('app')
    .command('fetch', (c) =>
      c
        .arguments(z.object({ file: z.string().optional(), url: z.string().optional() }), { exactlyOne: ['file', 'url'] })
        .action((args) => args),
    )
    .command('notify', (c) =>
      c
        .arguments(z.object({ email: z.string().optional(), slack: z.string().optional() }), { atLeastOne: ['email', 'slack'] })
        .action((args) => args),
    );
  const messages = (input: string) => (program.eval(input).argsResult?.issues ?? []).map((i) => i.message);

  it('requires exactly one of a group', () => {
    expect(messages('fetch --file a')).toEqual([]);
    expect(messages('fetch')).toEqual(['Exactly one of "--file", "--url" is required']);
    expect(messages('fetch --file a --url b')).toEqual(['Only one of "--file", "--url" can be used']);
  });

  it('requires at least one of a group', () => {
    expect(messages('notify --email a --slack b')).toEqual([]);
    expect(messages('notify')).toEqual(['At least one of "--email", "--slack" is required']);
  });

  it('takes several groups, and groups on global args', () => {
    const multi = createPadrone('app')
      .globalArgs(z.object({ token: z.string().optional(), tokenFile: z.string().optional() }), { exactlyOne: ['token', 'tokenFile'] })
      .command('export', (c) =>
        c
          .arguments(
            z.object({
              json: z.boolean().optional(),
              yaml: z.boolean().optional(),
              out: z.string().optional(),
              stdout: z.boolean().optional(),
            }),
            {
              exactlyOne: [
                ['json', 'yaml'],
                ['out', 'stdout'],
              ],
            },
          )
          .action(() => 'ok'),
      );
    const issues = (input: string) => (multi.eval(input).argsResult?.issues ?? []).map((i) => i.message);
    expect(issues('export --token t --json --stdout')).toEqual([]);
    expect(issues('export --token t --json')).toEqual(['Exactly one of "--out", "--stdout" is required']);
    expect(issues('export --json --stdout')).toEqual(['Exactly one of "--token", "--token-file" is required']);
  });
});

describe('interceptor requires ids', () => {
  const needsLogger = defineInterceptor({ name: 'needs-logger' })
    .requires('padrone:logger')
    .factory(() => ({}));

  it('fails when a required interceptor is missing', () => {
    const program = createPadrone('app')
      .intercept(needsLogger)
      .command('run', (c) => c.action(() => 'ran'));
    expect((program.eval('run').error as Error).message).toContain('"needs-logger" requires "padrone:logger"');
  });

  it('runs when it is registered on the command or a parent', () => {
    const program = createPadrone('app')
      .extend(padroneLogger())
      .command('run', (c) => c.intercept(needsLogger).action(() => 'ran'));
    expect(program.eval('run').result).toBe('ran');
  });

  it('keeps meta given to defineInterceptor(meta, factory), including async', () => {
    const errors: string[] = [];
    const program = createPadrone('app')
      .runtime({ ...quiet, error: (e) => errors.push(e) })
      .extend(padroneConfig({ files: ['app.json'], loadConfig: async () => ({ name: 'cfg' }) }))
      .command('run', (c) => c.arguments(z.object({ name: z.string() })).action((args) => args.name));
    return Promise.resolve(program.eval('run')).then((result) => {
      expect(result.result).toBe('cfg');
      expect(errors.filter((e) => e.includes('not marked as async'))).toEqual([]);
    });
  });
});

describe('program.dirs', () => {
  const home = { HOME: '/home/u' };

  it('follows XDG on Linux', () => {
    expect(getProgramDirs('app', home, 'linux')).toEqual({
      config: '/home/u/.config/app',
      cache: '/home/u/.cache/app',
      data: '/home/u/.local/share/app',
      state: '/home/u/.local/state/app',
      log: '/home/u/.local/state/app/log',
    });
    expect(getProgramDirs('app', { ...home, XDG_CACHE_HOME: '/c' }, 'linux').cache).toBe('/c/app');
  });

  it('follows platform conventions on macOS and Windows', () => {
    expect(getProgramDirs('app', home, 'darwin').cache).toBe('/home/u/Library/Caches/app');
    const win = getProgramDirs('app', { USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\R', LOCALAPPDATA: 'C:\\L' }, 'win32');
    expect(win.config).toBe('C:\\R\\app');
    expect(win.cache).toBe('C:\\L\\app\\Cache');
  });

  it('is available on the program, named after it', () => {
    const program = createPadrone('my-tool').runtime({ env: () => ({ HOME: '/h', XDG_CONFIG_HOME: '/x' }) });
    expect(program.dirs.config).toMatch(/^[/\\]x[/\\]my-tool$/);
  });
});

describe('runtime.page / editor / open', () => {
  it('writes the text with output when there is no terminal', async () => {
    const output: unknown[] = [];
    const program = createPadrone('app')
      .runtime({ ...quiet, output: (v) => output.push(v), terminal: { isTTY: false } })
      .command('log', (c) => c.async().action(async (_args, ctx) => ctx.runtime.page('line 1\nline 2')));
    await program.eval('log');
    expect(output).toEqual(['line 1\nline 2']);
  });

  it('can be replaced in the runtime', async () => {
    const editor = mock(async (text: string) => `${text} edited`);
    const open = mock(async () => {});
    const program = createPadrone('app')
      .runtime({ ...quiet, editor, open })
      .command('msg', (c) =>
        c.async().action(async (_args, ctx) => {
          await ctx.runtime.open('https://example.com');
          return ctx.runtime.editor('draft', { extension: '.md' });
        }),
      );
    expect((await program.eval('msg')).result as unknown).toBe('draft edited');
    expect(editor).toHaveBeenCalledWith('draft', { extension: '.md' });
    expect(open).toHaveBeenCalledWith('https://example.com');
  });

  it.skipIf(process.platform === 'win32')('opens $EDITOR on a temporary file and returns what was saved', async () => {
    const text = await openInEditor('draft', { ...process.env, EDITOR: `sh -c 'printf saved > "$0"'` });
    expect(text).toBe('saved');
  });
});

describe('suggestions run: prompt', () => {
  const create = (answer: unknown) => {
    const prompt = mock(async () => answer);
    const program = createPadrone('app', { builtins: { suggestions: { run: 'prompt' } } })
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('deploy', (c) => c.arguments(z.object({ env: z.string().optional() })).action((args) => `deployed ${args.env ?? ''}`));
    return { program, prompt };
  };

  it('runs the closest command when the user agrees', async () => {
    const { program, prompt } = create(true);
    const result = await program.cli({ runtime: { argv: () => ['dpeloy', '--env', 'prod'] } });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unknown command "dpeloy". Run "deploy" instead?' }));
    expect(result.result).toBe('deployed prod');
  });

  it('reports the error when declined, and never asks eval()', async () => {
    const { program, prompt } = create(false);
    const result = await program.cli({ runtime: { argv: () => ['dpeloy'] } });
    expect((result.error as Error).message).toContain('Did you mean "deploy"?');
    prompt.mockClear();
    expect(program.eval('dpeloy').error).toBeDefined();
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('help pickSubcommand', () => {
  const create = (answers: unknown[]) => {
    const prompt = mock(async () => answers.shift());
    const program = createPadrone('app', { builtins: { help: { pickSubcommand: true } } })
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('db', (c) =>
        c
          .command('migrate', (m) => m.configure({ description: 'Run migrations' }).action(() => 'migrated'))
          .command('seed', (m) => m.action(() => 'seeded')),
      );
    return { program, prompt };
  };

  it('asks which subcommand to run, through nested groups', async () => {
    const { program, prompt } = create(['db', 'seed']);
    const result = await program.cli({ runtime: { argv: () => [] } });
    expect(result.result).toBe('seeded');
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1] as unknown[]).toEqual([
      expect.objectContaining({
        type: 'select',
        choices: [
          { label: 'migrate — Run migrations', value: 'migrate' },
          { label: 'seed', value: 'seed' },
        ],
      }),
    ]);
  });

  it('still shows help for --help', async () => {
    const { program, prompt } = create(['migrate']);
    const result = await program.cli({ runtime: { argv: () => ['db', '--help'] } });
    expect(prompt).not.toHaveBeenCalled();
    expect(String(result.result)).toContain('migrate');
  });
});

describe('padroneAliases', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'padrone-aliases-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const create = () =>
    createPadrone('git')
      .runtime(quiet)
      .extend(padroneAliases({ file: join(dir, 'aliases.json'), aliases: { co: 'checkout' } }))
      .command('checkout', (c) =>
        c.arguments(z.object({ branch: z.string(), force: z.boolean().optional() }), { positional: ['branch'] }).action((args) => args),
      );
  const cli = (program: ReturnType<typeof create>, ...argv: string[]) => program.cli({ runtime: { argv: () => argv } });

  it('expands aliases the program defines', async () => {
    expect((await cli(create(), 'co', 'main')).result).toEqual({ branch: 'main' });
  });

  it('adds, expands with placeholders, lists and deletes user aliases', async () => {
    const program = create();
    await cli(program, 'alias', 'set', 'pr', 'checkout pr/$1 --force');
    expect(JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf-8'))).toEqual({ pr: 'checkout pr/$1 --force' });
    expect((await cli(program, 'pr', '42')).result).toEqual({ branch: 'pr/42', force: true });
    expect((await cli(program, 'alias', 'list')).result).toBe('co  checkout\npr  checkout pr/$1 --force');
    await cli(program, 'alias', 'delete', 'pr');
    expect(JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf-8'))).toEqual({});
  });

  it("doesn't let an alias shadow a command, or expand in eval()", async () => {
    const program = create();
    const result = await cli(program, 'alias', 'set', 'checkout', 'status');
    expect((result.error as Error).message).toBe('"checkout" is already a command');
    expect((await program.eval('co main')).error).toBeDefined();
  });
});

describe('padroneUpgrade', () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ 'dist-tags': { latest: '2.0.0', next: '3.0.0-beta.1' } }) });
  });
  afterAll(() => server.stop(true));

  const create = (options: Parameters<typeof padroneUpgrade>[0] = {}) => {
    const exec = mock(async (_command: readonly string[]) => 0);
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .runtime(quiet)
      .extend(padroneUpgrade({ registry: server.url.href, installer: 'bun', exec, ...options }));
    return { program, exec };
  };

  it('reports an available update with --check', async () => {
    const { program, exec } = create();
    expect((await program.eval('upgrade --check')).result as unknown).toBe('Update available: 1.0.0 → 2.0.0');
    expect(exec).not.toHaveBeenCalled();
  });

  it('installs the latest version, or a channel, with the package manager', async () => {
    const { program, exec } = create();
    expect((await program.eval('upgrade')).result as unknown).toBe('Upgraded tool to 2.0.0');
    expect(exec).toHaveBeenCalledWith(['bun', 'add', '-g', 'tool@2.0.0']);
    await program.eval('upgrade --channel next');
    expect(exec).toHaveBeenLastCalledWith(['bun', 'add', '-g', 'tool@3.0.0-beta.1']);
  });

  it('shows the command on --dry-run, and fails when the installer does', async () => {
    const { program, exec } = create();
    expect((await program.eval('upgrade --dry-run')).result as unknown).toBe(
      'Would upgrade tool 1.0.0 → 2.0.0 with: bun add -g tool@2.0.0',
    );
    expect(exec).not.toHaveBeenCalled();
    exec.mockImplementation(async () => 3);
    expect(((await program.eval('upgrade --to 1.5.0')).error as Error).message).toBe('"bun add -g tool@1.5.0" failed with exit code 3');
  });

  it('is up to date on the latest version, and takes a custom installer', async () => {
    const installer = mock(async () => undefined);
    const { program } = create({ installer });
    expect((await program.eval('upgrade --to 1.0.0')).result as unknown).toBe('tool is up to date (1.0.0)');
    await program.eval('upgrade');
    expect(installer).toHaveBeenCalledWith(expect.objectContaining({ packageName: 'tool', current: '1.0.0', version: '2.0.0' }));
  });

  it('detects the package manager from the install path', () => {
    expect(detectInstaller(['/opt/homebrew/Cellar/tool/1.0.0/bin/tool'])).toBe('brew');
    expect(detectInstaller(['/home/u/.bun/install/global/node_modules/tool/cli.js'])).toBe('bun');
    expect(detectInstaller(['/home/u/.local/share/pnpm/global/5/node_modules/tool/cli.js'])).toBe('pnpm');
    expect(detectInstaller(['/usr/local/lib/node_modules/tool/cli.js'])).toBe('npm');
  });
});
