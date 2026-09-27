import { isPlainObject } from '../core/args.ts';
import {
  buildInputSchema,
  buildOutputSchema,
  collectEndpoints,
  isAllowedHost,
  isAllowedOrigin,
  serializeArgsToFlags,
} from '../core/commands.ts';
import { formatIssueMessages } from '../core/validate.ts';
import { generateHelp } from '../output/help.ts';
import type { AnyPadroneCommand, AnyPadroneProgram } from '../types/index.ts';
import { outputValueToText } from '../util/json.ts';
import { BodyTooLargeError, readBodyText } from '../util/stream.ts';
import {
  createAuthenticator,
  createCallLimiter,
  createCommandFilter,
  linkedController,
  type PadroneRemotePreferences,
  serverBaseUrl,
  toFetchHeaders,
} from './remote.ts';

export type PadroneMcpPreferences = PadroneRemotePreferences & {
  /** Server name. Defaults to the program name. */
  name?: string;
  /** Server version. Defaults to the program version. */
  version?: string;
  /**
   * Transport mode.
   * - `'http'` — Start a Streamable HTTP server (default). Responds with `application/json` or `text/event-stream` based on the client's `Accept` header. Use `port` and `host` to configure.
   * - `'stdio'` — Communicate over stdin/stdout with newline-delimited JSON.
   */
  transport?: 'http' | 'stdio';
  /** HTTP port. Defaults to `3000`. Only used with `transport: 'http'`. */
  port?: number;
  /** HTTP host. Defaults to `'127.0.0.1'`. Only used with `transport: 'http'`. */
  host?: string;
  /** Base path for the MCP endpoint. Defaults to `'/mcp'`. Only used with `transport: 'http'`. */
  basePath?: string;
  /**
   * CORS allowed origin. Defaults to `'*'`. Set to a specific origin or `false` to disable CORS headers. Only used with HTTP transports.
   * Requests with an `Origin` header are rejected (403) unless it's a loopback origin (`localhost`, `127.0.0.1`, `[::1]`)
   * or the origin set here (`'*'` set explicitly allows any).
   */
  cors?: string | false;
  /** Largest HTTP request body accepted, in bytes; a larger one gets a 413. Defaults to 4 MiB. Only used with `transport: 'http'`. */
  maxBodySize?: number;
  /**
   * How long an HTTP session may go without requests, in ms, before it's dropped (its calls aborted); the client then gets
   * 404 and starts a new one. Calls in flight keep it alive. Defaults to no limit. Only used with `transport: 'http'`.
   */
  sessionTtl?: number;
  /**
   * Most HTTP sessions kept: a new one drops the least recently used (aborting its calls). Defaults to 1000.
   * Only used with `transport: 'http'`.
   */
  maxSessions?: number;
};

const PROTOCOL_VERSION = '2025-11-25';
/** Versions this server can speak; `initialize` echoes the client's when it's one of them. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, '2025-06-18', '2025-03-26']);

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Convert an endpoint dot-path to a valid MCP tool name. Spec allows: [A-Za-z0-9_\-\.] */
function toToolName(path: string): string {
  return path.replace(/\s+/g, '.');
}

/** The root command's tool name: the program name (tool names must be 1–128 characters of `[A-Za-z0-9_.-]`). */
function toRootToolName(programName: string, taken: Set<string>): string {
  const name = programName.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 128) || 'run';
  return taken.has(name) ? `${name}_root` : name;
}

/** Build MCP tool annotations from a command's metadata. */
function buildAnnotations(cmd: AnyPadroneCommand) {
  if (cmd.mutation == null) return undefined;
  return {
    destructiveHint: cmd.mutation || undefined,
    readOnlyHint: cmd.mutation === false || undefined,
  };
}

/** Build an MCP tool definition from a command. */
function buildToolDefinition(toolName: string, name: string, cmd: AnyPadroneCommand) {
  const outputSchema = buildOutputSchema(cmd);
  return {
    name: toolName,
    title: cmd.title ?? undefined,
    description: cmd.description || cmd.title || (name ? `Run the "${name}" command` : 'Run the program'),
    inputSchema: buildInputSchema(cmd),
    // The spec only allows object output schemas
    outputSchema: outputSchema?.type === 'object' ? outputSchema : undefined,
    annotations: buildAnnotations(cmd),
  };
}

