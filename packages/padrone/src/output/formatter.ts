import { camelToKebab } from '../util/shell-utils.ts';
import type { ColorConfig, ColorTheme } from './colorizer.ts';
import {
  createAnsiStyler,
  createConsoleStyler,
  createHtmlLayout,
  createHtmlStyler,
  createMarkdownLayout,
  createMarkdownStyler,
  createTextLayout,
  createTextStyler,
  DEFAULT_TERMINAL_WIDTH,
  type LayoutConfig,
  type Styler,
  shouldUseAnsi,
  wrapText,
} from './styling.ts';

export type HelpFormat = 'text' | 'ansi' | 'console' | 'markdown' | 'html' | 'json';
export type HelpDetail = 'minimal' | 'standard' | 'full';

// ============================================================================
// Help Info Types (shared with help.ts)
// ============================================================================

/**
 * Information about a single positional argument.
 */
export type HelpPositionalInfo = {
  name: string;
  description?: string;
  optional: boolean;
  default?: unknown;
  type?: string;
  enum?: string[];
  /** Placeholder shown instead of the name (from the field's `valueName`). */
  valueName?: string;
};

/**
 * Information about a single argument/flag.
 */
export type HelpArgumentInfo = {
  name: string;
  description?: string;
  optional: boolean;
  default?: unknown;
  type?: string;
  enum?: string[];
  /** Placeholder for the value, shown instead of the type (from the field's `valueName`). */
  valueName?: string;
  /** Single-character short flags (shown as `-v`) */
  flags?: string[];
  /** Multi-character alternative long names (shown as `--dry-run`) */
  aliases?: string[];
  deprecated?: boolean | string;
  hidden?: boolean;
  examples?: unknown[];
  /** Environment variable(s) this arg can be set from */
  env?: string | string[];
  /** Whether this arg is an array type (shown as <type...>) */
  variadic?: boolean;
  /** Whether this arg is a boolean (shown as --[no-]arg) */
  negatable?: boolean;
  /** Custom negative keyword(s) that set this arg to false (e.g. `['remote']` for `--remote`) */
  negative?: string[];
  /** Config file key that maps to this arg */
  configKey?: string;
  /** Group name for organizing this option under a labeled section in help output */
  group?: string;
  /** Short notes shown after the description, e.g. `repeatable` or `conflicts with --json` */
  notes?: string[];
};

/**
 * Information about a subcommand (minimal info for listing).
 */
export type HelpSubcommandInfo = {
  name: string;
  title?: string;
  description?: string;
  aliases?: string[];
  deprecated?: boolean | string;
  hidden?: boolean;
  hasSubcommands?: boolean;
  /** Group name for organizing this command under a labeled section in help output */
  group?: string;
};

/**
 * Information about a built-in command/flag entry.
 */
export type HelpBuiltinInfo = {
  name: string;
  description?: string;
  sub?: { name: string; description?: string }[];
  /** Short form for the collapsed `Global:` line (e.g. `help [command]`); entries without one are only listed with `--all`. */
  summary?: string;
};

/**
 * Comprehensive JSON structure for help information.
 * This is the single source of truth that all formatters use.
 */
export type HelpInfo = {
  /** The full command name (e.g., "cli serve" or "<root>") */
  name: string;
  /** Short title for the command */
  title?: string;
  /** Command description */
  description?: string;
  /** Alternative names/aliases for this command */
  aliases?: string[];
  /** Whether the command is deprecated */
  deprecated?: boolean | string;
  /** Whether the command is hidden */
  hidden?: boolean;
  /** Usage string parts for flexible formatting */
  usage: {
    command: string;
    hasSubcommands: boolean;
    hasPositionals: boolean;
    hasArguments: boolean;
    /** The name of the field that reads from stdin, if any. Shown as `[stdin > field]` in usage. */
    stdinField?: string;
    /** Replaces the generated usage line when set. */
    text?: string;
    /** The flag that shows help (e.g. `--help`), used in hints. Absent when help has no flag. */
    helpFlag?: string;
  };
  /** List of subcommands */
  subcommands?: HelpSubcommandInfo[];
  /** Positional arguments */
  positionals?: HelpPositionalInfo[];
  /** Arguments/flags (only visible ones, hidden filtered out) */
  arguments?: HelpArgumentInfo[];
  /** Built-in commands and flags (shown only for root command) */
  builtins?: HelpBuiltinInfo[];
  /** Topics `help <topic>` shows, listed under "Additional help topics" (root command only) */
  topics?: { name: string; title?: string; description?: string }[];
  /** Command-level usage examples (shown in help output) */
  examples?: string[];
  /** Full help info for nested commands (used in 'full' detail mode) */
  nestedCommands?: HelpInfo[];
  /** Text shown before the rest of the help (from `.configure({ help: { before } })`) */
  before?: string;
  /** Text shown after the rest of the help (from `.configure({ help: { after } })`) */
  after?: string;
};

