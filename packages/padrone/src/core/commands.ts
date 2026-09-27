import type { AnyPadroneCommand, PadroneGlobalArgsMeta, PadroneSchema } from '../types/index.ts';
import { extractSchemaMetadata, getJsonSchema, markSensitiveProperties } from './args.ts';
import { resolveRuntime } from './default-runtime.ts';
import type { ResolvedPadroneRuntime } from './runtime.ts';

// ---------------------------------------------------------------------------
// Lazy command resolution
// ---------------------------------------------------------------------------

export const lazyResolver = Symbol('lazyResolver');

/** Resolves a lazy command in place by calling its stored resolver. No-op if already resolved. */
export function resolveCommand(cmd: AnyPadroneCommand): AnyPadroneCommand {
  const resolver = (cmd as any)[lazyResolver];
  if (resolver) {
    delete (cmd as any)[lazyResolver];
    resolver(cmd);
  }
  return cmd;
}

/** Recursively resolves a command and all its descendants. */
export function resolveAllCommands(cmd: AnyPadroneCommand): void {
  resolveCommand(cmd);
  if (cmd.commands) {
    for (const sub of cmd.commands) resolveAllCommands(sub);
  }
}

/** Checks whether a value is a Padrone program/builder. */
export function isPadroneProgram(value: unknown): value is object {
  return !!value && typeof value === 'object' && commandSymbol in value;
}

/** Extracts the underlying command from a program/builder and resolves the full command tree. */
export function getCommand(program: object): AnyPadroneCommand {
  const cmd = commandSymbol in program ? ((program as any)[commandSymbol] as AnyPadroneCommand) : (program as AnyPadroneCommand);
  resolveAllCommands(cmd);
  return cmd;
}

export const commandSymbol = Symbol('padrone_command');

/** Config keys that are merged when overriding a command. */
export const configKeys = [
  'title',
  'description',
  'version',
  'deprecated',
  'hidden',
  'mutation',
  'needsApproval',
  'outputSchema',
  'help',
  'flagNames',
] as const;

/**
 * Merges an existing command with an override.
 * - Config fields are shallow-merged (new overrides old).
 * - Action, arguments, meta, config schema, env schema are taken from the override if set.
 * - Subcommands are recursively merged by name.
 */
export function mergeCommands(existing: AnyPadroneCommand, override: AnyPadroneCommand): AnyPadroneCommand {
  resolveCommand(existing);
  resolveCommand(override);
  const merged: AnyPadroneCommand = { ...existing };

  // Merge config fields
  for (const key of configKeys) {
    if (override[key] !== undefined) (merged as any)[key] = override[key];
  }

  // Override fields: take from override if explicitly set (not inherited from existing via spread)
  if (override.action !== existing.action) merged.action = override.action;
  if (override.dryRun !== existing.dryRun) merged.dryRun = override.dryRun;
  if (override.argsSchema !== existing.argsSchema) merged.argsSchema = override.argsSchema;
  if (override.globalArgsSchema !== existing.globalArgsSchema) merged.globalArgsSchema = override.globalArgsSchema;
  if (override.globalArgsMeta !== existing.globalArgsMeta) merged.globalArgsMeta = override.globalArgsMeta;
  if (override.meta !== existing.meta) merged.meta = override.meta;
  if (override.isAsync !== existing.isAsync) merged.isAsync = override.isAsync || existing.isAsync;
  if (override.runtime !== existing.runtime) merged.runtime = override.runtime;
  if (override.interceptors !== existing.interceptors) merged.interceptors = override.interceptors;
  if (override.aliases !== existing.aliases) merged.aliases = override.aliases;
  // Recursively merge subcommands by name
  if (override.commands) {
    const baseCommands = [...(existing.commands || [])];
    for (const overrideChild of override.commands) {
      const existingIndex = baseCommands.findIndex((c) => c.name === overrideChild.name);
      if (existingIndex >= 0) {
        baseCommands[existingIndex] = mergeCommands(baseCommands[existingIndex]!, overrideChild);
      } else {
        baseCommands.push(overrideChild);
      }
    }
    merged.commands = baseCommands;
  }

  return merged;
}

