import type { PadroneActionContext } from '../types/index.ts';
import { type ColorConfig, type ColorTheme, createColorizer } from './colorizer.ts';

export const DEFAULT_TERMINAL_WIDTH = 80;

export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || text.length <= maxWidth) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + 1 + word.length > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ── Styler ──────────────────────────────────────────────────────────────

/**
 * Styling functions for semantic text roles.
 * Used by formatters to apply visual styles (ANSI, HTML, Markdown, etc.)
 * to different types of content.
 */
export type Styler = {
  command: (text: string) => string;
  arg: (text: string) => string;
  type: (text: string) => string;
  description: (text: string) => string;
  label: (text: string) => string;
  section: (text: string) => string;
  meta: (text: string) => string;
  example: (text: string) => string;
  exampleValue: (text: string) => string;
  deprecated: (text: string) => string;
};

/**
 * Layout configuration for formatters.
 */
export type LayoutConfig = {
  newline: string;
  indent: (level: number) => string;
  join: (parts: string[]) => string;
  wrapDocument?: (content: string) => string;
};

// ── Styler Factories ────────────────────────────────────────────────────

export function createTextStyler(): Styler {
  return {
    command: (text) => text,
    arg: (text) => text,
    type: (text) => text,
    description: (text) => text,
    label: (text) => text,
    section: (text) => text,
    meta: (text) => text,
    example: (text) => text,
    exampleValue: (text) => text,
    deprecated: (text) => text,
  };
}

export function createAnsiStyler(theme?: ColorTheme | ColorConfig): Styler {
  const colorizer = createColorizer(theme);
  return {
    command: colorizer.command,
    arg: colorizer.arg,
    type: colorizer.type,
    description: colorizer.description,
    label: colorizer.label,
    section: colorizer.label,
    meta: colorizer.meta,
    example: colorizer.example,
    exampleValue: colorizer.exampleValue,
    deprecated: colorizer.deprecated,
  };
}

export function createConsoleStyler(theme?: ColorTheme | ColorConfig): Styler {
  return createAnsiStyler(theme);
}

export function createMarkdownStyler(): Styler {
  return {
    command: (text) => `**${text}**`,
    arg: (text) => `\`${text}\``,
    type: (text) => `\`${text}\``,
    description: (text) => text,
    label: (text) => `**${text}**`,
    section: (text) => `### ${text}`,
    meta: (text) => `*${text}*`,
    example: (text) => `**${text}**`,
    exampleValue: (text) => `\`${text}\``,
    deprecated: (text) => `~~${text}~~`,
  };
}

export function createHtmlStyler(): Styler {
  return {
    command: (text) => `<strong style="color: #00bcd4;">${escapeHtml(text)}</strong>`,
    arg: (text) => `<code style="color: #4caf50;">${escapeHtml(text)}</code>`,
    type: (text) => `<code style="color: #ff9800;">${escapeHtml(text)}</code>`,
    description: (text) => `<span style="color: #666;">${escapeHtml(text)}</span>`,
    label: (text) => `<strong>${escapeHtml(text)}</strong>`,
    section: (text) => `<h3>${escapeHtml(text)}</h3>`,
    meta: (text) => `<span style="color: #999;">${escapeHtml(text)}</span>`,
    example: (text) => `<strong style="text-decoration: underline;">${escapeHtml(text)}</strong>`,
    exampleValue: (text) => `<em>${escapeHtml(text)}</em>`,
    deprecated: (text) => `<del style="color: #999;">${escapeHtml(text)}</del>`,
  };
}

// ── Layout Factories ────────────────────────────────────────────────────

export function createTextLayout(): LayoutConfig {
  return {
    newline: '\n',
    indent: (level) => '  '.repeat(level),
    join: (parts) => parts.filter(Boolean).join(' '),
  };
}

export function createMarkdownLayout(): LayoutConfig {
  return {
    newline: '\n\n',
    indent: (level) => {
      if (level === 0) return '';
      if (level === 1) return '  ';
      return '    ';
    },
    join: (parts) => parts.filter(Boolean).join(' '),
  };
}

export function createHtmlLayout(): LayoutConfig {
  return {
    newline: '<br>',
    indent: (level) => '&nbsp;&nbsp;'.repeat(level),
    join: (parts) => parts.filter(Boolean).join(' '),
    wrapDocument: (content) => `<div style="font-family: monospace; line-height: 1.6;">${content}</div>`,
  };
}

// ── Format Detection ────────────────────────────────────────────────────

export function shouldUseAnsi(env?: Record<string, string | undefined>, isTTY?: boolean): boolean {
  const force = env?.FORCE_COLOR;
  if (force !== undefined) return force !== '0' && force !== 'false';
  if (env?.NO_COLOR) return false;
  if (env?.TERM === 'dumb') return false;
  if (env?.CI) return false;
  if (typeof isTTY === 'boolean') return isTTY;
  return false;
}

// ── Output Context ──────────────────────────────────────────────────────

/** Resolved formatting context used by output primitives. */
export type OutputFormat = 'text' | 'ansi' | 'json' | 'markdown' | 'html';

export type OutputContext = {
  format: OutputFormat;
  styler: Styler;
  layout: LayoutConfig;
  terminalWidth?: number;
};

/** Resolve the output format from the runtime and caller context. */
export function resolveOutputFormat(
  runtime: {
    format?: string;
    theme?: ColorTheme | ColorConfig;
    terminal?: { columns?: number; isTTY?: boolean };
    env: () => Record<string, string | undefined>;
  },
  caller?: PadroneActionContext['caller'],
): OutputContext {
  let format: OutputFormat;

  if (caller === 'serve' || caller === 'mcp' || caller === 'tool') {
    format = 'json';
  } else if (runtime.format && runtime.format !== 'auto' && runtime.format !== 'console') {
    format = runtime.format as OutputFormat;
  } else {
    format = shouldUseAnsi(runtime.env(), runtime.terminal?.isTTY) ? 'ansi' : 'text';
  }

  const terminalWidth = format === 'markdown' || format === 'html' ? undefined : (runtime.terminal?.columns ?? DEFAULT_TERMINAL_WIDTH);

  let styler: Styler;
  let layout: LayoutConfig;

  switch (format) {
    case 'ansi':
      styler = createAnsiStyler(runtime.theme);
      layout = createTextLayout();
      break;
    case 'markdown':
      styler = createMarkdownStyler();
      layout = createMarkdownLayout();
      break;
    case 'html':
      styler = createHtmlStyler();
      layout = createHtmlLayout();
      break;
    default:
      styler = createTextStyler();
      layout = createTextLayout();
      break;
  }

  return { format, styler, layout, terminalWidth };
}
