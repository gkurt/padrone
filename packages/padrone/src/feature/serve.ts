import { extractSchemaMetadata, parsePositionalConfig } from '../core/args.ts';
import {
  buildInputSchema,
  buildOutputSchema,
  type CollectedEndpoint,
  collectEndpoints,
  getGlobalArgs,
  isAllowedHost,
  isAllowedOrigin,
  serializeArgsToFlags,
} from '../core/commands.ts';
import { RoutingError, ValidationError } from '../core/errors.ts';
import { formatIssueMessages } from '../core/validate.ts';
import { generateHelp } from '../output/help.ts';
import type { AnyPadroneCommand, AnyPadroneProgram } from '../types/index.ts';
import { outputValueToText } from '../util/json.ts';
import { BodyTooLargeError, readBodyText } from '../util/stream.ts';
import {
  createAuthenticator,
  createCallLimiter,
  createCommandFilter,
  createOfferedView,
  linkedController,
  type PadroneRemotePreferences,
  serverBaseUrl,
  toFetchHeaders,
} from './remote.ts';

export type PadroneServePreferences = PadroneRemotePreferences & {
  /** Port to listen on. Default: 3000 */
  port?: number;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Base path prefix for all routes. Default: '/' */
  basePath?: string;
  /**
   * CORS allowed origin. Default: '*'. Set to `false` to disable CORS headers.
   * Requests with an `Origin` header are rejected (403) unless it's a loopback origin (`localhost`, `127.0.0.1`, `[::1]`)
   * or the origin set here (`'*'` set explicitly allows any).
   */
  cors?: string | false;
  /** Largest request body accepted, in bytes; a larger one gets a 413. Default: 4 MiB. */
  maxBodySize?: number;
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

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Normalizes a base path to start and end with `/` (`api` → `/api/`). */
/** A page served by this server itself (the docs, opened on a LAN address): its origin names the request's own host. */
function isSameOrigin(origin: string, req: Request): boolean {
  try {
    return new URL(origin).host === (req.headers.get('host') ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

function normalizeBasePath(basePath = '/'): string {
  return `/${basePath}/`.replace(/\/{2,}/g, '/');
}

/** The error response, with what the command wrote to stderr (left out when it wrote nothing). */
function errorToResponse(error: unknown, stderr: string[] = []): Response {
  // The route was already matched, so a routing error here means bad input (e.g. an extra positional value)
  const status = error instanceof ValidationError || error instanceof RoutingError ? 400 : 500;
  const logs = stderr.length > 0 ? { stderr } : {};
  if (error instanceof ValidationError) {
    return jsonResponse(
      {
        ok: false,
        error: 'validation',
        message: error.message,
        issues: error.issues.map((i) => ({ path: i.path?.map(String), message: i.message })),
        ...logs,
      },
      status,
    );
  }
  if (error instanceof RoutingError) {
    return jsonResponse({ ok: false, error: 'bad_request', message: error.message, suggestions: error.suggestions, ...logs }, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ ok: false, error: 'action_error', message, ...logs }, status);
}

const stderrSchema = { type: 'array', items: { type: 'string' }, description: 'Lines the command wrote to stderr' };

/** Generate an OpenAPI 3.1.0 spec from the command tree. */
function buildOpenApiSpec(
  existingCommand: AnyPadroneCommand,
  endpoints: CollectedEndpoint[],
  basePath: string,
  bearer: boolean,
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  const responses = (resultSchema: Record<string, unknown> = {}) => ({
    '200': {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean', const: true },
              result: resultSchema,
              output: { type: 'array', items: { type: 'string' }, description: 'Lines the command printed' },
              stderr: stderrSchema,
            },
          },
        },
      },
    },
    '400': {
      description: 'Validation error or bad request',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean', const: false },
              error: { type: 'string', enum: ['validation', 'bad_request'] },
              message: { type: 'string' },
              issues: { type: 'array', items: { type: 'object', properties: { path: { type: 'array' }, message: { type: 'string' } } } },
              stderr: stderrSchema,
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
              stderr: stderrSchema,
            },
          },
        },
      },
    },
  });

  for (const { name, command: cmd } of endpoints) {
    const urlPath = `${basePath}${toUrlPath(name)}`;
    const inputSchema = buildInputSchema(cmd);
    const description = cmd.description || cmd.title || `Run the "${name}" command`;
    const pathItem: Record<string, unknown> = {};
    const responseSchema = responses(buildOutputSchema(cmd));

    // GET: args as query parameters, unless the command is a mutation or needs a sensitive field
    const queryParams = cmd.mutation ? undefined : toQueryParameters(inputSchema);
    if (queryParams) {
      pathItem.get = {
        summary: cmd.title || name,
        description,
        operationId: `get_${name.replace(/\./g, '_')}`,
        parameters: queryParams,
        responses: responseSchema,
      };
    }
    pathItem.post = {
      summary: cmd.title || name,
      description,
      operationId: `post_${name.replace(/\./g, '_')}`,
      requestBody: { content: { 'application/json': { schema: inputSchema } } },
      responses: responseSchema,
    };

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
    ...(bearer && { components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, security: [{ bearer: [] }] }),
  };
}

