import { describe, expect, test } from 'bun:test';
import { Text } from 'ink';
import { createPadrone } from 'padrone';
import { padroneInk } from 'padrone/ink';
import React from 'react';
import * as z from 'zod/v4';
import { commandSymbol, serializeArgsToFlags } from '../src/core/commands.ts';
import { createMcpHandler, startMcpServer } from '../src/feature/mcp.ts';
import { createServeHandler } from '../src/feature/serve.ts';

const getCommand = (program: any) => program[commandSymbol];

describe('MCP messages', () => {
  const program = createPadrone('app')
    .command('greet', (c) => c.arguments(z.object({ name: z.string().optional() })).action((args) => `Hello, ${args.name ?? 'nobody'}`))
    .command('print', (c) => c.action((_, ctx) => void ctx.runtime.output({ a: 1 })))
    .command('slow', (c) =>
      c.async().action(
        (_, ctx) =>
          new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve('finished'), 200);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve('aborted');
            });
          }),
      ),
    );
  const handler = createMcpHandler(getCommand(program), program.eval.bind(program) as any);

  test('malformed messages are invalid requests', async () => {
    for (const message of [null, 'x', 42, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], { jsonrpc: '2.0', id: 1 }]) {
      const res = await handler(message);
      expect(res?.error?.code).toBe(-32600);
    }
  });

  test('responses from the client get no response', async () => {
    expect(await handler({ jsonrpc: '2.0', id: 1, result: {} })).toBeUndefined();
  });

  test('initialize echoes a supported protocol version', async () => {
    const older = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect((older?.result as any).protocolVersion).toBe('2025-06-18');
    const unknown = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((unknown?.result as any).protocolVersion).toBe('2025-11-25');
  });

  test('cancellation is scoped to the session', async () => {
    const call = (session: string) =>
      handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } }, undefined, session);
    const a = call('a');
    const b = call('b');
    await handler({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, undefined, 'a');
    const [resA, resB] = await Promise.all([a, b]);
    expect((resA?.result as any).content[0].text).toBe('aborted');
    expect((resB?.result as any).content[0].text).toBe('finished');
  });

  test('objects printed with runtime.output are JSON', async () => {
    const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'print', arguments: {} } });
    expect((res?.result as any).content[0].text).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  test('null arguments are unset', async () => {
    const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'greet', arguments: { name: null } } });
    expect((res?.result as any).content[0].text).toBe('Hello, nobody');
    expect(serializeArgsToFlags({ a: null, b: undefined, c: 'x' })).toEqual(['--c=x']);
  });

  test('help for an unknown command is an error', async () => {
    const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'help', arguments: { command: 'nope' } } });
    expect((res?.result as any).isError).toBe(true);
  });

  test("a command named help keeps the tool name; the built-in help tool doesn't collide", async () => {
    const withHelp = createPadrone('app', { builtins: { help: false } }).command('help', (c) => c.action(() => 'user help ran'));
    const h = createMcpHandler(getCommand(withHelp), withHelp.eval.bind(withHelp) as any);
    const list = await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (list?.result as any).tools.map((t: any) => t.name);
    expect(names).toEqual(['help', 'padrone_help']);
    const res = await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'help', arguments: {} } });
    expect((res?.result as any).content[0].text).toBe('user help ran');
  });
});

describe('MCP HTTP transport', () => {
  test('rejects bad bodies and unsupported protocol versions', async () => {
    let close: (() => void) | undefined;
    const program = createPadrone('app')
      .runtime({
        error: () => {},
        onSignal: (cb) => {
          close = () => cb('SIGTERM');
          return () => {};
        },
      })
      .command('greet', (c) => c.action(() => 'hi'));
    const port = 40000 + Math.floor(Math.random() * 20000);
    const server = startMcpServer(program as any, getCommand(program), program.eval.bind(program) as any, { port });
    await new Promise((r) => setTimeout(r, 50));
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
    try {
      const nullBody = await post('null');
      expect(nullBody.status).toBe(400);
      expect(((await nullBody.json()) as any).error.code).toBe(-32600);

      const batch = await post(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
      expect(batch.status).toBe(400);

      const clientResponse = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      expect(clientResponse.status).toBe(202);

      const badVersion = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { 'mcp-protocol-version': '1999-01-01' });
      expect(badVersion.status).toBe(400);

      const deleteWithoutSession = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE' });
      expect(deleteWithoutSession.status).toBe(400);
    } finally {
      close?.();
      await server;
    }
  });
});

