import { describe, expect, it, mock } from 'bun:test';
import { createPadrone, padroneAutoOutput } from 'padrone';
import * as z from 'zod/v4';

describe('autoOutput', () => {
  describe('disabled', () => {
    it('should not output when disabled at program level', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .extend(padroneAutoOutput({ disabled: true }))
        .command('greet', (c) => c.action(() => 'hello'));

      program.eval('greet');
      expect(output).not.toHaveBeenCalled();
    });

    it('should not output when disabled at command level', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('greet', (c) => c.extend(padroneAutoOutput({ disabled: true })).action(() => 'hello'))
        .command('other', (c) => c.action(() => 'world'));

      program.eval('greet');
      expect(output).not.toHaveBeenCalled();

      program.eval('other');
      expect(output).toHaveBeenCalledWith('world');
    });
  });

  describe('eval', () => {
    it('should output result by default', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('greet', (c) => c.action(() => 'hello'));

      program.eval('greet');
      expect(output).toHaveBeenCalledWith('hello');
    });

    it('should output number result', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('add', (c) => c.action(() => 42));

      program.eval('add');
      expect(output).toHaveBeenCalledWith(42);
    });

    it('should output object directly without stringification', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('data', (c) => c.action(() => ({ a: 1, b: 'two' })));

      program.eval('data');
      expect(output).toHaveBeenCalledWith({ a: 1, b: 'two' });
    });

    it('should not output undefined result', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('noop', (c) => c.action(() => {}));

      program.eval('noop');
      expect(output).not.toHaveBeenCalled();
    });

    it('should not output null result', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('noop', (c) => c.action(() => null));

      program.eval('noop');
      expect(output).not.toHaveBeenCalled();
    });

    it('should await and output promise result', async () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('async', (c) => c.action(() => Promise.resolve('async-result')));

      await program.eval('async');
      expect(output).toHaveBeenCalledWith('async-result');
    });

    it('should consume and output sync iterator values', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('iter', (c) =>
          c.action(function* () {
            yield 'one';
            yield 'two';
            yield 'three';
          } as any),
        );

      program.eval('iter');
      expect(output).toHaveBeenCalledTimes(3);
      expect(output.mock.calls[0]![0]).toBe('one');
      expect(output.mock.calls[1]![0]).toBe('two');
      expect(output.mock.calls[2]![0]).toBe('three');
    });

    it('should consume and output async iterator values', async () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('aiter', (c) =>
          c.action(async function* () {
            yield 'a';
            yield 'b';
          } as any),
        );

      await program.eval('aiter');
      expect(output).toHaveBeenCalledTimes(2);
      expect(output.mock.calls[0]![0]).toBe('a');
      expect(output.mock.calls[1]![0]).toBe('b');
    });

    it('should output boolean result', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('check', (c) => c.action(() => true));

      program.eval('check');
      expect(output).toHaveBeenCalledWith(true);
    });

    it('should output array directly without stringification', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output })
        .command('list', (c) => c.action(() => [1, 2, 3]));

      program.eval('list');
      expect(output).toHaveBeenCalledWith([1, 2, 3]);
    });

    it('should not output when validation fails', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output, error: () => {} })
        .command('cmd', (c) => c.arguments(z.object({ url: z.url() })).action(() => 'should not see'));

      program.eval('cmd --url not-a-url');
      expect(output).not.toHaveBeenCalled();
    });
  });

  describe('cli', () => {
    it('should output result by default', () => {
      const output = mock();
      const program = createPadrone('test')
        .runtime({ output, argv: () => ['greet'] })
        .command('greet', (c) => c.action(() => 'cli-hello'));

      program.cli();
      expect(output).toHaveBeenCalledWith('cli-hello');
    });
  });

  describe('repl', () => {
    it('should output results in REPL by default', async () => {
      const inputs = ['greet', '.exit'];
      let inputIndex = 0;
      const readLine = async () => (inputIndex < inputs.length ? inputs[inputIndex++]! : null);

      const output: unknown[] = [];
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) => c.action(() => 'repl-hello'));

      for await (const _ of program.repl({ greeting: false, hint: false })) {
        // drain
      }

      expect(output).toContain('repl-hello');
    });
  });
});

describe('cli error output', () => {
  const capture = () => {
    const errors: string[] = [];
    return { errors, runtime: { output: () => {}, error: (text: string) => errors.push(text), setExitCode: () => {} } };
  };

  it('prints errors thrown outside the execute phase', async () => {
    const { errors, runtime } = capture();
    const program = createPadrone('test')
      .intercept({ name: 'auth' }, () => ({
        route() {
          throw new Error('Not authenticated');
        },
      }))
      .command('deploy', (c) => c.action(() => 'ok'));

    await program.cli({ runtime: { ...runtime, argv: () => ['deploy'] } });
    expect(errors).toEqual(['Not authenticated']);
  });

  it('prints an error once when auto-output is also applied to the command', async () => {
    const { errors, runtime } = capture();
    const program = createPadrone('test').command('deploy', (c) =>
      c.extend(padroneAutoOutput({ output: 'json' })).action(() => {
        throw new Error('boom');
      }),
    );

    await program.cli({ runtime: { ...runtime, argv: () => ['deploy'] } });
    expect(errors).toEqual(['boom']);
  });

  it('prints validation errors when the help builtin is disabled', async () => {
    const { errors, runtime } = capture();
    const program = createPadrone('test', { builtins: { help: false } }).command('deploy', (c) =>
      c.arguments(z.object({ env: z.string() })).action(() => 'ok'),
    );

    await program.cli({ runtime: { ...runtime, argv: () => ['deploy'] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith('Validation error:');
  });
});

describe('error stack traces', () => {
  const createProgram = (options?: { errorStack?: boolean }) =>
    createPadrone('test', { builtins: { autoOutput: options ?? true } }).command('deploy', (c) =>
      c.action(() => {
        throw new Error('outer', { cause: new Error('inner') });
      }),
    );
  const run = (program: ReturnType<typeof createProgram>, env: Record<string, string> = {}) => {
    const errors: string[] = [];
    program.cli({
      runtime: { argv: () => ['deploy'], output: () => {}, error: (text) => errors.push(text), env: () => env, setExitCode: () => {} },
    });
    return errors;
  };

  it('prints only the message by default', () => {
    expect(run(createProgram())).toEqual(['outer']);
    expect(run(createProgram(), { DEBUG: '0' })).toEqual(['outer']);
  });

  it('prints the stack and cause chain with DEBUG or errorStack', () => {
    for (const errors of [run(createProgram(), { DEBUG: '1' }), run(createProgram({ errorStack: true }))]) {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toStartWith('Error: outer\n    at ');
      expect(errors[0]).toContain('Caused by: Error: inner');
    }
  });
});
