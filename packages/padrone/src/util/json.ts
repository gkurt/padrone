/**
 * `JSON.stringify` that doesn't throw: bigints become decimal strings, errors `{ name, message }`,
 * and circular references `"[Circular]"`. Returns `undefined` for values JSON can't represent (e.g. `undefined`).
 */
export function safeJsonStringify(value: unknown, space?: number): string | undefined {
  const ancestors: unknown[] = [];
  try {
    return JSON.stringify(
      value,
      function (this: unknown, _key, v: unknown) {
        if (typeof v === 'bigint') return String(v);
        if (v instanceof Error) return { name: v.name, message: v.message };
        if (!v || typeof v !== 'object') return v;
        // `this` is the object holding `v`: drop the ancestors that aren't on its path
        while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
        if (ancestors.includes(v)) return '[Circular]';
        ancestors.push(v);
        return v;
      },
      space,
    );
  } catch {
    return undefined;
  }
}