describe('serve', () => {
  const program = createPadrone('app')
    .command('printer', (c) =>
      c.action((_, ctx) => {
        ctx.runtime.output('printed line');
        return 'done';
      }),
    )
    .command('nested', (c) =>
      c.arguments(z.object({ db: z.object({ host: z.string(), port: z.coerce.number().optional() }) })).action((args) => args.db),
    )
    .command('greet', (c) => c.arguments(z.object({ name: z.string().optional() })).action((args) => args.name ?? 'nobody'));
  const handler = createServeHandler(getCommand(program), program.eval.bind(program) as any);

  test('returns printed output with the result', async () => {
    const res = await handler(new Request('http://localhost/printer'));
    expect(await res.json()).toEqual({ ok: true, result: 'done', output: ['printed line'] });
  });

  test('null in a JSON body is unset', async () => {
    const res = await handler(new Request('http://localhost/greet', { method: 'POST', body: '{"name":null}' }));
    expect(await res.json()).toEqual({ ok: true, result: 'nobody' });
  });

  test('a trailing slash reaches the command', async () => {
    const res = await handler(new Request('http://localhost/greet/?name=x'));
    expect(await res.json()).toEqual({ ok: true, result: 'x' });
  });

  test('OpenAPI documents nested objects as the dotted query params the server takes', async () => {
    const spec = (await (await handler(new Request('http://localhost/_openapi'))).json()) as any;
    const params = spec.paths['/nested'].get.parameters;
    expect(params.map((p: any) => [p.name, p.required])).toEqual([
      ['db.host', true],
      ['db.port', false],
    ]);
    const res = await handler(new Request('http://localhost/nested?db.host=h&db.port=1'));
    expect(await res.json()).toEqual({ ok: true, result: { host: 'h', port: 1 } });
  });
});

describe('tool()', () => {
  const program = createPadrone('app')
    .command('boom', (c) =>
      c.action(() => {
        throw new Error('it broke');
      }),
    )
    .command('num', (c) => c.arguments(z.object({ n: z.coerce.number() })).action((args) => args.n))
    .command('wait', (c) =>
      c.async().action(
        (_, ctx) =>
          new Promise<string>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve('aborted'));
          }),
      ),
    );
  const tool = program.tool();

  test('errors, validation failures and unknown commands are reported', async () => {
    const run = (command: string) => tool.execute!({ command }, {} as never) as Promise<{ error: string }>;
    expect((await run('boom')).error).toContain('it broke');
    expect((await run('num --n=abc')).error).toContain('Validation error');
    expect((await run('nope')).error).not.toBe('');
  });

  test("the AI SDK's abort signal cancels the command", async () => {
    const controller = new AbortController();
    const pending = tool.execute!({ command: 'wait' }, { abortSignal: controller.signal } as never) as Promise<{ result: unknown }>;
    controller.abort();
    expect((await pending).result).toBe('aborted');
  });

  test('the input schema requires the command', () => {
    expect((tool.inputSchema as any).jsonSchema.required).toEqual(['command']);
  });
});

describe('ink remote rendering', () => {
  function Forever() {
    return React.createElement(Text, null, 'still going');
  }

  test('an aborted call does not wait for the timeout', async () => {
    const controller = new AbortController();
    const program = createPadrone('app')
      .runtime({ output: () => {}, error: () => {} })
      .extend(padroneInk({ remote: 'exit', remoteTimeout: 5000 }))
      .command('forever', (c) =>
        c.async().action(async () => {
          await new Promise((r) => setTimeout(r, 30));
          return React.createElement(Forever);
        }),
      );
    setTimeout(() => controller.abort(), 5);
    const started = Date.now();
    const res = await program.eval('forever', { caller: 'serve', signal: controller.signal } as any);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.error).toBeDefined();
  });

  test('a render error is the call error', async () => {
    function Broken(): React.ReactElement {
      throw new Error('render boom');
    }
    const program = createPadrone('app')
      .runtime({ output: () => {}, error: () => {} })
      .extend(padroneInk({ remote: 'exit', remoteTimeout: 1000 }))
      .command('broken', (c) => c.action(() => React.createElement(Broken)));
    const res = (await program.tool().execute!({ command: 'broken' }, {} as never)) as { result: unknown; error: string };
    expect(res.result).toBeUndefined();
    expect(res.error).toContain('render boom');
  });
});
