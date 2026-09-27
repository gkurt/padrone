/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests contain dotenv variable expansion syntax */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPadrone, padroneConfig } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol } from '../src/core/commands.ts';
import { createServeHandler } from '../src/feature/serve.ts';
import { expandVariables, parseEnvFile } from '../src/util/dotenv.ts';

let tempDir: string;
let userDir: string;
let env: Record<string, string | undefined>;
const originalCwd = process.cwd();

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-sweep4-')));
  userDir = path.join(tempDir, 'xdg', 'app');
  env = { HOME: tempDir, XDG_CONFIG_HOME: path.join(tempDir, 'xdg') };
  fs.mkdirSync(path.join(tempDir, 'work'));
  process.chdir(path.join(tempDir, 'work'));
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const writeUser = (data: unknown, name = 'config.json') => {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, name), typeof data === 'string' ? data : JSON.stringify(data));
};

function create(options: Parameters<typeof padroneConfig>[0] = {}) {
  const program = createPadrone('app')
    .runtime({ env: () => env, output: () => {}, error: () => {} })
    .extend(padroneConfig({ command: true, ...options }))
    .command('serve', (c) =>
      c
        .arguments(
          z.object({
            port: z.number().int().optional(),
            dryRun: z.boolean().optional(),
            apiKey: z.string().optional(),
            db: z.object({ host: z.string().optional(), port: z.number().optional() }).optional(),
          }),
          { fields: { apiKey: { sensitive: true } } },
        )
        .action((args) => args),
    );
  const run = async (input: string) => {
    const { result, error } = await program.eval(input);
    if (error) throw error;
    return result as any;
  };
  const fail = async (input: string) => ((await program.eval(input)).error as Error | undefined)?.message;
  return { program, run, fail };
}

describe('--config from remote callers', () => {
  const program = () =>
    createPadrone('app')
      .runtime({ output: () => {} })
      .extend(padroneConfig({ files: ['app.json'] }))
      .command('greet', (c) => c.arguments(z.object({ name: z.string().optional() })).action((args) => args.name ?? 'nobody'));

  it('is not read for serve, mcp and tool calls', async () => {
    const script = path.join(tempDir, 'script.mjs');
    fs.writeFileSync(script, 'globalThis.__padroneSweep4 = true; export default { name: "from-script" };');
    fs.writeFileSync('other.json', JSON.stringify({ name: 'from-file' }));

    for (const caller of ['serve', 'mcp', 'tool'] as const) {
      for (const flag of [`--config=${script}`, '--config=other.json', '-c=other.json']) {
        const result = await program().eval(['greet', flag], { caller });
        expect(result.result).toBeUndefined();
        expect(result.argsResult?.issues?.[0]?.message).toMatch(/^Unknown option: "c(onfig)?"$/);
      }
    }
    const handler = createServeHandler((program() as any)[commandSymbol], program().eval.bind(program()) as any);
    const res = await handler(new Request(`http://localhost/greet?config=${encodeURIComponent(script)}`));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect((globalThis as { __padroneSweep4?: boolean }).__padroneSweep4).toBeUndefined();
  });

  it('is still read for local callers, and auto-detected files still load for remote ones', async () => {
    fs.writeFileSync('other.json', JSON.stringify({ name: 'from-file' }));
    fs.writeFileSync('app.json', JSON.stringify({ name: 'auto' }));
    expect((await program().eval(['greet', '--config=other.json'])).result).toBe('from-file');
    expect((await program().eval(['greet'], { caller: 'serve' })).result).toBe('auto');
  });
});

describe('config get and unset', () => {
  it('take the alias or kebab-case name that set stores under the option name', async () => {
    const { run } = create();
    await run('config set dry-run true');
    expect(await run('config get dry-run')).toBe(true);
    expect(await run('config get dryRun')).toBe(true);
    await run('config unset dry-run');
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'config.json'), 'utf-8'))).toEqual({});
  });

  it('still read a key written as-is in the file first', async () => {
    writeUser({ 'dry-run': false, dryRun: true });
    const { run } = create();
    expect(await run('config get dry-run')).toBe(false);
  });
});