type JsonSchemaObject = Record<string, unknown> & { properties?: Record<string, JsonSchemaObject>; required?: string[] };

/**
 * GET query parameters for an input schema: nested objects become dotted names (`db.host`), which is what the server parses.
 * Sensitive (`writeOnly`) fields are left out, as the server rejects them in query strings; `undefined` when one is required.
 */
function toQueryParameters(schema: JsonSchemaObject, prefix = '', parentRequired = true): Record<string, unknown>[] | undefined {
  const params: Record<string, unknown>[] = [];
  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    const name = `${prefix}${key}`;
    const required = parentRequired && (schema.required?.includes(key) ?? false);
    const leaf = propSchema.type !== 'object' || !propSchema.properties;
    if (propSchema.writeOnly || (leaf && containsSensitive(propSchema))) {
      if (required) return undefined;
      continue;
    }
    if (leaf) {
      params.push({ name, in: 'query', schema: propSchema, required });
      continue;
    }
    const nested = toQueryParameters(propSchema, `${name}.`, required);
    if (!nested) return undefined;
    params.push(...nested);
  }
  return params;
}

/** Whether a JSON schema is, or has somewhere inside (properties, array items, unions), a sensitive field. */
function containsSensitive(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const node = schema as JsonSchemaObject;
  if (node.writeOnly || node.sensitive === true) return true;
  const children = [...Object.values(node.properties ?? {}), node.items, ...['anyOf', 'oneOf', 'allOf'].flatMap((key) => node[key] ?? [])];
  return children.some(containsSensitive);
}

/**
 * Whether a query key sets a sensitive (`writeOnly`) field, whose value would end up in URLs and logs: option names,
 * aliases and flags, dotted paths into nested objects, and `_` when a positional is sensitive.
 */