/** Create the MCP request handler. Returns an async function that processes a JSON-RPC request and returns a response (or undefined for notifications). */
export function createMcpHandler(
  existingCommand: AnyPadroneCommand,
  evalCommand: AnyPadroneProgram['eval'],
  prefs?: PadroneMcpPreferences,
) {
  const serverName = prefs?.name ?? existingCommand.name;
  const serverVersion = prefs?.version ?? existingCommand.version ?? '0.0.0';

  const endpoints = collectEndpoints(existingCommand, 'mcp', createCommandFilter(prefs));
  const taken = new Set(endpoints.map((t) => toToolName(t.name)));
  const rootTools = endpoints.map((t) => ({ ...t, toolName: t.name ? toToolName(t.name) : toRootToolName(existingCommand.name, taken) }));
  const limit = createCallLimiter(prefs);

  const toolMap = new Map(rootTools.map((t) => [t.toolName, t]));

  // A command named `help` keeps its name; the built-in help tool steps aside
  const helpToolName = toolMap.has('help') ? 'padrone_help' : 'help';
  const helpToolDef = {
    name: helpToolName,
    title: 'Help',
    description: `Show help for the "${serverName}" program or a specific command`,
    inputSchema: {
      type: 'object' as const,
      properties: { command: { type: 'string', description: 'Command name to get help for (omit for program help)' } },
      additionalProperties: false,
    },
  };

  // Tool calls in flight, keyed by session and request id, so `notifications/cancelled` can abort them
  const inFlight = new Map<string, AbortController>();
  const flightKey = (session: string, id: string | number) => `${session}\0${typeof id}:${id}`;

  /**
   * Handles one JSON-RPC message. `signal` aborts the call too, e.g. when an HTTP client disconnects; `session` scopes
   * request ids (clients number them independently); `auth` is who made the request. Notifications and responses from the
   * client get no response.
   */
  return async function handleRequest(
    message: unknown,
    signal?: AbortSignal,
    session = '',
    auth?: unknown,
  ): Promise<JsonRpcResponse | undefined> {
    const kind = classifyMessage(message);
    if (kind === 'response') return undefined;
    if (kind === 'invalid') return invalidRequest(message);
    const req = message as JsonRpcRequest;
    const response = await dispatch(req, signal, session, auth);
    return req.id === undefined ? undefined : response;
  };

  async function dispatch(
    req: JsonRpcRequest,
    signal: AbortSignal | undefined,
    session: string,
    auth: unknown,
  ): Promise<JsonRpcResponse | undefined> {
    const { id, method, params } = req;

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: serverVersion },
          },
        };
      }

      case 'notifications/cancelled': {
        const requestId = params?.requestId as string | number | undefined;
        if (requestId !== undefined) inFlight.get(flightKey(session, requestId))?.abort(params?.reason ?? 'Cancelled by the client');
        return undefined;
      }

      case 'notifications/initialized':
        return undefined;

      case 'ping':
        return { jsonrpc: '2.0', id: id ?? null, result: {} };

      case 'tools/list': {
        const tools = [...rootTools.map((t) => buildToolDefinition(t.toolName, t.name, t.command)), helpToolDef];
        return { jsonrpc: '2.0', id: id ?? null, result: { tools } };
      }

      case 'tools/call': {
        const toolName = params?.name as string;
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== 'object' || Array.isArray(args)) {
          return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'Invalid params: arguments must be an object' } };
        }

        // Built-in help tool
        if (toolName === helpToolName) {
          const cmdName = args.command as string | undefined;
          const targetCmd = cmdName ? rootTools.find((t) => t.name === cmdName || t.toolName === cmdName)?.command : undefined;
          if (cmdName && !targetCmd) {
            return {
              jsonrpc: '2.0',
              id: id ?? null,
              result: { content: [{ type: 'text', text: `Unknown command: ${cmdName}` }], isError: true },
            };
          }
          const helpText = generateHelp(existingCommand, targetCmd ?? existingCommand, { format: 'text', detail: 'full' });
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: { content: [{ type: 'text', text: helpText }], isError: false },
          };
        }

        const tool = toolMap.get(toolName);
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
          };
        }

        // Passed as argv tokens, so values with spaces or quotes arrive intact
        const input = [...tool.name.split('.').filter(Boolean), ...serializeArgsToFlags(args, tool.command)];

        const { controller, dispose } = linkedController(signal);
        // A reused id doesn't take over the cancellation of a call still running under it
        const key = id != null && !inFlight.has(flightKey(session, id)) ? flightKey(session, id) : undefined;
        if (key) inFlight.set(key, controller);
        try {
          const call = await limit(controller, () => callTool(input, controller.signal, auth));
          if (call.status === 'busy') {
            return { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: 'Too many requests in progress, try again later' } };
          }
          if (call.status === 'timeout') {
            return { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: `Request timed out after ${prefs?.timeout} ms` } };
          }
          return { jsonrpc: '2.0', id: id ?? null, result: call.value };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text: errorMsg }], isError: true } };
        } finally {
          if (key) inFlight.delete(key);
          dispose();
        }
      }

      default:
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  /** Runs a tool's command: the `tools/call` result. */
  async function callTool(input: string[], signal: AbortSignal, auth: unknown): Promise<Record<string, unknown>> {
    const output: string[] = [];
    const errors: string[] = [];
    const result = await evalCommand(input.length ? input : (undefined as any), {
      caller: 'mcp',
      signal,
      auth,
      runtime: {
        output: (...outArgs: unknown[]) => output.push(outArgs.map(outputValueToText).join(' ')),
        error: (text: string) => errors.push(text),
        interactive: 'unsupported',
        format: 'text',
      },
    });

    const content: { type: string; text: string }[] = [];

    if (result.error) {
      const errorMsg = result.error instanceof Error ? result.error.message : String(result.error);
      if (errors.length) content.push({ type: 'text', text: errors.join('\n') });
      content.push({ type: 'text', text: errorMsg });
      return { content, isError: true };
    }

    if (result.argsResult?.issues) {
      content.push({ type: 'text', text: `Validation error:\n${formatIssueMessages(result.argsResult.issues)}` });
      return { content, isError: true };
    }

    if (output.length) content.push({ type: 'text', text: output.join('\n') });
    if (result.result !== undefined && result.result !== null) {
      const resultText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
      content.push({ type: 'text', text: resultText });
    }
    if (content.length === 0) content.push({ type: 'text', text: 'Done.' });
    const structuredContent = isPlainObject(result.result) ? result.result : undefined;
    return { content, ...(structuredContent && { structuredContent }), isError: false };
  }
}

