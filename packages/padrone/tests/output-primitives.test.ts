import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneAutoOutput } from 'padrone';
import type { PadroneOutputIndicator } from '#src/output/output-indicator.ts';
import { renderKeyValue, renderList, renderTable, renderTree } from '#src/output/primitives.ts';
import type { OutputContext } from '#src/output/styling.ts';
import { createAnsiStyler, createTextLayout, createTextStyler } from '#src/output/styling.ts';

// ── Test helpers ────────────────────────────────────────────────────────

function textCtx(width?: number): OutputContext {
  return { format: 'text', styler: createTextStyler(), layout: createTextLayout(), terminalWidth: width ?? 80 };
}

function ansiCtx(width?: number): OutputContext {
  return { format: 'ansi', styler: createAnsiStyler(), layout: createTextLayout(), terminalWidth: width ?? 80 };
}

function jsonCtx(): OutputContext {
  return { format: 'json', styler: createTextStyler(), layout: createTextLayout() };
}

function markdownCtx(): OutputContext {
  return { format: 'markdown', styler: createTextStyler(), layout: createTextLayout() };
}

function htmlCtx(): OutputContext {
  return { format: 'html', styler: createTextStyler(), layout: createTextLayout() };
}

// ── Table ───────────────────────────────────────────────────────────────

