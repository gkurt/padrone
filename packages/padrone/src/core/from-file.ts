import type { StandardSchemaV1 } from '@standard-schema/spec';
import { isRemoteCaller } from '#src/extension/utils.ts';
import type { AnyPadroneCommand } from '#src/types/index.ts';
import { fileErrorReason, readTextFile } from '#src/util/files.ts';
import { getStdinConfig, isAsyncStreamField, parsePositionalConfig } from './args.ts';
import { resolveStdin, resolveStdinAlways } from './default-runtime.ts';
import type { PadroneRuntime } from './runtime.ts';
import { getCommandFieldRules } from './validate.ts';

type Issue = StandardSchemaV1.Issue;
type Slot = { field: string; source: string; set: (value: string) => void };

const isStdin = (source: string) => source === '-' || source === '@-';

/** The field each positional value lands in, following `meta.positional` (a variadic one takes what the fields after it leave). */
export function positionalFields(command: AnyPadroneCommand, count: number): (string | undefined)[] {
  const config = command.meta?.positional ? parsePositionalConfig(command.meta.positional) : [];
  const fields: (string | undefined)[] = [];
  let index = 0;
  config.forEach(({ name, variadic }, i) => {
    const end = variadic ? count - config.slice(i + 1).filter((p) => !p.variadic).length : index + 1;
    for (; index < end && index < count; index++) fields[index] = name;
  });
  return fields;
}

/**
 * Reads the command-line values of `fromFile` fields, in place: `@path` becomes the file's text, `-` (or `@-`) stdin's,
 * and `@@text` becomes `@text`. Returns the issues (an unreadable file, stdin wanted twice). Remote callers' values stay as given.
 */
export function readFileValues(
  command: AnyPadroneCommand,
  rawArgs: Record<string, unknown>,
  positionalArgs: string[],
  runtime: PadroneRuntime,
  caller: string,
): Issue[] | undefined | Promise<Issue[] | undefined> {
  const fields = getCommandFieldRules(command).fromFile;
  if (fields.size === 0 || isRemoteCaller(caller)) return undefined;

  const slots: Slot[] = [];
  const add = (field: string, source: unknown, set: Slot['set']) => {
    if (typeof source === 'string' && (source.startsWith('@') || source === '-')) slots.push({ field, source, set });
  };
  for (const field of fields) {
    const value = rawArgs[field];
    if (!Array.isArray(value)) add(field, value, (text) => (rawArgs[field] = text));
    else for (let i = 0; i < value.length; i++) add(field, value[i], (text) => (value[i] = text));
  }
  const positional = positionalFields(command, positionalArgs.length);
  for (let i = 0; i < positional.length; i++) {
    const field = positional[i];
    if (field && fields.has(field)) add(field, positionalArgs[i], (text) => (positionalArgs[i] = text));
  }
  if (slots.length === 0) return undefined;

  const issues: Issue[] = slots
    .filter((slot) => slot.source === '@')
    .map((slot) => ({ path: [slot.field], message: 'Expected a file path after "@"' }));
  const stdinSlots = slots.filter((slot) => isStdin(slot.source));
  if (stdinSlots.length > 1) issues.push({ path: [], message: 'Only one value can be read from stdin ("-")' });
  // The stdin field reads stdin when given `-`, or when not given and stdin is piped (a stream field reads a terminal too)
  const stdinField = getStdinConfig(command.meta)?.field;
  const stdinValue = stdinField && (rawArgs[stdinField] ?? positionalArgs[positional.indexOf(stdinField)]);
  const readsUnset = () => !!resolveStdin({ stdin: runtime.stdin }) || !!isAsyncStreamField(command.argsSchema, stdinField!);
  const stdinFieldReads = !!stdinField && (String(stdinValue) === '-' || (stdinValue === undefined && readsUnset()));
  const otherStdinSlot = stdinSlots.find((slot) => slot.field !== stdinField);
  if (otherStdinSlot && stdinFieldReads) {
    issues.push({ path: [otherStdinSlot.field], message: `Cannot read stdin ("-"): the command reads stdin into "${stdinField}"` });
  }
  if (issues.length > 0) return issues;

  const outcomes = slots.map((slot): Issue | undefined | Promise<Issue | undefined> => {
    const { source, field } = slot;
    const set = (text: string) => void slot.set(text);
    if (source.startsWith('@@')) return set(source.slice(1));
    const fail = (err: unknown): Issue => ({
      path: [field],
      message: `Cannot read ${isStdin(source) ? 'stdin' : `"${source.slice(1)}"`}: ${fileErrorReason(err)}`,
    });
    try {
      const text = isStdin(source) ? resolveStdinAlways({ stdin: runtime.stdin }).text() : readTextFile(source.slice(1));
      return text instanceof Promise ? text.then(set, fail) : set(text);
    } catch (err) {
      return fail(err);
    }
  });
  const collect = (results: (Issue | undefined)[]) => {
    const failed = results.filter((issue): issue is Issue => !!issue);
    return failed.length > 0 ? failed : undefined;
  };
  return outcomes.some((o) => o instanceof Promise) ? Promise.all(outcomes).then(collect) : collect(outcomes as (Issue | undefined)[]);
}