/** The global args in effect for a command: its own `.globalArgs()`, or else the nearest ancestor's. */
export function getGlobalArgs(command: AnyPadroneCommand): { schema: PadroneSchema; meta?: PadroneGlobalArgsMeta } | undefined {
  for (let current: AnyPadroneCommand | undefined = command; current; current = current.parent) {
    if (current.globalArgsSchema) return { schema: current.globalArgsSchema, meta: current.globalArgsMeta };
  }
  return undefined;
}

/**
 * Resolves the runtime for a command by walking up the parent chain.
 * Returns a fully resolved runtime with all defaults filled in.
 */
export function getCommandRuntime(cmd: AnyPadroneCommand): ResolvedPadroneRuntime {
  let current: AnyPadroneCommand | undefined = cmd;
  while (current) {
    if (current.runtime) return resolveRuntime(current.runtime);
    current = current.parent;
  }
  return resolveRuntime();
}

/**
 * Recursively re-paths a command tree under a new parent path, updating parent references.
 */
export function repathCommandTree(
  cmd: AnyPadroneCommand,
  newName: string,
  parentPath: string,
  parent: AnyPadroneCommand,
): AnyPadroneCommand {
  resolveCommand(cmd);
  const newPath = parentPath ? `${parentPath} ${newName}` : newName;
  const remounted: AnyPadroneCommand = {
    ...cmd,
    name: newName,
    path: newPath,
    parent,
    version: undefined,
  };

  if (cmd.commands?.length) {
    remounted.commands = cmd.commands.map((child) => repathCommandTree(child, child.name, newPath, remounted));
  }

  return remounted;
}

/**
 * Builds a completer function for the REPL from the command tree.
 * Completes command names, subcommand names, option names (--foo), and aliases (-f).
 * Also includes dot-prefixed built-in REPL commands (.exit, .clear, .scope, .help, .history).
 */
export function buildReplCompleter(
  rootCommand: AnyPadroneCommand,
  builtins: {
    inScope?: boolean;
  },
): (line: string) => [string[], string] {
  resolveAllCommands(rootCommand);
  return (line: string): [string[], string] => {
    const trimmed = line.trimStart();
    const parts = trimmed.split(/\s+/);
    const lastPart = parts[parts.length - 1] ?? '';

    // If we're completing a dot-command
    if (lastPart.startsWith('.')) {
      const dotCmds = ['.exit', '.clear', '.help', '.history'];
      if (rootCommand.commands?.some((c) => c.commands?.length) || builtins.inScope) dotCmds.push('.scope');
      const hits = dotCmds.filter((c) => c.startsWith(lastPart));
      return [hits.length ? hits : dotCmds, lastPart];
    }

    // If we're completing an option (starts with -)
    if (lastPart.startsWith('-')) {
      // Find which command we're in
      const commandParts = parts.slice(0, -1).filter((p) => !p.startsWith('-'));
      let targetCommand = rootCommand;
      for (const part of commandParts) {
        resolveCommand(targetCommand);
        const sub = targetCommand.commands?.find((c) => c.name === part || c.aliases?.includes(part));
        if (sub) {
          resolveCommand(sub);
          targetCommand = sub;
        } else break;
      }

      // Options of this command, then its global options
      const options: string[] = [];
      const globals = getGlobalArgs(targetCommand);
      for (const [schema, meta] of [
        [targetCommand.argsSchema, targetCommand.meta],
        [globals?.schema, globals?.meta],
      ] as const) {
        if (!schema) continue;
        try {
          const { flags, aliases } = extractSchemaMetadata(schema, meta?.fields, meta?.autoAlias);
          const jsonSchema = getJsonSchema(schema) as Record<string, any>;
          if (jsonSchema.type === 'object' && jsonSchema.properties) {
            for (const key of Object.keys(jsonSchema.properties)) options.push(`--${key}`);
            for (const flag of Object.keys(flags)) options.push(`-${flag}`);
            for (const alias of Object.keys(aliases)) options.push(`--${alias}`);
          }
        } catch {
          // Ignore schema parsing errors
        }
      }
      // The flags of the built-in help command (`--help`, or as renamed with `padroneHelp({ flags })`)
      let root = targetCommand;
      while (root.parent) root = root.parent;
      const helpCommand = root.commands?.find((c) => c.name === 'help');
      const helpFlags = (helpCommand && resolveCommand(helpCommand).flagNames) ?? [];
      options.push(...helpFlags.map((flag) => (flag.length > 1 ? `--${flag}` : `-${flag}`)));

      const unique = [...new Set(options)];
      const hits = unique.filter((o) => o.startsWith(lastPart));
      return [hits.length ? hits : unique, lastPart];
    }

    // Completing command names
    const commandParts = parts.filter((p) => !p.startsWith('-'));
    // Walk into subcommands for all but the last token
    let targetCommand = rootCommand;
    for (let i = 0; i < commandParts.length - 1; i++) {
      resolveCommand(targetCommand);
      const sub = targetCommand.commands?.find((c) => c.name === commandParts[i] || c.aliases?.includes(commandParts[i]!));
      if (sub) {
        resolveCommand(sub);
        targetCommand = sub;
      } else break;
    }

    const candidates: string[] = [];

    // Add subcommand names and aliases
    if (targetCommand.commands) {
      for (const cmd of targetCommand.commands) {
        if (!cmd.hidden) {
          candidates.push(cmd.name);
          if (cmd.aliases) candidates.push(...cmd.aliases.filter(Boolean));
        }
      }
    }

    // Add dot-commands and `..` shorthand at the root level (relative to current scope)
    if (targetCommand === rootCommand) {
      candidates.push('.help', '.exit', '.clear', '.history');
      if (rootCommand.commands?.some((c) => c.commands?.length) || builtins.inScope) candidates.push('.scope');
      if (builtins.inScope) candidates.push('..');
    }

    const hits = candidates.filter((c) => c.startsWith(lastPart));
    return [hits.length ? hits : candidates, lastPart];
  };
}

