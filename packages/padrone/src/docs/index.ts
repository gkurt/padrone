import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getCommand, getCommandRuntime } from '../core/commands.ts';
import {
  type HelpArgumentInfo,
  type HelpInfo,
  type HelpPositionalInfo,
  type HelpSubcommandInfo,
  hasDefaultValue,
  optionPlaceholder,
  positionalLabel,
} from '../output/formatter.ts';
import { getHelpInfo, getHelpTopics } from '../output/help.ts';
import type { AnyPadroneCommand } from '../types/index.ts';

// ============================================================================
// Types
// ============================================================================

export type DocsFormat = 'markdown' | 'html' | 'man' | 'json';

export type DocsOptions = {
  /** Output format. Defaults to 'markdown'. */
  format?: DocsFormat;
  /** Output directory. If not set, docs are returned but not written. */
  output?: string;
  /** Include hidden commands and options. Defaults to false. */
  includeHidden?: boolean;
  /** Frontmatter generator for markdown files (VitePress, Starlight, etc.). */
  frontmatter?: (info: HelpInfo, depth: number) => Record<string, unknown>;
  /** Whether to overwrite existing files. Defaults to true. */
  overwrite?: boolean;
  /** Print what would be written without writing. */
  dryRun?: boolean;
  /** The date in man pages' `.TH` line. Defaults to `SOURCE_DATE_EPOCH` when set (reproducible builds), else today. */
  date?: string | Date;
  /** The man page section (`.TH`, SEE ALSO references and the file extension). Defaults to `1`. */
  section?: ManSection;
};

/** A man page section: `1` (user commands), `8` (administration), or a suffixed one like `'1m'`. */
export type ManSection = number | string;

export type DocsPage = {
  /** File path relative to output directory (e.g., "deploy.md", "index.md"). */
  path: string;
  /** Generated content for this page. */
  content: string;
  /** The command name this page documents. */
  command: string;
};

export type DocsResult = {
  /** All generated pages. */
  pages: DocsPage[];
  /** Files that were written (empty if no output dir). */
  written: string[];
  /** Files that were skipped (already exist, no overwrite). */
  skipped: string[];
  /** Files that failed to write. */
  errors: { file: string; error: Error }[];
};

// ============================================================================
// Help Info Collection
// ============================================================================

function collectAllHelpInfo(cmd: AnyPadroneCommand, includeHidden: boolean): HelpInfo[] {
  const info = getHelpInfo(cmd, 'standard');
  const result: HelpInfo[] = [info];

  if (cmd.commands) {
    for (const sub of cmd.commands) {
      if (!includeHidden && sub.hidden) continue;
      result.push(...collectAllHelpInfo(sub, includeHidden));
    }
  }

  return result;
}

// ============================================================================
// Markdown Generator
// ============================================================================

function generateFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
      }
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function formatMarkdownPositional(arg: HelpPositionalInfo): string {
  const parts: string[] = [];
  parts.push(`- \`${positionalLabel(arg)}\``);
  if (arg.type) parts.push(`*(${arg.type})*`);
  if (arg.optional) parts.push('*(optional)*');
  if (hasDefaultValue(arg.default)) parts.push(`— default: \`${String(arg.default)}\``);
  if (arg.description) parts.push(`— ${arg.description}`);
  return parts.join(' ');
}

