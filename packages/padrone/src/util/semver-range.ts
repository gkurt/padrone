type Version = [number, number, number];

const parse = (text: string): Version | undefined => {
  const match = text.trim().match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+].*)?$/i);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]) || 0, Number(match[3]) || 0];
};

const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether one comparator (`^1.2`, `~1.2.3`, `>=2`, `<3`, `1.x`, `1.2.3`, `*`) accepts `version`. */
function satisfiesComparator(version: Version, comparator: string): boolean {
  if (comparator === '*' || comparator === 'x' || comparator === '') return true;
  const [, operator = '', text = ''] = comparator.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/) ?? [];
  const target = parse(text);
  if (!target) return false;
  const parts = text.replace(/^v/, '').split('.');
  switch (operator) {
    case '^': {
      // ^1.2.3 := >=1.2.3 <2.0.0; ^0.2.3 := >=0.2.3 <0.3.0; ^0.0.3 := 0.0.3
      const upper: Version = target[0] > 0 ? [target[0] + 1, 0, 0] : target[1] > 0 ? [0, target[1] + 1, 0] : [0, 0, target[2] + 1];
      return compare(version, target) >= 0 && compare(version, upper) < 0;
    }
    case '~':
      return compare(version, target) >= 0 && compare(version, [target[0], target[1] + 1, 0]) < 0;
    case '>=':
      return compare(version, target) >= 0;
    case '>':
      return compare(version, target) > 0;
    case '<=':
      return compare(version, target) <= 0;
    case '<':
      return compare(version, target) < 0;
    default: {
      // `1` and `1.x` match any 1.y.z, `1.2` any 1.2.z
      const wildcard = (index: number) => parts[index] === undefined || /^(x|\*)$/i.test(parts[index]!);
      return version.every((n, i) => wildcard(i) || n === target[i]);
    }
  }
}

/**
 * Whether `version` satisfies a semver `range`: space-separated comparators that must all match, and `||` alternatives
 * (`^1.2.0`, `>=1 <3`, `1.x || ^2`). A range that can't be read matches nothing. Pre-release tags are ignored.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parse(version);
  if (!parsed) return false;
  return range.split('||').some((alternative) => {
    const words = alternative
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/);
    return words.every((word) => satisfiesComparator(parsed, word));
  });
}
