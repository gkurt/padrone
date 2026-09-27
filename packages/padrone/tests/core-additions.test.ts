import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPadrone, defineEvent, defineInterceptor, type PadroneInterceptor, padroneEnv } from 'padrone';
import * as z from 'zod/v4';
import { commandSymbol, serializeArgsToFlags } from '../src/core/commands.ts';
import { createMcpHandler } from '../src/feature/mcp.ts';

const quiet = { output: () => {}, error: () => {} };
const dir = mkdtempSync(join(tmpdir(), 'padrone-core-additions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('JSON values for object options', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .command('deploy', (c) =>
      c
        .arguments(
          z.object({
            db: z.object({ host: z.string(), port: z.number().optional(), tags: z.string().array().optional() }).optional(),
            items: z.object({ name: z.string(), count: z.number().optional() }).array().optional(),
            labels: z.record(z.string(), z.string()).optional(),
            limits: z.record(z.string(), z.number()).optional(),
            tags: z.string().array().optional(),
            title: z.string().optional(),
          }),
          { fields: { db: { flags: 'd', fromFile: true }, items: { fromFile: true } } },
        )
        .action((args) => args),
    );
  const run = (input: string | string[]) => program.eval(input) as { result?: any; argsResult?: { issues?: { message: string }[] } };

  it('takes a JSON object, in every spelling', () => {
    const expected = { db: { host: 'x', port: 5432 } };
    expect(run(`deploy --db '{"host":"x","port":5432}'`).result).toEqual(expected);
    expect(run(['deploy', '--db', '{"host":"x","port":5432}']).result).toEqual(expected);
    expect(run(['deploy', '--db={"host":"x","port":5432}']).result).toEqual(expected);
    expect(run(['deploy', '-d', '{"host":"x","port":5432}']).result).toEqual(expected);
  });

  it('merges dotted keys with a JSON value, the later one winning', () => {
    expect(run(`deploy --db '{"host":"x","port":1}' --db.port 2`).result).toEqual({ db: { host: 'x', port: 2 } });
    expect(run(`deploy --db.port 2 --db.host y --db '{"host":"x"}'`).result).toEqual({ db: { host: 'x', port: 2 } });
  });

  it('takes arrays of objects as one JSON array or one object per occurrence', () => {
    const expected = { items: [{ name: 'a', count: 1 }, { name: 'b' }] };
    expect(run(`deploy --items '[{"name":"a","count":1},{"name":"b"}]'`).result).toEqual(expected);
    expect(run(['deploy', '--items={"name":"a","count":1}', '--items', '{"name":"b"}']).result).toEqual(expected);
    expect(run(['deploy', '--items=[{"name":"a","count":1},{"name":"b"}]']).result).toEqual(expected);
    expect(run(`deploy --items '{"name":"a"}'`).result).toEqual({ items: [{ name: 'a' }] });
  });

  it('takes records as JSON (keys with dots too) or dotted keys', () => {
    expect(run(`deploy --labels '{"app.kubernetes.io/name":"web"}' --labels.env prod`).result).toEqual({
      labels: { 'app.kubernetes.io/name': 'web', env: 'prod' },
    });
    expect(run('deploy --limits.cpu 2').result).toEqual({ limits: { cpu: 2 } });
  });

  it('reports invalid JSON', () => {
    const issues = run(`deploy --db '{"host":'`).argsResult?.issues ?? [];
    expect(issues.map((issue) => issue.message).join('\n')).toContain('Option "--db" has invalid JSON');
  });

  it('leaves other options alone', () => {
    expect(run(`deploy --title '{"a":1}' --tags=[a,b]`).result).toEqual({ title: '{"a":1}', tags: ['a', 'b'] });
  });

  it('reads a JSON file for a fromFile object option', () => {
    const path = join(dir, 'items.json');
    writeFileSync(path, '[\n  { "name": "a", "count": 1 }\n]\n');
    expect(run(['deploy', '--items', `@${path}`]).result).toEqual({ items: [{ name: 'a', count: 1 }] });
    const db = join(dir, 'db.json');
    writeFileSync(db, '{ "host": "x", "port": 5432 }');
    expect(run(['deploy', '--db', `@${db}`]).result).toEqual({ db: { host: 'x', port: 5432 } });
  });

  it('parses JSON from an env variable', async () => {
    const withEnv = createPadrone('app')
      .extend(padroneEnv({ prefix: 'APP' }))
      .arguments(z.object({ db: z.object({ host: z.string() }).optional() }))
      .action((args) => args);
    const result = await withEnv.eval('', { runtime: { env: () => ({ APP_DB: '{"host":"x"}' }), output: () => {} } });
    expect(result.args).toEqual({ db: { host: 'x' } });
  });
});

