import { describe, expect, it } from 'bun:test';
import { toYaml } from '../src/util/yaml.ts';

describe('toYaml', () => {
  it('emits nested objects and arrays', () => {
    const value = { name: 'app', tags: ['a', 'b'], deps: { zod: '4.0.0' }, items: [{ id: 1, ok: true }, [1, 2]], empty: [], none: {} };
    expect(toYaml(value)).toBe(
      [
        'name: app',
        'tags:',
        '  - a',
        '  - b',
        'deps:',
        '  zod: "4.0.0"',
        'items:',
        '  - id: 1',
        '    ok: true',
        '  - - 1',
        '    - 2',
        'empty: []',
        'none: {}',
      ].join('\n'),
    );
  });

  it('emits scalars', () => {
    expect(toYaml('hello world')).toBe('hello world');
    expect(toYaml(null)).toBe('null');
    expect(toYaml([1.5, -2, 10n, NaN, Infinity, false])).toBe('- 1.5\n- -2\n- 10\n- .nan\n- .inf\n- false');
    expect(toYaml(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(toYaml([])).toBe('[]');
  });

  it('quotes strings that would read back as something else', () => {
    const strings = [
      '',
      'true',
      'No',
      'null',
      '~',
      '123',
      '1e3',
      '-dash',
      ' pad',
      'a: b',
      'end:',
      'a #b',
      'multi\nline',
      '"q"',
      '[x]',
      '*ref',
    ];
    for (const text of strings) expect(toYaml(text)).toBe(JSON.stringify(text));
    expect(toYaml({ 'a key': 1, '1': 2, y: 3 })).toBe('"1": 2\na key: 1\n"y": 3');
  });

  it('skips undefined and function values, and uses toJSON', () => {
    expect(toYaml({ a: undefined, b: () => 1, c: { toJSON: () => 'x' } })).toBe('c: x');
  });

  it('round-trips through a YAML parser', () => {
    const value = {
      text: 'Hello, "world": #1',
      url: 'https://example.com/a?b=1#c',
      path: '/usr/local/bin',
      list: [{ nested: { deep: ['x', 'yes', '0x10'] } }],
      unicode: 'héllo ✓',
      tab: 'a\tb',
    };
    expect(Bun.YAML.parse(toYaml(value))).toEqual(value);
  });
});
