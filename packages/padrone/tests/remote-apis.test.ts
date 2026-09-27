import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPadrone, defineInterceptor, padronePlugins } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol, isAllowedHost } from '../src/core/commands.ts';
import { createMcpHandler } from '../src/feature/mcp.ts';
import { matchesCommandPattern } from '../src/feature/remote.ts';
import { createServeHandler } from '../src/feature/serve.ts';

const getCommand = (program: any) => program[commandSymbol];
const serveHandler = (program: any, prefs?: Parameters<typeof createServeHandler>[2]) =>
  createServeHandler(getCommand(program), program.eval.bind(program), prefs);
const mcpHandler = (program: any, prefs?: Parameters<typeof createMcpHandler>[2]) =>
  createMcpHandler(getCommand(program), program.eval.bind(program), prefs);
const toolNames = async (handler: ReturnType<typeof mcpHandler>) =>
  ((await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
const openApiPaths = async (serve: ReturnType<typeof serveHandler>) =>
  Object.keys(((await (await serve(new Request('http://localhost/_openapi'))).json()) as { paths: object }).paths);

/** A command that waits `ms` (or until aborted), recording whether its signal was aborted. */
const waitCommand = (log: string[]) => (c: any) =>
  c.arguments(z.object({ ms: z.coerce.number().default(1000) })).action(
    (args: { ms: number }, ctx: { signal: AbortSignal }) =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('finished'), args.ms);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          log.push(`aborted: ${(ctx.signal.reason as Error)?.name ?? ctx.signal.reason}`);
          resolve('aborted');
        });
      }),
  );

/** Starts `program.serve()` / `program.mcp()` on a free port; `stop()` closes it. */
async function startServer(kind: 'serve' | 'mcp', build: (program: any) => any, prefs: Record<string, unknown> = {}) {
  let close: (() => void) | undefined;
  const logs: string[] = [];
  const program = build(
    createPadrone('app').runtime({
      output: () => {},
      error: (text: string) => logs.push(text),
      onSignal: (cb: (signal: 'SIGTERM') => void) => {
        close ??= () => cb('SIGTERM');
        return () => {};
      },
    }),
  );
  const running: Promise<void> = program[kind]({ port: 0, ...prefs });
  let port: string | undefined;
  for (let i = 0; i < 100 && !port; i++) {
    port = logs.join('\n').match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) await new Promise((r) => setTimeout(r, 10));
  }
  if (!port) throw new Error('The server did not start');
  return {
    url: `http://127.0.0.1:${port}`,
    port: Number(port),
    stop: async () => {
      close?.();
      await running;
    },
  };
}

const msg = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method, params });
const rpc = (id: number, method: string, params?: Record<string, unknown>) => JSON.stringify(msg(id, method, params));

