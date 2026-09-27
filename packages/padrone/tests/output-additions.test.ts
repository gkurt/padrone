import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneFormat, padroneJson } from 'padrone';
import { renderTable } from '#src/output/primitives.ts';
import { createTextLayout, createTextStyler, shouldUseAnsi } from '#src/output/styling.ts';
import { compileJq } from '#src/util/jq.ts';

const jq = (expression: string, input: unknown = null) => compileJq(expression)(input);

const capture = (isTTY?: boolean) => {
  const output: unknown[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: {
      output: (...args: unknown[]) => output.push(...args),
      error: (text: string) => errors.push(text),
      setExitCode: () => {},
      terminal: { isTTY },
    },
  };
};

const users = [
  { id: 2, name: 'Bob', note: 'first\nsecond' },
  { id: 1, name: 'Alice', note: 'one' },
];

describe('jq: if, variables and arithmetic', () => {
  it('evaluates if/then/elif/else/end', () => {
    expect(jq('if . > 1 then "big" elif . == 1 then "one" else "small" end', 2)).toEqual(['big']);
    expect(jq('.[] | if . > 1 then "big" elif . == 1 then "one" else "small" end', [2, 1, 0])).toEqual(['big', 'one', 'small']);
    expect(jq('if . then 1 end', null)).toEqual([null]);
    expect(jq('if (true, false) then 1 else 2 end')).toEqual([1, 2]);
    expect(() => compileJq('if true then 1 else 2')).toThrow('Expected "end"');
  });

  it('binds variables with `as`', () => {
    expect(jq('.[0] as $x | .[1] as $y | [$x, $y, $x * $y]', [3, 4])).toEqual([[3, 4, 12]]);
    expect(jq('.[] as $x | select($x > 1) | $x * 10', [1, 2, 3])).toEqual([20, 30]);
    expect(jq('1, 2 as $x | $x')).toEqual([1, 2]);
    expect(jq('. as $x | {$x, y: $x.a}', { a: 1 })).toEqual([{ x: { a: 1 }, y: 1 }]);
    expect(jq('map(. as $v | $v + 1)', [1, 2])).toEqual([[2, 3]]);
    expect(() => compileJq('$nope')).toThrow('$nope is not defined');
  });

  it('does arithmetic with jq semantics and precedence', () => {
    expect(jq('1 + 2 * 3, (1 + 2) * 3, 10 - 2 - 3, -1 + 2, 10 / 4, 5 % 2, -5 % 2, 5.5 % 2')).toEqual([7, 9, 5, 1, 2.5, 1, -1, 1]);
    expect(jq('(1, 2) + (10, 20)')).toEqual([11, 12, 21, 22]);
    expect(jq('null + 1, "a" + "b", [1] + [2], {a: 1} + {b: 2}')).toEqual([1, 'ab', [1, 2], { a: 1, b: 2 }]);
    expect(jq('[1, 2, 3, 2] - [2], "ab" * 2, 2 * "ab", "ab" * -1, "a,b" / ","')).toEqual([[1, 3], 'abab', 'abab', null, ['a', 'b']]);
    expect(jq('{a: {b: 1}} * {a: {c: 2}}')).toEqual([{ a: { b: 1, c: 2 } }]);
    expect(jq('map(.age) | add / length', [{ age: 2 }, { age: 4 }])).toEqual([3]);
    expect(jq('1 + 1 == 2 and true')).toEqual([true]);
    expect(() => jq('1 + "a"')).toThrow('number (1) and string ("a") cannot be added');
    expect(() => jq('{} - 1')).toThrow('object ({}) and number (1) cannot be subtracted');
    expect(() => jq('1 / 0')).toThrow('cannot be divided because the divisor is zero');
    expect(() => jq('-"a"')).toThrow('string ("a") cannot be negated');
  });
});

