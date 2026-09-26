import type { AnyPadroneCommand, PadroneSchema } from '../types/index.ts';
import type { Thenable } from '../util/type-utils.ts';
import { getCommandRuntime, getGlobalArgs } from './commands.ts';

/**
 * Brands a schema as async, signaling that its `validate()` may return a Promise.
 * When an async-branded schema is passed to `.arguments()`, `.configFile()`, or `.env()`,
 * the command's `parse()` and `cli()` will return Promises.
 */
export function asyncSchema<T extends PadroneSchema>(schema: T): T & { '~async': true } {
  return Object.assign(schema, { '~async': true as const });
}

export const noop = <TRes>() => undefined as TRes;

/**
 * Maps over a value that may or may not be a Promise.
 * If the value is a Promise, chains with `.then()`. Otherwise, calls the function synchronously.
 * This preserves sync behavior for sync schemas and async behavior for async schemas.
 */
export function thenMaybe<T, U>(value: T | Promise<T>, fn: (v: T) => U | Promise<U>): U | Promise<U> {
  if (value instanceof Promise) return value.then(fn);
  return fn(value);
}

/**
 * Makes a sync result object thenable by adding `.then()`, `.catch()`, and `.finally()` methods.
 * If the value is already a Promise, returns it as-is.
 * This allows users to write `await program.cli()` or `program.cli().then(...)` regardless of sync/async.
 *
 * The `.then()` resolves with a plain copy (without thenable methods) to avoid infinite
 * recursive unwrapping by the Promise resolution algorithm.
 */
export function makeThenable<T>(value: T | Promise<T>): Thenable<T> {
  if (value instanceof Promise) return value as any;
  if (value !== null && typeof value === 'object' && !('then' in value)) {
    const toPlain = () => {
      const plain = { ...value } as any;
      delete plain.then;
      delete plain.catch;
      delete plain.finally;
      return plain as T;
    };
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable shim for sync results
    (value as any).then = (onfulfilled?: (v: T) => any, onrejected?: (reason: any) => any) => {
      try {
        const result = onfulfilled ? onfulfilled(toPlain()) : toPlain();
        return Promise.resolve(result);
      } catch (err) {
        if (onrejected) return Promise.resolve(onrejected(err));
        return Promise.reject(err);
      }
    };
    (value as any).catch = (onrejected?: (reason: any) => any) => (value as any).then(undefined, onrejected);
    (value as any).finally = (onfinally?: () => void) =>
      (value as any).then(
        (v: any) => {
          onfinally?.();
          return v;
        },
        (err: any) => {
          onfinally?.();
          throw err;
        },
      );
  }
  return value as any;
}

/**
 * Wraps a Promise to include a `drain()` method at the top level.
 * This allows `await promise.drain()` without first awaiting the promise.
 * Since cli/eval never reject, this just delegates to the resolved result's `drain()`.
 */
export function withPromiseDrain<T extends Promise<any>>(promise: T): T & { drain: () => Promise<any> } {
  (promise as any).drain = async () => {
    const resolved = await promise;
    return resolved.drain();
  };
  return promise as any;
}

export function isIterator(value: unknown): value is Iterator<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value && typeof (value as any)[Symbol.iterator] === 'function';
}

export function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as any)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Writes a command's return value to output, handling promises, iterators, and async iterators.
 * Values are passed directly to the output function without stringification —
 * runtimes like Node/Bun already format objects via console.log.
 * Returns void or a Promise depending on whether async consumption is needed.
 */
export function outputValue(value: unknown, output: (...args: unknown[]) => void): void | Promise<void> {
  if (value == null) return;

  // Async iterator — consume and output each yielded value
  if (isAsyncIterator(value)) {
    return (async () => {
      const iter = (value as any)[Symbol.asyncIterator]();
      while (true) {
        const { done, value: item } = await iter.next();
        if (done) break;
        if (item != null) output(item);
      }
    })();
  }

  // Sync iterator (but not a plain string/array which also have Symbol.iterator)
  if (typeof value !== 'string' && !Array.isArray(value) && isIterator(value)) {
    const iter = (value as any)[Symbol.iterator]();
    while (true) {
      const { done, value: item } = iter.next();
      if (done) break;
      if (item != null) output(item);
    }
    return;
  }

  // Promise — await then output
  if (value instanceof Promise) {
    return value.then((resolved) => outputValue(resolved, output));
  }

  // Pass value directly — runtime handles formatting
  output(value);
}

