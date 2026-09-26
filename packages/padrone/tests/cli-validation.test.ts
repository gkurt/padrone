import { describe, expect, it, mock } from 'bun:test';
import { createPadrone, type InteractivePromptConfig, padroneConfig, RoutingError, ValidationError } from 'padrone';
import * as z from 'zod/v4';

describe('CLI validation improvements', () => {
  // ====================================================================
  // Issue #1: Auto-coercion of CLI types
  // ====================================================================
  describe('auto-coercion', () => {
    it('should auto-coerce string to number for z.number() fields', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.arguments(z.object({ limit: z.number().optional() })).action((args) => args),
      );

      const result = program.eval('list --limit 3');
      expect(result.args?.limit).toBe(3);
      expect(typeof result.args?.limit).toBe('number');
    });

    it('should auto-coerce string to number for z.number() with min/max', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.arguments(z.object({ limit: z.number().min(1).max(100).optional() })).action((args) => args),
      );

      const result = program.eval('list --limit 50');
      expect(result.args?.limit).toBe(50);
    });

    it('should auto-coerce string to boolean for z.boolean() fields', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ verbose: z.boolean().optional() })).action((args) => args),
      );

      const result = program.eval('run --verbose true');
      expect(result.args?.verbose).toBe(true);
    });

    it('should auto-coerce "false" string to false boolean', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ verbose: z.boolean().optional() })).action((args) => args),
      );

      const result = program.eval('run --verbose false');
      expect(result.args?.verbose).toBe(false);
    });

    it('should auto-coerce yes/no/on/off to boolean', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ verbose: z.boolean().optional() })).action((args) => args),
      );

      expect(program.eval('run --verbose yes').args?.verbose).toBe(true);
      expect(program.eval('run --verbose no').args?.verbose).toBe(false);
      expect(program.eval('run --verbose on').args?.verbose).toBe(true);
      expect(program.eval('run --verbose off').args?.verbose).toBe(false);
    });

    it('should auto-coerce booleans case-insensitively', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ verbose: z.boolean().optional() })).action((args) => args),
      );

      expect(program.eval('run --verbose TRUE').args?.verbose).toBe(true);
      expect(program.eval('run --verbose False').args?.verbose).toBe(false);
      expect(program.eval('run --verbose YES').args?.verbose).toBe(true);
      expect(program.eval('run --verbose NO').args?.verbose).toBe(false);
      expect(program.eval('run --verbose On').args?.verbose).toBe(true);
      expect(program.eval('run --verbose Off').args?.verbose).toBe(false);
    });

    it('should auto-coerce number strings in arrays', () => {
      const program = createPadrone('app').command('batch', (c) =>
        c.arguments(z.object({ ids: z.array(z.number()).optional() })).action((args) => args),
      );

      const result = program.eval('batch --ids 1 --ids 2 --ids 3');
      expect(result.args?.ids).toEqual([1, 2, 3]);
    });

    it('should not coerce invalid number strings', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.arguments(z.object({ limit: z.number().optional() })).action((args) => args),
      );

      // "abc" cannot be coerced to a number, so validation should fail
      const result = program.eval('list --limit abc');
      expect(result.argsResult?.issues).toBeDefined();
    });

    it('should work with z.number() without requiring z.coerce.number()', () => {
      const program = createPadrone('app').command('serve', (c) =>
        c.arguments(z.object({ port: z.number().default(3000) })).action((args) => args),
      );

      const result = program.eval('serve --port 8080');
      expect(result.args?.port).toBe(8080);
    });

    it('should not coerce when value is already the right type', () => {
      const program = createPadrone('app').command('test', (c) =>
        c.arguments(z.object({ count: z.number().optional() })).action((args) => args),
      );

      // When parsed from CLI, "5" is a string — should coerce to 5
      const result = program.eval('test --count 5');
      expect(result.args?.count).toBe(5);
    });

    it('should coerce integer types', () => {
      const program = createPadrone('app').command('test', (c) =>
        c.arguments(z.object({ count: z.int().optional() })).action((args) => args),
      );

      const result = program.eval('test --count 42');
      expect(result.args?.count).toBe(42);
    });

    it('should coerce string to boolean for z.union([z.boolean(), z.string()])', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ test: z.union([z.boolean(), z.string()]) })).action((args) => args),
      );

      expect(program.eval('run --test true').args?.test).toBe(true);
      expect(program.eval('run --test false').args?.test).toBe(false);
    });

    it('should coerce string to literal boolean for z.union([z.literal(true), z.string()])', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ test: z.union([z.literal(true), z.string()]) })).action((args) => args),
      );

      const result = program.eval('run --test true');
      expect(result.args?.test).toBe(true);
    });

    it('should leave non-boolean strings as string in boolean|string union', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ test: z.union([z.boolean(), z.string()]) })).action((args) => args),
      );

      const result = program.eval('run --test hello');
      expect(result.args?.test).toBe('hello');
    });

    it('should coerce string to number for z.union([z.number(), z.string()])', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ test: z.union([z.number(), z.string()]) })).action((args) => args),
      );

      expect(program.eval('run --test 42').args?.test).toBe(42);
      expect(program.eval('run --test hello').args?.test).toBe('hello');
    });

    it('should prefer boolean coercion over number when both are allowed', () => {
      const program = createPadrone('app').command('run', (c) =>
        c.arguments(z.object({ test: z.union([z.boolean(), z.number()]) })).action((args) => args),
      );

      expect(program.eval('run --test true').args?.test).toBe(true);
      expect(program.eval('run --test 42').args?.test).toBe(42);
    });
  });

  // ====================================================================
  // Issue #2: Strict schema by default
  // ====================================================================
  describe('strict by default', () => {
    it('should reject unknown options when no arguments are defined', () => {
      const program = createPadrone('app').command('run', (c) => c.action(() => 'done'));

      const result = program.eval('run --foo bar');
      expect(result.argsResult?.issues).toBeDefined();
      expect(result.argsResult?.issues?.[0]?.message).toContain('Unknown option: "foo"');
      expect(result.args).toBeUndefined();
    });

    it('should return empty args when no arguments are defined and no options passed', () => {
      const program = createPadrone('app').command('run', (c) => c.action(() => 'done'));

      const result = program.eval('run');
      expect(result.argsResult?.issues).toBeUndefined();
      expect(result.args as unknown).toEqual({});
    });

    it('should reject unknown options by default', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.arguments(z.object({ status: z.string().optional(), limit: z.number().optional() })).action((args) => args),
      );

      const result = program.eval('list --statu pending');
      expect(result.argsResult?.issues).toBeDefined();
      expect(result.argsResult?.issues?.length).toBeGreaterThan(0);
    });

    it('should not reject known options', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.arguments(z.object({ status: z.string().optional(), limit: z.number().optional() })).action((args) => args),
      );

      const result = program.eval('list --status pending');
      expect(result.argsResult?.issues).toBeUndefined();
      expect(result.args?.status).toBe('pending');
    });

    it('should not reject alias options', () => {
      const program = createPadrone('app').command('list', (c) =>
        c
          .arguments(z.object({ status: z.string().optional() }), {
            fields: { status: { flags: 's' } },
          })
          .action((args) => args),
      );

      const result = program.eval('list -s pending');
      expect(result.argsResult?.issues).toBeUndefined();
      expect(result.args?.status).toBe('pending');
    });

    it('should allow additional properties when schema uses additionalProperties: true', () => {
      // z.looseObject or z.object().catchall() sets additionalProperties
      const program = createPadrone('app').command('test', (c) =>
        c.arguments(z.looseObject({ status: z.string().optional() })).action((args) => args),
      );

      const result = program.eval('test --status ok --extra value');
      expect(result.argsResult?.issues).toBeUndefined();
    });

    it('should throw ValidationError in hard mode for unknown options', () => {
      const errors: string[] = [];
      const program = createPadrone('app')
        .runtime({
          error: (msg) => errors.push(msg),
          argv: () => ['list', '--statu', 'pending'],
        })
        .command('list', (c) => c.arguments(z.object({ status: z.string().optional() })).action((args) => args));

      const result = program.cli();
      expect(result.error).toBeInstanceOf(ValidationError);
    });

    it('should not flag framework keys like --config when config extension is used', async () => {
      const program = createPadrone('app').command('connect', (c) =>
        c
          .arguments(z.object({ host: z.string().optional() }))
          .extend(padroneConfig({ files: ['config.json'], loadConfig: () => undefined }))
          .action((args) => args),
      );

      // --config is consumed by the config extension, should not be flagged as unknown
      const result = await program.eval('connect --config some-config.json --host localhost');
      expect(result.argsResult?.issues).toBeUndefined();
      expect(result.args?.host).toBe('localhost');
    });
  });

  // ====================================================================
  // Issue #3: Fuzzy match unknown options and suggest similar ones
  // ====================================================================
  describe('option fuzzy matching', () => {
    it('should suggest similar option for typo', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.arguments(z.object({ status: z.string().optional(), priority: z.string().optional() })).action((args) => args),
      );

      const result = program.eval('list --statsu pending');
      expect(result.argsResult?.issues).toBeDefined();
      const issue = result.argsResult?.issues?.[0];
      expect(issue?.message).toContain('Unknown option');
      expect(issue?.message).toContain('statsu');
      expect(issue?.message).toContain('Did you mean "--status"');
    });

    it('should suggest similar option for misspelling', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.arguments(z.object({ verbose: z.boolean().optional(), output: z.string().optional() })).action((args) => args),
      );

      const result = program.eval('list --vrebose');
      expect(result.argsResult?.issues).toBeDefined();
      expect(result.argsResult?.issues?.[0]?.message).toContain('Did you mean "--verbose"');
    });

    it('should report unknown option without suggestion when too different', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.arguments(z.object({ status: z.string().optional() })).action((args) => args),
      );

      const result = program.eval('list --xyz value');
      expect(result.argsResult?.issues).toBeDefined();
      expect(result.argsResult?.issues?.[0]?.message).toContain('Unknown option: "xyz"');
      expect(result.argsResult?.issues?.[0]?.message).not.toContain('Did you mean');
    });

    it('should suggest in hard mode (cli)', () => {
      const errors: string[] = [];
      const program = createPadrone('app')
        .runtime({
          error: (msg) => errors.push(msg),
          argv: () => ['run', '--vrebose'],
        })
        .command('run', (c) => c.arguments(z.object({ verbose: z.boolean().optional() })).action(() => 'ran'));

      const result = program.cli();
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(errors.some((e) => e.includes('Did you mean "--verbose"'))).toBe(true);
    });
  });

  // ====================================================================
  // Issue #4: Exit early on validation errors before prompting
  // ====================================================================
  describe('early exit before prompting', () => {
    it('should not prompt when a provided value has a validation error', async () => {
      const promptFn = mock(async (config: InteractivePromptConfig) => {
        return config.name === 'name' ? 'Alice' : 'react';
      });

      const program = createPadrone('app')
        .runtime({ interactive: 'supported', prompt: promptFn })
        .command('init', (c) =>
          c
            .arguments(
              z.object({
                name: z.string(),
                template: z.enum(['react', 'vue', 'svelte']),
                status: z.enum(['active', 'inactive']).optional(),
              }),
              { interactive: ['name', 'template'] },
            )
            .action((args) => args),
        );

      // status has an invalid value — should fail before prompting for name/template
      const result = await program.eval('init --status bogus');
      expect(result.argsResult?.issues).toBeDefined();
      // Should NOT have prompted the user at all
      expect(promptFn).not.toHaveBeenCalled();
    });

    it('should not prompt when an unknown option is provided', async () => {
      const promptFn = mock(async (_config: InteractivePromptConfig) => 'value');

      const program = createPadrone('app')
        .runtime({ interactive: 'supported', prompt: promptFn })
        .command('init', (c) => c.arguments(z.object({ name: z.string() }), { interactive: ['name'] }).action((args) => args));

      const result = await program.eval('init --bogus value');
      expect(result.argsResult?.issues).toBeDefined();
      expect(promptFn).not.toHaveBeenCalled();
    });

    it('should still prompt when only missing fields have issues', async () => {
      const promptFn = mock(async (config: InteractivePromptConfig) => {
        return config.name === 'name' ? 'Alice' : undefined;
      });

      const program = createPadrone('app')
        .runtime({ interactive: 'supported', prompt: promptFn })
        .command('init', (c) => c.arguments(z.object({ name: z.string() }), { interactive: ['name'] }).action((args) => args));

      // No args provided — name is missing but should be prompted
      const result = await program.eval('init');
      expect(promptFn).toHaveBeenCalled();
      expect(result.args?.name).toBe('Alice');
    });
  });

  // ====================================================================
  // Issue #5: Suggest similar commands on misspelled command names
  // ====================================================================
  describe('command name suggestions', () => {
    it('should suggest the correct command for a typo', () => {
      const program = createPadrone('app')
        .command('list', (c) => c.action(() => 'listed'))
        .command('show', (c) => c.action(() => 'shown'))
        .command('add', (c) => c.action(() => 'added'));

      const result = program.eval('lis');
      expect(result.error).toBeInstanceOf(RoutingError);
      expect((result.error as Error).message).toMatch(/Did you mean "list"/);
    });

    it('should include the unknown command name in the error', () => {
      const program = createPadrone('app')
        .command('list', (c) => c.action(() => 'listed'))
        .command('show', (c) => c.action(() => 'shown'));

      const result = program.eval('lis');
      expect(result.error).toBeInstanceOf(RoutingError);
      expect((result.error as Error).message).toMatch(/Unknown command: lis/);
    });

    it('should show compact available commands list in hard mode when suggestion exists', () => {
      const errors: string[] = [];
      const outputs: string[] = [];
      const program = createPadrone('app')
        .runtime({
          output: (...args) => outputs.push(args.map(String).join(' ')),
          error: (msg) => errors.push(msg),
          argv: () => ['lis'],
        })
        .command('list', (c) => c.action(() => 'listed'))
        .command('show', (c) => c.action(() => 'shown'));

      const result = program.cli();
      expect(result.error).toBeInstanceOf(RoutingError);

      // Everything goes to stderr so stdout stays clean for piping
      expect(errors.some((e) => e.includes('Did you mean "list"'))).toBe(true);
      expect(errors.some((e) => e.includes('Available commands: list, show'))).toBe(true);
      expect(errors.some((e) => e.includes('Run "app --help" for usage.'))).toBe(true);
      expect(outputs).toEqual([]);
    });

    it('should list available commands and a help hint when no suggestion matches', () => {
      const errors: string[] = [];
      const program = createPadrone('app')
        .runtime({
          error: (msg) => errors.push(msg),
          argv: () => ['xyzabc'],
        })
        .command('list', (c) => c.action(() => 'listed'))
        .command('show', (c) => c.action(() => 'shown'));

      const result = program.cli();
      expect(result.error).toBeInstanceOf(RoutingError);
      expect(errors).toEqual(['Unknown command: xyzabc', '\nAvailable commands: list, show', '\nRun "app --help" for usage.']);
    });

    it('should show full help after an error with showHelpOnError', () => {
      const errors: string[] = [];
      const program = createPadrone('app', { builtins: { help: { showHelpOnError: true } } })
        .runtime({
          error: (msg) => errors.push(msg),
          argv: () => ['list', '--nope'],
        })
        .command('list', (c) => c.configure({ description: 'List things' }).action(() => 'listed'));

      const result = program.cli();
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(errors[0]).toContain('Unknown option: "nope"');
      expect(errors.some((e) => e.includes('Usage: app list') && e.includes('List things'))).toBe(true);
      expect(errors.some((e) => e.includes('for usage.'))).toBe(false);
    });

    it('should point to the failing command help after a validation error', () => {
      const errors: string[] = [];
      const program = createPadrone('app')
        .runtime({
          error: (msg) => errors.push(msg),
          argv: () => ['list', '--nope'],
        })
        .command('list', (c) => c.action(() => 'listed'));

      program.cli();
      expect(errors.at(-1)).toBe('\nRun "app list --help" for usage.');
      expect(errors.some((e) => e.includes('Usage:'))).toBe(false);
    });

    it('should be a RoutingError with suggestions', () => {
      const program = createPadrone('app')
        .command('deploy', (c) => c.action(() => 'deployed'))
        .command('list', (c) => c.action(() => 'listed'));

      const result = program.eval('deply');
      expect(result.error).toBeInstanceOf(RoutingError);
      const err = result.error as RoutingError;
      expect(err.suggestions).toContain('Did you mean "deploy"?');
    });
  });
});