type JsonRpcMessageKind = 'request' | 'response' | 'invalid';

function classifyMessage(message: unknown): JsonRpcMessageKind {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'invalid';
  const msg = message as Record<string, unknown>;
  const validId = msg.id === undefined || typeof msg.id === 'string' || typeof msg.id === 'number';
  if (typeof msg.method === 'string') return validId ? 'request' : 'invalid';
  return msg.id !== undefined && ('result' in msg || 'error' in msg) ? 'response' : 'invalid';
}

function invalidRequest(message: unknown): JsonRpcResponse {
  const id = message && typeof message === 'object' ? (message as Record<string, unknown>).id : undefined;
  return {
    jsonrpc: '2.0',
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: { code: -32600, message: Array.isArray(message) ? 'Invalid Request: batches are not supported' : 'Invalid Request' },
  };
}

type McpRequestHandler = ReturnType<typeof createMcpHandler>;

type McpSession = { version: string; owner?: string; calls: Set<AbortController>; timer?: ReturnType<typeof setTimeout> };

/** Who a session belongs to: the `auth` identity, compared by value (a fresh object per request). */
function sessionOwner(auth: unknown): string | undefined {
  if (auth === undefined) return undefined;
  try {
    return JSON.stringify(auth) ?? String(auth);
  } catch {
    return String(auth);
  }
}

/**
 * HTTP sessions, least recently used first. One is dropped (its calls aborted) after `ttl` ms without requests, or when a
 * new one would make more than `max`.
 */