describe('jq: builtins', () => {
  const people = [
    { name: 'ann', age: 31, team: 'b' },
    { name: 'bob', age: 25, team: 'a' },
    { name: 'cy', age: 31, team: 'a' },
  ];

  it('finds extremes, groups and dedupes', () => {
    expect(jq('min, max', [3, 1, 2])).toEqual([1, 3]);
    expect(jq('min, max', [])).toEqual([null, null]);
    expect(jq('min_by(.age).name, max_by(.age).name', people)).toEqual(['bob', 'cy']);
    expect(jq('group_by(.team) | map(map(.name))', people)).toEqual([[['bob', 'cy'], ['ann']]]);
    expect(jq('unique_by(.age) | map(.name)', people)).toEqual([['bob', 'ann']]);
    expect(jq('unique', [1, 'a', 1])).toEqual([[1, 'a']]);
  });

  it('splits, joins and trims strings', () => {
    expect(jq('split(", ")', 'a, b')).toEqual([['a', 'b']]);
    expect(jq('split("")', 'é😀')).toEqual([['é', '😀']]);
    expect(jq('split(",")', '')).toEqual([[]]);
    expect(jq('join("-")', [1, 'a', null, true])).toEqual(['1-a--true']);
    expect(() => jq('join("-")', [[1]])).toThrow('cannot be added');
    expect(jq('ltrimstr("a"), rtrimstr("c"), ltrimstr(1), startswith("ab"), endswith("bc")', 'abc')).toEqual([
      'bc',
      'ab',
      'abc',
      true,
      true,
    ]);
    expect(jq('ltrimstr("a")', 1)).toEqual([1]);
  });

  it('formats rows and strings with @csv, @tsv, @json, @text, @html, @uri and @base64', () => {
    expect(jq('@csv', [1, 'a"b', null, true])).toEqual(['1,"a""b",,true']);
    expect(jq('@tsv', [1, 'a\tb\\c', null])).toEqual(['1\ta\\tb\\\\c\t']);
    expect(jq('.[] | [.name, .age] | @tsv', people.slice(0, 1))).toEqual(['ann\t31']);
    expect(jq('@json, @text', [1, 'x'])).toEqual(['[1,"x"]', '[1,"x"]']);
    expect(jq('@html', `<&>'"`)).toEqual(['&lt;&amp;&gt;&apos;&quot;']);
    expect(jq('@uri', 'a b/é')).toEqual(['a%20b%2F%C3%A9']);
    expect(jq('@base64', 'hi')).toEqual(['aGk=']);
    expect(() => jq('@csv', { a: 1 })).toThrow('object ({"a":1}) cannot be csv-formatted, only array');
    expect(() => jq('@csv', [[1]])).toThrow('array ([1]) is not valid in a csv row');
    expect(() => compileJq('@nope')).toThrow('nope is not a valid format');
  });

  it('matches and replaces with regex flags', () => {
    expect(jq('test("b"; "i"), test("b"), test("a b c"; "x")', 'ABC')).toEqual([true, false, false]);
    expect(jq('test("a.b"; "s"), test("a.b"; "p")', 'a\nb')).toEqual([false, true]);
    expect(jq('sub("b"; "X"), gsub("b"; "X"), sub("b"; "X"; "g")', 'abcb')).toEqual(['aXcb', 'aXcX', 'aXcX']);
    expect(jq('gsub("x"; "-"; "i")', 'aXbx')).toEqual(['a-b-']);
    expect(jq('sub("(?<first>\\\\w+) (?<last>\\\\w+)"; .last + ", " + .first)', 'John Smith')).toEqual(['Smith, John']);
    expect(jq('gsub("b"; "1", "2")', 'abab')).toEqual(['a1a1', 'a2a2']);
    expect(jq('gsub(""; "-")', 'aaa')).toEqual(['-a-a-a-']);
    expect(jq('sub("z"; "y")', 'abc')).toEqual(['abc']);
    expect(() => jq('test("a"; "q")', 'x')).toThrow('q is not a valid modifier string');
    expect(() => jq('test("a")', 1)).toThrow('number (1) cannot be matched, as it is not a string');
  });
});

describe('--jq output', () => {
  const program = createPadrone('app')
    .extend(padroneJson())
    .command('users', (c) => c.action(() => users));

  it('prints compact JSON, one value per line, when stdout is not a terminal', () => {
    const { output, runtime } = capture();
    program.eval(['users', '--jq', '.[] | {id}'], { runtime });
    expect(output).toEqual(['{"id":2}', '{"id":1}']);
  });

  it('pretty-prints on a terminal', () => {
    const { output, runtime } = capture(true);
    program.eval(['users', '--jq', '.[0] | {id}'], { runtime });
    expect(output).toEqual([JSON.stringify({ id: 2 }, null, 2)]);
  });
});

