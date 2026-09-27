import { describe, expect, it } from 'bun:test';
import { createPadrone, defineInterceptor, padroneConfirm, padroneJson } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol } from '../src/core/commands.ts';
import { createMcpHandler } from '../src/feature/mcp.ts';

const quiet = { output: () => {}, error: () => {} };

function createProgram() {
  const deleted: string[] = [];
  const program = createPadrone('files')
    .command('rm', (c) =>
      c
        .configure({ mutation: true, description: 'Delete files' })
        .arguments(z.object({ paths: z.string().array().min(1), force: z.boolean().optional() }), { positional: ['...paths'] })
        .action((args) => {
          deleted.push(...args.paths);
          return `deleted ${args.paths.length}`;
        })
        .dryRun((args) => args.paths.map((path) => `delete ${path}`)),
    )
    .command('touch', (c) =>
      c
        .configure({ mutation: true })
        .arguments(z.object({ path: z.string() }), { positional: ['path'] })
        .action((args) => {
          deleted.push(`touched ${args.path}`);
        }),
    );
  return { program, deleted };
}

describe('dry-run', () => {
  it('runs the dry-run handler instead of the action with --dry-run or -n', () => {
    const { program, deleted } = createProgram();
    expect(program.eval('rm a b --dry-run', { runtime: quiet }).result).toEqual(['delete a', 'delete b']);
    expect(program.eval('rm a -n', { runtime: quiet }).result).toEqual(['delete a']);
    expect(deleted).toEqual([]);

    expect(program.eval('rm a --no-dry-run', { runtime: quiet }).result).toBe('deleted 1');
    expect(deleted).toEqual(['a']);
  });

  it('rejects --dry-run on commands without a dry-run handler, without running them', () => {
    const { program, deleted } = createProgram();
    const result = program.eval('touch x --dry-run', { runtime: quiet });
    expect(result.argsResult?.issues?.[0]?.message).toStartWith('Unknown option: "dry-run"');
    expect(program.eval('touch x -n', { runtime: quiet }).argsResult?.issues).toBeDefined();
    expect(deleted).toEqual([]);
  });

  it('validates arguments before the dry-run handler', () => {
    let called = false;
    const program = createPadrone('app').command('rm', (c) =>
      c
        .arguments(z.object({ paths: z.string().array().min(1) }), { positional: ['...paths'] })
        .dryRun(() => {
          called = true;
        })
        .action(() => {}),
    );
    expect(program.eval('rm --dry-run', { runtime: quiet }).argsResult?.issues).toBeDefined();
    expect(called).toBe(false);
  });

  it("leaves the flag to a command's own dryRun option or -n flag", () => {
    const own = createPadrone('app').command('sync', (c) =>
      c
        .arguments(z.object({ dryRun: z.boolean().optional() }))
        .dryRun(() => 'framework')
        .action((args) => `own ${args.dryRun}`),
    );
    expect(own.eval('sync --dry-run', { runtime: quiet }).result).toBe('own true');

    const shortTaken = createPadrone('app').command('sync', (c) =>
      c
        .arguments(z.object({ number: z.coerce.number().optional() }), { fields: { number: { flags: 'n' } } })
        .dryRun(() => 'dry')
        .action((args) => `number ${args.number}`),
    );
    expect(shortTaken.eval('sync -n 3', { runtime: quiet }).result).toBe('number 3');
    expect(shortTaken.eval('sync --dry-run', { runtime: quiet }).result).toBe('dry');
  });

  it('shows --dry-run in help only for commands with a dry-run handler', () => {
    const { program } = createProgram();
    expect(program.help('rm', { format: 'text' })).toMatch(/-n, --dry-run +Show what would change without changing anything/);
    expect(program.help('touch', { format: 'text' })).not.toContain('dry-run');
  });

  it('runs execute interceptors with ctx.dryRun and their context, and skips confirmation', async () => {
    const seen: unknown[] = [];
    const db = defineInterceptor({ name: 'db' }, () => ({
      execute: (ctx, next) => {
        seen.push(ctx.dryRun);
        return next({ context: { db: { count: () => 3 } } });
      },
    })).provides<{ db: { count: () => number } }>();
    const program = createPadrone('app')
      .extend(padroneConfirm())
      .intercept(db)
      .command('purge', (c) =>
        c
          .configure({ mutation: true })
          .action(() => 'purged')
          .dryRun((_args, ctx) => `would purge ${ctx.context.db.count()} rows`),
      );

    // No terminal: confirm would fail without --yes, but a dry run needs no confirmation
    const result = await program.cli({
      runtime: { ...quiet, argv: () => ['purge', '--dry-run'], interactive: 'unsupported', setExitCode: () => {} },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('would purge 3 rows');
    expect(seen).toEqual([true]);
  });

  it('prints the result as JSON under --json', () => {
    const output: unknown[] = [];
    const { program } = createProgram();
    program.extend(padroneJson()).eval('rm a --dry-run --json', { runtime: { ...quiet, output: (...args) => output.push(...args) } });
    expect(output).toEqual([JSON.stringify(['delete a'], null, 2)]);
  });

  it('reports dryRun from parse(), and tool() needs no approval for a dry run', async () => {
    const { program } = createProgram();
    expect((await program.parse('rm a -n')).dryRun).toBe(true);
    expect((await program.parse('rm a')).dryRun).toBeUndefined();
    const needsApproval = program.tool().needsApproval as (input: { command: string }) => Promise<boolean>;
    expect(await needsApproval({ command: 'rm a' })).toBe(true);
    expect(await needsApproval({ command: 'rm a --dry-run' })).toBe(false);
  });

  it('takes dryRun as an MCP tool argument on commands with a dry-run handler', async () => {
    const { program, deleted } = createProgram();
    const handler = createMcpHandler((program as any)[commandSymbol], program.eval.bind(program) as any);
    const list = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (list!.result as any).tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    expect(tools.find((t) => t.name === 'rm')!.inputSchema.properties.dryRun).toEqual({ type: 'boolean', description: expect.any(String) });
    expect(tools.find((t) => t.name === 'touch')!.inputSchema.properties.dryRun).toBeUndefined();

    const call = await handler({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'rm', arguments: { paths: ['a'], dryRun: true } },
    });
    expect((call!.result as any).isError).toBe(false);
    expect(deleted).toEqual([]);
  });
});
