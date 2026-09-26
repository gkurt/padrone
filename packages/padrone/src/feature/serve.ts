import { buildInputSchema, type CollectedEndpoint, collectEndpoints, serializeArgsToFlags } from '../core/commands.ts';
import { RoutingError, ValidationError } from '../core/errors.ts';
import { generateHelp } from '../output/help.ts';
import type { AnyPadroneCommand, AnyPadroneProgram } from '../types/index.ts';
import { readStreamAsText } from '../util/stream.ts';

export type PadroneServePreferences = {
  /** Port to listen on. Default: 3000 */
  port?: number;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Base path prefix for all routes. Default: '/' */
  basePath?: string;
  /** CORS allowed origin. Default: '*'. Set to `false` to disable CORS headers. */
  cors?: string | false;
  /** Control built-in utility endpoints. All enabled by default. */
  builtins?: {
    /** GET /_health — returns 200 OK. */
    health?: boolean;
    /** GET /_help and GET /_help/:command — returns help text. */
    help?: boolean;
    /** GET /_schema and GET /_schema/:command — returns JSON Schema. */
    schema?: boolean;
    /** GET /_docs — Scalar OpenAPI docs viewer. */
    docs?: boolean;
  };
  /** Hook to run before each request. Return a Response to short-circuit. */
  onRequest?: (req: Request) => Response | void | Promise<Response | void>;
  /** Transform errors into responses. */
  onError?: (error: unknown, req: Request) => Response;
};

/** Convert an endpoint dot-path to a URL path segment. */
function toUrlPath(name: string): string {
  return name.replace(/\./g, '/');
}

