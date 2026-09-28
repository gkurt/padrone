import { afterEach, beforeEach, describe, expect, expectTypeOf, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InteractivePromptConfig, PadroneCommandRunner, PadroneCredentialBackend, PadronePrompt, PadroneRuntime } from 'padrone';
import {
  createPadrone,
  createPrompt,
  defineInterceptor,
  isPromptCancel,
  PROMPT_CANCEL,
  PromptCancelledError,
  PromptUnavailableError,
  padroneConfirm,
  padroneCredentials,
} from 'padrone';
import { testCli } from 'padrone/test';
import * as z from 'zod/v4';
import { runEnquirerPrompt } from '../src/core/default-runtime.ts';
import { parseKeychainDump, spawnCommandRunner } from '../src/feature/credentials.ts';

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} } satisfies PadroneRuntime;

/** A runtime that answers prompts from `answers` by name and records the questions. */
function scripted(answers: Record<string, unknown>, extra: PadroneRuntime = {}) {
  const asked: InteractivePromptConfig[] = [];
  const errors: string[] = [];
  const runtime: PadroneRuntime = {
    ...quiet,
    error: (text) => errors.push(text),
    interactive: 'supported',
    stdin: { isTTY: true, text: async () => '', lines: async function* () {} },
    prompt: async (config) => {
      asked.push(config);
      const answer = answers[config.name];
      return Array.isArray(answer) && !config.choices ? answer.shift() : answer;
    },
    ...extra,
  };
  return { runtime, asked, errors };
}

// ── Prompts ──────────────────────────────────────────────────────────────

