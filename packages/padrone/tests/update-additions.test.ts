import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPadrone, padroneConfirm, padroneUpdateCheck, padroneUpgrade } from 'padrone';
import { createUpdateChecker } from '../src/feature/update-check.ts';
import { getVersion, readScriptVersion } from '../src/util/utils.ts';

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };
const tmp = (prefix = 'padrone-update-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function waitFor(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A registry that answers `{ version: latest }`, after `delay` ms. */
function createRegistry() {
  const state = { latest: '2.0.0', delay: 0, hits: 0 };
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: async () => {
        state.hits++;
        if (state.delay) await Bun.sleep(state.delay);
        return Response.json({ version: state.latest });
      },
    });
  });
  afterAll(() => server.stop(true));
  afterEach(() => {
    state.latest = '2.0.0';
    state.delay = 0;
    state.hits = 0;
  });
  return Object.assign(state, { url: () => server.url.href });
}

describe('getVersion reads the program’s own package', () => {
  const originalScript = process.argv[1];
  const originalCwd = process.cwd();
  const originalEnv = process.env.npm_package_version;
  afterEach(() => {
    process.argv[1] = originalScript!;
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.npm_package_version;
    else process.env.npm_package_version = originalEnv;
  });

  const install = () => {
    const root = tmp('padrone-version-');
    const pkg = path.join(root, 'lib', 'node_modules', 'tool');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'tool', version: '3.1.4' }));
    fs.writeFileSync(path.join(pkg, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), '');
    fs.mkdirSync(path.join(root, 'bin'));
    fs.symlinkSync(path.join(pkg, 'dist', 'cli.js'), path.join(root, 'bin', 'tool'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'project', version: '9.9.9' }));
    return { script: path.join(root, 'bin', 'tool'), project };
  };

  it('walks up from the script path, symlinks resolved, to the package it belongs to', async () => {
    const { script } = install();
    expect(await readScriptVersion(script)).toBe('3.1.4');
    expect(await readScriptVersion(path.join(os.tmpdir(), 'missing', 'cli.js'))).toBeUndefined();
    expect(await readScriptVersion('')).toBeUndefined();
  });

  it('ignores the working directory and npm_package_version', async () => {
    const { script, project } = install();
    process.chdir(project);
    process.env.npm_package_version = '9.9.9';
    process.argv[1] = script;
    expect(await getVersion()).toBe('3.1.4');
    expect(getVersion('1.2.3')).toBe('1.2.3');
    process.argv[1] = path.join(project, 'nowhere', 'cli.js');
    fs.rmSync(path.join(project, 'package.json'));
    expect(await getVersion()).toBe('0.0.0');
  });

  it('feeds --version when no version is configured', async () => {
    const { script, project } = install();
    process.chdir(project);
    process.argv[1] = script;
    const program = createPadrone('tool').runtime(quiet);
    expect((await program.eval('--version')).result as unknown).toBe('3.1.4');
  });
});

