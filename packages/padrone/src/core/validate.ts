import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AnyPadroneCommand, InterceptorValidateResult, PadroneGlobalArgsMeta, PadroneInput, PadroneSchema } from '../types/index.ts';
import { camelToKebab } from '../util/shell-utils.ts';
import {
  applyFieldRules,
  checkFieldRequirements,
  coerceArgs,
  createOptionArityLookup,
  detectUnknownArgs,
  extractFieldRules,
  extractSchemaMetadata,
  type FieldRules,
  getJsonSchema,
  getOptionArity,
  parsePositionalConfig,
  preprocessArgs,
} from './args.ts';
import { getCommandRuntime, getGlobalArgs } from './commands.ts';
import type { OptionArity, ParseResolver } from './parse.ts';
import { getNestedValue, parseCliInputToParts, setNestedValue } from './parse.ts';
import { thenMaybe } from './results.ts';

/** Options the command's interceptors (and its ancestors') read from `rawArgs`, keyed by name or flag. */
function collectInterceptorOptions(command: AnyPadroneCommand): Record<string, OptionArity> {
  const options: Record<string, OptionArity> = {};
  for (let current: AnyPadroneCommand | undefined = command; current; current = current.parent) {
    for (const { meta } of current.interceptors ?? []) {
      if (meta.disabled || !meta.options) continue;
      // The nearest declaration wins, except that a counting flag wins over a plain one (e.g. logger `-v` over version `-v`)
      for (const [key, arity] of Object.entries(meta.options)) {
        if (options[key] === undefined || (arity === 'count' && options[key] === 'flag')) options[key] = arity;
      }
    }
  }
  return options;
}

/** Options interceptors on the command chain declare, with their arity (e.g. `{ config: 'value', help: 'flag' }`). */
export function getInterceptorOptions(command: AnyPadroneCommand): Record<string, OptionArity> {
  return collectInterceptorOptions(command);
}

/** Names of the options interceptors on the command chain declare (`meta.options`), which they read from `rawArgs` themselves. */
export function getInterceptorOptionNames(command: AnyPadroneCommand): Set<string> {
  return new Set(Object.keys(collectInterceptorOptions(command)));
}

type SchemaOptionInfo = ReturnType<typeof extractSchemaMetadata> & {
  /** Arity from the schema's own properties. */
  schemaArity: (key: string[], short: boolean) => OptionArity | undefined;
  arrayArguments: Set<string>;
  properties: Set<string>;
  rules: FieldRules;
};

type CommandOptionInfo = SchemaOptionInfo & {
  /** Options declared by interceptors on the command chain. */
  interceptorOptions: Record<string, OptionArity>;
};

function getPropertyNames(schema: PadroneSchema | undefined): Set<string> {
  if (!schema) return new Set();
  try {
    const jsonSchema = getJsonSchema(schema);
    if (jsonSchema.type === 'object' && jsonSchema.properties) return new Set(Object.keys(jsonSchema.properties));
  } catch {}
  return new Set();
}

function getSchemaOptionInfo(schema: PadroneSchema | undefined, meta: PadroneGlobalArgsMeta | undefined): SchemaOptionInfo {
  const metadata = schema
    ? extractSchemaMetadata(schema, meta?.fields, meta?.autoAlias)
    : { flags: {}, aliases: {}, negatives: {}, customNegation: new Set<string>() };
  const rules = extractFieldRules(schema, meta?.fields, meta);
  const schemaArity = createOptionArityLookup(schema, metadata, rules);

  const arrayArguments = new Set<string>();
  if (schema) {
    try {
      const jsonSchema = getJsonSchema(schema) as Record<string, any>;
      if (jsonSchema.type === 'object' && jsonSchema.properties) {
        for (const [key, prop] of Object.entries(jsonSchema.properties as Record<string, any>)) {
          if (getOptionArity(prop) === 'array') arrayArguments.add(key);
        }
      }
    } catch {
      // Ignore schema parsing errors
    }
  }

  return { ...metadata, arrayArguments, schemaArity, properties: getPropertyNames(schema), rules };
}

