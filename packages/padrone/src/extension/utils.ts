import { getKnownOptionNames } from '../core/validate.ts';
import type { AnyPadroneCommand, PadroneSchema } from '../types/index.ts';

/**
 * Access to the framework flags an extension reads from `rawArgs` (`--color`, `--version`, …).
 * A command's own option of the same name always wins: such keys read as absent and are never deleted.
 */
export function frameworkFlags(rawArgs: Record<string, unknown>, command: AnyPadroneCommand) {
  const owned = new Set(getKnownOptionNames(command));
  return {
    has: (key: string) => !owned.has(key) && key in rawArgs,
    get: (key: string) => (owned.has(key) ? undefined : rawArgs[key]),
    delete: (...keys: string[]) => {
      for (const key of keys) if (!owned.has(key)) delete rawArgs[key];
    },
  };
}

type SchemaShape = Record<string, 'string' | 'string[]' | 'boolean'>;

type InferPassthroughSchema<T extends SchemaShape> = {
  [K in keyof T]: T[K] extends 'string' ? string : T[K] extends 'string[]' ? string[] : T[K] extends 'boolean' ? boolean : never;
};

/** Minimal Standard Schema that passes through known fields, ignoring unknown ones. */
export function passthroughSchema<TShape extends SchemaShape>(fields: TShape): PadroneSchema<InferPassthroughSchema<TShape>> {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'padrone' as const,
      jsonSchema: {
        input: () => ({}),
        output: () => ({}),
      },
      validate: (value) => {
        const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const result: Record<string, unknown> = {};
        for (const [name, type] of Object.entries(fields)) {
          const v = input[name];
          if (v === undefined) continue;
          if (type === 'string[]') {
            if (Array.isArray(v)) result[name] = v.map(String);
            else if (typeof v === 'string') result[name] = [v];
          } else if (type === 'string') {
            if (typeof v === 'string') result[name] = v;
            else if (Array.isArray(v) && v.length > 0) result[name] = String(v[0]);
          } else if (type === 'boolean') {
            result[name] = v === true || v === 'true';
          }
        }
        return { value: result as InferPassthroughSchema<TShape> };
      },
    },
  };
}

/** Find a command by space-separated name in the command tree. */
export function findCommandInTree(name: string, rootCommand: AnyPadroneCommand): AnyPadroneCommand | undefined {
  const parts = name.split(' ').filter(Boolean);
  let current = rootCommand;
  for (const part of parts) {
    const found = current.commands?.find((c) => c.name === part || c.aliases?.includes(part));
    if (!found) return undefined;
    current = found;
  }
  return current;
}
