import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPadrone, padroneUpgrade } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import { padroneMan } from 'padrone/man';
import { padroneMcp } from 'padrone/mcp';
import { padroneServe } from 'padrone/serve';
import * as z from 'zod/v4';
import { commandSymbol } from '../src/core/commands.ts';
import { startMcpServer } from '../src/feature/mcp.ts';
import { createServeHandler, startServeServer } from '../src/feature/serve.ts';

const getCommand = (program: any) => program[commandSymbol];
const randomPort = () => 40000 + Math.floor(Math.random() * 20000);

describe('tool() and built-in commands that act on the host', () => {
  const home = mkdtempSync(join(tmpdir(), 'padrone-sweep5-'));
  const saved = { PROFILE: process.env.PROFILE, XDG_DATA_HOME: process.env.XDG_DATA_HOME, fetch: globalThis.fetch };
  const fetched: string[] = [];
  const installed: string[][] = [];
  beforeAll(() => {
    process.env.PROFILE = join(home, 'profile.ps1');
    process.env.XDG_DATA_HOME = join(home, 'share');
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      return Response.json({ version: '9.9.9' });
    }) as typeof fetch;
  });
  afterAll(() => {
    for (const key of ['PROFILE', 'XDG_DATA_HOME'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.fetch = saved.fetch;
    rmSync(home, { recursive: true, force: true });
  });

  const program = createPadrone('app')
    .runtime({ output: () => {}, error: () => {} })
    .extend(
      padroneUpgrade({
        packageName: 'app',
        installer: 'npm',
        exec: async (command) => {
          installed.push([...command]);
          return 0;
        },
      }),
    )
    .extend(padroneServe({ port: randomPort() }))
    .extend(padroneMcp({ port: randomPort() }))
    .extend(padroneCompletion())
    .extend(padroneMan())
    .command('greet', (c) => c.action(() => 'hi'));
  const execute = (command: string) => program.tool().execute!({ command }, {} as never) as Promise<{ result: unknown; error: string }>;

  test("serve and mcp don't start servers", async () => {
    for (const command of ['serve', 'mcp http']) {
      const res = await Promise.race([execute(command), new Promise((r) => setTimeout(() => r('timeout'), 500))]);
      expect(res).not.toBe('timeout');
      expect((res as { error: string }).error).toContain('only available on the command line');
    }
  });

  test("completion scripts and man pages aren't installed", async () => {
    for (const command of ['completion powershell --setup', 'man --setup', 'man --remove']) {
      const res = await execute(command);
      expect(res.result).toBeUndefined();
      expect(res.error).toContain('only available on the command line');
    }
    expect(existsSync(join(home, 'profile.ps1'))).toBe(false);
    expect(existsSync(join(home, 'share'))).toBe(false);
  });

  test("upgrade doesn't reach the registry or install anything", async () => {
    for (const command of ['upgrade', 'upgrade --check']) {
      expect((await execute(command)).error).toContain('only available on the command line');
    }
    expect(fetched).toEqual([]);
    expect(installed).toEqual([]);
  });

  test('help and program commands still run', async () => {
    expect((await execute('greet')).result).toBe('hi');
    expect(String((await execute('help greet')).result)).toContain('greet');
  });

  test('the command line still has them', async () => {
    expect(String((await program.eval('completion bash')).result)).toContain('app');
  });
});

