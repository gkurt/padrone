import { describe, expect, test } from 'bun:test';
import { createPadrone, padroneLogger } from 'padrone';
import type { OtelSpan, OtelTracerProvider } from 'padrone/tracing';
import { padroneTracing } from 'padrone/tracing';
import * as z from 'zod/v4';
import { commandSymbol, isAllowedOrigin } from '../src/core/commands.ts';
import { createMcpHandler, startMcpServer } from '../src/feature/mcp.ts';
import { createServeHandler } from '../src/feature/serve.ts';

const getCommand = (program: any) => program[commandSymbol];
const randomPort = () => 40000 + Math.floor(Math.random() * 20000);

describe('needsApproval', () => {
  const program = createPadrone('app')
    .command('del', (c) =>
      c
        .arguments(z.object({ force: z.boolean().optional(), n: z.number() }))
        .configure({ needsApproval: (args) => !!args.force && args.n > 0 })
        .action(() => 'deleted'),
    )
    .command('read', (c) => c.configure({ mutation: true, needsApproval: false }).action(() => 'ok'));
  const needsApproval = (command: string) =>
    (program.tool().needsApproval as (input: { command: string }) => Promise<boolean>)({ command });

  test('a function gets the validated args; a boolean overrides mutation', async () => {
    expect(await needsApproval('del --n=1')).toBe(false);
    expect(await needsApproval('del --n=1 --force')).toBe(true);
    expect(await needsApproval('read')).toBe(false);
  });

  test('the function is typed with the args', () => {
    createPadrone('app').command('x', (c) =>
      c.arguments(z.object({ n: z.number() })).configure({
        // @ts-expect-error: `missing` isn't an arg
        needsApproval: (args) => args.missing,
      }),
    );
  });
});

describe('MCP structured content', () => {
  const program = createPadrone('app')
    .command('info', (c) =>
      c.configure({ outputSchema: z.object({ name: z.string(), size: z.number() }) }).action(() => ({ name: 'a', size: 1 })),
    )
    .command('obj', (c) => c.action(() => ({ ok: true })))
    .command('list', (c) => c.configure({ outputSchema: z.array(z.string()) }).action(() => ['a', 'b']))
    .command('text', (c) => c.action(() => 'hello'))
    .command('fail', (c) =>
      c.configure({ outputSchema: z.object({ x: z.string() }) }).action(() => {
        throw new Error('nope');
      }),
    );
  const handler = createMcpHandler(getCommand(program), program.eval.bind(program) as any);
  const call = async (name: string) =>
    ((await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })) as any).result;

  test('tools/list advertises an object output schema', async () => {
    const list = (await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as any;
    const tools = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t]));
    expect(tools.info.outputSchema).toMatchObject({ type: 'object', properties: { name: { type: 'string' }, size: { type: 'number' } } });
    expect(tools.obj.outputSchema).toBeUndefined();
    // Output schemas must describe objects
    expect(tools.list.outputSchema).toBeUndefined();
  });

  test('object results come back as structuredContent too', async () => {
    const info = await call('info');
    expect(info.structuredContent).toEqual({ name: 'a', size: 1 });
    expect(JSON.parse(info.content.at(-1).text)).toEqual({ name: 'a', size: 1 });
    expect((await call('obj')).structuredContent).toEqual({ ok: true });
    expect((await call('list')).structuredContent).toBeUndefined();
    expect((await call('text')).structuredContent).toBeUndefined();
    const fail = await call('fail');
    expect(fail.isError).toBe(true);
    expect(fail.structuredContent).toBeUndefined();
  });
});