/**
 * Computes the Levenshtein edit distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = temp;
    }
  }

  return dp[n]!;
}

/**
 * Finds close matches from a list of candidates using Levenshtein distance
 * and prefix/substring matching (for inputs longer than 3 characters).
 * Returns up to 3 matching candidate names (raw, unformatted).
 */
export function suggestSimilar(input: string, candidates: string[]): string[] {
  if (candidates.length === 0) return [];

  const lower = input.toLowerCase();
  const matches: { candidate: string; score: number }[] = [];

  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();
    if (candidate === input) continue;
    // Differs only in case (`Deploy` for `deploy`)
    if (candidateLower === lower) {
      matches.push({ candidate, score: 0 });
      continue;
    }

    const dist = levenshtein(lower, candidateLower);
    const maxLen = Math.max(input.length, candidate.length);
    const threshold = Math.min(3, Math.max(1, Math.ceil(maxLen * 0.4)));

    if (dist > 0 && dist <= threshold) {
      matches.push({ candidate, score: dist });
    } else if (lower.length >= 3) {
      // Prefix or substring match for longer inputs
      if (candidateLower.startsWith(lower) || candidateLower.includes(lower)) {
        matches.push({ candidate, score: threshold + 1 });
      }
    }
  }

  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, 3).map((m) => m.candidate);
}

/** `Did you mean "a", "b" or "c"?` for the given names (each after `prefix`, like `--`); `''` for none. */
export function formatSuggestions(names: string[], prefix = ''): string {
  if (names.length === 0) return '';
  const quoted = names.map((n) => `"${prefix}${n}"`);
  if (quoted.length === 1) return `Did you mean ${quoted[0]}?`;
  return `Did you mean ${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}?`;
}

/** The names and aliases of a command's visible subcommands, the candidates for a mistyped one. */
export function subcommandNames(command: AnyPadroneCommand): string[] {
  return (command.commands ?? []).flatMap((cmd) => {
    resolveCommand(cmd);
    return cmd.hidden ? [] : [cmd.name, ...(cmd.aliases ?? [])];
  });
}

