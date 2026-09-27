import { describe, expect, it } from 'bun:test';
import type { PadroneLogger, PadroneLoggerConfig, PadroneProgressRenderer } from 'padrone';
import {
  createPadrone,
  createTerminalProgress,
  defineInterceptor,
  padroneFormat,
  padroneJson,
  padroneLogger,
  padroneProgress,
} from 'padrone';
import { getJsonOutputFilter } from '#src/extension/utils.ts';
import { renderTable, sanitizeText } from '#src/output/primitives.ts';
import { createTextLayout, createTextStyler } from '#src/output/styling.ts';
import { compileJq, compileTemplate, JqLimitError } from '#src/util/jq.ts';

const jq = (expression: string, input: unknown = null) => compileJq(expression)(input);

const capture = () => {
  const output: unknown[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: { output: (...args: unknown[]) => output.push(...args), error: (text: string) => errors.push(text), setExitCode: () => {} },
  };
};

describe('jq: string interpolation and formats', () => {
  it('interpolates values, later interpolations varying slowest', () => {
    expect(jq('"\\(.a) and \\(.b)"', { a: 'x', b: [1] })).toEqual(['x and [1]']);
    expect(jq('"\\(1,2)-\\(3,4)"')).toEqual(['1-3', '2-3', '1-4', '2-4']);
    expect(jq('"\\("in\\("ner")")"')).toEqual(['inner']);
    expect(jq('.[] as $x | "n=\\($x)"', [1, 2])).toEqual(['n=1', 'n=2']);
    expect(jq('{"k\\(.n)": 1}', { n: 2 })).toEqual([{ k2: 1 }]);
    expect(() => compileJq('"\\(.a"')).toThrow('Unterminated');
  });

  it('applies a format to each interpolated value', () => {
    expect(jq('@sh "echo \\(.name) \\(.n)"', { name: "it's", n: 3 })).toEqual(["echo 'it'\\''s' 3"]);
    expect(jq('@uri "q=\\(.q)&x=1"', { q: 'a b&c' })).toEqual(['q=a%20b%26c&x=1']);
    expect(jq('@json "v=\\(.)"', 'x')).toEqual(['v="x"']);
    expect(jq('@base64 "plain"')).toEqual(['plain']);
  });

  it('@sh quotes strings and arrays of scalars, and rejects objects', () => {
    expect(jq('@sh', "a'b")).toEqual(["'a'\\''b'"]);
    expect(jq('@sh', [1, 'a b', null, true])).toEqual(["1 'a b' null true"]);
    expect(() => jq('@sh', { a: 1 })).toThrow('can not be escaped for shell');
    expect(() => jq('@sh', [[1]])).toThrow('can not be escaped for shell');
  });

  it('@base64d decodes UTF-8, with or without padding', () => {
    expect(jq('@base64d', 'aGk')).toEqual(['hi']);
    expect(jq('@base64 | @base64d', 'héllo ✓')).toEqual(['héllo ✓']);
    expect(() => jq('@base64d', '!!')).toThrow('is not valid base64 data');
  });
});