describe('MCP HTTP origins and sessions', () => {
  test('isAllowedOrigin allows loopback origins and the explicit cors origin', () => {
    for (const origin of ['http://localhost:5173', 'https://127.0.0.1', 'http://[::1]:8080', 'http://localhost']) {
      expect(isAllowedOrigin(origin, undefined)).toBe(true);
    }
    for (const origin of ['http://evil.example', 'null', 'http://localhost.evil.example', 'not a url']) {
      expect(isAllowedOrigin(origin, undefined)).toBe(false);
    }
    expect(isAllowedOrigin('https://app.example.com', 'https://app.example.com')).toBe(true);
    expect(isAllowedOrigin('https://other.example.com', 'https://app.example.com')).toBe(false);
    expect(isAllowedOrigin('https://other.example.com', '*')).toBe(true);
    expect(isAllowedOrigin('https://other.example.com', false)).toBe(false);
  });

  const startServer = async (prefs: Record<string, unknown> = {}) => {
    let close: (() => void) | undefined;
    const program = createPadrone('app')
      .runtime({
        error: () => {},
        // The server subscribes first; tool calls subscribe too
        onSignal: (cb) => {
          close ??= () => cb('SIGTERM');
          return () => {};
        },
      })
      .command('greet', (c) => c.action(() => 'hi'))
      .command('slow', (c) =>
        c.async().action(
          (_, ctx) =>
            new Promise<string>((resolve) => {
              const timer = setTimeout(() => resolve('finished'), 2000);
              ctx.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve('aborted');
              });
            }),
        ),
      );
    const port = randomPort();
    const server = startMcpServer(program as any, getCommand(program), program.eval.bind(program) as any, { port, ...prefs });
    await new Promise((r) => setTimeout(r, 50));
    const url = `http://127.0.0.1:${port}/mcp`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
    return {
      url,
      post,
      stop: async () => {
        close?.();
        await server;
      },
    };
  };

  test('rejects requests from origins that are not allowed', async () => {
    const { post, stop } = await startServer();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    try {
      expect((await post(ping, { Origin: 'http://evil.example' })).status).toBe(403);
      expect((await post(ping, { Origin: 'http://localhost:5173' })).status).toBe(200);
      expect((await post(ping)).status).toBe(200);
    } finally {
      await stop();
    }
  });

  test('an explicit cors origin is allowed', async () => {
    const { post, stop } = await startServer({ cors: 'https://app.example.com' });
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    try {
      expect((await post(ping, { Origin: 'https://app.example.com' })).status).toBe(200);
      expect((await post(ping, { Origin: 'https://other.example.com' })).status).toBe(403);
    } finally {
      await stop();
    }
  });

  test('DELETE aborts the calls in flight in that session', async () => {
    const { url, post, stop } = await startServer();
    try {
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
      const session = init.headers.get('mcp-session-id')!;
      expect(session).toBeTruthy();
      const pending = post(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } },
        { 'MCP-Session-Id': session },
      );
      await new Promise((r) => setTimeout(r, 50));
      expect((await fetch(url, { method: 'DELETE', headers: { 'MCP-Session-Id': session } })).status).toBe(200);
      const res = (await (await pending).json()) as any;
      expect(res.result.content[0].text).toBe('aborted');
    } finally {
      await stop();
    }
  });
});

describe('serve stderr', () => {
  const program = createPadrone('app')
    .extend(padroneLogger())
    .command('warn', (c) =>
      c.action((_, ctx) => {
        ctx.runtime.output('out');
        ctx.context.logger.warn('careful');
        return 'ok';
      }),
    )
    .command('quiet', (c) => c.action(() => 'ok'))
    .command('fail', (c) =>
      c.action((_, ctx) => {
        ctx.runtime.error('about to fail');
        throw new Error('broke');
      }),
    );
  const handler = createServeHandler(getCommand(program), program.eval.bind(program) as any);

  test('what the command wrote to stderr is returned alongside the output', async () => {
    expect(await (await handler(new Request('http://localhost/warn'))).json()).toEqual({
      ok: true,
      result: 'ok',
      output: ['out'],
      stderr: ['[WARN] careful'],
    });
    expect(await (await handler(new Request('http://localhost/quiet'))).json()).toEqual({ ok: true, result: 'ok' });
    const fail = await handler(new Request('http://localhost/fail'));
    expect(fail.status).toBe(500);
    expect(await fail.json()).toEqual({ ok: false, error: 'action_error', message: 'broke', stderr: ['about to fail'] });
  });
});

