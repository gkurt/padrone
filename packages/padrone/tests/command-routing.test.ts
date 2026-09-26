import { describe, expect, expectTypeOf, it } from 'bun:test';
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

describe('command routing', () => {
  describe('default command (empty name)', () => {
    const program = createPadrone('app')
      .configure({ version: '1.0.0' })
      .command(['', 'shell'], (c) => c.configure({ title: 'Start interactive mode' }).action(() => 'default-executed'))
      .command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      );

    it('should match empty-name command when no input is provided', () => {
      const result = program.eval('');
      expect(result.command?.name).toBe('');
      expect(result.result).toBe('default-executed');
    });

    it('should match empty-name command via alias', () => {
      const result = program.eval('shell');
      expect(result.command?.name).toBe('');
      expect(result.result).toBe('default-executed');
    });

    it('should still match named commands normally', () => {
      const result = program.eval('greet World');
      expect(result.result).toBe('Hello, World!');
    });

    it('should match empty-name command via cli() with no argv', () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'app'];
      try {
        const result = program.cli();
        expect((result as any).command.name).toBe('');
        expect((result as any).result).toBe('default-executed');
      } finally {
        process.argv = originalArgv;
      }
    });

    it('should use alias as display name with [default] marker in help', () => {
      const helpText = program.help(undefined, { format: 'text' });
      // Should show 'shell [default]' — alias as display name, [default] marker
      expect(helpText).toContain('shell');
      expect(helpText).toContain('[default]');
      expect(helpText).not.toContain('(shell)');
    });

    it('should show [default] marker for empty-name command without aliases', () => {
      const p = createPadrone('app')
        .command('', (c) => c.configure({ title: 'Default action' }).action(() => 'ok'))
        .command('list', (c) => c.action(() => 'listed'));
      const helpText = p.help(undefined, { format: 'text' });
      expect(helpText).toContain('[default]');
      expect(helpText).toContain('Default action');
    });

    it('should show [default] marker with multiple aliases', () => {
      const p = createPadrone('app')
        .command(['', 'shell', 'r'], (c) => c.configure({ title: 'Shell' }).action(() => 'ok'))
        .command('list', (c) => c.action(() => 'listed'));
      const helpText = p.help(undefined, { format: 'text' });
      // 'shell' is display name, 'r' is a real alias, [default] is marker
      expect(helpText).toContain('shell');
      expect(helpText).toMatch(/\(r\)/);
      expect(helpText).toContain('[default]');
    });

    it('should show [default] for reversed alias order', () => {
      const p = createPadrone('app')
        .command(['shell', ''], (c) => c.configure({ title: 'Shell' }).action(() => 'ok'))
        .command('list', (c) => c.action(() => 'listed'));
      const helpText = p.help(undefined, { format: 'text' });
      expect(helpText).toContain('shell');
      expect(helpText).toContain('[default]');
    });

    it('should use alias in help for the empty-name command itself', () => {
      const helpText = program.help('shell', { format: 'text' });
      // Usage line should reference alias, not 'program'
      expect(helpText).toContain('shell');
      expect(helpText).not.toContain('program');
    });

    it('should use alias in error message for empty-name command with extra args', () => {
      const result = program.eval('shell bogus');
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toContain("Unexpected arguments for 'shell'");
    });
  });

  describe('default help (no handler, no default command)', () => {
    const program = createPadrone('myapp')
      .configure({ description: 'A test app' })
      .command('list', (c) => c.action(() => 'listed'))
      .command('show', (c) => c.action(() => 'shown'));

    it('should print help when eval is called with empty input', () => {
      const result = program.eval('');
      expect(typeof result.result).toBe('string');
      expect(result.result as unknown as string).toContain('myapp');
      expect(result.result as unknown as string).toContain('list');
      expect(result.result as unknown as string).toContain('show');
    });

    it('should print help when cli() is called with no argv', () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'myapp'];
      try {
        const result = program.cli();
        expect(typeof result.result).toBe('string');
        expect(result.result as unknown as string).toContain('myapp');
      } finally {
        process.argv = originalArgv;
      }
    });
  });

  describe('unknown command error', () => {
    const errors: string[] = [];
    const output: unknown[] = [];
    const program = createPadrone('app')
      .runtime({ error: (msg) => errors.push(msg), output: (...args) => output.push(...args) })
      .command('list', (c) => c.action(() => 'listed'))
      .command('show', (c) => c.action(() => 'shown'));

    it('should throw on unknown command in eval()', () => {
      const result = program.eval('bogus');
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toContain('Unknown command: bogus');
    });

    it('should throw on unknown command in cli()', () => {
      const originalArgv = process.argv;
      process.argv = ['node', 'app', 'bogus'];
      try {
        const result = program.cli();
        expect(result.error).toBeDefined();
        expect((result.error as Error).message).toContain('Unknown command: bogus');
      } finally {
        process.argv = originalArgv;
      }
    });

    it('should include help in error output for cli()', () => {
      errors.length = 0;
      const originalArgv = process.argv;
      process.argv = ['node', 'app', 'bogus'];
      try {
        const result = program.cli();
        expect(result.error).toBeDefined();
      } finally {
        process.argv = originalArgv;
      }
      expect(errors.some((e) => e.includes('Unknown command: bogus'))).toBe(true);
      expect(errors.some((e) => e.includes('list'))).toBe(true);
    });
  });

  describe('extra parameters rejection', () => {
    const program = createPadrone('app')
      .command('start', (c) => c.action(() => 'start-executed'))
      .command('show', (c) => c.arguments(z.object({ id: z.string() }), { positional: ['id'] }).action((args) => `showing ${args.id}`));

    it('should reject extra terms for command without positionals', () => {
      const result = program.eval('start test');
      expect(result.error).toBeDefined();
      expect((result.error as Error).message).toMatch(/Unexpected arguments for 'start'/);
    });

    it('should accept positional args for commands that define them', () => {
      const result = program.eval('show my-id');
      expect(result.result).toBe('showing my-id');
    });

    it('should reject extra args after -- separator when the command has no positionals', () => {
      // After --, 'test' is a positional arg. start declares no positionals, so it is reported
      // instead of being silently dropped.
      const result = program.eval('start -- test');
      expect(result.command?.name).toBe('start');
      expect(result.result).toBeUndefined();
      expect(result.argsResult?.issues?.[0]?.message).toBe('Unexpected argument: test');
    });

    it('should not reject extra terms for commands with positional config', () => {
      const result = program.eval('show task-123');
      expect(result.result).toBe('showing task-123');
    });
  });

  describe('parent command help', () => {
    it('should show help for parent command with subcommands but no handler', () => {
      const program = createPadrone('app').command('db', (c) =>
        c
          .configure({ title: 'Database operations' })
          .command('migrate', (c) => c.action(() => 'migrated'))
          .command('seed', (c) => c.action(() => 'seeded')),
      );

      const result = program.eval('db');
      expect(typeof result.result).toBe('string');
      const helpText = result.result as unknown as string;
      expect(helpText).toContain('migrate');
      expect(helpText).toContain('seed');
    });

    it('should show <subcommand> indicator in help for commands with subcommands', () => {
      const program = createPadrone('app')
        .command('db', (c) => c.command('migrate', (c) => c.action(() => 'migrated')).command('seed', (c) => c.action(() => 'seeded')))
        .command('simple', (c) => c.action(() => 'done'));

      const helpText = program.help(undefined, { format: 'text' });
      expect(helpText).toContain('db <subcommand>');
      expect(helpText).not.toContain('simple <subcommand>');
    });

    it('should show [default] entry in help when parent has both handler and subcommands', () => {
      const program = createPadrone('app').command('list', (c) =>
        c
          .configure({ title: 'List items' })
          .action(() => 'listed')
          .command('extended', (c) => c.action(() => 'extended')),
      );

      const helpText = program.help('list', { format: 'text' });
      expect(helpText).toContain('[default]');
      expect(helpText).toContain('extended');
    });

    it('should still execute handler for parent command with both handler and subcommands', () => {
      const program = createPadrone('app').command('list', (c) =>
        c.action(() => 'listed').command('extended', (c) => c.action(() => 'extended')),
      );

      // list has a handler AND subcommands — handler should still run
      const result = program.eval('list');
      expect(result.result).toBe('listed');
    });
  });

  describe('command override/extension', () => {
    it('should override action when re-registering the same command name', () => {
      const program = createPadrone('app')
        .command('greet', (c) => c.action(() => 'original'))
        .command('greet', (c) => c.action(() => 'overridden'));

      const result = program.eval('greet');
      expect(result.result).toBe('overridden');
    });

    it('should pass base action as third parameter to overridden action', () => {
      const program = createPadrone('app')
        .command('greet', (c) => c.action(() => 'original'))
        .command('greet', (c) =>
          c.action((_args, _ctx, base) => {
            const original = base(_args, _ctx);
            return `modified: ${original}`;
          }),
        );

      const result = program.eval('greet');
      expect(result.result).toBe('modified: original');
    });

    it('should merge configuration on override', () => {
      const program = createPadrone('app')
        .command('greet', (c) => c.configure({ title: 'Original Title', description: 'Original Desc' }).action(() => 'ok'))
        .command('greet', (c) => c.configure({ title: 'New Title' }));

      const cmd = program.find('greet');
      expect(cmd?.title).toBe('New Title');
      expect(cmd?.description).toBe('Original Desc');
    });

    it('should preserve arguments schema when override does not change it', () => {
      const program = createPadrone('app')
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `hello ${args.name}`),
        )
        .command('greet', (c) =>
          c.action((args, _ctx, base) => {
            return base(args, _ctx).toUpperCase();
          }),
        );

      const result = program.eval('greet World');
      expect(result.result).toBe('HELLO WORLD');
    });

    it('should allow overriding arguments schema', () => {
      const program = createPadrone('app')
        .command('greet', (c) => c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => args.name))
        .command('greet', (c) =>
          c
            .arguments(z.object({ name: z.string(), loud: z.boolean().optional().default(false) }), { positional: ['name'] })
            .action((args) => (args.loud ? args.name.toUpperCase() : args.name)),
        );

      expect(program.eval('greet World').result).toBe('World');
      expect(program.eval('greet World --loud').result).toBe('WORLD');
    });

    it('should preserve subcommands from original when override adds none', () => {
      const program = createPadrone('app')
        .command('db', (c) =>
          c
            .configure({ title: 'Database' })
            .command('migrate', (c) => c.action(() => 'migrated'))
            .command('seed', (c) => c.action(() => 'seeded')),
        )
        .command('db', (c) => c.configure({ title: 'Database v2' }));

      expect(program.eval('db migrate').result).toBe('migrated');
      expect(program.eval('db seed').result).toBe('seeded');
      expect(program.find('db')?.title).toBe('Database v2');
    });

    it('should recursively merge subcommands by name', () => {
      const program = createPadrone('app')
        .command('db', (c) =>
          c
            .command('migrate', (c) => c.configure({ title: 'Migrate DB' }).action(() => 'migrated'))
            .command('seed', (c) => c.action(() => 'seeded')),
        )
        .command('db', (c) =>
          c
            .command('migrate', (c) => c.configure({ title: 'Migrate DB v2' }).action(() => 'migrated-v2'))
            .command('reset', (c) => c.action(() => 'reset')),
        );

      expect(program.eval('db migrate').result).toBe('migrated-v2');
      expect(program.eval('db seed').result).toBe('seeded');
      expect(program.eval('db reset').result).toBe('reset');
    });

    it('should not duplicate commands in the commands list', () => {
      const program = createPadrone('app')
        .command('greet', (c) => c.action(() => 'v1'))
        .command('greet', (c) => c.action(() => 'v2'))
        .command('other', (c) => c.action(() => 'other'));

      // Help should only list 'greet' once
      const helpText = program.help(undefined, { format: 'text' });
      const matches = helpText.match(/\bgreet\b/g) ?? [];
      // greet should appear exactly once in the commands list (in the help output)
      // It may appear more than once if it's in the usage line too, so just check it's not 3+
      expect(matches.length).toBeLessThanOrEqual(2);

      // eval should return the latest version
      expect(program.eval('greet').result).toBe('v2');
      expect(program.eval('other').result).toBe('other');
    });

    it('should provide noop as base when overriding a command without action', () => {
      const program = createPadrone('app')
        .command('greet', (c) => c.configure({ title: 'Greet' }))
        .command('greet', (c) =>
          c.action((_args, _ctx, base) => {
            const baseResult = base(_args, _ctx);
            return `result: ${baseResult}`;
          }),
        );

      const result = program.eval('greet');
      expect(result.result).toBe('result: undefined');
    });

    it('should chain multiple overrides with base passing', () => {
      const program = createPadrone('app')
        .command('greet', (c) => c.action(() => 'v1'))
        .command('greet', (c) => c.action((_args, _ctx, base) => `${base(_args, _ctx)}+v2`))
        .command('greet', (c) => c.action((_args, _ctx, base) => `${base(_args, _ctx)}+v3`));

      expect(program.eval('greet').result).toBe('v1+v2+v3');
    });

    it('should preserve aliases from original when override does not specify new ones', () => {
      const program = createPadrone('app')
        .command(['greet', 'g', 'hi'], (c) => c.action(() => 'hello'))
        .command('greet', (c) => c.action(() => 'hello v2'));

      expect(program.eval('g').result).toBe('hello v2');
      expect(program.eval('hi').result).toBe('hello v2');
    });

    it('should have correct types for override builder arguments', () => {
      const program = createPadrone('app')
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `hello ${args.name}`),
        )
        .command('greet', (c) => {
          // c should have the existing args type
          return c.action((args) => {
            expectTypeOf(args).toEqualTypeOf<{ name: string }>();
            return args.name;
          });
        });

      expect(program.eval('greet World').result).toBe('World');
    });

    it('should type the result as a union of all possible command results', () => {
      const program = createPadrone('app')
        .command('greet', (c) => c.action(() => 'string-result' as const))
        .command('greet', (c) => c.action(() => 42 as const));

      const result = program.eval('greet');
      expectTypeOf(result.result).toEqualTypeOf<42 | undefined>();
    });
  });

  describe('-- separator', () => {
    const program = createPadrone('app').command('run', (c) =>
      c
        .arguments(z.object({ items: z.array(z.string()).optional().default([]) }), {
          positional: ['...items'] as any,
        })
        .action((a) => ({ items: a.items })),
    );

    it('should treat tokens after -- as positional args, not command terms', () => {
      const result = program.eval('run -- --verbose --debug');
      expect(result.result?.items).toEqual(['--verbose', '--debug']);
    });

    it('should not parse flags after -- as named args', () => {
      const result = program.eval('run -- --help');
      // --help after -- should NOT trigger help output, should be a positional
      expect(result.result?.items).toEqual(['--help']);
    });

    it('should not match terms after -- as commands', () => {
      const result = program.eval('run -- run');
      expect(result.result?.items).toEqual(['run']);
    });
  });
});
