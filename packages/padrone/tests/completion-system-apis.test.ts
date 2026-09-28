import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPadrone, padroneUpdateCheck, padroneUpgrade, verifySha256, verifySignature } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import { padroneMan } from 'padrone/man';
import * as z from 'zod/v4';
import { generateDocs } from '../src/docs/index.ts';
import { createUpdateChecker } from '../src/feature/update-check.ts';
import { argsToCliArgs } from '../src/feature/wrap.ts';
import type { PadroneCompleteContext } from '../src/index.ts';

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };
const tmp = (prefix = 'padrone-system-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── Completion hooks ─────────────────────────────────────────────────────

describe('command-level complete hook', () => {
  const calls: PadroneCompleteContext[] = [];
  const createProgram = () =>
    createPadrone('kube')
      .context<{ cluster: string }>()
      .runtime({ env: () => ({ KUBE_NS: 'prod' }) })
      .command('get', (c) =>
        c
          .context((ctx) => ({ ...ctx, scoped: true }))
          .arguments(z.object({ kind: z.string(), names: z.string().array().optional(), all: z.boolean().optional() }), {
            positional: ['kind', '...names'],
          })
          .configure({
            complete: (ctx) => {
              calls.push(ctx);
              if (ctx.position === 0) return [{ value: 'pods', description: 'Pods' }, 'services'];
              return { values: [`${ctx.positionals?.[0]}-a`, `${ctx.positionals?.[0]}-b`], directive: 'dirs' };
            },
          })
          .action(() => {}),
      )
      .command('logs', (c) =>
        c
          .arguments(z.object({ pod: z.string() }), { positional: ['pod'], fields: { pod: { complete: () => ['own'] } } })
          .configure({ complete: () => ['hook'] })
          .action(() => {}),
      )
      .command('broken', (c) =>
        c
          .arguments(z.object({ x: z.string() }), { positional: ['x'] })
          .configure({
            complete: () => {
              throw new Error('boom');
            },
          })
          .action(() => {}),
      )
      .extend(padroneCompletion());

  const complete = async (...words: string[]) => {
    const output: string[] = [];
    await createProgram().eval(['__complete2', ...words], {
      runtime: { output: (text) => output.push(String(text)) },
      context: { cluster: 'eu' },
    });
    return output.join('\n').split('\n');
  };

  it('offers the hook’s values for each positional, with the position, field and words before it', async () => {
    calls.length = 0;
    expect(await complete('get', '')).toEqual(['pods\tPods', 'services', ':nofiles']);
    expect(calls[0]).toMatchObject({ prefix: '', command: 'get', position: 0, field: 'kind', positionals: [] });
    expect(await complete('get', '--all', 'pods', 'x')).toEqual([':dirs']);
    expect(await complete('get', 'pods', 'pods-')).toEqual(['pods-a', 'pods-b', ':dirs']);
    expect(calls.at(-1)).toMatchObject({ prefix: 'pods-', position: 1, field: 'names', positionals: ['pods'] });
  });

  it('passes the parsed args, the transformed context and the runtime', async () => {
    calls.length = 0;
    await complete('get', '--all', '');
    const ctx = calls[0]!;
    expect(ctx.args).toEqual({ all: true });
    expect(ctx.context).toEqual({ cluster: 'eu', scoped: true });
    expect(ctx.runtime.env().KUBE_NS).toBe('prod');
  });

  it('lets a positional field’s own complete win, and offers nothing when the hook throws', async () => {
    expect(await complete('logs', '')).toEqual(['own', ':nofiles']);
    expect(await complete('broken', '')).toEqual([':nofiles']);
  });

  it('keeps offering subcommands next to the hook’s values', async () => {
    const program = createPadrone('app')
      .configure({ complete: () => ['value'] })
      .arguments(z.object({ target: z.string().optional() }), { positional: ['target'] })
      .command('sub', (c) => c.action(() => {}))
      .extend(padroneCompletion());
    const output: string[] = [];
    await program.eval(['__complete2', ''], { runtime: { output: (text) => output.push(String(text)) } });
    expect(output.join('\n').split('\n')).toEqual(['sub', 'value', ':nofiles']);
  });
});

describe('field complete returning a directive', () => {
  const program = createPadrone('app')
    .command('open', (c) =>
      c
        .arguments(z.object({ file: z.string(), out: z.string().optional(), bad: z.string().optional() }), {
          positional: ['file'],
          fields: {
            file: { complete: () => ({ values: [], directive: 'ext:json,yaml' }) },
            out: { complete: () => ({ values: ['stdout'], directive: 'dirs' }) },
            bad: { complete: () => ({ values: [], directive: 'ext:$(rm)' as never }) },
          },
        })
        .action(() => {}),
    )
    .extend(padroneCompletion());
  const complete = async (...words: string[]) => {
    const output: string[] = [];
    await program.eval(['__complete2', ...words], { runtime: { output: (text) => output.push(String(text)) } });
    return output.join('\n').split('\n');
  };

  it('prints the callback’s directive for positionals and options', async () => {
    expect(await complete('open', '')).toEqual([':ext:json,yaml']);
    expect(await complete('open', 'a.json', '--out', '')).toEqual(['stdout', ':dirs']);
    expect(await complete('open', 'a.json', '--out=')).toEqual(['--out=stdout', ':dirs']);
  });

  it('falls back to files for extensions a shell glob can’t take', async () => {
    expect(await complete('open', 'a.json', '--bad', '')).toEqual([':files']);
  });
});

// ── Static vs dynamic scripts ────────────────────────────────────────────

describe('completion script mode and descriptions', () => {
  const create = (options?: Parameters<typeof padroneCompletion>[0]) =>
    createPadrone('app')
      .runtime(quiet)
      .command('deploy', (c) =>
        c
          .configure({ description: 'Deploy it' })
          .arguments(z.object({ env: z.enum(['dev', 'prod']).optional() }), { fields: { env: { description: 'Target' } } })
          .action(() => {}),
      )
      .extend(padroneCompletion(options));
  const script = async (program: ReturnType<typeof create>, ...argv: string[]) =>
    (await program.eval(['completion', ...argv])).result as unknown as string;

  it('prints the dynamic script by default and a static one for --static', async () => {
    const program = create();
    expect(await script(program, 'bash')).toContain('__complete2');
    const staticScript = await script(program, 'bash', '--static');
    expect(staticScript).not.toContain('__complete2');
    expect(staticScript).toContain('local commands="deploy');
  });

  it('follows mode: static, which --no-static overrides', async () => {
    const program = create({ mode: 'static' });
    expect(await script(program, 'zsh')).not.toContain('__complete2');
    expect(await script(program, 'zsh', '--no-static')).toContain('__complete2');
    expect(await program.completion('fish', { mode: 'dynamic' })).toContain('__complete2');
  });

  it('leaves descriptions out of static scripts with --no-descriptions', async () => {
    const program = create();
    const zsh = await script(program, 'zsh', '--static');
    expect(zsh).toContain("'deploy:Deploy it'");
    expect(zsh).toContain("'--env[Target]: :(dev prod)'");
    const plain = await script(program, 'zsh', '--static', '--no-descriptions');
    expect(plain).toContain("'deploy'");
    expect(plain).toContain("'--env: :(dev prod)'");
    expect(plain).toContain("'--help'");
    const fish = await script(program, 'fish', '--static', '--no-descriptions');
    expect(fish).not.toContain(' -d ');
    expect(fish).toContain("-l env -xa 'dev prod'");
  });

  it('strips descriptions in dynamic scripts too', async () => {
    const program = create({ descriptions: false });
    const zsh = await script(program, 'zsh');
    expect(zsh).toContain('__complete2');
    expect(zsh).not.toContain(':${line#*');
    expect(await script(program, 'fish')).toContain("string replace -r -- '\\t.*' '' $lines");
    expect(await script(program, 'powershell')).toContain("'ParameterValue', $value)");
    expect(await script(program, 'zsh', '--descriptions')).toContain(':${line#*');
  });

  it('keeps --static and --no-descriptions in the snippet --setup installs', async () => {
    const home = tmp('padrone-home-');
    const program = create().runtime({ env: () => ({ HOME: home, SHELL: '/bin/bash' }) });
    const result = await script(program, 'bash', '--setup', '--static', '--no-descriptions');
    const rc = path.join(home, '.bashrc');
    expect(result).toBe(`Added app completions in ${rc}`);
    expect(fs.readFileSync(rc, 'utf-8')).toContain('eval "$(app completion bash --static --no-descriptions)"');
  });

  it('writes fish completions under the runtime’s HOME', async () => {
    const home = tmp('padrone-home-');
    const program = create().runtime({ env: () => ({ HOME: home }) });
    await script(program, 'fish', '--setup');
    expect(fs.readFileSync(path.join(home, '.config', 'fish', 'completions', 'app.fish'), 'utf-8')).toContain(
      'app completion fish | source',
    );
  });
});

// ── wrap() argv ──────────────────────────────────────────────────────────

describe('wrap separator and flagStyle', () => {
  const input = { name: 'x', tag: ['a', 'b'], force: true, off: false, file: '-rf' };

  it('keeps the default argv', () => {
    expect(argsToCliArgs(input, ['file'])).toEqual(['--name', 'x', '--tag', 'a', '--tag', 'b', '--force', '-rf']);
  });

  it('puts positionals after -- with separator: "--"', () => {
    expect(argsToCliArgs(input, ['file'], { separator: '--' })).toEqual([
      '--name',
      'x',
      '--tag',
      'a',
      '--tag',
      'b',
      '--force',
      '--',
      '-rf',
    ]);
    expect(argsToCliArgs({ name: 'x' }, ['file'], { separator: '--' })).toEqual(['--name', 'x']);
  });

  it('emits --key=value with flagStyle: "equals"', () => {
    expect(argsToCliArgs(input, ['file'], { flagStyle: 'equals' })).toEqual(['--name=x', '--tag=a', '--tag=b', '--force', '-rf']);
  });

  it('passes the argv to the wrapped command', async () => {
    const program = createPadrone('test').command('show', (c) =>
      c
        .arguments(z.object({ name: z.string(), files: z.string().array() }), { positional: ['...files'] })
        .wrap({ command: 'printf', args: ['%s\\n'], inheritStdio: false, separator: '--', flagStyle: 'equals' }),
    );
    const result = await (await program.run('show', { name: 'x', files: ['-a', 'b'] })).result;
    expect(result?.stdout?.trim().split('\n')).toEqual(['--name=x', '--', '-a', 'b']);
  });
});

// ── upgrade verify ───────────────────────────────────────────────────────

describe('padroneUpgrade verify', () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ version: '2.0.0' }) });
  });
  afterAll(() => server.stop(true));

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-upgrade-state-'));
  afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const create = (verify: NonNullable<Parameters<typeof padroneUpgrade>[0]>['verify'], installer?: 'npm' | (() => undefined)) => {
    const exec = mock(async (_command: readonly string[]) => 0);
    const program = createPadrone('tool')
      .configure({ version: '1.0.0' })
      .runtime({ ...quiet, env: () => ({ XDG_STATE_HOME: stateDir }) })
      .extend(padroneUpgrade({ registry: server.url.href, installer: installer ?? 'npm', exec, verify }));
    return { program, exec };
  };

  it('refuses to install when verify resolves false', async () => {
    const verify = mock(async () => false);
    const { program, exec } = create(verify);
    const { error } = await program.eval('upgrade');
    expect((error as Error).message).toBe("Couldn't verify tool 2.0.0; nothing was installed");
    expect(exec).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: 'tool', current: '1.0.0', version: '2.0.0', command: ['npm', 'install', '-g', 'tool@2.0.0'] }),
    );
  });

  it('installs when verify passes, and a throwing verify stops it', async () => {
    const ok = create(async () => true);
    expect((await ok.program.eval('upgrade')).result as unknown).toBe('Upgraded tool to 2.0.0');
    expect(ok.exec).toHaveBeenCalledTimes(1);
    const failing = create(() => {
      throw new Error('bad signature');
    });
    expect(((await failing.program.eval('upgrade')).error as Error).message).toBe('bad signature');
    expect(failing.exec).not.toHaveBeenCalled();
  });

  it('runs before a custom installer, and not on --dry-run', async () => {
    const order: string[] = [];
    const installer = mock(() => {
      order.push('install');
      return undefined;
    });
    const verify = mock((_plan: { command?: readonly string[] }) => {
      order.push('verify');
    });
    const { program } = create(verify, installer);
    await program.eval('upgrade');
    expect(order).toEqual(['verify', 'install']);
    expect(verify.mock.calls[0]?.[0].command).toBeUndefined();
    await program.eval('upgrade --dry-run');
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('padroneUpgrade --rollback', () => {
  let server: ReturnType<typeof Bun.serve>;
  let stateDir: string;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ version: '2.0.0' }) });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-rollback-'));
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const create = (version: string, commands: (readonly string[])[]) =>
    createPadrone('tool')
      .configure({ version })
      .runtime({ ...quiet, env: () => ({ XDG_STATE_HOME: stateDir }) })
      .extend(
        padroneUpgrade({
          registry: server.url.href,
          installer: 'npm',
          exec: async (command) => {
            commands.push(command);
            return 0;
          },
        }),
      );

  it('goes back to the version the last upgrade replaced', async () => {
    const commands: (readonly string[])[] = [];
    expect((await create('1.0.0', commands).eval('upgrade')).result as unknown).toBe('Upgraded tool to 2.0.0');
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'tool', 'upgrade.json'), 'utf-8')).previous).toBe('1.0.0');
    expect((await create('2.0.0', commands).eval('upgrade --rollback')).result as unknown).toBe('Rolled back tool to 1.0.0');
    expect(commands.at(-1)).toEqual(['npm', 'install', '-g', 'tool@1.0.0']);
  });

  it('fails without a record, and with --to', async () => {
    const program = create('2.0.0', []);
    expect(((await program.eval('upgrade --rollback')).error as Error).message).toBe('No previous version is recorded to roll back to');
    expect(((await program.eval('upgrade --rollback --to 1.5.0')).error as Error).message).toContain("can't be combined");
  });
});

