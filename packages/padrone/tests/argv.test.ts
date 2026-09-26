import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';
import { parseCliInputToParts } from '../src/core/parse.ts';

const schema = z.object({
  family: z.string().optional(),
  chars: z.union([z.boolean(), z.string()]).default(false).meta({ flags: 'c' }),
  s: z.string().optional().meta({ flags: 's' }),
  n: z.number().optional(),
});

function createProgram(argv: string[], exitCodes: number[] = []) {
  return createPadrone('t')
    .runtime({ argv: () => argv, output: () => {}, error: () => {}, setExitCode: (code) => exitCodes.push(code) })
    .command('g', (c) => c.arguments(schema, { positional: ['family'] }).action((args) => args))
    .command('fail', (c) =>
      c.action(() => {
        throw new Error('boom');
      }),
    )
    .command('stream', (c) =>
      c.action(async function* () {
        yield 1;
        throw new Error('late boom');
      }),
    );
}

const argsOf = (argv: string[]) => {
  const result = createProgram(argv).cli();
  expect(result.error).toBeUndefined();
  return result.result as z.output<typeof schema>;
};

describe('parseCliInputToParts with argv', () => {
  it('takes every argv entry as exactly one token', () => {
    expect(parseCliInputToParts(['g', 'Dancing Script', '-c', 'Hello Wrd'])).toEqual([
      { type: 'term', value: 'g' },
      { type: 'arg', value: 'Dancing Script' },
      { type: 'alias', key: ['c'], value: 'Hello Wrd' },
    ]);
  });

  it('keeps quotes in a --flag=value entry as typed', () => {
    expect(parseCliInputToParts(['--name="quoted"'])).toEqual([{ type: 'named', key: ['name'], value: '"quoted"' }]);
  });

  it('keeps an empty entry as the empty value', () => {
    expect(parseCliInputToParts(['-c', ''])).toEqual([{ type: 'alias', key: ['c'], value: '' }]);
  });

  it('still tokenizes a string', () => {
    expect(parseCliInputToParts('g "Dancing Script" -c "Hello Wrd"')).toEqual([
      { type: 'term', value: 'g' },
      { type: 'arg', value: 'Dancing Script' },
      { type: 'alias', key: ['c'], value: 'Hello Wrd' },
    ]);
  });
});

describe('cli() argv', () => {
  it('keeps a positional with spaces whole', () => {
    expect(argsOf(['g', 'Dancing Script'])).toEqual({ family: 'Dancing Script', chars: false });
  });

  it('keeps short flag values with spaces whole', () => {
    expect(argsOf(['g', 'Dancing Script', '-c', 'Hello Wrd'])).toEqual({ family: 'Dancing Script', chars: 'Hello Wrd' });
    expect(argsOf(['g', '-s', 'Hello Wrd'])).toEqual({ chars: false, s: 'Hello Wrd' });
  });

  it('keeps long flag values with spaces whole', () => {
    expect(argsOf(['g', '--chars', 'Hello Wrd'])).toEqual({ chars: 'Hello Wrd' });
    expect(argsOf(['g', '--chars=Hello Wrd'])).toEqual({ chars: 'Hello Wrd' });
  });

  it('passes quotes and backslashes through as typed', () => {
    for (const value of ['say "hi"', "it's", 'C:\\path\\to', '\\"', '"quoted"', "'single'", 'a\\ b']) {
      expect(argsOf(['g', value, '-c', value, `--s=${value}`])).toEqual({ family: value, chars: value, s: value });
    }
  });

  it('keeps = and non-ASCII text inside a value', () => {
    expect(argsOf(['g', 'a=b', '-c', 'x=1 y=2', '--s=k=v'])).toEqual({ family: 'a=b', chars: 'x=1 y=2', s: 'k=v' });
    expect(argsOf(['g', 'Noto Sans 日本語', '-c', 'שלום עולם', '--s=Ünïcödé ✓'])).toEqual({
      family: 'Noto Sans 日本語',
      chars: 'שלום עולם',
      s: 'Ünïcödé ✓',
    });
  });

  it('takes an explicit empty entry as the empty string', () => {
    expect(argsOf(['g', '-c', ''])).toEqual({ chars: '' });
    expect(argsOf(['g', '--chars', ''])).toEqual({ chars: '' });
    expect(argsOf(['g', '--chars='])).toEqual({ chars: '' });
    expect(argsOf(['g', ''])).toEqual({ family: '', chars: false });
  });

  it('a boolean | string flag without a value is still true', () => {
    expect(argsOf(['g', '-c'])).toEqual({ chars: true });
  });
});

