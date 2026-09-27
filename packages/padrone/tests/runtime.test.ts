import { describe, expect, it, mock } from 'bun:test';
import { createPadrone, padroneConfig, padroneEnv } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import * as z from 'zod/v4';

describe('runtime', () => {
  describe('.runtime() builder method', () => {
    it('should use custom output for help', () => {
      const output = mock();
      const program = createPadrone('app')
        .runtime({ output })
        .command('greet', (c) => c.action(() => 'hello'));

      program.eval('--help');
      expect(output).toHaveBeenCalledTimes(1);
      expect(output.mock.calls[0]![0]).toContain('greet');
    });

    it('should use custom output for version', () => {
      const output = mock();
      const program = createPadrone('app').runtime({ output }).configure({ version: '1.2.3' });

      program.eval('--version');
      expect(output).toHaveBeenCalledTimes(1);
      expect(output.mock.calls[0]![0]).toBe('1.2.3');
    });

    it('should use custom output for completion', async () => {
      const output = mock();
      const program = createPadrone('app')
        .extend(padroneCompletion())
        .runtime({ output })
        .command('build', (c) => c.action(() => 'built'));

      await program.eval('completion bash');
      expect(output).toHaveBeenCalledTimes(1);
      expect(output.mock.calls[0]![0]).toContain('bash');
    });

    it('should use custom error for validation failures', () => {
      const error = mock();
      const program = createPadrone('app')
        .runtime({ error, argv: () => ['greet'] })
        .command('greet', (c) => c.arguments(z.object({ name: z.string() })).action((args) => `Hello, ${args.name}!`));

      // cli() without explicit input uses runtime.argv, and validation failure returns error in result
      const result = program.cli();
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('Validation error');
      expect(error).toHaveBeenCalled();
      expect(error.mock.calls[0]![0]).toContain('Validation error');
    });

    it('should use custom argv', () => {
      const program = createPadrone('app')
        .runtime({ argv: () => ['greet', '--name', 'Alice'] })
        .command('greet', (c) => c.arguments(z.object({ name: z.string() })).action((args) => `Hello, ${args.name}!`));

      const result = program.cli();
      expect(result.result as unknown).toBe('Hello, Alice!');
    });

    it('should use custom env', () => {
      const program = createPadrone('app')
        .runtime({ env: () => ({ APP_NAME: 'TestApp' }) })
        .extend(padroneEnv(z.object({ APP_NAME: z.string() }).transform((e) => ({ name: e.APP_NAME }))))
        .command('greet', (c) => c.arguments(z.object({ name: z.string().optional() })).action((args) => `Hello, ${args.name}!`));

      const result = program.eval('greet');
      expect(result.args).toEqual({ name: 'TestApp' });
    });

    it('should use custom format as default for help()', () => {
      const program = createPadrone('app')
        .runtime({ format: 'markdown' })
        .command('build', (c) => c.configure({ description: 'Build the project' }).action(() => 'built'));

      const helpText = program.help();
      // Markdown format uses ** for bold
      expect(helpText).toContain('**');
    });

    it('should use custom loadConfig with explicit --config flag', () => {
      const mockLoadConfig = mock(() => ({ port: 8080 }));
      const program = createPadrone('app').command('serve', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().default(3000) }))
          .extend(padroneConfig({ files: ['config.json'], loadConfig: mockLoadConfig }))
          .action((args) => args.port),
      );

      program.eval('serve --config=my.json');
      expect(mockLoadConfig).toHaveBeenCalledWith('my.json', undefined, undefined);
    });

    it('should use custom loadConfig with auto-detection', async () => {
      const mockLoadConfig = mock(() => ({ port: 9090 }));
      const program = createPadrone('app').command('serve', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().default(3000) }))
          .extend(padroneConfig({ files: ['config.json', 'config.yaml'], loadConfig: mockLoadConfig }))
          .action((args) => args.port),
      );

      const result = await program.eval('serve');
      expect(mockLoadConfig).toHaveBeenCalledWith(['config.json', 'config.yaml'], undefined, undefined);
      expect(result.result).toBe(9090);
    });
  });

  describe('merging', () => {
    it('should merge successive .runtime() calls', () => {
      const output = mock();
      const error = mock();

      const program = createPadrone('app')
        .runtime({ output })
        .runtime({ error })
        .command('greet', (c) => c.arguments(z.object({ name: z.string() })).action((args) => `Hello, ${args.name}!`));

      // output should still be the custom one from the first call
      program.eval('--help');
      expect(output).toHaveBeenCalledTimes(1);

      // error should be the custom one from the second call
      // Use argv so cli() runs without explicit input, which triggers throw on validation error
      const program2 = createPadrone('app')
        .runtime({ error, argv: () => ['greet'] })
        .command('greet', (c) => c.arguments(z.object({ name: z.string() })).action((args) => `Hello, ${args.name}!`));

      const result2 = program2.cli();
      expect(result2.error).toBeInstanceOf(Error);
      expect((result2.error as Error).message).toContain('Validation error');
      expect(error).toHaveBeenCalled();
    });

    it('should allow later .runtime() to override earlier fields', () => {
      const output1 = mock();
      const output2 = mock();

      const program = createPadrone('app')
        .runtime({ output: output1 })
        .runtime({ output: output2 })
        .command('greet', (c) => c.action(() => 'hello'));

      program.eval('--help');
      expect(output1).not.toHaveBeenCalled();
      expect(output2).toHaveBeenCalledTimes(1);
    });
  });

  describe('inheritance', () => {
    it('should inherit runtime from parent command', () => {
      const env = mock(() => ({ GREETING: 'Hi' }));

      const program = createPadrone('app')
        .runtime({ env })
        .extend(padroneEnv(z.object({ GREETING: z.string() }).transform((e) => ({ greeting: e.GREETING }))))
        .command('greet', (c) => c.arguments(z.object({ greeting: z.string().optional() })).action((args) => args.greeting));

      const result = program.eval('greet');
      expect(env).toHaveBeenCalled();
      expect(result.args).toEqual({ greeting: 'Hi' });
    });
  });

  describe('defaults', () => {
    it('should fall back to default runtime when none is set', () => {
      // This just verifies the program works without any runtime config
      const program = createPadrone('app').command('greet', (c) =>
        c.arguments(z.object({ name: z.string() })).action((args) => `Hello, ${args.name}!`),
      );

      const result = program.eval('greet --name World');
      expect(result.result).toBe('Hello, World!');
    });
  });
});
