import { describe, expect, it } from 'bun:test';
import { getNestedValue, parseCliInputToParts, setNestedValue } from '../src/core/parse.ts';

describe('parseCliInputToParts', () => {
  describe('terms', () => {
    it('should parse a single term', () => {
      expect(parseCliInputToParts('deploy')).toEqual([{ type: 'term', value: 'deploy' }]);
    });

    it('should parse multiple terms (nested commands)', () => {
      expect(parseCliInputToParts('git commit')).toEqual([
        { type: 'term', value: 'git' },
        { type: 'term', value: 'commit' },
      ]);
    });

    it('should allow hyphens and underscores in terms', () => {
      expect(parseCliInputToParts('my-cmd my_sub')).toEqual([
        { type: 'term', value: 'my-cmd' },
        { type: 'term', value: 'my_sub' },
      ]);
    });

    it('should allow numeric terms', () => {
      expect(parseCliInputToParts('cmd 123')).toEqual([
        { type: 'term', value: 'cmd' },
        { type: 'term', value: '123' },
      ]);
    });
  });

  describe('positional args', () => {
    it('should treat non-alphanumeric values as args', () => {
      expect(parseCliInputToParts('cmd /path/to/file')).toEqual([
        { type: 'term', value: 'cmd' },
        { type: 'arg', value: '/path/to/file' },
      ]);
    });

    it('should stop allowing terms after a positional arg', () => {
      expect(parseCliInputToParts('cmd file.txt subcmd')).toEqual([
        { type: 'term', value: 'cmd' },
        { type: 'arg', value: 'file.txt' },
        { type: 'arg', value: 'subcmd' },
      ]);
    });
  });

  describe('named args (--)', () => {
    it('should parse --key as named with no value', () => {
      const result = parseCliInputToParts('--verbose');
      expect(result).toEqual([{ type: 'named', key: ['verbose'], value: undefined }]);
    });

    it('should parse --key value as named with pending value', () => {
      const result = parseCliInputToParts('--name hello');
      expect(result).toEqual([{ type: 'named', key: ['name'], value: 'hello' }]);
    });

    it('should parse --key=value inline', () => {
      const result = parseCliInputToParts('--name=hello');
      expect(result).toEqual([{ type: 'named', key: ['name'], value: 'hello' }]);
    });

    it('should parse nested keys with dots', () => {
      const result = parseCliInputToParts('--user.name=John');
      expect(result).toEqual([{ type: 'named', key: ['user', 'name'], value: 'John' }]);
    });

    it('should parse deeply nested keys', () => {
      const result = parseCliInputToParts('--a.b.c=val');
      expect(result).toEqual([{ type: 'named', key: ['a', 'b', 'c'], value: 'val' }]);
    });

    it('should handle multiple named args', () => {
      const result = parseCliInputToParts('--host localhost --port 8080');
      expect(result).toEqual([
        { type: 'named', key: ['host'], value: 'localhost' },
        { type: 'named', key: ['port'], value: '8080' },
      ]);
    });
  });

  describe('negated args (--no-)', () => {
    it('should parse --no-verbose as negated', () => {
      const result = parseCliInputToParts('--no-verbose');
      expect(result).toEqual([{ type: 'named', key: ['verbose'], value: undefined, negated: true }]);
    });

    it('should handle nested negated keys', () => {
      const result = parseCliInputToParts('--no-config.debug');
      expect(result).toEqual([{ type: 'named', key: ['config', 'debug'], value: undefined, negated: true }]);
    });

    it('should not treat --no as negation (too short)', () => {
      const result = parseCliInputToParts('--no');
      expect(result).toEqual([{ type: 'named', key: ['no'], value: undefined }]);
    });

    it('should not treat --no- as negation (empty key after no-)', () => {
      const result = parseCliInputToParts('--no-');
      expect(result).toEqual([{ type: 'named', key: ['no-'], value: undefined }]);
    });
  });

  describe('alias args (-)', () => {
    it('should parse single char alias', () => {
      const result = parseCliInputToParts('-v');
      expect(result).toEqual([{ type: 'alias', key: ['v'], value: undefined }]);
    });

    it('should parse alias with pending value', () => {
      const result = parseCliInputToParts('-o output.txt');
      expect(result).toEqual([{ type: 'alias', key: ['o'], value: 'output.txt' }]);
    });

    it('should parse alias with inline value', () => {
      const result = parseCliInputToParts('-o=output.txt');
      expect(result).toEqual([{ type: 'alias', key: ['o'], value: 'output.txt' }]);
    });

    it('should not treat negative numbers as aliases', () => {
      // -5 is a negative number, so it is a positional arg rather than a flag or a command term
      const result = parseCliInputToParts('cmd -5');
      expect(result).toEqual([
        { type: 'term', value: 'cmd' },
        { type: 'arg', value: '-5' },
      ]);
    });

    it('should not treat negative numbers as aliases after term cutoff', () => {
      // After a non-term arg, -5 becomes a positional arg
      const result = parseCliInputToParts('cmd file.txt -5');
      expect(result).toEqual([
        { type: 'term', value: 'cmd' },
        { type: 'arg', value: 'file.txt' },
        { type: 'arg', value: '-5' },
      ]);
    });
  });

  describe('flag stacking', () => {
    it('should expand -abc into three separate aliases', () => {
      const result = parseCliInputToParts('-abc');
      expect(result).toEqual([
        { type: 'alias', key: ['a'], value: undefined },
        { type: 'alias', key: ['b'], value: undefined },
        { type: 'alias', key: ['c'], value: 'abc' in result ? undefined : undefined },
      ]);
      // Last flag gets pending value behavior
      expect(result).toHaveLength(3);
    });

    it('should allow the last stacked flag to take a value', () => {
      const result = parseCliInputToParts('-abc val');
      expect(result).toEqual([
        { type: 'alias', key: ['a'], value: undefined },
        { type: 'alias', key: ['b'], value: undefined },
        { type: 'alias', key: ['c'], value: 'val' },
      ]);
    });

    it('should handle stacked flags with inline value on last', () => {
      const result = parseCliInputToParts('-abc=val');
      expect(result).toEqual([
        { type: 'alias', key: ['a'], value: undefined },
        { type: 'alias', key: ['b'], value: undefined },
        { type: 'alias', key: ['c'], value: 'val' },
      ]);
    });
  });

  describe('double dash separator (--)', () => {
    it('should treat everything after -- as positional args', () => {
      const result = parseCliInputToParts('cmd -- --not-a-flag -x');
      expect(result).toEqual([
        { type: 'term', value: 'cmd' },
        { type: 'arg', value: '--not-a-flag' },
        { type: 'arg', value: '-x' },
      ]);
    });

    it('should discard pending value on bare --', () => {
      const result = parseCliInputToParts('--name -- literal');
      expect(result).toEqual([
        { type: 'named', key: ['name'], value: undefined },
        { type: 'arg', value: 'literal' },
      ]);
    });

    it('should disable terms after --', () => {
      const result = parseCliInputToParts('-- subcmd');
      expect(result).toEqual([{ type: 'arg', value: 'subcmd' }]);
    });
  });

  describe('quoted strings', () => {
    it('should handle double-quoted values', () => {
      const result = parseCliInputToParts('--msg "hello world"');
      expect(result).toEqual([{ type: 'named', key: ['msg'], value: 'hello world' }]);
    });

    it('should handle single-quoted values', () => {
      const result = parseCliInputToParts("--msg 'hello world'");
      expect(result).toEqual([{ type: 'named', key: ['msg'], value: 'hello world' }]);
    });

    it('should handle backtick-quoted values', () => {
      const result = parseCliInputToParts('--msg `hello world`');
      expect(result).toEqual([{ type: 'named', key: ['msg'], value: 'hello world' }]);
    });

    it('should handle escaped quotes inside quoted strings', () => {
      const result = parseCliInputToParts('--msg "hello \\"world\\""');
      expect(result).toEqual([{ type: 'named', key: ['msg'], value: 'hello "world"' }]);
    });

    it('should handle escaped backslash inside quoted strings', () => {
      const result = parseCliInputToParts('--path "C:\\\\Users"');
      expect(result).toEqual([{ type: 'named', key: ['path'], value: 'C:\\Users' }]);
    });

    it('should handle quoted value in --key=value syntax', () => {
      const result = parseCliInputToParts('--name="hello world"');
      expect(result).toEqual([{ type: 'named', key: ['name'], value: 'hello world' }]);
    });

    it('an empty quoted string is the empty value', () => {
      expect(parseCliInputToParts('--name ""')).toEqual([{ type: 'named', key: ['name'], value: '' }]);
      expect(parseCliInputToParts("greet ''")).toEqual([
        { type: 'term', value: 'greet' },
        { type: 'arg', value: '' },
      ]);
    });
  });

  describe('array syntax', () => {
    it('should parse [a,b,c] as array value', () => {
      const result = parseCliInputToParts('--tags=[a,b,c]');
      expect(result).toEqual([{ type: 'named', key: ['tags'], value: ['a', 'b', 'c'] }]);
    });

    it('should parse empty array', () => {
      const result = parseCliInputToParts('--tags=[]');
      expect(result).toEqual([{ type: 'named', key: ['tags'], value: [] }]);
    });

    it('should handle quoted items in arrays', () => {
      const result = parseCliInputToParts('--tags=["hello world","foo"]');
      expect(result).toEqual([{ type: 'named', key: ['tags'], value: ['hello world', 'foo'] }]);
    });

    it('should handle spaces inside bracket array tokens', () => {
      const result = parseCliInputToParts('--tags=[hello world, foo]');
      expect(result).toEqual([{ type: 'named', key: ['tags'], value: ['hello world', 'foo'] }]);
    });
  });

  describe('mixed inputs', () => {
    it('should handle terms, named args, and aliases together', () => {
      const result = parseCliInputToParts('deploy --env prod -v');
      expect(result).toEqual([
        { type: 'term', value: 'deploy' },
        { type: 'named', key: ['env'], value: 'prod' },
        { type: 'alias', key: ['v'], value: undefined },
      ]);
    });

    it('should handle complex real-world input', () => {
      const result = parseCliInputToParts('git commit --message "initial commit" -a --no-verify');
      expect(result).toEqual([
        { type: 'term', value: 'git' },
        { type: 'term', value: 'commit' },
        { type: 'named', key: ['message'], value: 'initial commit' },
        { type: 'alias', key: ['a'], value: undefined },
        { type: 'named', key: ['verify'], value: undefined, negated: true },
      ]);
    });

    it('should handle named arg followed by another named arg (no pending value)', () => {
      const result = parseCliInputToParts('--verbose --name hello');
      expect(result).toEqual([
        { type: 'named', key: ['verbose'], value: undefined },
        { type: 'named', key: ['name'], value: 'hello' },
      ]);
    });

    it('should handle alias followed by named arg (no pending value)', () => {
      const result = parseCliInputToParts('-v --name hello');
      expect(result).toEqual([
        { type: 'alias', key: ['v'], value: undefined },
        { type: 'named', key: ['name'], value: 'hello' },
      ]);
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      expect(parseCliInputToParts('')).toEqual([]);
    });

    it('should handle whitespace-only input', () => {
      expect(parseCliInputToParts('   ')).toEqual([]);
    });

    it('should handle tabs as whitespace', () => {
      const result = parseCliInputToParts('cmd\t--flag');
      expect(result).toEqual([
        { type: 'term', value: 'cmd' },
        { type: 'named', key: ['flag'], value: undefined },
      ]);
    });

    it('should trim leading/trailing whitespace', () => {
      const result = parseCliInputToParts('  cmd  ');
      expect(result).toEqual([{ type: 'term', value: 'cmd' }]);
    });

    it('should handle bare -', () => {
      // `-` (conventionally stdin) is a positional arg, never a flag or a command term
      const result = parseCliInputToParts('-');
      expect(result).toEqual([{ type: 'arg', value: '-' }]);
    });
  });
});