describe('ctx.prompt', () => {
  it('asks text, password, confirm, select and multiselect through runtime.prompt', async () => {
    const { runtime, asked } = scripted({
      'Project name?': 'demo',
      token: 's3cret',
      'Use TypeScript?': true,
      port: '8080',
      features: ['lint', 'test'],
    });
    const program = createPadrone('app')
      .runtime(runtime)
      .command('init', (c) =>
        c.action(async (_, ctx) => ({
          name: await ctx.prompt.text('Project name?'),
          token: await ctx.prompt.password({ message: 'Token', name: 'token' }),
          ts: await ctx.prompt.confirm({ message: 'Use TypeScript?' }),
          port: await ctx.prompt.select({ message: 'Port', name: 'port', choices: [3000, { value: 8080, label: 'Alt', hint: 'dev' }] }),
          features: await ctx.prompt.multiselect({ message: 'Features', name: 'features', choices: ['lint', 'test', 'docs'] }),
        })),
      );
    const result = await program.eval('init');
    expect(result.result as unknown).toEqual({ name: 'demo', token: 's3cret', ts: true, port: 8080, features: ['lint', 'test'] });
    expect(asked.map((q) => q.type)).toEqual(['input', 'password', 'confirm', 'select', 'multiselect']);
    expect(asked[3]!.choices).toEqual([
      { value: 3000, label: '3000' },
      { value: 8080, label: 'Alt — dev' },
    ]);
  });

  // Type-level only: never called
  const _inferTypes = (prompt: PadronePrompt) => {
    expectTypeOf(prompt.select({ message: 'm', choices: ['a', 'b'] })).toEqualTypeOf<Promise<'a' | 'b'>>();
    expectTypeOf(prompt.select({ message: 'm', choices: [{ value: 1 }, { value: 2, label: 'Two' }] })).toEqualTypeOf<Promise<1 | 2>>();
    expectTypeOf(prompt.multiselect({ message: 'm', choices: ['x', 'y'] })).toEqualTypeOf<Promise<('x' | 'y')[]>>();
    const grouped = prompt.group({
      name: () => prompt.text('Name'),
      role: () => prompt.select({ message: 'Role', choices: ['admin', 'user'] }),
      admin: ({ results }) => {
        expectTypeOf(results.name).toEqualTypeOf<string | undefined>();
        return results.role === 'admin' ? prompt.confirm('Sure?') : undefined;
      },
    });
    // A step that reads `results` can't be inferred; an explicit type argument types it
    expectTypeOf(grouped).resolves.toEqualTypeOf<{ name: string; role: 'admin' | 'user'; admin: unknown }>();
    const explicit = prompt.group<{ name: string; admin: boolean | undefined }>({
      name: () => prompt.text('Name'),
      admin: ({ results }) => (results.name ? prompt.confirm('Sure?') : undefined),
    });
    expectTypeOf(explicit).resolves.toEqualTypeOf<{ name: string; admin: boolean | undefined }>();
  };

  it('group asks in order, passes earlier answers, and names questions after their keys (testCli)', async () => {
    const seen: unknown[] = [];
    const program = createPadrone('app').command('setup', (c) =>
      c.action((_, ctx) =>
        ctx.prompt.group({
          name: () => ctx.prompt.text('Project name?'),
          lang: () => ctx.prompt.select({ message: 'Language', choices: ['ts', 'js'] }),
          strict: ({ results }) => {
            seen.push({ ...results });
            return results.lang === 'ts' ? ctx.prompt.confirm('Strict mode?') : undefined;
          },
          named: () => ctx.prompt.text({ message: 'Own name', name: 'custom' }),
        }),
      ),
    );
    const result = await testCli(program).prompt({ name: 'demo', lang: 'ts', strict: true, custom: 'x' }).run('setup');
    expect(result.result as unknown).toEqual({ name: 'demo', lang: 'ts', strict: true, named: 'x' });
    expect(seen).toEqual([{ name: 'demo', lang: 'ts' }]);
  });

  it('re-asks until validate accepts, and a blank text answer takes the default', async () => {
    const { runtime, errors } = scripted({ Age: ['x', '42'], City: '' });
    const program = createPadrone('app')
      .runtime(runtime)
      .command('ask', (c) =>
        c.action(async (_, ctx) => [
          await ctx.prompt.text({ message: 'Age', validate: (v) => (/^\d+$/.test(v) ? undefined : 'Enter a number') }),
          await ctx.prompt.text({ message: 'City', default: 'Paris' }),
        ]),
      );
    expect((await program.eval('ask')).result as unknown).toEqual(['42', 'Paris']);
    expect(errors).toEqual(['Enter a number']);
  });

  it('an empty answer is not a cancellation', async () => {
    const { runtime } = scripted({ Note: '' });
    const program = createPadrone('app')
      .runtime(runtime)
      .command('ask', (c) => c.action((_, ctx) => ctx.prompt.text('Note')));
    expect((await program.eval('ask')).result as unknown).toBe('');
  });

  it('cancelling throws PromptCancelledError, which cli() reports with exit code 130', async () => {
    const codes: number[] = [];
    const { runtime, errors } = scripted({ 'Project name?': PROMPT_CANCEL }, { setExitCode: (code) => codes.push(code) });
    let caught: unknown;
    const program = createPadrone('app')
      .runtime(runtime)
      .command('init', (c) =>
        c.action(async (_, ctx) => {
          try {
            return await ctx.prompt.text('Project name?');
          } catch (err) {
            caught = err;
            throw err;
          }
        }),
      );
    const result = await program.cli({ runtime: { argv: () => ['init'] } });
    expect(isPromptCancel(caught)).toBe(true);
    expect(result.error).toBeInstanceOf(PromptCancelledError);
    expect(errors).toEqual(['Cancelled']);
    expect(codes).toEqual([130]);
  });

  it('turns an Enquirer cancellation into PromptCancelledError, and keys answers apart from dotted names', async () => {
    const config: InteractivePromptConfig = { name: 'db.host', message: 'Host', type: 'input' };
    await expect(runEnquirerPrompt(() => Promise.reject(''), config)).rejects.toBeInstanceOf(PromptCancelledError);
    await expect(runEnquirerPrompt(async () => ({ value: 'localhost' }), config)).resolves.toBe('localhost');
    const enquirer = mock(async (_question: Record<string, unknown>) => ({ value: '3' }));
    await runEnquirerPrompt(enquirer, { name: 'n', message: 'N', type: 'select', choices: [{ label: 'Three', value: 3 }], default: 3 });
    expect(enquirer.mock.calls[0]![0]).toMatchObject({ initial: '3', choices: [{ name: '3', message: 'Three' }] });
  });

  describe('without an interactive terminal', () => {
    const build = (runtime: PadroneRuntime) =>
      createPadrone('app')
        .runtime({ ...quiet, ...runtime })
        .command('name', (c) => c.action((_, ctx) => ctx.prompt.text('Project name?')))
        .command('named', (c) => c.action((_, ctx) => ctx.prompt.text({ message: 'Project name?', default: 'fallback' })))
        .command('ok', (c) => c.action((_, ctx) => ctx.prompt.confirm({ message: 'Proceed?', default: true })));

    it('returns the default without asking, or fails fast', async () => {
      const prompt = mock(async () => 'typed');
      const program = build({ interactive: 'disabled', prompt });
      expect((await program.eval('named')).result as unknown).toBe('fallback');
      expect((await program.eval('ok')).result as unknown).toBe(true);
      const { error } = await program.eval('name');
      expect(error).toBeInstanceOf(PromptUnavailableError);
      expect((error as Error).message).toBe('Cannot prompt for "Project name?" without an interactive terminal');
      expect(prompt).not.toHaveBeenCalled();
    });

    it('covers unsupported runtimes, piped stdin and --no-interactive', async () => {
      const prompt = mock(async () => 'typed');
      const piped = { isTTY: false, text: async () => '', lines: async function* () {} };
      expect((await build({ interactive: 'unsupported', prompt }).eval('name')).error).toBeInstanceOf(PromptUnavailableError);
      expect((await build({ interactive: 'supported', prompt, stdin: piped }).eval('name')).error).toBeInstanceOf(PromptUnavailableError);
      const tty = { isTTY: true, text: async () => '', lines: async function* () {} };
      expect((await build({ interactive: 'supported', prompt, stdin: tty }).eval('name --no-interactive')).error).toBeInstanceOf(
        PromptUnavailableError,
      );
      expect((await build({ interactive: 'supported', prompt, stdin: tty }).eval('name')).result as unknown).toBe('typed');
    });

    it('never asks remote callers', async () => {
      const { runtime, asked } = scripted({ 'Project name?': 'typed' });
      const program = build(runtime);
      const { error } = await program.eval('name', { caller: 'mcp' });
      expect((error as Error).message).toBe('Cannot prompt for "Project name?" in a "mcp" call');
      expect((await program.eval('named', { caller: 'serve' })).result as unknown).toBe('fallback');
      expect(asked).toEqual([]);
    });
  });

  it('createPrompt works in interceptors, with the --interactive flag of the phase context', async () => {
    const { runtime, asked } = scripted({ Region: 'eu' });
    const pickRegion = defineInterceptor({ name: 'region' }, () => ({
      async execute(ctx, next) {
        const region = await createPrompt(ctx).select({ message: 'Region', choices: ['us', 'eu'] });
        return next({ context: { region } });
      },
    }));
    const program = createPadrone('app')
      .runtime(runtime)
      .intercept(pickRegion)
      .command('deploy', (c) => c.action((_, ctx) => (ctx.context as { region: string }).region));
    expect((await program.eval('deploy')).result as unknown).toBe('eu');
    expect(asked).toHaveLength(1);
  });

  it('interactive field prompting also treats PROMPT_CANCEL as a cancellation', async () => {
    const { runtime } = scripted({ name: PROMPT_CANCEL });
    const program = createPadrone('app')
      .runtime(runtime)
      .command('init', (c) => c.arguments(z.object({ name: z.string() }), { interactive: true }).action((args) => args));
    expect((await program.eval('init')).error).toBeInstanceOf(PromptCancelledError);
  });
});

