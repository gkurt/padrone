import { escapeHtml, type OutputContext } from './styling.ts';

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
};

function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return max <= 1 ? '…' : `${text.slice(0, max - 1)}…`;
}

function padCell(text: string, width: number, alignment: 'left' | 'right' | 'center' = 'left'): string {
  const pad = width - text.length;
  if (pad <= 0) return text;
  if (alignment === 'right') return ' '.repeat(pad) + text;
  if (alignment === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
  }
  return text + ' '.repeat(pad);
}

export function renderTable(data: Record<string, unknown>[], options: TableOptions | undefined, ctx: OutputContext): string {
  if (data.length === 0) return '';
  if (ctx.format === 'json') return JSON.stringify(data, null, 2);

  const columns = options?.columns ?? Object.keys(data[0]!);
  if (columns.length === 0) return '';

  const headers = columns.map((col) => options?.headers?.[col] ?? col);
  const maxCol = options?.maxColumnWidth;

  const rows = data.map((row) =>
    columns.map((col) => {
      const text = stringifyCell(row[col]);
      return maxCol ? truncate(text, maxCol) : text;
    }),
  );

  const colWidths = columns.map((_, i) => {
    const headerWidth = headers[i]!.length;
    const maxCellWidth = rows.reduce((max, row) => Math.max(max, row[i]!.length), 0);
    return Math.max(headerWidth, maxCellWidth);
  });

  const getAlign = (i: number): 'left' | 'right' | 'center' => options?.align?.[columns[i]!] ?? 'left';

  if (ctx.format === 'markdown') return renderTableMarkdown(headers, rows, colWidths, getAlign);
  if (ctx.format === 'html') return renderTableHtml(columns, headers, rows, data, getAlign);
  return renderTableText(headers, rows, colWidths, getAlign, options?.border !== false, ctx);
}

function renderTableText(
  headers: string[],
  rows: string[][],
  colWidths: number[],
  getAlign: (i: number) => 'left' | 'right' | 'center',
  border: boolean,
  ctx: OutputContext,
): string {
  const { styler } = ctx;
  const formatRow = (cells: string[], style?: (s: string) => string) =>
    cells.map((cell, i) => {
      const padded = padCell(cell, colWidths[i]!, getAlign(i));
      return style ? style(padded) : padded;
    });

  if (border) {
    const sep = ctx.styler.meta('─');
    const divider = colWidths.map((w) => sep.repeat(w + 2)).join(styler.meta('┼'));
    const row = (cells: string[], style: (s: string) => string) =>
      formatRow(cells, style)
        .map((c) => ` ${c} `)
        .join(styler.meta('│'));
    const headerRow = row(headers, styler.label);
    const dataRows = rows.map((r) => row(r, styler.description));
    return [headerRow, divider, ...dataRows].join('\n');
  }

  const headerCells = formatRow(headers, styler.label);
  const dataCells = rows.map((r) => formatRow(r, styler.description));
  const gap = '  ';
  return [headerCells.join(gap), ...dataCells.map((r) => r.join(gap))].join('\n');
}

function renderTableMarkdown(
  headers: string[],
  rows: string[][],
  colWidths: number[],
  getAlign: (i: number) => 'left' | 'right' | 'center',
): string {
  const headerLine = `| ${headers.map((h, i) => padCell(h, colWidths[i]!, 'left')).join(' | ')} |`;
  const separatorLine =
    '| ' +
    colWidths
      .map((w, i) => {
        const a = getAlign(i);
        const dashes = '─'.repeat(Math.max(w, 3));
        if (a === 'center') return `:${dashes}:`;
        if (a === 'right') return `${dashes}:`;
        return dashes;
      })
      .join(' | ') +
    ' |';
  const dataLines = rows.map((r) => `| ${r.map((c, i) => padCell(c, colWidths[i]!, 'left')).join(' | ')} |`);
  return [headerLine, separatorLine, ...dataLines].join('\n');
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
  if (nodes.length === 0) return '';
  if (ctx.format === 'json') return JSON.stringify(nodes, null, 2);
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
  if (data.length === 0) return '';
  if (ctx.format === 'json') {
    const normalized = data.map((item) => (typeof item === 'string' ? { label: item } : item));
    return JSON.stringify(normalized, null, 2);
  }
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
  const entries = Object.entries(data);
  if (entries.length === 0) return '';
  if (ctx.format === 'json') return JSON.stringify(data, null, 2);
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
  const maxWidth = shouldAlign ? Math.max(...displayLabels.map((l) => l.length)) : 0;

  return entries
    .map(([_key, value], i) => {
      const label = displayLabels[i]!;
      const paddedLabel = shouldAlign ? label + ' '.repeat(maxWidth - label.length) : label;
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