describe('expose', () => {
  const program = createPadrone('app')
    .runtime({ output: () => {}, error: () => {} })
    .command('local', (c) => c.configure({ expose: false }).action(() => 'local'))
    .command('agents', (c) => c.configure({ expose: ['cli', 'eval', 'mcp'] }).action(() => 'agents'))
    .command('admin', (c) =>
      c
        .configure({ expose: false })
        .command('reset', (s) => s.action(() => 'reset'))
        .command('status', (s) => s.configure({ expose: true }).action(() => 'status')),
    )
    .command('open', (c) => c.action(() => 'open'));

  test('local commands run from the command line but not for serve, MCP or tool()', async () => {
    expect((await program.eval('local')).result).toBe('local');
    for (const caller of ['serve', 'mcp', 'tool'] as const) {
      const result = await program.eval('local', { caller });
      expect((result.error as Error).message).toBe('"local" is only available on the command line');
    }
    const res = (await program.tool().execute!({ command: 'local' }, {} as never)) as { error: string };
    expect(res.error).toBe('"local" is only available on the command line');
  });

  test('a list of callers allows exactly those', async () => {
    expect((await program.eval('agents', { caller: 'mcp' })).result).toBe('agents');
    expect(((await program.eval('agents', { caller: 'serve' })).error as Error).message).toBe('"agents" is not available to serve callers');
    expect((program.run('agents', undefined as never).error as Error).message).toBe('"agents" is not available to run callers');
    expect(program.run('open', undefined as never).result).toBe('open');
  });

  test('subcommands inherit it, unless they set their own', async () => {
    expect(((await program.eval('admin reset', { caller: 'mcp' })).error as Error).message).toContain('only available on the command line');
    expect((await program.eval('admin status', { caller: 'mcp' })).result).toBe('status');
  });

  test('serve and MCP only list what they can run', async () => {
    expect(await toolNames(mcpHandler(program))).toEqual(['agents', 'admin.status', 'open', 'help']);
    expect(await openApiPaths(serveHandler(program))).toEqual(['/admin/status', '/open']);
    expect((await serveHandler(program)(new Request('http://localhost/local'))).status).toBe(404);
  });

  test('the plugins group is local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'padrone-remote-apis-'));
    const installed: string[][] = [];
    try {
      const plugins = createPadrone('app')
        .runtime({ output: () => {}, error: () => {} })
        .extend(
          padronePlugins({
            dir,
            command: true,
            exec: async (command) => {
              installed.push([...command]);
              return 0;
            },
          }),
        );
      for (const caller of ['serve', 'mcp', 'tool'] as const) {
        const result = await plugins.eval('plugins install left-pad', { caller });
        expect((result.error as Error).message).toBe('"plugins install" is only available on the command line');
      }
      expect(installed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('built-in commands are local, except help and version', async () => {
    const tool = createPadrone('app')
      .runtime({ output: () => {} })
      .configure({ version: '1.2.3' })
      .command('greet', (c) => c.action(() => 'hi'))
      .tool();
    const execute = (command: string) => tool.execute!({ command }, {} as never) as Promise<{ result: unknown; error: string }>;
    expect(String((await execute('help greet')).result)).toContain('greet');
    expect((await execute('version')).result).toBe('1.2.3');
  });
});

describe('include and exclude', () => {
  const program = createPadrone('app')
    .action(() => 'root')
    .command('db', (c) =>
      c
        .action(() => 'db')
        .command('migrate', (s) => s.action(() => 'migrate'))
        .command('seed', (s) => s.action(() => 'seed')),
    )
    .command('users', (c) => c.command('list', (s) => s.action(() => 'users')).command('delete', (s) => s.action(() => 'deleted')));

  test('command patterns', () => {
    expect(matchesCommandPattern('db migrate', 'db.migrate')).toBe(true);
    expect(matchesCommandPattern('db.*', 'db.migrate')).toBe(true);
    expect(matchesCommandPattern('db.*', 'db')).toBe(false);
    expect(matchesCommandPattern('db.**', 'db')).toBe(true);
    expect(matchesCommandPattern('**.delete', 'users.delete')).toBe(true);
    expect(matchesCommandPattern('user*', 'users')).toBe(true);
    expect(matchesCommandPattern('*', 'users.list')).toBe(false);
    expect(matchesCommandPattern('**', '')).toBe(true);
  });

  test('serve offers only the included commands', async () => {
    const serve = serveHandler(program, { include: ['db.**'], exclude: ['db seed'] });
    expect(await openApiPaths(serve)).toEqual(['/db', '/db/migrate']);
    expect((await serve(new Request('http://localhost/db/seed'))).status).toBe(404);
    expect(await (await serve(new Request('http://localhost/db/migrate'))).json()).toEqual({ ok: true, result: 'migrate' });
  });

  test('MCP takes patterns or a predicate', async () => {
    expect(await toolNames(mcpHandler(program, { exclude: ['**.delete'] }))).toEqual([
      'app',
      'db',
      'db.migrate',
      'db.seed',
      'users.list',
      'help',
    ]);
    expect(await toolNames(mcpHandler(program, { include: (command) => command.name === 'seed' }))).toEqual(['db.seed', 'help']);
    const call = await mcpHandler(program, { include: ['users.*'] })(msg(1, 'tools/call', { name: 'db' }));
    expect(call!.error?.message).toBe('Unknown tool: db');
  });
});

describe('serve auth', () => {
  const whoami = (c: any) => c.action((_args: unknown, ctx: { auth?: unknown }) => ctx.auth ?? null);
  const program = createPadrone('app').command('whoami', whoami);

  test('bearer tokens', async () => {
    const serve = serveHandler(program, { bearer: ['one', 'two'] });
    const get = (headers?: Record<string, string>) => serve(new Request('http://localhost/whoami', { headers }));
    const refused = await get();
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    expect(await refused.json()).toEqual({ ok: false, error: 'unauthorized', message: 'Unauthorized' });
    expect((await get({ Authorization: 'Bearer three' })).status).toBe(401);
    expect((await get({ Authorization: 'Basic two' })).status).toBe(401);
    expect(await (await get({ Authorization: 'bearer two' })).json()).toEqual({ ok: true, result: { token: 'two' } });
    // Health checks and the CORS preflight need no token; the docs do
    expect((await serve(new Request('http://localhost/_health'))).status).toBe(200);
    expect((await serve(new Request('http://localhost/whoami', { method: 'OPTIONS' }))).status).toBe(204);
    expect((await serve(new Request('http://localhost/_openapi'))).status).toBe(401);
    const spec = (await (
      await serve(new Request('http://localhost/_openapi', { headers: { Authorization: 'Bearer one' } }))
    ).json()) as any;
    expect(spec.security).toEqual([{ bearer: [] }]);
  });

  test('an auth function gives the identity to actions and interceptors', async () => {
    const seen: unknown[] = [];
    const audited = createPadrone('app')
      .intercept(
        defineInterceptor({ name: 'audit' }, () => ({
          route(ctx, next) {
            seen.push(ctx.auth);
            return next();
          },
        })),
      )
      .command('whoami', whoami);
    const serve = serveHandler(audited, {
      auth: async (req) => (req.headers.get('x-user') ? { user: req.headers.get('x-user') } : undefined),
    });
    const refused = await serve(new Request('http://localhost/whoami'));
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBeNull();
    const res = await serve(new Request('http://localhost/whoami', { headers: { 'X-User': 'ada' } }));
    expect(await res.json()).toEqual({ ok: true, result: { user: 'ada' } });
    expect(seen).toEqual([{ user: 'ada' }]);
  });

  test('eval() takes it too', async () => {
    expect((await program.eval('whoami', { auth: 'me' })).result as unknown).toBe('me');
    expect((await program.eval('whoami')).result as unknown).toBeNull();
  });
});

describe('timeout and maxConcurrent', () => {
  test('serve answers 504 after the timeout and aborts the command', async () => {
    const log: string[] = [];
    const program = createPadrone('app').command('wait', waitCommand(log));
    const serve = serveHandler(program, { timeout: 30 });
    const res = await serve(new Request('http://localhost/wait?ms=5000'));
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: string }).error).toBe('timeout');
    expect(log).toEqual(['aborted: TimeoutError']);
    expect(await (await serve(new Request('http://localhost/wait?ms=1'))).json()).toEqual({ ok: true, result: 'finished' });
  });

  test('serve answers 503 over maxConcurrent', async () => {
    const program = createPadrone('app').command('wait', waitCommand([]));
    const serve = serveHandler(program, { maxConcurrent: 1 });
    const first = serve(new Request('http://localhost/wait?ms=50'));
    const second = await serve(new Request('http://localhost/wait?ms=1'));
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBe('1');
    expect((await first).status).toBe(200);
    expect((await serve(new Request('http://localhost/wait?ms=1'))).status).toBe(200);
  });

  test('MCP answers with JSON-RPC errors', async () => {
    const log: string[] = [];
    const program = createPadrone('app').command('wait', waitCommand(log));
    const timed = await mcpHandler(program, { timeout: 30 })(msg(1, 'tools/call', { name: 'wait', arguments: { ms: 5000 } }));
    expect(timed!.error).toEqual({ code: -32001, message: 'Request timed out after 30 ms' });
    expect(log).toEqual(['aborted: TimeoutError']);

    const limited = mcpHandler(program, { maxConcurrent: 1 });
    const first = limited(msg(1, 'tools/call', { name: 'wait', arguments: { ms: 50 } }));
    const second = await limited(msg(2, 'tools/call', { name: 'wait', arguments: { ms: 1 } }));
    expect(second!.error?.code).toBe(-32000);
    expect(((await first)!.result as { isError: boolean }).isError).toBe(false);
  });

  test('tool() takes a timeout', async () => {
    const log: string[] = [];
    const tool = createPadrone('app').command('wait', waitCommand(log)).tool({ timeout: 30 });
    const res = (await tool.execute!({ command: 'wait --ms 5000' }, {} as never)) as { error: string };
    expect(res.error).toBe('Timed out after 30 ms');
    expect(log).toEqual(['aborted: TimeoutError']);
  });
});

