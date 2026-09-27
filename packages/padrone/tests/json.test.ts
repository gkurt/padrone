import { describe, expect, it } from 'bun:test';
import type { InterceptorErrorResult } from 'padrone';
import { createPadrone, padroneJson } from 'padrone';
import * as z from 'zod/v4';

const capture = () => {
  const output: unknown[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: { output: (...args: unknown[]) => output.push(...args), error: (text: string) => errors.push(text), setExitCode: () => {} },
  };
};

const program = createPadrone('app')
  .extend(padroneJson())
  .command('user', (c) =>
    c.arguments(z.object({ id: z.coerce.number() }), { positional: ['id'] }).action((args) => ({ id: args.id, big: 1n })),
  )
  .command('greet', (c) => c.action(() => 'hello'))
  .command('stream', (c) =>
    c.action(function* () {
      yield { n: 1 };
      yield { n: 2 };
    }),
  )
  .command('fail', (c) =>
    c.action(() => {
      throw new Error('boom');
    }),
  );

describe('padroneJson', () => {
  it('prints the result as JSON with --json', () => {
    const { output, runtime } = capture();
    const result = program.eval('user 7 --json', { runtime });
    expect(result.result).toEqual({ id: 7, big: 1n });
    expect(output).toEqual([JSON.stringify({ id: 7, big: '1' }, null, 2)]);
  });

  it('prints strings as JSON strings, and iterator items one per line', () => {
    const { output, runtime } = capture();
    program.eval('greet --json', { runtime });
    program.eval('stream --json', { runtime });
    expect(output).toEqual(['"hello"', '{"n":1}', '{"n":2}']);
  });

  it('prints raw output without the flag', () => {
    const { output, runtime } = capture();
    program.eval('greet', { runtime });
    expect(output).toEqual(['hello']);
  });

  it('prints errors as JSON in cli()', () => {
    const { output, errors, runtime } = capture();
    program.cli({ runtime: { ...runtime, argv: () => ['fail', '--json'] } });
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0] as string)).toEqual({ error: { name: 'Error', message: 'boom' } });
  });

  it('prints validation issues and routing errors as JSON', () => {
    const validation = capture();
    program.cli({ runtime: { ...validation.runtime, argv: () => ['user', 'abc', '--json'] } });
    const { error } = JSON.parse(validation.output[0] as string);
    expect(error.name).toBe('ValidationError');
    expect(error.issues[0].path).toEqual(['id']);
    expect(validation.errors).toEqual([]);

    const routing = capture();
    program.cli({ runtime: { ...routing.runtime, argv: () => ['nope', '--json'] } });
    expect(JSON.parse(routing.output[0] as string).error.name).toBe('RoutingError');
    expect(routing.errors).toEqual([]);
  });

  it('works when applied to a single command', () => {
    const { output, runtime } = capture();
    const scoped = createPadrone('app').command('info', (c) => c.extend(padroneJson()).action(() => ({ ok: true })));
    scoped.eval('info --json', { runtime });
    expect(output).toEqual([JSON.stringify({ ok: true }, null, 2)]);
  });

  it('lists --json among the global flags in help', () => {
    expect(program.help(undefined, { all: true, format: 'text' })).toContain('--json');
  });
});

describe('JSON errors', () => {
  it('prints the error an inner error handler replaced', () => {
    const { output, errors, runtime } = capture();
    const program = createPadrone('app')
      .extend(padroneJson())
      .intercept({ name: 'wrap', order: 0 }, () => ({
        error: (_ctx, next) => {
          const er = next() as InterceptorErrorResult;
          return { ...er, error: new Error('wrapped', { cause: er.error }) };
        },
      }))
      .command('fail', (c) =>
        c.action(() => {
          throw new Error('boom');
        }),
      );
    program.cli({ runtime: { ...runtime, argv: () => ['fail', '--json'] } });
    expect(errors).toEqual([]);
    expect(output.map((line) => JSON.parse(line as string).error.message)).toEqual(['wrapped']);
  });

  it('prints errors as JSON under format: json without the flag', () => {
    const { output, errors, runtime } = capture();
    program.cli({ runtime: { ...runtime, format: 'json', argv: () => ['nope'] } });
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0] as string).error.name).toBe('RoutingError');
  });
});

describe('--jq and --template', () => {
  const list = createPadrone('app')
    .extend(padroneJson())
    .command('users', (c) =>
      c.action(() => [
        { id: 1, name: 'ann', admin: true },
        { id: 2, name: 'bob', admin: false },
      ]),
    )
    .command('stream', (c) =>
      c.action(function* () {
        yield { id: 1 };
        yield { id: 2 };
      }),
    );

  it('filters the result with --jq, printing strings raw', () => {
    const { output, runtime } = capture();
    list.eval(['users', '--jq', '.[] | select(.admin) | .name'], { runtime });
    list.eval(['users', '--jq', '.[0] | {id}'], { runtime });
    expect(output).toEqual(['ann', '{"id":1}']);
  });

  it('applies --jq to each streamed item', () => {
    const { output, runtime } = capture();
    list.eval(['stream', '--jq', '.id'], { runtime });
    expect(output).toEqual(['1', '2']);
  });

  it('formats each item with --template', () => {
    const { output, runtime } = capture();
    list.eval(['users', '--template', '{{.id}}: {{.name}}'], { runtime });
    expect(output).toEqual(['1: ann', '2: bob']);
  });

  it('rejects an invalid expression before running the command', () => {
    let ran = false;
    const program = createPadrone('app')
      .extend(padroneJson())
      .command('x', (c) =>
        c.action(() => {
          ran = true;
        }),
      );
    const { output, runtime } = capture();
    program.cli({ runtime: { ...runtime, argv: () => ['x', '--jq', '.a |'] } });
    expect(ran).toBe(false);
    expect(JSON.parse(output[0] as string).error.message).toBe('Invalid --jq: Unexpected end of expression');
  });

  it('can use a full jq implementation', () => {
    const { output, runtime } = capture();
    const program = createPadrone('app')
      .extend(padroneJson({ jq: (input, expression) => [`${expression} on ${JSON.stringify(input)}`] }))
      .command('x', (c) => c.action(() => ({ a: 1 })));
    program.eval(['x', '--jq', '.a'], { runtime });
    expect(output).toEqual(['.a on {"a":1}']);
  });
});