// ── Confirm ──────────────────────────────────────────────────────────────

describe('padroneConfirm additions', () => {
  const build = (options: Parameters<typeof padroneConfirm>[0], runtime: PadroneRuntime) => {
    const ran = mock((_args: unknown) => 'done');
    const program = createPadrone('db')
      .runtime({ ...quiet, ...runtime })
      .extend(padroneConfirm(options))
      .command('drop', (c) => c.configure({ mutation: true }).action(() => ran('drop')))
      .command('wipe', (c) =>
        c
          .arguments(z.object({ table: z.string() }), { positional: ['table'] })
          .configure({ confirm: (args) => `Wipe ${args.table}?` })
          .action(() => ran('wipe')),
      )
      .command('reset', (c) => c.configure({ mutation: true, confirm: false }).action(() => ran('reset')))
      .command('touch', (c) => c.configure({ confirm: 'Touch it?' }).action(() => ran('touch')));
    const cli = (...argv: string[]) => program.cli({ runtime: { argv: () => argv } });
    return { ran, cli };
  };

  it("nonInteractive: 'yes' runs and 'no' aborts where it can't ask; 'fail' stays the default", async () => {
    const yes = build({ nonInteractive: 'yes' }, { interactive: 'unsupported' });
    expect((await yes.cli('drop')).result as unknown).toBe('done');
    const no = build({ nonInteractive: 'no' }, { interactive: 'unsupported' });
    expect(((await no.cli('drop')).error as Error).message).toBe('Aborted');
    expect(no.ran).not.toHaveBeenCalled();
    const fail = build({}, { interactive: 'unsupported' });
    expect(((await fail.cli('drop')).error as Error).message).toContain('needs confirmation: pass --yes');
  });

  it('takes the question and whether to ask from .configure({ confirm })', async () => {
    const { runtime, asked } = scripted({ confirm: true });
    const { ran, cli } = build({}, runtime);
    await cli('wipe', 'users');
    await cli('reset');
    await cli('touch');
    expect(asked.map((q) => q.message)).toEqual(['Wipe users?', 'Touch it?']);
    expect(ran.mock.calls.map((call) => call[0])).toEqual(['wipe', 'reset', 'touch']);
  });

  it('aborts when the question is cancelled', async () => {
    const { runtime } = scripted({ confirm: PROMPT_CANCEL });
    const { ran, cli } = build({}, runtime);
    expect(((await cli('drop')).error as Error).message).toBe('Aborted');
    expect(ran).not.toHaveBeenCalled();
  });
});