describe('jq: generators and paths', () => {
  it('range, limit, first and last', () => {
    expect(jq('[range(4)], [range(2; 5)], [range(5; 0; -2)], [range(0; 1; 0)]')).toEqual([[0, 1, 2, 3], [2, 3, 4], [5, 3, 1], []]);
    expect(jq('[range(0, 1; 3)]')).toEqual([[0, 1, 2, 1, 2]]);
    expect(() => jq('range("a")')).toThrow('Range bounds must be numeric');
    // Lazy: never runs the rest of the generator
    expect(jq('[limit(3; range(1e12))], first(range(10; 1e12)), [limit(0; 1, 2)], [limit(-1; 1, 2)]')).toEqual([[0, 1, 2], 10, [], [1, 2]]);
    expect(jq('last(range(5)), [first(empty)], last(empty)')).toEqual([4, [], null]);
    expect(jq('[.[] | (1, error("x"), 3)?]', [0])).toEqual([[1]]);
    expect(() => jq('error("boom")')).toThrow('boom');
  });

  it('any and all, short-circuiting', () => {
    expect(jq('map(any), map(all)', [[], [1, null], [false, true]])).toEqual([
      [false, true, true],
      [true, false, false],
    ]);
    expect(jq('any(. > 2), all(. > 0)', [1, 2, 3])).toEqual([true, true]);
    expect(jq('any(range(1e12); . == 3), all(range(1e12); . < 3)')).toEqual([true, false]);
  });

  it('type selectors and recursion', () => {
    expect(jq('[.[] | values], [.[] | nulls], [.[] | scalars]', [1, null, [2], 'a'])).toEqual([[1, [2], 'a'], [null], [1, null, 'a']]);
    expect(jq('[..]', [[1], { a: 2 }])).toEqual([[[[1], { a: 2 }], [1], 1, { a: 2 }, 2]]);
    expect(jq('[.. | numbers]', { a: [1, { b: 2 }] })).toEqual([[1, 2]]);
    expect(jq('[limit(4; recurse(. * 2))]', 1)).toEqual([[1, 2, 4, 8]]);
  });

  it('paths, getpath, setpath, delpaths and tostream', () => {
    const doc = { a: [1, { b: 2 }], c: [] };
    expect(jq('[paths]', doc)).toEqual([[['a'], ['a', 0], ['a', 1], ['a', 1, 'b'], ['c']]]);
    expect(jq('[paths(type == "number")], [leaf_paths]', doc)).toEqual([
      [
        ['a', 0],
        ['a', 1, 'b'],
      ],
      [
        ['a', 0],
        ['a', 1, 'b'],
      ],
    ]);
    expect(jq('getpath(["a", 1, "b"]), getpath(["x", "y"])', doc)).toEqual([2, null]);
    expect(jq('setpath(["a", 1, "b"]; 9) | .a[1].b', doc)).toEqual([9]);
    expect(jq('setpath(["x", 2]; 1)', null)).toEqual([{ x: [null, null, 1] }]);
    expect(() => jq('setpath(["a"]; 1)', [1])).toThrow('Cannot index array');
    expect(jq('delpaths([["a", 0], ["c"]])', doc)).toEqual([{ a: [{ b: 2 }] }]);
    expect(jq('{"a":[1,2,3]} | delpaths([["a", 0], ["a", 2]])')).toEqual([{ a: [2] }]);
    expect(jq('[tostream]', doc)).toEqual([[[['a', 0], 1], [['a', 1, 'b'], 2], [['a', 1, 'b']], [['a', 1]], [['c'], []], [['c']]]]);
    expect(jq('with_entries(select(.value > 1))', { a: 1, b: 2 })).toEqual([{ b: 2 }]);
  });
});

describe('jq: $ENV and budgets', () => {
  it('reads $ENV and env from the options, none by default', () => {
    expect(jq('$ENV, env')).toEqual([{}, {}]);
    expect(compileJq('$ENV.HOME, env.X', { env: { HOME: '/home/me', X: undefined } })(null)).toEqual(['/home/me', null]);
    expect(compileJq('. as $ENV | $ENV', { env: { A: '1' } })(2)).toEqual([2]);
  });

  it('fails runaway expressions fast, and ? or // never hide it', () => {
    const run = (expression: string) => compileJq(expression, { maxSteps: 10_000 })({ s: 'ab' });
    for (const expression of [
      '[range(1e9)]',
      '[range(1e9)]?',
      '[range(1e9)] // 1',
      '"x" * 1e9',
      '0 | [recurse(. + 1)]',
      'null | setpath([1e9]; 1)',
    ]) {
      expect(() => run(expression)).toThrow(JqLimitError);
    }
    expect(() => run('.s | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + . | . + .')).toThrow(
      'exceeded its budget of 10000 steps',
    );
    // Each run gets the whole budget
    const program = compileJq('[range(6000)] | length', { maxSteps: 10_000 });
    expect(program(null)).toEqual([6000]);
    expect(program(null)).toEqual([6000]);
    expect(compileTemplate('{{[range(1e9)]}}', { maxSteps: 100 })).toBeFunction();
    expect(() => compileTemplate('{{[range(1e9)]}}', { maxSteps: 100 })(null)).toThrow(JqLimitError);
  });
});

