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

1. Collects all non-hidden commands that have an action or schema
2. Exposes each as an MCP tool with a JSON Schema derived from your Zod definitions, named by its path (`db.migrate`); a root command with an action is named after the program
3. Handles the JSON-RPC protocol (initialize, tools/list, tools/call, ping, etc.), with a session per client over HTTP
4. Adds a `help` tool that returns the program's or a command's help (named `padrone_help` when a command is already called `help`)

A tool call's result holds what the command printed (`runtime.output`, `ctx.context.output.*`) and its return value (as JSON unless it's a string). Errors and validation failures come back as a result with `isError: true`.

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
| `cors` | `string \| false` | `'*'` | CORS allowed origin, or `false` to disable |

### Transports

**Streamable HTTP** (default) — Starts an HTTP server. Responds with `application/json` or `text/event-stream` (SSE) based on the client's `Accept` header, per the MCP spec. Includes session management with `MCP-Session-Id` headers. Protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26` are accepted; JSON-RPC batches are rejected, as the spec no longer has them.

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

1. Collects all non-hidden commands that have an action or schema
2. Maps each to a URL path (e.g., `users list` → `/users/list`)
3. For each request, converts query params (GET) or JSON body (POST) to CLI flags and calls `eval()`. Nested objects are passed as dotted query params (`?db.host=localhost`), repeated params fill arrays, `_` gives positional values, and `null` in a JSON body means unset
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

The `mutation` flag also affects MCP (sets `annotations.destructiveHint`) and Vercel AI SDK (defaults `needsApproval` to `true`).

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
| `cors` | `string \| false` | `'*'` | CORS allowed origin, or `false` to disable |
| `builtins` | `object` | all `true` | Toggle built-in endpoints (health, help, schema, docs) |
| `onRequest` | `function` | — | Hook to run before each request (auth, rate-limiting) |
| `onError` | `function` | — | Custom error response handler |

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

**Success (200):** `output` holds what the command printed (`runtime.output`, `ctx.context.output.*`) and is left out when it printed nothing
```json
{ "ok": true, "result": <action return value>, "output": ["line printed by the command"] }
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

Validation errors go through `onError` when it's set. Arguments reach the command intact: strings with spaces or quotes, arrays, nested objects (as `--a.b=`) and booleans with a custom `negative` keyword. An empty POST body means no arguments.

The `serve` command is hidden from help. Leave out `padroneServe()` to go without it; `program.serve()` works either way.

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

The tool returns `{ result, logs, error }` to the AI model: `result` is the action's return value, `logs` what the command printed (`runtime.output`, `ctx.context.output.*`), and `error` the error message when the command failed, its arguments didn't validate, or the command doesn't exist. The AI SDK's `abortSignal` cancels the command through `ctx.signal`.

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

The `.tool()` method generates a JSON schema from your Zod definitions. The descriptions you provide with `.describe()` help the AI understand how to use each argument:

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