/** Convert a URL path segment back to a command path (slash → space). */
function toCommandPath(urlPath: string): string {
  return urlPath.replace(/\//g, ' ');
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorToStatus(error: unknown): number {
  if (error instanceof RoutingError) return 404;
  if (error instanceof ValidationError) return 400;
  return 500;
}

function errorToResponse(error: unknown): Response {
  const status = errorToStatus(error);
  if (error instanceof ValidationError) {
    return jsonResponse(
      {
        ok: false,
        error: 'validation',
        message: error.message,
        issues: error.issues.map((i) => ({ path: i.path?.map(String), message: i.message })),
      },
      status,
    );
  }
  if (error instanceof RoutingError) {
    return jsonResponse({ ok: false, error: 'not_found', message: error.message, suggestions: error.suggestions }, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ ok: false, error: 'action_error', message }, status);
}

/** Generate an OpenAPI 3.1.0 spec from the command tree. */
function buildOpenApiSpec(existingCommand: AnyPadroneCommand, endpoints: CollectedEndpoint[], basePath: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  const responseSchema = {
    '200': {
      description: 'Successful response',
      content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', const: true }, result: {} } } } },
    },
    '400': {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean', const: false },
              error: { type: 'string', const: 'validation' },
              message: { type: 'string' },
              issues: { type: 'array', items: { type: 'object', properties: { path: { type: 'array' }, message: { type: 'string' } } } },
            },
          },
        },
      },
    },
    '404': {
      description: 'Command not found',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean', const: false },
              error: { type: 'string', const: 'not_found' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    '500': {
      description: 'Action error',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean', const: false },
              error: { type: 'string', const: 'action_error' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  };

  for (const { name, command: cmd } of endpoints) {
    const urlPath = `${basePath}${toUrlPath(name)}`;
    const inputSchema = buildInputSchema(cmd);
    const description = cmd.description || cmd.title || `Run the "${name}" command`;
    const pathItem: Record<string, unknown> = {};

    const postOp = {
      summary: cmd.title || name,
      description,
      operationId: `post_${name.replace(/\./g, '_')}`,
      requestBody: { content: { 'application/json': { schema: inputSchema } } },
      responses: responseSchema,
    };

    if (cmd.mutation) {
      pathItem.post = postOp;
    } else {
      // GET: args as query parameters
      const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const queryParams = Object.entries(properties).map(([key, schema]) => ({
        name: key,
        in: 'query',
        schema,
        required: (inputSchema.required as string[] | undefined)?.includes(key) ?? false,
      }));
      pathItem.get = {
        summary: cmd.title || name,
        description,
        operationId: `get_${name.replace(/\./g, '_')}`,
        parameters: queryParams,
        responses: responseSchema,
      };
      pathItem.post = postOp;
    }

    paths[urlPath] = pathItem;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: existingCommand.title || existingCommand.name,
      description: existingCommand.description,
      version: existingCommand.version ?? '0.0.0',
    },
    paths,
  };
}

function scalarDocsHtml(openapiUrl: string, title: string): string {
  return `<!doctype html>
<html>
<head>
  <title>${title} — API Docs</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="${openapiUrl}"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}

/** Create the serve request handler. */
export function createServeHandler(
  existingCommand: AnyPadroneCommand,
  evalCommand: AnyPadroneProgram['eval'],
  prefs?: PadroneServePreferences,
): (req: Request) => Promise<Response> {
  const basePath = (prefs?.basePath ?? '/').replace(/\/$/, '/');
  const corsOrigin = prefs?.cors !== false ? (prefs?.cors ?? '*') : undefined;
  const builtins = { health: true, help: true, schema: true, docs: true, ...prefs?.builtins };

  const endpoints = collectEndpoints(existingCommand.commands, '');
  if (existingCommand.action || existingCommand.argsSchema) {
    endpoints.unshift({ name: '', command: existingCommand });
  }

  const routeMap = new Map<string, CollectedEndpoint>();
  for (const ep of endpoints) {
    routeMap.set(toUrlPath(ep.name), ep);
  }

  let cachedOpenApiSpec: Record<string, unknown> | undefined;
  const getOpenApiSpec = () => (cachedOpenApiSpec ??= buildOpenApiSpec(existingCommand, endpoints, basePath));

  function addCorsHeaders(res: Response): Response {
    if (!corsOrigin) return res;
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  async function evalAndRespond(commandString: string, request: Request): Promise<Response> {
    const output: string[] = [];
    const errors: string[] = [];
    const result = await evalCommand(commandString || (undefined as any), {
      caller: 'serve',
      // Aborts the command when the client disconnects
      signal: request.signal,
      runtime: {
        output: (...args: unknown[]) => output.push(args.map(String).join(' ')),
        error: (text: string) => errors.push(text),
        interactive: 'unsupported',
        format: 'json',
      },
    });

    if (result.error) {
      return prefs?.onError ? prefs.onError(result.error, request) : errorToResponse(result.error);
    }

    if (result.argsResult?.issues) {
      const issues = (result.argsResult.issues as { path?: PropertyKey[]; message: string }[]).map((i) => ({
        path: i.path?.map(String),
        message: i.message,
      }));
      return jsonResponse({ ok: false, error: 'validation', issues }, 400);
    }

    return jsonResponse({ ok: true, result: result.result ?? null });
  }

  return async function handleRequest(req: Request): Promise<Response> {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      return addCorsHeaders(new Response(null, { status: corsOrigin ? 204 : 405 }));
    }

    // onRequest hook
    if (prefs?.onRequest) {
      const hookResponse = await prefs.onRequest(req);
      if (hookResponse) return addCorsHeaders(hookResponse);
    }

    const url = new URL(req.url, 'http://localhost');
    let pathname = url.pathname;

    // Strip basePath prefix
    if (basePath !== '/' && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length - 1);
    }
    // Remove leading slash for route matching
    const routePath = pathname.replace(/^\//, '');

    // Built-in endpoints
    if (req.method === 'GET') {
      if (builtins.health && routePath === '_health') {
        return addCorsHeaders(jsonResponse({ status: 'ok' }));
      }

      if (builtins.schema && routePath === '_schema') {
        const schemaMap: Record<string, unknown> = {};
        for (const ep of endpoints) {
          schemaMap[toUrlPath(ep.name) || '/'] = buildInputSchema(ep.command);
        }
        return addCorsHeaders(jsonResponse(schemaMap));
      }

      if (builtins.schema && routePath.startsWith('_schema/')) {
        const cmdPath = routePath.slice('_schema/'.length);
        const ep = routeMap.get(cmdPath);
        if (!ep) return addCorsHeaders(jsonResponse({ ok: false, error: 'not_found', message: `Command not found: ${cmdPath}` }, 404));
        return addCorsHeaders(jsonResponse(buildInputSchema(ep.command)));
      }

      if (builtins.help && routePath === '_help') {
        const accept = req.headers.get('accept') ?? '';
        const format = accept.includes('application/json') ? 'json' : 'markdown';
        const helpText = generateHelp(existingCommand, existingCommand, { format, detail: 'full' });
        if (format === 'json') return addCorsHeaders(jsonResponse(JSON.parse(helpText)));
        return addCorsHeaders(new Response(helpText, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
      }

      if (builtins.help && routePath.startsWith('_help/')) {
        const cmdPath = routePath.slice('_help/'.length);
        const ep = routeMap.get(cmdPath);
        if (!ep) return addCorsHeaders(jsonResponse({ ok: false, error: 'not_found', message: `Command not found: ${cmdPath}` }, 404));
        const accept = req.headers.get('accept') ?? '';
        const format = accept.includes('application/json') ? 'json' : 'markdown';
        const helpText = generateHelp(existingCommand, ep.command, { format, detail: 'full' });
        if (format === 'json') return addCorsHeaders(jsonResponse(JSON.parse(helpText)));
        return addCorsHeaders(new Response(helpText, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
      }

      if (builtins.docs && routePath === '_openapi') {
        return addCorsHeaders(jsonResponse(getOpenApiSpec()));
      }

      if (builtins.docs && routePath === '_docs') {
        const openapiUrl = `${basePath}_openapi`;
        const title = existingCommand.title || existingCommand.name;
        const html = scalarDocsHtml(openapiUrl, title);
        return addCorsHeaders(new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }));
      }
    }

    // Route to command
    const endpoint = routeMap.get(routePath);
    if (!endpoint) {
      return addCorsHeaders(jsonResponse({ ok: false, error: 'not_found', message: `Command not found: ${routePath || '/'}` }, 404));
    }

    // Enforce method based on mutation flag
    if (endpoint.command.mutation && req.method === 'GET') {
      return addCorsHeaders(
        new Response(JSON.stringify({ ok: false, error: 'method_not_allowed', message: 'Mutation commands only accept POST' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: 'POST' },
        }),
      );
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      return addCorsHeaders(new Response(null, { status: 405, headers: { Allow: endpoint.command.mutation ? 'POST' : 'GET, POST' } }));
    }

    // Build command string from request
    const commandPath = toCommandPath(routePath);
    let argParts: string[];

    if (req.method === 'POST') {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        argParts = serializeArgsToFlags(body);
      } catch {
        return addCorsHeaders(jsonResponse({ ok: false, error: 'bad_request', message: 'Invalid JSON body' }, 400));
      }
    } else {
      // GET: query string → flags
      argParts = [];
      for (const [key, value] of url.searchParams.entries()) {
        if (key === '_') {
          // Positional args
          argParts.push(value);
        } else {
          argParts.push(value === '' ? `--${key}` : `--${key}=${value}`);
        }
      }
    }

    const commandString = [commandPath, ...argParts].filter(Boolean).join(' ');
    const response = await evalAndRespond(commandString, req);
    return addCorsHeaders(response);
  };
}

/** Start the serve HTTP server. */
export async function startServeServer(
  _program: AnyPadroneProgram,
  existingCommand: AnyPadroneCommand,
  evalCommand: AnyPadroneProgram['eval'],
  prefs?: PadroneServePreferences,
): Promise<void> {
  const handler = createServeHandler(existingCommand, evalCommand, prefs);
  const http = await import('node:http');

  const port = prefs?.port ?? 3000;
  const host = prefs?.host ?? '127.0.0.1';
  const basePath = (prefs?.basePath ?? '/').replace(/\/$/, '/');

  const server = http.createServer(async (req, res) => {
    const url = `http://${host}:${port}${req.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    const disconnected = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) disconnected.abort('Client disconnected');
    });
    const fetchReq = new Request(url, {
      method: req.method,
      headers,
      signal: disconnected.signal,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? await readBody(req) : undefined,
    });

    const response = await handler(fetchReq);
    const resHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    res.writeHead(response.status, resHeaders);
    const body = await response.text();
    res.end(body);
  });

  const { getCommandRuntime } = await import('../core/commands.ts');
  const runtime = getCommandRuntime(existingCommand);

  return new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      runtime.error(`REST server listening on http://${host}:${port}${basePath}`);
      const builtins = { health: true, help: true, schema: true, docs: true, ...prefs?.builtins };
      if (builtins.docs) runtime.error(`API docs: http://${host}:${port}${basePath}_docs`);
    });
    server.on('error', reject);
    const unsubscribe = runtime.onSignal?.(() => {
      server.close(() => resolve());
    });
    server.on('close', () => unsubscribe?.());
  });
}

/** Read the full body from a Node.js IncomingMessage. */
async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return readStreamAsText(req as AsyncIterable<Uint8Array>);
}