/** Declarative help customization for a single command, set via `.configure({ help })`. */
export type PadroneHelpConfig = {
  /** Replaces the generated usage line (the text after `Usage:`). */
  usage?: string;
  /** Text shown before the rest of the help. */
  before?: string;
  /** Text shown after the rest of the help. */
  after?: string;
};

export type PadroneHelpContext = {
  /** The command whose help is being generated. */
  command: unknown;
  /** The requested output format (`'auto'` picks ANSI or text from the terminal). */
  format: HelpFormat | 'auto';
  detail: HelpDetail;
  /** Renders help info with the built-in formatter for this format. */
  render: (info: HelpInfo) => string;
};

/**
 * Function form of `.configure({ help })`: receives the generated help info (with any declarative parts applied)
 * and returns modified info, rendered by the built-in formatter, or the final help string.
 * It applies to the command and its subcommands; a subcommand's own function takes precedence.
 */
export type PadroneHelpTransform = (info: HelpInfo, ctx: PadroneHelpContext) => HelpInfo | string;

/** A positional's name in usage and argument lists: its `valueName` when set, with `...` after a variadic one (`files...`). */
export function positionalLabel(arg: HelpPositionalInfo): string {
  const variadic = arg.name.startsWith('...');
  const name = arg.valueName ?? (variadic ? arg.name.slice(3) : arg.name);
  return variadic ? `${name}...` : name;
}

/** Whether a default is worth showing: not unset, `''` or `[]`. */
export function hasDefaultValue(value: unknown): boolean {
  return value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
}

/** The value placeholder of an option (`valueName`, or its type); none for booleans and counts. */
export function optionPlaceholder(arg: HelpArgumentInfo): string | undefined {
  return arg.type && arg.type !== 'boolean' ? (arg.valueName ?? arg.type) : undefined;
}

// ============================================================================
// Formatter Interface
// ============================================================================

/**
 * A formatter that takes the entire HelpInfo structure and produces formatted output.
 */
export type Formatter = {
  /** Format the entire help info structure into a string */
  format: (info: HelpInfo) => string;
};

// ============================================================================
// Generic Formatter Implementation
// ============================================================================

/**
 * Creates a formatter that uses the given styler and layout configuration.
 */
