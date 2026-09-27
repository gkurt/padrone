import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PadroneSchema } from '../types/index.ts';

export interface AsyncStreamMeta {
  [x: string]: unknown;
  readonly asyncStream: number;
  readonly itemSchema?: StandardSchemaV1;
}

let asyncStreamIdCounter = 1;
export const asyncStreamRegistry = new Map<number, AsyncStreamMeta>();

/**
 * Returns metadata to mark a schema field as an async stream via `.meta()`.
 *
 * When used with `stdin`, padrone pipes stdin data as an `AsyncIterable` instead of
 * buffering it. Each line is validated against the item schema (if provided) as it arrives.
 *
 * @param itemSchema - Optional item schema that validates each stdin line (a string). It must parse the line
 *   itself, e.g. `jsonCodec(schema)` from `padrone/zod` for JSON lines.
 *
 * @example
 * ```ts
 * import { asyncStream } from 'padrone';
 *
 * // String lines
 * z.object({ lines: z.custom<AsyncIterable<string>>().meta(asyncStream()) })
 *
 * // Typed items — each line validated (and parsed) by the item schema
 * z.object({ records: z.custom<AsyncIterable<{ name: string }>>().meta(asyncStream(jsonCodec(recordSchema))) })
 * ```
 */
export function asyncStream<T = string>(itemSchema?: PadroneSchema<T>): AsyncStreamMeta {
  const id = asyncStreamIdCounter++;
  const meta: AsyncStreamMeta = itemSchema ? { asyncStream: id, itemSchema } : { asyncStream: id };
  asyncStreamRegistry.set(id, meta);
  return meta;
}

/** Stdin interface matching PadroneRuntime.stdin */
interface StdinSource {
  isTTY?: boolean;
  text(): Promise<string>;
  lines(): AsyncIterable<string>;
}

/**
 * Creates an `AsyncIterable` from a stdin source, optionally validating each item.
 * When no stdin is available (TTY / undefined), yields nothing.
 *
 * - No item schema: yields raw string lines
 * - With item schema: validates each line and yields the schema's output
 */
export function createStdinStream(stdin: StdinSource | undefined, itemSchema?: StandardSchemaV1): AsyncIterable<unknown> {
  if (!stdin) return emptyAsyncIterable;

  if (!itemSchema) return stdin.lines();

  return {
    async *[Symbol.asyncIterator]() {
      for await (const line of stdin.lines()) {
        const result = itemSchema['~standard'].validate(line);
        const resolved = result instanceof Promise ? await result : result;
        if ('issues' in resolved && resolved.issues) {
          throw new Error(`Stream item validation failed: ${resolved.issues.map((i) => i.message).join(', ')}`);
        }
        yield (resolved as { value: unknown }).value;
      }
    },
  };
}

const emptyAsyncIterable: AsyncIterable<never> = {
  async *[Symbol.asyncIterator]() {},
};

const textEncoder = /* @__PURE__ */ new TextEncoder();
const textDecoder = /* @__PURE__ */ new TextDecoder();

/** Concatenate multiple `Uint8Array` chunks into a single array. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let totalLength = 0;
  for (const chunk of chunks) totalLength += chunk.byteLength;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Read an async iterable of chunks into a UTF-8 string. */
export async function readStreamAsText(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? textEncoder.encode(chunk) : chunk);
  }
  return textDecoder.decode(concatBytes(chunks));
}