function formatMarkdownArgument(arg: HelpArgumentInfo): string[] {
  const lines: string[] = [];

  const flagName = `--${arg.name}`;
  const flagStr = arg.flags?.length ? `${arg.flags.map((f) => `-${f}`).join(', ')}, ` : '';
  const aliasStr = arg.aliases?.length ? `${arg.aliases.map((a) => `--${a}`).join(', ')}, ` : '';
  const header = `#### \`${flagStr}${aliasStr}${flagName}${arg.valueName && optionPlaceholder(arg) ? ` <${arg.valueName}>` : ''}\``;
  lines.push(header);
  lines.push('');

  if (arg.description) {
    lines.push(arg.description);
    lines.push('');
  }

  const meta: string[] = [];
  if (arg.type && arg.type !== 'boolean') meta.push(`**Type:** \`${arg.type}\``);
  if (!arg.optional) meta.push('**Required**');
  if (hasDefaultValue(arg.default)) meta.push(`**Default:** \`${String(arg.default)}\``);
  if (arg.enum) meta.push(`**Choices:** ${arg.enum.map((v) => `\`${v}\``).join(', ')}`);
  if (arg.variadic) meta.push('**Repeatable**');
  if (arg.deprecated) {
    const msg = typeof arg.deprecated === 'string' ? arg.deprecated : '';
    meta.push(`**Deprecated**${msg ? `: ${msg}` : ''}`);
  }

  if (meta.length > 0) {
    lines.push(meta.join(' | '));
    lines.push('');
  }

  if (arg.env) {
    const envVars = typeof arg.env === 'string' ? [arg.env] : arg.env;
    lines.push(`**Environment:** ${envVars.map((v) => `\`${v}\``).join(', ')}`);
    lines.push('');
  }

  if (arg.configKey) {
    lines.push(`**Config key:** \`${arg.configKey}\``);
    lines.push('');
  }

  if (arg.examples?.length) {
    lines.push(`**Examples:** ${arg.examples.map((e) => `\`${typeof e === 'string' ? e : JSON.stringify(e)}\``).join(', ')}`);
    lines.push('');
  }

  return lines;
}

function formatMarkdownSubcommand(sub: HelpSubcommandInfo): string {
  const parts: string[] = [];
  const suffix = sub.hasSubcommands ? ' ...' : '';
  parts.push(`| \`${sub.name}${suffix}\``);

  const aliases = sub.aliases?.filter((a) => a !== '[default]');
  parts.push(`| ${aliases?.length ? aliases.map((a) => `\`${a}\``).join(', ') : ''}`);

  // A table cell is one line, and `|` would end it
  const desc = (sub.title ?? sub.description ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
  parts.push(`| ${desc}`);
  parts.push('|');

  return parts.join(' ');
}

function generateMarkdownPage(info: HelpInfo, depth: number, frontmatterFn?: DocsOptions['frontmatter']): string {
  const lines: string[] = [];

  if (frontmatterFn) {
    const fm = frontmatterFn(info, depth);
    if (Object.keys(fm).length > 0) {
      lines.push(generateFrontmatter(fm));
      lines.push('');
    }
  }

  // Title
  const displayName = info.name === '<root>' || !info.name ? 'CLI Reference' : info.name;
  lines.push(`# ${displayName}`);
  lines.push('');

  // Deprecation warning
  if (info.deprecated) {
    const msg = typeof info.deprecated === 'string' ? info.deprecated : 'This command is deprecated.';
    lines.push(`> **Deprecated:** ${msg}`);
    lines.push('');
  }

  // Description
  if (info.title) {
    lines.push(`> ${info.title}`);
    lines.push('');
  }
  if (info.description) {
    lines.push(info.description);
    lines.push('');
  }

  // Aliases
  if (info.aliases?.length) {
    const realAliases = info.aliases.filter((a) => a !== '[default]');
    if (realAliases.length > 0) {
      lines.push(`**Aliases:** ${realAliases.map((a) => `\`${a}\``).join(', ')}`);
      lines.push('');
    }
  }

  // Usage
  const usageParts: string[] = [info.usage.command];
  if (info.usage.hasSubcommands) usageParts.push('[command]');
  if (info.positionals?.length) {
    for (const arg of info.positionals) {
      usageParts.push(arg.optional ? `[${positionalLabel(arg)}]` : `<${positionalLabel(arg)}>`);
    }
  }
  if (info.usage.hasArguments) usageParts.push('[options]');

  lines.push('## Usage');
  lines.push('');
  lines.push('```');
  lines.push(usageParts.join(' '));
  lines.push('```');
  lines.push('');

  // Examples
  if (info.examples?.length) {
    lines.push('## Examples');
    lines.push('');
    lines.push('```');
    for (const ex of info.examples) {
      lines.push(`$ ${ex}`);
    }
    lines.push('```');
    lines.push('');
  }

  // Subcommands
  if (info.subcommands?.length) {
    const visibleSubs = info.subcommands.filter((s) => !s.hidden);
    if (visibleSubs.length > 0) {
      lines.push('## Commands');
      lines.push('');
      lines.push('| Command | Aliases | Description |');
      lines.push('| --- | --- | --- |');
      for (const sub of visibleSubs) {
        lines.push(formatMarkdownSubcommand(sub));
      }
      lines.push('');
    }
  }

  // Positional arguments
  if (info.positionals?.length) {
    lines.push('## Arguments');
    lines.push('');
    for (const arg of info.positionals) {
      lines.push(formatMarkdownPositional(arg));
    }
    lines.push('');
  }

  // Options
  if (info.arguments?.length) {
    lines.push('## Options');
    lines.push('');
    for (const arg of info.arguments) {
      lines.push(...formatMarkdownArgument(arg));
    }
  }

  lines.push(...markdownTopicsSection(info));

  return `${lines.join('\n').trimEnd()}\n`;
}