describe('padroneFormat options', () => {
  const create = (options: Parameters<typeof padroneFormat>[0]) =>
    createPadrone('app')
      .extend(padroneFormat(options))
      .command('users', (c) => c.action(() => users))
      .command('stream', (c) =>
        c.action(function* () {
          yield* users;
        }),
      );
  const run = (program: ReturnType<typeof create>, input: string, isTTY?: boolean) => {
    const { output, runtime } = capture(isTTY);
    program.eval(input, { runtime });
    return output;
  };

  it("prints -o table as TSV when piped, with pipedTable: 'tsv'", () => {
    const program = create({ pipedTable: 'tsv' });
    expect(run(program, 'users -o table')).toEqual(['id\tname\tnote\n2\tBob\tfirst\\nsecond\n1\tAlice\tone']);
    expect(run(program, 'stream -o table')).toEqual(['id\tname\tnote', '2\tBob\tfirst\\nsecond', '1\tAlice\tone']);
    expect((run(program, 'users -o table', true)[0] as string).split('\n')[0]).toContain('│');
    expect((run(create({}), 'users -o table')[0] as string).split('\n')[0]).toContain('│');
  });

  it('labels and picks columns with columns', () => {
    const program = create({ columns: { name: 'Name', id: 'ID' }, tableFlags: true });
    expect(run(program, 'users -o csv')).toEqual(['Name,ID\nBob,2\nAlice,1']);
    expect(run(program, 'stream -o tsv')).toEqual(['Name\tID', 'Bob\t2', 'Alice\t1']);
    expect(run(program, 'users -o csv --columns id,note')).toEqual(['ID,note\n2,"first\nsecond"\n1,one']);
    expect((run(program, 'users -o table')[0] as string).split('\n')[0]).toBe(' Name  │ ID ');

    const perCommand = create({ columns: (command) => (command.name === 'users' ? { id: 'User ID' } : undefined) });
    expect(run(perCommand, 'users -o csv')).toEqual(['User ID\n2\n1']);
    expect(run(perCommand, 'stream -o csv')[0]).toBe('id,name,note');
  });

  it("ends csv lines with CRLF with csvLineEnding: 'crlf'", () => {
    const program = create({ csvLineEnding: 'crlf' });
    expect(run(program, 'users -o csv')).toEqual(['id,name,note\r\n2,Bob,"first\nsecond"\r\n1,Alice,one\r']);
    expect(run(program, 'stream -o csv')).toEqual(['id,name,note\r', '2,Bob,"first\nsecond"\r', '1,Alice,one\r']);
    expect(run(program, 'users -o tsv')[0]).not.toContain('\r');
  });
});

describe('multi-line table cells', () => {
  const ctx = { format: 'text' as const, styler: createTextStyler(), layout: createTextLayout() };

  it('wraps a cell with newlines inside its column', () => {
    expect(renderTable(users, undefined, ctx).split('\n')).toEqual([
      ' id │ name  │ note   ',
      '────┼───────┼────────',
      ' 2  │ Bob   │ first  ',
      '    │       │ second ',
      ' 1  │ Alice │ one    ',
    ]);
    expect(renderTable(users, { border: false }, ctx).split('\n')).toEqual([
      'id  name   note  ',
      '2   Bob    first ',
      '           second',
      '1   Alice  one   ',
    ]);
  });
});

describe('--color themes', () => {
  const program = createPadrone('app').action((_args, ctx) => ctx.runtime.theme ?? '-');

  it('rejects an unknown theme, listing the valid ones', () => {
    const { output, errors, runtime } = capture();
    const result = program.eval('--color=dracula', { runtime });
    expect((result.error as Error).message).toBe(
      'Unknown color theme "dracula". Expected auto, always, never or a theme: default, ocean, warm, monochrome',
    );
    expect(output).toEqual([]);
    expect(errors).toEqual([]);
    expect(program.eval('--color=ocean', { runtime }).result as unknown).toBe('ocean');
  });
});

describe('color environment variables', () => {
  it('does not turn colors off for CI=false or CI=0', () => {
    expect(shouldUseAnsi({ CI: 'false' }, true)).toBe(true);
    expect(shouldUseAnsi({ CI: '0' }, true)).toBe(true);
    expect(shouldUseAnsi({ CI: 'true' }, true)).toBe(false);
  });

  it('honors CLICOLOR=0 and CLICOLOR_FORCE, below NO_COLOR and FORCE_COLOR', () => {
    expect(shouldUseAnsi({ CLICOLOR: '0' }, true)).toBe(false);
    expect(shouldUseAnsi({ CLICOLOR: '1' }, true)).toBe(true);
    expect(shouldUseAnsi({ CLICOLOR: '1' }, false)).toBe(false);
    expect(shouldUseAnsi({ CLICOLOR_FORCE: '1' }, false)).toBe(true);
    expect(shouldUseAnsi({ CLICOLOR_FORCE: '1', CLICOLOR: '0', CI: '1', TERM: 'dumb' }, false)).toBe(true);
    expect(shouldUseAnsi({ CLICOLOR_FORCE: '0' }, false)).toBe(false);
    expect(shouldUseAnsi({ CLICOLOR_FORCE: '1', NO_COLOR: '1' }, true)).toBe(false);
    expect(shouldUseAnsi({ CLICOLOR: '0', FORCE_COLOR: '1' }, false)).toBe(true);
  });
});

describe('routing errors as JSON', () => {
  it('keeps the "Did you mean" hint out of the message, in suggestions only', () => {
    const program = createPadrone('app')
      .extend(padroneJson())
      .command('deploy', (c) => c.action(() => 'ok'));
    const { output, runtime } = capture();
    program.cli({ runtime: { ...runtime, argv: () => ['deploi', '--json'] } });
    const { error } = JSON.parse(output[0] as string);
    expect(error.message).toBe('Unknown command: deploi');
    expect(error.suggestions).toEqual(['Did you mean "deploy"?']);
  });
});