function createGenericFormatter(styler: Styler, layout: LayoutConfig, showAllBuiltins?: boolean, terminalWidth?: number): Formatter {
  const { newline, indent, join, wrapDocument } = layout;

  function formatUsageSection(info: HelpInfo): string[] {
    if (info.usage.text !== undefined) return [`${styler.label('Usage:')} ${styler.command(info.usage.text)}`];
    const usageParts: string[] = [styler.command(info.usage.command), info.usage.hasSubcommands ? styler.meta('[command]') : ''];
    // Show actual positional argument names in usage line
    if (info.positionals && info.positionals.length > 0) {
      for (const arg of info.positionals) {
        const name = positionalLabel(arg);
        usageParts.push(styler.meta(arg.optional ? `[${name}]` : `<${name}>`));
      }
    }
    if (info.usage.hasArguments) usageParts.push(styler.meta('[options]'));
    return [`${styler.label('Usage:')} ${join(usageParts)}`];
  }

  function formatSubcommandsSection(info: HelpInfo): string[] {
    const lines: string[] = [];
    const subcommands = info.subcommands!;

    const subcommandSuffix = (c: HelpSubcommandInfo) => (c.hasSubcommands ? ' <subcommand>' : '');
    const formatAliasParts = (c: HelpSubcommandInfo) => {
      if (!c.aliases?.length) return { plain: '', styled: '' };
      const realAliases = c.aliases.filter((a) => a !== '[default]');
      const hasDefault = c.aliases.some((a) => a === '[default]');
      const parts: string[] = [];
      const styledParts: string[] = [];
      if (realAliases.length) {
        parts.push(`(${realAliases.join(', ')})`);
        styledParts.push(`(${realAliases.join(', ')})`);
      }
      if (hasDefault) {
        parts.push('[default]');
        styledParts.push(styler.meta('[default]'));
      }
      return { plain: parts.length ? ` ${parts.join(' ')}` : '', styled: styledParts.length ? ` ${styledParts.join(' ')}` : '' };
    };
    // Column width is computed across all subcommands for consistent alignment
    const maxNameLength = Math.max(
      ...subcommands.map((c) => {
        return (c.name + subcommandSuffix(c) + formatAliasParts(c).plain).length;
      }),
    );

    const grouped = Object.groupBy(subcommands, (c) => c.group ?? '');

    const renderSubcommands = (cmds: HelpSubcommandInfo[]) => {
      for (const subCmd of cmds) {
        const aliasParts = formatAliasParts(subCmd);
        const suffix = subcommandSuffix(subCmd);
        const commandDisplay = subCmd.name + suffix + aliasParts.plain;
        const padding = ' '.repeat(Math.max(0, maxNameLength - commandDisplay.length + 2));
        const isDeprecated = !!subCmd.deprecated;
        const isDefaultEntry = subCmd.name === '[default]';
        const commandName = isDeprecated
          ? styler.deprecated(commandDisplay)
          : (isDefaultEntry ? styler.meta(subCmd.name) : styler.command(subCmd.name)) +
            (suffix ? styler.meta(suffix) : '') +
            aliasParts.styled;
        // Use title if available, otherwise use description
        const displayText = subCmd.title ?? subCmd.description;
        // No padding after a name with nothing next to it
        const lineParts: string[] = displayText || isDeprecated ? [commandName, padding] : [commandName];
        if (displayText) {
          lineParts.push(isDeprecated ? styler.deprecated(displayText) : styler.description(displayText));
        }
        if (isDeprecated) {
          const deprecatedMeta =
            typeof subCmd.deprecated === 'string' ? styler.meta(` (deprecated: ${subCmd.deprecated})`) : styler.meta(' (deprecated)');
          lineParts.push(deprecatedMeta);
        }
        lines.push(indent(1) + lineParts.join(''));
      }
    };

    for (const [key, items] of Object.entries(grouped)) {
      if (lines.length > 0) lines.push('');
      lines.push(styler.section(key ? `${key}:` : 'Commands:'));
      renderSubcommands(items!);
    }

    return lines;
  }

  function formatPositionalsSection(info: HelpInfo): string[] {
    const lines: string[] = [];
    const args = info.positionals!;

    lines.push(styler.section('Arguments:'));

    const maxNameLength = Math.min(32, Math.max(...args.map((a) => positionalLabel(a).length)));
    const descCol = 2 + maxNameLength + 2;
    const posAvailWidth = terminalWidth ? terminalWidth - descCol : undefined;
    const descColPad = ' '.repeat(descCol);

    for (const arg of args) {
      const label = positionalLabel(arg);
      const padding = ' '.repeat(Math.max(2, maxNameLength - label.length + 2));
      const prefix = indent(1) + styler.arg(label) + padding;

      const descPlain = arg.description ?? '';
      const styledDesc = descPlain ? styler.description(descPlain) : '';

      const metaParts: string[] = [];
      const styledMetaParts: string[] = [];
      if (info.usage.stdinField === arg.name) {
        metaParts.push('(stdin)');
        styledMetaParts.push(styler.meta('(stdin)'));
      }
      if (arg.enum) {
        const text = `(choices: ${arg.enum.join(', ')})`;
        metaParts.push(text);
        styledMetaParts.push(styler.meta(text));
      }
      if (hasDefaultValue(arg.default)) {
        const text = `(default: ${String(arg.default)})`;
        metaParts.push(text);
        styledMetaParts.push(styler.meta(text));
      }

      const metaStyled = join(styledMetaParts);

      if (posAvailWidth && posAvailWidth > 0) {
        const metaPlain = metaParts.join(' ');
        const fullPlain = [descPlain, metaPlain].filter(Boolean).join(' ');
        if (fullPlain.length <= posAvailWidth) {
          lines.push((prefix + [styledDesc, metaStyled].filter(Boolean).join(' ')).trimEnd());
        } else if (!descPlain || descPlain.length <= posAvailWidth) {
          lines.push((prefix + styledDesc).trimEnd());
          if (metaStyled) lines.push(descColPad + metaStyled);
        } else {
          const wrapped = wrapText(descPlain, posAvailWidth);
          lines.push(prefix + styler.description(wrapped[0]!));
          for (const wline of wrapped.slice(1)) lines.push(descColPad + styler.description(wline));
          if (metaStyled) lines.push(descColPad + metaStyled);
        }
      } else {
        lines.push((prefix + join([styledDesc, metaStyled])).trimEnd());
      }
    }

    return lines;
  }

  function formatArgumentsSection(info: HelpInfo): string[] {
    const lines: string[] = [];
    const argList = info.arguments || [];

    // Build columns: flags | names | type | description
    const argColumns = argList.map((arg) => {
      // Promote kebab-case alias to primary display name if it exists
      const kebab = camelToKebab(arg.name);
      const primaryName = kebab && arg.aliases?.includes(kebab) ? kebab : arg.name;
      const remainingAliases = arg.aliases?.filter((a) => a !== primaryName);

      const flagsPlain = arg.flags?.length ? arg.flags.map((f) => `-${f}`).join(', ') : '';
      const negPlain = arg.negative?.length ? arg.negative.map((n) => `--${n}`).join(', ') : '';
      const namesPlain = [`--${primaryName}`, ...(remainingAliases?.map((a) => `--${a}`) || []), ...(negPlain ? [negPlain] : [])].join(
        ', ',
      );
      const placeholder = optionPlaceholder(arg);
      const typePlain = placeholder ? (arg.optional ? `[${placeholder}]` : `<${placeholder}>`) : '';

      const isDeprecated = !!arg.deprecated;

      return { flagsPlain, namesPlain, typePlain, isDeprecated, arg };
    });

    // Column widths are computed across all args (regardless of group) for consistent alignment
    const maxFlagsWidth = Math.min(12, Math.max(0, ...argColumns.map((c) => c.flagsPlain.length)));
    const maxNamesWidth = Math.min(32, Math.max(0, ...argColumns.map((c) => c.namesPlain.length)));
    const maxTypeWidth = Math.min(16, Math.max(0, ...argColumns.map((c) => c.typePlain.length)));
    const hasAnyFlags = maxFlagsWidth > 0;
    const descCol = 2 + (hasAnyFlags ? maxFlagsWidth + 2 : 0) + maxNamesWidth + 2 + (maxTypeWidth > 0 ? maxTypeWidth + 2 : 0);
    const argAvailWidth = terminalWidth ? terminalWidth - descCol : undefined;
    const descColPad = ' '.repeat(descCol);

    // Split into ordered groups: ungrouped first as "Options:", then each group in first-seen order
    const grouped = Object.groupBy(argColumns, (c) => c.arg.group ?? '');

    const renderArgColumns = (columns: typeof argColumns) => {
      for (const { flagsPlain, namesPlain, typePlain, isDeprecated, arg } of columns) {
        const parts: string[] = [];

        // Flags column
        if (hasAnyFlags) {
          const styledFlags = isDeprecated ? (flagsPlain ? styler.deprecated(flagsPlain) : '') : flagsPlain ? styler.arg(flagsPlain) : '';
          const flagsPadding = ' '.repeat(Math.max(0, maxFlagsWidth - flagsPlain.length));
          const separator = flagsPlain ? ', ' : '  ';
          parts.push(styledFlags + flagsPadding + separator);
        }

        // Names column
        const styledNames = isDeprecated ? styler.deprecated(namesPlain) : styler.arg(namesPlain);
        const namesPadding = ' '.repeat(Math.max(2, maxNamesWidth - namesPlain.length + 2));
        parts.push(styledNames + namesPadding);

        // Type column
        if (maxTypeWidth > 0) {
          const styledType = typePlain ? styler.type(typePlain) : '';
          const typePadding = ' '.repeat(Math.max(2, maxTypeWidth - typePlain.length + 2));
          parts.push(styledType + typePadding);
        }

        const prefix = indent(1) + parts.join('');
        const contPad = argAvailWidth ? descColPad : indent(3);

        // Build inline meta (deprecated no-reason, default, choices)
        const inlineMeta: string[] = [];
        const styledInlineMeta: string[] = [];
        if (isDeprecated && typeof arg.deprecated !== 'string') {
          inlineMeta.push('(deprecated)');
          styledInlineMeta.push(styler.meta('(deprecated)'));
        }
        if (hasDefaultValue(arg.default)) {
          const text = `(default: ${String(arg.default)})`;
          inlineMeta.push(text);
          styledInlineMeta.push(styler.meta(text));
        }
        if (arg.enum) {
          const text = `(choices: ${arg.enum.join(', ')})`;
          inlineMeta.push(text);
          styledInlineMeta.push(styler.meta(text));
        }
        for (const note of arg.notes ?? []) {
          inlineMeta.push(`(${note})`);
          styledInlineMeta.push(styler.meta(`(${note})`));
        }
        if (arg.env) {
          const text = `(env: ${(typeof arg.env === 'string' ? [arg.env] : arg.env).join(', ')})`;
          inlineMeta.push(text);
          styledInlineMeta.push(styler.meta(text));
        }
        if (arg.configKey) {
          const text = `(config: ${arg.configKey})`;
          inlineMeta.push(text);
          styledInlineMeta.push(styler.meta(text));
        }

        const descPlain = arg.description ?? '';
        const styledDesc = descPlain ? (isDeprecated ? styler.deprecated(descPlain) : styler.description(descPlain)) : '';
        const metaStyled = join(styledInlineMeta);

        if (argAvailWidth && argAvailWidth > 0) {
          // Terminal-width-aware: try to fit description + meta on one line
          const metaPlain = inlineMeta.join(' ');
          const fullPlain = [descPlain, metaPlain].filter(Boolean).join(' ');
          if (fullPlain.length <= argAvailWidth) {
            lines.push((prefix + [styledDesc, metaStyled].filter(Boolean).join(' ')).trimEnd());
          } else if (!descPlain || descPlain.length <= argAvailWidth) {
            lines.push((prefix + styledDesc).trimEnd());
            if (metaStyled) lines.push(descColPad + metaStyled);
          } else {
            const wrapped = wrapText(descPlain, argAvailWidth);
            const styleFn = isDeprecated ? styler.deprecated : styler.description;
            lines.push(prefix + styleFn(wrapped[0]!));
            for (const wline of wrapped.slice(1)) lines.push(descColPad + styleFn(wline));
            if (metaStyled) lines.push(descColPad + metaStyled);
          }
        } else {
          // No terminal width (markdown/html): description on line 1, meta on line 2
          const descParts: string[] = [];
          if (styledDesc) descParts.push(styledDesc);
          lines.push((prefix + join(descParts)).trimEnd());
          if (styledInlineMeta.length > 0) lines.push(indent(3) + metaStyled);
        }

        // Deprecated (with reason), examples — always on separate line
        const line3Parts: string[] = [];
        if (isDeprecated && typeof arg.deprecated === 'string') line3Parts.push(styler.meta(`(deprecated: ${arg.deprecated})`));
        if (arg.examples && arg.examples.length > 0) {
          const exampleValues = arg.examples.map((example) => (typeof example === 'string' ? example : JSON.stringify(example))).join(', ');
          line3Parts.push(styler.example('Example:'), styler.exampleValue(exampleValues));
        }
        if (line3Parts.length > 0) lines.push(contPad + join(line3Parts));

        if (info.usage.stdinField === arg.name) lines.push(contPad + styler.meta('(stdin)'));
      }
    };

    for (const [key, items] of Object.entries(grouped)) {
      if (lines.length > 0) lines.push('');
      lines.push(styler.section(key ? `${key}:` : 'Options:'));
      renderArgColumns(items!);
    }

    return lines;
  }

  function formatTopicsSection(info: HelpInfo): string[] {
    const topics = info.topics!;
    const width = Math.max(...topics.map((t) => t.name.length)) + 2;
    const lines = [styler.section('Additional help topics:')];
    for (const topic of topics) {
      const text = topic.description ?? topic.title;
      const padding = text ? ' '.repeat(width - topic.name.length) : '';
      lines.push(indent(1) + styler.command(topic.name) + padding + (text ? styler.description(text) : ''));
    }
    return lines;
  }

  function formatBuiltinsSection(info: HelpInfo): string[] {
    const lines: string[] = [];
    const builtins = info.builtins!;

    if (!showAllBuiltins) {
      // Collapsed summary: show selected builtins on a single line with a combined hint
      const highlights = builtins.flatMap((entry) => (entry.summary ? [entry.summary] : []));
      if (highlights.length > 0) lines.push(`${styler.label('Global:')} ${styler.meta(highlights.join(', '))}`);
      const helpFlag = info.usage.helpFlag;
      const hasHelpCommand = builtins.some((entry) => entry.summary?.startsWith('help'));
      const hint =
        info.usage.hasSubcommands && helpFlag
          ? `Run "${info.usage.command} [command] ${helpFlag}" for more information. Use "--all" for all global commands.`
          : hasHelpCommand
            ? `Use "${info.usage.command} help --all" for more information on global commands.`
            : undefined;
      if (hint) lines.push(styler.meta(hint));
      return lines;
    }

    lines.push(styler.section('Global:'));

    // Compute max effective name length for alignment across main and sub entries
    const allLengths: number[] = [];
    for (const entry of builtins) {
      allLengths.push(entry.name.length);
      if (entry.sub) {
        for (const sub of entry.sub) {
          // Sub entries get extra indent(2) - indent(1) = 2 chars
          allLengths.push(sub.name.length + 2);
        }
      }
    }
    const maxLen = Math.max(...allLengths);

    for (const entry of builtins) {
      const padding = ' '.repeat(Math.max(2, maxLen - entry.name.length + 2));
      const parts: string[] = [styler.command(entry.name)];
      if (entry.description) parts.push(padding + styler.description(entry.description));
      lines.push(indent(1) + parts.join(''));

      if (entry.sub) {
        for (const sub of entry.sub) {
          const subPadding = ' '.repeat(Math.max(2, maxLen - sub.name.length));
          const subParts: string[] = [styler.arg(sub.name)];
          if (sub.description) subParts.push(subPadding + styler.description(sub.description));
          lines.push(indent(2) + subParts.join(''));
        }
      }
    }

    return lines;
  }

  return {
    format(info: HelpInfo): string {
      const lines: string[] = [];

      // Show deprecation warning at the top if command is deprecated
      if (info.deprecated) {
        const deprecationMessage =
          typeof info.deprecated === 'string' ? `⚠️  This command is deprecated: ${info.deprecated}` : '⚠️  This command is deprecated';
        lines.push(styler.deprecated(deprecationMessage));
        lines.push('');
      }

      if (info.before) {
        lines.push(info.before);
        lines.push('');
      }

      // Usage section
      lines.push(...formatUsageSection(info));
      lines.push('');

      // Title section (if present, shows a short summary line)
      if (info.title) {
        lines.push(styler.label(info.title));
        lines.push('');
      }

      // Aliases section (if present)
      if (info.aliases && info.aliases.length > 0) {
        lines.push(styler.meta(`Aliases: ${info.aliases.join(', ')}`));
        lines.push('');
      }

      // Description section (if present)
      if (info.description) {
        lines.push(styler.description(info.description));
        lines.push('');
      }

      // Examples section (if present)
      if (info.examples && info.examples.length > 0) {
        lines.push(styler.section('Examples:'));
        for (const ex of info.examples) {
          lines.push(indent(1) + styler.meta('$ ') + styler.exampleValue(ex));
        }
        lines.push('');
      }

      // Subcommands section
      if (info.subcommands && info.subcommands.length > 0) {
        lines.push(...formatSubcommandsSection(info));
        lines.push('');
      }

      if (info.positionals && info.positionals.length > 0) {
        lines.push(...formatPositionalsSection(info));
        lines.push('');
      }

      if (info.arguments && info.arguments.length > 0) {
        lines.push(...formatArgumentsSection(info));
        lines.push('');
      }

      if (info.topics && info.topics.length > 0) {
        lines.push(...formatTopicsSection(info));
        lines.push('');
      }

      if (info.builtins && info.builtins.length > 0) {
        lines.push(...formatBuiltinsSection(info));
        lines.push('');
      } else if (info.subcommands && info.subcommands.length > 0) {
        // Last, like the builtins section's combined hint
        lines.push(
          styler.meta(`Run "${info.usage.command} [command] ${info.usage.helpFlag ?? '--help'}" for more information on a command.`),
        );
        lines.push('');
      }

      // Show --no- hint when there are negatable boolean options defaulting to true
      if (info.arguments?.some((arg) => arg.negatable && arg.default === true)) {
        lines.push(styler.meta('Boolean options can be negated with --no-<option>.'));
        lines.push('');
      }

      if (info.after) {
        lines.push(info.after);
        lines.push('');
      }

      // Nested commands section (full detail mode)
      if (info.nestedCommands?.length) {
        lines.push(styler.section('Subcommand Details:'));
        lines.push('');
        for (const nestedCmd of info.nestedCommands) {
          lines.push(styler.meta('─'.repeat(60)));
          lines.push(this.format(nestedCmd));
        }
      }

      const result = lines.join(newline);
      return wrapDocument ? wrapDocument(result) : result;
    },
  };
}

