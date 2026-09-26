import { describe, expect, it } from 'bun:test';
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol } from '../src/core/commands.ts';
import { createMcpHandler } from '../src/feature/mcp.ts';

function getCommand(program: any) {
  return program[commandSymbol];
}

describe('mcp', () => {
  const program = createPadrone('test')
    .configure({ version: '1.0.0', description: 'Test program' })
    .command('greet', (c) =>
      c
        .configure({ title: 'Greeter', description: 'Greet someone' })
        .arguments(z.object({ name: z.string() }))
        .action((args) => `Hello, ${args.name}!`),
    )
    .command('add', (c) =>
      c
        .configure({ description: 'Add numbers' })
        .arguments(z.object({ a: z.coerce.number(), b: z.coerce.number() }))
        .action((args) => args.a + args.b),
    )
    .command('hidden', (c) => c.configure({ hidden: true }).action(() => 'secret'))
    .command('nested', (c) =>
      c.command('sub', (s) =>
        s
          .configure({ description: 'A nested subcommand' })
          .arguments(z.object({ value: z.string() }))
          .action((args) => args.value),
      ),
    );

  function createHandler(prefs?: { name?: string; version?: string }) {
    return createMcpHandler(getCommand(program), program.eval.bind(program) as any, prefs);
  }

  describe('initialize', () => {
    it('should respond with 2025-11-25 protocol version', async () => {
      const handler = createHandler();
      const res = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(res?.id).toBe(1);
      expect(res?.result).toEqual({
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'test', version: '1.0.0' },
      });
    });

    it('should use custom name and version from prefs', async () => {
      const handler = createHandler({ name: 'custom', version: '2.0.0' });
      const res = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect((res?.result as any).serverInfo).toEqual({ name: 'custom', version: '2.0.0' });
    });
  });

  describe('ping', () => {
    it('should respond with empty object', async () => {
      const handler = createHandler();
      const res = await handler({ jsonrpc: '2.0', id: 1, method: 'ping' });

      expect(res?.result).toEqual({});
    });
  });

  describe('notifications', () => {
    it('should return undefined for notifications/initialized', async () => {
      const handler = createHandler();
      const res = await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(res).toBeUndefined();
    });

    it('should return undefined for notifications/cancelled', async () => {
      const handler = createHandler();
      const res = await handler({ jsonrpc: '2.0', method: 'notifications/cancelled' });
      expect(res).toBeUndefined();
    });
  });

  describe('tools/list', () => {
    it('should list all non-hidden commands as tools with dot-separated names', async () => {
      const handler = createHandler();
      const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const tools = (res?.result as any).tools;
      const toolNames = tools.map((t: any) => t.name);

      expect(toolNames).toContain('greet');
      expect(toolNames).toContain('add');
      // Nested commands use dot separator per MCP tool naming rules
      expect(toolNames).toContain('nested.sub');
      expect(toolNames).not.toContain('hidden');
      // Built-in help tool
      expect(toolNames).toContain('help');
    });

    it('should include title, description and input schemas', async () => {
      const handler = createHandler();
      const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const tools = (res?.result as any).tools;
      const greetTool = tools.find((t: any) => t.name === 'greet');

      expect(greetTool.title).toBe('Greeter');
      expect(greetTool.description).toBe('Greet someone');
      expect(greetTool.inputSchema.type).toBe('object');
      expect(greetTool.inputSchema.properties).toHaveProperty('name');
    });

    it('should use empty strict schema for commands without arguments', async () => {
      const simpleProgram = createPadrone('simple').command('noop', (c) => c.action(() => 'done'));
      const handler = createMcpHandler(getCommand(simpleProgram), simpleProgram.eval.bind(simpleProgram) as any);
      const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const tools = (res?.result as any).tools;
      const noopTool = tools.find((t: any) => t.name === 'noop');
      expect(noopTool.inputSchema).toEqual({ type: 'object', additionalProperties: false });
    });
  });

  describe('tools/call', () => {
    it('should execute a command and return result with isError: false', async () => {
      const handler = createHandler();
      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'greet', arguments: { name: 'World' } },
      });

      const result = res?.result as any;
      expect(result.isError).toBe(false);
      const texts = result.content.map((c: any) => c.text);
      expect(texts.some((t: string) => t.includes('Hello, World!'))).toBe(true);
    });

    it('should execute a command with numeric args', async () => {
      const handler = createHandler();
      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'add', arguments: { a: 2, b: 3 } },
      });

      const result = res?.result as any;
      expect(result.isError).toBe(false);
      const texts = result.content.map((c: any) => c.text);
      expect(texts.some((t: string) => t.includes('5'))).toBe(true);
    });

    it('should execute nested subcommands via dot-separated name', async () => {
      const handler = createHandler();
      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'nested.sub', arguments: { value: 'test-value' } },
      });

      const result = res?.result as any;
      expect(result.isError).toBe(false);
      const texts = result.content.map((c: any) => c.text);
      expect(texts.some((t: string) => t.includes('test-value'))).toBe(true);
    });

    it('should return protocol error for unknown tool', async () => {
      const handler = createHandler();
      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'nonexistent', arguments: {} },
      });

      // Per spec: unknown tools are protocol errors (JSON-RPC error), not tool execution errors
      expect(res?.error).toBeDefined();
      expect(res?.error?.code).toBe(-32602);
      expect(res?.error?.message).toContain('Unknown tool');
    });

    it('should return tool execution error for validation failures', async () => {
      const handler = createHandler();
      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'greet', arguments: {} },
      });

      const result = res?.result as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Validation error');
    });

    it('should handle boolean args', async () => {
      const boolProgram = createPadrone('bool').command('cmd', (c) =>
        c.arguments(z.object({ verbose: z.boolean().default(false) })).action((args) => (args.verbose ? 'verbose' : 'quiet')),
      );
      const handler = createMcpHandler(getCommand(boolProgram), boolProgram.eval.bind(boolProgram) as any);

      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'cmd', arguments: { verbose: true } },
      });

      const result = res?.result as any;
      expect(result.isError).toBe(false);
      const texts = result.content.map((c: any) => c.text);
      expect(texts.some((t: string) => t.includes('verbose'))).toBe(true);
    });

    it('should return Done for void results', async () => {
      const voidProgram = createPadrone('void').command('noop', (c) => c.action(() => {}));
      const handler = createMcpHandler(getCommand(voidProgram), voidProgram.eval.bind(voidProgram) as any);

      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'noop', arguments: {} },
      });

      const result = res?.result as any;
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe('Done.');
    });
  });

  describe('help tool', () => {
    it('should return program help when no command is specified', async () => {
      const handler = createHandler();
      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'help', arguments: {} },
      });

      const result = res?.result as any;
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('test');
      expect(result.content[0].text).toContain('greet');
    });

    it('should return command help when command is specified', async () => {
      const handler = createHandler();
      const res = await handler({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'help', arguments: { command: 'greet' } },
      });

      const result = res?.result as any;
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('Greet someone');
    });
  });

  describe('default commands', () => {
    it('should not produce trailing dots for default subcommands', async () => {
      const prog = createPadrone('app').command('parent', (c) =>
        c.command('', (s) => s.action(() => 'default')).command('child', (s) => s.action(() => 'child')),
      );
      const handler = createMcpHandler(getCommand(prog), prog.eval.bind(prog) as any);
      const res = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const tools = (res?.result as any).tools;
      const toolNames = tools.map((t: any) => t.name);

      // Default command should use parent name, not 'parent.'
      expect(toolNames).toContain('parent');
      expect(toolNames).toContain('parent.child');
      expect(toolNames).not.toContain('parent.');
    });
  });

  describe('unknown method', () => {
    it('should return method not found error for unknown methods with id', async () => {
      const handler = createHandler();
      const res = await handler({ jsonrpc: '2.0', id: 1, method: 'unknown/method' });

      expect(res?.error).toBeDefined();
      expect(res?.error?.code).toBe(-32601);
    });

    it('should return undefined for unknown notifications (no id)', async () => {
      const handler = createHandler();
      const res = await handler({ jsonrpc: '2.0', method: 'unknown/notification' });
      expect(res).toBeUndefined();
    });
  });

  describe('program.mcp method', () => {
    it('should exist on the program', () => {
      expect(typeof program.mcp).toBe('function');
    });
  });
});

describe('mcp cancellation', () => {
  const createWaitProgram = () =>
    createPadrone('test').command('wait', (c) =>
      c.async().action(
        (_args, ctx) =>
          new Promise<string>((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error(`aborted: ${ctx.signal.reason}`)));
            setTimeout(() => resolve('finished'), 1000);
          }),
      ),
    );

  it('aborts a tool call on notifications/cancelled', async () => {
    const program = createWaitProgram();
    const handler = createMcpHandler(getCommand(program), program.eval.bind(program) as any);
    const call = handler({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wait', arguments: {} } });
    await handler({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'user' } });
    const response = (await call) as any;
    expect(response.result.isError).toBe(true);
    expect(response.result.content.at(-1).text).toBe('aborted: user');
  });

  it('aborts a tool call when the transport signal aborts', async () => {
    const program = createWaitProgram();
    const handler = createMcpHandler(getCommand(program), program.eval.bind(program) as any);
    const controller = new AbortController();
    const call = handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: {} } }, controller.signal);
    controller.abort('gone');
    expect(((await call) as any).result.content.at(-1).text).toBe('aborted: gone');
  });
});
