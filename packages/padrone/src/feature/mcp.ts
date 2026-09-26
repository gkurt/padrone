import { buildInputSchema, collectEndpoints, serializeArgsToFlags } from '../core/commands.ts';
import { formatIssueMessages } from '../core/validate.ts';
import { generateHelp } from '../output/help.ts';
import type { AnyPadroneCommand, AnyPadroneProgram } from '../types/index.ts';
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

/** Convert a tool name back to a command path (dot → space). */
function toCommandPath(toolName: string): string {
  return toolName.replace(/\./g, ' ');
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
function buildToolDefinition(name: string, cmd: AnyPadroneCommand) {
  return {
    name: toToolName(name),
    title: cmd.title ?? undefined,
    description: cmd.description || cmd.title || `Run the "${name}" command`,
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

  const rootTools = collectEndpoints(existingCommand.commands, '');
  if (existingCommand.action || existingCommand.argsSchema) {
    rootTools.unshift({ name: '', command: existingCommand });
  }

  const toolMap = new Map(rootTools.map((t) => [toToolName(t.name), t]));

  const helpToolName = 'help';
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

  return async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const { id, method, params } = req;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: serverVersion },
          },
        };

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;

      case 'ping':
        return { jsonrpc: '2.0', id: id ?? null, result: {} };

      case 'tools/list': {
        const tools = [...rootTools.map((t) => buildToolDefinition(t.name, t.command)), helpToolDef];
        return { jsonrpc: '2.0', id: id ?? null, result: { tools } };
      }

      case 'tools/call': {
        const toolName = params?.name as string;
        const args = (params?.arguments ?? {}) as Record<string, unknown>;

        // Built-in help tool
        if (toolName === helpToolName) {
          const cmdName = args.command as string | undefined;
          const targetCmd = cmdName ? rootTools.find((t) => t.name === cmdName || toToolName(t.name) === cmdName)?.command : undefined;
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

        // Build command string: convert tool name back to command path + serialize args as flags
        const commandPath = toCommandPath(tool.name);
        const argParts = serializeArgsToFlags(args);
        const input = [commandPath, ...argParts].filter(Boolean).join(' ') || undefined;

        try {
          const output: string[] = [];
          const errors: string[] = [];
          const result = await evalCommand(input as any, {
            caller: 'mcp',
            runtime: {
              output: (...outArgs: unknown[]) => output.push(outArgs.map(String).join(' ')),
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
        }
      }

      default: {
        if (id !== undefined) {
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
        }
        return undefined;
      }
    }
  };
}

/** stdio transport: newline-delimited JSON per 2025-11-25 spec. */
async function startStdioTransport(handleRequest: (req: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>): Promise<void> {
  const { stdin, stdout } = await import('node:process');
  const { createInterface } = await import('node:readline');

  function send(msg: JsonRpcResponse) {
    stdout.write(`${JSON.stringify(msg)}\n`);
  }

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const res = await handleRequest(req);
      if (res) send(res);
    } catch {
      // Ignore malformed JSON
    }
  }
}

/** Streamable HTTP transport per 2025-11-25 spec. Responds with JSON or SSE based on client's Accept header. */
async function startHttpTransport(
  handleRequest: (req: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>,
  prefs: PadroneMcpPreferences,
  log: (msg: string) => void,
  onSignal?: (callback: () => void) => () => void,
): Promise<void> {
  const http = await import('node:http');
  const crypto = await import('node:crypto');

  const port = prefs.port ?? 3000;
  const host = prefs.host ?? '127.0.0.1';
  const endpoint = prefs.basePath ?? '/mcp';

  // Session management
  let sessionId: string | undefined;
  let negotiatedVersion: string | undefined;

  const corsOrigin = prefs.cors !== false ? (prefs.cors ?? '*') : undefined;

  const server = http.createServer(async (req, res) => {
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

    if (req.url !== endpoint) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // DELETE: terminate session
    if (req.method === 'DELETE') {
      const reqSessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && reqSessionId === sessionId) {
        sessionId = undefined;
        negotiatedVersion = undefined;
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
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
    if (sessionId && reqSessionId && reqSessionId !== sessionId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid session' } }));
      return;
    }

    // Validate MCP-Protocol-Version header on post-init requests
    const reqProtocolVersion = req.headers['mcp-protocol-version'] as string | undefined;
    if (negotiatedVersion && reqProtocolVersion && reqProtocolVersion !== negotiatedVersion) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Protocol version mismatch' } }));
      return;
    }

    // Read request body
    const body = await readStreamAsText(req as AsyncIterable<Uint8Array>);

    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const response = await handleRequest(rpcRequest);

    // On initialize response: create session and set header
    if (rpcRequest.method === 'initialize' && response?.result) {
      sessionId = crypto.randomUUID();
      negotiatedVersion = PROTOCOL_VERSION;
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
