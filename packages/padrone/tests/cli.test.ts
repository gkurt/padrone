import { describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asyncSchema, createPadrone, padroneConfig, padroneEnv } from 'padrone';
import * as z from 'zod/v4';
import { createTasksProgram } from './common.ts';

describe('CLI', () => {
  const program = createTasksProgram();

  describe('programmatic execution', () => {
    it('should execute a simple command with args and args', () => {
      const result = program.run('show', { id: 'task-1', priority: 'high', verbose: true });

      expect(result.command?.path).toBe('show');
      expect(result.args).toMatchInlineSnapshot(`
        {
          "id": "task-1",
          "priority": "high",
          "verbose": true,
        }
      `);
      expect(result.result?.id).toBe('task-1');
      expect(result.result?.title).toBe('Important Task');
      expect(result.result?.stats?.total).toBe(5);
    });

    it('should execute a command with default args', () => {
      const result = program.run('show', { id: 'task-2' });

      expect(result.command?.path).toBe('show');
      expect(result.result?.title).toBe('Regular Task'); // Default medium priority
      expect(result.result?.stats).toBeUndefined(); // verbose not set
    });

    it('should execute nested commands', () => {
      const result = program.run('list extended', { status: 'pending', priority: 'high' });

      expect(result.command?.path).toBe('list extended');
      expect(result.args?.status).toEqual('pending');
      expect(result.args?.priority).toEqual('high');
      expect(result.result?.status).toBe('pending');
      expect(result.result?.extendedList).toBeDefined();
    });

    it('should execute a command with array args', () => {
      const result = program.run('batch', { ids: ['task-1', 'task-2', 'task-3'] });

      expect(result.command?.path).toBe('batch');
      expect(result.args?.ids).toEqual(['task-1', 'task-2', 'task-3']);
      expect(result.result?.ids).toEqual(['task-1', 'task-2', 'task-3']);
      expect(result.result?.results).toHaveLength(3);
    });

    it('should execute a command with void args and args', () => {
      const result = program.run('noop', undefined);

      expect(result.command?.path).toBe('noop');
      // Like eval(), a command without arguments gets {}
      expect(result.args).toEqual({});
      expect(result.result).toBeUndefined();
    });
  });

  describe('CLI parsing', () => {
    it('should parse simple command with args', () => {
      const result = program.parse('show task-1');

      expect(result.command.path).toBe('show');
      expect(result.args?.id).toEqual('task-1');
      expect(result.args?.priority).toEqual('medium');
    });

    it('should parse command with args', () => {
      const result = program.parse('show task-2 --priority high --verbose');

      expect(result.command.path).toBe('show');
      expect(result.args?.id).toEqual('task-2');
      expect(result.args?.priority).toEqual('high');
      expect(result.args?.verbose).toBe(true);
    });

    it('should parse command with arg values', () => {
      const result = program.parse('list --limit=5 --priority high');

      expect(result.command.path).toBe('list');
      expect(result.args?.limit).toEqual(5);
      expect(result.args?.priority).toEqual('high');
    });

    it('should parse nested commands', () => {
      const result = program.parse('list extended --status pending --priority high');

      expect(result.command.path).toBe('list extended');
      expect(result.args?.status).toEqual('pending');
      expect(result.args?.priority).toEqual('high');
    });

    it('should parse command with multiple args', () => {
      const result = program.parse('batch task-1 task-2 task-3 task-4');

      expect(result.command.path).toBe('batch');
      expect(result.args?.ids).toEqual(['task-1', 'task-2', 'task-3', 'task-4']);
    });

    it('should parse command with complex args', () => {
      const result = program.parse('filter --status "in_progress" --priority high');

      expect(result.command.path).toBe('filter');
      expect(result.args).toEqual({ status: 'in_progress', priority: 'high' }); // Note: quotes are now properly parsed
    });

    it('should handle empty input', () => {
      const result = program.parse('');

      expect(result.command.path).toBe('');
      expect(result.args).toEqual({});
    });
  });

  describe('CLI execution', () => {
    it('should execute command via CLI string', () => {
      const result = program.eval('show task-1 --priority high');

      expect(result).toBeDefined();
      if (!result) throw new Error('Result is undefined');
      expect(result.command?.path).toBe('show');
      expect(result.args?.id).toEqual('task-1');
      expect(result.result?.id).toBe('task-1');
      expect(result.result?.title).toBe('Important Task');
    });

    it('should show help for empty CLI input when root has no handler', () => {
      const result = program.eval('');
      expect(typeof result.result).toBe('string');
      expect(result.result as unknown as string).toContain('padrone-test');
    });

    it('should execute nested command via CLI', () => {
      const result = program.eval('list extended --status pending --priority high');

      expect(result).toBeDefined();
      expect(result?.command?.path).toBe('list extended');
      expect(result?.result?.status).toBe('pending');
    });

    it('should return error for non-existent command', () => {
      const result = program.run('nonexistent' as string, {});
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('Command "nonexistent" not found');
    });
  });

  describe('command finding', () => {
    it('should find a top-level command', () => {
      const command = program.find('show');

      expect(command).toBeDefined();
      expect(command?.name).toBe('show');
    });

    it('should find a nested command', () => {
      const command = program.find('list extended');

      expect(command).toBeDefined();
      expect(command?.name).toBe('extended');
      expect(command?.path).toBe('list extended');
    });

    it('should return undefined for non-existent command', () => {
      const command = program.find('nonexistent');

      expect(command).toBeUndefined();
    });
  });

  describe('API generation', () => {
    it('should generate type-safe API for top-level commands', () => {
      const api = program.api();

      expect(api.show).toBeDefined();
      expect(typeof api.show).toBe('function');

      const result = api.show({ id: 'task-1', priority: 'high', verbose: true });
      // API returns PadroneCommandResult, so access .result property
      expect(result.id).toBe('task-1');
      expect(result.title).toBe('Important Task');
    });

    it('should generate nested API structure', () => {
      const api = program.api();
      expect(api.list).toBeDefined();
      expect(typeof api.list).toBe('function');
      expect(api.list.extended).toBeDefined();
      expect(typeof api.list.extended).toBe('function');

      const result = api.list.extended({ status: 'pending', priority: 'high' });
      // API returns PadroneCommandResult, so access .result property
      expect(result.status).toBe('pending');
      expect(result.extendedList).toBeDefined();
    });

    it('should generate API for all commands', () => {
      const api = program.api();

      expect(api.show).toBeDefined();
      expect(api.list).toBeDefined();
      expect(api.filter).toBeDefined();
      expect(api.batch).toBeDefined();
      expect(api.noop).toBeDefined();
    });

    it('should execute commands through API', () => {
      const api = program.api();

      const batchResult = api.batch({ ids: ['task-1', 'task-2'] });
      // API returns PadroneCommandResult, so access .result property
      expect(batchResult.ids).toEqual(['task-1', 'task-2']);

      const filterResult = api.filter({ status: 'pending', priority: 'high' });
      expect(filterResult.status).toBe('pending');
    });
  });

  describe('program.info', () => {
    it('should expose program metadata', () => {
      const info = program.info;

      expect(info.name).toBe('padrone-test');
      expect(info.commands).toContain('show');
      expect(info.commands).toContain('list');
      expect(info.commands).toContain('filter');
      expect(info.commands).toContain('batch');
      expect(info.commands).toContain('noop');
    });

    it('should expose name, version, and description', () => {
      const p = createPadrone('my-cli').configure({ version: '1.2.3', description: 'A test CLI' });
      const info = p.info;

      expect(info.name).toBe('my-cli');
      expect(info.version).toBe('1.2.3');
      expect(info.description).toBe('A test CLI');
    });

    it('should list subcommand names including builtins', () => {
      const p = createPadrone('my-cli')
        .command('deploy', (c) => c.action(() => {}))
        .command('rollback', (c) => c.action(() => {}));

      expect(p.info.commands).toContain('deploy');
      expect(p.info.commands).toContain('rollback');
      // Builtins are also present
      expect(p.info.commands).toContain('help');
      expect(p.info.commands).toContain('version');
    });

    it('should expose title, examples, and deprecated', () => {
      const p = createPadrone('my-cli').configure({
        title: 'My CLI Tool',
        examples: ['my-cli deploy --env=prod'],
        deprecated: 'Use new-cli instead',
      });

      expect(p.info.title).toBe('My CLI Tool');
      expect(p.info.examples).toEqual(['my-cli deploy --env=prod']);
      expect(p.info.deprecated).toBe('Use new-cli instead');
    });

    it('should reflect changes after builder mutations', () => {
      const p1 = createPadrone('my-cli').configure({ version: '1.0.0' });
      const p2 = p1.configure({ version: '2.0.0' }).command('new-cmd', (c) => c.action(() => {}));

      expect(p1.info.version).toBe('1.0.0');
      expect(p1.info.commands).not.toContain('new-cmd');
      expect(p2.info.version).toBe('2.0.0');
      expect(p2.info.commands).toContain('new-cmd');
    });
  });

  describe('edge cases', () => {
    it('should handle command with no args schema', () => {
      const program = createPadrone('padrone-test').command('test', (c) => c.action(() => ({ message: 'success' })));

      const result = program.run('test', undefined);
      expect(result.result?.message).toBe('success');
    });

    it('should handle command with positional args', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c.arguments(z.object({ id: z.string() }), { positional: ['id'] }).action((args) => ({ id: args.id })),
      );

      const result = program.run('test', { id: 'task-1' });
      expect(result.result?.id).toBe('task-1');
    });

    it('should handle deeply nested commands', () => {
      const program = createPadrone('padrone-test').command('level1', (c) =>
        c.command('level2', (c2) => c2.command('level3', (c3) => c3.action(() => ({ depth: 3 })))).action(() => ({ depth: 1 })),
      );

      const result = program.run('level1 level2 level3', undefined);
      expect(result.result?.depth).toBe(3);
    });

    it('should handle command names with spaces in parsing', () => {
      // Note: This tests the parsing behavior - spaces typically separate commands
      const result = program.parse('list extended');

      expect(result.command.path).toBe('list extended');
    });

    it('should handle args without values', () => {
      const result = program.parse('filter --ascending');

      expect(result.command.path).toBe('filter');
      expect(result.args?.ascending).toBe(true);
    });

    it('should handle multiple boolean args', () => {
      const result = program.parse('show task-1 --verbose --priority high');

      expect(result.command.path).toBe('show');
      expect(result.args?.verbose).toBe(true);
      expect(result.args?.priority).toBe('high');
    });
  });

  describe('real-world task CLI scenarios', () => {
    it('should handle showing tasks for multiple IDs sequentially', () => {
      const ids = ['task-1', 'task-2', 'task-3'];
      const results = ids.map((id) => program.run('show', { id, priority: 'high' }));

      expect(results).toHaveLength(3);
      results.forEach((result, i) => {
        expect(result.result?.id).toBe(ids[i]!);
        expect(result.result?.title).toBe('Important Task');
      });
    });

    it('should handle listing tasks with custom limit', () => {
      const result = program.run('list', { limit: 5, priority: 'medium' });

      expect(result.result?.limit).toBe(5);
      expect(result.result?.tasks).toHaveLength(2); // Mock data only has 2 tasks
    });

    it('should handle batch operations across multiple tasks', () => {
      const ids = ['task-1', 'task-2', 'task-3'];
      const result = program.run('batch', { ids });

      expect(result.result?.results).toHaveLength(3);
      result.result?.results.forEach((res: any, i: number) => {
        expect(res.id).toBe(ids[i]);
        expect(res.status).toBeDefined();
        expect(res.title).toBeDefined();
      });
    });

    it('should handle filtering tasks with args', () => {
      const result = program.run('filter', {
        status: 'pending',
        priority: 'high',
      });

      expect(result.result?.status).toBe('pending');
      expect(result.result?.priority).toBe('high');
      expect(result.result?.tasks).toBeDefined();
    });
  });

  describe('alias functionality', () => {
    it('should resolve aliases to full arg names when parsing', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z
                .boolean()
                .optional()
                .meta({ flags: ['v'] }),
              help: z
                .boolean()
                .optional()
                .meta({ flags: ['h'] }),
            }),
          )
          .action((args) => ({
            verbose: args?.verbose,
            help: args?.help,
          })),
      );

      const result = program.parse('test -v -h');

      expect(result.command.path).toBe('test');
      expect(result.args?.verbose).toBe(true);
      expect(result.args?.help).toBe(true);
    });

    it('should resolve aliases with values', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              unit: z
                .string()
                .optional()
                .meta({ flags: ['u'] }),
              count: z.coerce
                .number()
                .optional()
                .meta({ flags: ['c'] }),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test -u celsius -c=5');

      expect(result.args?.unit).toBe('celsius');
      expect(result.args?.count).toBe(5);
    });

    it('should execute commands with aliases via CLI', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z
                .boolean()
                .optional()
                .meta({ flags: ['v'] }),
            }),
          )
          .action((args) => ({
            verbose: args?.verbose || false,
          })),
      );

      const result = program.eval('test -v');

      expect(result?.args?.verbose).toBe(true);
      expect(result?.result?.verbose).toBe(true);
    });

    it('should handle aliases mixed with full arg names', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z
                .boolean()
                .optional()
                .meta({ flags: ['v'] }),
              help: z
                .boolean()
                .optional()
                .meta({ flags: ['h'] }),
              output: z
                .string()
                .optional()
                .meta({ flags: ['o'] }),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test -v --help -o=file.txt');

      expect(result.args?.verbose).toBe(true);
      expect(result.args?.help).toBe(true);
      expect(result.args?.output).toBe('file.txt');
    });

    it('should handle undefined aliases gracefully', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().optional(),
              v: z.boolean().optional(), // Include 'v' in schema to test without alias
            }),
          )
          .action((args) => args),
      );

      // No aliases defined, -v should work as 'v' key if it's in the schema
      const result = program.parse('test -v');

      expect(result.args?.v).toBe(true);
      expect(result.args?.verbose).toBeUndefined();
    });

    it('should display aliases in help text', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z
                .boolean()
                .optional()
                .describe('Enable verbose output')
                .meta({ flags: ['v'] }),
              help: z
                .boolean()
                .optional()
                .describe('Show help information')
                .meta({ flags: ['h'] }),
            }),
          )
          .action(),
      );

      const helpText = program.help('test');

      expect(helpText).toContain('--verbose');
      expect(helpText).toContain('--help');
      expect(helpText).toContain('-v');
      expect(helpText).toContain('-h');
    });

    it('should work with nested commands', () => {
      const program = createPadrone('padrone-test').command('parent', (c) =>
        c
          .command('child', (c2) =>
            c2
              .arguments(
                z.object({
                  verbose: z
                    .boolean()
                    .optional()
                    .meta({ flags: ['v'] }),
                }),
              )
              .action((args) => ({
                verbose: args?.verbose || false,
              })),
          )
          .action(),
      );

      const result = program.parse('parent child -v');

      expect(result.command.path).toBe('parent child');
      expect(result.args?.verbose).toBe(true);
    });

    it('should work with meta object', () => {
      const program = createPadrone('padrone-test').command('parent', (c) =>
        c
          .command('child', (c2) =>
            c2
              .arguments(
                z.object({
                  verbose: z.boolean().optional(),
                }),
                {
                  fields: {
                    verbose: {
                      flags: ['v'],
                    },
                  },
                },
              )
              .action((args) => ({
                verbose: args?.verbose || false,
              })),
          )
          .action(),
      );

      const result = program.parse('parent child -v');

      expect(result.command.path).toBe('parent child');
      expect(result.args?.verbose).toBe(true);
    });

    it('should handle multiple aliases for the same arg', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z
                .boolean()
                .optional()
                .meta({ flags: ['v'] }),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test -v');

      expect(result.args?.verbose).toBe(true);
    });
  });

  describe('auto-alias (camelCase → kebab-case)', () => {
    it('should auto-generate kebab-case alias for camelCase args', () => {
      const program = createPadrone('test').command('run', (c) =>
        c.arguments(z.object({ dryRun: z.boolean().optional(), outputDir: z.string().optional() })).action((args) => args),
      );

      const result = program.parse('run --dry-run --output-dir=dist');
      expect(result.args?.dryRun).toBe(true);
      expect(result.args?.outputDir).toBe('dist');
    });

    it('should not generate alias for non-camelCase args', () => {
      const program = createPadrone('test').command('run', (c) =>
        c.arguments(z.object({ verbose: z.boolean().optional() })).action((args) => args),
      );

      // 'verbose' has no uppercase letters, so no auto-alias is generated
      const result = program.parse('run --verbose');
      expect(result.args?.verbose).toBe(true);
    });

    it('should prefer explicit alias over auto-alias', () => {
      const program = createPadrone('test').command('run', (c) =>
        c
          .arguments(z.object({ dryRun: z.boolean().optional() }), {
            fields: { dryRun: { alias: 'dry' } },
          })
          .action((args) => args),
      );

      // Explicit alias should work
      const result = program.parse('run --dry');
      expect(result.args?.dryRun).toBe(true);

      // Auto-alias should also work
      const result2 = program.parse('run --dry-run');
      expect(result2.args?.dryRun).toBe(true);
    });

    it('should disable auto-alias when autoAlias is false', () => {
      const program = createPadrone('test').command('run', (c) =>
        c.arguments(z.object({ dryRun: z.boolean().optional() }), { autoAlias: false }).action((args) => args),
      );

      // --dry-run should NOT resolve to dryRun
      const result = program.parse('run --dry-run');
      expect(result.args?.dryRun).toBeUndefined();
    });

    it('should show kebab-case as primary name in help text', () => {
      const program = createPadrone('test').command('run', (c) =>
        c.arguments(z.object({ dryRun: z.boolean().optional().describe('Skip actual execution') })).action(),
      );

      const helpText = program.help('run', { detail: 'full' });
      expect(helpText).toContain('--dry-run');
    });
  });

  describe('stringify', () => {
    it('should stringify a simple command with args', () => {
      const result = program.stringify('show', { id: 'task 1', priority: 'medium' });

      expect(result).toBe('show "task 1" --priority=medium');
    });

    it('should stringify a command with args and args', () => {
      const result = program.stringify('show', { id: 'task-1', priority: 'high', verbose: true });

      expect(result).toBe('show task-1 --priority=high --verbose');
    });

    it('should stringify a nested command', () => {
      const result = program.stringify('list extended', { status: 'pending', priority: 'medium' });

      expect(result).toBe('list extended --status=pending --priority=medium');
    });

    it('should stringify a command with multiple args', () => {
      const result = program.stringify('batch', { ids: ['task-1', 'task-2', 'task-3'] });

      expect(result).toBe('batch task-1 task-2 task-3');
    });

    it('should stringify args with spaces using quotes', () => {
      const result = program.stringify('batch', { ids: ['task one', 'task two'] });

      expect(result).toBe('batch "task one" "task two"');
    });

    it('should stringify args with string values containing spaces', () => {
      const result = program.stringify('filter', { status: 'in_progress', priority: 'high' });

      expect(result).toBe('filter --status=in_progress --priority=high');
    });

    it('should stringify false boolean args with no- prefix', () => {
      const result = program.stringify('filter', { ascending: false });

      expect(result).toBe('filter --no-ascending');
    });

    it('should stringify numeric args', () => {
      const result = program.stringify('list', { limit: 5, priority: 'high' });

      expect(result).toBe('list --limit=5 --priority=high');
    });

    it('should omit undefined args', () => {
      const result = program.stringify('show', { id: 'task-1', priority: 'high', verbose: undefined });

      expect(result).toBe('show task-1 --priority=high');
    });

    it('should handle command with no args and no args', () => {
      const result = program.stringify('noop', undefined);

      expect(result).toBe('noop');
    });

    it('should throw error for non-existent command', () => {
      expect(() => {
        program.stringify('nonexistent', {});
      }).toThrow('Command "nonexistent" not found');
    });

    it('should handle empty ids array', () => {
      const result = program.stringify('batch', { ids: [] });

      expect(result).toBe('batch');
    });

    it('should roundtrip: stringify then parse produces same result', () => {
      const original = { command: 'show' as const, args: { id: 'task-1', priority: 'high' as const, verbose: true } };
      const stringified = program.stringify(original.command, original.args);
      const parsed = program.parse<'show'>(stringified);

      expect(parsed.command.path).toBe(original.command);
      expect(parsed.args?.id).toEqual(original.args.id);
      expect(parsed.args?.priority).toBe(original.args.priority);
      expect(parsed.args?.verbose).toBe(original.args.verbose);
    });

    it('should stringify variadic args as multiple flags', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              include: z.array(z.string()).optional(),
            }),
          )
          .action(),
      );

      const result = program.stringify('test', { include: ['src', 'lib', 'tests'] });
      expect(result).toBe('test --include=src --include=lib --include=tests');
    });
  });

  describe('variadic args', () => {
    it('should collect repeated args into an array', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              include: z.array(z.string()).optional(),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --include=src --include=lib --include=tests');

      expect(result.args?.include).toEqual(['src', 'lib', 'tests']);
    });

    it('should work with aliases for variadic args', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              include: z.array(z.string()).optional(),
            }),
            { fields: { include: { flags: ['i'] } } },
          )
          .action((args) => args),
      );

      const result = program.parse('test -i=src -i=lib --include=tests');

      expect(result.args?.include).toEqual(['src', 'lib', 'tests']);
    });

    it('should handle variadic args with space-separated values', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              tag: z.array(z.string()).optional(),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --tag one --tag two --tag three');

      expect(result.args?.tag).toEqual(['one', 'two', 'three']);
    });

    it('should collect repeated non-array args into an array for union schemas', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              id: z.union([z.string(), z.array(z.string())]).optional(),
            }),
          )
          .action((args) => args),
      );

      const single = program.parse('test --id foo');
      expect(single.args?.id).toBe('foo');

      const multiple = program.parse('test --id foo --id bar --id baz');
      expect(multiple.args?.id).toEqual(['foo', 'bar', 'baz']);
    });

    it('should display variadic args in help text', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              include: z.array(z.string()).optional().describe('Files to include'),
            }),
          )
          .action(),
      );

      const helpText = program.help('test');

      expect(helpText).toContain('--include');
      expect(helpText).toContain('<string[]>');
    });
  });

  describe('negatable boolean args', () => {
    it('should parse --no-<arg> as false', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().optional().default(true),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --no-verbose');

      expect(result.args?.verbose).toBe(false);
    });

    it('should parse --<arg> as true', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().optional().default(false),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --verbose');

      expect(result.args?.verbose).toBe(true);
    });

    it('should display negatable args in help text', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().optional().describe('Enable verbose output'),
            }),
          )
          .action(),
      );

      const helpText = program.help('test');

      expect(helpText).toContain('--verbose');
      expect(helpText).not.toContain('--[no-]verbose');
    });

    it('should stringify false boolean to --no-<arg>', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().optional(),
            }),
          )
          .action(),
      );

      const result = program.stringify('test', { verbose: false });

      expect(result).toBe('test --no-verbose');
    });

    it('should not mark as negatable when explicit noArg property exists', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().optional().describe('Enable verbose output'),
              noVerbose: z.boolean().optional().describe('Disable verbose output'),
            }),
          )
          .action(),
      );

      const helpText = program.help('test');

      // verbose should NOT be shown as --[no-]verbose since noVerbose exists
      expect(helpText).toContain('--verbose');
      expect(helpText).not.toContain('--[no-]verbose');
      // noVerbose shown as kebab-case --no-verbose
      expect(helpText).toContain('--no-verbose');
    });

    it('should handle kebab-case no-arg property', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              debug: z.boolean().optional().describe('Enable debug mode'),
              'no-debug': z.never(),
            }),
          )
          .action(),
      );

      const helpText = program.help('test');

      // debug should NOT be shown as --[no-]debug since no-debug exists
      expect(helpText).toContain('--debug');
      expect(helpText).not.toContain('--[no-]debug');
    });
  });

  describe('custom negative keywords', () => {
    it('should parse --<negative> as false for the target arg', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              local: z.boolean().default(true).meta({ negative: 'remote' }),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --remote');
      expect(result.args?.local).toBe(false);
    });

    it('should disable --no- prefix when negative is set', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              local: z.boolean().default(true).meta({ negative: 'remote' }),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --no-local');
      expect(result.args).toBeUndefined();
      expect(result.argsResult?.issues).toBeDefined();
    });

    it('should disable --no- prefix when negative is empty string', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().default(true).meta({ negative: '' }),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --no-verbose');
      expect(result.args).toBeUndefined();
      expect(result.argsResult?.issues).toBeDefined();
    });

    it('should disable --no- prefix when negative is empty array', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              verbose: z.boolean().default(true).meta({ negative: [] }),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --no-verbose');
      expect(result.args).toBeUndefined();
      expect(result.argsResult?.issues).toBeDefined();
    });

    it('should support array of negative keywords', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              local: z
                .boolean()
                .default(true)
                .meta({ negative: ['remote', 'cloud'] }),
            }),
          )
          .action((args) => args),
      );

      expect(program.parse('test --remote').args?.local).toBe(false);
      expect(program.parse('test --cloud').args?.local).toBe(false);
    });

    it('should still allow --<arg> to set true', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              local: z.boolean().default(false).meta({ negative: 'remote' }),
            }),
          )
          .action((args) => args),
      );

      expect(program.parse('test --local').args?.local).toBe(true);
    });

    it('should stringify false boolean using negative keyword', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              local: z.boolean().default(true).meta({ negative: 'remote' }),
            }),
          )
          .action(),
      );

      expect(program.stringify('test', { local: false })).toBe('test --remote');
    });

    it('should stringify true boolean normally with negative keyword', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              local: z.boolean().default(true).meta({ negative: 'remote' }),
            }),
          )
          .action(),
      );

      expect(program.stringify('test', { local: true })).toBe('test --local');
    });

    it('should show negative keywords in help', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              local: z.boolean().default(true).meta({ negative: 'remote' }),
            }),
          )
          .action(),
      );

      const helpText = program.help('test');
      expect(helpText).toContain('--remote');
      expect(helpText).toContain('--local');
    });

    it('should support negative via fields meta', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ local: z.boolean().default(true) }), {
            fields: { local: { negative: 'remote' } },
          })
          .action((args) => args),
      );

      const result = program.parse('test --remote');
      expect(result.args?.local).toBe(false);
    });
  });

  describe('environment variable binding', () => {
    it('should apply env var when arg is not provided', async () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              apiKey: z.string().optional(),
            }),
          )
          .extend(padroneEnv(z.object({ API_KEY: z.string().optional() }).transform((env) => ({ apiKey: env.API_KEY }))))
          .action((args) => args),
      );

      const result = await program.runtime({ env: () => ({ API_KEY: 'secret123' }) }).eval('test');

      expect(result.args?.apiKey).toBe('secret123');
    });

    it('should prefer CLI value over env var', async () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              apiKey: z.string().optional(),
            }),
          )
          .extend(padroneEnv(z.object({ API_KEY: z.string().optional() }).transform((env) => ({ apiKey: env.API_KEY }))))
          .action((args) => args),
      );

      const result = await program.runtime({ env: () => ({ API_KEY: 'from-env' }) }).eval('test --apiKey=from-cli');

      expect(result.args?.apiKey).toBe('from-cli');
    });

    it('should support multiple env var names (fallback)', async () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              port: z.coerce.number().optional(),
            }),
          )
          .extend(
            padroneEnv(
              z
                .object({ PORT: z.string().optional(), APP_PORT: z.string().optional() })
                .transform((env) => ({ port: env.PORT ? Number(env.PORT) : env.APP_PORT ? Number(env.APP_PORT) : undefined })),
            ),
          )
          .action((args) => args),
      );

      // First env var not set, second one is
      const result = await program.runtime({ env: () => ({ APP_PORT: '8080' }) }).eval('test');

      expect(result.args?.port).toBe(8080);
    });

    it('should parse boolean env vars correctly', async () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              debug: z.boolean().optional(),
            }),
          )
          .extend(
            padroneEnv(z.object({ DEBUG: z.string().optional() }).transform((env) => ({ debug: env.DEBUG === 'true' ? true : undefined }))),
          )
          .action((args) => args),
      );

      const result = await program.runtime({ env: () => ({ DEBUG: 'true' }) }).eval('test');

      expect(result.args?.debug).toBe(true);
    });
  });

  describe('quoted string parsing', () => {
    it('should parse double-quoted strings with spaces', () => {
      const result = program.parse('show "task one" --priority high');

      expect(result.args?.id).toEqual('task one');
      expect(result.args?.priority).toBe('high');
    });

    it('should parse single-quoted strings with spaces', () => {
      const result = program.parse("show 'task two' --priority high");

      expect(result.args?.id).toEqual('task two');
      expect(result.args?.priority).toBe('high');
    });

    it('should parse quoted arg values', () => {
      const result = program.parse('filter --status="in_progress" --priority high');

      expect(result.args?.status).toBe('in_progress');
      expect(result.args?.priority).toBe('high');
    });

    it('should handle escaped quotes within quoted strings', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c.arguments(z.object({ message: z.string() }), { positional: ['message'] }).action((args) => ({ message: args.message })),
      );

      const result = program.parse('test "He said \\"hello\\""');

      expect(result.args?.message).toBe('He said "hello"');
    });

    it('should handle multiple quoted arguments', () => {
      const result = program.parse('batch "task one" "task two" "task three"');

      expect(result.args?.ids).toEqual(['task one', 'task two', 'task three']);
    });
  });

  describe('config file support', () => {
    it('should apply config values when args are not provided', async () => {
      const configData = { server: { port: 3000, host: 'localhost' } };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().optional(), host: z.string().optional() }))
          .extend(
            padroneConfig({
              files: ['config.json'],
              schema: z.object({ server: z.object({ port: z.number(), host: z.string() }) }).transform((data) => data.server),
              loadConfig: () => configData,
            }),
          )
          .action((args) => args),
      );

      const result = await program.eval('test');

      expect(result.args?.port).toBe(3000);
      expect(result.args?.host).toBe('localhost');
    });

    it('should prefer CLI value over config value', async () => {
      const configData = { server: { port: 3000 } };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().optional() }))
          .extend(
            padroneConfig({
              files: ['config.json'],
              schema: z.object({ server: z.object({ port: z.number() }) }).transform((data) => ({ port: data.server.port })),
              loadConfig: () => configData,
            }),
          )
          .action((args) => args),
      );

      const result = await program.eval('test --port=8080');

      expect(result.args?.port).toBe(8080);
    });

    it('should prefer env value over config value', async () => {
      const configData = { server: { port: 3000 } };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().optional() }))
          .extend(
            padroneEnv(z.object({ PORT: z.string().optional() }).transform((env) => ({ port: env.PORT ? Number(env.PORT) : undefined }))),
          )
          .extend(
            padroneConfig({
              files: ['config.json'],
              schema: z.object({ server: z.object({ port: z.number() }) }).transform((data) => ({ port: data.server.port })),
              loadConfig: () => configData,
            }),
          )
          .action((args) => args),
      );

      const result = await program.runtime({ env: () => ({ PORT: '9000' }) }).eval('test');

      expect(result.args?.port).toBe(9000);
    });

    it('should handle deeply nested config with schema transforms', async () => {
      const configData = { services: { api: { connection: { timeout: 5000 } } } };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ timeout: z.coerce.number().optional() }))
          .extend(
            padroneConfig({
              files: ['config.json'],
              schema: z
                .object({ services: z.object({ api: z.object({ connection: z.object({ timeout: z.number() }) }) }) })
                .transform((data) => ({ timeout: data.services.api.connection.timeout })),
              loadConfig: () => configData,
            }),
          )
          .action((args) => args),
      );

      const result = await program.eval('test');

      expect(result.args?.timeout).toBe(5000);
    });
  });

  describe('configFile method', () => {
    it('should validate config data against schema', async () => {
      const configData = { port: 3000, host: 'localhost' };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ port: z.number().optional(), host: z.string().optional() }))
          .extend(
            padroneConfig({
              files: ['config.json'],
              schema: z.object({ port: z.number(), host: z.string() }),
              loadConfig: () => configData,
            }),
          )
          .action((args) => args),
      );

      const result = await program.eval('test');

      expect(result.args?.port).toBe(3000);
      expect(result.args?.host).toBe('localhost');
    });

    it('should throw error when config data fails validation', async () => {
      const configData = { port: 'not-a-number' };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ port: z.number().optional() }))
          .extend(padroneConfig({ files: ['config.json'], schema: z.object({ port: z.number() }), loadConfig: () => configData }))
          .action((args) => args),
      );

      const result = await program.eval('test');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toMatch(/Invalid config file/);
    });

    it('should transform config data using schema', async () => {
      const configData = { serverPort: 8080 };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ port: z.number().optional() }))
          .extend(
            padroneConfig({
              files: ['config.json'],
              schema: z.object({ serverPort: z.number() }).transform((data) => ({ port: data.serverPort })),
              loadConfig: () => configData,
            }),
          )
          .action((args) => args),
      );

      const result = await program.eval('test');

      expect(result.args?.port).toBe(8080);
    });

    it('should use schema that matches args shape', async () => {
      const configData = { port: 3000 };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ port: z.number().optional(), host: z.string().optional() }))
          .extend(
            padroneConfig({
              files: ['config.json'],
              schema: z.object({ port: z.number().optional(), host: z.string().optional() }),
              loadConfig: () => configData,
            }),
          )
          .action((args) => args),
      );

      const result = await program.eval('test');

      expect(result.args?.port).toBe(3000);
    });

    it('should load config from single file name', async () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ name: z.string().optional() }))
          .extend(padroneConfig({ files: 'myapp.config.json', loadConfig: () => ({ name: 'loaded' }) }))
          .action((args) => args),
      );

      const result = await program.eval('test');
      expect(result.args?.name).toBe('loaded');
    });

    it('should load config from array of file names', async () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ name: z.string().optional() }))
          .extend(padroneConfig({ files: ['myapp.config.json', '.myapprc'], loadConfig: () => ({ name: 'loaded' }) }))
          .action((args) => args),
      );

      const result = await program.eval('test');
      expect(result.args?.name).toBe('loaded');
    });

    it('should inherit config extension from parent command', async () => {
      const configData = { port: 3000 };
      const program = createPadrone('padrone-test')
        .extend(padroneConfig({ files: ['config.json'], schema: z.object({ port: z.number() }), loadConfig: () => configData }))
        .command('sub', (c) => c.arguments(z.object({ port: z.number().optional() })).action((args) => args));

      const result = await program.eval('sub');

      expect(result.args?.port).toBe(3000);
    });

    it('should allow CLI args to override validated config values', async () => {
      const configData = { port: 3000 };
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().optional() }))
          .extend(padroneConfig({ files: ['config.json'], schema: z.object({ port: z.number() }), loadConfig: () => configData }))
          .action((args) => args),
      );

      const result = await program.eval('test --port=8080');

      expect(result.args?.port).toBe(8080);
    });
  });

  describe('array syntax with brackets', () => {
    it('should parse [a,b,c] as an array', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              tags: z.array(z.string()).optional(),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --tags=[a,b,c]');

      expect(result.args?.tags).toEqual(['a', 'b', 'c']);
    });

    it('should parse empty brackets as empty array', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              tags: z.array(z.string()).optional(),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --tags=[]');

      expect(result.args?.tags).toEqual([]);
    });

    it('should handle quoted values within array brackets', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              names: z.array(z.string()).optional(),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --names=["hello world","foo bar"]');

      expect(result.args?.names).toEqual(['hello world', 'foo bar']);
    });

    it('should handle mixed quoted and unquoted values in array', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              items: z.array(z.string()).optional(),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --items=[simple,"with space",another]');

      expect(result.args?.items).toEqual(['simple', 'with space', 'another']);
    });

    it('should combine array syntax with variadic args', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              include: z.array(z.string()).optional(),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --include=[a,b] --include=c --include=[d,e]');

      expect(result.args?.include).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('should work with short aliases', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              tags: z.array(z.string()).optional(),
            }),
            { fields: { tags: { flags: ['t'] } } },
          )
          .action((args) => args),
      );

      const result = program.parse('test -t=[one,two,three]');

      expect(result.args?.tags).toEqual(['one', 'two', 'three']);
    });

    it('should trim whitespace from array items', () => {
      const program = createPadrone('padrone-test').command('test', (c) =>
        c
          .arguments(
            z.object({
              items: z.array(z.string()).optional(),
            }),
          )
          .action((args) => args),
      );

      const result = program.parse('test --items=[  a  ,  b  ,  c  ]');

      expect(result.args?.items).toEqual(['a', 'b', 'c']);
    });
  });

  describe('help and version commands', () => {
    it('should show help with --help flag', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'A test CLI application', version: '1.2.3' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('--help');

      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should show help with -h flag', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'A test CLI application', version: '1.2.3' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('-h');

      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should show help for specific command with --help flag', () => {
      const program = createPadrone('test-cli').command('greet', (c) =>
        c
          .arguments(z.object({ name: z.string().describe('Name to greet') }), { positional: ['name'] })
          .action((args) => `Hello, ${args.name}!`),
      );

      const result = program.eval('greet --help');

      expect(result.result as unknown as string).toContain('greet');
    });

    it('should show help for nested command with --help flag', () => {
      const program = createPadrone('test-cli').command('git', (c) =>
        c.command('commit', (c) =>
          c.arguments(z.object({ message: z.string().describe('Commit message') })).action((args) => args?.message),
        ),
      );

      const result = program.eval('git commit --help');

      expect(result.result as unknown as string).toContain('commit');
      expect(result.result as unknown as string).toContain('message');
    });

    it('should show help with help command', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'A test CLI application', version: '1.2.3' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('help');

      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should show help for specific command with help command', () => {
      const program = createPadrone('test-cli').command('greet', (c) =>
        c
          .arguments(z.object({ name: z.string().describe('Name to greet') }), { positional: ['name'] })
          .action((args) => `Hello, ${args.name}!`),
      );

      const result = program.eval('help greet');

      expect(result.result as unknown as string).toContain('greet');
    });

    it('should show help for nested command with help command', () => {
      const program = createPadrone('test-cli').command('git', (c) =>
        c.command('commit', (c) =>
          c.arguments(z.object({ message: z.string().describe('Commit message') })).action((args) => args?.message),
        ),
      );

      const result = program.eval('help git commit');

      expect(result.result as unknown as string).toContain('commit');
      expect(result.result as unknown as string).toContain('message');
    });

    it('should show version with --version flag', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'A test CLI application', version: '1.2.3' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('--version');

      expect(result.result as unknown as string).toBe('1.2.3');
    });

    it('should show version with -v flag', () => {
      const program = createPadrone('test-cli')
        .configure({ version: '2.0.0' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('-v');

      expect(result.result as unknown as string).toBe('2.0.0');
    });

    it('should show version with -V flag', () => {
      const program = createPadrone('test-cli')
        .configure({ version: '3.0.0' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('-V');

      expect(result.result as unknown as string).toBe('3.0.0');
    });

    it('should show version with --version on a subcommand, but keep -v for the root', () => {
      const program = createPadrone('test-cli')
        .configure({ version: '5.0.0' })
        .command('greet', (c) => c.action(() => 'hello'))
        .command('build', (c) =>
          c.arguments(z.object({ version: z.string().optional() })).action((args) => `build ${args.version ?? '-'}`),
        );

      expect(program.eval('greet --version').result as unknown as string).toBe('5.0.0');
      expect(program.eval('greet -v').argsResult?.issues?.[0]?.message).toBe('Unknown option "-v"');
      // A command's own --version option wins
      expect(program.eval('build --version 2').result as unknown as string).toBe('build 2');
    });

    it('should give remote callers the plain version for --verbose unless `remoteVerbose`', async () => {
      const make = (remoteVerbose?: boolean) =>
        createPadrone('test-cli', { builtins: { version: { remoteVerbose } } }).configure({ version: '6.0.0' });
      const runtime = { env: () => ({}), output: () => {} };
      expect((await make().eval('version --verbose', { runtime, caller: 'serve' })).result as unknown).toBe('6.0.0');
      expect(((await make(true).eval('version --verbose', { runtime, caller: 'serve' })).result as unknown as string).split('\n')[0]).toBe(
        'test-cli 6.0.0',
      );
    });

    it('should show runtime, platform and shell with version --verbose', async () => {
      const program = createPadrone('test-cli', { builtins: { version: { info: () => ({ Channel: 'beta', Skipped: undefined }) } } })
        .configure({ version: '6.0.0' })
        .command('greet', (c) => c.action(() => 'hello'));
      const runtime = { env: () => ({ SHELL: '/bin/zsh' }), output: () => {} };

      const text = (await program.eval('version --verbose', { runtime })).result as unknown as string;
      const lines = text.split('\n');
      expect(lines[0]).toBe('test-cli 6.0.0');
      expect(text).toMatch(new RegExp(`^Platform: +${process.platform}$`, 'm'));
      expect(text).toMatch(/^Shell: +zsh$/m);
      expect(text).toMatch(/^Channel: +beta$/m);
      expect(text).not.toContain('Skipped');
      expect(text).toMatch(/Runtime: +(Bun|Node\.js) /);

      expect((await program.eval('--version --verbose', { runtime })).result as unknown).toBe(text);

      const json = (await program.eval('version --verbose', { runtime: { ...runtime, format: 'json' } })).result;
      expect(json).toMatchObject({ name: 'test-cli', version: '6.0.0', arch: process.arch, shell: 'zsh', Channel: 'beta' });
    });

    it('should show version with version command', async () => {
      const program = createPadrone('test-cli')
        .configure({ version: '4.0.0' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = await program.eval('version');

      expect(result.result as unknown as string).toBe('4.0.0');
    });

    it('should auto-detect version from package.json when not explicitly set', async () => {
      const program = createPadrone('test-cli').command('greet', (c) => c.action(() => 'hello'));

      // Without explicit version, getVersion falls back to async package.json discovery
      const result = await program.eval('--version');
      expect(result.result as unknown as string).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should allow user to override help command', () => {
      const program = createPadrone('test-cli')
        .configure({ version: '1.0.0' })
        .command('help', (c) => c.action(() => 'Custom help!'))
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('help');

      expect(result.result).toBe('Custom help!');
    });

    it('should allow user to override version command', () => {
      const program = createPadrone('test-cli')
        .configure({ version: '1.0.0' })
        .command('version', (c) => c.action(() => 'Custom version info'))
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('version');

      expect(result.result).toBe('Custom version info');
    });

    it('should still show help with --help flag even when help command is overridden', () => {
      const program = createPadrone('test-cli')
        .configure({ version: '1.0.0' })
        .command('help', (c) => c.action(() => 'Custom help!'))
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('--help');

      // --help flag should still use built-in help
      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should set description on program', () => {
      const program = createPadrone('test-cli').configure({ description: 'My awesome CLI tool' });

      const result = program.eval('--help');

      expect(result.result as unknown as string).toContain('My awesome CLI tool');
    });

    it('should chain description and version', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'My awesome CLI tool', version: '5.0.0' })
        .command('greet', (c) => c.action(() => 'hello'));

      const helpResult = program.eval('--help');
      const versionResult = program.eval('--version');

      expect(helpResult.result as unknown as string).toContain('My awesome CLI tool');
      expect(versionResult.result as unknown as string).toBe('5.0.0');
    });

    it('should accept --detail flag for help', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'My CLI' })
        .command('greet', (c) => c.action(() => 'hello'));

      const minimalResult = program.eval('--help --detail=minimal');
      const standardResult = program.eval('--help --detail=standard');
      const fullResult = program.eval('--help --detail=full');

      // All should produce help output
      expect(minimalResult.result as unknown as string).toContain('test-cli');
      expect(standardResult.result as unknown as string).toContain('test-cli');
      expect(fullResult.result as unknown as string).toContain('test-cli');
    });

    it('should accept -d shorthand for detail flag', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'My CLI' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('--help -d full');

      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should accept detail flag with help command', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'My CLI' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('help --detail=full');

      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should accept detail flag for subcommand help', () => {
      const program = createPadrone('test-cli').command('greet', (c) =>
        c.arguments(z.object({ name: z.string().describe('Name') }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      );

      const result = program.eval('greet --help --detail=full');

      expect(result.result as unknown as string).toContain('greet');
    });

    it('should accept --format flag for help', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'My CLI' })
        .command('greet', (c) => c.action(() => 'hello'));

      const textResult = program.eval('--help --format=text');
      const markdownResult = program.eval('--help --format=markdown');
      const jsonResult = program.eval('--help --format=json');

      // All should produce help output
      expect(textResult.result as unknown as string).toContain('test-cli');
      expect(markdownResult.result as unknown as string).toContain('test-cli');
      expect(jsonResult.result as unknown as string).toContain('test-cli');
    });

    it('should accept -f shorthand for format flag', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'My CLI' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('--help -f markdown');

      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should accept format flag with help command', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'My CLI' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('help --format=json');

      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should combine format and detail flags', () => {
      const program = createPadrone('test-cli')
        .configure({ description: 'My CLI' })
        .command('greet', (c) => c.action(() => 'hello'));

      const result = program.eval('--help --format=markdown --detail=full');

      expect(result.result as unknown as string).toContain('test-cli');
    });

    it('should load config from --config flag', async () => {
      // Create a temp config file
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');

      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-test-'));
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ server: { port: 9999 } }));

      try {
        const program = createPadrone('test-cli').command('serve', (c) =>
          c
            .arguments(z.object({ port: z.coerce.number().optional() }))
            .extend(
              padroneConfig({
                files: ['config.json'],
                schema: z.object({ server: z.object({ port: z.number() }) }).transform((data) => ({ port: data.server.port })),
              }),
            )
            .action((args) => args?.port),
        );

        const result = await program.eval(`serve --config=${configPath}`);

        expect(result.result).toBe(9999);
      } finally {
        fs.unlinkSync(configPath);
        fs.rmdirSync(configDir);
      }
    });

    it('should load config from -c shorthand', async () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');

      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-test-'));
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ host: 'example.com' }));

      try {
        const program = createPadrone('test-cli').command('connect', (c) =>
          c
            .arguments(z.object({ host: z.string().optional() }))
            .extend(padroneConfig({ files: ['config.json'], schema: z.object({ host: z.string() }) }))
            .action((args) => args?.host),
        );

        const result = await program.eval(`connect -c ${configPath}`);

        expect(result.result).toBe('example.com');
      } finally {
        fs.unlinkSync(configPath);
        fs.rmdirSync(configDir);
      }
    });

    it('should allow CLI args to override config file values', async () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');

      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-test-'));
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ server: { port: 3000 } }));

      try {
        const program = createPadrone('test-cli').command('serve', (c) =>
          c
            .arguments(z.object({ port: z.coerce.number().optional() }))
            .extend(
              padroneConfig({
                files: ['config.json'],
                schema: z.object({ server: z.object({ port: z.number() }) }).transform((data) => ({ port: data.server.port })),
              }),
            )
            .action((args) => args?.port),
        );

        const result = await program.eval(`serve --config=${configPath} --port=8080`);

        // CLI arg should override config file
        expect(result.result).toBe(8080);
      } finally {
        fs.unlinkSync(configPath);
        fs.rmdirSync(configDir);
      }
    });
  });

  describe('XDG config directory support', () => {
    it('should load config from XDG directory when not found in cwd', async () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');

      // Create a fake XDG config dir
      const xdgBase = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-xdg-'));
      const appConfigDir = path.join(xdgBase, 'myapp');
      fs.mkdirSync(appConfigDir);
      fs.writeFileSync(path.join(appConfigDir, 'config.json'), JSON.stringify({ port: 4000 }));

      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = xdgBase;

      try {
        const program = createPadrone('myapp').command('serve', (c) =>
          c
            .arguments(z.object({ port: z.coerce.number().optional() }))
            .extend(padroneConfig({ files: ['config.json'], xdg: 'myapp' }))
            .action((args) => args?.port),
        );

        const result = await program.eval('serve');
        expect(result.result).toBe(4000);
      } finally {
        process.env.XDG_CONFIG_HOME = origXdg;
        fs.unlinkSync(path.join(appConfigDir, 'config.json'));
        fs.rmdirSync(appConfigDir);
        fs.rmdirSync(xdgBase);
      }
    });

    it('should not search XDG directory when xdg is false', async () => {
      const program = createPadrone('myapp').command('serve', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().optional() }))
          .extend(padroneConfig({ files: ['nonexistent.json'], xdg: false }))
          .action((args) => args?.port),
      );

      const result = await program.eval('serve');
      expect(result.result).toBeUndefined();
    });

    it('should pass xdgAppName to custom loadConfig', () => {
      let receivedXdgName: string | undefined;

      const program = createPadrone('myapp').command('serve', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().optional() }))
          .extend(
            padroneConfig({
              files: ['config.json'],
              xdg: 'my-cool-app',
              loadConfig: (_files, xdgAppName) => {
                receivedXdgName = xdgAppName;
                return { port: 5000 };
              },
            }),
          )
          .action((args) => args?.port),
      );

      program.eval('serve');
      expect(receivedXdgName).toBe('my-cool-app');
    });

    it('should derive app name from program name when xdg is true', async () => {
      let receivedXdgName: string | undefined;

      const program = createPadrone('my-cli-tool').command('serve', (c) =>
        c
          .arguments(z.object({ port: z.coerce.number().optional() }))
          .extend(
            padroneConfig({
              files: ['config.json'],
              xdg: true,
              loadConfig: (_files, xdgAppName) => {
                receivedXdgName = xdgAppName;
                return { port: 7000 };
              },
            }),
          )
          .action((args) => args?.port),
      );

      const result = await program.eval('serve');
      expect(receivedXdgName).toBe('my-cli-tool');
      expect(result.result).toBe(7000);
    });
  });

  describe('nested object args (dot notation)', () => {
    it('should parse --key.nested=value as nested object', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ user: z.object({ id: z.coerce.number() }).optional() })).action((args) => args),
      );

      const result = program.parse('test --user.id=123');

      expect(result.args?.user).toEqual({ id: 123 });
    });

    it('should parse deeply nested args', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ server: z.object({ database: z.object({ host: z.string() }) }).optional() })).action((args) => args),
      );

      const result = program.parse('test --server.database.host=localhost');

      expect(result.args?.server).toEqual({ database: { host: 'localhost' } });
    });

    it('should combine multiple nested args into same object', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ user: z.object({ name: z.string(), age: z.coerce.number() }).optional() })).action((args) => args),
      );

      const result = program.parse('test --user.name=John --user.age=30');

      expect(result.args?.user).toEqual({ name: 'John', age: 30 });
    });

    it('should handle nested boolean values', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ config: z.object({ debug: z.boolean() }).optional() })).action((args) => args),
      );

      const result = program.parse('test --config.debug');

      expect(result.args?.config).toEqual({ debug: true });
    });

    it('should handle negated nested boolean values', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ config: z.object({ debug: z.boolean().default(true) }).optional() })).action((args) => args),
      );

      const result = program.parse('test --no-config.debug');

      expect(result.args?.config).toEqual({ debug: false });
    });

    it('should stringify nested objects to dot notation', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ user: z.object({ id: z.number(), name: z.string() }).optional() })).action((args) => args),
      );

      const result = program.stringify('test', { user: { id: 123, name: 'John' } });

      expect(result).toContain('--user.id=123');
      expect(result).toContain('--user.name=John');
    });

    it('should stringify deeply nested objects', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ server: z.object({ db: z.object({ host: z.string() }) }).optional() })).action((args) => args),
      );

      const result = program.stringify('test', { server: { db: { host: 'localhost' } } });

      expect(result).toBe('test --server.db.host=localhost');
    });

    it('should roundtrip nested objects through stringify and parse', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ config: z.object({ port: z.coerce.number(), host: z.string() }).optional() })).action((args) => args),
      );

      const original = { config: { port: 8080, host: 'example.com' } };
      const stringified = program.stringify('test', original);
      const parsed = program.parse(stringified);

      expect('config' in parsed.args! && parsed.args?.config).toEqual(original.config);
    });

    it('should handle nested args with quoted string values', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ message: z.object({ text: z.string() }).optional() })).action((args) => args),
      );

      const result = program.parse('test --message.text="Hello World"');

      expect(result.args?.message).toEqual({ text: 'Hello World' });
    });

    it('should work with CLI execution', () => {
      const program = createPadrone('test-cli').command('test', (c) =>
        c.arguments(z.object({ settings: z.object({ verbose: z.boolean().default(false) }).optional() })).action((args) => args?.settings),
      );

      const result = program.eval('test --settings.verbose');

      expect(result.result).toEqual({ verbose: true });
    });
  });

  describe('validation errors', () => {
    it('should return result with issues when called with explicit input and arg fails url validation', () => {
      const handler = mock((args: any) => args);
      const program = createPadrone('test-cli').command('fetch', (c) =>
        c.arguments(z.object({ url: z.url().describe('URL to fetch') })).action(handler),
      );

      const result = program.eval('fetch --url not-a-valid-url');

      expect(result.argsResult?.issues).toBeDefined();
      expect(result.args).toBeUndefined();
      expect(result.result).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });

    it('should return result with issues for enum arg with invalid value', () => {
      const program = createPadrone('test-cli').command('cmd', (c) =>
        c.arguments(z.object({ priority: z.enum(['low', 'medium', 'high']).describe('Priority') })).action((args) => args),
      );

      const result = program.eval('cmd --priority invalid');

      expect(result.argsResult?.issues).toBeDefined();
      expect(result.args).toBeUndefined();
    });

    it('should not call action when validation fails with explicit input', () => {
      const handler = mock(() => 'called');
      const program = createPadrone('test-cli').command('fetch', (c) =>
        c.arguments(z.object({ url: z.url().describe('URL to fetch') })).action(handler),
      );

      program.eval('fetch --url not-a-valid-url');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should throw and print error when called without arguments and validation fails', () => {
      const originalArgv = process.argv;
      const errorSpy = mock();
      const originalError = console.error;
      console.error = errorSpy;
      process.argv = ['node', 'test-cli', 'fetch', '--url', 'not-a-valid-url'];

      try {
        const program = createPadrone('test-cli').command('fetch', (c) =>
          c.arguments(z.object({ url: z.url().describe('URL to fetch') })).action((args) => args),
        );

        const result = program.cli();
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toContain('Validation error:');
        expect(errorSpy).toHaveBeenCalledTimes(2);
      } finally {
        console.error = originalError;
        process.argv = originalArgv;
      }
    });

    it('should not throw when validation passes', () => {
      const program = createPadrone('test-cli').command('fetch', (c) =>
        c.arguments(z.object({ url: z.url().describe('URL to fetch') })).action((args) => args),
      );

      expect(() => program.eval('fetch --url https://example.com')).not.toThrow();
    });
  });

  describe('async validation', () => {
    it('should return a Promise when using asyncSchema()', async () => {
      const schema = asyncSchema(
        z.object({ name: z.string() }).check(async (_ctx) => {
          // async refinement
        }),
      );

      const program = createPadrone('test-async').command('greet', (c) => c.arguments(schema).action((args) => `Hello, ${args.name}!`));

      const parseResult = program.parse('greet --name Alice');
      expect(parseResult).toBeInstanceOf(Promise);
      const resolved = await parseResult;
      expect(resolved.args).toEqual({ name: 'Alice' });

      const cliResult = program.eval('greet --name Alice');
      expect(cliResult).toBeInstanceOf(Promise);
      const resolvedCli = await cliResult;
      expect(resolvedCli.result).toBe('Hello, Alice!');
    });

    it('should return a Promise when using .async()', async () => {
      const program = createPadrone('test-async').command('greet', (c) =>
        c
          .arguments(z.object({ name: z.string() }))
          .async()
          .action((args) => `Hello, ${args.name}!`),
      );

      const result = program.parse('greet --name Bob');
      // .async() marks the type as async, but if the schema is actually sync,
      // thenMaybe will return synchronously at runtime
      const resolved = await result;
      expect(resolved.args).toEqual({ name: 'Bob' });
    });

    it('should return sync value for non-async commands', () => {
      const program = createPadrone('test-sync').command('greet', (c) =>
        c.arguments(z.object({ name: z.string() })).action((args) => `Hello, ${args.name}!`),
      );

      const result = program.parse('greet --name Charlie');
      expect(result).not.toBeInstanceOf(Promise);
      expect((result as any).args).toEqual({ name: 'Charlie' });
    });

    it('should warn when validation returns Promise but command not marked async', async () => {
      const errorSpy = mock();
      const originalError = console.error;
      console.error = errorSpy;

      try {
        // Create a schema with async validation but DON'T brand it
        const schema = z.object({ name: z.string() }).check(async (_ctx) => {
          // async refinement without branding
        });

        const program = createPadrone('test-warn').command('greet', (c) =>
          c.arguments(schema as any).action((args: any) => `Hello, ${args.name}!`),
        );

        const result = program.parse('greet --name Alice');
        // Should still work, just with a warning via runtime.error
        if (result instanceof Promise) {
          await result;
          expect(errorSpy).toHaveBeenCalledTimes(1);
          expect(errorSpy.mock.calls[0]![0]).toContain('[padrone]');
          expect(errorSpy.mock.calls[0]![0]).toContain('not marked as async');
        }
      } finally {
        console.error = originalError;
      }
    });
  });
});

