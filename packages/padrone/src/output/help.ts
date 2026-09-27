import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import {
  extractSchemaMetadata,
  getJsonSchema,
  optionDisplayName,
  type PadroneArgsSchemaMeta,
  parsePositionalConfig,
} from '../core/args.ts';
import { findCommandByName, getGlobalArgs, resolveCommand } from '../core/commands.ts';
import type { AnyPadroneCommand, InterceptorMeta, PadroneSchema } from '../types/index.ts';
import { getRootCommand } from '../util/utils.ts';
import type { ColorConfig, ColorTheme } from './colorizer.ts';
import {
  createFormatter,
  type HelpArgumentInfo,
  type HelpDetail,
  type HelpFormat,
  type HelpInfo,
  type HelpPositionalInfo,
  type HelpSubcommandInfo,
  type PadroneHelpTransform,
} from './formatter.ts';

export type HelpPreferences = {
  format?: HelpFormat | 'auto';
  detail?: HelpDetail;
  theme?: ColorTheme | ColorConfig;
  /** Show all global commands and flags in full detail */
  all?: boolean;
  /** Terminal width for text wrapping. Defaults to terminal columns or 80. */
  width?: number;
  /** Terminal capabilities for auto-detection of ANSI and width. */
  terminal?: { columns?: number; isTTY?: boolean };
  /** Environment variables for auto-detection (e.g., NO_COLOR, CI). */
  env?: Record<string, string | undefined>;
};

/**
 * Extract positional arguments info from schema based on meta.positional config.
 */
function extractPositionalArgsInfo(
  schema: StandardJSONSchemaV1,
  meta?: PadroneArgsSchemaMeta,
): { args: HelpPositionalInfo[]; positionalNames: Set<string> } {
  const args: HelpPositionalInfo[] = [];
  const positionalNames = new Set<string>();

  if (!schema || !meta?.positional || meta.positional.length === 0) {
    return { args, positionalNames };
  }

  const positionalConfig = parsePositionalConfig(meta.positional);

  try {
    const jsonSchema = getJsonSchema(schema) as Record<string, any>;

    if (jsonSchema.type === 'object' && jsonSchema.properties) {
      const properties = jsonSchema.properties as Record<string, any>;
      const required = (jsonSchema.required as string[]) || [];

      for (const { name, variadic } of positionalConfig) {
        const prop = properties[name];
        if (!prop) continue;

        positionalNames.add(name);
        const optMeta = meta.fields?.[name];

        args.push({
          name: variadic ? `...${name}` : name,
          description: optMeta?.description ?? prop.description,
          optional: !required.includes(name),
          default: prop.default,
          type: variadic ? `array<${prop.items?.type || 'string'}>` : prop.type,
          enum: (prop.enum ?? prop.items?.enum) as string[] | undefined,
        });
      }
    }
  } catch {
    // Fallback to empty result if toJSONSchema fails
  }

  return { args, positionalNames };
}

