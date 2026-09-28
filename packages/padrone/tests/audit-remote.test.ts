import { describe, expect, test } from 'bun:test';
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol } from '../src/core/commands.ts';
import { createMcpHandler } from '../src/feature/mcp.ts';
import { createServeHandler } from '../src/feature/serve.ts';
import { compileJq } from '../src/util/jq.ts';

const getCommand = (program: any) => program[commandSymbol];

describe('help for remote callers', () => {
  const program: any = createPadrone('app')
    .runtime({ output: () => {}, error: () => {} })
    .command('public', (c) => c.configure({ description: 'Public thing' }).action(() => 'p'))
    .command('secret', (c) => c.configure({ description: 'TOPSECRET' }).action(() => 's'))
    .command('internal', (c) => c.configure({ description: 'HIDDENTHING', hidden: true }).action(() => 'i'))
    .command('local', (c) => c.configure({ description: 'LOCALONLY', expose: false }).action(() => 'l'));

  test('serve help leaves out excluded, hidden and local-only commands', async () => {
    const serve = createServeHandler(getCommand(program), program.eval.bind(program), { exclude: ['secret'] });
    const text = await (await serve(new Request('http://localhost/_help'))).text();
    expect(text).toContain('Public thing');
    for (const leaked of ['TOPSECRET', 'HIDDENTHING', 'LOCALONLY']) expect(text).not.toContain(leaked);
    const json = await (await serve(new Request('http://localhost/_help', { headers: { accept: 'application/json' } }))).text();
    for (const leaked of ['TOPSECRET', 'HIDDENTHING', 'LOCALONLY']) expect(json).not.toContain(leaked);
    const one = await (await serve(new Request('http://localhost/_help/public'))).text();
    expect(one).toContain('Public thing');
  });

  test('the MCP help tool leaves them out too', async () => {
    const mcp = createMcpHandler(getCommand(program), program.eval.bind(program), { exclude: ['secret'] });
    const call = async (args: object) =>
      JSON.stringify(await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'help', arguments: args } }));
    const text = await call({});
    expect(text).toContain('Public thing');
    for (const leaked of ['TOPSECRET', 'HIDDENTHING', 'LOCALONLY']) expect(text).not.toContain(leaked);
    expect(await call({ command: 'secret' })).toContain('Unknown command');
    expect(await call({ command: 'public' })).toContain('Public thing');
  });
});

describe('MCP request ids without a session', () => {
  test("another identity can't cancel a call by its id", async () => {
    let close: (() => void) | undefined;
    const logs: string[] = [];
    let aborted = false;
    const program: any = createPadrone('app')
      .runtime({
        output: () => {},
        error: (text: string) => logs.push(text),
        onSignal: (cb: (signal: 'SIGTERM') => void) => {
          close ??= () => cb('SIGTERM');
          return () => {};
        },
      })
      .command('wait', (c: any) =>
        c.arguments(z.object({})).action(
          (_args: unknown, ctx: { signal: AbortSignal }) =>
            new Promise<string>((resolve) => {
              const timer = setTimeout(() => resolve('finished'), 200);
              ctx.signal.addEventListener('abort', () => {
                aborted = true;
                clearTimeout(timer);
                resolve('aborted');
              });
            }),
        ),
      );
    const running = program.mcp({ port: 0, bearer: ['alice', 'bob'] });
    let port: string | undefined;
    for (let i = 0; i < 100 && !port; i++) {
      port = logs.join('\n').match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      if (!port) await new Promise((r) => setTimeout(r, 10));
    }
    try {
      const post = (token: string, body: object) =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        });
      const call = post('alice', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: {} } });
      await new Promise((r) => setTimeout(r, 50));
      await post('bob', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
      const res = (await (await call).json()) as any;
      expect(aborted).toBe(false);
      expect(res.result.content[0].text).toBe('finished');
    } finally {
      close?.();
      await running;
    }
  });
});

describe('jq budget', () => {
  const run = (expression: string, maxSteps = 1000) => compileJq(expression, { maxSteps })(null);

  test('a non-finite step count still hits the budget', () => {
    expect(() => run('[(("" * 1e999)?), range(100000)] | length')).toThrow('budget');
    expect(() => run('(0 * 1e999) as $n | [("a" * $n), range(100000)] | length')).toThrow('budget');
  });

  test('merging objects and removing array items count their work', () => {
    expect(() => run('[range(400)] | map({(tostring): .}) | add | length', 500)).toThrow('budget');
    expect(() => run('[range(100)] as $a | [range(100)] as $b | ($a - $b) | length', 1000)).toThrow('budget');
    expect(run('[1,2,3] - [2] | length')).toEqual([2]);
    expect(run('{a:1} + {b:2} | keys')).toEqual([['a', 'b']]);
    expect(run('"ab" * 2')).toEqual(['abab']);
  });
});