describe('padroneJson: jq env and limits', () => {
  /** Applies the `--jq` filter the json extension set up, as a transport for remote callers would. */
  const program = (options?: Parameters<typeof padroneJson>[0]) => {
    const seen: { lines?: string[]; error?: string } = {};
    const probe = defineInterceptor({ name: 'probe' }, () => ({
      execute(ctx, next) {
        try {
          seen.lines = getJsonOutputFilter(ctx.runtime)?.({ n: 1 });
        } catch (err) {
          seen.error = (err as Error).message;
        }
        return next();
      },
    }));
    const app = createPadrone('app')
      .extend(padroneJson(options))
      .intercept(probe)
      .command('show', (c) => c.action(() => ({ n: 1 })));
    return { app, seen };
  };
  const env = () => ({ SECRET: 's3cret' });

  it('gives local callers the runtime env, and remote callers none', async () => {
    const local = program();
    await local.app.eval(['show', '--jq', '$ENV.SECRET'], { runtime: { ...capture().runtime, env } });
    expect(local.seen.lines).toEqual(['s3cret']);

    for (const caller of ['serve', 'mcp', 'tool'] as const) {
      const remote = program();
      await remote.app.eval(['show', '--jq', '[$ENV.SECRET, env.SECRET]'], { caller, runtime: { ...capture().runtime, env } });
      expect(remote.seen.lines).toEqual(['[null,null]']);
    }
    const custom = program({ jq: (_input, _expression, { env }) => [env] });
    await custom.app.eval(['show', '--jq', '.'], { caller: 'mcp', runtime: { ...capture().runtime, env } });
    expect(custom.seen.lines).toEqual(['{}']);
  });

  it('uses jqLimits, with a lower default budget for remote callers', async () => {
    const local = program({ jqLimits: { maxSteps: 50 } });
    await local.app.eval(['show', '--jq', '[range(100)] | length'], { runtime: capture().runtime });
    expect(local.seen.error).toContain('exceeded its budget of 50 steps');

    const remote = program();
    const started = performance.now();
    await remote.app.eval(['show', '--jq', '[range(1e9)]'], { caller: 'mcp', runtime: capture().runtime });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(remote.seen.error).toBe('The expression exceeded its budget of 1000000 steps');

    const configured = program({ jqLimits: { remoteMaxSteps: 10 } });
    await configured.app.eval(['show', '--template', '{{[range(20)]}}'], { caller: 'serve', runtime: capture().runtime });
    expect(configured.seen.error).toContain('budget of 10 steps');
  });
});

describe('logger serializers and destinations', () => {
  const run = (config: PadroneLoggerConfig, fn: (logger: PadroneLogger) => void, input = 'a') => {
    const errors: string[] = [];
    createPadrone('tool')
      .extend(padroneLogger(config))
      .command('a', (c) => c.action((_args, ctx) => fn(ctx.context.logger)))
      .eval(input, { runtime: { output: () => {}, error: (text) => errors.push(text) } });
    return errors;
  };
  const json = (lines: string[]) => lines.map((line) => JSON.parse(line) as Record<string, any>);

  it('serializes fields and bindings by key, before redacting', () => {
    const serializers = { req: (req: any) => ({ method: req.method, token: req.headers.token }) };
    const lines = run({ format: 'json', serializers, redact: ['req.token'] }, (logger) => {
      const req = { method: 'GET', headers: { token: 't0k3n' }, socket: {} };
      logger.info({ req }, 'handled');
      logger.child({ req }).info('child');
    });
    expect(json(lines).map((line) => line.req)).toEqual([
      { method: 'GET', token: '[Redacted]' },
      { method: 'GET', token: '[Redacted]' },
    ]);
    const text = run({ serializers }, (logger) => logger.info({ req: { method: 'PUT', headers: {} } }));
    expect(text).toEqual(['[INFO] {"req":{"method":"PUT"}}']);
  });

  it('logs errors through the err serializer, { name, message, stack } by default', () => {
    const [plain] = json(run({ format: 'json' }, (logger) => logger.error({ cause: new TypeError('bad') }, 'failed')));
    expect(plain!.cause).toMatchObject({ name: 'TypeError', message: 'bad' });
    const err = (e: any) => ({ type: e.name, message: e.message, code: e.code });
    const lines = json(
      run({ format: 'json', serializers: { err } }, (logger) => {
        logger.error(Object.assign(new Error('boom'), { code: 'E1' }));
        logger.warn({ other: new RangeError('r') });
      }),
    );
    expect(lines[0]!.err).toEqual({ type: 'Error', message: 'boom', code: 'E1' });
    expect(lines[1]!.other).toEqual({ type: 'RangeError', message: 'r' });
  });

  it('writes to several destinations, each with its own level and format', () => {
    const file: string[] = [];
    const stream: string[] = [];
    const config: PadroneLoggerConfig = {
      destination: [
        {},
        { destination: (line) => file.push(line), level: 'debug', format: 'json' },
        { write: (chunk) => stream.push(chunk) },
      ],
    };
    const log = (logger: PadroneLogger) => {
      logger.debug('details');
      logger.info('hello');
    };
    const terminal = run(config, log);
    expect(terminal).toEqual(['[INFO] hello']);
    expect(stream).toEqual(['[INFO] hello\n']);
    expect(json(file).map((line) => [line.level, line.msg])).toEqual([
      ['debug', 'details'],
      ['info', 'hello'],
    ]);

    // `--silent` quiets the destinations that follow the logger's level; one with a level of its own keeps it
    file.length = 0;
    expect(run(config, log, 'a --silent')).toEqual([]);
    expect(file).toHaveLength(2);
  });
});