describe('renderTable', () => {
  const data = [
    { name: 'api', status: 'up', latency: '42ms' },
    { name: 'db', status: 'down', latency: '-' },
  ];

  it('renders empty data as empty string', () => {
    expect(renderTable([], undefined, textCtx())).toBe('');
  });

  it('renders text format with borders', () => {
    const result = renderTable(data, undefined, textCtx());
    expect(result).toContain('name');
    expect(result).toContain('status');
    expect(result).toContain('api');
    expect(result).toContain('db');
    expect(result).toContain('┼');
  });

  it('draws the border divider as wide as the rows', () => {
    const lines = renderTable(data, undefined, textCtx()).split('\n');
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it('aligns bordered columns when cells are colored', () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
    const ansi = /\x1b\[[0-9;]*m/g;
    const lines = renderTable(data, undefined, ansiCtx()).replace(ansi, '').split('\n');
    expect(lines[2]).toBe(' api  │ up     │ 42ms    ');
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it('renders text format without borders', () => {
    const result = renderTable(data, { border: false }, textCtx());
    expect(result).toContain('api');
    expect(result).not.toContain('┼');
  });

  it('renders JSON format as passthrough', () => {
    const result = renderTable(data, undefined, jsonCtx());
    expect(JSON.parse(result)).toEqual(data);
  });

  it('renders markdown format', () => {
    const result = renderTable(data, undefined, markdownCtx());
    expect(result).toContain('| name');
    expect(result).toContain('| ---');
    expect(result).toContain('| api');
  });

  it('renders HTML format', () => {
    const result = renderTable(data, undefined, htmlCtx());
    expect(result).toContain('<table>');
    expect(result).toContain('<th>name</th>');
    expect(result).toContain('<td>api</td>');
    expect(result).toContain('</table>');
  });

  it('respects columns option', () => {
    const result = renderTable(data, { columns: ['name', 'status'] }, textCtx());
    expect(result).toContain('name');
    expect(result).toContain('status');
    expect(result).not.toContain('latency');
  });

  it('respects headers option', () => {
    const result = renderTable(data, { headers: { name: 'Service', status: 'State' } }, textCtx());
    expect(result).toContain('Service');
    expect(result).toContain('State');
  });

  it('respects maxColumnWidth option', () => {
    const longData = [{ description: 'This is a very long description that should be truncated' }];
    const result = renderTable(longData, { maxColumnWidth: 10 }, textCtx());
    expect(result).toContain('…');
  });

  it('renders ANSI format with colors', () => {
    const result = renderTable(data, undefined, ansiCtx());
    expect(result).toContain('\x1b['); // ANSI escape codes
    expect(result).toContain('api');
  });

  it('handles right alignment', () => {
    const result = renderTable(data, { align: { latency: 'right' } }, markdownCtx());
    expect(result).toMatch(/-+:/); // right-aligned separator
  });
});

// ── Tree ────────────────────────────────────────────────────────────────

describe('renderTree', () => {
  const tree = {
    label: 'root',
    children: [{ label: 'src', children: [{ label: 'index.ts' }, { label: 'utils.ts' }] }, { label: 'package.json' }],
  };

  it('renders empty array as empty string', () => {
    expect(renderTree([], undefined, textCtx())).toBe('');
  });

  it('renders text format with guides', () => {
    const result = renderTree(tree, undefined, textCtx());
    expect(result).toContain('root');
    expect(result).toContain('├── src');
    expect(result).toContain('└── package.json');
    expect(result).toContain('index.ts');
  });

  it('renders text format without guides', () => {
    const result = renderTree(tree, { guides: false }, textCtx());
    expect(result).toContain('root');
    expect(result).toContain('src');
    expect(result).not.toContain('├');
  });

  it('renders JSON format as passthrough', () => {
    const result = renderTree(tree, undefined, jsonCtx());
    const parsed = JSON.parse(result);
    expect(parsed[0].label).toBe('root');
  });

  it('renders markdown format', () => {
    const result = renderTree(tree, undefined, markdownCtx());
    expect(result).toContain('- root');
    expect(result).toContain('  - src');
    expect(result).toContain('    - index.ts');
  });

  it('renders HTML format', () => {
    const result = renderTree(tree, undefined, htmlCtx());
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>root');
    expect(result).toContain('<li>src');
  });

  it('handles array of nodes', () => {
    const nodes = [{ label: 'a' }, { label: 'b' }];
    const result = renderTree(nodes, undefined, textCtx());
    expect(result).toContain('├── a');
    expect(result).toContain('└── b');
  });
});

// ── List ────────────────────────────────────────────────────────────────

describe('renderList', () => {
  const items = ['apples', 'bananas', 'cherries'];

  it('renders empty array as empty string', () => {
    expect(renderList([], undefined, textCtx())).toBe('');
  });

  it('renders text format with bullets', () => {
    const result = renderList(items, undefined, textCtx());
    expect(result).toContain('- apples');
    expect(result).toContain('- bananas');
  });

  it('renders ANSI format with bullet character', () => {
    const result = renderList(items, undefined, ansiCtx());
    expect(result).toContain('•');
  });

  it('renders numbered list', () => {
    const result = renderList(items, { numbered: true }, textCtx());
    expect(result).toContain('1.');
    expect(result).toContain('2.');
    expect(result).toContain('3.');
  });

  it('renders items with descriptions', () => {
    const itemsWithDesc = [
      { label: 'apples', description: 'red fruit' },
      { label: 'bananas', description: 'yellow fruit' },
    ];
    const result = renderList(itemsWithDesc, undefined, textCtx());
    expect(result).toContain('apples');
    expect(result).toContain('red fruit');
  });

  it('renders JSON format', () => {
    const result = renderList(items, undefined, jsonCtx());
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].label).toBe('apples');
  });

  it('renders markdown format', () => {
    const result = renderList(items, undefined, markdownCtx());
    expect(result).toContain('- apples');
  });

  it('renders markdown numbered list', () => {
    const result = renderList(items, { numbered: true }, markdownCtx());
    expect(result).toContain('1. apples');
  });

  it('renders HTML format', () => {
    const result = renderList(items, undefined, htmlCtx());
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>apples</li>');
  });

  it('renders HTML ordered list', () => {
    const result = renderList(items, { numbered: true }, htmlCtx());
    expect(result).toContain('<ol>');
  });
});

// ── Key-Value ───────────────────────────────────────────────────────────

describe('renderKeyValue', () => {
  const data = { version: '1.2.3', uptime: '4h 23m', status: 'healthy' };

  it('renders empty object as empty string', () => {
    expect(renderKeyValue({}, undefined, textCtx())).toBe('');
  });

  it('renders text format with aligned keys', () => {
    const result = renderKeyValue(data, undefined, textCtx());
    expect(result).toContain('version');
    expect(result).toContain('1.2.3');
    expect(result).toContain('uptime');
    expect(result).toContain('status');
  });

  it('renders with custom separator', () => {
    const result = renderKeyValue(data, { separator: ' = ' }, textCtx());
    expect(result).toContain(' = ');
  });

  it('renders with custom labels', () => {
    const result = renderKeyValue(data, { labels: { version: 'Version', uptime: 'Uptime' } }, textCtx());
    expect(result).toContain('Version');
    expect(result).toContain('Uptime');
  });

  it('renders JSON format as passthrough', () => {
    const result = renderKeyValue(data, undefined, jsonCtx());
    expect(JSON.parse(result)).toEqual(data);
  });

  it('renders markdown format', () => {
    const result = renderKeyValue(data, undefined, markdownCtx());
    expect(result).toContain('- **version**: 1.2.3');
  });

  it('renders HTML format', () => {
    const result = renderKeyValue(data, undefined, htmlCtx());
    expect(result).toContain('<dl>');
    expect(result).toContain('<dt>version</dt>');
    expect(result).toContain('<dd>1.2.3</dd>');
  });

  it('handles non-string values', () => {
    const mixed = { count: 42, active: true, config: { nested: 'value' } };
    const result = renderKeyValue(mixed, undefined, textCtx());
    expect(result).toContain('42');
    expect(result).toContain('true');
    expect(result).toContain('{"nested":"value"}');
  });
});

// ── Integration: auto-output with output indicator ──────────────────────

describe('output indicator — integration', () => {
  it('action receives output indicator in context', () => {
    let hasOutput = false;

    const program = createPadrone('test').command('cmd', (c) =>
      c.action((_args, ctx) => {
        hasOutput = (ctx.context as { output: PadroneOutputIndicator }).output !== undefined;
        return 'ok';
      }),
    );

    program.eval('cmd');
    expect(hasOutput).toBe(true);
  });

  it('imperative output.table() suppresses auto-output', () => {
    const outputs: unknown[] = [];

    const program = createPadrone('test')
      .runtime({ output: (...args: unknown[]) => outputs.push(...args) })
      .command('cmd', (c) =>
        c.action((_args, ctx) => {
          (ctx.context as { output: PadroneOutputIndicator }).output.table([{ a: 1 }]);
          return [{ a: 1 }]; // should NOT be auto-output
        }),
      );

    program.eval('cmd');
    // Only one output: the table rendering, not the raw return value
    expect(outputs).toHaveLength(1);
    expect(typeof outputs[0]).toBe('string');
    expect(outputs[0]).toContain('a');
  });

  it('auto-output still works when output.* is not called', () => {
    const outputs: unknown[] = [];

    const program = createPadrone('test')
      .runtime({ output: (...args: unknown[]) => outputs.push(...args) })
      .command('cmd', (c) => c.action(() => 'hello'));

    program.eval('cmd');
    expect(outputs).toEqual(['hello']);
  });

  it('declarative output config formats return value', () => {
    const outputs: unknown[] = [];

    const program = createPadrone('test')
      .runtime({ output: (...args: unknown[]) => outputs.push(...args) })
      .command('cmd', (c) =>
        c.extend(padroneAutoOutput({ output: 'table' })).action(() => [
          { name: 'api', status: 'up' },
          { name: 'db', status: 'down' },
        ]),
      );

    program.eval('cmd');
    expect(outputs).toHaveLength(1);
    expect(typeof outputs[0]).toBe('string');
    expect(outputs[0]).toContain('api');
    expect(outputs[0]).toContain('db');
  });

  it('declarative kv output config formats return value', () => {
    const outputs: unknown[] = [];

    const program = createPadrone('test')
      .runtime({ output: (...args: unknown[]) => outputs.push(...args) })
      .command('cmd', (c) => c.extend(padroneAutoOutput({ output: 'kv' })).action(() => ({ version: '1.0', status: 'ok' })));

    program.eval('cmd');
    expect(outputs).toHaveLength(1);
    expect(typeof outputs[0]).toBe('string');
    expect(outputs[0]).toContain('version');
    expect(outputs[0]).toContain('1.0');
  });

  it('eval() returns clean data even when output.table() is called', () => {
    const data = [{ x: 1 }, { x: 2 }];

    const program = createPadrone('test')
      .runtime({ output: () => {} })
      .command('cmd', (c) =>
        c.action((_args, ctx) => {
          (ctx.context as { output: PadroneOutputIndicator }).output.table(data);
          return data;
        }),
      );

    const result = program.eval('cmd');
    expect(result.result).toEqual(data);
  });

  it('declarative json output config formats return value as JSON', () => {
    const outputs: unknown[] = [];

    const program = createPadrone('test')
      .runtime({ output: (...args: unknown[]) => outputs.push(...args) })
      .command('cmd', (c) => c.extend(padroneAutoOutput({ output: 'json' })).action(() => ({ hello: 'world' })));

    program.eval('cmd');
    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0] as string)).toEqual({ hello: 'world' });
  });
});
