import { describe, expect, it } from 'bun:test';
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const argsOf = (result: { args?: unknown }) => result.args as Record<string, unknown> | undefined;
const issuesOf = (result: { argsResult?: { issues?: readonly { message: string }[] } }) => result.argsResult?.issues?.map((i) => i.message);

function createProgram() {
  return createPadrone('app').command('run', (c) =>
    c
      .arguments(
        z.object({
          file: z.string().optional(),
          verbose: z.number().default(0).meta({ flags: 'v', count: true }),
          quiet: z.boolean().optional().meta({ flags: 'q', conflicts: 'verbose' }),
          json: z
            .boolean()
            .optional()
            .meta({ conflicts: ['table', 'color'], implies: { color: false } }),
          table: z.boolean().optional(),
          color: z.boolean().optional(),
          ci: z.boolean().optional(),
          level: z.enum(['low', 'high']).optional(),
        }),
        { positional: ['file'], fields: { ci: { implies: { color: false, level: 'high' } } } },
      )
      .action((args) => args),
  );
}

describe('counting flags', () => {
  it('counts repeated short flags, stacked or separate', () => {
    expect(argsOf(createProgram().eval(['run', '-vvv']))?.verbose).toBe(3);
    expect(argsOf(createProgram().eval(['run', '-v', '-v', '--verbose']))?.verbose).toBe(3);
  });

  it('never takes the next token as a value', () => {
    expect(createProgram().eval(['run', '-vv', 'x.txt']).args).toMatchObject({ verbose: 2, file: 'x.txt' });
    expect(createProgram().eval(['run', '--verbose', '5']).args).toMatchObject({ verbose: 1, file: '5' });
  });

  it('accepts an explicit count and a reset', () => {
    expect(argsOf(createProgram().eval(['run', '--verbose=5']))?.verbose).toBe(5);
    expect(argsOf(createProgram().eval(['run', '-vv', '--no-verbose']))?.verbose).toBe(0);
  });

  it('uses the schema default when absent', () => {
    expect(argsOf(createProgram().eval(['run']))?.verbose).toBe(0);
  });
});

describe('conflicting options', () => {
  it('rejects options used together', () => {
    const result = createProgram().eval(['run', '-q', '-v']);
    expect(result.args).toBeUndefined();
    expect(issuesOf(result)).toEqual(['Option "--quiet" cannot be used with "--verbose"']);
  });

  it('reports each pair once, whichever side declares it', () => {
    expect(issuesOf(createProgram().eval(['run', '--json', '--table', '--color']))).toEqual([
      'Option "--json" cannot be used with "--table"',
      'Option "--json" cannot be used with "--color"',
    ]);
  });

  it('allows either option alone, and ignores defaults', () => {
    expect(createProgram().eval(['run', '-q']).args).toMatchObject({ quiet: true, verbose: 0 });
  });

  it('counts an explicit false as provided', () => {
    expect(issuesOf(createProgram().eval(['run', '--json', '--no-table']))).toEqual(['Option "--json" cannot be used with "--table"']);
  });
});

describe('implied options', () => {
  it('sets implied values', () => {
    expect(createProgram().eval(['run', '--ci']).args).toMatchObject({ ci: true, color: false, level: 'high' });
  });

  it('keeps explicit values', () => {
    expect(createProgram().eval(['run', '--ci', '--level', 'low']).args).toMatchObject({ level: 'low', color: false });
  });

  it('does not treat implied values as conflicts', () => {
    // --json implies color=false and conflicts with --color: only an explicit --color conflicts
    expect(createProgram().eval(['run', '--json']).args).toMatchObject({ json: true, color: false });
  });

  it('does nothing when the option is false', () => {
    expect(createProgram().eval(['run', '--no-ci']).args).toEqual({ ci: false, verbose: 0 });
  });
});

describe('help', () => {
  it('shows repeatable, conflicts and implies notes', () => {
    const help = createProgram().help('run');
    expect(help).toContain('(repeatable)');
    expect(help).toContain('(conflicts with --verbose)');
    expect(help).toContain('(conflicts with --table, --color)');
    expect(help).toContain('(implies --no-color, --level=high)');
  });
});
