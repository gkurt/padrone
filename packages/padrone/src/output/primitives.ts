import { safeJsonStringify } from '../util/json.ts';
import { escapeHtml, type OutputContext } from './styling.ts';

// ── Display width ───────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Emoji shown as emoji, and the East Asian wide and fullwidth ranges. */
const WIDE =
  /\u{fe0f}|[\p{Emoji_Presentation}\u{1100}-\u{115f}\u{2e80}-\u{303e}\u{3041}-\u{33ff}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{a000}-\u{a4cf}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter() : undefined;
const graphemes = (text: string): string[] => (segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text));
const graphemeWidth = (grapheme: string) => (WIDE.test(grapheme) ? 2 : ZERO_WIDTH.test(grapheme) ? 0 : 1);

/** The number of terminal columns `text` takes: ANSI escapes take none, wide characters and emoji two. */
export function displayWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length;
  let width = 0;
  for (const grapheme of graphemes(text.replace(ANSI_ESCAPE, ''))) width += graphemeWidth(grapheme);
  return width;
}

// ── Table ───────────────────────────────────────────────────────────────

export type TableOptions = {
  /** Explicit column keys to display (default: infer from first row's keys). */
  columns?: string[];
  /** Column key → display header name mapping. */
  headers?: Record<string, string>;
  /** Column key → text alignment. */
  align?: Record<string, 'left' | 'right' | 'center'>;
  /** Maximum column width before truncation. */
  maxColumnWidth?: number;
  /** Show borders (default: true for ansi/text, false for others). */
  border?: boolean;
  /** Show the header row in text output (default: true). */
  header?: boolean;
};

/** A cell's text: nothing for `null`/`undefined`, dates as ISO strings, objects as JSON. */
export function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (typeof value === 'object') return safeJsonStringify(value) ?? String(value);
  return String(value);
}

const cellLines = (text: string) => text.split(/\r?\n/);

const toJson = (value: unknown) => safeJsonStringify(value, 2) ?? 'null';

function truncate(text: string, max: number): string {
  if (max <= 0 || displayWidth(text) <= max) return text;
  if (max <= 1) return '…';
  let result = '';
  let width = 0;
  for (const grapheme of graphemes(text)) {
    width += graphemeWidth(grapheme);
    if (width > max - 1) break;
    result += grapheme;
  }
  return `${result}…`;
}

function padCell(text: string, width: number, alignment: 'left' | 'right' | 'center' = 'left'): string {
  const pad = width - displayWidth(text);
  if (pad <= 0) return text;
  if (alignment === 'right') return ' '.repeat(pad) + text;
  if (alignment === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
  }
  return text + ' '.repeat(pad);
}

export function renderTable(data: Record<string, unknown>[], options: TableOptions | undefined, ctx: OutputContext): string {
  if (ctx.format === 'json') return toJson(data);
  if (data.length === 0) return '';

  const columns = options?.columns ?? Object.keys(data[0]!);
  if (columns.length === 0) return '';

  const headers = columns.map((col) => options?.headers?.[col] ?? col);
  const maxCol = options?.maxColumnWidth;

  const rows = data.map((row) =>
    columns.map((col) => {
      const text = stringifyCell(row[col]);
      return maxCol
        ? cellLines(text)
            .map((line) => truncate(line, maxCol))
            .join('\n')
        : text;
    }),
  );

  const widthOf = (cell: string) => Math.max(...cellLines(cell).map(displayWidth));
  const colWidths = columns.map((_, i) => {
    const headerWidth = options?.header === false ? 0 : widthOf(headers[i]!);
    const maxCellWidth = rows.reduce((max, row) => Math.max(max, widthOf(row[i]!)), 0);
    return Math.max(headerWidth, maxCellWidth);
  });

  const getAlign = (i: number): 'left' | 'right' | 'center' => options?.align?.[columns[i]!] ?? 'left';

  if (ctx.format === 'markdown') return renderTableMarkdown(headers, rows, getAlign);
  if (ctx.format === 'html') return renderTableHtml(columns, headers, rows, data, getAlign);
  return renderTableText(headers, rows, colWidths, getAlign, options?.border !== false, options?.header !== false, ctx);
}