describe('config list', () => {
  it('redacts sensitive options', async () => {
    writeUser({ apiKey: 'secret', 'api-key': 'secret2', port: 1 });
    const { run } = create();
    const listed = await run('config list');
    expect(listed).not.toContain('secret');
    expect(listed).toContain('apiKey=[redacted]');
    expect(listed).toContain('api-key=[redacted]');
    expect(listed).toContain('port=1');
    expect(await run('config get apiKey')).toBe('secret');
  });
});

describe('config path and edit with a non-JSON file name', () => {
  it('show and create the YAML user file', async () => {
    const edits: string[] = [];
    const program = createPadrone('app')
      .runtime({
        env: () => env,
        output: () => {},
        editor: async (text: string, options?: { extension?: string }) => {
          edits.push(`${options?.extension}:${text}`);
          return 'port: 5\n';
        },
      })
      .extend(padroneConfig({ command: true, files: ['config.yaml'] }))
      .command('serve', (c) => c.arguments(z.object({ port: z.number().optional() })).action((args) => args));
    const file = path.join(userDir, 'config.yaml');
    const result = async (input: string): Promise<unknown> => (await program.eval(input)).result;
    expect(await result('config path')).toBe(`User config: ${file}\nNo config files found`);
    expect(await result('config edit')).toBe(`Saved ${file}`);
    expect(edits).toEqual(['.yaml:']);
    expect((await program.eval('serve')).result).toEqual({ port: 5 });
  });
});

describe('config file text', () => {
  const program = (files: string[]) =>
    createPadrone('app')
      .extend(padroneConfig({ files }))
      .arguments(z.object({ port: z.number().optional() }))
      .action((args) => args);

  for (const [name, text] of [
    ['app.yaml', ''],
    ['app.yaml', '# nothing yet\n'],
    ['.apprc', '// nothing yet\n'],
    ['app.json', '  \n'],
  ] as const) {
    it(`treats ${name} with ${JSON.stringify(text)} as an empty config`, async () => {
      fs.writeFileSync(name, text);
      const result = await program([name]).eval('');
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({});
    });
  }

  for (const [name, text] of [
    ['app.json', '{ "port": 1 }'],
    ['app.yaml', 'port: 1\n'],
    ['app.toml', 'port = 1\n'],
  ] as const) {
    it(`reads ${name} saved with a byte order mark`, async () => {
      fs.writeFileSync(name, `\uFEFF${text}`);
      expect((await program([name]).eval('')).result).toEqual({ port: 1 });
    });
  }

  it('still rejects a YAML document that is not an object', async () => {
    fs.writeFileSync('app.yaml', '- 1\n');
    expect(((await program(['app.yaml']).eval('')).error as Error).message).toContain('must be an object');
  });
});

describe('null in nested config values', () => {
  it('unsets the nested option instead of failing validation', async () => {
    fs.writeFileSync('base.json', JSON.stringify({ db: { host: 'h', port: 5432 } }));
    fs.writeFileSync('config.json', JSON.stringify({ extends: './base.json', db: { port: null } }));
    const { run } = create({ xdg: false });
    expect(await run('serve')).toEqual({ db: { host: 'h' } });
  });
});

describe('dotenv', () => {
  it('normalizes CRLF line endings inside multiline values', () => {
    expect(parseEnvFile('A="l1\r\nl2\r\nl3"\r\nB=x\r\n')).toEqual({ A: 'l1\nl2\nl3', B: 'x' });
  });

  it('expands variables inside defaults', () => {
    expect(expandVariables('${API:-http://${HOST}:3000}/v1', { HOST: 'h' })).toBe('http://h:3000/v1');
    expect(expandVariables('${A:-${B:-z}}', {})).toBe('z');
    expect(expandVariables('${A-${B}}!', { B: 'b' })).toBe('b!');
    expect(expandVariables('${A-${B:-x}}', {})).toBe('x');
    expect(expandVariables('${A:-a-b}', {})).toBe('a-b');
    expect(expandVariables('${A:-${B}}', { A: 'a' })).toBe('a');
  });
});
