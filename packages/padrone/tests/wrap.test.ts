import { describe, expect, it } from 'bun:test';
import * as z from 'zod/v4';
import { createPadrone } from '../src/index.js';

describe('wrap', () => {
  describe('basic wrapping', () => {
    it('should wrap echo command with string argument', async () => {
      const program = createPadrone('test').command('echo', (c) =>
        c
          .arguments(
            z.object({
              message: z.string(),
            }),
            {
              positional: ['message'],
            },
          )
          .wrap({
            command: 'echo',
            schema: (cmdSchema) => cmdSchema, // Identity transform
          }),
      );

      const result = await program.run('echo', { message: 'Hello World from echo wrapper' });
      const wrapResult = await result.result;

      expect(result.command?.path).toBe('echo');
      expect(result.args?.message).toBe('Hello World from echo wrapper');
      expect(wrapResult?.success).toBe(true);
      expect(wrapResult?.exitCode).toBe(0);
    });

    it('should capture stdout when inheritStdio is false', async () => {
      const program = createPadrone('test').command('echo', (c) =>
        c
          .arguments(
            z.object({
              message: z.string(),
            }),
            {
              positional: ['message'],
            },
          )
          .wrap({
            command: 'echo',
            inheritStdio: false,
            schema: (cmdSchema) => cmdSchema,
          }),
      );

      const result = await program.run('echo', { message: 'Hello' });
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
      expect(wrapResult?.stdout?.trim()).toBe('Hello');
    });
  });

  describe('arg mapping', () => {
    it('should convert boolean args to flags', async () => {
      const program = createPadrone('test').command('ls', (c) =>
        c
          .arguments(
            z.object({
              all: z.boolean().optional(),
              long: z.boolean().optional(),
            }),
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            args: ['ls', '/tmp'],
            inheritStdio: false,
          }),
      );

      const result = await program.run('ls', { all: true, long: true });
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
      expect(result.args?.all).toBe(true);
      expect(result.args?.long).toBe(true);
    });

    it('should handle array args', async () => {
      const program = createPadrone('test').command('test', (c) =>
        c
          .arguments(
            z.object({
              files: z.string().array().optional(),
            }),
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            inheritStdio: false,
          }),
      );

      const result = await program.run('test', { files: ['file1.txt', 'file2.txt'] });
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
      expect(wrapResult?.stdout?.includes('file1.txt')).toBe(true);
      expect(wrapResult?.stdout?.includes('file2.txt')).toBe(true);
    });
  });

  describe('positional arguments', () => {
    it('should handle single positional argument', async () => {
      const program = createPadrone('test').command('cat', (c) =>
        c
          .arguments(
            z.object({
              file: z.string(),
            }),
            {
              positional: ['file'],
            },
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            args: ['Reading:'],
            inheritStdio: false,
          }),
      );

      const result = await program.run('cat', { file: 'test.txt' });
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
      expect(wrapResult?.stdout?.includes('test.txt')).toBe(true);
    });

    it('should handle variadic positional arguments', async () => {
      const program = createPadrone('test').command('concat', (c) =>
        c
          .arguments(
            z.object({
              files: z.string().array(),
            }),
            {
              positional: ['...files'],
            },
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            inheritStdio: false,
          }),
      );

      const result = await program.run('concat', { files: ['file1.txt', 'file2.txt', 'file3.txt'] });
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
      expect(wrapResult?.stdout?.includes('file1.txt')).toBe(true);
      expect(wrapResult?.stdout?.includes('file2.txt')).toBe(true);
      expect(wrapResult?.stdout?.includes('file3.txt')).toBe(true);
    });

    it('should handle mixed positional and arg arguments', async () => {
      const program = createPadrone('test').command('grep', (c) =>
        c
          .arguments(
            z.object({
              pattern: z.string(),
              file: z.string(),
              ignoreCase: z.boolean().optional(),
            }),
            {
              positional: ['pattern', 'file'],
            },
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            inheritStdio: false,
          }),
      );

      const result = await program.run('grep', { pattern: 'test', file: 'file.txt', ignoreCase: true });
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle command not found', async () => {
      const program = createPadrone('test').command('notfound', (c) =>
        c.arguments(z.object({})).wrap({
          command: 'this-command-does-not-exist-12345',
          inheritStdio: false,
          schema: (cmdSchema) => cmdSchema, // Identity transform
        }),
      );

      // Like eval(), run() reports a failing async action in `error`
      const result = await program.run('notfound', {});
      expect(result.error).toBeDefined();
    });

    it('should return non-zero exit code for failing commands', async () => {
      const program = createPadrone('test').command('false', (c) =>
        c.arguments(z.object({})).wrap({
          command: 'false',
          inheritStdio: false,
          schema: (cmdSchema) => cmdSchema, // Identity transform
        }),
      );

      const result = await program.run('false', {});
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(false);
      expect(wrapResult?.exitCode).not.toBe(0);
    });
  });

  describe('CLI parsing', () => {
    it('should work with CLI parsing', async () => {
      const program = createPadrone('test').command('echo', (c) =>
        c
          .arguments(
            z.object({
              message: z.string(),
            }),
            {
              positional: ['message'],
            },
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            inheritStdio: false,
          }),
      );

      const result = await program.eval('echo "Hello from CLI"');
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
      expect(wrapResult?.stdout?.includes('Hello from CLI')).toBe(true);
    });

    it('should work with args from CLI', async () => {
      const program = createPadrone('test-cli').command('cmd', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().optional(),
              file: z.string().optional(),
            }),
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            inheritStdio: false,
          }),
      );

      const result = await program.eval('cmd --verbose --file test.txt');
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
    });
  });

  describe('with fixed args', () => {
    it('should prepend fixed args to command', async () => {
      const program = createPadrone('git').command('status', (c) =>
        c
          .arguments(
            z.object({
              s: z.boolean().optional(),
            }),
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            args: ['git', 'status'],
            inheritStdio: false,
          }),
      );

      const result = await program.run('status', { s: true });
      const wrapResult = await result.result;

      // Note: This will succeed because we're using echo instead of actual git
      expect(result.command?.path).toBe('status');
      expect(wrapResult?.success).toBe(true);
    });
  });

  describe('type safety', () => {
    it('should enforce args schema', async () => {
      const program = createPadrone('test').command('echo', (c) =>
        c
          .arguments(
            z.object({
              message: z.string(),
              count: z.number().optional(),
            }),
            {
              positional: ['message'],
            },
          )
          .wrap({
            schema: (cmdSchema) => cmdSchema,
            command: 'echo',
            inheritStdio: false,
          }),
      );

      const result = await program.run('echo', { message: 'test', count: 5 });
      const wrapResult = await result.result;

      expect(result.args?.message).toBe('test');
      expect(result.args?.count).toBe(5);
      expect(wrapResult?.success).toBe(true);
    });
  });

  describe('schema transformation', () => {
    it('should transform args using wrap schema', async () => {
      const program = createPadrone('test').command('git-commit', (c) =>
        c
          .arguments(
            z.object({
              message: z.string(),
              all: z.boolean().optional(),
            }),
            {
              positional: ['message'],
            },
          )
          .wrap({
            command: 'echo',
            args: ['git', 'commit'],
            positional: ['m'],
            inheritStdio: false,
            schema: z
              .object({
                message: z.string(),
                all: z.boolean().optional(),
              })
              .transform((args) => ({
                m: args.message,
                a: args.all,
              })),
          }),
      );

      const result = await program.run('git-commit', { message: 'Initial commit', all: true });
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
      // The echo output should contain the transformed flags
      expect(wrapResult?.stdout?.includes('--a')).toBe(true);
      expect(wrapResult?.stdout?.includes('Initial commit')).toBe(true);
    });

    it('should use custom positional config from wrap', async () => {
      const program = createPadrone('test').command('docker', (c) =>
        c
          .arguments(
            z.object({
              image: z.string(),
              detach: z.boolean().optional(),
            }),
          )
          .wrap({
            command: 'echo',
            args: ['docker', 'run'],
            positional: ['image'], // Custom positional for wrap
            inheritStdio: false,
            schema: z
              .object({
                image: z.string(),
                detach: z.boolean().optional(),
              })
              .transform((args) => ({
                image: args.image,
                d: args.detach,
              })),
          }),
      );

      const result = await program.run('docker', { image: 'nginx', detach: true });
      const wrapResult = await result.result;

      expect(wrapResult?.success).toBe(true);
      expect(wrapResult?.stdout?.includes('nginx')).toBe(true);
      expect(wrapResult?.stdout?.includes('--d')).toBe(true);
    });
  });
});
