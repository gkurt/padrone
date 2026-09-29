import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneAutoOutput, padroneFormat } from 'padrone';
import { renderKeyValue, renderList, renderTable, renderTree } from '#src/output/primitives.ts';
import type { OutputContext } from '#src/output/styling.ts';
import { createAnsiStyler, createTextLayout, createTextStyler, shouldUseAnsi } from '#src/output/styling.ts';
import { compileJq } from '#src/util/jq.ts';
import { toYaml } from '#src/util/yaml.ts';

const ctxFor = (format: OutputContext['format']): OutputContext => ({
  format,
  styler: format === 'ansi' ? createAnsiStyler() : createTextStyler(),
  layout: createTextLayout(),
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

const capture = () => {
  const output: unknown[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: { output: (...args: unknown[]) => output.push(...args), error: (text: string) => errors.push(text), setExitCode: () => {} },
  };
};

describe('table primitive', () => {
  it('pads wide characters and emoji by their display width', () => {
    const data = [
      { name: '日本語', n: 1 },
      { name: 'ok ✅', n: 2 },
      { name: 'x', n: 3 },
    ];
    const lines = renderTable(data, undefined, ctxFor('text')).split('\n');
    expect(lines).toEqual([' name   │ n', '────────┼───', ' 日本語 │ 1', ' ok ✅  │ 2', ' x      │ 3']);
  });

  it('measures cells that are already colored without their escape codes', () => {
    const lines = renderTable([{ a: '\x1b[31mred\x1b[0m' }, { a: 'plain' }], { border: false }, ctxFor('text')).split('\n');
    expect(lines.map(stripAnsi)).toEqual(['a', 'red', 'plain']);
  });

  it('truncates by display width without splitting characters', () => {
    const lines = renderTable([{ a: '日本語テキスト' }, { a: '😀😀😀😀' }], { maxColumnWidth: 5, border: false }, ctxFor('text')).split(
      '\n',
    );
    expect(lines).toEqual(['a', '日本…', '😀😀…']);
  });

  it('prints dates and bigints as plain values', () => {
    const table = renderTable([{ at: new Date(0), n: 10n }], { border: false }, ctxFor('text'));
    expect(table.split('\n')[1]).toBe('1970-01-01T00:00:00.000Z  10');
    expect(renderKeyValue({ n: 10n }, undefined, ctxFor('text'))).toBe('n: 10');
    expect(JSON.parse(renderTable([{ n: 10n }], undefined, ctxFor('json')))).toEqual([{ n: '10' }]);
  });

  it('renders a valid Markdown table: hyphen delimiter row and escaped pipes', () => {
    const table = renderTable([{ a: 'x|y', b: 1 }], { align: { b: 'right' } }, ctxFor('markdown'));
    expect(table).toBe('| a    | b   |\n| ---- | --: |\n| x\\|y | 1   |');
  });

  it('renders empty data as empty JSON under JSON output', () => {
    expect(renderTable([], undefined, ctxFor('json'))).toBe('[]');
    expect(renderList([], undefined, ctxFor('json'))).toBe('[]');
    expect(renderTree([], undefined, ctxFor('json'))).toBe('[]');
    expect(renderKeyValue({}, undefined, ctxFor('json'))).toBe('{}');
  });
});

describe('declarative output', () => {
  it("streams a generator's items under output: 'json' instead of printing {}", () => {
    const { output, runtime } = capture();
    const program = createPadrone('app').command('list', (c) =>
      c.extend(padroneAutoOutput({ output: 'json' })).action(function* () {
        yield { id: 1 };
        yield { id: 2 };
      }),
    );
    const res = program.eval('list', { runtime });
    expect(res.result as unknown).toEqual([{ id: 1 }, { id: 2 }]);
    expect(output).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("prints a non-object result as text under output: 'tree'", () => {
    const { output, runtime } = capture();
    createPadrone('app')
      .command('x', (c) => c.extend(padroneAutoOutput({ output: 'tree' })).action(() => 'hello'))
      .eval('x', { runtime });
    expect(output).toEqual(['hello']);
  });

  it("prints bigints under output: 'json'", () => {
    const { output, errors, runtime } = capture();
    createPadrone('app')
      .command('x', (c) => c.extend(padroneAutoOutput({ output: 'json' })).action(() => ({ n: 1n })))
      .cli({ runtime: { ...runtime, argv: () => ['x'] } });
    expect(errors).toEqual([]);
    expect(output).toEqual([JSON.stringify({ n: '1' }, null, 2)]);
  });
});

describe('-o yaml', () => {
  it('prints text results, such as help and the version, as text', () => {
    const program = createPadrone('app')
      .configure({ version: '1.2.3' })
      .extend(padroneFormat())
      .command('greet', (c) => c.action(() => 'hello:\nworld'));
    const run = (input: string) => {
      const { output, runtime } = capture();
      program.eval(input, { runtime });
      return output;
    };
    expect(run('greet -o yaml')).toEqual(['hello:\nworld']);
    expect(run('--version -o yaml')).toEqual(['1.2.3']);
    expect(run('greet --help -o yaml')[0]).toStartWith('Usage: app greet');
  });
});

describe('toYaml', () => {
  it('quotes strings a YAML parser reads as numbers or a document end', () => {
    for (const text of ['.5', '.5e3', '...']) expect(toYaml(text)).toBe(JSON.stringify(text));
    const value = { a: '.5', b: ['.25', '...'] };
    expect(Bun.YAML.parse(toYaml(value))).toEqual(value);
  });
});

describe('jq subset', () => {
  const jq = (expression: string, input: unknown) => compileJq(expression)(input);

  it('slices strings by code point, like length counts them', () => {
    expect(jq('.[1:2], .[-1:], length', 'a😀b')).toEqual(['😀', 'b', 3]);
  });

  it('only changes ASCII letters in ascii_downcase / ascii_upcase', () => {
    expect(jq('ascii_upcase, ascii_downcase', 'éa É')).toEqual(['éA É', 'éa É']);
  });

  it('orders comparison outputs like jq (the right side varies slowest)', () => {
    expect(jq('(1,2) < (2,3)', null)).toEqual([true, false, true, true]);
  });
});

describe('colors', () => {
  const formatAfter = (flag: string) => {
    const { runtime } = capture();
    return createPadrone('app')
      .command('x', (c) => c.action((_args, ctx) => ctx.runtime.format))
      .eval(`x ${flag}`, { runtime: { ...runtime, format: 'auto', terminal: { isTTY: true } } }).result;
  };

  it('reads --color keywords case-insensitively', () => {
    expect(formatAfter('--color=NEVER')).toBe('text');
    expect(formatAfter('--color=Auto')).toBe('auto');
    expect(formatAfter('--color=Always')).toBe('ansi');
  });

  it('turns colors off for TERM=dumb unless FORCE_COLOR is set', () => {
    expect(shouldUseAnsi({ TERM: 'dumb' }, true)).toBe(false);
    expect(shouldUseAnsi({ TERM: 'dumb', FORCE_COLOR: '1' }, true)).toBe(true);
    expect(shouldUseAnsi({ TERM: 'xterm-256color' }, true)).toBe(true);
  });
});