/** Field rules of the command merged with those of the global args it doesn't override. */
function mergeFieldRules(own: FieldRules, globals: FieldRules, globalOnly: (key: string) => boolean): FieldRules {
  const pick = <T>(entries: Record<string, T>) => Object.fromEntries(Object.entries(entries).filter(([key]) => globalOnly(key)));
  return {
    counts: new Set([...own.counts, ...[...globals.counts].filter(globalOnly)]),
    variadic: new Set([...own.variadic, ...[...globals.variadic].filter(globalOnly)]),
    conflicts: { ...pick(globals.conflicts), ...own.conflicts },
    implies: { ...pick(globals.implies), ...own.implies },
    requires: { ...pick(globals.requires), ...own.requires },
    requiredIf: { ...pick(globals.requiredIf), ...own.requiredIf },
    requiredUnless: { ...pick(globals.requiredUnless), ...own.requiredUnless },
    // A global group applies when the command overrides none of its fields
    exactlyOne: [...own.exactlyOne, ...globals.exactlyOne.filter((group) => group.every(globalOnly))],
    atLeastOne: [...own.atLeastOne, ...globals.atLeastOne.filter((group) => group.every(globalOnly))],
  };
}

/** Option info for a command: its own schema, then the global args in effect (the command's own fields win). */
function getCommandOptionInfo(command: AnyPadroneCommand): CommandOptionInfo {
  const own = getSchemaOptionInfo(command.argsSchema, command.meta);
  const interceptorOptions = collectInterceptorOptions(command);
  const globalArgs = getGlobalArgs(command);
  if (!globalArgs) return { ...own, interceptorOptions };

  const globals = getSchemaOptionInfo(globalArgs.schema, globalArgs.meta);
  const globalOnly = (key: string) => !own.properties.has(key);
  const pick = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).filter(([, target]) => globalOnly(target)));
  return {
    flags: { ...pick(globals.flags), ...own.flags },
    aliases: { ...pick(globals.aliases), ...own.aliases },
    negatives: { ...pick(globals.negatives), ...own.negatives },
    customNegation: new Set([...own.customNegation, ...[...globals.customNegation].filter(globalOnly)]),
    arrayArguments: new Set([...own.arrayArguments, ...[...globals.arrayArguments].filter(globalOnly)]),
    properties: new Set([...own.properties, ...globals.properties]),
    rules: mergeFieldRules(own.rules, globals.rules, globalOnly),
    schemaArity: (key, short) => own.schemaArity(key, short) ?? globals.schemaArity(key, short),
    interceptorOptions,
  };
}

const DRY_RUN_LONG_NAMES = ['dry-run', 'dryRun'];

/**
 * The raw-arg keys that mean `--dry-run` / `-n` on a command: only when it has a dry-run handler (`.dryRun()`),
 * and only names its own options don't use. Anywhere else the flag is an unknown option, so it can't be ignored.
 */
function dryRunKeysFor(command: AnyPadroneCommand, info: CommandOptionInfo): string[] {
  if (!command.dryRun) return [];
  const free = (name: string, short: boolean) => info.schemaArity([name], short) === undefined && !info.properties.has(name);
  return [...(DRY_RUN_LONG_NAMES.every((name) => free(name, false)) ? DRY_RUN_LONG_NAMES : []), ...(free('n', true) ? ['n'] : [])];
}

export function getDryRunFlagKeys(command: AnyPadroneCommand): string[] {
  return command.dryRun ? dryRunKeysFor(command, getCommandOptionInfo(command)) : [];
}

/** Removes `--dry-run` / `-n` from `rawArgs`; `true` when it was given (and not negated). */
export function takeDryRunFlag(command: AnyPadroneCommand, rawArgs: Record<string, unknown>): boolean {
  let dryRun = false;
  for (const key of getDryRunFlagKeys(command)) {
    if (!Object.hasOwn(rawArgs, key)) continue;
    const value = rawArgs[key];
    delete rawArgs[key];
    if (value !== false && value !== 'false') dryRun = true;
  }
  return dryRun;
}