/**
 * Resolves a result value by unwrapping Promises and collecting iterables into arrays.
 * This is the runtime counterpart of the `Drained<T>` type.
 */
export async function drainValue(value: unknown): Promise<unknown> {
  // Unwrap promises first
  if (value instanceof Promise) {
    return drainValue(await value);
  }

  // Async iterator — collect into array
  if (isAsyncIterator(value)) {
    const items: unknown[] = [];
    const iter = (value as any)[Symbol.asyncIterator]();
    while (true) {
      const { done, value: item } = await iter.next();
      if (done) break;
      items.push(item);
    }
    return items;
  }

  // Sync iterator (but not string/array)
  if (typeof value !== 'string' && !Array.isArray(value) && isIterator(value)) {
    const items: unknown[] = [];
    const iter = (value as any)[Symbol.iterator]();
    while (true) {
      const { done, value: item } = iter.next();
      if (done) break;
      items.push(item);
    }
    return items;
  }

  return value;
}

/**
 * Attaches a `drain()` method to a command result object.
 * If the result has an `error` field, `drain()` returns `{ error }`.
 * Otherwise, resolves the result (unwrapping Promises, collecting iterables), catches errors,
 * and returns a discriminated union `{ value } | { error }` that never throws.
 */
export function withDrain<T extends Record<string, unknown>>(obj: T): T & { drain: () => Promise<any> } {
  (obj as any).drain = async () => {
    if ('error' in obj && obj.error !== undefined) {
      return { error: obj.error };
    }
    try {
      const value = await drainValue(obj.result);
      return { value };
    } catch (err) {
      return { error: err };
    }
  };
  return obj as any;
}

/**
 * Creates an error command result with a `drain()` that returns the error.
 */
export function errorResult(error: unknown, partial?: { command?: unknown; args?: unknown; argsResult?: unknown }) {
  return withDrain({
    error,
    result: undefined,
    command: partial?.command,
    args: partial?.args,
    argsResult: partial?.argsResult,
  });
}

export function isAsyncBranded(schema: unknown): boolean {
  return !!schema && typeof schema === 'object' && '~async' in schema && (schema as any)['~async'] === true;
}

export function hasInteractiveConfig(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as Record<string, unknown>;
  return m.interactive === true || Array.isArray(m.interactive) || m.optionalInteractive === true || Array.isArray(m.optionalInteractive);
}

/** Whether a command prompts for missing args: its own interactive config, or that of the global args in effect. */
export function usesInteractive(command: AnyPadroneCommand): boolean {
  return hasInteractiveConfig(command.meta) || hasInteractiveConfig(getGlobalArgs(command)?.meta);
}

/** Whether a command may validate asynchronously: marked async, or under async or interactive global args. */
export function isAsyncCommand(command: AnyPadroneCommand): boolean {
  if (command.isAsync) return true;
  const globalArgs = getGlobalArgs(command);
  return !!globalArgs && (isAsyncBranded(globalArgs.schema) || hasInteractiveConfig(globalArgs.meta));
}

export function warnIfUnexpectedAsync<T>(value: T, command: AnyPadroneCommand): T {
  const runtime = getCommandRuntime(command);
  if (runtime.env().NODE_ENV === 'production') return value;
  if (value instanceof Promise && !isAsyncCommand(command)) {
    runtime.error(
      `[padrone] Command "${command.path || command.name}" returned a Promise from validation, ` +
        `but was not marked as async. Use \`.async()\` on the builder or \`asyncSchema()\` to brand your schema. ` +
        `Without this, TypeScript will infer a sync return type and the result will be a Promise at runtime.`,
    );
  }
  return value;
}