export function findCommandByName(name: string, commands?: AnyPadroneCommand[]): AnyPadroneCommand | undefined {
  if (!commands) return undefined;

  const foundByName = commands.find((cmd) => cmd.name === name);
  if (foundByName) return resolveCommand(foundByName);

  // Check for aliases
  const foundByAlias = commands.find((cmd) => cmd.aliases?.includes(name));
  if (foundByAlias) return resolveCommand(foundByAlias);

  for (const cmd of commands) {
    if (name.startsWith(`${cmd.name} `)) {
      resolveCommand(cmd);
      if (cmd.commands) {
        const subCommandName = name.slice(cmd.name.length + 1);
        const subCommand = findCommandByName(subCommandName, cmd.commands);
        if (subCommand) return subCommand;
      }
    }
    // Check aliases for nested commands
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        if (name.startsWith(`${alias} `)) {
          resolveCommand(cmd);
          if (cmd.commands) {
            const subCommandName = name.slice(alias.length + 1);
            const subCommand = findCommandByName(subCommandName, cmd.commands);
            if (subCommand) return subCommand;
          }
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared utilities for MCP and serve
// ---------------------------------------------------------------------------

export type CollectedEndpoint = { name: string; command: AnyPadroneCommand };

/** Collect all actionable commands recursively. Hidden commands are excluded. */
export function collectEndpoints(commands: AnyPadroneCommand[] | undefined, prefix: string): CollectedEndpoint[] {
  if (!commands) return [];
  const endpoints: CollectedEndpoint[] = [];
  for (const cmd of commands) {
    resolveCommand(cmd);
    if (cmd.hidden) continue;
    const path = cmd.name ? (prefix ? `${prefix}.${cmd.name}` : cmd.name) : prefix;
    if (cmd.action || cmd.argsSchema) {
      endpoints.push({ name: path, command: cmd });
    }
    if (cmd.commands?.length) {
      endpoints.push(...collectEndpoints(cmd.commands, path));
    }
  }
  return endpoints;
}

/** Build the JSON Schema for a command's arguments, plus `dryRun` when it has a dry-run handler. */
export function buildInputSchema(cmd: AnyPadroneCommand): Record<string, unknown> {
  const schema = buildArgsInputSchema(cmd);
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if (!cmd.dryRun || (schema.type !== undefined && schema.type !== 'object') || 'dryRun' in properties || 'dry-run' in properties)
    return schema;
  // Serve, MCP and tool callers ask for a dry run with `dryRun: true`, like `--dry-run`
  return {
    ...schema,
    type: 'object',
    properties: { ...properties, dryRun: { type: 'boolean', description: 'Show what would change without changing anything' } },
  };
}

/** The JSON Schema of a command's result, from `.configure({ outputSchema })`. */
export function buildOutputSchema(cmd: AnyPadroneCommand): Record<string, unknown> | undefined {
  if (!cmd.outputSchema) return undefined;
  try {
    return cmd.outputSchema['~standard'].jsonSchema.output({ target: 'draft-2020-12', libraryOptions: { unrepresentable: 'any' } });
  } catch {
    return undefined;
  }
}

/** A JSON schema with its sensitive properties marked `writeOnly`, without their defaults and examples. */
function withSensitiveMarked(schema: Record<string, any>, fields: Record<string, any> | undefined): Record<string, any> {
  return schema.properties ? { ...schema, properties: markSensitiveProperties(schema.properties, fields) } : schema;
}

function buildArgsInputSchema(cmd: AnyPadroneCommand): Record<string, unknown> {
  const empty = { type: 'object', additionalProperties: false };
  let own: Record<string, any> = empty;
  try {
    if (cmd.argsSchema) own = withSensitiveMarked(getJsonSchema(cmd.argsSchema), cmd.meta?.fields);
  } catch {}

  // Merge in the global args in effect; the command's own properties win
  const globalArgs = getGlobalArgs(cmd);
  if (!globalArgs) return own;
  let globals: Record<string, any>;
  try {
    globals = withSensitiveMarked(getJsonSchema(globalArgs.schema), globalArgs.meta?.fields);
  } catch {
    return own;
  }
  if (globals.type !== 'object' || !globals.properties || (own !== empty && own.type !== 'object')) return own;

  const ownProperties: Record<string, unknown> = own.properties ?? {};
  const globalOnly = Object.keys(globals.properties).filter((key) => !(key in ownProperties));
  const required = [
    ...(own.required ?? []),
    ...((globals.required as string[] | undefined) ?? []).filter((key) => globalOnly.includes(key)),
  ];
  return {
    ...own,
    type: 'object',
    properties: { ...Object.fromEntries(globalOnly.map((key) => [key, globals.properties[key]])), ...ownProperties },
    ...(required.length > 0 && { required }),
  };
}

/**
 * Arg name → first custom negative keyword (`negative: 'remote'`), or `''` when the `--no-` prefix is disabled without one,
 * from the command's schema and its global args.
 */
export function getNegativeKeywords(cmd: AnyPadroneCommand): Record<string, string> {
  const keywords: Record<string, string> = {};
  const collect = (schema: PadroneSchema | undefined, meta: { fields?: any; autoAlias?: boolean } | undefined) => {
    if (!schema) return;
    try {
      const { negatives, customNegation } = extractSchemaMetadata(schema, meta?.fields, meta?.autoAlias);
      for (const [keyword, argName] of Object.entries(negatives)) keywords[argName] ??= keyword;
      for (const argName of customNegation) keywords[argName] ??= '';
    } catch {}
  };
  collect(cmd.argsSchema, cmd.meta);
  const globals = getGlobalArgs(cmd);
  if (globals) collect(globals.schema, globals.meta);
  return keywords;
}

/** Whether an object can be passed as dotted keys (`--a.b=x`): non-empty, with plain keys, and scalars or such objects as values. */
function isDottable(value: object): boolean {
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([key, v]) =>
        key !== '' &&
        !key.includes('.') &&
        key !== '__proto__' &&
        !Array.isArray(v) &&
        (typeof v !== 'object' || v === null || isDottable(v)),
    )
  );
}

/**
 * Serializes args into argv tokens (`--key=value`, one per token, unquoted), for passing to `eval()` as an array:
 * `null` and `undefined` are left out, booleans become `--key` / `--no-key` (or the custom negative keyword, or `--key=false`),
 * arrays repeat the flag (`--key=[]` when empty), objects become `--a.b=`, or JSON (`--a={...}`) when dotted keys can't
 * express them (keys with dots, arrays inside, empty objects). Array items that are objects are JSON too.
 */
export function serializeArgsToFlags(args: Record<string, unknown>, cmd?: AnyPadroneCommand): string[] {
  const negatives = cmd ? getNegativeKeywords(cmd) : {};
  const parts: string[] = [];
  const add = (key: string, value: unknown) => {
    // `null` (allowed by nullable fields' JSON Schema) is unset, like an omitted key
    if (value === undefined || value === null) return;
    if (typeof value === 'boolean') {
      const negative = negatives[key] ?? `no-${key}`;
      parts.push(value ? `--${key}` : negative ? `--${negative}` : `--${key}=false`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) parts.push(`--${key}=[]`);
      for (const v of value) {
        const text = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
        // `--key=[a,b]` is list syntax, so a bracketed item goes in a token of its own, which is taken as is
        if (text.startsWith('[') && text.endsWith(']')) parts.push(`--${key}`, text);
        else parts.push(`--${key}=${text}`);
      }
    } else if (typeof value === 'object' && value !== null) {
      if (!isDottable(value)) parts.push(`--${key}=${JSON.stringify(value)}`);
      else for (const [nestedKey, nestedValue] of Object.entries(value)) add(`${key}.${nestedKey}`, nestedValue);
    } else {
      parts.push(`--${key}=${String(value)}`);
    }
  };
  for (const [key, value] of Object.entries(args)) add(key, value);
  return parts;
}