describe('serve origins', () => {
  const program = createPadrone('app').command('deploy', (c) => c.configure({ mutation: true }).action(() => 'deployed'));
  const handler = (prefs?: Parameters<typeof createServeHandler>[2]) =>
    createServeHandler(getCommand(program), program.eval.bind(program) as any, prefs);
  // A text/plain POST is a "simple" request: browsers send it cross-origin without a preflight
  const post = (serve: (req: Request) => Promise<Response>, headers: Record<string, string> = {}) =>
    serve(new Request('http://localhost/deploy', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain', ...headers } }));

  test('requests from other websites are rejected', async () => {
    const serve = handler();
    const res = await post(serve, { Origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('deployed');
    const preflight = await serve(
      new Request('http://localhost/deploy', { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } }),
    );
    expect(preflight.status).toBe(403);
    expect((await post(serve, { Origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await post(serve)).status).toBe(200);
  });

  test('an explicit cors origin is allowed, and "*" allows any', async () => {
    const one = handler({ cors: 'https://app.example.com' });
    expect((await post(one, { Origin: 'https://app.example.com' })).status).toBe(200);
    expect((await post(one, { Origin: 'https://other.example.com' })).status).toBe(403);
    expect((await post(handler({ cors: '*' }), { Origin: 'https://other.example.com' })).status).toBe(200);
  });

  test('a same-origin request (the served docs page on a LAN address) is allowed', async () => {
    const res = await handler()(
      new Request('http://192.168.1.5:3000/deploy', { method: 'POST', body: '{}', headers: { Origin: 'http://192.168.1.5:3000' } }),
    );
    expect(res.status).toBe(200);
  });
});

describe('serve sensitive values inside objects', () => {
  const program = createPadrone('app')
    .globalArgs(z.object({ auth: z.object({ key: z.string().optional().meta({ sensitive: true }) }).optional() }))
    .command('login', (c) =>
      c
        .arguments(
          z.object({
            user: z.string(),
            db: z.object({ host: z.string().optional(), password: z.string().optional().meta({ sensitive: true }) }).optional(),
            list: z.array(z.object({ secret: z.string().meta({ sensitive: true }) })).optional(),
          }),
        )
        .action((args) => args),
    );
  const serve = createServeHandler(getCommand(program), program.eval.bind(program) as any);

  test('a whole object with a sensitive value in the query string is rejected', async () => {
    for (const query of ['db={"password":"LEAK"}', 'list={"secret":"LEAK"}', 'auth={"key":"LEAK"}']) {
      const res = await serve(new Request(`http://localhost/login?user=u&${query}`));
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('LEAK');
    }
    const ok = await serve(new Request('http://localhost/login?user=u&db.host=h'));
    expect(await ok.json()).toEqual({ ok: true, result: { user: 'u', db: { host: 'h' } } });
  });

  test('OpenAPI leaves them out of the GET query parameters', async () => {
    const spec = (await (await serve(new Request('http://localhost/_openapi'))).json()) as any;
    expect(spec.paths['/login'].get.parameters.map((p: { name: string }) => p.name)).toEqual(['user', 'db.host']);
  });
});

describe('request body size', () => {
  const program = createPadrone('app').command('echo', (c) =>
    c.arguments(z.object({ text: z.string().optional() })).action((args) => args.text?.length ?? 0),
  );
  const body = (size: number) => JSON.stringify({ text: 'x'.repeat(size) });

  test('serve refuses bodies over maxBodySize, from Content-Length or while reading', async () => {
    const serve = createServeHandler(getCommand(program), program.eval.bind(program) as any, { maxBodySize: 1000 });
    const post = (init: RequestInit) => serve(new Request('http://localhost/echo', { method: 'POST', ...init }));
    const sized = await post({ body: body(2000) });
    expect(sized.status).toBe(413);
    expect(((await sized.json()) as { error: string }).error).toBe('payload_too_large');
    const chunks = [new TextEncoder().encode(body(600)), new TextEncoder().encode(body(600))];
    const stream = new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    expect((await post({ body: stream, duplex: 'half' } as RequestInit)).status).toBe(413);
    expect(await (await post({ body: body(500) })).json()).toEqual({ ok: true, result: 500 });
  });

  test('the default limit is 4 MiB', async () => {
    const serve = createServeHandler(getCommand(program), program.eval.bind(program) as any);
    const post = (size: number) => serve(new Request('http://localhost/echo', { method: 'POST', body: body(size) }));
    expect((await post(5 * 1024 * 1024)).status).toBe(413);
    expect((await post(1024 * 1024)).status).toBe(200);
  });

  test('the servers answer 413', async () => {
    let close: (() => void) | undefined;
    const server = createPadrone('app')
      .runtime({
        error: () => {},
        onSignal: (cb) => {
          close = () => cb('SIGTERM');
          return () => {};
        },
      })
      .command('echo', (c) => c.action(() => 'ok'));
    const [servePort, mcpPort] = [randomPort(), randomPort()];
    const cmd = getCommand(server);
    const serving = startServeServer(server as any, cmd, server.eval.bind(server) as any, { port: servePort, maxBodySize: 100 });
    const closeServe = () => close?.();
    await new Promise((r) => setTimeout(r, 50));
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(200) } });
    try {
      expect((await fetch(`http://127.0.0.1:${servePort}/echo`, { method: 'POST', body: big })).status).toBe(413);
    } finally {
      closeServe();
      await serving;
    }
    const mcp = startMcpServer(server as any, cmd, server.eval.bind(server) as any, { port: mcpPort, maxBodySize: 100 });
    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        method: 'POST',
        body: big,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(413);
      const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect((await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', body: ping })).status).toBe(200);
    } finally {
      close?.();
      await mcp;
    }
  });
});

/** Sends a request with any `Host` header (fetch doesn't let a request set it). */
const rawRequest = (port: number, options: { method?: string; path: string; host: string; body?: string }) =>
  new Promise<number>((resolve, reject) => {
    const headers = { Host: options.host, 'Content-Type': 'application/json' };
    const req = request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(options.body);
  });

describe('DNS rebinding', () => {
  const serverProgram = () => {
    let close: (() => void) | undefined;
    const program = createPadrone('app')
      .runtime({
        error: () => {},
        onSignal: (cb) => {
          close ??= () => cb('SIGTERM');
          return () => {};
        },
      })
      .command('greet', (c) => c.action(() => 'hi'));
    return { program, close: () => close?.() };
  };

  test('serve on a loopback host only answers requests for a loopback host name', async () => {
    const { program, close } = serverProgram();
    const port = randomPort();
    const server = startServeServer(program as any, getCommand(program), program.eval.bind(program) as any, { port });
    await new Promise((r) => setTimeout(r, 50));
    try {
      expect(await rawRequest(port, { path: '/greet', host: `evil.example:${port}` })).toBe(403);
      expect(await rawRequest(port, { path: '/greet', host: `localhost:${port}` })).toBe(200);
      expect(await rawRequest(port, { path: '/greet', host: `127.0.0.1:${port}` })).toBe(200);
    } finally {
      close();
      await server;
    }
  });

  test('so does the MCP HTTP transport', async () => {
    const { program, close } = serverProgram();
    const port = randomPort();
    const server = startMcpServer(program as any, getCommand(program), program.eval.bind(program) as any, { port });
    await new Promise((r) => setTimeout(r, 50));
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    try {
      expect(await rawRequest(port, { method: 'POST', path: '/mcp', host: `evil.example:${port}`, body })).toBe(403);
      expect(await rawRequest(port, { method: 'POST', path: '/mcp', host: `[::1]:${port}`, body })).toBe(200);
    } finally {
      close();
      await server;
    }
  });
});