describe('sanitizing output', () => {
  const hostile =
    '\x1b[31mred\x1b[0m \x1b]0;pwned\x07title \x1b]8;;https://evil\x1b\\link\x1b]8;;\x1b\\ \x9b2Jc1 bell\x07 nul\x00 \x1bPdcs\x1b\\x';

  it('strips escape sequences and control characters, keeping tabs and line breaks', () => {
    expect(sanitizeText(hostile)).toBe('red title link c1 bell nul x');
    expect(sanitizeText('a\tb\nc\r\nd\x7f\x85')).toBe('a\tb\nc\r\nd');
    expect(sanitizeText('plain ✓ 日本')).toBe('plain ✓ 日本');
  });

  it('sanitizes table cells and headers only when asked', () => {
    const ctx = { format: 'text' as const, styler: createTextStyler(), layout: createTextLayout() };
    const data = [{ 'k\x1b[2J': '\x1b[31mred\x1b[0m\tx' }];
    expect(renderTable(data, { border: false }, ctx)).toContain('\x1b[31m');
    expect(renderTable(data, { border: false, sanitize: true }, ctx).split('\n')).toEqual(['k    ', 'red x']);
  });

  it('padroneFormat({ sanitize }) cleans yaml, csv, tsv and table values', () => {
    const program = createPadrone('app')
      .extend(padroneFormat({ sanitize: true }))
      .command('show', (c) => c.action(() => [{ name: '\x1b[31mBob\x1b[0m', note: 'a\x1b]0;x\x07b' }]));
    const lines = (format: string) => {
      const { output, runtime } = capture();
      program.eval(['show', '-o', format], { runtime });
      return output.join('\n');
    };
    for (const format of ['yaml', 'csv', 'tsv', 'table']) {
      const printed = lines(format);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for escapes
      expect(printed).not.toMatch(/[\x1b\x07]/);
      expect(printed).toContain('Bob');
    }
    expect(lines('csv')).toBe('name,note\nBob,ab');
    const raw = capture();
    createPadrone('app')
      .extend(padroneFormat())
      .command('show', (c) => c.action(() => [{ name: '\x1b[31mBob' }]))
      .eval(['show', '-o', 'csv'], { runtime: raw.runtime });
    expect(raw.output).toEqual(['name\n\x1b[31mBob']);
  });
});