/**
 * Splits args into the command's own and the global ones. A key belongs to the globals only when
 * the global schema defines it and the command's own schema doesn't (a command can override a global).
 */
function splitGlobalArgs(command: AnyPadroneCommand, args: Record<string, unknown>) {
  const globalArgs = getGlobalArgs(command);
  if (!globalArgs) return { own: args, globals: undefined, globalSchema: undefined };

  const ownProperties = getPropertyNames(command.argsSchema);
  const globalProperties = getPropertyNames(globalArgs.schema);
  const own: Record<string, unknown> = {};
  const globals: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (globalProperties.has(key) && !ownProperties.has(key)) globals[key] = value;
    else own[key] = value;
  }
  return { own, globals, globalSchema: globalArgs.schema };
}

/**
 * A resolver that follows routing while tokenizing, so each option's arity is looked up
 * on the command it appears under.
 */
export function createParseResolver(
  rootCommand: AnyPadroneCommand,
  findCommandByName: FindCommandFn,
  skipRootName: boolean,
): ParseResolver {
  let current = rootCommand;
  let routing = true;
  let first = true;
  const cache = new Map<AnyPadroneCommand, CommandOptionInfo>();
  const info = (command: AnyPadroneCommand) => {
    let entry = cache.get(command);
    if (!entry) cache.set(command, (entry = getCommandOptionInfo(command)));
    return entry;
  };

  return {
    // The current command's schema, then its default subcommand's (options typed before a default
    // subcommand belong to it), then options declared by interceptors.
    arity(key, short) {
      const own = info(current);
      const defaultCommand = findCommandByName('', current.commands);
      return (
        own.schemaArity(key, short) ??
        (defaultCommand ? info(defaultCommand).schemaArity(key, short) : undefined) ??
        (key.length === 1 && dryRunKeysFor(current, own).includes(key[0]!) ? 'flag' : undefined) ??
        (key.length === 1 ? own.interceptorOptions[key[0]!] : undefined)
      );
    },
    isCommand: (term) => routing && !!findCommandByName(term, current.commands),
    enter(term) {
      const isFirst = first;
      first = false;
      if (!routing) return;
      if (isFirst && skipRootName && term === rootCommand.name) return;
      const found = findCommandByName(term, current.commands);
      if (found) current = found;
      else routing = false;
    },
  };
}

/**
 * Parses CLI input to find the command and extract raw arguments without validation.
 * A string is tokenized; an array (argv) is taken as already tokenized. Without input, reads the runtime's argv.
 *
 * A string input may start with the program name (`eval('my-cli build')`); argv never does.
 */
