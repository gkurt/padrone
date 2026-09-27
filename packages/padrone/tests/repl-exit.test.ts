import { describe, expect, it } from 'bun:test';
import { buildReplCompleter, createPadrone } from 'padrone';
import * as z from 'zod/v4';

const readLineOf = (inputs: string[]) => {
  let i = 0;
  return async () => inputs[i++] ?? null;
};

async function runRepl(program: { repl: (opts: any) => AsyncIterable<{ result?: unknown }> }) {
  const results: unknown[] = [];
  for await (const r of program.repl({ greeting: false, hint: false })) results.push(r.result);
  return results;
}

describe('REPL exit and quit', () => {
  it('bare exit and quit end the REPL', async () => {
    for (const word of ['exit', 'quit', '  exit  ']) {
      const program = createPadrone('app')
        .runtime({ readLine: readLineOf(['greet', word, 'greet']), output: () => {}, error: () => {} })
        .command('greet', (c) => c.action(() => 'hi'));
      expect(await runRepl(program)).toEqual(['hi']);
    }
  });

  it('a command named exit runs instead', async () => {
    const program = createPadrone('app')
      .runtime({ readLine: readLineOf(['exit', 'quit', 'exit']), output: () => {}, error: () => {} })
      .command('exit', (c) => c.action(() => 'custom exit'));
    expect(await runRepl(program)).toEqual(['custom exit']);
  });

  it('exit with arguments goes through routing', async () => {
    const errors: string[] = [];
    const program = createPadrone('app')
      .runtime({ readLine: readLineOf(['exit now', 'greet']), output: () => {}, error: (e) => void errors.push(String(e)) })
      .command('greet', (c) => c.action(() => 'hi'));
    expect(await runRepl(program)).toContain('hi');
    expect(errors.join('\n')).toContain('exit');
  });
});

describe('REPL tab completion', () => {
  const program = createPadrone('app')
    .command('deploy', (c) =>
      c
        .arguments(
          z.object({
            dryRun: z.boolean().optional(),
            secret: z.string().optional(),
            oldRegion: z.string().optional(),
          }),
          { fields: { secret: { hidden: true }, oldRegion: { deprecated: true } } },
        )
        .action(() => 'ok'),
    )
    .command('legacy', (c) => c.configure({ deprecated: true }).action(() => 'old'))
    .command('list', (c) => c.action(() => []));
  const completer = buildReplCompleter((program as any).runtime({ argv: () => [] }).parse().command, {});

  it('offers kebab-case names and hides hidden and deprecated options', () => {
    const [hits] = completer('deploy --');
    expect(hits).toContain('--dry-run');
    expect(hits).not.toContain('--dryRun');
    expect(hits).not.toContain('--secret');
    expect(hits).not.toContain('--old-region');
  });

  it('offers a deprecated option only when nothing else matches', () => {
    expect(completer('deploy --old')[0]).toEqual(['--old-region']);
  });

  it('hides deprecated commands unless only they match', () => {
    expect(completer('')[0]).not.toContain('legacy');
    expect(completer('le')[0]).toEqual(['legacy']);
    expect(completer('li')[0]).toEqual(['list']);
  });
});