// ── Credentials ──────────────────────────────────────────────────────────

type Call = { command: string; args: readonly string[]; input?: string };

/** An in-memory `security` / `secret-tool`, recording each call. */
function fakeKeychain(options: { missing?: boolean; noService?: boolean } = {}) {
  const store = new Map<string, string>();
  const calls: Call[] = [];
  const key = (service: string, account: string) => `${service}\u0000${account}`;
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const runner: PadroneCommandRunner = async (command, args, opts) => {
    calls.push({ command, args, input: opts?.input });
    if (options.missing) return { code: 127, stdout: '', stderr: `spawn ${command} ENOENT` };
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    if (command === 'security') {
      if (args[0] === 'list-keychains') return ok('"login.keychain-db"\n');
      if (args[0] === '-i') {
        const match = /^add-generic-password -U -s "([^"]*)" -a "([^"]*)" -X ([0-9a-f]*)\n$/.exec(opts?.input ?? '');
        if (!match) return { code: 1, stdout: '', stderr: 'bad command' };
        store.set(key(match[1]!, match[2]!), Buffer.from(match[3]!, 'hex').toString('utf-8'));
        return ok();
      }
      const k = key(flag('-s'), flag('-a'));
      if (args[0] === 'find-generic-password')
        return store.has(k) ? ok(`${store.get(k)}\n`) : { code: 44, stdout: '', stderr: 'not found' };
      if (args[0] === 'delete-generic-password') return store.delete(k) ? ok() : { code: 44, stdout: '', stderr: 'not found' };
    }
    if (command === 'secret-tool') {
      if (options.noService) return { code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' };
      const attr = (name: string) => args[args.indexOf(name, 1) + 1]!;
      if (args[0] === 'lookup' && args[1] === 'padrone-probe') return { code: 1, stdout: '', stderr: '' };
      const k = key(attr('service'), attr('account'));
      if (args[0] === 'lookup') return store.has(k) ? ok(store.get(k)) : { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'store') store.set(k, opts?.input ?? '');
      if (args[0] === 'clear') store.delete(k);
      if (args[0] === 'store' || args[0] === 'clear') return ok();
    }
    return { code: 2, stdout: '', stderr: 'unexpected' };
  };
  return { runner, store, calls };
}

describe('padroneCredentials', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-credentials-')));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A program whose commands use `ctx.context.credentials`; env points the data dir at the temp dir, never HOME. */
  const build = (options: Parameters<typeof padroneCredentials>[0]) =>
    createPadrone('my-cli')
      .runtime({ ...quiet, env: () => ({ XDG_DATA_HOME: tempDir }) })
      .extend(padroneCredentials(options))
      .command('login', (c) =>
        c
          .arguments(z.object({ token: z.string() }), { positional: ['token'] })
          .action(async (args, ctx) => ctx.context.credentials.set('github', args.token)),
      )
      .command('token', (c) => c.action((_, ctx) => ctx.context.credentials.get('github')))
      .command('logout', (c) => c.action((_, ctx) => ctx.context.credentials.delete('github')))
      .command('names', (c) => c.action((_, ctx) => ctx.context.credentials.list()))
      .command('where', (c) => c.action((_, ctx) => ctx.context.credentials.backend()));

  it('stores secrets in a 0600 file in the data directory', async () => {
    const program = build({ backend: 'file' });
    await program.eval('login abc123');
    expect((await program.eval('token')).result as unknown).toBe('abc123');
    expect((await program.eval('where')).result as unknown).toBe('file');
    const file = path.join(tempDir, 'my-cli', 'credentials.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ 'my-cli': { github: 'abc123' } });
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    await program.eval('logout');
    expect((await program.eval('token')).result as unknown).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({});
  });

  it('lists the stored names of the service', async () => {
    const file = path.join(tempDir, 'shared.json');
    await build({ backend: 'file', file, service: 'one' }).eval('login a');
    await build({ backend: 'file', file, service: 'two' }).eval('login b');
    expect((await build({ backend: 'file', file, service: 'one' }).eval('names')).result as unknown).toEqual(['github']);
    expect((await build({ backend: 'file', file, service: 'none' }).eval('names')).result as unknown).toEqual([]);
  });

  it('lists through secret-tool and reads the macOS keychain dump', async () => {
    const runner: PadroneCommandRunner = async (_command, args) =>
      args[0] === 'search'
        ? {
            code: 0,
            stdout: 'attribute.account = b\nattribute.service = my-cli\n\nattribute.account = a\nattribute.service = my-cli\n',
            stderr: '',
          }
        : { code: 0, stdout: '', stderr: '' };
    expect((await build({ platform: 'linux', runner }).eval('names')).result as unknown).toEqual(['a', 'b']);

    const dump = [
      'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="github"',
      '    "svce"<blob>="my-cli"',
      'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="other"',
      '    "svce"<blob>="another-cli"',
      'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
      'class: "inet"',
      'attributes:',
      '    "acct"<blob>="web"',
      '    "svce"<blob>="my-cli"',
    ].join('\n');
    expect(parseKeychainDump(dump, 'my-cli')).toEqual(['github']);
  });

  it('fails to list on a custom backend without list', async () => {
    const backend: PadroneCredentialBackend = { name: 'custom', get: async () => undefined, set: async () => {}, delete: async () => {} };
    expect((await build({ backend }).eval('names')).error).toBeInstanceOf(Error);
  });

  it('keeps services apart in a shared file', async () => {
    const file = path.join(tempDir, 'shared.json');
    await build({ backend: 'file', file, service: 'one' }).eval('login a');
    await build({ backend: 'file', file, service: 'two' }).eval('login b');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ one: { github: 'a' }, two: { github: 'b' } });
  });

  it('uses the macOS keychain without putting the secret on the command line', async () => {
    const keychain = fakeKeychain();
    const program = build({ platform: 'darwin', runner: keychain.runner });
    await program.eval('login abc123');
    expect((await program.eval('token')).result as unknown).toBe('abc123');
    expect((await program.eval('where')).result as unknown).toBe('keychain');
    const store = keychain.calls.find((call) => call.args[0] === '-i')!;
    expect(store.input).toBe(`add-generic-password -U -s "my-cli" -a "github" -X ${Buffer.from('abc123').toString('hex')}\n`);
    expect(keychain.calls.flatMap((call) => call.args).join(' ')).not.toContain('abc123');
    expect(keychain.calls.filter((call) => call.args[0] === 'list-keychains')).toHaveLength(1);
    await program.eval('logout');
    await program.eval('logout');
    expect((await program.eval('token')).result as unknown).toBeUndefined();
    expect(fs.existsSync(path.join(tempDir, 'my-cli'))).toBe(false);
  });

  it('round-trips secrets that security would print in hex', async () => {
    const keychain = fakeKeychain();
    const program = build({ platform: 'darwin', runner: keychain.runner });
    await program.eval(['login', 'pässwörd\nline2']);
    expect([...keychain.store.values()][0]).toStartWith('padrone-base64:');
    expect((await program.eval('token')).result as unknown).toBe('pässwörd\nline2');
  });

  it('uses secret-tool on Linux with the secret on stdin', async () => {
    const keychain = fakeKeychain();
    const program = build({ platform: 'linux', runner: keychain.runner });
    await program.eval('login abc123');
    expect((await program.eval('token')).result as unknown).toBe('abc123');
    expect((await program.eval('where')).result as unknown).toBe('secret-service');
    const store = keychain.calls.find((call) => call.args[0] === 'store')!;
    expect(store).toEqual({
      command: 'secret-tool',
      args: ['store', '--label', 'my-cli (github)', 'service', 'my-cli', 'account', 'github'],
      input: 'abc123',
    });
    expect(keychain.calls.flatMap((call) => call.args)).not.toContain('abc123');
  });

  it("falls back to the file when there's no keychain tool, Secret Service or Windows support", async () => {
    for (const [platform, keychain] of [
      ['linux', fakeKeychain({ missing: true })],
      ['linux', fakeKeychain({ noService: true })],
      ['darwin', fakeKeychain({ missing: true })],
      ['win32', fakeKeychain()],
    ] as const) {
      const program = build({ platform, runner: keychain.runner, file: path.join(tempDir, `${platform}.json`) });
      await program.eval('login abc123');
      expect((await program.eval('where')).result as unknown).toBe('file');
      expect((await program.eval('token')).result as unknown).toBe('abc123');
      expect(keychain.store.size).toBe(0);
    }
  });

  it("backend: 'keychain' fails where there's none", async () => {
    const linux = build({ platform: 'linux', backend: 'keychain', runner: fakeKeychain({ noService: true }).runner });
    expect(((await linux.eval('token')).error as Error).message).toContain("The OS keychain isn't available");
    const windows = build({ platform: 'win32', backend: 'keychain', runner: fakeKeychain().runner });
    expect(((await windows.eval('token')).error as Error).message).toContain('No OS keychain is supported on win32');
  });

  it('refuses remote callers unless remote: true', async () => {
    const backend: PadroneCredentialBackend = {
      name: 'memory',
      get: async () => 'abc123',
      set: async () => {},
      delete: async () => {},
    };
    for (const caller of ['serve', 'mcp', 'tool'] as const) {
      const { error } = await build({ backend }).eval('token', { caller });
      expect((error as Error).message).toBe(`Credentials aren't available to "${caller}" calls`);
    }
    expect((await build({ backend, remote: true }).eval('token', { caller: 'mcp' })).result as unknown).toBe('abc123');
    expect((await build({ backend }).eval('where')).result as unknown).toBe('memory');
  });

  it('rejects empty names and names with control characters', async () => {
    const program = createPadrone('my-cli')
      .runtime(quiet)
      .extend(padroneCredentials({ backend: 'file', file: path.join(tempDir, 'c.json') }))
      .command('bad', (c) => c.action((_, ctx) => ctx.context.credentials.get('a\nb')));
    expect(((await program.eval('bad')).error as Error).message).toBe('Invalid credential name: "a\\nb"');
  });

  it('the default runner spawns with argv, feeds stdin, and reports missing programs as 127', async () => {
    const script = 'process.stdout.write(process.argv.at(-1)); process.stdin.pipe(process.stdout)';
    const echo = await spawnCommandRunner(process.execPath, ['-e', script, '$HOME;'], { input: ' héllo' });
    expect(echo).toEqual({ code: 0, stdout: '$HOME; héllo', stderr: '' });
    expect((await spawnCommandRunner('padrone-no-such-program', [])).code).toBe(127);
  });
});