export function parseCommand(input: PadroneInput | undefined, rootCommand: AnyPadroneCommand, findCommandByName: FindCommandFn) {
  input ??= getCommandRuntime(rootCommand).argv();
  const empty = { rawArgs: {} as Record<string, unknown>, args: [] as string[], unmatchedTerms: [] as string[], issues: undefined };
  if (!input.length) {
    const defaultCommand = findCommandByName('', rootCommand.commands);
    return { command: defaultCommand ?? rootCommand, ...empty };
  }

  const skipRootName = typeof input === 'string';
  const parts = parseCliInputToParts(input, createParseResolver(rootCommand, findCommandByName, skipRootName));

  const terms = parts.filter((p) => p.type === 'term').map((p) => p.value);
  const argTokens = parts.filter((p) => p.type === 'arg').map((p) => p.value);

  let curCommand: AnyPadroneCommand = rootCommand;
  let unmatchedTerms: string[] = [];

  if (skipRootName && terms[0] === rootCommand.name) terms.shift();

  for (let i = 0; i < terms.length; i++) {
    const found = findCommandByName(terms[i]!, curCommand.commands);
    if (found) {
      curCommand = found;
    } else {
      unmatchedTerms = terms.slice(i);
      argTokens.unshift(...unmatchedTerms);
      break;
    }
  }

  if (unmatchedTerms.length === 0 && curCommand.commands?.length) {
    const defaultCommand = findCommandByName('', curCommand.commands);
    if (defaultCommand) curCommand = defaultCommand;
  }

  const { flags, aliases, negatives, customNegation, arrayArguments, rules, properties, interceptorOptions } =
    getCommandOptionInfo(curCommand);

  const rawArgs: Record<string, unknown> = {};
  let issues: StandardSchemaV1.Issue[] | undefined;

  for (const arg of parts) {
    if (arg.type !== 'named' && arg.type !== 'alias') continue;

    let key: string[];
    const [head] = arg.key;
    const single = arg.key.length === 1 ? head! : undefined;
    if (arg.type === 'alias' && single !== undefined && Object.hasOwn(flags, single)) {
      key = [flags[single]!];
    } else if (arg.type === 'named' && head !== undefined && Object.hasOwn(aliases, head)) {
      key = [aliases[head]!, ...arg.key.slice(1)];
    } else if (arg.type === 'named' && !arg.negated && single !== undefined && Object.hasOwn(negatives, single)) {
      // Negative keyword: --remote sets local to false
      setNestedValue(rawArgs, [negatives[single]!], false);
      continue;
    } else {
      key = arg.key;
    }

    const rootKey = key[0]!;

    if (arg.missing) {
      const display = arg.type === 'alias' ? `-${arg.key[0]}` : `--${arg.key.join('.')}`;
      (issues ??= []).push({ path: key, message: `Option "${display}" requires a value` });
      continue;
    }

    const counted = rules.counts.has(rootKey) || (!properties.has(rootKey) && interceptorOptions[rootKey] === 'count');
    if (counted && key.length === 1) {
      // Counting flag: each bare occurrence adds one (-vvv → 3); --x=5 sets it; --no-x resets it
      const existing = rawArgs[rootKey];
      if (arg.type === 'named' && arg.negated) rawArgs[rootKey] = 0;
      else if (arg.value !== undefined) rawArgs[rootKey] = arg.value;
      else rawArgs[rootKey] = (typeof existing === 'number' ? existing : Number(existing ?? 0) || 0) + 1;
      continue;
    }

    if (arg.type === 'named' && arg.negated) {
      // Skip --no- prefix negation for args with custom negation
      if (customNegation.has(rootKey)) {
        // Treat as unknown: put it back as `no-<key>` so detectUnknownArgs catches it
        setNestedValue(rawArgs, [`no-${key.join('.')}`], false);
        continue;
      }
      setNestedValue(rawArgs, key, false);
      continue;
    }

    const value = arg.value ?? true;

    if (arrayArguments.has(rootKey)) {
      // Array options accumulate across repeats: --tag a --tag b. A single value stays as given;
      // coercion wraps it when the schema only accepts arrays.
      const existing = getNestedValue(rawArgs, key);
      const values = Array.isArray(value) ? value : [value];
      if (existing === undefined) setNestedValue(rawArgs, key, value);
      else if (Array.isArray(existing)) existing.push(...values);
      else setNestedValue(rawArgs, key, [existing, ...values]);
    } else {
      // Other options take the last value given, like most CLIs: --name a --name b → "b"
      setNestedValue(rawArgs, key, value);
    }
  }

  return { command: curCommand, rawArgs, args: argTokens, unmatchedTerms, issues };
}

/**
 * Warnings for a deprecated command, and for each deprecated option set in `rawArgs`
 * (from `.meta({ deprecated })` or the `fields` config).
 */