describe('verifySignature', () => {
  it('verifies Ed25519 and ECDSA signatures with PEM or raw keys, in hex or base64', async () => {
    const data = new TextEncoder().encode('release bytes');
    const ed = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, ed.privateKey, data));
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', ed.publicKey));
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
    const hex = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(await verifySignature(data, sig, pem)).toBe(true);
    expect(await verifySignature('release bytes', hex, pem)).toBe(true);
    expect(
      await verifySignature(data, btoa(String.fromCharCode(...sig)), new Uint8Array(await crypto.subtle.exportKey('raw', ed.publicKey))),
    ).toBe(true);
    expect(await verifySignature('tampered', sig, pem)).toBe(false);
    expect(await verifySignature(data, 'not a signature', pem)).toBe(false);

    const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    const ecSig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ec.privateKey, data);
    const ecKey = new Uint8Array(await crypto.subtle.exportKey('raw', ec.publicKey));
    expect(await verifySignature(data, ecSig, ecKey, { algorithm: 'ECDSA-P256' })).toBe(true);
    expect(await verifySignature(data, ecSig, ecKey)).toBe(false);
  });
});

describe('verifySha256', () => {
  // sha256("hello")
  const digest = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

  it('checks a hex digest', async () => {
    expect(await verifySha256('hello', digest)).toBe(true);
    expect(await verifySha256(new TextEncoder().encode('hello'), digest.toUpperCase())).toBe(true);
    expect(await verifySha256('hello!', digest)).toBe(false);
    expect(await verifySha256('hello', 'not a digest')).toBe(false);
  });

  it('picks the file’s line from a SHA256SUMS file', async () => {
    const sums = `${'0'.repeat(64)}  tool-linux-arm64\n${digest} *tool-linux-x64\n`;
    expect(await verifySha256('hello', sums, 'tool-linux-x64')).toBe(true);
    expect(await verifySha256('hello', sums, 'tool-linux-arm64')).toBe(false);
    expect(await verifySha256('hello', sums, 'tool-darwin')).toBe(false);
    expect(await verifySha256('hello', sums)).toBe(false);
    expect(await verifySha256(new TextEncoder().encode('hello').buffer, `${digest}  ./tool`, 'tool')).toBe(true);
  });
});

