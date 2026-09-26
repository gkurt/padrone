import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneConfig, padroneEnv } from 'padrone';
import { testCli } from 'padrone/test';
import { jsonCodec, zodAsyncStream } from 'padrone/zod';
import * as z from 'zod/v4';

describe('stdin', () => {
  describe('text mode (default)', () => {
    const program = createPadrone('test').command('process', (c) =>
      c.arguments(z.object({ data: z.string() }), { stdin: 'data' }).action((args) => `processed: ${args.data}`),
    );

    it('should read stdin as text into the specified field', async () => {
      const result = await testCli(program).stdin('hello world').run('process');

      expect(result.result).toBe('processed: hello world');
      expect(result.args).toEqual({ data: 'hello world' });
    });

    it('should allow CLI flag to override stdin', async () => {
      const result = await testCli(program).stdin('from stdin').run('process --data="from flag"');

      expect(result.result).toBe('processed: from flag');
    });

    it('should fail validation when no stdin and field is required', async () => {
      const result = await testCli(program).run('process');

      expect(result.issues).toBeDefined();
      expect(result.issues!.length).toBeGreaterThan(0);
    });
  });

  describe('text mode with optional field', () => {
    const program = createPadrone('test').command('process', (c) =>
      c.arguments(z.object({ data: z.string().optional() }), { stdin: 'data' }).action((args) => args.data ?? 'no data'),
    );

    it('should work without stdin when field is optional', async () => {
      const result = await testCli(program).run('process');

      expect(result.result).toBe('no data');
      expect(result.issues).toBeUndefined();
    });
  });

  describe('lines mode (inferred from array schema)', () => {
    const program = createPadrone('test').command('count', (c) =>
      c.arguments(z.object({ lines: z.string().array() }), { stdin: 'lines' }).action((args) => args.lines.length),
    );

    it('should read stdin as lines into an array field', async () => {
      const result = await testCli(program).stdin('line1\nline2\nline3\n').run('count');

      expect(result.result).toBe(3);
      expect(result.args).toEqual({ lines: ['line1', 'line2', 'line3'] });
    });

    it('should handle single line without trailing newline', async () => {
      const result = await testCli(program).stdin('single line').run('count');

      expect(result.result).toBe(1);
      expect(result.args).toEqual({ lines: ['single line'] });
    });
  });

  describe('lines mode with optional array field', () => {
    const program = createPadrone('test').command('count', (c) =>
      c.arguments(z.object({ lines: z.string().array().optional() }), { stdin: 'lines' }).action((args) => args.lines?.length ?? 0),
    );

    it('should read stdin as lines when field is optional array', async () => {
      const result = await testCli(program).stdin('a\nb\nc\n').run('count');

      expect(result.result).toBe(3);
      expect(result.args).toEqual({ lines: ['a', 'b', 'c'] });
    });

    it('should work without stdin when field is optional', async () => {
      const result = await testCli(program).run('count');

      expect(result.result).toBe(0);
      expect(result.issues).toBeUndefined();
    });
  });

  describe('precedence: CLI > stdin > env > config', () => {
    const program = createPadrone('test').command('greet', (c) =>
      c
        .arguments(z.object({ name: z.string() }), { stdin: 'name' })
        .extend(padroneEnv(z.object({ GREET_NAME: z.string().optional() }).transform((e) => ({ name: e.GREET_NAME! }))))
        .extend(padroneConfig({ files: ['config.json'], loadConfig: () => ({ name: 'config-name' }) }))
        .action((args) => `Hello, ${args.name}!`),
    );

    it('stdin should take precedence over env', async () => {
      const result = await testCli(program).stdin('stdin-name').env({ GREET_NAME: 'env-name' }).run('greet');

      expect(result.result).toBe('Hello, stdin-name!');
    });

    it('stdin should take precedence over config', async () => {
      const result = await testCli(program).stdin('stdin-name').run('greet');

      expect(result.result).toBe('Hello, stdin-name!');
    });

    it('CLI flag should take precedence over stdin', async () => {
      const result = await testCli(program).stdin('stdin-name').run('greet --name="cli-name"');

      expect(result.result).toBe('Hello, cli-name!');
    });

    it('env should be used when no stdin', async () => {
      const result = await testCli(program).env({ GREET_NAME: 'env-name' }).run('greet');

      expect(result.result).toBe('Hello, env-name!');
    });
  });

  describe('stdin with positional args', () => {
    const program = createPadrone('test').command('transform', (c) =>
      c
        .arguments(z.object({ format: z.string(), data: z.string() }), { positional: ['format'], stdin: 'data' })
        .action((args) => `${args.format}: ${args.data}`),
    );

    it('should combine positional args with stdin data', async () => {
      const result = await testCli(program).stdin('raw data').run('transform json');

      expect(result.result).toBe('json: raw data');
    });
  });

  describe('asyncStream', () => {
    describe('string stream (default)', () => {
      const program = createPadrone('test').command('stream', (c) =>
        c.arguments(z.object({ lines: zodAsyncStream() }), { stdin: 'lines' }).action(async (args) => {
          const result: string[] = [];
          for await (const line of args.lines) {
            result.push(line);
          }
          return result;
        }),
      );

      it('should stream stdin lines as AsyncIterable', async () => {
        const result = await testCli(program).stdin('line1\nline2\nline3\n').run('stream');

        expect(result.result).toEqual(['line1', 'line2', 'line3']);
      });

      it('should yield empty iterable when no stdin is piped', async () => {
        const result = await testCli(program).run('stream');

        expect(result.result).toEqual([]);
      });
    });

    describe('typed stream with item validation', () => {
      const itemSchema = z.object({ name: z.string(), age: z.number() });
      const program = createPadrone('test').command('ingest', (c) =>
        c
          .arguments(z.object({ records: zodAsyncStream(jsonCodec(itemSchema)) }), {
            stdin: 'records',
          })
          .action(async (args) => {
            const result: string[] = [];
            for await (const record of args.records) {
              result.push(`${record.name}:${record.age}`);
            }
            return result;
          }),
      );

      it('should parse and validate each JSON line', async () => {
        const input = ['{"name":"Alice","age":30}', '{"name":"Bob","age":25}'].join('\n');
        const result = await testCli(program).stdin(input).run('ingest');

        expect(result.result).toEqual(['Alice:30', 'Bob:25']);
      });

      it('should throw on invalid item', async () => {
        const input = ['{"name":"Alice","age":30}', '{"name":"Bad","age":"not-a-number"}'].join('\n');
        const result = await testCli(program).stdin(input).run('ingest');

        expect(result.error).toBeDefined();
      });
    });
  });

  describe('help output', () => {
    it('should show stdin field in usage line', () => {
      const program = createPadrone('test').command('process', (c) =>
        c.arguments(z.object({ data: z.string() }), { stdin: 'data' }).action((args) => args.data),
      );

      const help = program.help('process');
      expect(help).toContain('stdin');
      expect(help).toContain('data');
    });
  });
});

describe('stdin field given positionally', () => {
  const program = createPadrone('test').command('cat', (c) =>
    c
      .arguments(z.object({ input: z.string().optional() }), { positional: ['input'], stdin: 'input' })
      .async()
      .action((args) => args.input),
  );

  it('uses the positional value instead of piped stdin', async () => {
    const result = await testCli(program).stdin('piped').run('cat file.txt');
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('file.txt');
  });

  it('reads stdin when the positional is omitted', async () => {
    const result = await testCli(program).stdin('piped').run('cat');
    expect(result.result).toBe('piped');
  });
});