describe('csvFormulaEscape', () => {
  const rows = [{ a: '=SUM(A1)', b: '+cmd', c: '-2+3', d: '@x', e: '\tt', f: -5, g: '+3.2', h: '-1e3', i: 'ok', j: '' }];
  const render = (format: string, csvFormulaEscape?: boolean) => {
    const { output, runtime } = capture();
    createPadrone('app')
      .extend(padroneFormat({ csvFormulaEscape }))
      .command('show', (c) => c.action(() => rows))
      .eval(['show', '-o', format], { runtime });
    return (output[0] as string).split('\n')[1];
  };

  it("prefixes cells that start a formula with ', leaving numbers alone", () => {
    expect(render('csv', true)).toBe("'=SUM(A1),'+cmd,'-2+3,'@x,'\tt,-5,+3.2,-1e3,ok,");
    expect(render('tsv', true)).toBe("'=SUM(A1)\t'+cmd\t'-2+3\t'@x\t'\\tt\t-5\t+3.2\t-1e3\tok\t");
  });

  it('is off by default', () => {
    expect(render('csv')).toBe('=SUM(A1),+cmd,-2+3,@x,\tt,-5,+3.2,-1e3,ok,');
  });
});

describe('progress: stopAndPersist, prefixText and suffixText', () => {
  async function withStderr(isTTY: boolean, fn: (writes: string[]) => void | Promise<void>) {
    const writes: string[] = [];
    const stderr = process.stderr as unknown as Record<string, unknown>;
    const original = { isTTY: stderr.isTTY, write: stderr.write, columns: stderr.columns };
    Object.defineProperty(stderr, 'isTTY', { value: isTTY, configurable: true, writable: true });
    Object.defineProperty(stderr, 'columns', { value: 80, configurable: true, writable: true });
    stderr.write = (chunk: string) => writes.push(String(chunk)) > 0;
    const env = { CI: process.env.CI, TERM: process.env.TERM };
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
  const finalLines = (writes: string[]) => writes.filter((w) => w.endsWith('\n'));

  for (const tty of [false, true]) {
    it(`leaves a final line with a custom symbol (${tty ? 'TTY' : 'non-TTY'})`, async () => {
      await withStderr(tty, (writes) => {
        const p = createTerminalProgress('Checking...');
        p.stopAndPersist!({ symbol: 'ℹ', text: 'Up to date' });
        p.succeed('ignored');
        const q = createTerminalProgress('Working...');
        q.stopAndPersist!();
        const r = createTerminalProgress('Plain');
        r.stopAndPersist!({ symbol: '' });
        expect(finalLines(writes)).toEqual(['ℹ Up to date\n', '  Working...\n', 'Plain\n']);
      });
    });

    it(`adds prefixText and suffixText to the line and the final line (${tty ? 'TTY' : 'non-TTY'})`, async () => {
      await withStderr(tty, (writes) => {
        const p = createTerminalProgress('Uploading', { prefixText: '[1/2]', spinner: false });
        if (tty) expect(writes.at(-1)).toBe('[1/2] Uploading');
        p.update({ suffixText: '(3 MB)' });
        if (tty) expect(writes.at(-1)).toBe('[1/2] Uploading (3 MB)');
        p.succeed('Uploaded');
        const q = createTerminalProgress('x', { prefixText: '[2/2]' });
        q.stopAndPersist!({ symbol: '→', text: 'Done', suffixText: '!' });
        expect(finalLines(writes)).toEqual(['[1/2] ✔ Uploaded (3 MB)\n', '[2/2] → Done !\n']);
      });
    });
  }

  it('offers stopAndPersist on ctx.context.progress, falling back to succeed for custom renderers', async () => {
    const calls: unknown[] = [];
    const renderer: PadroneProgressRenderer = () => ({
      update() {},
      eta: { start() {}, stop() {}, reset() {} },
      succeed: (message, options) => calls.push(['succeed', message, options?.indicator]),
      fail() {},
      stop() {},
      pause() {},
      resume() {},
    });
    await createPadrone('app')
      .command('check', (c) =>
        c
          .extend(padroneProgress({ message: 'Checking', renderer }))
          .action((_args, ctx) => ctx.context.progress.stopAndPersist({ symbol: 'ℹ', text: 'Nothing to do' })),
      )
      .eval('check', { runtime: capture().runtime });
    expect(calls[0]).toEqual(['succeed', 'Nothing to do', 'ℹ']);
  });
});