// ── update-check shouldNotify / format ───────────────────────────────────

describe('padroneUpdateCheck shouldNotify and format', () => {
  const freshCache = () => {
    const cache = path.join(tmp(), 'cache.json');
    fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now(), latestVersion: '2.0.0' }));
    return cache;
  };
  const runtime = (errors: string[], env: Record<string, string> = {}) => ({
    error: (text: string) => errors.push(text),
    env: () => env,
    terminal: { isTTY: true },
  });

  it('suppresses the notice when shouldNotify returns false', async () => {
    const errors: string[] = [];
    const shouldNotify = mock(
      ({ runtime }: { runtime: { env: () => Record<string, string | undefined> } }) => !runtime.env().npm_lifecycle_event,
    );
    const config = { cache: freshCache(), registry: 'http://127.0.0.1:9/', shouldNotify };
    (await createUpdateChecker('tool', '1.0.0', config, runtime(errors, { npm_lifecycle_event: 'test' }) as never)).notify();
    expect(errors).toEqual([]);
    expect(shouldNotify).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: 'tool', current: '1.0.0', latest: '2.0.0', updateCommand: 'npm update -g tool' }),
    );
    (await createUpdateChecker('tool', '1.0.0', config, runtime(errors) as never)).notify();
    expect(errors.join('')).toContain('Update available: 1.0.0 → 2.0.0');
  });

  it('follows a channel: pre-releases count, and each channel has its own cache file', async () => {
    const errors: string[] = [];
    const home = tmp();
    const env = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') };
    const cacheDir = path.join(home, 'cache', 'tool');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'update-check.json'), JSON.stringify({ lastCheck: Date.now(), latestVersion: '3.0.0' }));
    fs.writeFileSync(
      path.join(cacheDir, 'update-check-next.json'),
      JSON.stringify({ lastCheck: Date.now(), latestVersion: '2.0.0-beta.2' }),
    );
    const registry = 'http://127.0.0.1:9/';
    (await createUpdateChecker('tool', '2.0.0-beta.1', { registry, channel: 'next' }, runtime(errors, env) as never)).notify();
    expect(errors.join('')).toContain('Update available: 2.0.0-beta.1 → 2.0.0-beta.2');
    errors.length = 0;
    (await createUpdateChecker('tool', '1.0.0', { registry, channel: 'next' }, runtime(errors, env) as never)).notify();
    expect(errors.join('')).toContain('1.0.0 → 2.0.0-beta.2');
    errors.length = 0;
    (await createUpdateChecker('tool', '1.0.0', { registry }, runtime(errors, env) as never)).notify();
    expect(errors.join('')).toContain('1.0.0 → 3.0.0');
  });

  it('rewords the notice with format, also for version --check', async () => {
    const errors: string[] = [];
    const format = ({ current, latest, updateCommand }: { current: string; latest: string; updateCommand: string }) =>
      `${current} -> ${latest}: ${updateCommand}`;
    const config = { cache: freshCache(), registry: 'http://127.0.0.1:9/', format, updateCommand: 'tool upgrade' };
    (await createUpdateChecker('tool', '1.0.0', config, runtime(errors) as never)).notify();
    expect(errors).toEqual(['1.0.0 -> 2.0.0: tool upgrade']);

    const server = Bun.serve({ port: 0, fetch: () => Response.json({ version: '2.0.0' }) });
    try {
      const program = createPadrone('tool')
        .configure({ version: '1.0.0' })
        .runtime(quiet)
        .extend(padroneUpdateCheck({ registry: server.url.href, format }));
      expect((await program.eval('version --check')).result as unknown).toBe('1.0.0\n1.0.0 -> 2.0.0: npm update -g tool');
    } finally {
      server.stop(true);
    }
  });
});