// ============================================================================
// HTML Generator
// ============================================================================

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateHtmlPage(info: HelpInfo, depth: number): string {
  const displayName = info.name === '<root>' || !info.name ? 'CLI Reference' : escapeHtml(info.name);

  const sections: string[] = [];

  // Header
  sections.push(`<article class="padrone-docs-page" data-command="${escapeHtml(info.name)}" data-depth="${depth}">`);
  sections.push(`  <h1>${displayName}</h1>`);

  if (info.deprecated) {
    const msg = typeof info.deprecated === 'string' ? escapeHtml(info.deprecated) : 'This command is deprecated.';
    sections.push(`  <div class="deprecated-warning"><strong>Deprecated:</strong> ${msg}</div>`);
  }

  if (info.title) {
    sections.push(`  <p class="command-title">${escapeHtml(info.title)}</p>`);
  }
  if (info.description) {
    sections.push(`  <p class="command-description">${escapeHtml(info.description)}</p>`);
  }

  // Aliases
  if (info.aliases?.length) {
    const realAliases = info.aliases.filter((a) => a !== '[default]');
    if (realAliases.length > 0) {
      sections.push(`  <p><strong>Aliases:</strong> ${realAliases.map((a) => `<code>${escapeHtml(a)}</code>`).join(', ')}</p>`);
    }
  }

  // Usage
  const usageParts: string[] = [info.usage.command];
  if (info.usage.hasSubcommands) usageParts.push('[command]');
  if (info.positionals?.length) {
    for (const arg of info.positionals) {
      usageParts.push(arg.optional ? `[${positionalLabel(arg)}]` : `<${positionalLabel(arg)}>`);
    }
  }
  if (info.usage.hasArguments) usageParts.push('[options]');

  sections.push('  <h2>Usage</h2>');
  sections.push(`  <pre><code>${escapeHtml(usageParts.join(' '))}</code></pre>`);

  // Examples
  if (info.examples?.length) {
    sections.push('  <h2>Examples</h2>');
    sections.push(`  <pre><code>${info.examples.map((ex) => `$ ${escapeHtml(ex)}`).join('\n')}</code></pre>`);
  }

  // Subcommands
  if (info.subcommands?.length) {
    const visibleSubs = info.subcommands.filter((s) => !s.hidden);
    if (visibleSubs.length > 0) {
      sections.push('  <h2>Commands</h2>');
      sections.push('  <table>');
      sections.push('    <thead><tr><th>Command</th><th>Aliases</th><th>Description</th></tr></thead>');
      sections.push('    <tbody>');
      for (const sub of visibleSubs) {
        const aliases = sub.aliases?.filter((a) => a !== '[default]');
        const desc = sub.title ?? sub.description ?? '';
        const suffix = sub.hasSubcommands ? ' ...' : '';
        sections.push(
          `      <tr><td><code>${escapeHtml(sub.name + suffix)}</code></td><td>${aliases?.length ? aliases.map((a) => `<code>${escapeHtml(a)}</code>`).join(', ') : ''}</td><td>${escapeHtml(desc)}</td></tr>`,
        );
      }
      sections.push('    </tbody>');
      sections.push('  </table>');
    }
  }

  // Positional arguments
  if (info.positionals?.length) {
    sections.push('  <h2>Arguments</h2>');
    sections.push('  <dl>');
    for (const arg of info.positionals) {
      sections.push(
        `    <dt><code>${escapeHtml(positionalLabel(arg))}</code>${arg.type ? ` <span class="type">${escapeHtml(arg.type)}</span>` : ''}${arg.optional ? ' <em>(optional)</em>' : ''}</dt>`,
      );
      if (arg.description) sections.push(`    <dd>${escapeHtml(arg.description)}</dd>`);
      if (hasDefaultValue(arg.default)) sections.push(`    <dd>Default: <code>${escapeHtml(String(arg.default))}</code></dd>`);
    }
    sections.push('  </dl>');
  }

  // Options
  if (info.arguments?.length) {
    sections.push('  <h2>Options</h2>');
    sections.push('  <dl>');
    for (const arg of info.arguments) {
      const flagName = `--${arg.name}`;
      const flagStr = arg.flags?.length ? `${arg.flags.map((f) => `-${f}`).join(', ')}, ` : '';
      const aliasStr = arg.aliases?.length ? `${arg.aliases.map((a) => `--${a}`).join(', ')}, ` : '';
      const placeholder = optionPlaceholder(arg);
      const typeSpan = placeholder ? ` <span class="type">${escapeHtml(placeholder)}</span>` : '';
      sections.push(`    <dt><code>${escapeHtml(flagStr + aliasStr + flagName)}</code>${typeSpan}</dt>`);
      if (arg.description) sections.push(`    <dd>${escapeHtml(arg.description)}</dd>`);

      const meta: string[] = [];
      if (!arg.optional) meta.push('Required');
      if (hasDefaultValue(arg.default)) meta.push(`Default: <code>${escapeHtml(String(arg.default))}</code>`);
      if (arg.enum) meta.push(`Choices: ${arg.enum.map((v) => `<code>${escapeHtml(v)}</code>`).join(', ')}`);
      if (arg.variadic) meta.push('Repeatable');
      if (arg.deprecated) {
        const msg = typeof arg.deprecated === 'string' ? escapeHtml(arg.deprecated) : '';
        meta.push(`Deprecated${msg ? `: ${msg}` : ''}`);
      }
      if (meta.length > 0) sections.push(`    <dd class="meta">${meta.join(' · ')}</dd>`);

      if (arg.env) {
        const envVars = typeof arg.env === 'string' ? [arg.env] : arg.env;
        sections.push(`    <dd>Environment: ${envVars.map((v) => `<code>${escapeHtml(v)}</code>`).join(', ')}</dd>`);
      }
      if (arg.configKey) {
        sections.push(`    <dd>Config key: <code>${escapeHtml(arg.configKey)}</code></dd>`);
      }
    }
    sections.push('  </dl>');
  }

  sections.push('</article>');
  return `${sections.join('\n')}\n`;
}