describe('allowedHosts', () => {
  test('extends the host check to any binding', () => {
    expect(isAllowedHost('evil.example', '0.0.0.0')).toBe(true);
    expect(isAllowedHost('evil.example', '0.0.0.0', ['api.example.com'])).toBe(false);
    expect(isAllowedHost('api.example.com:8080', '0.0.0.0', ['api.example.com'])).toBe(true);
    expect(isAllowedHost('a.b.example.com', '0.0.0.0', ['.example.com'])).toBe(true);
    expect(isAllowedHost('example.com', '0.0.0.0', ['.example.com'])).toBe(true);
    expect(isAllowedHost('badexample.com', '0.0.0.0', ['.example.com'])).toBe(false);
    expect(isAllowedHost('localhost:3000', '0.0.0.0', ['api.example.com'])).toBe(true);
    expect(isAllowedHost('192.168.1.5:3000', '192.168.1.5', [])).toBe(true);
    expect(isAllowedHost('app.local', '127.0.0.1', ['app.local'])).toBe(true);
    expect(isAllowedHost('evil.example', '127.0.0.1', true)).toBe(true);
    expect(isAllowedHost('evil.example', '127.0.0.1', 'all')).toBe(true);
  });

  const statusFor = (port: number, host: string, path: string, method = 'GET', body?: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: host, 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(body);
    });

  test('serve and MCP servers apply it', async () => {
    const build = (p: any) => p.command('greet', (c: any) => c.action(() => 'hi'));
    const serve = await startServer('serve', build, { allowedHosts: ['app.local'] });
    try {
      expect(await statusFor(serve.port, 'app.local', '/greet')).toBe(200);
      expect(await statusFor(serve.port, 'evil.example', '/greet')).toBe(403);
    } finally {
      await serve.stop();
    }
    const mcp = await startServer('mcp', build, { allowedHosts: true });
    try {
      expect(await statusFor(mcp.port, 'evil.example', '/mcp', 'POST', rpc(1, 'ping'))).toBe(200);
    } finally {
      await mcp.stop();
    }
  });
});