describe('serve sensitive fields', () => {
  const program = createPadrone('app')
    .command('login', (c) =>
      c
        .arguments(
          z.object({
            user: z.string(),
            token: z.string().optional(),
            db: z.object({ host: z.string().optional(), password: z.string().optional().meta({ sensitive: true }) }).optional(),
          }),
          { fields: { token: { sensitive: true, flags: 't', alias: 'api-token' } } },
        )
        .action((args) => ({ user: args.user, hasToken: !!args.token, hasPassword: !!args.db?.password })),
    )
    .command('secret', (c) =>
      c
        .arguments(z.object({ key: z.string() }), { positional: ['key'], fields: { key: { sensitive: true } } })
        .action((args) => args.key.length),
    );
  const handler = createServeHandler(getCommand(program), program.eval.bind(program) as any);

  test('OpenAPI leaves sensitive fields out of GET query parameters', async () => {
    const spec = (await (await handler(new Request('http://localhost/_openapi'))).json()) as any;
    expect(spec.paths['/login'].get.parameters.map((p: any) => p.name)).toEqual(['user', 'db.host']);
    expect(spec.paths['/login'].post.requestBody.content['application/json'].schema.properties.token.writeOnly).toBe(true);
    // A required sensitive field can't be sent with GET
    expect(spec.paths['/secret'].get).toBeUndefined();
    expect(spec.paths['/secret'].post).toBeDefined();
  });

  test('sensitive fields in the query string are rejected', async () => {
    for (const query of ['token=x', 't=x', 'api-token=x', 'db.password=x']) {
      const res = await handler(new Request(`http://localhost/login?user=u&${query}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe('bad_request');
    }
    expect((await handler(new Request('http://localhost/secret?_=abc'))).status).toBe(400);
    expect(await (await handler(new Request('http://localhost/login?user=u&db.host=h'))).json()).toEqual({
      ok: true,
      result: { user: 'u', hasToken: false, hasPassword: false },
    });
  });

  test('POST bodies can carry them', async () => {
    const res = await handler(
      new Request('http://localhost/login', { method: 'POST', body: JSON.stringify({ user: 'u', token: 'x', db: { password: 'p' } }) }),
    );
    expect(await res.json()).toEqual({ ok: true, result: { user: 'u', hasToken: true, hasPassword: true } });
  });
});

describe('tracing conventions', () => {
  function createProvider() {
    const spans: { name: string; options?: { kind?: number }; status?: { code: number; message?: string } }[] = [];
    const provider: OtelTracerProvider = {
      getTracer: () => ({
        startSpan(name, options) {
          const record: (typeof spans)[number] = { name, options };
          spans.push(record);
          const span: OtelSpan = {
            setAttribute: () => span,
            addEvent: () => span,
            setStatus: (status) => {
              record.status = status;
              return span;
            },
            recordException: () => span,
            end() {},
            spanContext: () => ({ traceId: 't', spanId: name }),
          };
          return span;
        },
      }),
    };
    return { provider, spans };
  }

  const build = (provider: OtelTracerProvider) =>
    createPadrone('app')
      .runtime({ output: () => {}, error: () => {} })
      .extend(padroneTracing({ provider }))
      .command('deploy', (c) => c.action(() => 'ok'))
      .command('fail', (c) =>
        c.action(() => {
          throw new Error('boom');
        }),
      );

  test('spans are named after the caller, with a server kind for serve and MCP', async () => {
    const { provider, spans } = createProvider();
    const program = build(provider);
    await program.eval('deploy');
    await program.eval('deploy', { caller: 'serve' });
    await program.eval('deploy', { caller: 'mcp' });
    await program.run('deploy', undefined);
    expect(spans.map((s) => [s.name, s.options?.kind])).toEqual([
      ['eval deploy', 0],
      ['serve deploy', 1],
      ['mcp deploy', 1],
      ['run deploy', 0],
    ]);
  });

  test('the span status carries the error message', async () => {
    const { provider, spans } = createProvider();
    await build(provider).eval('fail');
    expect(spans[0]!.status).toEqual({ code: 2, message: 'boom' });
  });
});