// ============================================================================
// Man Page Generator (experimental)
// ============================================================================

function escapeMan(text: string): string {
  return (
    text
      .replace(/\\/g, '\\\\')
      .replace(/-/g, '\\-')
      .replace(/'/g, '\\(aq')
      // A line starting with `.` would be read as a roff request
      .replace(/(^|\n)\./g, '$1\\&.')
  );
}

/** A quoted macro argument (`.TH "..."`): `"` can't appear in one as is. */
const manArg = (text: string) => `"${escapeMan(text).replace(/"/g, '\\(dq')}"`;

/** Joins escaped parts into a sentence line; a part ending in a newline would start the next line with the `.` separator. */
const manJoin = (parts: string[]) => parts.join('. ').replace(/\n\./g, '\n\\&.');

/** The command a man page documents, with the program name (`myapp deploy`), so pages don't shadow system ones (`ls.1`). */
function manCommandName(info: HelpInfo, programName: string): string {
  if (info.name === '<root>' || !info.name || info.name === programName) return programName;
  return info.name.startsWith(`${programName} `) ? info.name : `${programName} ${info.name}`;
}

const manPageName = (info: HelpInfo, programName: string) => manCommandName(info, programName).replace(/\s+/g, '-');

type ManPageContext = {
  programName: string;
  section: string;
  /** The `.TH` date. */
  date: string;
  /** The `.TH` source: the program and its version. */
  source: string;
  /** Every page generated, to link the parent and subcommand pages. */
  infos: HelpInfo[];
};

/** The `.TH` date: the `date` option, else `SOURCE_DATE_EPOCH` (for reproducible builds), else today, as `YYYY-MM-DD`. */
function manDate(date: string | Date | undefined, env: Record<string, string | undefined>): string {
  if (typeof date === 'string') return date;
  const epoch = Number(env.SOURCE_DATE_EPOCH);
  const value = date ?? (env.SOURCE_DATE_EPOCH && Number.isFinite(epoch) ? new Date(epoch * 1000) : new Date());
  return value.toISOString().slice(0, 10);
}

function manPageContext(
  cmd: AnyPadroneCommand,
  infos: HelpInfo[],
  date: string | Date | undefined,
  section: ManSection | undefined,
): ManPageContext {
  const programName = cmd.name || 'program';
  const source = cmd.version ? `${programName} ${cmd.version}` : '';
  return { programName, section: manSectionName(section), date: manDate(date, getCommandRuntime(cmd).env()), source, infos };
}

/** The section as written in file names and references; anything but letters and digits is dropped. */
function manSectionName(section: ManSection | undefined): string {
  return String(section ?? 1).replace(/[^A-Za-z0-9]/g, '') || '1';
}

/** The pages of the parent command and the direct subcommands (the first info is the program's), like cobra's SEE ALSO. */
function manSeeAlso(info: HelpInfo, { infos, programName }: ManPageContext): string[] {
  const pathOf = (other: HelpInfo) => (other === infos[0] ? [] : other.name.split(' '));
  const path = pathOf(info);
  const isPrefix = (short: string[], long: string[]) => long.length === short.length + 1 && short.every((part, i) => part === long[i]);
  return infos
    .filter((other) => isPrefix(pathOf(other), path) || isPrefix(path, pathOf(other)))
    .map((other) => manPageName(other, programName));
}

function generateManPage(info: HelpInfo, context: ManPageContext): string {
  const { programName } = context;
  const commandName = manCommandName(info, programName);
  const manName = commandName.replace(/\s+/g, '-');
  const lines: string[] = [];

  lines.push(`.TH ${[manName.toUpperCase(), context.section, context.date, context.source, ''].map(manArg).join(' ')}`);

  // NAME
  lines.push('.SH NAME');
  const desc = info.title ?? info.description ?? '';
  lines.push(`${escapeMan(manName)}${desc ? ` \\- ${escapeMan(desc)}` : ''}`);

  // SYNOPSIS
  lines.push('.SH SYNOPSIS');
  const usageParts: string[] = [`\\fB${escapeMan(commandName)}\\fR`];
  if (info.usage.hasSubcommands) usageParts.push('[\\fIcommand\\fR]');
  if (info.positionals?.length) {
    for (const arg of info.positionals) {
      usageParts.push(arg.optional ? `[\\fI${escapeMan(positionalLabel(arg))}\\fR]` : `\\fI${escapeMan(positionalLabel(arg))}\\fR`);
    }
  }
  if (info.usage.hasArguments) usageParts.push('[\\fIoptions\\fR]');
  lines.push(usageParts.join(' '));

  // DESCRIPTION
  if (info.description) {
    lines.push('.SH DESCRIPTION');
    lines.push(escapeMan(info.description));
  }

  // EXAMPLES
  if (info.examples?.length) {
    lines.push('.SH EXAMPLES');
    for (const ex of info.examples) {
      lines.push('.PP');
      lines.push(`.nf\n$ ${escapeMan(ex)}\n.fi`);
    }
  }

  // COMMANDS
  if (info.subcommands?.length) {
    const visibleSubs = info.subcommands.filter((s) => !s.hidden);
    if (visibleSubs.length > 0) {
      lines.push('.SH COMMANDS');
      for (const sub of visibleSubs) {
        const suffix = sub.hasSubcommands ? ' ...' : '';
        lines.push(`.TP`);
        lines.push(`\\fB${escapeMan(sub.name + suffix)}\\fR`);
        const subDesc = sub.title ?? sub.description;
        if (subDesc) lines.push(escapeMan(subDesc));
      }
    }
  }

  // ARGUMENTS
  if (info.positionals?.length) {
    lines.push('.SH ARGUMENTS');
    for (const arg of info.positionals) {
      lines.push('.TP');
      lines.push(`\\fI${escapeMan(positionalLabel(arg))}\\fR`);
      const parts: string[] = [];
      if (arg.description) parts.push(escapeMan(arg.description));
      if (arg.optional) parts.push('(optional)');
      if (hasDefaultValue(arg.default)) parts.push(`Default: ${escapeMan(String(arg.default))}`);
      if (parts.length > 0) lines.push(manJoin(parts));
    }
  }

  // OPTIONS
  if (info.arguments?.length) {
    lines.push('.SH OPTIONS');
    for (const arg of info.arguments) {
      const flagName = `\\-\\-${escapeMan(arg.name)}`;
      const flagStr = arg.flags?.length ? `${arg.flags.map((f) => `\\-${escapeMan(f)}`).join(', ')}, ` : '';
      const aliasStr = arg.aliases?.length ? `${arg.aliases.map((a) => `\\-\\-${escapeMan(a)}`).join(', ')}, ` : '';
      lines.push('.TP');
      const placeholder = optionPlaceholder(arg);
      lines.push(`\\fB${flagStr}${aliasStr}${flagName}\\fR${placeholder ? ` \\fI${escapeMan(placeholder)}\\fR` : ''}`);
      const parts: string[] = [];
      if (arg.description) parts.push(escapeMan(arg.description));
      if (hasDefaultValue(arg.default)) parts.push(`Default: ${escapeMan(String(arg.default))}`);
      if (arg.enum) parts.push(`Choices: ${arg.enum.map((v) => escapeMan(v)).join(', ')}`);
      if (parts.length > 0) lines.push(manJoin(parts));

      if (arg.env) {
        const envVars = typeof arg.env === 'string' ? [arg.env] : arg.env;
        lines.push(`.br`);
        lines.push(`Environment: ${envVars.map((v) => escapeMan(v)).join(', ')}`);
      }
    }
  }

  const related = manSeeAlso(info, context);
  if (related.length > 0) {
    lines.push('.SH SEE ALSO');
    lines.push(related.map((name) => `\\fB${escapeMan(name)}\\fR(${context.section})`).join(', '));
  }

  return `${lines.join('\n')}\n`;
}

// ============================================================================
// Page Path Helpers
// ============================================================================

function commandToPath(info: HelpInfo, ext: string, isRoot: boolean): string {
  if (isRoot) return `index${ext}`;
  // Split on whitespace and replace empty segments (from empty-name default commands) with "_default"
  const segments = info.name.split(/\s+/).map((s) => s || '_default');
  return segments.join('/') + ext;
}

// ============================================================================
// Index Page Generators
// ============================================================================

/** Links to the help topic pages (`topics/<name>.md`). */
function markdownTopicsSection(info: HelpInfo): string[] {
  if (!info.topics?.length) return [];
  const links = info.topics.map((t) => {
    const desc = t.description ?? t.title;
    return `- [${t.name}](topics/${t.name}.md)${desc ? ` — ${desc}` : ''}`;
  });
  return ['## Help Topics', '', ...links, ''];
}

function generateMarkdownIndex(rootInfo: HelpInfo, allInfos: HelpInfo[]): string {
  const lines: string[] = [];
  lines.push(`# ${rootInfo.title ?? rootInfo.name ?? 'CLI'} Reference`);
  lines.push('');

  if (rootInfo.description) {
    lines.push(rootInfo.description);
    lines.push('');
  }

  if (allInfos.length > 1) {
    lines.push('## Commands');
    lines.push('');
    for (const info of allInfos) {
      const path = commandToPath(info, '.md', info === rootInfo);
      const name = info === rootInfo ? info.name || 'root' : info.name;
      const desc = info.title ?? info.description ?? '';
      lines.push(`- [${name}](${path})${desc ? ` — ${desc}` : ''}`);
    }
    lines.push('');
  }

  lines.push(...markdownTopicsSection(rootInfo));

  return `${lines.join('\n').trimEnd()}\n`;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Generate documentation for a Padrone CLI program or command tree.
 * Accepts either a PadroneProgram (from createPadrone()) or a raw AnyPadroneCommand.
 */
export function generateDocs(program: object, options: DocsOptions = {}): DocsResult {
  const { format = 'markdown', output, includeHidden = false, frontmatter, overwrite = true, dryRun = false } = options;

  const cmd = getCommand(program);
  const allInfos = collectAllHelpInfo(cmd, includeHidden);
  const rootInfo = allInfos[0]!;
  const programName = cmd.name || 'program';
  const manContext = format === 'man' ? manPageContext(cmd, allInfos, options.date, options.section) : undefined;

  const pages: DocsPage[] = [];

  const ext = format === 'markdown' ? '.md' : format === 'html' ? '.html' : format === 'man' ? `.${manContext!.section}` : '.json';

  for (let i = 0; i < allInfos.length; i++) {
    const info = allInfos[i]!;
    const isRoot = i === 0;
    const depth = isRoot ? 0 : info.name.split(/\s+/).length;
    const path = commandToPath(info, ext, isRoot);

    let content: string;
    switch (format) {
      case 'markdown':
        content = generateMarkdownPage(info, depth, frontmatter);
        break;
      case 'html':
        content = generateHtmlPage(info, depth);
        break;
      case 'man':
        content = generateManPage(info, manContext!);
        break;
      case 'json':
        content = `${JSON.stringify(info, null, 2)}\n`;
        break;
    }

    pages.push({ path, content, command: info.name });
  }

  // Generate index page for markdown (when there are subcommands)
  if (format === 'markdown' && allInfos.length > 1) {
    // Replace the root page with a combined index
    const rootPage = pages[0]!;
    rootPage.content = generateMarkdownIndex(rootInfo, allInfos);
  }

  if (format === 'markdown') {
    const runtime = getCommandRuntime(cmd);
    for (const [name, topic] of getHelpTopics(cmd)) {
      const title = topic.title ?? name;
      const content = typeof topic.content === 'function' ? topic.content({ runtime, format: 'markdown' }) : topic.content;
      const info: HelpInfo = {
        name,
        title,
        description: topic.description,
        usage: { command: `${programName} help ${name}`, hasSubcommands: false, hasPositionals: false, hasArguments: false },
      };
      const fm = frontmatter?.(info, 1);
      const header = fm && Object.keys(fm).length > 0 ? `${generateFrontmatter(fm)}\n\n` : '';
      pages.push({ path: `topics/${name}.md`, content: `${header}# ${title}\n\n${content.trim()}\n`, command: `help ${name}` });
    }
  }

  const result: DocsResult = { pages, written: [], skipped: [], errors: [] };

  // Write to disk if output dir specified
  if (output) {
    const outDir = resolve(output);

    for (const page of pages) {
      const fullPath = join(outDir, page.path);

      try {
        if (existsSync(fullPath) && !overwrite) {
          result.skipped.push(page.path);
          continue;
        }

        if (dryRun) {
          result.written.push(page.path);
          continue;
        }

        const dir = dirname(fullPath);
        mkdirSync(dir, { recursive: true });
        writeFileSync(fullPath, page.content, 'utf-8');
        result.written.push(page.path);
      } catch (err) {
        result.errors.push({
          file: page.path,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  return result;
}

// ============================================================================
// Man Page Installation
// ============================================================================

export type SetupManPagesResult = {
  /** Directory where man pages were written. */
  dir: string;
  /** Man page files that were written. */
  written: string[];
  /** Whether existing pages were overwritten (true) or newly created (false). */
  updated: boolean;
};

/** Where `setupManPages()` / `removeManPages()` put the pages. */
export type ManPagesInstallOptions = {
  /** The man page section. Defaults to `1`. */
  section?: ManSection;
  /**
   * The directory the pages are written to. Defaults to `man<section>` under `$XDG_DATA_HOME/man`
   * (`~/.local/share/man`), read from the program's runtime environment. A leading `~/` is the home directory.
   */
  dir?: string;
};

/** The directory to install man pages in (see `ManPagesInstallOptions.dir`). */
async function getManPageDir(cmd: AnyPadroneCommand, section: string, dir: string | undefined): Promise<string> {
  const { homedir } = await import('node:os');
  const env = getCommandRuntime(cmd).env();
  const home = env.HOME || env.USERPROFILE || homedir();
  if (dir) return resolve(dir === '~' || /^~[/\\]/.test(dir) ? join(home, dir.slice(2)) : dir);
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'man', `man${section}`);
}

/**
 * Converts a command name to a man page filename.
 * "myapp" → "myapp.1", "myapp deploy" → "myapp-deploy.1"
 */
function manPageFilename(commandName: string, section: string): string {
  return `${commandName.replace(/\s+/g, '-')}.${section}`;
}

/**
 * Installs man pages for a Padrone CLI program into the local man directory.
 * Generates man pages for all commands and writes them to `~/.local/share/man/man1/` (see `ManPagesInstallOptions`).
 *
 * After installation, `man <program>` and `man <program>-<subcommand>` should work
 * (assuming `~/.local/share/man` is in `MANPATH` or `manpath` picks it up).
 */
export async function setupManPages(program: object, options: ManPagesInstallOptions = {}): Promise<SetupManPagesResult> {
  const cmd = getCommand(program);
  const allInfos = collectAllHelpInfo(cmd, false);
  const context = manPageContext(cmd, allInfos, undefined, options.section);
  const manDir = await getManPageDir(cmd, context.section, options.dir);

  mkdirSync(manDir, { recursive: true });

  const written: string[] = [];
  let updated = false;

  for (const info of allInfos) {
    const filename = manPageFilename(manCommandName(info, context.programName), context.section);
    const fullPath = join(manDir, filename);

    if (existsSync(fullPath)) updated = true;

    const content = generateManPage(info, context);
    writeFileSync(fullPath, content, 'utf-8');
    written.push(filename);
  }

  return { dir: manDir, written, updated };
}

/**
 * Removes installed man pages for a Padrone CLI program.
 */
export async function removeManPages(program: object, options: ManPagesInstallOptions = {}): Promise<{ dir: string; removed: string[] }> {
  const { unlinkSync } = await import('node:fs');
  const cmd = getCommand(program);
  const allInfos = collectAllHelpInfo(cmd, false);
  const programName = cmd.name || 'program';
  const section = manSectionName(options.section);
  const manDir = await getManPageDir(cmd, section, options.dir);
  const removed: string[] = [];

  for (let i = 0; i < allInfos.length; i++) {
    const info = allInfos[i]!;
    const commandName = manCommandName(info, programName);
    const filename = manPageFilename(commandName, section);
    const fullPath = join(manDir, filename);

    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
      removed.push(filename);
    }
  }

  return { dir: manDir, removed };
}