// ── man section / dir ────────────────────────────────────────────────────

describe('padroneMan section and dir', () => {
  const create = (env: Record<string, string>, options?: Parameters<typeof padroneMan>[0]) =>
    createPadrone('tool')
      .configure({ version: '1.0.0', description: 'Say "hi"' })
      .runtime({ ...quiet, env: () => env })
      .command('sub', (c) => c.action(() => {}))
      .extend(padroneMan(options));

  it('installs into XDG_DATA_HOME from the runtime env', async () => {
    const data = tmp('padrone-data-');
    const program = create({ HOME: tmp('padrone-home-'), XDG_DATA_HOME: data });
    const result = (await program.eval('man --setup')).result as unknown as string;
    const dir = path.join(data, 'man', 'man1');
    expect(result).toBe(`Installed 2 man page(s) in ${dir}`);
    expect(fs.readdirSync(dir).sort()).toEqual(['tool-sub.1', 'tool.1']);
  });

  it('falls back to the runtime HOME', async () => {
    const home = tmp('padrone-home-');
    await create({ HOME: home }).eval('man --setup');
    expect(fs.existsSync(path.join(home, '.local', 'share', 'man', 'man1', 'tool.1'))).toBe(true);
  });

  it('uses the section in .TH, SEE ALSO, file names and the default dir', async () => {
    const data = tmp('padrone-data-');
    const program = create({ HOME: tmp('padrone-home-'), XDG_DATA_HOME: data }, { section: 8 });
    const page = (await program.eval('man')).result as unknown as string;
    expect(page).toContain('.TH "TOOL" "8"');
    expect(page).toContain('\\fBtool\\-sub\\fR(8)');
    await program.eval('man --setup');
    expect(fs.readdirSync(path.join(data, 'man', 'man8')).sort()).toEqual(['tool-sub.8', 'tool.8']);
    const removed = (await program.eval('man --remove')).result as unknown as string;
    expect(removed).toBe(`Removed 2 man page(s) from ${path.join(data, 'man', 'man8')}`);
  });

  it('installs into dir, expanding ~ from the runtime HOME', async () => {
    const home = tmp('padrone-home-');
    await create({ HOME: home }, { dir: '~/man/custom' }).eval('man --setup');
    expect(fs.readdirSync(path.join(home, 'man', 'custom')).sort()).toEqual(['tool-sub.1', 'tool.1']);
    const other = tmp('padrone-man-');
    await create({ HOME: home }, { dir: other, section: '1m' }).eval('man --setup');
    expect(fs.readdirSync(other).sort()).toEqual(['tool-sub.1m', 'tool.1m']);
  });

  it('escapes quotes in .TH arguments', () => {
    const program = createPadrone('tool').configure({ version: '1.0 "beta"' });
    const page = generateDocs(program, { format: 'man', date: '2026-01-01', section: 1 }).pages[0]!;
    expect(page.path).toBe('index.1');
    expect(page.content.split('\n')[0]).toBe('.TH "TOOL" "1" "2026\\-01\\-01" "tool 1.0 \\(dqbeta\\(dq" ""');
  });
});