describe('cli() exit code', () => {
  const exitCodesOf = async (argv: string[]) => {
    const exitCodes: number[] = [];
    await createProgram(argv, exitCodes).cli().drain();
    return exitCodes;
  };

  it('is 1 when the action throws', async () => {
    expect(await exitCodesOf(['fail'])).toEqual([1]);
  });

  it('is 1 for a validation error', async () => {
    expect(await exitCodesOf(['g', '--n', 'abc'])).toEqual([1]);
  });

  it('is 1 for a routing error', async () => {
    expect(await exitCodesOf(['nope'])).toEqual([1]);
  });

  it('is 1 when the error only surfaces on drain', async () => {
    expect(await exitCodesOf(['stream'])).toEqual([1]);
  });

  it("takes the error's own exitCode", async () => {
    const exitCodes: number[] = [];
    const { PadroneError } = await import('padrone');
    await createPadrone('t')
      .runtime({ argv: () => ['x'], output: () => {}, error: () => {}, setExitCode: (code) => exitCodes.push(code) })
      .command('x', (c) =>
        c.action(() => {
          throw new PadroneError('nope', { exitCode: 3 });
        }),
      )
      .cli()
      .drain();
    expect(exitCodes).toEqual([3]);
  });

  it('is left alone on success, --help and --version', async () => {
    expect(await exitCodesOf(['g', 'Caveat'])).toEqual([]);
    expect(await exitCodesOf(['--help'])).toEqual([]);
    expect(await exitCodesOf(['g', '--help'])).toEqual([]);
    expect(await exitCodesOf(['--version'])).toEqual([]);
  });

  it('is not set by eval()', async () => {
    const exitCodes: number[] = [];
    await createProgram([], exitCodes).eval('fail').drain();
    expect(exitCodes).toEqual([]);
  });
});

describe('cli() in a subprocess', () => {
  const fixture = join(import.meta.dir, 'fixtures/argv-program.ts');
  const run = (...argv: string[]) => {
    const proc = Bun.spawnSync([process.execPath, '--conditions=padrone@dev', fixture, ...argv], {
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString().trim() };
  };

  it('keeps arguments with spaces whole', () => {
    const { exitCode, stdout } = run('g', 'Dancing Script', '-c', 'Hello Wrd');
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ family: 'Dancing Script', chars: 'Hello Wrd' });
    expect(JSON.parse(run('g', '-s', 'Hello Wrd').stdout)).toEqual({ chars: false, s: 'Hello Wrd' });
    expect(JSON.parse(run('g', '--chars=Hello Wrd').stdout)).toEqual({ chars: 'Hello Wrd' });
  });

  it('passes quotes and backslashes through as typed', () => {
    const value = `say "hi" it's C:\\dir\\`;
    expect(JSON.parse(run('g', value, '-c', value).stdout)).toEqual({ family: value, chars: value });
  });

  it('exits 1 when the action throws', () => {
    expect(run('fail').exitCode).toBe(1);
  });

  it('exits 1 for a validation error', () => {
    expect(run('g', '--n', 'abc').exitCode).toBe(1);
  });

  it('exits 0 on success and for --help', () => {
    expect(run('g', 'Caveat').exitCode).toBe(0);
    expect(run('--help').exitCode).toBe(0);
  });
});