function renderTableText(
  headers: string[],
  rows: string[][],
  colWidths: number[],
  getAlign: (i: number) => 'left' | 'right' | 'center',
  border: boolean,
  header: boolean,
  ctx: OutputContext,
): string {
  const { styler } = ctx;
  // A row with multi-line cells takes a line per cell line, the other cells padded with blanks
  const formatRow = (cells: string[], style: (s: string) => string, join: (padded: string[]) => string) => {
    const lines = cells.map(cellLines);
    const height = Math.max(...lines.map((l) => l.length));
    return Array.from({ length: height }, (_, n) =>
      join(lines.map((cell, i) => style(padCell(cell[n] ?? '', colWidths[i]!, getAlign(i))))),
    ).join('\n');
  };

  if (border) {
    const sep = ctx.styler.meta('─');
    const divider = colWidths.map((w) => sep.repeat(w + 2)).join(styler.meta('┼'));
    const join = (padded: string[]) => padded.map((c) => ` ${c} `).join(styler.meta('│'));
    const dataRows = rows.map((r) => formatRow(r, styler.description, join));
    return (header ? [formatRow(headers, styler.label, join), divider, ...dataRows] : dataRows).join('\n');
  }

  const join = (padded: string[]) => padded.join('  ');
  const dataRows = rows.map((r) => formatRow(r, styler.description, join));
  return (header ? [formatRow(headers, styler.label, join), ...dataRows] : dataRows).join('\n');
}

const markdownCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

function renderTableMarkdown(headers: string[], rows: string[][], getAlign: (i: number) => 'left' | 'right' | 'center'): string {
  const [head, ...body] = [headers, ...rows].map((cells) => cells.map(markdownCell));
  const colWidths = head!.map((h, i) => Math.max(3, displayWidth(h), ...body.map((r) => displayWidth(r[i]!))));
  const line = (cells: string[]) => `| ${cells.map((c, i) => padCell(c, colWidths[i]!, 'left')).join(' | ')} |`;
  const delimiters = colWidths.map((w, i) => {
    const a = getAlign(i);
    if (a === 'center') return `:${'-'.repeat(w - 2)}:`;
    if (a === 'right') return `${'-'.repeat(w - 1)}:`;
    return '-'.repeat(w);
  });
  return [line(head!), `| ${delimiters.join(' | ')} |`, ...body.map(line)].join('\n');
}

function renderTableHtml(
  columns: string[],
  headers: string[],
  _rows: string[][],
  data: Record<string, unknown>[],
  getAlign: (i: number) => 'left' | 'right' | 'center',
): string {
  const ths = headers.map((h, i) => {
    const a = getAlign(i);
    const style = a !== 'left' ? ` style="text-align: ${a};"` : '';
    return `<th${style}>${escapeHtml(h)}</th>`;
  });
  const trs = data.map(
    (row) =>
      '<tr>' +
      columns
        .map((col, i) => {
          const a = getAlign(i);
          const style = a !== 'left' ? ` style="text-align: ${a};"` : '';
          return `<td${style}>${escapeHtml(stringifyCell(row[col]))}</td>`;
        })
        .join('') +
      '</tr>',
  );
  return `<table><thead><tr>${ths.join('')}</tr></thead><tbody>${trs.join('')}</tbody></table>`;
}

// ── Tree ────────────────────────────────────────────────────────────────

export type TreeNode = {
  label: string;
  children?: TreeNode[];
};

export type TreeOptions = {
  /** Characters per indent level (default: 2). */
  indent?: number;
  /** Show tree guide lines (default: true for ansi/text). */
  guides?: boolean;
};

export function renderTree(data: TreeNode | TreeNode[], options: TreeOptions | undefined, ctx: OutputContext): string {
  const nodes = Array.isArray(data) ? data : [data];
  if (ctx.format === 'json') return toJson(nodes);
  if (nodes.length === 0) return '';
  if (ctx.format === 'markdown') return renderTreeMarkdown(nodes, 0);
  if (ctx.format === 'html') return renderTreeHtml(nodes);

  const guides = options?.guides !== false;
  return renderTreeText(nodes, '', guides, ctx).join('\n');
}

function renderTreeText(nodes: TreeNode[], prefix: string, guides: boolean, ctx: OutputContext): string[] {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    if (guides) {
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      lines.push(prefix + ctx.styler.meta(connector) + ctx.styler.label(node.label));
      if (node.children?.length) lines.push(...renderTreeText(node.children, prefix + ctx.styler.meta(childPrefix), guides, ctx));
    } else {
      const indent = prefix ? `${prefix}  ` : '';
      lines.push(indent + ctx.styler.label(node.label));
      if (node.children?.length) lines.push(...renderTreeText(node.children, indent, guides, ctx));
    }
  }
  return lines;
}

function renderTreeMarkdown(nodes: TreeNode[], depth: number): string {
  return nodes
    .map((node) => {
      const indent = '  '.repeat(depth);
      const line = `${indent}- ${node.label}`;
      if (!node.children?.length) return line;
      return `${line}\n${renderTreeMarkdown(node.children, depth + 1)}`;
    })
    .join('\n');
}

function renderTreeHtml(nodes: TreeNode[]): string {
  const items = nodes
    .map((node) => {
      const label = escapeHtml(node.label);
      if (!node.children?.length) return `<li>${label}</li>`;
      return `<li>${label}${renderTreeHtml(node.children)}</li>`;
    })
    .join('');
  return `<ul>${items}</ul>`;
}

// ── List ────────────────────────────────────────────────────────────────

