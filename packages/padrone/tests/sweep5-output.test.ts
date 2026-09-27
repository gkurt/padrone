import { describe, expect, it } from 'bun:test';
import type { PadroneLogger, PadroneLoggerConfig, PadroneTaskState } from 'padrone';
import { createPadrone, createTerminalTaskList, padroneLogger } from 'padrone';
import { createTerminalProgress } from '#src/extension/progress-renderer.ts';
import { compileJq, JqError } from '#src/util/jq.ts';

const jq = (expression: string, input: unknown = null) => compileJq(expression)(input);

/** Records what's written to a 20-column TTY stderr (animated: not CI, not a dumb terminal). */
async function withTtyStderr(fn: (writes: string[]) => void | Promise<void>) {
  const writes: string[] = [];
  const stderr = process.stderr as unknown as Record<string, unknown>;
  const original = { isTTY: stderr.isTTY, columns: stderr.columns, write: stderr.write };
  const env = { CI: process.env.CI, TERM: process.env.TERM };
  Object.defineProperty(stderr, 'isTTY', { value: true, configurable: true, writable: true });
  Object.defineProperty(stderr, 'columns', { value: 20, configurable: true, writable: true });
  stderr.write = (chunk: string) => writes.push(String(chunk)) > 0;
  delete process.env.CI;
  delete process.env.TERM;
  try {
    await fn(writes);
  } finally {
    for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
    Object.defineProperty(stderr, 'isTTY', { value: original.isTTY, configurable: true, writable: true });
    Object.defineProperty(stderr, 'columns', { value: original.columns, configurable: true, writable: true });
    stderr.write = original.write;
  }
}

const CURSOR_UP = '\x1b[1A';
const cursorUps = (writes: string[]) => writes.join('').split(CURSOR_UP).length - 1;

describe('jq subset', () => {
  it('keeps a "__proto__" key in objects it builds, like any other key', () => {
    expect(jq('{"__proto__": 1}')).toEqual([JSON.parse('{"__proto__":1}')]);
    const [built] = jq('{(.k): .v}', { k: '__proto__', v: { a: 1 } }) as Record<string, unknown>[];
    expect(Object.keys(built!)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(built)).toBe(Object.prototype);
    expect(JSON.stringify(jq('{} * .', JSON.parse('{"__proto__":{"a":1}}')))).toBe('[{"__proto__":{"a":1}}]');
  });

  it('builds from_entries like jq: "null" for a missing key, a present null value kept, and a jq error for a non-object', () => {
    expect(jq('from_entries', [{}])).toEqual([{ null: null }]);
    expect(jq('from_entries', [{ key: 'a', value: null, v: 2 }])).toEqual([{ a: null }]);
    expect(() => jq('from_entries', [null])).toThrow(JqError);
  });

  it('floors the start and ceils the end of a fractional slice', () => {
    expect(jq('.[-1.5:]', [1, 2, 3])).toEqual([[2, 3]]);
    expect(jq('.[1.2:2.5]', [1, 2, 3, 4])).toEqual([[2, 3]]);
    expect(jq('.[1.2:2.5]', 'abcdef')).toEqual(['bc']);
  });

  it('orders strings by code point, like jq', () => {
    expect(jq('sort', ['｡', '😀'])).toEqual([['｡', '😀']]);
    expect(jq('. < "😀"', '｡')).toEqual([true]);
    expect(jq('keys', { '😀': 1, '｡': 2 })).toEqual([['｡', '😀']]);
  });

  it('reverses null into an empty array', () => {
    expect(jq('reverse', null)).toEqual([[]]);
  });
});

describe('logger redact', () => {
  const jsonLines = (config: PadroneLoggerConfig, fn: (logger: PadroneLogger) => void) => {
    const errors: string[] = [];
    createPadrone('tool')
      .extend(padroneLogger({ level: 'trace', format: 'json', ...config }))
      .command('a', (c) => c.action((_args, ctx) => fn(ctx.context.logger)))
      .eval('a', { runtime: { output: () => {}, error: (text) => errors.push(text) } });
    return errors.map((line) => JSON.parse(line) as Record<string, any>);
  };

  class User {
    constructor(
      readonly name: string,
      readonly password: string,
    ) {}
  }

  it('censors paths inside class instances, which are logged with their fields', () => {
    const user = new User('ada', 'secret');
    const [line] = jsonLines({ redact: ['user.password'] }, (logger) => logger.info({ user }, 'signed in'));
    expect(line!.user).toEqual({ name: 'ada', password: '[Redacted]' });
    expect(user.password).toBe('secret');
  });
});

describe('terminal progress', () => {
  it('clears every line of a multi-line message before redrawing', async () => {
    await withTtyStderr((writes) => {
      const progress = createTerminalProgress('one\ntwo\nthree', { spinner: false });
      writes.length = 0;
      progress.update('done');
      progress.stop();
      expect(cursorUps(writes)).toBe(2);
    });
  });

  it('counts wide characters by their display width when a line wraps', async () => {
    await withTtyStderr((writes) => {
      // 12 wide characters take 24 columns: two rows on a 20-column terminal
      const progress = createTerminalProgress('日本語日本語日本語日本語', { spinner: false });
      writes.length = 0;
      progress.update('done');
      progress.stop();
      expect(cursorUps(writes)).toBe(1);
    });
  });
});

describe('terminal task list', () => {
  const state = (title: string): PadroneTaskState => ({ title, status: 'pending', subtasks: [] });

  it('clears every line of a multi-line title before redrawing', async () => {
    await withTtyStderr((writes) => {
      const list = createTerminalTaskList([state('one\ntwo')]);
      list.update();
      writes.length = 0;
      list.update();
      const redraw = [...writes];
      list.done();
      expect(redraw[0]).toBe('\x1b[2K\r');
      expect(cursorUps(redraw)).toBe(1);
    });
  });

  it('truncates lines by display width so wide characters never wrap', async () => {
    await withTtyStderr((writes) => {
      const list = createTerminalTaskList([state('日本語日本語日本語日本語')]);
      list.update();
      const drawn = writes.at(-1)!;
      list.done();
      expect(drawn.endsWith('…')).toBe(true);
      expect(drawn.length).toBeLessThan(12);
    });
  });
});
