import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPadrone, padroneConfig, padroneLogger } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol, serializeArgsToFlags } from '../src/core/commands.ts';
import { createMcpHandler } from '../src/feature/mcp.ts';
import { createServeHandler } from '../src/feature/serve.ts';

const getCommand = (program: any) => program[commandSymbol];

const mcpCall = async (handler: ReturnType<typeof createMcpHandler>, name: string, args: unknown) =>
  (await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as any;

describe('serializeArgsToFlags round trips', () => {
  const program = createPadrone('app')
    .command('bools', (c) =>
      c
        .arguments(z.object({ plain: z.boolean().default(true), noPrefix: z.boolean().default(true) }), {
          fields: { noPrefix: { negative: '' } },
        })
        .action((args) => args),
    )
    .command('arrs', (c) => c.arguments(z.object({ list: z.array(z.string()).default(['default']) })).action((args) => args));
  const handler = createMcpHandler(getCommand(program), program.eval.bind(program) as any);

  test('false reaches a boolean whose --no- prefix is disabled', async () => {
    const res = await mcpCall(handler, 'bools', { plain: false, noPrefix: false });
    expect(res.result.isError).toBe(false);
    expect(JSON.parse(res.result.content[0].text)).toEqual({ plain: false, noPrefix: false });
  });

  test('an empty array stays empty instead of taking the default', async () => {
    const res = await mcpCall(handler, 'arrs', { list: [] });
    expect(JSON.parse(res.result.content[0].text)).toEqual({ list: [] });
  });

  test('array items in brackets or with commas stay whole', async () => {
    const res = await mcpCall(handler, 'arrs', { list: ['[x]', 'a,b', '[]'] });
    expect(JSON.parse(res.result.content[0].text)).toEqual({ list: ['[x]', 'a,b', '[]'] });
  });

  test('stringify output parses back to the same array', async () => {
    const line = program.stringify('arrs', { list: ['[x]'] });
    expect((await program.eval(line)).result).toEqual({ list: ['[x]'] });
    expect(serializeArgsToFlags({ list: [] })).toEqual(['--list=[]']);
  });
});

describe('serve query strings', () => {
  const program = createPadrone('app').command('greet', (c) =>
    c.arguments(z.object({ name: z.string().optional(), loud: z.boolean().optional() })).action((args) => args),
  );
  const serve = createServeHandler(getCommand(program), program.eval.bind(program) as any);

  test('a param without a value is an empty string, or turns a boolean on', async () => {
    const res = await serve(new Request('http://localhost/greet?name=&loud'));
    expect(await res.json()).toEqual({ ok: true, result: { name: '', loud: true } });
    const flag = await serve(new Request('http://localhost/greet?loud=&name'));
    expect(await flag.json()).toEqual({ ok: true, result: { name: '', loud: true } });
    const help = await serve(new Request('http://localhost/greet?help'));
    expect(JSON.stringify(await help.json())).toContain('"ok":true');
  });
});

describe('remote callers and --config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'padrone-sweep4-'));
  const secret = join(dir, 'secret.json');
  writeFileSync(secret, JSON.stringify({ name: 'SECRET' }));
  const program = createPadrone('app')
    .extend(padroneConfig())
    .command('greet', (c) => c.arguments(z.object({ name: z.string().optional() })).action((args) => `hi ${args.name ?? 'you'}`));

  test("serve, MCP and tool() callers can't pick a config file", async () => {
    const serve = createServeHandler(getCommand(program), program.eval.bind(program) as any);
    for (const query of ['config', 'c']) {
      const res = await serve(new Request(`http://localhost/greet?${query}=${encodeURIComponent(secret)}`));
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('SECRET');
    }
    const mcp = await mcpCall(createMcpHandler(getCommand(program), program.eval.bind(program) as any), 'greet', { config: secret });
    expect(mcp.result.isError).toBe(true);
    expect(JSON.stringify(mcp)).not.toContain('SECRET');
    const tool = (await program.tool().execute!({ command: `greet -c ${secret}` }, {} as never)) as { result: unknown; error: string };
    expect(tool.result).toBeUndefined();
    expect(tool.error).toContain('Unknown option');
  });

  test('local callers still read it', async () => {
    expect((await program.eval(['greet', '--config', secret])).result).toBe('hi SECRET');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('MCP tools', () => {
  const program = createPadrone('app').command('greet', (c) =>
    c.arguments(z.object({ name: z.string().optional() })).action((args) => `hi ${args.name ?? 'you'}`),
  );
  const handler = createMcpHandler(getCommand(program), program.eval.bind(program) as any);

  test('arguments that are not an object are invalid params', async () => {
    for (const args of ['abc', ['x'], 42]) {
      const res = await mcpCall(handler, 'greet', args);
      expect(res.error?.code).toBe(-32602);
    }
  });
});

describe('tool()', () => {
  const program = createPadrone('app').command('del', (c) =>
    c
      .arguments(z.object({ force: z.boolean().optional(), n: z.number() }))
      .configure({ needsApproval: (args) => !!args.force })
      .action(() => 'deleted'),
  );
  const tool = program.tool();
  const needsApproval = (command: string) => (tool.needsApproval as (input: { command: string }) => Promise<boolean>)({ command });

  test('stderr from a successful command is in the logs, not the error', async () => {
    const program = createPadrone('app')
      .extend(padroneLogger())
      .command('go', (c) =>
        c.action((_, ctx) => {
          ctx.runtime.output('out');
          ctx.context.logger.warn('careful');
          return 'ok';
        }),
      )
      .command('fail', (c) =>
        c.action((_, ctx) => {
          ctx.runtime.output('out');
          ctx.runtime.error('about to fail');
          throw new Error('broke');
        }),
      );
    const run = (command: string) => program.tool().execute!({ command }, {} as never) as Promise<Record<string, unknown>>;
    expect(await run('go')).toEqual({ result: 'ok', logs: 'out\n[WARN] careful', error: '' });
    expect(await run('fail')).toEqual({ result: undefined, logs: 'out', error: 'about to fail\nbroke' });
  });

  test("an approval function isn't called without valid args, and approval is asked", async () => {
    expect(await needsApproval('del --n=abc')).toBe(true);
    expect(await needsApproval('del --n=1')).toBe(false);
    expect(await needsApproval('del --n=1 --force')).toBe(true);
  });
});
