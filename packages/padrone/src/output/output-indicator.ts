import { safeJsonStringify } from '../util/json.ts';
import type { KeyValueOptions, ListItem, ListOptions, TableOptions, TreeNode, TreeOptions } from './primitives.ts';
import { renderKeyValue, renderList, renderTable, renderTree } from './primitives.ts';
import type { OutputContext } from './styling.ts';

/**
 * Runtime output helper injected into action context as `ctx.context.output`.
 * Provides format-aware output primitives (table, tree, list, key-value).
 *
 * Each method renders data using the resolved format (ANSI, text, JSON, markdown, HTML)
 * and writes it to the runtime's output function.
 */
export type PadroneOutputIndicator = {
  /** Render data as a table. */
  table(data: Record<string, unknown>[], options?: TableOptions): void;
  /** Render data as a tree. */
  tree(data: TreeNode | TreeNode[], options?: TreeOptions): void;
  /** Render data as a list. */
  list(data: ListItem[], options?: ListOptions): void;
  /** Render data as aligned key-value pairs. */
  kv(data: Record<string, unknown>, options?: KeyValueOptions): void;
  /** Write raw output (same as runtime.output but sets the "already called" flag). */
  raw(...args: unknown[]): void;
  /** Whether any output method has been called. */
  readonly called: boolean;
};

/** Declarative output configuration for a command. */
export type OutputPrimitiveType = 'table' | 'tree' | 'list' | 'kv' | 'json';
export type OutputConfig =
  | OutputPrimitiveType
  | { type: OutputPrimitiveType; options?: TableOptions | TreeOptions | ListOptions | KeyValueOptions };

/** Create an output indicator that renders through the given output function and format context. */
export function createOutputIndicator(outputFn: (...args: unknown[]) => void, ctx: OutputContext): PadroneOutputIndicator {
  let _called = false;

  const emit = (rendered: string) => {
    _called = true;
    outputFn(rendered);
  };

  return {
    table(data, options) {
      emit(renderTable(data, options, ctx));
    },
    tree(data, options) {
      emit(renderTree(data, options, ctx));
    },
    list(data, options) {
      emit(renderList(data, options, ctx));
    },
    kv(data, options) {
      emit(renderKeyValue(data, options, ctx));
    },
    raw(...args) {
      _called = true;
      outputFn(...args);
    },
    get called() {
      return _called;
    },
  };
}

/** Format a return value using a declarative output config. */
export function formatDeclarativeOutput(value: unknown, config: OutputConfig, ctx: OutputContext): string | undefined {
  const type = typeof config === 'string' ? config : config.type;
  const options = typeof config === 'object' ? config.options : undefined;

  switch (type) {
    case 'table':
      if (!Array.isArray(value)) return undefined;
      return renderTable(value as Record<string, unknown>[], options as TableOptions | undefined, ctx);
    case 'tree':
      if (typeof value !== 'object' || value === null) return undefined;
      return renderTree(value as TreeNode | TreeNode[], options as TreeOptions | undefined, ctx);
    case 'list':
      if (!Array.isArray(value)) return undefined;
      return renderList(value as ListItem[], options as ListOptions | undefined, ctx);
    case 'kv':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      return renderKeyValue(value as Record<string, unknown>, options as KeyValueOptions | undefined, ctx);
    case 'json':
      return safeJsonStringify(value, 2);
    default:
      return undefined;
  }
}
