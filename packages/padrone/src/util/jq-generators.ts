/** Generator and path builtins of the jq subset in `jq.ts`: `range`, `limit`, `first(f)`, `any`, `paths`, `setpath`, `tostream`, … */

import type { Builtin, JqFilter } from './jq-builtins.ts';
import { BUILTINS, describe, index, isObject, JqError, outputs, product, runEnv, tick, truthy, typeOf } from './jq-builtins.ts';

type Path = (string | number)[];

/** The children of an array or object as `[key, value]` pairs; none for anything else. */
function children(value: unknown): [string | number, unknown][] {
  if (Array.isArray(value)) return value.map((item, i) => [i, item]);
  if (isObject(value)) return Object.entries(value);
  return [];
}

/** `value`, then everything `f` gives for it, recursively (depth first), without growing the call stack. */
function* recurseWith(value: unknown, f: JqFilter): Generator<unknown> {
  tick();
  yield value;
  const stack = [f(value)[Symbol.iterator]()];
  try {
    while (stack.length) {
      const next = stack.at(-1)!.next();
      if (next.done) {
        stack.pop();
        continue;
      }
      tick();
      yield next.value;
      stack.push(f(next.value)[Symbol.iterator]());
    }
  } finally {
    for (const iterator of stack) iterator.return?.();
  }
}

const childValues: JqFilter = (value) => children(value).map(([, child]) => child);

/** Every path below `value`, parents before their children. */
function* pathsOf(value: unknown, prefix: Path = []): Generator<Path> {
  for (const [key, child] of children(value)) {
    tick();
    const path = [...prefix, key];
    yield path;
    yield* pathsOf(child, path);
  }
}

/** `tostream` events: `[path, leaf]` for scalars and empty containers, and `[lastPath]` closing each non-empty container. */
function* streamOf(value: unknown, prefix: Path = []): Generator<unknown[]> {
  tick();
  const entries = children(value);
  if (!entries.length) return yield [prefix, value];
  for (const [key, child] of entries) yield* streamOf(child, [...prefix, key]);
  yield [[...prefix, entries.at(-1)![0]]];
}

function toPath(value: unknown): Path {
  if (!Array.isArray(value)) throw new JqError('Path must be specified as an array');
  for (const key of value) {
    if (typeof key !== 'string' && typeof key !== 'number') throw new JqError(`Invalid path component ${describe(key)}`);
  }
  return value;
}

const getPath = (value: unknown, path: Path): unknown => path.reduce<unknown>((current, key) => index(current, key), value);

function setPath(value: unknown, path: Path, replacement: unknown): unknown {
  if (!path.length) return replacement;
  const [key, ...rest] = path;
  if (typeof key === 'string') {
    if (value !== null && value !== undefined && !isObject(value)) throw new JqError(`Cannot index ${typeOf(value)} with "${key}"`);
    const object = (value ?? {}) as Record<string, unknown>;
    const child = setPath(Object.hasOwn(object, key) ? object[key] : null, rest, replacement);
    // Defines own properties, so a "__proto__" key is a key
    return { ...object, ...Object.fromEntries([[key, child]]) };
  }
  if (value !== null && value !== undefined && !Array.isArray(value)) throw new JqError(`Cannot index ${typeOf(value)} with number`);
  const array = [...((value ?? []) as unknown[])];
  const i = Math.floor(key!);
  const at = i < 0 ? array.length + i : i;
  if (at < 0) throw new JqError('Out of bounds negative array index');
  if (at >= array.length) {
    tick(at - array.length + 1);
    while (array.length < at) array.push(null);
  }
  array[at] = setPath(array[at] ?? null, rest, replacement);
  return array;
}

function deletePath(value: unknown, path: Path): unknown {
  if (value === null || value === undefined) return null;
  if (!path.length) return null;
  const [key, ...rest] = path;
  if (typeof key === 'string') {
    if (!isObject(value)) throw new JqError(`Cannot delete field at object index of ${typeOf(value)}`);
    if (!Object.hasOwn(value, key)) return value;
    if (rest.length) return { ...value, ...Object.fromEntries([[key, deletePath(value[key], rest)]]) };
    const { [key]: _, ...kept } = value;
    return kept;
  }
  if (!Array.isArray(value)) throw new JqError(`Cannot delete field at index of ${typeOf(value)}`);
  const i = Math.floor(key!);
  const at = i < 0 ? value.length + i : i;
  if (at < 0 || at >= value.length) return value;
  const copy = [...value];
  if (rest.length) copy[at] = deletePath(copy[at], rest);
  else copy.splice(at, 1);
  return copy;
}

/** Deletes the longest (and last) paths first, so earlier array indices stay valid. */
function deletePaths(value: unknown, paths: unknown): unknown {
  if (!Array.isArray(paths)) throw new JqError('Paths must be specified as an array');
  const sorted = paths.map(toPath).sort((a, b) => comparePaths(b, a));
  return sorted.reduce<unknown>((current, path) => deletePath(current, path), value);
}

