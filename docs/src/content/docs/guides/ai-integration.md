---
title: AI Integration
description: Expose your CLI as an AI tool with MCP or Vercel AI SDK
---

Padrone provides three ways to expose your CLI to AI assistants and external services:

1. **[Model Context Protocol (MCP)](#model-context-protocol-mcp)** *(experimental)* — Standard protocol supported by Claude, Cursor, Windsurf, and other AI tools. Works over HTTP or stdio.
2. **[REST Server](#rest-server)** *(experimental)* — HTTP endpoints with OpenAPI docs. Each command becomes a route.
3. **[Vercel AI SDK](#vercel-ai-sdk)** — Programmatic integration for building AI-powered applications.

## Model Context Protocol (MCP) *(experimental)*

> **Experimental**: This API is experimental and may change in future releases.

The [Model Context Protocol](https://modelcontextprotocol.io/) is an open standard that lets AI assistants discover and use your CLI commands as tools. Padrone implements the [2025-11-25 MCP spec](https://modelcontextprotocol.io/specification/2025-11-25) with Streamable HTTP and stdio transports.

### Quick Start

Add the `mcp` command with the `padroneMcp()` extension from `padrone/mcp`:

```typescript
import { createPadrone } from 'padrone';
import { padroneMcp } from 'padrone/mcp';

const program = createPadrone('myapp').extend(padroneMcp());
```

```bash
# Start an MCP server over HTTP (default)
myapp mcp

# Start over stdio (for local tool integration)
myapp mcp stdio

# Custom port and host
myapp mcp --port 8080 --host 0.0.0.0
```

### How It Works

When you run `myapp mcp`, Padrone:

1. Collects all commands that have an action or schema, except hidden and built-in ones (`config`, `alias`, `upgrade`, …) and those not exposed to it (see [Securing Remote Access](#securing-remote-access))
2. Exposes each as an MCP tool with a JSON Schema derived from your Zod definitions, named by its path (`db.migrate`); a root command with an action is named after the program
3. Handles the JSON-RPC protocol (initialize, tools/list, tools/call, ping, etc.), with a session per client over HTTP
4. Adds a `help` tool that returns the program's or a command's help (named `padrone_help` when a command is already called `help`)

A tool call's result holds what the command printed (`runtime.output`, `ctx.context.output.*`) and its return value (as JSON unless it's a string). When the return value is an object, it's also sent as `structuredContent`. Errors and validation failures come back as a result with `isError: true`.

Declare the shape of that object with `outputSchema`, and it's advertised as the tool's `outputSchema` in `tools/list` (MCP only allows object schemas; others are left out). It documents the result and isn't checked at runtime:

```typescript
.command('status', (c) =>
  c
    .configure({ outputSchema: z.object({ healthy: z.boolean(), uptime: z.number() }) })
    .action(() => ({ healthy: true, uptime: process.uptime() }))
)
```

For example, a CLI with `greet` and `deploy` commands becomes two MCP tools that AI assistants can discover and call.

### Programmatic Usage

You can also start the MCP server from code:

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('myapp')
  .configure({ version: '1.0.0' })
  .command('greet', (c) =>
    c
      .arguments(z.object({ name: z.string().describe('Name to greet') }), { positional: ['name'] })
      .action((args) => `Hello, ${args.name}!`)
  );

// Start MCP server programmatically
await program.mcp({ port: 3000, host: '127.0.0.1' });
```

### Configuration

The `.mcp()` method, `padroneMcp(defaults)` and the `mcp` command accept these options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | `'http' \| 'stdio'` | `'http'` | Transport mode |
| `port` | `number` | `3000` | HTTP port |
| `host` | `string` | `'127.0.0.1'` | HTTP host |
| `basePath` | `string` | `'/mcp'` | HTTP endpoint path |
| `name` | `string` | program name | Server name |
| `version` | `string` | program version | Server version |
| `cors` | `string \| false` | `'*'` | CORS allowed origin, or `false` to disable. Also the origin allowed past the `Origin` check (below) |
| `maxBodySize` | `number` | 4 MiB | Largest request body in bytes; a larger one gets 413 |
| `include` | `string[] \| (command) => boolean` | — | Only offer these commands (paths or globs, see below) |
| `exclude` | `string[] \| (command) => boolean` | — | Never offer these commands |
| `auth` | `(req: Request) => unknown` | — | Authenticate each request: the identity, or a falsy value for 401 |
| `bearer` | `string \| string[]` | — | Accepted bearer tokens |
| `allowedHosts` | `string[] \| true \| 'all'` | — | `Host` names answered besides loopback ones and the bound host |
| `timeout` | `number` | — | Longest a command may run, in ms |
| `maxConcurrent` | `number` | — | Most commands running at once |
| `sessionTtl` | `number` | — | Drop an HTTP session after this many ms without requests |
| `maxSessions` | `number` | `1000` | Most HTTP sessions kept; a new one drops the least recently used |

### Transports

**Streamable HTTP** (default) — Starts an HTTP server. Responds with `application/json` or `text/event-stream` (SSE) based on the client's `Accept` header, per the MCP spec. Includes session management with `MCP-Session-Id` headers. Protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26` are accepted; JSON-RPC batches are rejected, as the spec no longer has them. A `DELETE` request ends a session and aborts its tool calls still in flight (through `ctx.signal`).

To guard against DNS rebinding, a request with an `Origin` header (which browsers send) is rejected with 403 unless the origin is a loopback one (`http://localhost:5173`, `http://127.0.0.1`, `http://[::1]:8080`) or the one set with `cors`. Setting `cors: '*'` explicitly allows any origin; the default only sends the `*` CORS header. Clients that aren't browsers send no `Origin` and aren't affected. When bound to a loopback host, a request whose `Host` header isn't a loopback name is rejected with 403 too.

```typescript
// A web app on another origin may call the server
await program.mcp({ cors: 'https://app.example.com' });
```

**stdio** — Communicates over stdin/stdout with newline-delimited JSON. Use this when the AI tool launches your CLI as a subprocess (e.g., Claude Desktop, `mcp-cli`).

The `mcp` command is hidden from help. Leave out `padroneMcp()` to go without it; `program.mcp()` works either way.

### Tool Naming

Commands are exposed as MCP tools using dot-separated names: `nested.sub` for a subcommand `sub` under `nested`. This follows the MCP tool naming spec (`[A-Za-z0-9_\-\.]`).

### Tips for AI Readability

Use `.describe()` on your Zod fields and `.configure({ description })` on commands — these become the tool descriptions that AI models read to understand your CLI.

---

## REST Server *(experimental)*

> **Experimental**: This API is experimental and may change in future releases.

Padrone can expose your CLI as a REST API with automatic OpenAPI documentation. Each command becomes an HTTP endpoint.

### Quick Start

Add the `serve` command with the `padroneServe()` extension from `padrone/serve`:

```typescript
import { createPadrone } from 'padrone';
import { padroneServe } from 'padrone/serve';

const program = createPadrone('myapp').extend(padroneServe());
```

```bash
# Start a REST server (default port 3000)
myapp serve

# Custom port and host
myapp serve --port 8080 --host 0.0.0.0

# Custom base path
myapp serve --base-path /api/
```

### How It Works

When you run `myapp serve`, Padrone:

1. Collects all commands that have an action or schema, except hidden and built-in ones (`config`, `alias`, `upgrade`, …) and those not exposed to it (see [Securing Remote Access](#securing-remote-access))
2. Maps each to a URL path (e.g., `users list` → `/users/list`)
3. For each request, converts query params (GET) or JSON body (POST) to CLI flags and calls `eval()`. Nested objects are passed as dotted query params (`?db.host=localhost`), repeated params fill arrays, `_` gives positional values, a param without a value is an empty string (`?name=`) or turns a boolean on (`?verbose`), and `null` in a JSON body means unset
4. Returns structured JSON responses

### Mutation Commands

Commands configured with `mutation: true` only accept POST requests. This is useful for commands that create, update, or delete data:

```typescript
const program = createPadrone('api')
  .command('users', (c) =>
    c
      .command('list', (c) =>
        c.action(() => db.users.findMany())
      )
      .command('create', (c) =>
        c
          .configure({ mutation: true })
          .arguments(z.object({ name: z.string(), email: z.string() }))
          .action((args) => db.users.create(args))
      )
  );

await program.serve({ port: 3000 });
// GET  /users/list                          → 200 OK
// POST /users/create { "name": "Alice" }    → 200 OK
// GET  /users/create?name=Alice             → 405 Method Not Allowed
```

The `mutation` flag also affects MCP (sets `annotations.destructiveHint`) and Vercel AI SDK (defaults `needsApproval` to `true`, see [Approval](#approval)).

### Sensitive Fields

Fields marked `sensitive: true` are `writeOnly` in the schemas, and can't be sent in a GET query string, where they'd end up in URLs and server logs: the server answers 400 for them (by name, alias, flag, dotted path, a whole object or array holding one, or `_` for a sensitive positional), and the OpenAPI spec leaves them out of the GET parameters. Send them in a POST body. A command with a required sensitive field has no GET operation in the spec.

```typescript
.command('login', (c) =>
  c
    .arguments(z.object({ user: z.string(), token: z.string() }), { fields: { token: { sensitive: true } } })
    .action((args) => signIn(args))
)
// GET  /login?user=alice&token=…           → 400 Bad Request
// POST /login { "user": "alice", "token": "…" } → 200 OK
```

### Programmatic Usage

```typescript
await program.serve({
  port: 3000,
  host: '127.0.0.1',
  basePath: '/api/',
  cors: 'https://example.com',
});
```

### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `3000` | HTTP port |
| `host` | `string` | `'127.0.0.1'` | HTTP host |
| `basePath` | `string` | `'/'` | Base path prefix for all routes |
| `cors` | `string \| false` | `'*'` | CORS allowed origin, or `false` to disable. Also the origin allowed past the `Origin` check (below) |
| `maxBodySize` | `number` | 4 MiB | Largest request body in bytes; a larger one gets 413 (`payload_too_large`) |
| `include` | `string[] \| (command) => boolean` | — | Only offer these commands (paths or globs, see below) |
| `exclude` | `string[] \| (command) => boolean` | — | Never offer these commands |
| `auth` | `(req: Request) => unknown` | — | Authenticate each request: the identity, or a falsy value for 401 |
| `bearer` | `string \| string[]` | — | Accepted bearer tokens |
| `allowedHosts` | `string[] \| true \| 'all'` | — | `Host` names answered besides loopback ones and the bound host |
| `timeout` | `number` | — | Longest a command may run, in ms |
| `maxConcurrent` | `number` | — | Most commands running at once |
| `builtins` | `object` | all `true` | Toggle built-in endpoints (health, help, schema, docs) |
| `onRequest` | `function` | — | Hook to run before each request (auth, rate-limiting) |
| `onError` | `function` | — | Custom error response handler |

Like MCP, a request with an `Origin` header is rejected with 403 unless the origin is a loopback one, the page's own (its host is the request's `Host`, like `/_docs` opened on a LAN address), or the one set with `cors` (`'*'` allows any), so other websites can't run commands. When bound to a loopback host, a request whose `Host` header isn't a loopback name is rejected with 403 (DNS rebinding).

### Built-in Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /_health` | Returns `{ status: "ok" }` |
| `GET /_help` | Program help (JSON or markdown based on Accept header) |
| `GET /_help/:path` | Command-specific help |
| `GET /_schema` | JSON Schema map of all commands |
| `GET /_schema/:path` | JSON Schema for a single command |
| `GET /_docs` | Interactive API documentation (powered by Scalar) |
| `GET /_openapi` | Raw OpenAPI 3.1.0 JSON spec |

### Response Format

**Success (200):** `output` holds what the command printed (`runtime.output`, `ctx.context.output.*`), `stderr` what it wrote to stderr (warnings, `padroneLogger()` logs), each left out when empty. Error responses carry `stderr` too, unless `onError` builds them. The OpenAPI `result` schema comes from `.configure({ outputSchema })`
```json
{ "ok": true, "result": <action return value>, "output": ["line printed by the command"], "stderr": ["[WARN] cache is stale"] }
```

**Validation error (400):**
```json
{ "ok": false, "error": "validation", "message": "Validation error: ...", "issues": [{ "path": ["name"], "message": "Required" }] }
```

**Bad request (400):** input the command can't take, such as an extra positional value, or a body that isn't a JSON object
```json
{ "ok": false, "error": "bad_request", "message": "Unexpected arguments for 'users': extra" }
```

**Not found (404):** no command at that path (or a path outside `basePath`)
```json
{ "ok": false, "error": "not_found", "message": "Command not found: users/update" }
```

**Action error (500):** the command threw
```json
{ "ok": false, "error": "action_error", "message": "Database unavailable" }
```

**Unauthorized (401), busy (503), timed out (504):** with `auth`/`bearer`, `maxConcurrent` and `timeout` (below)
```json
{ "ok": false, "error": "unauthorized", "message": "Unauthorized" }
{ "ok": false, "error": "unavailable", "message": "Too many requests in progress, try again later" }
{ "ok": false, "error": "timeout", "message": "The command timed out after 5000 ms" }
```

Validation errors go through `onError` when it's set. Arguments reach the command intact: strings with spaces or quotes, arrays (empty ones too, and items like `[x]`), nested objects (as `--a.b=`, or as JSON when dotted keys can't express them: record keys with dots, arrays inside, empty objects), arrays of objects (as JSON) and `false` for booleans with a custom `negative` keyword or none. An empty POST body means no arguments. Serve, MCP and `tool()` callers can't pick a config file: `--config`/`-c` is an unknown option for them, so they can't make the server read local files. The `config`, `alias`, `completion`, `man`, `serve`, `mcp` and `upgrade` commands refuse them ("… is only available on the command line").

The `serve` command is hidden from help. Leave out `padroneServe()` to go without it; `program.serve()` works either way.

---

## Securing Remote Access

These apply to both `mcp()` and `serve()` (and `padroneMcp()`/`padroneServe()` defaults). For MCP, `auth`, `bearer` and `allowedHosts` apply to the HTTP transport.

### Choosing what's exposed

`.configure({ expose })` says which callers may run a command (and its subcommands, unless they set their own): `true` any (the default), `false` local ones only (`cli`, `eval`, `run`, `repl`), or the callers allowed. Servers don't list a command they can't run, and running it from another caller (a `tool()` call included) fails with `"admin reset" is only available on the command line`. Built-in commands that act on the host (`config`, `alias`, `plugins`, `upgrade`, `completion`, `man`, `serve`, `mcp`) are local only; `help` and `version` stay available.

```typescript
.command('admin', (c) =>
  c
    .configure({ expose: false })                               // not over serve, MCP or tool()
    .command('reset', (c) => c.action(() => resetEverything()))
    .command('status', (c) => c.configure({ expose: true }).action(() => status())),
)
.command('ask', (c) => c.configure({ expose: ['cli', 'mcp'] }).action(/* … */)) // MCP, not serve
```

`include` and `exclude` choose commands per server: command paths (`'db migrate'` or `'db.migrate'`) and globs over them (`*` within a name, `**` any number of names: `'db.**'` is `db` and everything under it, `'**'` also the root program), or a predicate of the command.

```typescript
await program.mcp({ include: ['db.**', 'status'], exclude: ['db drop'] });
await program.serve({ include: (command) => !command.mutation });
```

### Authentication

`bearer` accepts `Authorization: Bearer <token>` requests with one of the tokens (compared in constant time); `auth` runs your own check on the `Request` and returns who made it. A refused request gets 401 (serve: `{ "error": "unauthorized" }`; MCP: a JSON-RPC error), with `WWW-Authenticate: Bearer` for bearer tokens and MCP. The identity reaches actions, hooks and interceptors as `ctx.auth` (`{ token }` with `bearer`; the `auth` result when it's set, which runs after the token check). Serve's `/_health` and CORS preflights don't authenticate.

```typescript
await program.serve({ bearer: process.env.API_TOKEN! });

await program.mcp({
  auth: async (req) => verifySession(req.headers.get('authorization')), // a user, or undefined for 401
});

.command('whoami', (c) => c.action((_args, ctx) => ctx.auth))
```

`eval()` and `cli()` take an `auth` preference too, which becomes `ctx.auth`.

### Host names

Bound to a loopback host (the default), the servers only answer requests whose `Host` is a loopback name, against DNS rebinding. `allowedHosts` lists more names (`.example.com` covers its subdomains) and applies the check to any binding; the bound host always passes, and `true` or `'all'` turns the check off.

```typescript
await program.serve({ host: '0.0.0.0', allowedHosts: ['api.example.com', '.internal.example.com'] });
```

### Limits

`timeout` (ms) aborts a command's `ctx.signal` with a `TimeoutError` and fails the request (serve: 504; MCP: JSON-RPC error `-32001`); `maxConcurrent` refuses a request while that many commands are running (serve: 503 with `Retry-After`; MCP: `-32000`). A command that ignores its signal keeps its slot until it ends. MCP HTTP sessions are dropped after `sessionTtl` ms without requests (calls in flight keep them alive) and, past `maxSessions` (default 1000), least recently used first; their calls are aborted and the client gets 404, which tells it to start a new session.

```typescript
await program.mcp({ timeout: 30_000, maxConcurrent: 8, sessionTtl: 30 * 60_000 });
```

---

## Vercel AI SDK

Padrone provides first-class support for the [Vercel AI SDK](https://ai-sdk.dev/), allowing you to expose your CLI commands as tools that AI models can use.

### Overview

The `.tool()` method converts your Padrone program into a Vercel AI SDK compatible tool. This lets AI assistants:

- Understand your CLI's capabilities through the schema
- Execute commands with proper type validation
- Receive structured responses

### Basic Setup

```typescript
import { streamText } from 'ai';
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

// Define your CLI
const weatherCli = createPadrone('weather')
  .command('current', (c) =>
    c
      .configure({ description: 'Get current weather for a city' })
      .arguments(
        z.object({
          city: z.string().describe('City name'),
          units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
        }),
        { positional: ['city'] }
      )
      .action(async (args) => {
        // Fetch weather data...
        return {
          city: args.city,
          temperature: 22,
          units: args.units,
          condition: 'Sunny',
        };
      })
  )
  .command('forecast', (c) =>
    c
      .configure({ description: 'Get weather forecast' })
      .arguments(
        z.object({
          city: z.string().describe('City name'),
          days: z.number().default(3).describe('Number of days'),
        }),
        { positional: ['city'] }
      )
      .action(async (args) => {
        return {
          city: args.city,
          forecast: [
            { day: 'Mon', temp: 22 },
            { day: 'Tue', temp: 24 },
            { day: 'Wed', temp: 20 },
          ].slice(0, args.days),
        };
      })
  );

// Convert to AI tool
const weatherTool = weatherCli.tool();
```

### Using with AI Models

Pass the tool to any Vercel AI SDK function:

```typescript
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const result = await streamText({
  model: anthropic('claude-sonnet-4-20250514'),
  prompt: "What's the weather like in London?",
  tools: {
    weather: weatherTool,
  },
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

The AI model will:
1. Understand the available commands from the tool schema
2. Choose the appropriate command (`weather current`)
3. Provide the required args (`city: 'London'`)
4. Execute the command and use the response

### Return Values

Your action handlers should return data that the AI can use:

```typescript
.action(async (args) => {
  // Return structured data for the AI
  return {
    status: 'success',
    data: { /* ... */ },
  };
})
```

The tool returns `{ result, logs, error }` to the AI model: `result` is the action's return value, `logs` what the command printed (`runtime.output`, `ctx.context.output.*`, and its stderr when it succeeded), and `error` the error message, after what it wrote to stderr, when the command failed, its arguments didn't validate, or the command doesn't exist. The AI SDK's `abortSignal` cancels the command through `ctx.signal`.

`tool({ timeout })` aborts a call that runs longer (in ms): the command's signal is aborted and the model gets `Timed out after 30000 ms` in `error`. Commands with `expose` that leaves out `tool` fail with an error the model reads.

```typescript
const weatherTool = weatherCli.tool({ timeout: 30_000 });
```

### Approval

`tool()` sets the AI SDK's `needsApproval`, so the user confirms a call before it runs. It defaults to the command's `mutation` flag; set `needsApproval` to override it, as a boolean or a function of the validated args. Put `.configure()` after `.arguments()` so the args are typed. When the args don't validate, approval is asked without calling the function, and a dry run (`--dry-run`) never needs approval.

```typescript
.command('delete', (c) =>
  c
    .arguments(z.object({ id: z.string(), force: z.boolean().optional() }))
    .configure({ needsApproval: (args) => !!args.force })
    .action((args) => remove(args.id, args.force))
)
```

### Multiple Tools

You can provide multiple Padrone CLIs as separate tools:

```typescript
const weatherCli = createPadrone('weather').command(/* ... */);
const calendarCli = createPadrone('calendar').command(/* ... */);
const notesCli = createPadrone('notes').command(/* ... */);

const result = await streamText({
  model: yourModel,
  prompt: "Check the weather in Paris and add it to my calendar",
  tools: {
    weather: weatherCli.tool(),
    calendar: calendarCli.tool(),
    notes: notesCli.tool(),
  },
});
```

### Tool Schema

The tool takes a single `command` string (`"weather current London --units fahrenheit"`), and its description holds the program's help. The model reads a command's arguments with `help <command>`, so the descriptions you provide with `.describe()` help it understand how to use each one:

```typescript
z.object({
  city: z.string().describe('The name of the city to get weather for'),
  units: z.enum(['celsius', 'fahrenheit'])
    .default('celsius')
    .describe('Temperature units (celsius or fahrenheit)'),
})
```

Good descriptions improve AI accuracy when selecting and using your tools.

### Error Handling

Handle errors gracefully so the AI can respond appropriately:

```typescript
.action(async (args) => {
  try {
    const data = await fetchWeather(args.city);
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: `Could not fetch weather for ${args.city}`,
    };
  }
})
```

### Real-World Example

Here's a complete example of a task management CLI exposed as an AI tool:

```typescript
import { streamText } from 'ai';
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const tasks = createPadrone('tasks')
  .command('add', (c) =>
    c
      .configure({ description: 'Add a new task' })
      .arguments(
        z.object({
          title: z.string().describe('Task title'),
          priority: z.enum(['low', 'medium', 'high']).default('medium'),
          dueDate: z.string().optional().describe('Due date (YYYY-MM-DD)'),
        }),
        { positional: ['title'] }
      )
      .action((args) => {
        // Save task to database...
        return { id: 'task-1', ...args, status: 'created' };
      })
  )
  .command('list', (c) =>
    c
      .configure({ description: 'List all tasks' })
      .arguments(
        z.object({
          status: z.enum(['all', 'pending', 'completed']).default('all'),
        })
      )
      .action((args) => {
        // Fetch from database...
        return {
          tasks: [
            { id: '1', title: 'Buy groceries', status: 'pending' },
            { id: '2', title: 'Call mom', status: 'completed' },
          ],
        };
      })
  )
  .command('complete', (c) =>
    c
      .configure({ description: 'Mark a task as completed' })
      .arguments(
        z.object({
          id: z.string().describe('Task ID'),
        }),
        { positional: ['id'] }
      )
      .action((args) => {
        return { id: args.id, status: 'completed' };
      })
  );

// Use with AI
const result = await streamText({
  model: yourModel,
  prompt: "Add a high priority task to buy milk, then show me all my tasks",
  tools: {
    tasks: tasks.tool(),
  },
  maxSteps: 5, // Allow multiple tool calls
});
```

### Compatibility

Padrone's AI integration requires:
- Vercel AI SDK 5.x or 6.x (peer dependency)
- Zod 3.25+ or 4.x

Install the AI SDK if you haven't already:

```bash
npm install ai @ai-sdk/anthropic
# or your preferred AI provider
```