describe('upgrade --check --exit-code', () => {
  const registry = createRegistry();
  const create = () =>
    createPadrone('tool')
      .configure({ version: '1.0.0' })
      .extend(padroneUpgrade({ registry: registry.url() }));

  it('exits 1 when a newer version exists', async () => {
    const setExitCode = mock((_code: number) => {});
    const output: unknown[] = [];
    const result = await create().cli({
      runtime: { ...quiet, output: (value) => output.push(value), setExitCode, argv: () => ['upgrade', '--check', '--exit-code'] },
    });
    expect(result.error).toBeUndefined();
    expect(output).toEqual(['Update available: 1.0.0 → 2.0.0']);
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect((await create().eval('upgrade --check --exit-code')).exitCode).toBe(1);
  });

  it('exits 0 when up to date, and without the flag', async () => {
    const setExitCode = mock((_code: number) => {});
    await create().cli({ runtime: { ...quiet, setExitCode, argv: () => ['upgrade', '--check'] } });
    registry.latest = '1.0.0';
    await create().cli({ runtime: { ...quiet, setExitCode, argv: () => ['upgrade', '--check', '--exit-code'] } });
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('implies --check', async () => {
    const exec = mock(async () => 0);
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .extend(padroneUpgrade({ registry: registry.url(), installer: 'npm', exec }));
    const result = await program.eval('upgrade --exit-code');
    expect(result.result as unknown).toBe('Update available: 1.0.0 → 2.0.0');
    expect(result.exitCode).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('upgrade checks before asking for confirmation', () => {
  const registry = createRegistry();
  const create = (answer = true) => {
    const exec = mock(async (_command: readonly string[]) => 0);
    const prompt = mock(async () => {
      expect(registry.hits).toBe(1);
      return answer;
    });
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .extend(padroneConfirm())
      .extend(padroneUpgrade({ registry: registry.url(), installer: 'npm', exec }));
    const cli = (...argv: string[]) =>
      program.cli({ runtime: { ...quiet, argv: () => argv, prompt, interactive: 'supported', stdin: { isTTY: true } as never } });
    return { cli, exec, prompt };
  };

  it("doesn't ask when already up to date", async () => {
    registry.latest = '1.0.0';
    const { cli, exec, prompt } = create();
    const result = await cli('upgrade');
    expect(result.result as unknown).toBe('tool is up to date (1.0.0)');
    expect(prompt).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('asks once a newer version is found, then installs it', async () => {
    const { cli, exec, prompt } = create();
    const result = await cli('upgrade');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.result as unknown).toBe('Upgraded tool to 2.0.0');
    expect(exec).toHaveBeenCalledWith(['npm', 'install', '-g', 'tool@2.0.0']);
    expect(registry.hits).toBe(1);
  });

  it('installs nothing when the answer is no', async () => {
    const { cli, exec } = create(false);
    expect(((await cli('upgrade')).error as Error).message).toBe('Aborted');
    expect(exec).not.toHaveBeenCalled();
  });

  it('asks for --force even when up to date', async () => {
    registry.latest = '1.0.0';
    const { cli, exec, prompt } = create();
    await cli('upgrade', '--force');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(['npm', 'install', '-g', 'tool@1.0.0']);
  });

  it('works through run()', async () => {
    const exec = mock(async (_command: readonly string[]) => 0);
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .runtime(quiet)
      .extend(padroneUpgrade({ registry: registry.url(), installer: 'npm', exec }));
    const run = async (args: object) => (await program.run('upgrade' as never, args as never)).result as unknown;
    expect(await run({})).toBe('Upgraded tool to 2.0.0');
    expect(await run({ check: true })).toBe('Update available: 1.0.0 → 2.0.0');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('background update check', () => {
  const registry = createRegistry();
  const staleCache = (latestVersion = '1.5.0') => {
    const cache = path.join(tmp(), 'cache.json');
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: 0, latestVersion }));
    return cache;
  };
  const readCache = (cache: string) => JSON.parse(fs.readFileSync(cache, 'utf-8')) as { lastCheck: number; latestVersion: string };
  const runtime = (errors: string[] = []) => ({ error: (text: string) => errors.push(text), env: () => ({}), terminal: { isTTY: true } });

  it('notifies from the cache right away and refreshes it in the background', async () => {
    registry.delay = 300;
    const cache = staleCache();
    const errors: string[] = [];
    const start = Date.now();
    const check = await createUpdateChecker('tool', '1.0.0', { cache, registry: registry.url() }, runtime(errors) as never);
    check.notify();
    expect(Date.now() - start).toBeLessThan(250);
    expect(errors.join('')).toContain('Update available: 1.0.0 → 1.5.0');
    // Claimed right away, so concurrent runs don't check too
    expect(readCache(cache).lastCheck).toBeGreaterThan(0);
    await check.refresh;
    expect(readCache(cache).latestVersion).toBe('2.0.0');
  });

  it('keeps the cached version when the registry fails', async () => {
    const cache = staleCache();
    const check = await createUpdateChecker('tool', '1.0.0', { cache, registry: 'http://127.0.0.1:9/' }, runtime() as never);
    await check.refresh;
    expect(readCache(cache).latestVersion).toBe('1.5.0');
  });

  it('does not refresh a fresh cache', async () => {
    const cache = path.join(tmp(), 'cache.json');
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now(), latestVersion: '1.5.0' }));
    const check = await createUpdateChecker('tool', '1.0.0', { cache, registry: registry.url() }, runtime() as never);
    await check.refresh;
    expect(registry.hits).toBe(0);
  });

  it("doesn't hold up cli() or the process exit on a slow registry", async () => {
    registry.delay = 3000;
    const cache = staleCache();
    const dir = tmp();
    const script = path.join(dir, 'cli.ts');
    const entry = path.resolve(import.meta.dir, '../src/index.ts');
    fs.writeFileSync(
      script,
      `import { createPadrone, padroneUpdateCheck } from ${JSON.stringify(entry)};
createPadrone('tool')
  .configure({ version: '1.0.0' })
  .extend(padroneUpdateCheck({ cache: ${JSON.stringify(cache)}, registry: ${JSON.stringify(registry.url())} }))
  .runtime({ terminal: { isTTY: true }, env: () => ({}) })
  .command('hello', (c) => c.action(() => 'hello'))
  .cli();
`,
    );
    const start = Date.now();
    const child = Bun.spawn([process.execPath, '--conditions=padrone@dev', script, 'hello'], { stdout: 'pipe', stderr: 'pipe' });
    await child.exited;
    expect(Date.now() - start).toBeLessThan(2500);
    expect(await new Response(child.stdout).text()).toBe('hello\n');
    expect(await new Response(child.stderr).text()).toContain('Update available: 1.0.0 → 1.5.0');
    await waitFor(() => readCache(cache).latestVersion === '2.0.0', 6000);
  }, 10_000);
});

describe('update check cache location', () => {
  const registry = createRegistry();

  const setup = () => {
    const home = tmp('padrone-home-');
    const cacheHome = path.join(home, 'xdg-cache');
    const errors: string[] = [];
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .extend(padroneUpdateCheck({ registry: registry.url() }))
      .runtime({
        ...quiet,
        error: (text) => errors.push(text),
        env: () => ({ HOME: home, XDG_CACHE_HOME: cacheHome }),
        terminal: { isTTY: true },
      })
      .command('hello', (c) => c.action(() => 'hello'));
    return {
      home,
      errors,
      cache: path.join(cacheHome, 'tool', 'update-check.json'),
      run: () => program.cli({ runtime: { argv: () => ['hello'] } }),
    };
  };

  it('defaults to update-check.json in program.dirs.cache', async () => {
    const { cache, errors, run } = setup();
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now(), latestVersion: '2.0.0' }));
    await run();
    await waitFor(() => errors.join('').includes('Update available: 1.0.0 → 2.0.0'));
    expect(registry.hits).toBe(0);
  });

  it('moves the old ~/.config/<name>-update-check.json there', async () => {
    const { home, cache, errors, run } = setup();
    const legacy = path.join(home, '.config', 'tool-update-check.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ lastCheck: Date.now(), latestVersion: '2.0.0' }));
    await run();
    await waitFor(() => errors.join('').includes('Update available: 1.0.0 → 2.0.0'));
    expect(fs.existsSync(legacy)).toBe(false);
    expect(JSON.parse(fs.readFileSync(cache, 'utf-8')).latestVersion).toBe('2.0.0');
    expect(registry.hits).toBe(0);
  });

  it('ignores an unreadable old file', async () => {
    const { home, cache, run } = setup();
    const legacy = path.join(home, '.config', 'tool-update-check.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, 'not json');
    const result = await run();
    expect(result.error).toBeUndefined();
    await waitFor(() => fs.existsSync(cache));
  });
});

describe('version --check', () => {
  const registry = createRegistry();
  const create = () =>
    createPadrone('tool')
      .configure({ version: '1.0.0' })
      .runtime(quiet)
      .extend(padroneUpdateCheck({ registry: registry.url(), updateCommand: 'tool upgrade' }));

  it('adds an update notice, like gh version', async () => {
    const result = await create().eval('version --check');
    expect(result.result as unknown).toBe('1.0.0\n\n  Update available: 1.0.0 → 2.0.0\n  Run "tool upgrade" to update');
    expect((await create().eval('--version --check')).result as unknown).toBe(result.result);
  });

  it('prints only the version when up to date', async () => {
    registry.latest = '1.0.0';
    expect((await create().eval('version --check')).result as unknown).toBe('1.0.0');
  });

  it('returns the latest version under JSON output', async () => {
    const result = await create().eval('version --check', { runtime: { format: 'json' } });
    expect(result.result as unknown).toEqual({ name: 'tool', version: '1.0.0', latest: '2.0.0', updateAvailable: true });
    const verbose = await create().eval('version --check --verbose', { runtime: { format: 'json' } });
    expect(verbose.result as unknown).toMatchObject({ name: 'tool', version: '1.0.0', latest: '2.0.0', updateAvailable: true });
    expect((verbose.result as { runtime?: string }).runtime).toBeDefined();
  });

  it('suggests the upgrade command, and reads its registry without padroneUpdateCheck', async () => {
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .runtime(quiet)
      .extend(padroneUpgrade({ registry: registry.url() }));
    expect((await program.eval('version --check')).result as unknown).toContain('Run "tool upgrade" to update');
  });

  it('asks the npm registry by default', async () => {
    const original = globalThis.fetch;
    const fetchMock = mock(async (_url: string | URL | Request) => Response.json({ version: '1.2.0' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const program = createPadrone('tool').configure({ version: '1.0.0' }).runtime(quiet);
      expect((await program.eval('version --check')).result as unknown).toContain('Update available: 1.0.0 → 1.2.0');
      expect(String(fetchMock.mock.calls[0]![0])).toBe('https://registry.npmjs.org/tool/latest');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('warns when the registry cannot be reached', async () => {
    const errors: string[] = [];
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .runtime({ ...quiet, error: (text) => errors.push(text) })
      .extend(padroneUpdateCheck({ registry: 'http://127.0.0.1:9/' }));
    expect((await program.eval('version --check')).result as unknown).toBe('1.0.0');
    expect(errors).toEqual(["Couldn't check for updates"]);
  });

  it("doesn't reach the registry for remote callers", async () => {
    const result = await create().eval('version --check', { caller: 'mcp' });
    expect(result.result as unknown).toBe('1.0.0');
    expect(registry.hits).toBe(0);
  });
});
