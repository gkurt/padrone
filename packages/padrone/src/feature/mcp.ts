import { buildInputSchema, collectEndpoints, serializeArgsToFlags } from '../core/commands.ts';
import { formatIssueMessages } from '../core/validate.ts';
import { generateHelp } from '../output/help.ts';
import type { AnyPadroneCommand, AnyPadroneProgram } from '../types/index.ts';
import { outputValueToText } from '../util/json.ts';
import { readStreamAsText } from '../util/stream.ts';

export type PadroneMcpPreferences = {
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
  /** CORS allowed origin. Defaults to `'*'`. Set to a specific origin or `false` to disable CORS headers. Only used with HTTP transports. */
  cors?: string | false;
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
  return {
    name: toolName,
    title: cmd.title ?? undefined,
    description: cmd.description || cmd.title || (name ? `Run the "${name}" command` : 'Run the program'),
    inputSchema: buildInputSchema(cmd),
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

  const rootTools = collectEndpoints(existingCommand.commands, '').map((t) => ({ ...t, toolName: toToolName(t.name) }));
  if (existingCommand.action || existingCommand.argsSchema) {
    const taken = new Set(rootTools.map((t) => t.toolName));
    rootTools.unshift({ name: '', command: existingCommand, toolName: toRootToolName(existingCommand.name, taken) });
  }

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
   * request ids (clients number them independently). Notifications and responses from the client get no response.
   */
  return async function handleRequest(message: unknown, signal?: AbortSignal, session = ''): Promise<JsonRpcResponse | undefined> {
    const kind = classifyMessage(message);
    if (kind === 'response') return undefined;
    if (kind === 'invalid') return invalidRequest(message);
    const req = message as JsonRpcRequest;
    const response = await dispatch(req, signal, session);
    return req.id === undefined ? undefined : response;
  };

  async function dispatch(req: JsonRpcRequest, signal: AbortSignal | undefined, session: string): Promise<JsonRpcResponse | undefined> {
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

        const controller = new AbortController();
        const onAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        // A reused id doesn't take over the cancellation of a call still running under it
        const key = id != null && !inFlight.has(flightKey(session, id)) ? flightKey(session, id) : undefined;
        if (key) inFlight.set(key, controller);
        try {
          const output: string[] = [];
          const errors: string[] = [];
          const result = await evalCommand(input.length ? input : (undefined as any), {
            caller: 'mcp',
            signal: controller.signal,
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
            return { jsonrpc: '2.0', id: id ?? null, result: { content, isError: true } };
          }

          if (result.argsResult?.issues) {
            content.push({ type: 'text', text: `Validation error:\n${formatIssueMessages(result.argsResult.issues)}` });
            return { jsonrpc: '2.0', id: id ?? null, result: { content, isError: true } };
          }

          if (output.length) content.push({ type: 'text', text: output.join('\n') });
          if (result.result !== undefined && result.result !== null) {
            const resultText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
            content.push({ type: 'text', text: resultText });
          }
          if (content.length === 0) content.push({ type: 'text', text: 'Done.' });
          return { jsonrpc: '2.0', id: id ?? null, result: { content, isError: false } };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: { content: [{ type: 'text', text: errorMsg }], isError: true },
          };
        } finally {
          if (key) inFlight.delete(key);
          signal?.removeEventListener('abort', onAbort);
        }
      }

      default:
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
    }
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

  // Session ID → negotiated protocol version, one per initialized client
  const sessions = new Map<string, string>();

  const corsOrigin = prefs.cors !== false ? (prefs.cors ?? '*') : undefined;

  const server = http.createServer(async (req, res) => {
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // CORS headers
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, MCP-Session-Id, MCP-Protocol-Version');
      res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id');
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

    // DELETE: terminate session
    if (req.method === 'DELETE') {
      const reqSessionId = req.headers['mcp-session-id'] as string | undefined;
      res.writeHead(!reqSessionId ? 400 : sessions.delete(reqSessionId) ? 200 : 404);
      res.end();
      return;
    }

    // GET: SSE stream (not implemented — return 405)
    if (req.method === 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'SSE stream not supported' } }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    // Validate session ID on non-initialize requests
    const reqSessionId = req.headers['mcp-session-id'] as string | undefined;
    const negotiatedVersion = reqSessionId ? sessions.get(reqSessionId) : undefined;
    if (reqSessionId && !negotiatedVersion) {
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
      rpcRequest = JSON.parse(await readStreamAsText(req as AsyncIterable<Uint8Array>));
    } catch {
      sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    // Abort the call when the client goes away before the response is sent
    const disconnected = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) disconnected.abort('Client disconnected');
    });
    let response: JsonRpcResponse | undefined;
    try {
      response = await handleRequest(rpcRequest, disconnected.signal, reqSessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: `Internal error: ${message}` } });
      return;
    }
    if (response?.error?.code === -32600 && response.id === null) {
      sendJson(400, response);
      return;
    }

    // On initialize response: create session and set header
    const initialized = (response?.result as { protocolVersion?: string } | undefined)?.protocolVersion;
    if ((rpcRequest as JsonRpcRequest).method === 'initialize' && initialized) {
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, initialized);
      res.setHeader('MCP-Session-Id', sessionId);
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
      log(`MCP server listening on http://${host}:${port}${endpoint}`);
    });
    server.on('error', reject);
    const unsubscribe = onSignal?.(() => {
      server.close(() => resolve());
    });
    server.on('close', () => unsubscribe?.());
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
