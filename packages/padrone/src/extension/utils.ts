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

/** Callers that return results through their own transport (HTTP, MCP, AI tool calls): no terminal, no stdin. */
const REMOTE_CALLERS = new Set<string>(['serve', 'mcp', 'tool']);

export function isRemoteCaller(caller: string): boolean {
  return REMOTE_CALLERS.has(caller);
}

type PassthroughType = 'string' | 'string[]' | 'boolean';
type PassthroughField = PassthroughType | { type: PassthroughType; description?: string; enum?: readonly string[] };
type SchemaShape = Record<string, PassthroughField>;

type InferPassthroughType<T> = T extends 'string' ? string : T extends 'string[]' ? string[] : T extends 'boolean' ? boolean : never;
type InferPassthroughSchema<T extends SchemaShape> = {
  [K in keyof T]: InferPassthroughType<T[K] extends { type: infer U } ? U : T[K]>;
};

const PASSTHROUGH_JSON_TYPES = {
  string: { type: 'string' },
  'string[]': { type: 'array', items: { type: 'string' } },
  boolean: { type: 'boolean' },
} as const;

function passthroughFieldJsonSchema(field: PassthroughField): Record<string, unknown> {
  if (typeof field === 'string') return PASSTHROUGH_JSON_TYPES[field];
  return {
    ...PASSTHROUGH_JSON_TYPES[field.type],
    ...(field.description && { description: field.description }),
    ...(field.enum && { enum: field.enum }),
  };
}

/**
 * Minimal Standard Schema for built-in commands. Its JSON Schema lists the fields,
 * so help shows them and boolean fields parse as flags (`--setup bash` doesn't take `bash` as its value).
 * Values are passed through without validation.
 */
export function passthroughSchema<TShape extends SchemaShape>(fields: TShape): PadroneSchema<InferPassthroughSchema<TShape>> {
  const jsonSchema = () => ({
    type: 'object',
    properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, passthroughFieldJsonSchema(field)])),
  });
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'padrone' as const,
      jsonSchema: { input: jsonSchema, output: jsonSchema },
      validate: (value) => {
        const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const result: Record<string, unknown> = {};
        for (const [name, field] of Object.entries(fields)) {
          const type = typeof field === 'string' ? field : field.type;
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

const reportedErrors = new WeakSet<object>();

/** Marks an error as already printed, so later error handlers (e.g. auto-output) don't print it again. */
export function markErrorReported(error: unknown): void {
  if (error && typeof error === 'object') reportedErrors.add(error);
}

/** Whether an error was already printed by an extension. */
export function isErrorReported(error: unknown): boolean {
  return !!error && typeof error === 'object' && reportedErrors.has(error);
}