describe('padroneConfig file loader', () => {
  const program = createPadrone('test')
    .extend(padroneConfig())
    .arguments(z.object({ port: z.number().optional(), url: z.string().optional() }))
    .action((args) => args);
  const writeConfig = (name: string, content: string) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-config-')), name);
    fs.writeFileSync(file, content);
    return file;
  };

  it('reads JSON with comments and trailing commas', async () => {
    const file = writeConfig('app.jsonc', '{\n  // port\n  "port": 8080, /* url */ "url": "http://a//b",\n}');
    const result = await program.eval(['--config', file]);
    expect(result.args).toEqual({ port: 8080, url: 'http://a//b' });
  });

  it('fails when the --config file does not exist', async () => {
    const result = await program.eval(['--config', '/does/not/exist.json']);
    expect((result.error as Error).name).toBe('ConfigError');
    expect((result.error as Error).message).toBe('Config file not found: /does/not/exist.json');
  });

  it('fails on a config file that cannot be parsed', async () => {
    const file = writeConfig('app.json', '{ "port": ');
    const result = await program.eval(['--config', file]);
    expect((result.error as Error).name).toBe('ConfigError');
    expect((result.error as Error).message).toStartWith(`Invalid config file ${file}:`);
  });

  it('prints config errors in cli()', async () => {
    const errors: string[] = [];
    await program.cli({
      runtime: {
        argv: () => ['--config', '/does/not/exist.json'],
        output: () => {},
        error: (text) => errors.push(text),
        setExitCode: () => {},
      },
    });
    expect(errors).toEqual(['Config file not found: /does/not/exist.json']);
  });
});