export type ListItem = string | { label: string; description?: string };

export type ListOptions = {
  /** Bullet character (default: '•' for ansi, '-' for text). */
  bullet?: string;
  /** Use numbered list instead of bullets. */
  numbered?: boolean;
  /** Indent level (default: 0). */
  indent?: number;
};

export function renderList(data: ListItem[], options: ListOptions | undefined, ctx: OutputContext): string {
  if (ctx.format === 'json') return toJson(data.map((item) => (typeof item === 'string' ? { label: item } : item)));
  if (data.length === 0) return '';
  if (ctx.format === 'markdown') return renderListMarkdown(data, options);
  if (ctx.format === 'html') return renderListHtml(data, options);
  return renderListText(data, options, ctx);
}

function renderListText(data: ListItem[], options: ListOptions | undefined, ctx: OutputContext): string {
  const { styler } = ctx;
  const numbered = options?.numbered ?? false;
  const bullet = options?.bullet ?? (ctx.format === 'ansi' ? '•' : '-');
  const baseIndent = '  '.repeat(options?.indent ?? 0);

  return data
    .map((item, i) => {
      const prefix = numbered ? `${i + 1}.` : bullet;
      const label = typeof item === 'string' ? item : item.label;
      const desc = typeof item === 'object' && item.description ? item.description : undefined;
      const line = `${baseIndent}${styler.meta(prefix)} ${styler.label(label)}`;
      if (!desc) return line;
      return `${line}  ${styler.description(desc)}`;
    })
    .join('\n');
}

function renderListMarkdown(data: ListItem[], options: ListOptions | undefined): string {
  const numbered = options?.numbered ?? false;
  return data
    .map((item, i) => {
      const prefix = numbered ? `${i + 1}.` : '-';
      const label = typeof item === 'string' ? item : item.label;
      const desc = typeof item === 'object' && item.description ? item.description : undefined;
      if (!desc) return `${prefix} ${label}`;
      return `${prefix} **${label}** — ${desc}`;
    })
    .join('\n');
}

function renderListHtml(data: ListItem[], options: ListOptions | undefined): string {
  const tag = options?.numbered ? 'ol' : 'ul';
  const items = data
    .map((item) => {
      const label = typeof item === 'string' ? item : item.label;
      const desc = typeof item === 'object' && item.description ? item.description : undefined;
      if (!desc) return `<li>${escapeHtml(label)}</li>`;
      return `<li><strong>${escapeHtml(label)}</strong> — ${escapeHtml(desc)}</li>`;
    })
    .join('');
  return `<${tag}>${items}</${tag}>`;
}

// ── Key-Value ───────────────────────────────────────────────────────────

export type KeyValueOptions = {
  /** Separator between key and value (default: ': '). */
  separator?: string;
  /** Align values by padding keys to the same width. */
  align?: boolean;
  /** Key → display label mapping. */
  labels?: Record<string, string>;
};

export function renderKeyValue(data: Record<string, unknown>, options: KeyValueOptions | undefined, ctx: OutputContext): string {
  if (ctx.format === 'json') return toJson(data);
  const entries = Object.entries(data);
  if (entries.length === 0) return '';
  if (ctx.format === 'markdown') return renderKeyValueMarkdown(entries, options);
  if (ctx.format === 'html') return renderKeyValueHtml(entries, options);
  return renderKeyValueText(entries, options, ctx);
}

function getLabel(key: string, labels?: Record<string, string>): string {
  return labels?.[key] ?? key;
}

function renderKeyValueText(entries: [string, unknown][], options: KeyValueOptions | undefined, ctx: OutputContext): string {
  const { styler } = ctx;
  const sep = options?.separator ?? ': ';
  const shouldAlign = options?.align !== false;

  const displayLabels = entries.map(([k]) => getLabel(k, options?.labels));
  const maxWidth = shouldAlign ? Math.max(...displayLabels.map(displayWidth)) : 0;

  return entries
    .map(([_key, value], i) => {
      const label = displayLabels[i]!;
      const paddedLabel = shouldAlign ? padCell(label, maxWidth) : label;
      return `${styler.label(paddedLabel)}${styler.meta(sep)}${styler.description(stringifyCell(value))}`;
    })
    .join('\n');
}

function renderKeyValueMarkdown(entries: [string, unknown][], options: KeyValueOptions | undefined): string {
  return entries.map(([key, value]) => `- **${getLabel(key, options?.labels)}**: ${stringifyCell(value)}`).join('\n');
}

function renderKeyValueHtml(entries: [string, unknown][], options: KeyValueOptions | undefined): string {
  const items = entries
    .map(([key, value]) => `<dt>${escapeHtml(getLabel(key, options?.labels))}</dt><dd>${escapeHtml(stringifyCell(value))}</dd>`)
    .join('');
  return `<dl>${items}</dl>`;
}
