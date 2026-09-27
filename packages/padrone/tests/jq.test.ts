import { describe, expect, it } from 'bun:test';
import { compileJq, compileTemplate } from '../src/util/jq.ts';

const jq = (expression: string, input: unknown) => compileJq(expression)(input);

const users = [
  { name: 'ann', age: 31, admin: true, tags: ['a', 'b'] },
  { name: 'bob', age: 25, admin: false, tags: [] },
  { name: 'cy', age: 40, admin: true, tags: ['c'] },
];

describe('jq subset', () => {
  it('evaluates paths', () => {
    expect(jq('.', 1)).toEqual([1]);
    expect(jq('.a.b', { a: { b: 2 } })).toEqual([2]);
    expect(jq('.missing.deep', {})).toEqual([null]);
    expect(jq('."a-b"', { 'a-b': 3 })).toEqual([3]);
    expect(jq('.["a b"]', { 'a b': 4 })).toEqual([4]);
    expect(jq('.[0], .[-1]', [1, 2, 3])).toEqual([1, 3]);
    expect(jq('.[1:3]', [1, 2, 3, 4])).toEqual([[2, 3]]);
    expect(jq('.[:2]', 'hello')).toEqual(['he']);
    expect(jq('.[].name', users)).toEqual(['ann', 'bob', 'cy']);
    expect(jq('.[] | .tags[]', users)).toEqual(['a', 'b', 'c']);
    expect(jq('.[0].tags[1]', users)).toEqual(['b']);
  });

  it('filters, maps and builds values', () => {
    expect(jq('.[] | select(.admin and .age > 35) | .name', users)).toEqual(['cy']);
    expect(jq('map(.age) | add', users)).toEqual([96]);
    expect(jq('[.[] | select(.admin | not) | .name]', users)).toEqual([['bob']]);
    expect(jq('.[0] | {name, years: .age}', users)).toEqual([{ name: 'ann', years: 31 }]);
    expect(jq('{(.k): .v}', { k: 'x', v: 1 })).toEqual([{ x: 1 }]);
    expect(jq('sort_by(.age) | map(.name) | join(", ")', users)).toEqual(['bob, ann, cy']);
    expect(jq('.[] | select(.name | test("^[ab]")) | .name', users)).toEqual(['ann', 'bob']);
    expect(jq('.nope // "default"', {})).toEqual(['default']);
    expect(jq('keys, length', { b: 1, a: 2 })).toEqual([['a', 'b'], 2]);
    expect(jq('to_entries | from_entries', { a: 1 })).toEqual([{ a: 1 }]);
    expect(jq('[.[] | .admin] | unique', users)).toEqual([[false, true]]);
    expect(jq('.[0] | has("name"), has("x")', users)).toEqual([true, false]);
  });

  it('reports syntax and runtime errors, and ? suppresses runtime ones', () => {
    expect(() => compileJq('.a |')).toThrow('Unexpected end of expression');
    expect(() => compileJq('nope')).toThrow('Unknown function nope/0');
    expect(() => compileJq('reduce .[] as $x (0; . + $x)')).toThrow('Unknown function reduce/0');
    expect(() => jq('.a', [1])).toThrow('Cannot index array with "a"');
    expect(jq('.[] | .a?', [1, { a: 2 }])).toEqual([2]);
  });
});

describe('templates', () => {
  it('fills placeholders with jq expressions', () => {
    const render = compileTemplate('{{.name}} ({{.age}}) {{.tags}} {{.missing}}!');
    expect(render(users[0])).toBe('ann (31) ["a","b"] !');
    expect(() => compileTemplate('{{.name')).toThrow('Unclosed');
  });
});