describe('MCP over HTTP', () => {
  const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
  const initialize = async (url: string, headers: Record<string, string> = {}) => {
    const res = await post(url, rpc(1, 'initialize', { protocolVersion: '2025-11-25' }), headers);
    return res.headers.get('mcp-session-id')!;
  };
  const build = (p: any) =>
    p.command('whoami', (c: any) => c.action((_args: unknown, ctx: { auth?: unknown }) => JSON.stringify(ctx.auth ?? null)));

  test('bearer auth answers 401 with a JSON-RPC error, and gives commands the identity', async () => {
    const server = await startServer('mcp', build, { bearer: 'secret' });
    try {
      const refused = await post(server.url, rpc(1, 'ping'));
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe('Bearer');
      expect(await refused.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
      const auth = { Authorization: 'Bearer secret' };
      const session = await initialize(server.url, auth);
      const call = await post(server.url, rpc(2, 'tools/call', { name: 'whoami', arguments: {} }), { ...auth, 'MCP-Session-Id': session });
      expect(((await call.json()) as any).result.content[0].text).toBe('{"token":"secret"}');
      expect((await fetch(`${server.url}/mcp`, { method: 'DELETE', headers: { 'MCP-Session-Id': session } })).status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  test('idle sessions expire after sessionTtl', async () => {
    const server = await startServer('mcp', build, { sessionTtl: 40 });
    try {
      const session = await initialize(server.url);
      expect((await post(server.url, rpc(2, 'ping'), { 'MCP-Session-Id': session })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 25));
      // A request keeps it alive
      expect((await post(server.url, rpc(3, 'ping'), { 'MCP-Session-Id': session })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 25));
      expect((await post(server.url, rpc(4, 'ping'), { 'MCP-Session-Id': session })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 80));
      expect((await post(server.url, rpc(5, 'ping'), { 'MCP-Session-Id': session })).status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test('maxSessions drops the least recently used session', async () => {
    const server = await startServer('mcp', build, { maxSessions: 2 });
    try {
      const [a, b] = [await initialize(server.url), await initialize(server.url)];
      expect((await post(server.url, rpc(2, 'ping'), { 'MCP-Session-Id': a })).status).toBe(200);
      const c = await initialize(server.url);
      expect((await post(server.url, rpc(3, 'ping'), { 'MCP-Session-Id': b })).status).toBe(404);
      for (const session of [a, c]) expect((await post(server.url, rpc(4, 'ping'), { 'MCP-Session-Id': session })).status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
