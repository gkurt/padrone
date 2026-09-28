import { describe, expect, it } from 'bun:test';
import { satisfiesRange } from '#src/util/semver-range.ts';

describe('satisfiesRange()', () => {
  it.each([
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.9.0', '1.x', true],
    ['2.0.0', '1', false],
    ['1.2.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['3.0.0', '>=2 <3', false],
    ['2.5.0', '>=2 <3', true],
    ['3.1.0', '1.x || >=3', true],
    ['9.9.9', '*', true],
    ['1.0.0', 'nonsense', false],
  ])('%s in %s → %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});