function createSessionStore(ttl: number | undefined, max: number, newId: () => string) {
  const sessions = new Map<string, McpSession>();
  const drop = (id: string, reason: string): boolean => {
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    clearTimeout(session.timer);
    for (const call of session.calls) call.abort(reason);
    return true;
  };
  const expireWhenIdle = (id: string, session: McpSession) => {
    clearTimeout(session.timer);
    if (ttl === undefined || session.calls.size > 0) return;
    session.timer = setTimeout(() => drop(id, 'Session expired'), ttl);
    session.timer.unref?.();
  };
  return {
    /** The session, if `owner` created it: another identity that knows its id can't use or end it. */
    get(id: string, owner: string | undefined) {
      const session = sessions.get(id);
      return session && session.owner === owner ? session : undefined;
    },
    drop,
    create(version: string, owner: string | undefined): string {
      for (const oldest of sessions.keys()) {
        if (sessions.size < Math.max(1, max)) break;
        drop(oldest, 'Session evicted');
      }
      const id = newId();
      const session: McpSession = { version, owner, calls: new Set() };
      sessions.set(id, session);
      expireWhenIdle(id, session);
      return id;
    },
    /** A request on the session: it becomes the most recently used and doesn't expire until the returned function is called. */
    begin(id: string, session: McpSession, call: AbortController): () => void {
      sessions.delete(id);
      sessions.set(id, session);
      clearTimeout(session.timer);
      session.calls.add(call);
      return () => {
        session.calls.delete(call);
        if (sessions.get(id) === session) expireWhenIdle(id, session);
      };
    },
    clear() {
      for (const session of sessions.values()) clearTimeout(session.timer);
      sessions.clear();
    },
  };
}

/** stdio transport: newline-delimited JSON per 2025-11-25 spec. */
async function startStdioTransport(handleRequest: McpRequestHandler): Promise<void> {
  const { stdin, stdout } = await import('node:process');
  const { createInterface } = await import('node:readline');

  function send(msg: JsonRpcResponse) {
    stdout.write(`${JSON.stringify(msg)}\n`);
  }

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Not awaited: a long tool call mustn't hold up later messages, such as its own cancellation
    const call = handleRequest(message).then(
      (res) => {
        if (res) send(res);
      },
      () => {},
    );
    pending.add(call);
    call.finally(() => pending.delete(call));
  }
  // Input closed: let calls still running send their responses before returning
  await Promise.all(pending);
}

