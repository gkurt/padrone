import { describe, expect, it } from 'bun:test';
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