function comparePaths(a: Path, b: Path): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function* range(from: unknown, upto: unknown, by: unknown = 1): Generator<number> {
  if (typeof from !== 'number' || typeof upto !== 'number' || typeof by !== 'number') throw new JqError('Range bounds must be numeric');
  if (by > 0) {
    for (let i = from; i < upto; i += by) {
      tick();
      yield i;
    }
  } else if (by < 0) {
    for (let i = from; i > upto; i += by) {
      tick();
      yield i;
    }
  }
}

/** Whether `cond` is truthy for any (`every: false`) or every output of `gen`, stopping at the first that decides. */
function quantify(x: unknown, gen: JqFilter, cond: JqFilter, every: boolean): boolean {
  for (const value of gen(x)) for (const c of cond(value)) if (truthy(c) !== every) return !every;
  return every;
}

const iterateChildren: JqFilter = (value) => {
  if (!Array.isArray(value) && !isObject(value)) throw new JqError(`Cannot iterate over ${typeOf(value)}`);
  return childValues(value);
};
const identity: JqFilter = (value) => [value];

const selectType =
  (...types: string[]): Builtin =>
  (x) =>
    types.includes(typeOf(x)) ? [x] : [];

const isScalar = (x: unknown) => !Array.isArray(x) && !isObject(x);

export const GENERATOR_BUILTINS: Record<string, Builtin> = {
  *'range/1'(x, upto) {
    for (const n of upto(x)) yield* range(0, n);
  },
  *'range/2'(x, from, upto) {
    for (const [a, b] of product([from, upto], x)) yield* range(a, b);
  },
  *'range/3'(x, from, upto, by) {
    for (const [a, b, c] of product([from, upto, by], x)) yield* range(a, b, c);
  },
  // jq 1.7: a negative limit gives every output
  *'limit/2'(x, count, f) {
    for (const n of count(x)) {
      if (typeof n !== 'number') throw new JqError(`Invalid limit ${describe(n)}: expected a number`);
      if (n < 0) yield* f(x);
      if (n <= 0) continue;
      let taken = 0;
      for (const value of f(x)) {
        yield value;
        if (++taken >= n) break;
      }
    }
  },
  *'first/1'(x, f) {
    for (const value of f(x)) return yield value;
  },
  'last/1': (x, f) => {
    let last: unknown = null;
    for (const value of f(x)) last = value;
    return [last];
  },
  'any/0': (x) => [quantify(x, iterateChildren, identity, false)],
  'all/0': (x) => [quantify(x, iterateChildren, identity, true)],
  'any/1': (x, cond) => [quantify(x, iterateChildren, cond, false)],
  'all/1': (x, cond) => [quantify(x, iterateChildren, cond, true)],
  'any/2': (x, gen, cond) => [quantify(x, gen, cond, false)],
  'all/2': (x, gen, cond) => [quantify(x, gen, cond, true)],

  'values/0': (x) => (x === null || x === undefined ? [] : [x]),
  'nulls/0': selectType('null'),
  'booleans/0': selectType('boolean'),
  'numbers/0': selectType('number'),
  'strings/0': selectType('string'),
  'arrays/0': selectType('array'),
  'objects/0': selectType('object'),
  'iterables/0': selectType('array', 'object'),
  'scalars/0': selectType('null', 'boolean', 'number', 'string'),

  'recurse/0': (x) => recurseWith(x, childValues),
  'recurse/1': (x, f) => recurseWith(x, f),
  'paths/0': (x) => pathsOf(x),
  *'paths/1'(x, f) {
    for (const path of pathsOf(x)) for (const keep of f(getPath(x, path))) if (truthy(keep)) yield path;
  },
  *'leaf_paths/0'(x) {
    for (const path of pathsOf(x)) if (isScalar(getPath(x, path))) yield path;
  },
  'getpath/1': (x, f) => outputs(f, x).map((path) => getPath(x, toPath(path))),
  'setpath/2': (x, path, value) => Array.from(product([path, value], x), ([p, v]) => setPath(x, toPath(p), v)),
  'delpaths/1': (x, f) => outputs(f, x).map((paths) => deletePaths(x, paths)),
  'tostream/0': (x) => streamOf(x),
  'with_entries/1': (x, f) => {
    const [entries] = outputs(BUILTINS['to_entries/0']!, x) as unknown[][];
    return BUILTINS['from_entries/0']!(entries!.flatMap((entry) => outputs(f, entry)));
  },
  'env/0': () => [runEnv()],
  'error/0': (x) => {
    throw new JqError(typeof x === 'string' ? x : `${describe(x)} (not a string)`);
  },
  'error/1': (x, message) => {
    for (const m of message(x)) throw new JqError(typeof m === 'string' ? m : `${describe(m)} (not a string)`);
    return [];
  },
};