describe('setNestedValue', () => {
  it('should set a top-level key', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, ['name'], 'John');
    expect(obj).toEqual({ name: 'John' });
  });

  it('should set a nested key, creating intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, ['user', 'profile', 'name'], 'John');
    expect(obj).toEqual({ user: { profile: { name: 'John' } } });
  });

  it('should overwrite existing values', () => {
    const obj: Record<string, unknown> = { name: 'old' };
    setNestedValue(obj, ['name'], 'new');
    expect(obj).toEqual({ name: 'new' });
  });

  it('should overwrite non-object intermediate values', () => {
    const obj: Record<string, unknown> = { user: 'string' };
    setNestedValue(obj, ['user', 'name'], 'John');
    expect(obj).toEqual({ user: { name: 'John' } });
  });
});

describe('getNestedValue', () => {
  it('should get a top-level key', () => {
    expect(getNestedValue({ name: 'John' }, ['name'])).toBe('John');
  });

  it('should get a nested key', () => {
    expect(getNestedValue({ user: { profile: { name: 'John' } } }, ['user', 'profile', 'name'])).toBe('John');
  });

  it('should return undefined for missing path', () => {
    expect(getNestedValue({ user: {} }, ['user', 'profile', 'name'])).toBeUndefined();
  });

  it('should return undefined when traversing through null', () => {
    expect(getNestedValue({ user: null } as any, ['user', 'name'])).toBeUndefined();
  });

  it('should return undefined when traversing through a primitive', () => {
    expect(getNestedValue({ user: 'string' }, ['user', 'name'])).toBeUndefined();
  });
});