function extractArgsInfo(schema: StandardJSONSchemaV1, meta?: Pick<PadroneArgsSchemaMeta, 'fields'>, positionalNames?: Set<string>) {
  const result: HelpArgumentInfo[] = [];
  if (!schema) return result;

  const argsMeta = meta?.fields;

  try {
    const jsonSchema = getJsonSchema(schema) as Record<string, any>;

    // Handle object: z.object({ key: z.string(), ... })
    if (jsonSchema.type === 'object' && jsonSchema.properties) {
      const properties = jsonSchema.properties as Record<string, any>;
      const required = (jsonSchema.required as string[]) || [];
      const propertyNames = new Set(Object.keys(properties));

      // Helper to check if a negated version of an arg exists
      const hasExplicitNegation = (key: string): boolean => {
        // Check for noVerbose style (camelCase)
        const camelNegated = `no${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        if (propertyNames.has(camelNegated)) return true;
        // Check for no-verbose style (kebab-case, though rare in JS)
        const kebabNegated = `no-${key}`;
        if (propertyNames.has(kebabNegated)) return true;
        return false;
      };

      // Helper to check if this arg is itself a negation of another arg
      const isNegationOf = (key: string): boolean => {
        // Check for noVerbose -> verbose (camelCase)
        if (key.startsWith('no') && key.length > 2 && key[2] === key[2]?.toUpperCase()) {
          const positiveKey = key.charAt(2).toLowerCase() + key.slice(3);
          if (propertyNames.has(positiveKey)) return true;
        }
        // Check for no-verbose -> verbose (kebab-case)
        if (key.startsWith('no-')) {
          const positiveKey = key.slice(3);
          if (propertyNames.has(positiveKey)) return true;
        }
        return false;
      };

      for (const [key, prop] of Object.entries(properties)) {
        // Skip positional arguments - they are shown in arguments section
        if (positionalNames?.has(key)) continue;

        const isOptional = !required.includes(key);
        const enumValues = (prop.enum ?? prop.items?.enum) as string[] | undefined;
        const optMeta = argsMeta?.[key];
        const propType = prop.type as string;

        // Resolve custom negative keywords from meta or schema
        const rawNegative = optMeta?.negative ?? prop?.negative;
        const hasCustomNegative = rawNegative !== undefined;
        const negativeList = hasCustomNegative
          ? typeof rawNegative === 'string'
            ? rawNegative
              ? [rawNegative]
              : []
            : Array.from(rawNegative as readonly string[]).filter(Boolean)
          : undefined;

        // Booleans are negatable unless there's an explicit noArg property,
        // this arg is itself a negation of another arg, or custom negative keywords are set
        const isNegatable = propType === 'boolean' && !hasCustomNegative && !hasExplicitNegation(key) && !isNegationOf(key);

        const isCount = !!(optMeta?.count ?? prop?.count);
        const rawConflicts = optMeta?.conflicts ?? prop?.conflicts;
        const conflicts: string[] = rawConflicts ? (typeof rawConflicts === 'string' ? [rawConflicts] : [...rawConflicts]) : [];
        const implies = (optMeta?.implies ?? prop?.implies) as Record<string, unknown> | undefined;
        const isVariadic = propType === 'array' && !!(optMeta?.variadic ?? prop?.variadic);
        const notes = [
          ...(isCount ? ['repeatable'] : []),
          ...(isVariadic ? ['takes multiple values'] : []),
          ...(conflicts.length ? [`conflicts with ${conflicts.map((c) => `--${optionDisplayName(c)}`).join(', ')}`] : []),
          ...(implies
            ? [
                `implies ${Object.entries(implies)
                  .map(([k, v]) =>
                    v === true
                      ? `--${optionDisplayName(k)}`
                      : v === false
                        ? `--no-${optionDisplayName(k)}`
                        : `--${optionDisplayName(k)}=${String(v)}`,
                  )
                  .join(', ')}`,
              ]
            : []),
        ];

        result.push({
          name: key,
          description: optMeta?.description ?? prop.description,
          optional: isOptional,
          default: prop.default,
          type: isCount ? undefined : propType === 'array' ? `${prop.items?.type || 'string'}[]` : propType,
          enum: enumValues,
          deprecated: optMeta?.deprecated ?? prop?.deprecated,
          hidden: optMeta?.hidden ?? prop?.hidden,
          examples: optMeta?.examples ?? prop?.examples,
          variadic: propType === 'array',
          negatable: isNegatable,
          negative: negativeList?.length ? negativeList : undefined,
          group: optMeta?.group,
          notes: notes.length ? notes : undefined,
        });
      }
    }
  } catch {
    // Fallback to empty result if toJSONSchema fails
  }

  return result;
}

/** Option info for a schema, with its short flags and aliases attached. */
function collectOptionsInfo(
  schema: PadroneSchema,
  meta: Pick<PadroneArgsSchemaMeta, 'fields' | 'autoAlias'> | undefined,
  positionalNames?: Set<string>,
): HelpArgumentInfo[] {
  const argsInfo = extractArgsInfo(schema, meta, positionalNames);
  const argMap: Record<string, HelpArgumentInfo> = Object.fromEntries(argsInfo.map((arg) => [arg.name, arg]));

  const { flags, aliases } = extractSchemaMetadata(schema, meta?.fields, meta?.autoAlias);
  for (const [flag, name] of Object.entries(flags)) {
    const arg = argMap[name];
    if (arg) arg.flags = [...(arg.flags || []), flag];
  }
  for (const [alias, name] of Object.entries(aliases)) {
    const arg = argMap[name];
    if (arg) arg.aliases = [...(arg.aliases || []), alias];
  }
  return argsInfo;
}

// ============================================================================
// Core Help Info Builder
// ============================================================================

/**
 * Builds a comprehensive HelpInfo structure from a command.
 * This is the single source of truth that all formatters use.
 * @param cmd - The command to build help info for
 * @param detail - The level of detail ('minimal', 'standard', or 'full')
 */
export function getHelpInfo(cmd: AnyPadroneCommand, detail: HelpPreferences['detail'] = 'standard', all?: boolean): HelpInfo {
  const rootCmd = getRootCommand(cmd);
  // A command is a "default" command if its name is '' or it has '' as an alias
  const isDefaultCommand = cmd.parent && (!cmd.name || cmd.aliases?.includes(''));
  // For commands with empty name, use the first non-empty alias as display name
  const nonEmptyAliases = cmd.aliases?.filter(Boolean);
  const commandName = cmd.path || cmd.name || nonEmptyAliases?.[0] || (cmd.parent ? '[default]' : 'program');
  // Build display aliases: real aliases (excluding the one promoted to display name) + [default] marker
  const remainingAliases = !cmd.name && nonEmptyAliases?.length ? nonEmptyAliases.slice(1) : (nonEmptyAliases ?? []);
  const displayAliases = isDefaultCommand ? [...remainingAliases, '[default]'] : nonEmptyAliases;

  // Extract positional args from schema based on meta.positional
  const { args: positionalArgs, positionalNames } = cmd.argsSchema
    ? extractPositionalArgsInfo(cmd.argsSchema, cmd.meta)
    : { args: [], positionalNames: new Set<string>() };

  const hasPositionals = positionalArgs.length > 0;

  const helpInfo: HelpInfo = {
    name: commandName,
    title: cmd.title,
    description: cmd.description,
    examples: cmd.examples,
    aliases: displayAliases,
    deprecated: cmd.deprecated,
    hidden: cmd.hidden,
    usage: {
      command: rootCmd === cmd ? commandName : `${rootCmd.name} ${commandName}`,
      hasSubcommands: !!(cmd.commands && cmd.commands.length > 0),
      hasPositionals,
      hasArguments: false, // updated below after extracting arguments
      stdinField: cmd.meta?.stdin,
      helpFlag: getHelpFlag(rootCmd),
    },
  };

  // Declarative customization from `.configure({ help: { usage, before, after } })`
  if (cmd.help && typeof cmd.help === 'object') {
    if (cmd.help.usage !== undefined) helpInfo.usage.text = cmd.help.usage;
    if (cmd.help.before) helpInfo.before = cmd.help.before;
    if (cmd.help.after) helpInfo.after = cmd.help.after;
  }

  // Build subcommands info (filter out hidden commands unless showing full detail)
  if (cmd.commands && cmd.commands.length > 0) {
    const visibleCommands = detail === 'full' ? cmd.commands : cmd.commands.filter((c) => !c.hidden);
    // If the command has both a handler and subcommands, show the handler as a "[default]" entry
    const selfEntry: typeof helpInfo.subcommands = cmd.action
      ? [{ name: '[default]', title: cmd.title, description: cmd.description }]
      : [];

    helpInfo.subcommands = [
      ...selfEntry,
      ...visibleCommands.flatMap((c): HelpSubcommandInfo[] => {
        const isDefault = !c.name || c.aliases?.includes('');
        const nonEmptyAliases = c.aliases?.filter(Boolean);
        const displayName = c.name || nonEmptyAliases?.[0] || '[default]';
        const remainingAliases = !c.name && nonEmptyAliases?.length ? nonEmptyAliases.slice(1) : (nonEmptyAliases ?? []);
        // Only add [default] alias marker if it's not already the display name
        const displayAliases =
          isDefault && displayName !== '[default]' ? [...remainingAliases, '[default]'] : isDefault ? remainingAliases : nonEmptyAliases;
        const hasSubcommands = !!(c.commands && c.commands.length > 0);

        // If a command has subcommands AND a default handler (direct or '' subcommand),
        // show two entries: one for the default action, one for the subcommand router
        const hasDefaultHandler = c.action || c.commands?.some((sub) => !sub.name || sub.aliases?.includes(''));
        if (hasSubcommands && hasDefaultHandler) {
          const defaultSub = !c.action ? c.commands?.find((sub) => !sub.name || sub.aliases?.includes('')) : undefined;
          const hasDefaultSubInfo = defaultSub && (defaultSub.title || defaultSub.description);
          return [
            {
              name: displayName,
              title: hasDefaultSubInfo ? defaultSub.title : c.title,
              description: hasDefaultSubInfo ? defaultSub.description : c.description,
              aliases: displayAliases?.length ? displayAliases : undefined,
              deprecated: c.deprecated,
              hidden: c.hidden,
              group: c.group,
            },
            {
              name: displayName,
              title: c.title,
              description: c.description,
              deprecated: c.deprecated,
              hidden: c.hidden,
              hasSubcommands: true,
              group: c.group,
            },
          ];
        }

        return [
          {
            name: displayName,
            title: c.title,
            description: c.description,
            aliases: displayAliases?.length ? displayAliases : undefined,
            deprecated: c.deprecated,
            hidden: c.hidden,
            hasSubcommands,
            group: c.group,
          },
        ];
      }),
    ];

    // In 'full' detail mode, recursively build help for all nested commands
    if (detail === 'full') {
      helpInfo.nestedCommands = visibleCommands.map((c) => getHelpInfo(c, 'full'));
    }
  }

  // Build arguments info from positionals
  if (hasPositionals) {
    helpInfo.positionals = positionalArgs;
  }

  // Build arguments info with aliases (excluding positional args), then the global args not overridden by the command
  const ownArgs = cmd.argsSchema ? collectOptionsInfo(cmd.argsSchema, cmd.meta, positionalNames) : [];
  const globalArgs = getGlobalArgs(cmd);
  const ownNames = new Set([...ownArgs.map((arg) => arg.name), ...positionalNames]);
  const inheritedArgs = globalArgs
    ? collectOptionsInfo(globalArgs.schema, globalArgs.meta)
        .filter((arg) => !ownNames.has(arg.name))
        .map((arg) => ({ ...arg, group: arg.group ?? 'Global Options' }))
    : [];

  const visibleArgs = [...ownArgs, ...inheritedArgs].filter((arg) => !arg.hidden);
  const envVarsOf = collectInterceptorEnv(cmd);
  for (const arg of visibleArgs) {
    const names = envVarsOf(arg.name);
    if (names) arg.env = typeof names === 'string' ? names : [...names];
  }
  if (visibleArgs.length > 0) {
    helpInfo.arguments = visibleArgs;
    helpInfo.usage.hasArguments = true;
  }

  // Add global commands/flags (root command by default, all commands when --all is passed)
  if (!cmd.parent || all) {
    const builtins: HelpInfo['builtins'] = [];

    if (!findCommandByName('help', rootCmd.commands)) {
      builtins.push({
        name: 'help [command], -h, --help',
        description: 'Show help for a command',
        sub: [
          { name: '--all', description: 'Show all global commands and flags' },
          { name: '--detail <level>', description: 'Detail level (minimal, standard, full)' },
          { name: '--format <format>', description: 'Output format (text, ansi, json, markdown, html)' },
        ],
      });
    }

    if (!findCommandByName('version', rootCmd.commands)) {
      builtins.push({
        name: 'version, -v, --version',
        description: 'Show version information',
      });
    }

    if (!findCommandByName('completion', rootCmd.commands)) {
      builtins.push({
        name: 'completion [shell]',
        description: 'Generate shell completions (bash, zsh, fish, powershell)',
      });
    }

    if (!findCommandByName('man', rootCmd.commands)) {
      builtins.push({
        name: 'man',
        description: 'Show or install man pages (--setup to install, --remove to uninstall) (experimental)',
      });
    }

    builtins.push({
      name: '[command] --repl',
      description: 'Start interactive REPL scoped to a command',
    });

    if (!findCommandByName('mcp', rootCmd.commands)) {
      builtins.push({
        name: 'mcp [http|stdio]',
        description: 'Start a Model Context Protocol server to expose commands as AI tools (experimental)',
        sub: [
          { name: '--port <port>', description: 'HTTP port (default: 3000)' },
          { name: '--host <host>', description: 'HTTP host (default: 127.0.0.1)' },
        ],
      });
    }

    if (rootCmd.interceptors?.some((i) => i.meta.id === 'padrone:json' && !i.meta.disabled)) {
      builtins.push({ name: '--json', description: 'Print the result, and errors, as JSON' });
    }

    builtins.push({
      name: '--color [theme], --no-color',
      description: 'Set color theme (default, ocean, warm, monochrome) or disable colors',
    });

    if (builtins.length > 0) {
      helpInfo.builtins = builtins;
    }
  }

  return helpInfo;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Env variables that interceptors on the command chain read into args (e.g. `padroneEnv({ vars })`), keyed by arg name.
 * The nearest declaration wins; an ancestor's interceptor counts only when it is inherited.
 */
function collectInterceptorEnv(command: AnyPadroneCommand): (arg: string) => string | readonly string[] | undefined {
  const sources: NonNullable<InterceptorMeta['env']>[] = [];
  for (let current: AnyPadroneCommand | undefined = command; current; current = current.parent) {
    for (const { meta } of current.interceptors ?? []) {
      if (meta.disabled || !meta.env || (current !== command && meta.inherit === false)) continue;
      sources.push(meta.env);
    }
  }
  return (arg) => {
    for (const env of sources) {
      const names = typeof env === 'function' ? env(arg) : Object.hasOwn(env, arg) ? env[arg] : undefined;
      if (names?.length) return names;
    }
    return undefined;
  };
}

/** The flag that shows help (`--help`, or a renamed one), from the help command's flags. */
function getHelpFlag(rootCommand: AnyPadroneCommand): string | undefined {
  const found = rootCommand.commands?.find((c) => c.name === 'help');
  const helpCommand = found && resolveCommand(found);
  const names = helpCommand?.flagNames ?? (helpCommand ? ['help', 'h'] : []);
  const name = names.find((n) => n.length > 1) ?? names[0];
  if (!name) return undefined;
  return name.length > 1 ? `--${name}` : `-${name}`;
}

/** The nearest help function from `.configure({ help })`, walking from the command up to the root. */
function findHelpTransform(command: AnyPadroneCommand): PadroneHelpTransform | undefined {
  for (let current: AnyPadroneCommand | undefined = command; current; current = current.parent) {
    if (typeof current.help === 'function') return current.help;
  }
  return undefined;
}

export function generateHelp(rootCommand: AnyPadroneCommand, commandObj: AnyPadroneCommand = rootCommand, prefs?: HelpPreferences): string {
  const helpInfo = getHelpInfo(commandObj, prefs?.detail, prefs?.all);
  const formatter = createFormatter(
    prefs?.format ?? 'auto',
    prefs?.detail,
    prefs?.theme,
    prefs?.all,
    prefs?.width,
    prefs?.terminal,
    prefs?.env,
  );

  const transform = findHelpTransform(commandObj);
  if (!transform) return formatter.format(helpInfo);

  const render = (info: HelpInfo) => formatter.format(info);
  const transformed = transform(helpInfo, {
    command: commandObj,
    format: prefs?.format ?? 'auto',
    detail: prefs?.detail ?? 'standard',
    render,
  });
  return typeof transformed === 'string' ? transformed : render(transformed);
}