describe('serializeArgsToFlags with object values', () => {
  const program = createPadrone('app')
    .runtime(quiet)
    .command('deploy', (c) =>
      c
        .arguments(
          z.object({
            db: z.object({ host: z.string(), port: z.number(), tags: z.string().array().optional() }).optional(),
            items: z.object({ name: z.string(), note: z.string().optional() }).array().optional(),
            labels: z.record(z.string(), z.string()).optional(),
            empty: z.object({}).optional(),
          }),
        )
        .action((args) => args),
    );
  const command = (program as any)[commandSymbol].commands.find((c: any) => c.name === 'deploy');

  it('keeps dotted keys for flat objects and uses JSON for the rest', () => {
    expect(serializeArgsToFlags({ db: { host: 'x', port: 1 } }, command)).toEqual(['--db.host=x', '--db.port=1']);
    expect(serializeArgsToFlags({ labels: { 'a.b': 'x' } }, command)).toEqual(['--labels={"a.b":"x"}']);
    expect(serializeArgsToFlags({ db: { host: 'x', port: 1, tags: ['a'] } }, command)).toEqual(['--db={"host":"x","port":1,"tags":["a"]}']);
    expect(serializeArgsToFlags({ empty: {} }, command)).toEqual(['--empty={}']);
    expect(serializeArgsToFlags({ items: [{ name: 'a' }] }, command)).toEqual(['--items={"name":"a"}']);
  });

  const args = {
    db: { host: 'x', port: 1, tags: ['a', 'b c'] },
    items: [{ name: 'a', note: 'it\'s a "note"' }, { name: 'b' }],
    labels: { 'app.kubernetes.io/name': 'web', env: 'prod' },
    empty: {},
  };

  it('round-trips through MCP', async () => {
    const handler = createMcpHandler((program as any)[commandSymbol], program.eval.bind(program) as any);
    const res = (await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'deploy', arguments: args },
    })) as any;
    expect(res.result.isError).toBe(false);
    expect(JSON.parse(res.result.content[0].text)).toEqual(args);
  });

  it('round-trips through stringify()', () => {
    const line = program.stringify('deploy', args);
    expect(program.eval(line).result).toEqual(args);
  });
});

describe('defineInterceptor chaining', () => {
  const pinged = defineEvent('test:pinged');
  const programWith = (interceptor: PadroneInterceptor) =>
    createPadrone('app')
      .runtime(quiet)
      .intercept(interceptor)
      .action(() => 'ok');

  it('.on() returns a new interceptor and leaves the original alone', async () => {
    const calls: string[] = [];
    const base = defineInterceptor({ id: 'test:base', name: 'base', order: 5 }, () => ({}));
    const withFirst = base.on(pinged, () => void calls.push('first'));
    const withBoth = withFirst.on(pinged, () => void calls.push('second'));

    expect(withFirst).not.toBe(base);
    expect(withBoth).not.toBe(withFirst);
    expect([withBoth.id, withBoth.name, withBoth.order]).toEqual(['test:base', 'base', 5]);

    await programWith(base).emit(pinged);
    expect(calls).toEqual([]);
    await programWith(withFirst).emit(pinged);
    expect(calls).toEqual(['first']);
    await programWith(withBoth).emit(pinged);
    expect(calls).toEqual(['first', 'first', 'second']);
  });

  it('.requires() returns a new interceptor and leaves the original alone', () => {
    const base = defineInterceptor({ name: 'base' }, () => ({}));
    const needy = base.requires('test:missing');
    expect(needy).not.toBe(base);
    expect(programWith(base).eval('').result).toBe('ok');
    expect((programWith(needy).eval('').error as Error).message).toContain('requires "test:missing"');
  });

  it('keeps the phase handlers of the original', () => {
    const seen: string[] = [];
    const base = defineInterceptor({ name: 'base' }, () => ({
      execute(_ctx, next) {
        seen.push('execute');
        return next();
      },
    }));
    programWith(base.on(pinged, () => {}).requires()).eval('');
    expect(seen).toEqual(['execute']);
  });

  it("doesn't change a factory shared by two interceptors", () => {
    const factory = () => ({});
    const a = defineInterceptor({ name: 'a', order: 1 }, factory);
    const b = defineInterceptor({ name: 'b', order: 2 }, factory);
    expect([a.name, a.order, b.name, b.order]).toEqual(['a', 1, 'b', 2]);
  });
});

