import { describe, expect, test } from 'bun:test';
import { Text } from 'ink';
import { createPadrone } from 'padrone';
import { padroneInk } from 'padrone/ink';
import React from 'react';

describe('padroneInk extension', () => {
  test('renders React element returned from action', async () => {
    function Greeting() {
      return React.createElement(Text, null, 'Hello from Ink!');
    }

    const program = createPadrone('test-tui')
      .extend(padroneInk({ waitUntilExit: false }))
      .command('greet', (c) => c.action(() => React.createElement(Greeting)));

    const result = await program.eval('greet');
    expect(result.result).toBeUndefined();
  });

  test('passes through non-React results unchanged', async () => {
    const program = createPadrone('test-tui')
      .extend(padroneInk({ waitUntilExit: false }))
      .command('plain', (c) => c.action(() => 'just text'));

    const result = await program.eval('plain');
    expect(result.result).toBe('just text');
  });

  test('handles async actions returning React elements', async () => {
    function Dashboard() {
      return React.createElement(Text, null, 'Dashboard');
    }

    const program = createPadrone('test-tui')
      .extend(padroneInk({ waitUntilExit: false }))
      .command('dash', (c) => c.action(async () => React.createElement(Dashboard)));

    const result = await program.eval('dash');
    expect(result.result).toBeUndefined();
  });

  test('can be applied per-command', async () => {
    function Widget() {
      return React.createElement(Text, null, 'widget');
    }

    const program = createPadrone('test-tui')
      .command('tui', (c) => c.extend(padroneInk({ waitUntilExit: false })).action(() => React.createElement(Widget)))
      .command('plain', (c) => c.action(() => 'hello'));

    const tuiResult = await program.eval('tui');
    expect(tuiResult.result).toBeUndefined();

    const plainResult = await program.eval('plain');
    expect(plainResult.result).toBe('hello');
  });

  test('returns undefined for React elements (not the raw element)', async () => {
    function Counter() {
      return React.createElement(Text, null, 'count: 0');
    }

    const program = createPadrone('test-tui')
      .extend(padroneInk({ waitUntilExit: false }))
      .command('counter', (c) => c.action(() => React.createElement(Counter)));

    const result = await program.eval('counter');
    expect(result.result).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});

describe('padroneInk for serve, MCP and tool calls', () => {
  test('returns the first frame as text instead of mounting the app', async () => {
    function Greeting() {
      return React.createElement(Text, null, 'Hello from Ink!');
    }
    const program = createPadrone('test-tui')
      .extend(padroneInk())
      .command('greet', (c) => c.action(() => React.createElement(Greeting)));

    const result = await program.eval('greet', { caller: 'mcp', runtime: { output: () => {} } });
    expect(result.result as unknown).toBe('Hello from Ink!');
  });
});