// ============================================================================
// JSON Formatter
// ============================================================================

function createJsonFormatter(): Formatter {
  return {
    format(info: HelpInfo): string {
      return JSON.stringify(info, null, 2);
    },
  };
}

// ============================================================================
// Minimal Formatter
// ============================================================================

/**
 * Creates a minimal formatter that outputs just a single-line usage string.
 */
function createMinimalFormatter(): Formatter {
  return {
    format(info: HelpInfo): string {
      if (info.usage.text !== undefined) return info.usage.text;
      const parts: string[] = [info.usage.command];
      if (info.usage.hasSubcommands) parts.push('[command]');
      if (info.positionals && info.positionals.length > 0) {
        for (const arg of info.positionals) {
          const name = positionalLabel(arg);
          parts.push(arg.optional ? `[${name}]` : `<${name}>`);
        }
      }
      if (info.usage.hasArguments) parts.push('[options]');
      return parts.join(' ');
    },
  };
}

export function createFormatter(
  format: HelpFormat | 'auto',
  detail: HelpDetail = 'standard',
  theme?: ColorTheme | ColorConfig,
  all?: boolean,
  width?: number,
  terminal?: { columns?: number; isTTY?: boolean },
  env?: Record<string, string | undefined>,
): Formatter {
  if (detail === 'minimal') return createMinimalFormatter();
  if (format === 'json') return createJsonFormatter();
  const tw = format === 'markdown' || format === 'html' ? undefined : (width ?? terminal?.columns ?? DEFAULT_TERMINAL_WIDTH);
  if (format === 'ansi' || (format === 'auto' && shouldUseAnsi(env, terminal?.isTTY)))
    return createGenericFormatter(createAnsiStyler(theme), createTextLayout(), all, tw);
  if (format === 'console') return createGenericFormatter(createConsoleStyler(theme), createTextLayout(), all, tw);
  if (format === 'markdown') return createGenericFormatter(createMarkdownStyler(), createMarkdownLayout(), all);
  if (format === 'html') return createGenericFormatter(createHtmlStyler(), createHtmlLayout(), all);
  return createGenericFormatter(createTextStyler(), createTextLayout(), all, tw);
}