describe('same-id interceptors across root and command lifecycles', () => {
  const tracker = (log: string[], label: string, extra?: object) =>
    defineInterceptor({ id: 'test:dup', name: label, ...extra }, () => ({
      error(_ctx, next) {
        log.push(`${label}:error`);
        return next();
      },
      shutdown(_ctx, next) {
        log.push(`${label}:shutdown`);
        return next();
      },
    }));

  const makeProgram = (log: string[], commandInterceptor: ReturnType<typeof tracker>) =>
    createPadrone('app')
      .runtime(quiet)
      .intercept(tracker(log, 'root'))
      .command('fail', (c) =>
        c.intercept(commandInterceptor).action(() => {
          throw new Error('boom');
        }),
      )
      .command('ok', (c) => c.intercept(commandInterceptor).action(() => 'ok'))
      .command('plain', (c) =>
        c.action(() => {
          throw new Error('boom');
        }),
      );

  it('runs only the command-level one on failure and on success', () => {
    const log: string[] = [];
    const program = makeProgram(log, tracker(log, 'command'));
    program.eval('fail');
    expect(log).toEqual(['command:error', 'command:shutdown']);
    log.length = 0;
    program.eval('ok');
    expect(log).toEqual(['command:shutdown']);
  });

  it('runs the root one for commands that do not override it, and for parse errors', () => {
    const log: string[] = [];
    const program = makeProgram(log, tracker(log, 'command'));
    program.eval('plain');
    expect(log).toEqual(['root:error', 'root:shutdown']);
    log.length = 0;
    program.eval('nope');
    expect(log).toEqual(['root:error', 'root:shutdown']);
  });

  it('runs neither when the command-level one is disabled', () => {
    const log: string[] = [];
    makeProgram(log, tracker(log, 'command', { disabled: true })).eval('fail');
    expect(log).toEqual([]);
  });

  it('keeps both layers for distinct interceptors', () => {
    const log: string[] = [];
    const other = defineInterceptor({ id: 'test:other', name: 'other' }, () => ({
      error(_ctx, next) {
        log.push('other:error');
        return next();
      },
      shutdown(_ctx, next) {
        log.push('other:shutdown');
        return next();
      },
    }));
    makeProgram(log, other as any).eval('fail');
    expect(log).toEqual(['other:error', 'other:shutdown', 'root:error', 'root:shutdown']);
  });

  it('still removes the signal listener when a command replaces the signal interceptor', async () => {
    let unsubscribed = 0;
    const noSignal = defineInterceptor({ id: 'padrone:signal', name: 'no-signal', disabled: true }, () => ({}));
    const program = createPadrone('app')
      .runtime({ ...quiet, onSignal: () => () => void unsubscribed++ })
      .command('sync', (c) =>
        c.intercept(noSignal).action(() => {
          throw new Error('boom');
        }),
      )
      .command('async', (c) =>
        c.intercept(noSignal).action(async () => {
          throw new Error('boom');
        }),
      );
    program.eval('sync');
    expect(unsubscribed).toBe(1);
    await program.eval('async');
    expect(unsubscribed).toBe(2);
  });
});