/** Streamable HTTP transport per 2025-11-25 spec. Responds with JSON or SSE based on client's Accept header. */
async function startHttpTransport(
  handleRequest: McpRequestHandler,
  prefs: PadroneMcpPreferences,
  log: (msg: string) => void,
  onSignal?: (callback: () => void) => () => void,
): Promise<void> {
  const http = await import('node:http');
  const crypto = await import('node:crypto');

  const port = prefs.port ?? 3000;
  const host = prefs.host ?? '127.0.0.1';
  const endpoint = prefs.basePath ?? '/mcp';
  let baseUrl = serverBaseUrl(host, port);
  const authenticate = createAuthenticator(prefs);

  // One per initialized client: the negotiated protocol version, and the calls in flight (aborted when it's terminated)
  const sessions = createSessionStore(prefs.sessionTtl, prefs.maxSessions ?? 1000, () => crypto.randomUUID());

  const corsOrigin = prefs.cors !== false ? (prefs.cors ?? '*') : undefined;

  const server = http.createServer(async (req, res) => {
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // A refused request's body is still read (up to `maxBodySize`), or its connection can keep the server from closing
    const discardBody = () =>
      readBodyText(req as AsyncIterable<Uint8Array>, req.headers['content-length'], prefs.maxBodySize).catch(() => {
        res.setHeader('Connection', 'close');
      });

    // CORS headers
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version');
      res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id');
    }

    // DNS rebinding protection: browsers send `Origin`, other clients don't
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, prefs.cors)) {
      sendJson(403, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Origin not allowed: ${origin}` } });
      return;
    }
    if (!isAllowedHost(req.headers.host, host, prefs.allowedHosts)) {
      sendJson(403, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Host not allowed: ${req.headers.host}` } });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(corsOrigin ? 204 : 405);
      res.end();
      return;
    }

    if (new URL(req.url ?? '/', 'http://localhost').pathname !== endpoint) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405);
      res.end();
      return;
    }

    let auth: unknown;
    if (authenticate) {
      try {
        auth = await authenticate(new Request(`${baseUrl}${req.url ?? '/'}`, { method: req.method, headers: toFetchHeaders(req.headers) }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: `Internal error: ${message}` } });
        return;
      }
      if (!auth) {
        await discardBody();
        res.setHeader('WWW-Authenticate', 'Bearer');
        sendJson(401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
        return;
      }
    }

    // DELETE: terminate session
    if (req.method === 'DELETE') {
      const reqSessionId = req.headers['mcp-session-id'] as string | undefined;
      const dropped =
        reqSessionId && sessions.get(reqSessionId, sessionOwner(auth)) ? sessions.drop(reqSessionId, 'Session terminated') : false;
      res.writeHead(!reqSessionId ? 400 : dropped ? 200 : 404);
      res.end();
      return;
    }

    // GET: SSE stream (not implemented — return 405)
    if (req.method === 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'SSE stream not supported' } }));
      return;
    }

    // Validate session ID on non-initialize requests
    const reqSessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = reqSessionId ? sessions.get(reqSessionId, sessionOwner(auth)) : undefined;
    const negotiatedVersion = session?.version;
    if (reqSessionId && !negotiatedVersion) {
      await discardBody();
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid session' } }));
      return;
    }

    // Validate MCP-Protocol-Version header: the negotiated version once in a session, a supported one otherwise
    const reqProtocolVersion = req.headers['mcp-protocol-version'] as string | undefined;
    if (
      reqProtocolVersion &&
      (negotiatedVersion ? reqProtocolVersion !== negotiatedVersion : !SUPPORTED_PROTOCOL_VERSIONS.has(reqProtocolVersion))
    ) {
      sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported protocol version: ${reqProtocolVersion}` } });
      return;
    }

    let rpcRequest: unknown;
    try {
      rpcRequest = JSON.parse(await readBodyText(req as AsyncIterable<Uint8Array>, req.headers['content-length'], prefs.maxBodySize));
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      if (tooLarge) res.setHeader('Connection', 'close');
      const rpcError = tooLarge ? { code: -32600, message: error.message } : { code: -32700, message: 'Parse error' };
      sendJson(tooLarge ? 413 : 400, { jsonrpc: '2.0', id: null, error: rpcError });
      return;
    }

    // Abort the call when the client goes away before the response is sent, or its session is terminated
    const call = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) call.abort('Client disconnected');
    });
    const done = session && reqSessionId ? sessions.begin(reqSessionId, session, call) : undefined;
    let response: JsonRpcResponse | undefined;
    try {
      response = await handleRequest(rpcRequest, call.signal, reqSessionId, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: `Internal error: ${message}` } });
      return;
    } finally {
      done?.();
    }
    if (response?.error?.code === -32600 && response.id === null) {
      sendJson(400, response);
      return;
    }

    // On initialize response: create session and set header
    const initialized = (response?.result as { protocolVersion?: string } | undefined)?.protocolVersion;
    if ((rpcRequest as JsonRpcRequest).method === 'initialize' && initialized) {
      res.setHeader('MCP-Session-Id', sessions.create(initialized, sessionOwner(auth)));
    }

    if (response) {
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/event-stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      }
    } else {
      // Notification or response from client — no body
      res.writeHead(202);
      res.end();
    }
  });

  return new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      // The port it got, for port 0
      const address = server.address();
      baseUrl = serverBaseUrl(host, typeof address === 'object' && address ? address.port : port);
      log(`MCP server listening on ${baseUrl}${endpoint}`);
    });
    server.on('error', reject);
    const unsubscribe = onSignal?.(() => {
      server.close(() => resolve());
      // Keep-alive clients would otherwise hold the server open; requests in flight still finish
      server.closeIdleConnections?.();
    });
    server.on('close', () => {
      unsubscribe?.();
      sessions.clear();
    });
  });
}

export async function startMcpServer(
  _program: AnyPadroneProgram,
  existingCommand: AnyPadroneCommand,
  evalCommand: AnyPadroneProgram['eval'],
  prefs?: PadroneMcpPreferences,
): Promise<void> {
  const handleRequest = createMcpHandler(existingCommand, evalCommand, prefs);
  const transport = prefs?.transport ?? 'http';

  if (transport === 'stdio') {
    return startStdioTransport(handleRequest);
  }

  const { getCommandRuntime } = await import('../core/commands.ts');
  const runtime = getCommandRuntime(existingCommand);
  return startHttpTransport(handleRequest, prefs ?? {}, (msg) => runtime.error(msg), runtime.onSignal);
}
