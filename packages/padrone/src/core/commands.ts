import type { AnyPadroneCommand, PadroneGlobalArgsMeta, PadroneSchema } from '../types/index.ts';
import { extractSchemaMetadata, getJsonSchema } from './args.ts';
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
export const configKeys = ['title', 'description', 'version', 'deprecated', 'hidden', 'mutation', 'needsApproval'] as const;

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

      // Get options for this command
      const options: string[] = [];
      if (targetCommand.argsSchema) {
        try {
          const argsMeta = targetCommand.meta?.fields;
          const { flags, aliases } = extractSchemaMetadata(targetCommand.argsSchema, argsMeta, targetCommand.meta?.autoAlias);
          const jsonSchema = getJsonSchema(targetCommand.argsSchema) as Record<string, any>;
          if (jsonSchema.type === 'object' && jsonSchema.properties) {
            for (const key of Object.keys(jsonSchema.properties)) {
              options.push(`--${key}`);
            }
            for (const flag of Object.keys(flags)) {
              options.push(`-${flag}`);
            }
            for (const alias of Object.keys(aliases)) {
              options.push(`--${alias}`);
            }
          }
        } catch {
          // Ignore schema parsing errors
        }
      }
      // Add global flags
      options.push('--help', '-h');

      const hits = options.filter((o) => o.startsWith(lastPart));
      return [hits.length ? hits : options, lastPart];
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
          if (cmd.aliases) candidates.push(...cmd.aliases);
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
    if (candidateLower === lower) continue;

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

/** Build the JSON Schema for a command's arguments. */
export function buildInputSchema(cmd: AnyPadroneCommand): Record<string, unknown> {
  const empty = { type: 'object', additionalProperties: false };
  let own: Record<string, any> = empty;
  try {
    if (cmd.argsSchema) own = getJsonSchema(cmd.argsSchema);
  } catch {}

  // Merge in the global args in effect; the command's own properties win
  const globalSchema = getGlobalArgs(cmd)?.schema;
  if (!globalSchema) return own;
  let globals: Record<string, any>;
  try {
    globals = getJsonSchema(globalSchema);
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

/** Serialize a record of args into CLI flag strings. */
export function serializeArgsToFlags(args: Record<string, unknown>): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (typeof value === 'boolean') {
      parts.push(value ? `--${key}` : `--no-${key}`);
    } else if (Array.isArray(value)) {
      for (const v of value) parts.push(`--${key}=${String(v)}`);
    } else {
      const strVal = String(value);
      parts.push(strVal.includes(' ') ? `--${key}="${strVal}"` : `--${key}=${strVal}`);
    }
  }
  return parts;
}
