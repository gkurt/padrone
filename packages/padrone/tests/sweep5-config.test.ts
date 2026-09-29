/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests contain dotenv variable expansion syntax */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPadrone, padroneAliases, padroneConfig, padroneEnv } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol } from '../src/core/commands.ts';
import { createMcpHandler } from '../src/feature/mcp.ts';
import { createServeHandler } from '../src/feature/serve.ts';
import { expandVariables, loadEnvFiles, parseEnvFile } from '../src/util/dotenv.ts';

let tempDir: string;
const originalCwd = process.cwd();
const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-sweep5-')));
  fs.mkdirSync(path.join(tempDir, 'work'));
  process.chdir(path.join(tempDir, 'work'));
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const issueMessages = (result: { argsResult?: { issues?: readonly { message: string }[] } }) =>
  result.argsResult?.issues?.map((issue) => issue.message);

describe('dotenv', () => {
  it('reads an opening quote that is never closed as part of an unquoted value, keeping the lines after it', () => {
    expect(parseEnvFile('A="oops\nB=2\nC=3')).toEqual({ A: '"oops', B: '2', C: '3' });
    expect(parseEnvFile("A='it\nB=2")).toEqual({ A: "'it", B: '2' });
  });

  it('keeps the whitespace at the end of the first line of a multiline value', () => {
    expect(parseEnvFile('A="abc   \ndef"')).toEqual({ A: 'abc   \ndef' });
  });

  it('strips an inline comment after a tab', () => {
    expect(parseEnvFile('A=value\t# comment\nB=x#y')).toEqual({ A: 'value', B: 'x#y' });
  });

  it("doesn't expand names of Object.prototype members", () => {
    expect(expandVariables('[$toString][${constructor}][${valueOf:-d}]', {})).toBe('[][][d]');
    fs.writeFileSync('.env', 'A=$hasOwnProperty\nB=${toString-fallback}');
    expect(loadEnvFiles({ dir: '.' }, { HOME: '/home' })).toEqual({ A: '', B: 'fallback' });
  });
});

describe('stdin', () => {
  it("doesn't read a runtime stdin that is a terminal unless the value is -", async () => {
    let reads = 0;
    const stdin = {
      isTTY: true,
      text: async () => {
        reads++;
        return 'typed';
      },
      async *lines() {
        reads++;
        yield 'typed';
      },
    };
    const program = createPadrone('app')
      .runtime({ ...quiet, stdin })
      .command('read', (c) =>
        c.arguments(z.object({ data: z.string().optional() }), { stdin: 'data' }).action((args) => args.data ?? 'none'),
      )
      .command('lines', (c) =>
        c.arguments(z.object({ data: z.array(z.string()).optional() }), { stdin: 'data' }).action((args) => args.data ?? 'none'),
      );
    expect((await program.eval('read')).result).toBe('none');
    expect((await program.eval('lines')).result).toBe('none');
    expect(reads).toBe(0);
    expect((await program.eval('read --data -')).result).toBe('typed');
  });

  it('lets a fromFile option read a terminal stdin when the stdin field would not read it', async () => {
    const create = (isTTY: boolean) =>
      createPadrone('app')
        .runtime({ ...quiet, stdin: { isTTY, text: async () => 'typed', async *lines() {} } })
        .command('post', (c) =>
          c
            .arguments(z.object({ data: z.string().optional(), body: z.string().optional() }), {
              stdin: 'data',
              fields: { body: { fromFile: true } },
            })
            .action((args) => args),
        );
    expect((await create(true).eval('post --body -')).result).toEqual({ body: 'typed' });
    expect(issueMessages(await create(false).eval('post --body -'))).toEqual([
      'Cannot read stdin ("-"): the command reads stdin into "data"',
    ]);
  });
});