describe('cli() runtime override', () => {
  it('reads argv from the cli() runtime', () => {
    const program = createPadrone('test')
      .runtime({ argv: () => ['a'], output: () => {} })
      .command('a', (c) => c.action(() => 'a'))
      .command('b', (c) => c.action(() => 'b'));
    expect(program.cli({ runtime: { argv: () => ['b'] } }).result).toBe('b');
  });
});

describe('padroneConfig search', () => {
  const inDir = async (dir: string, fn: () => unknown): Promise<{ result?: unknown }> => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      return (await fn()) as { result?: unknown };
    } finally {
      process.chdir(cwd);
    }
  };
  const projectWithSubdir = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-search-')));
    const sub = path.join(root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    return { root, sub };
  };
  const programWith = (options: Parameters<typeof padroneConfig>[0]) =>
    createPadrone('my-cli')
      .extend(padroneConfig(options))
      .arguments(z.object({ port: z.number().optional() }))
      .action((args) => args.port);

  it('finds a config file in a parent directory with searchParents', async () => {
    const { root, sub } = projectWithSubdir();
    fs.writeFileSync(path.join(root, '.myclirc.json'), '{ "port": 1 }');

    expect((await inDir(sub, () => programWith({ files: ['.myclirc.json'] }).eval(''))).result).toBeUndefined();
    expect((await inDir(sub, () => programWith({ files: ['.myclirc.json'], searchParents: true }).eval(''))).result).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads a package.json key, nearest directory first', async () => {
    const { root, sub } = projectWithSubdir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', 'my-cli': { port: 2 } }));
    fs.writeFileSync(path.join(sub, 'package.json'), JSON.stringify({ name: 'app' }));

    const result = await inDir(sub, () => programWith({ packageJson: true, searchParents: true }).eval(''));
    expect(result.result).toBe(2);

    fs.writeFileSync(path.join(sub, 'package.json'), JSON.stringify({ name: 'app', custom: { port: 3 } }));
    expect((await inDir(sub, () => programWith({ packageJson: 'custom' }).eval(''))).result).toBe(3);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('padroneConfig layering', () => {
  const inDir = async (dir: string, fn: () => unknown): Promise<{ result?: unknown; error?: unknown }> => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      return (await fn()) as { result?: unknown; error?: unknown };
    } finally {
      process.chdir(cwd);
    }
  };
  const schema = z.object({
    port: z.number().optional(),
    host: z.string().optional(),
    db: z.object({ user: z.string(), pool: z.number() }).partial().optional(),
  });
  const programWith = (options: Parameters<typeof padroneConfig>[0]) =>
    createPadrone('my-cli')
      .extend(padroneConfig(options))
      .arguments(schema)
      .action((args) => args);

  it('merges every config found with merge: true, nearest winning', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-merge-')));
    const sub = path.join(root, 'app');
    const xdg = path.join(root, 'xdg');
    fs.mkdirSync(sub);
    fs.mkdirSync(path.join(xdg, 'my-cli'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'my-cli', 'config.json'), JSON.stringify({ host: 'user', port: 1, db: { user: 'me' } }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ port: 2, db: { pool: 5 } }));
    fs.writeFileSync(path.join(sub, 'config.json'), JSON.stringify({ port: 3 }));
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const options = { files: ['config.json'], searchParents: true, xdg: true };
      expect((await inDir(sub, () => programWith({ ...options, merge: true }).eval(''))).result).toEqual({
        host: 'user',
        port: 3,
        db: { user: 'me', pool: 5 },
      });
      expect((await inDir(sub, () => programWith(options).eval(''))).result).toEqual({ port: 3 });
    } finally {
      process.env.XDG_CONFIG_HOME = origXdg;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows extends, relative to the extending file', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-extends-')));
    fs.mkdirSync(path.join(root, 'shared'));
    fs.writeFileSync(path.join(root, 'shared', 'base.json'), JSON.stringify({ host: 'base', port: 1, db: { user: 'base', pool: 1 } }));
    fs.writeFileSync(path.join(root, 'shared', 'team.json'), JSON.stringify({ extends: './base.json', db: { pool: 2 } }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ extends: ['./shared/team.json'], port: 3 }));
    try {
      expect((await inDir(root, () => programWith({ files: ['config.json'] }).eval(''))).result).toEqual({
        host: 'base',
        port: 3,
        db: { user: 'base', pool: 2 },
      });

      fs.writeFileSync(path.join(root, 'shared', 'base.json'), JSON.stringify({ extends: '../config.json' }));
      const { error } = await inDir(root, () => programWith({ files: ['config.json'] }).eval(''));
      expect((error as Error).message).toStartWith('Circular config extends:');

      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ extends: './missing.json' }));
      const missing = await inDir(root, () => programWith({ files: ['config.json'] }).eval(''));
      expect((missing.error as Error).message).toStartWith('Config file not found: ./missing.json (extended by');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