export function getDeprecationWarnings(command: AnyPadroneCommand, rawArgs: Record<string, unknown>): string[] {
  const suffix = (deprecated: unknown) => (typeof deprecated === 'string' && deprecated ? `: ${deprecated}` : '');
  const warnings: string[] = [];
  if (command.deprecated) warnings.push(`Warning: command "${command.path || command.name}" is deprecated${suffix(command.deprecated)}`);

  let properties: Record<string, any> = {};
  if (command.argsSchema) {
    try {
      const jsonSchema = getJsonSchema(command.argsSchema);
      if (jsonSchema.type === 'object' && jsonSchema.properties) properties = jsonSchema.properties;
    } catch {}
  }

  for (const key of Object.keys(rawArgs)) {
    const deprecated = command.meta?.fields?.[key]?.deprecated ?? properties[key]?.deprecated;
    if (deprecated) warnings.push(`Warning: option "--${camelToKebab(key) ?? key}" is deprecated${suffix(deprecated)}`);
  }
  return warnings;
}

type FindCommandFn = (name: string, commands?: AnyPadroneCommand[]) => AnyPadroneCommand | undefined;

/**
 * Preprocesses raw arguments: maps positional arguments and performs auto-coercion.
 * External data sources (stdin, env, config) are handled by extensions before this runs.
 * `missing` lists the options that `requires`, `requiredIf` or `requiredUnless` made required and weren't provided.
 */
export function buildCommandArgs(
  command: AnyPadroneCommand,
  rawArgs: Record<string, unknown>,
  positionalArgs: string[],
): { args: Record<string, unknown>; issues?: StandardSchemaV1.Issue[]; missing?: string[] } {
  let preprocessedArgs = preprocessArgs(rawArgs, { flags: {}, aliases: {} });
  let issues: StandardSchemaV1.Issue[] | undefined;

  const positionalConfig = command.meta?.positional ? parsePositionalConfig(command.meta.positional) : [];
  let argIndex = 0;

  if (positionalConfig.length > 0) {
    for (let i = 0; i < positionalConfig.length; i++) {
      const { name, variadic } = positionalConfig[i]!;
      if (argIndex >= positionalArgs.length) break;

      // Detect ambiguity: same arg provided both positionally and as a named option
      if (name in preprocessedArgs) {
        issues ??= [];
        issues.push({ path: [name], message: `Ambiguous argument "${name}": provided both positionally and as a named option` });
        continue;
      }

      if (variadic) {
        const remainingPositionals = positionalConfig.slice(i + 1);
        const nonVariadicAfter = remainingPositionals.filter((p) => !p.variadic).length;
        const variadicEnd = positionalArgs.length - nonVariadicAfter;
        preprocessedArgs[name] = positionalArgs.slice(argIndex, variadicEnd);
        argIndex = variadicEnd;
      } else {
        preprocessedArgs[name] = positionalArgs[argIndex];
        argIndex++;
      }
    }
  }

  const excess = positionalArgs.slice(argIndex);
  if (excess.length > 0 && !issues) {
    issues = [
      {
        path: [],
        message:
          positionalConfig.length > 0
            ? `Too many arguments: expected at most ${positionalConfig.length}, got ${positionalArgs.length} (unexpected: ${excess.join(' ')})`
            : `Unexpected argument${excess.length > 1 ? 's' : ''}: ${excess.join(' ')}`,
      },
    ];
  }

  const { rules } = getCommandOptionInfo(command);
  const ruled = applyFieldRules(preprocessedArgs, rules);
  preprocessedArgs = ruled.args;
  if (ruled.issues.length > 0) (issues ??= []).push(...ruled.issues.map((message) => ({ path: [], message })));

  const { own, globals, globalSchema } = splitGlobalArgs(command, preprocessedArgs);
  preprocessedArgs = command.argsSchema ? coerceArgs(own, command.argsSchema) : own;
  if (globals && globalSchema) preprocessedArgs = { ...coerceArgs(globals, globalSchema), ...preprocessedArgs };

  const required = checkFieldRequirements(preprocessedArgs, rules);
  if (required.length === 0) return { args: preprocessedArgs, issues };
  (issues ??= []).push(...required);
  return { args: preprocessedArgs, issues, missing: [...new Set(required.map((issue) => issue.path[0]!))] };
}