function createSensitiveQueryCheck(cmd: AnyPadroneCommand, inputSchema: JsonSchemaObject): (key: string) => boolean {
  const names: Record<string, string> = {};
  const globals = getGlobalArgs(cmd);
  for (const [schema, meta] of [
    [globals?.schema, globals?.meta],
    [cmd.argsSchema, cmd.meta],
  ] as const) {
    if (!schema) continue;
    const { flags, aliases } = extractSchemaMetadata(schema, meta?.fields, meta?.autoAlias);
    Object.assign(names, flags, aliases);
  }
  const isSensitivePath = (path: string[]) => {
    let node: JsonSchemaObject | undefined = inputSchema;
    for (const part of path) {
      node = node?.properties && Object.hasOwn(node.properties, part) ? node.properties[part] : undefined;
      if (node?.writeOnly) return true;
    }
    // A whole object (`?db={"password":…}`) holding a sensitive value
    return containsSensitive(node);
  };
  const positionals = parsePositionalConfig(cmd.meta?.positional ?? []);
  return (key) => {
    if (key === '_') return positionals.some(({ name }) => isSensitivePath([name]));
    const [first = '', ...rest] = key.split('.');
    return isSensitivePath([Object.hasOwn(names, first) ? names[first]! : first, ...rest]);
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
  const basePath = normalizeBasePath(prefs?.basePath);
  const corsOrigin = prefs?.cors !== false ? (prefs?.cors ?? '*') : undefined;
  const builtins = { health: true, help: true, schema: true, docs: true, ...prefs?.builtins };

  const endpoints = collectEndpoints(existingCommand, 'serve', createCommandFilter(prefs));
  const authenticate = createAuthenticator(prefs);
  const limit = createCallLimiter(prefs);
  const helpView = createOfferedView(existingCommand, endpoints, 'serve');

  const routeMap = new Map<string, CollectedEndpoint>();
  for (const ep of endpoints) {
    routeMap.set(toUrlPath(ep.name), ep);
  }

  let cachedOpenApiSpec: Record<string, unknown> | undefined;
  const getOpenApiSpec = () => (cachedOpenApiSpec ??= buildOpenApiSpec(existingCommand, endpoints, basePath, prefs?.bearer !== undefined));

  function addCorsHeaders(res: Response): Response {
    if (!corsOrigin) return res;
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  const handleError = (error: unknown, request: Request, stderr?: string[]) =>
    prefs?.onError ? prefs.onError(error, request) : errorToResponse(error, stderr);

  async function evalAndRespond(input: string[], request: Request, auth: unknown): Promise<Response> {
    const output: string[] = [];
    const errors: string[] = [];
    // Aborts the command when the client disconnects, or after `timeout`
    const { controller, dispose } = linkedController(request.signal);
    const call = await limit(controller, () =>
      evalCommand(input.length ? input : (undefined as any), {
        caller: 'serve',
        signal: controller.signal,
        auth,
        context: prefs?.context,
        runtime: {
          output: (...args: unknown[]) => output.push(args.map(outputValueToText).join(' ')),
          error: (text: string) => errors.push(text),
          interactive: 'unsupported',
          format: 'json',
        },
      }),
    ).finally(dispose);
    if (call.status === 'busy') {
      const message = 'Too many requests in progress, try again later';
      return jsonResponse({ ok: false, error: 'unavailable', message }, 503, { 'Retry-After': '1' });
    }
    if (call.status === 'timeout') {
      const message = `The command timed out after ${prefs?.timeout} ms`;
      return jsonResponse({ ok: false, error: 'timeout', message, ...(errors.length > 0 && { stderr: errors }) }, 504);
    }
    const result = call.value;

    if (result.error) return handleError(result.error, request, errors);

    if (result.argsResult?.issues) {
      const { issues } = result.argsResult;
      return handleError(new ValidationError(`Validation error:\n${formatIssueMessages(issues)}`, issues as any), request, errors);
    }

    // Printed output (`runtime.output`, `ctx.context.output.*`) and stderr (warnings, logs) are returned alongside the result
    return jsonResponse({
      ok: true,
      result: result.result ?? null,
      ...(output.length > 0 && { output }),
      ...(errors.length > 0 && { stderr: errors }),
    });
  }

  /** The route of a request path, without `basePath` and the slashes around it; `undefined` when it's outside `basePath`. */
  function routePathOf(pathname: string): string | undefined {
    if (basePath !== '/') {
      if (pathname !== basePath.slice(0, -1) && !pathname.startsWith(basePath)) return undefined;
      pathname = pathname.slice(basePath.length - 1);
    }
    return pathname.replace(/^\/+|\/+$/g, '');
  }

  return async function handleRequest(req: Request): Promise<Response> {
    try {
      return await routeRequest(req);
    } catch (error) {
      try {
        return addCorsHeaders(handleError(error, req));
      } catch (handlerError) {
        return addCorsHeaders(errorToResponse(handlerError));
      }
    }
  };

  async function routeRequest(req: Request): Promise<Response> {
    // Other websites could otherwise run commands with "simple" requests, which browsers send without a preflight
    const origin = req.headers.get('origin');
    if (origin && !isSameOrigin(origin, req) && !isAllowedOrigin(origin, prefs?.cors)) {
      return addCorsHeaders(jsonResponse({ ok: false, error: 'forbidden', message: `Origin not allowed: ${origin}` }, 403));
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return addCorsHeaders(new Response(null, { status: corsOrigin ? 204 : 405 }));
    }

    const url = new URL(req.url, 'http://localhost');
    const routePath = routePathOf(url.pathname);

    // Health checks (load balancers, probes) don't authenticate
    let auth: unknown;
    if (authenticate && !(builtins.health && req.method === 'GET' && routePath === '_health')) {
      auth = await authenticate(req);
      if (!auth) {
        const headers = prefs?.bearer !== undefined ? { 'WWW-Authenticate': 'Bearer' } : undefined;
        return addCorsHeaders(jsonResponse({ ok: false, error: 'unauthorized', message: 'Unauthorized' }, 401, headers));
      }
    }

    // onRequest hook
    if (prefs?.onRequest) {
      const hookResponse = await prefs.onRequest(req);
      if (hookResponse) return addCorsHeaders(hookResponse);
    }

    // Anything outside basePath isn't ours
    if (routePath === undefined) {
      return addCorsHeaders(jsonResponse({ ok: false, error: 'not_found', message: `Not found: ${url.pathname}` }, 404));
    }

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
        const helpText = generateHelp(helpView.root, helpView.root, { format, detail: 'full' });
        if (format === 'json') return addCorsHeaders(jsonResponse(JSON.parse(helpText)));
        return addCorsHeaders(new Response(helpText, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
      }

      if (builtins.help && routePath.startsWith('_help/')) {
        const cmdPath = routePath.slice('_help/'.length);
        const ep = routeMap.get(cmdPath);
        if (!ep) return addCorsHeaders(jsonResponse({ ok: false, error: 'not_found', message: `Command not found: ${cmdPath}` }, 404));
        const accept = req.headers.get('accept') ?? '';
        const format = accept.includes('application/json') ? 'json' : 'markdown';
        const helpText = generateHelp(helpView.root, helpView.of(ep.command), { format, detail: 'full' });
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

    // Args are passed as argv tokens, so values with spaces or quotes arrive intact
    const commandPath = routePath.split('/').filter(Boolean);
    let argParts: string[];

    if (req.method === 'POST') {
      let body: unknown;
      try {
        const text = await readBodyText(
          req.body as AsyncIterable<Uint8Array> | null,
          req.headers.get('content-length'),
          prefs?.maxBodySize,
        );
        body = text.trim() ? JSON.parse(text) : {};
      } catch (error) {
        if (error instanceof BodyTooLargeError)
          return addCorsHeaders(jsonResponse({ ok: false, error: 'payload_too_large', message: error.message }, 413));
        return addCorsHeaders(jsonResponse({ ok: false, error: 'bad_request', message: 'Invalid JSON body' }, 400));
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return addCorsHeaders(jsonResponse({ ok: false, error: 'bad_request', message: 'The JSON body must be an object' }, 400));
      }
      argParts = serializeArgsToFlags(body as Record<string, unknown>, endpoint.command);
    } else {
      // GET: query string → flags, `_` → positional values (after `--`, so values starting with `-` stay values).
      // Without a value, a field that isn't a boolean gets an empty one; anything else (`?verbose`, `?help`) is a flag.
      argParts = [];
      const positionals: string[] = [];
      const inputSchema = buildInputSchema(endpoint.command) as JsonSchemaObject;
      const isSensitive = createSensitiveQueryCheck(endpoint.command, inputSchema);
      const sensitiveKey = [...url.searchParams.keys()].find(isSensitive);
      if (sensitiveKey !== undefined) {
        const message = `"${sensitiveKey}" is sensitive: send it in a POST body, not the query string`;
        return addCorsHeaders(jsonResponse({ ok: false, error: 'bad_request', message }, 400));
      }
      const needsValue = (key: string) => {
        const field = key.split('.').reduce<JsonSchemaObject | undefined>((schema, part) => schema?.properties?.[part], inputSchema);
        const types = [field?.type, ...((field?.anyOf as JsonSchemaObject[] | undefined) ?? []).map((s) => s.type)];
        return !!field && !types.includes('boolean');
      };
      for (const [key, value] of url.searchParams.entries()) {
        if (key === '_') positionals.push(value);
        else argParts.push(value !== '' || needsValue(key) ? `--${key}=${value}` : `--${key}`);
      }
      if (positionals.length) argParts.push('--', ...positionals);
    }

    const response = await evalAndRespond([...commandPath, ...argParts], req, auth);
    return addCorsHeaders(response);
  }
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
  const basePath = normalizeBasePath(prefs?.basePath);

  let baseUrl = serverBaseUrl(host, port);
  const server = http.createServer(async (req, res) => {
    if (!isAllowedHost(req.headers.host, host, prefs?.allowedHosts)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ ok: false, error: 'forbidden', message: `Host not allowed: ${req.headers.host}` }));
    }
    // The request target is a path
    const url = `${baseUrl}${req.url ?? '/'}`;
    const headers = toFetchHeaders(req.headers);

    const disconnected = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) disconnected.abort('Client disconnected');
    });
    try {
      const fetchReq = new Request(url, {
        method: req.method,
        headers,
        signal: disconnected.signal,
        body:
          req.method !== 'GET' && req.method !== 'HEAD'
            ? await readBodyText(req as AsyncIterable<Uint8Array>, req.headers['content-length'], prefs?.maxBodySize)
            : undefined,
      });

      const response = await handler(fetchReq);
      const resHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });
      res.writeHead(response.status, resHeaders);
      res.end(await response.text());
    } catch (error) {
      if (res.headersSent) return void res.end();
      const tooLarge = error instanceof BodyTooLargeError;
      res.writeHead(tooLarge ? 413 : 500, { 'Content-Type': 'application/json', ...(tooLarge && { Connection: 'close' }) });
      const message = error instanceof Error ? error.message : String(error);
      res.end(JSON.stringify({ ok: false, error: tooLarge ? 'payload_too_large' : 'server_error', message }));
    }
  });

  const { getCommandRuntime } = await import('../core/commands.ts');
  const runtime = getCommandRuntime(existingCommand);

  return new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      // The port it got, for port 0
      const address = server.address();
      baseUrl = serverBaseUrl(host, typeof address === 'object' && address ? address.port : port);
      runtime.error(`REST server listening on ${baseUrl}${basePath}`);
      const builtins = { health: true, help: true, schema: true, docs: true, ...prefs?.builtins };
      if (builtins.docs) runtime.error(`API docs: ${baseUrl}${basePath}_docs`);
    });
    server.on('error', reject);
    const unsubscribe = runtime.onSignal?.(() => {
      server.close(() => resolve());
    });
    server.on('close', () => unsubscribe?.());
  });
}