describe('sources of nested values in validation errors', () => {
  const schema = z.object({ db: z.object({ host: z.string().optional(), port: z.number().optional() }).optional() });

  it('name the prefixed environment variable', async () => {
    const program = createPadrone('app')
      .runtime({ ...quiet, env: () => ({ APP_DB__PORT: 'x', APP_DB__HOST: 'h' }) })
      .extend(padroneEnv({ prefix: 'APP' }))
      .command('serve', (c) => c.arguments(schema).action((args) => args));
    expect(issueMessages(await program.eval('serve'))).toEqual(['Expected number, got "x" (from APP_DB__PORT)']);
  });

  it('name the merged config file that sets the value', async () => {
    fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify({ db: { port: 'x' } }));
    fs.writeFileSync('app.json', JSON.stringify({ db: { host: 'h' } }));
    const program = createPadrone('app')
      .runtime({ ...quiet, env: () => ({}) })
      .extend(padroneConfig({ files: ['app.json'], searchParents: true, merge: true }))
      .command('serve', (c) => c.arguments(schema).action((args) => args));
    expect(issueMessages(await program.eval('serve'))).toEqual([`Expected number, got "x" (from ${path.join(tempDir, 'app.json')})`]);
  });
});

describe('config and alias commands for remote callers', () => {
  const create = () =>
    createPadrone('app')
      .runtime({ ...quiet, env: () => ({ HOME: tempDir, XDG_CONFIG_HOME: tempDir }) })
      .extend(padroneConfig({ command: true }))
      .extend(padroneAliases({ file: path.join(tempDir, 'aliases.json') }))
      .command('serve', (c) => c.arguments(z.object({ port: z.number().optional() })).action((args) => args));

  it('are not served over HTTP or MCP', async () => {
    const program = create();
    const target = path.join(tempDir, 'elsewhere', 'written.json');
    const serve = createServeHandler((program as any)[commandSymbol], program.eval.bind(program) as any);
    const res = await serve(
      new Request('http://localhost/config/set', {
        method: 'POST',
        body: JSON.stringify({ key: 'port', value: '1', file: target }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(404);
    expect(fs.existsSync(target)).toBe(false);
    const spec = (await (await serve(new Request('http://localhost/_openapi'))).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(['/serve']);

    const mcp = createMcpHandler((program as any)[commandSymbol], program.eval.bind(program) as any);
    const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((list!.result as any).tools.map((tool: any) => tool.name)).not.toContain('config.set');
  });

  it('refuse to run for serve, MCP and tool calls', async () => {
    const program = create();
    const target = path.join(tempDir, 'elsewhere', 'written.json');
    fs.writeFileSync(path.join(tempDir, 'secret.json'), JSON.stringify({ token: 'abc' }));
    for (const caller of ['serve', 'mcp', 'tool'] as const) {
      for (const input of [
        ['config', 'set', 'port', '1', '--file', target],
        ['config', 'list', '--file', path.join(tempDir, 'secret.json')],
        ['alias', 'set', 'x', 'serve'],
      ]) {
        const result = await program.eval(input, { caller });
        expect((result.error as Error | undefined)?.message).toContain('is only available on the command line');
      }
    }
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'aliases.json'))).toBe(false);
    expect((await program.eval(['config', 'set', 'port', '1', '--file', target])).error).toBeUndefined();
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('config extends', () => {
  const program = (files: string[]) =>
    createPadrone('app')
      .extend(padroneConfig({ files }))
      .arguments(z.object({ port: z.number().optional() }))
      .action((args) => args);

  it('does not run a script that a JSON or YAML config extends', async () => {
    const marker = path.join(tempDir, 'ran');
    fs.writeFileSync('evil.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, ''); export default { port: 1 };`);
    fs.writeFileSync('config.json', JSON.stringify({ extends: './evil.mjs' }));
    const { error } = await program(['config.json']).eval('');
    expect(fs.existsSync(marker)).toBe(false);
    expect((error as Error).message).toContain('only a script config can extend a script');
  });

  it('lets a script config extend a script, and a JSON config extend JSON', async () => {
    fs.writeFileSync('base.mjs', 'export default { port: 2 };');
    fs.writeFileSync('app.config.mjs', `export default { extends: './base.mjs' };`);
    expect((await program(['app.config.mjs']).eval('')).result).toEqual({ port: 2 });
    fs.writeFileSync('base.json', JSON.stringify({ port: 3 }));
    fs.writeFileSync('config.json', JSON.stringify({ extends: './base.json' }));
    expect((await program(['config.json']).eval('')).result).toEqual({ port: 3 });
  });
});