/**
 * Detects unknown options in args that aren't defined in the schema.
 * Returns unknown key info with suggestions, or empty array if schema is loose.
 */
export function checkUnknownArgs(command: AnyPadroneCommand, args: Record<string, unknown>): { key: string }[] {
  const preprocessedArgs = splitGlobalArgs(command, args).own;
  if (!command.argsSchema) {
    const unknowns: { key: string }[] = [];
    for (const key of Object.keys(preprocessedArgs)) {
      unknowns.push({ key });
    }
    return unknowns;
  }

  const argsMeta = command.meta?.fields;
  const { flags, aliases, negatives } = extractSchemaMetadata(command.argsSchema, argsMeta, command.meta?.autoAlias);

  return detectUnknownArgs(preprocessedArgs, command.argsSchema, flags, aliases, negatives);
}

/**
 * Validates preprocessed arguments against the command's schema.
 * First checks for unknown args (strict by default), then runs schema validation.
 * Returns sync or async result depending on the schema's validate method.
 */
export function validateCommandArgs(command: AnyPadroneCommand, preprocessedArgs: Record<string, unknown>) {
  const unknownArgs = checkUnknownArgs(command, preprocessedArgs);
  if (unknownArgs.length > 0) {
    const issues: StandardSchemaV1.Issue[] = unknownArgs.map(({ key }) => ({
      path: [key],
      message: `Unknown option: "${key}"`,
    }));
    return { args: undefined, argsResult: { issues } as any };
  }

  const { own, globals, globalSchema } = splitGlobalArgs(command, preprocessedArgs);
  const argsParsed = command.argsSchema ? command.argsSchema['~standard'].validate(own) : { value: {} };

  const buildResult = (parsed: StandardSchemaV1.Result<unknown>) => ({
    args: parsed.issues ? undefined : (parsed.value as any),
    argsResult: parsed as any,
  });

  if (!globals || !globalSchema) return thenMaybe(argsParsed, buildResult);

  // Global args validate against their own schema; the command's own values win on the merged result
  return thenMaybe(argsParsed, (ownResult) =>
    thenMaybe(globalSchema['~standard'].validate(globals), (globalResult) => {
      const issues = [...(globalResult.issues ?? []), ...(ownResult.issues ?? [])];
      if (issues.length > 0) return buildResult({ issues });
      const ownValue = ownResult.issues ? undefined : ownResult.value;
      const globalValue = globalResult.issues ? undefined : globalResult.value;
      return buildResult({ value: { ...(globalValue as object), ...(typeof ownValue === 'object' ? ownValue : {}) } });
    }),
  );
}

/**
 * Returns the list of known option names from a command's schema (for fuzzy suggestion).
 */
export function getKnownOptionNames(command: AnyPadroneCommand): string[] {
  return [...new Set([...getPropertyNames(command.argsSchema), ...getPropertyNames(getGlobalArgs(command)?.schema)])];
}

/**
 * Formats validation issue messages for display.
 */
export function formatIssueMessages(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map((i) => {
      const path = i.path?.map((segment) => (typeof segment === 'object' ? segment.key : segment)).join('.');
      return path ? `  - ${path}: ${i.message}` : `  - ${i.message}`;
    })
    .join('\n');
}

/**
 * Core validate function for parse() — preprocesses and validates CLI args.
 * Used by the parse program method (lighter weight than the full exec pipeline).
 * External data sources (stdin, env, config) are not resolved here — use eval() for that.
 */
export function coreValidateForParse(
  command: AnyPadroneCommand,
  rawArgs: Record<string, unknown>,
  positionalArgs: string[],
): InterceptorValidateResult | Promise<InterceptorValidateResult> {
  const { args: preprocessedArgs, issues } = buildCommandArgs(command, rawArgs, positionalArgs);
  if (issues) return { args: undefined, argsResult: { issues } as any };
  const validated = validateCommandArgs(command, preprocessedArgs);
  return thenMaybe(validated, (v) => v as InterceptorValidateResult);
}
