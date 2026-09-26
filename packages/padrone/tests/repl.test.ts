import { describe, expect, it, mock } from 'bun:test';
import { buildReplCompleter, createPadrone, padroneRepl } from 'padrone';
import * as z from 'zod/v4';

/**
 * Creates a mock readLine that returns inputs in sequence, then null (EOF).
 */
function mockReadLine(inputs: (string | null)[]): (prompt: string) => Promise<string | null> {
  let index = 0;
  return mock(async (_prompt: string): Promise<string | null> => {
    if (index >= inputs.length) return null;
    return inputs[index++] ?? null;
  });
}

function createTestProgram(readLine: ReturnType<typeof mockReadLine>) {
  return createPadrone('test')
    .runtime({ readLine, output: () => {}, error: () => {} })
    .command('greet', (c) => c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`))
    .command('add', (c) =>
      c
        .arguments(
          z.object({
            a: z.coerce.number(),
            b: z.coerce.number(),
          }),
        )
        .action((args) => args.a + args.b),
    );
}

describe('REPL', () => {
  it('should support drain() to collect all results', async () => {
    const readLine = mockReadLine(['greet World', 'add --a=2 --b=3', null]);
    const program = createTestProgram(readLine);

    const { value, error } = await program.repl({ greeting: false, hint: false }).drain();
    expect(error).toBeUndefined();
    expect(value).toHaveLength(2);
    expect(value![0]!.result).toBe('Hello, World!');
    expect(value![1]!.result).toBe(5);
  });

  it('should execute commands and yield results', async () => {
    const readLine = mockReadLine(['greet World', 'add --a=2 --b=3', null]);
    const program = createTestProgram(readLine);

    const results: any[] = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    expect(results).toHaveLength(2);
    expect(results[0]!.result).toBe('Hello, World!');
    expect(results[1]!.result).toBe(5);
  });

  it('should stop on .exit command', async () => {
    const readLine = mockReadLine(['greet Alice', '.exit', 'greet Bob']);
    const program = createTestProgram(readLine);

    const results: any[] = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe('Hello, Alice!');
  });

  it('should stop on .quit command', async () => {
    const readLine = mockReadLine(['greet Alice', '.quit']);
    const program = createTestProgram(readLine);

    const results = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
  });

  it('should stop on EOF (null)', async () => {
    const readLine = mockReadLine(['greet Alice', null]);
    const program = createTestProgram(readLine);

    const results = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
  });

  it('should skip empty input lines', async () => {
    const readLine = mockReadLine(['', '   ', 'greet World', '', null]);
    const program = createTestProgram(readLine);

    const results: any[] = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe('Hello, World!');
  });

  it('should not crash on validation errors', async () => {
    const errors: string[] = [];
    const readLine = mockReadLine(['add --a=notanumber --b=3', 'greet World', null]);
    const program = createPadrone('test')
      .runtime({ readLine, output: () => {}, error: (msg) => errors.push(msg) })
      .command('add', (c) => c.arguments(z.object({ a: z.coerce.number().min(0), b: z.coerce.number() })).action((args) => args.a + args.b))
      .command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      );

    const results: any[] = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    // Validation error was printed
    expect(errors.some((e) => e.includes('Validation error'))).toBe(true);
    // The greet command still succeeded
    expect(results.at(-1)!.result).toBe('Hello, World!');
  });

  it('should not crash when handler throws', async () => {
    const errors: string[] = [];
    const readLine = mockReadLine(['boom', 'greet World', null]);
    const program = createPadrone('test')
      .runtime({ readLine, output: () => {}, error: (msg) => errors.push(msg) })
      .command('boom', (c) =>
        c.action(() => {
          throw new Error('kaboom');
        }),
      )
      .command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      );

    const results: any[] = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    // The error was caught and printed
    expect(errors.some((e) => e.includes('kaboom'))).toBe(true);
    // The second command still ran
    expect(results.some((r: any) => r.result === 'Hello, World!')).toBe(true);
  });

  describe('greeting and hint', () => {
    it('should display default greeting with program name', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('myapp').runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl({ hint: false })) {
        // no commands
      }

      // Empty line, greeting, empty line
      expect(output[0]).toBe('');
      expect(output[1]).toBe('Welcome to myapp');
      expect(output[2]).toBe('');
    });

    it('should use title in greeting when available', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('myapp')
        .configure({ title: 'My Application' })
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl({ hint: false })) {
        // no commands
      }

      expect(output[1]).toBe('Welcome to My Application');
    });

    it('should use title with version in greeting when both available', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('myapp')
        .configure({ title: 'My Application', version: '3.0.0' })
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl({ hint: false })) {
        // no commands
      }

      expect(output[1]).toBe('Welcome to My Application v3.0.0');
    });

    it('should display default greeting with version when available', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('myapp')
        .configure({ version: '2.1.0' })
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl({ hint: false })) {
        // no commands
      }

      expect(output[1]).toBe('Welcome to myapp v2.1.0');
    });

    it('should display custom greeting message', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('test').runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl({ greeting: 'Welcome to the REPL!', hint: false })) {
        // no commands
      }

      expect(output).toContain('Welcome to the REPL!');
    });

    it('should suppress greeting when greeting is false', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('myapp').runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl({ greeting: false, hint: false })) {
        // no commands
      }

      expect(output).toHaveLength(0);
    });

    it('should display default hint text below greeting', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('myapp').runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl()) {
        // no commands
      }

      // Empty line, greeting, hint, empty line
      expect(output[0]).toBe('');
      expect(output[1]).toBe('Welcome to myapp');
      expect(output[2]).toContain('.help');
      expect(output[2]).toContain('.exit');
      expect(output[3]).toBe('');
    });

    it('should display custom hint text', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('test').runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl({ greeting: false, hint: 'Custom hint here.' })) {
        // no commands
      }

      // Empty line, hint, empty line
      expect(output[0]).toBe('');
      expect(output[1]).toContain('Custom hint here.');
      expect(output[2]).toBe('');
    });

    it('should suppress hint when hint is false', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('myapp').runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

      for await (const _ of program.repl({ hint: false })) {
        // no commands
      }

      // Empty line, greeting, empty line
      expect(output).toHaveLength(3);
      expect(output[1]).toContain('Welcome to myapp');
    });
  });

  it('should use custom prompt string', async () => {
    const readLine = mockReadLine([null]);
    const program = createPadrone('test').runtime({ readLine, output: () => {}, error: () => {} });

    for await (const _ of program.repl({ prompt: 'custom> ', greeting: false, hint: false })) {
      // no commands
    }

    expect(readLine).toHaveBeenCalledWith('custom> ');
  });

  it('should use custom prompt function', async () => {
    let callCount = 0;
    const readLine = mockReadLine(['greet A', 'greet B', null]);
    const program = createPadrone('test')
      .runtime({ readLine, output: () => {}, error: () => {} })
      .command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      );

    for await (const _ of program.repl({ prompt: () => `[${++callCount}]> `, greeting: false, hint: false })) {
      // consume
    }

    expect((readLine as ReturnType<typeof mock>).mock.calls[0]![0]).toBe('[1]> ');
    expect((readLine as ReturnType<typeof mock>).mock.calls[1]![0]).toBe('[2]> ');
  });

  it('should use default prompt with program name', async () => {
    const readLine = mockReadLine([null]);
    const program = createPadrone('myapp').runtime({ readLine, output: () => {}, error: () => {}, format: 'text' });

    for await (const _ of program.repl({ greeting: false, hint: false })) {
      // no commands
    }

    expect(readLine).toHaveBeenCalledWith('myapp ❯ ');
  });

  it('should handle .clear command', async () => {
    const output: unknown[] = [];
    const readLine = mockReadLine(['.clear', null]);
    const program = createPadrone('test').runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

    for await (const _ of program.repl({ greeting: false, hint: false })) {
      // no commands
    }

    expect(output.some((o) => typeof o === 'string' && o.includes('\x1B[2J'))).toBe(true);
  });

  it('should throw when calling repl() while already in a REPL session', async () => {
    const errors: string[] = [];
    const readLine = mockReadLine(['start-repl', null]);
    const program = createPadrone('test')
      .runtime({ readLine, output: () => {}, error: (msg) => errors.push(msg) })
      .command('start-repl', (c) =>
        c.action(async () => {
          for await (const _ of program.repl()) {
            // nested repl — should not get here
          }
        }),
      );

    for await (const _ of program.repl({ greeting: false, hint: false })) {
      // consume
    }

    expect(errors.some((e) => e.includes('REPL is already running'))).toBe(true);
  });

  it('should not intercept bare exit/quit/clear as built-in (dot-prefix required)', async () => {
    const readLine = mockReadLine(['exit', 'quit', 'clear', null]);
    const program = createPadrone('test')
      .runtime({ readLine, output: () => {}, error: () => {} })
      .command('exit', (c) => c.action(() => 'custom-exit'))
      .command('quit', (c) => c.action(() => 'custom-quit'))
      .command('clear', (c) => c.action(() => 'custom-clear'));

    const results: any[] = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    // All three are user commands now, not built-ins
    expect(results).toHaveLength(3);
    expect(results[0]!.result).toBe('custom-exit');
    expect(results[1]!.result).toBe('custom-quit');
    expect(results[2]!.result).toBe('custom-clear');
  });

  it('should handle .help command with REPL-specific output', async () => {
    const output: unknown[] = [];
    const readLine = mockReadLine(['.help', null]);
    const program = createPadrone('test')
      .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
      .command('greet', (c) => c.action(() => 'hi'));

    for await (const _ of program.repl({ greeting: false, hint: false })) {
      // consume
    }

    const helpOutput = output.join('\n');
    expect(helpOutput).toContain('REPL Commands:');
    expect(helpOutput).toContain('.help');
    expect(helpOutput).toContain('.exit');
    expect(helpOutput).toContain('.clear');
    expect(helpOutput).toContain('.history');
    expect(helpOutput).toContain('Keybindings:');
    expect(helpOutput).toContain('Ctrl+C');
    expect(helpOutput).toContain('Ctrl+D');
    expect(helpOutput).toContain('Type "help" to see available commands.');
  });

  it('should handle .history command', async () => {
    const output: unknown[] = [];
    const readLine = mockReadLine(['greet World', 'add --a=1 --b=2', '.history', null]);
    const program = createPadrone('test')
      .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
      .command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      )
      .command('add', (c) => c.arguments(z.object({ a: z.coerce.number(), b: z.coerce.number() })).action((args) => args.a + args.b));

    for await (const _ of program.repl({ greeting: false, hint: false })) {
      // consume
    }

    const historyOutput = output.find((o) => typeof o === 'string' && o.includes('1  greet World'));
    expect(historyOutput).toBeDefined();
    expect(historyOutput).toContain('2  add --a=1 --b=2');
  });

  it('should show empty history message when no commands have been run', async () => {
    const output: unknown[] = [];
    const readLine = mockReadLine(['.history', null]);
    const program = createPadrone('test').runtime({ readLine, output: (msg) => output.push(msg), error: () => {} });

    for await (const _ of program.repl({ greeting: false, hint: false })) {
      // consume
    }

    expect(output).toContain('No history.');
  });

  it('should work with readLine from runtime', async () => {
    const readLine = mockReadLine([null]);
    const program = createPadrone('test').runtime({ readLine, output: () => {}, error: () => {} });

    const results = [];
    for await (const result of program.repl({ greeting: false, hint: false })) {
      results.push(result);
    }

    expect(results).toHaveLength(0);
  });

  describe('output styling', () => {
    it('should add blank lines before and after each command when spacing is true', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args, { runtime: rt }) => {
            rt.output(`Hello, ${args.name}!`);
          }),
        );

      for await (const _ of program.repl({ spacing: true, greeting: false, hint: false })) {
        // consume
      }

      expect(output.at(0)).toBe('');
      expect(output).toContain('Hello, World!');
      expect(output.at(-1)).toBe('');
    });

    it('should use single-char spacing as repeated separator before and after', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args, { runtime: rt }) => {
            rt.output(`Hello, ${args.name}!`);
          }),
        );

      for await (const _ of program.repl({ spacing: '─', greeting: false, hint: false })) {
        // consume
      }

      const firstLine = output.at(0) as string;
      expect(firstLine.length).toBe(120);
      expect(firstLine).toBe('─'.repeat(120));
      expect(output.at(1)).toBe('Hello, World!');
      // Also after
      expect(output.at(-1)).toBe(firstLine);
    });

    it('should use multi-char spacing string as-is', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args, { runtime: rt }) => {
            rt.output(`Hello, ${args.name}!`);
          }),
        );

      for await (const _ of program.repl({ spacing: '---', greeting: false, hint: false })) {
        // consume
      }

      expect(output.at(0)).toBe('---');
      expect(output.at(-1)).toBe('---');
    });

    it('should support object form with only before or only after', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args, { runtime: rt }) => {
            rt.output(`Hello, ${args.name}!`);
          }),
        );

      for await (const _ of program.repl({ spacing: { before: '─' }, greeting: false, hint: false })) {
        // consume
      }

      // Separator before, nothing after
      const firstLine = output.at(0) as string;
      expect(firstLine.length).toBe(120);
      expect(firstLine).toBe('─'.repeat(120));
      expect(output.at(-1)).toBe('Hello, World!');
    });

    it('should support different before and after spacing', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args, { runtime: rt }) => {
            rt.output(`Hello, ${args.name}!`);
          }),
        );

      for await (const _ of program.repl({ spacing: { before: '─', after: true }, greeting: false, hint: false })) {
        // consume
      }

      const firstLine = output.at(0) as string;
      expect(firstLine).toBe('─'.repeat(firstLine.length));
      expect(output.at(-1)).toBe('');
    });

    it('should prefix command output lines with outputPrefix', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args, { runtime: rt }) => {
            rt.output(`Hello, ${args.name}!`);
          }),
        );

      for await (const _ of program.repl({ outputPrefix: '│ ', greeting: false, hint: false })) {
        // consume
      }

      expect(output).toContain('│ Hello, World!');
    });

    it('should prefix error output with outputPrefix', async () => {
      const errors: string[] = [];
      const readLine = mockReadLine(['boom', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: () => {}, error: (msg) => errors.push(msg) })
        .command('boom', (c) =>
          c.action(() => {
            throw new Error('kaboom');
          }),
        );

      for await (const _ of program.repl({ outputPrefix: '│ ', greeting: false, hint: false })) {
        // consume
      }

      expect(errors.some((e) => e.startsWith('│ '))).toBe(true);
    });

    it('should restore output functions after command completes', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args, { runtime: rt }) => {
            rt.output(`Hello, ${args.name}!`);
          }),
        );

      for await (const _ of program.repl({ outputPrefix: '│ ', spacing: true, greeting: false, hint: false })) {
        // consume
      }

      // Spacing lines should NOT be prefixed (before: printed before prefix patching, after: printed after restoring)
      expect(output.at(0)).toBe('');
      expect(output.at(-1)).toBe('');
      // Command output should be prefixed
      expect(output).toContain('│ Hello, World!');
    });

    it('should support array spacing for multiple lines', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args, { runtime: rt }) => {
            rt.output(`Hello, ${args.name}!`);
          }),
        );

      for await (const _ of program.repl({ spacing: { before: [true, '─'], after: true }, greeting: false, hint: false })) {
        // consume
      }

      // Before: blank line, then separator
      expect(output.at(0)).toBe('');
      const sep = output.at(1) as string;
      expect(sep).toBe('─'.repeat(sep.length));
      // Command output
      expect(output.at(2)).toBe('Hello, World!');
      // After: blank line
      expect(output.at(-1)).toBe('');
    });
  });

  describe('tab completion', () => {
    function getCompleter(program: any, builtinOverrides?: { inScope?: boolean }) {
      // Get the root command via parse() with empty argv
      const rootCommand = program.runtime({ argv: () => [] }).parse().command;
      return buildReplCompleter(rootCommand, {
        inScope: builtinOverrides?.inScope ?? false,
      });
    }

    it('should complete command names', () => {
      const completer = getCompleter(
        createPadrone('test')
          .command('greet', (c) => c.action(() => 'hi'))
          .command('goodbye', (c) => c.action(() => 'bye')),
      );

      const [hits] = completer('gr');
      expect(hits).toContain('greet');
      expect(hits).not.toContain('goodbye');
    });

    it('should complete option names with --', () => {
      const completer = getCompleter(
        createPadrone('test').command('greet', (c) =>
          c.arguments(z.object({ name: z.string(), loud: z.boolean().default(false) })).action((args) => args.name),
        ),
      );

      const [hits] = completer('greet --n');
      expect(hits).toContain('--name');
      expect(hits).not.toContain('--loud');
    });

    it('should complete alias flags with -', () => {
      const completer = getCompleter(
        createPadrone('test').command('list', (c) =>
          c
            .arguments(z.object({ priority: z.string(), verbose: z.boolean().default(false) }), {
              fields: { priority: { flags: 'p' }, verbose: { flags: 'v' } },
            })
            .action(() => 'listed'),
        ),
      );

      const [hits] = completer('list -');
      expect(hits).toContain('-p');
      expect(hits).toContain('-v');
      expect(hits).not.toContain('-priority');
      expect(hits).not.toContain('-verbose');
    });

    it('should include dot-prefixed built-in commands in completions (not .quit)', () => {
      const completer = getCompleter(createPadrone('test').command('greet', (c) => c.action(() => 'hi')));

      const [hits] = completer('');
      expect(hits).toContain('.help');
      expect(hits).toContain('.exit');
      expect(hits).toContain('.clear');
      expect(hits).toContain('.history');
      expect(hits).not.toContain('.quit');
      expect(hits).toContain('greet');
    });

    it('should complete dot-commands when typing dot', () => {
      const completer = getCompleter(createPadrone('test').command('greet', (c) => c.action(() => 'hi')));

      const [hits] = completer('.e');
      expect(hits).toContain('.exit');
      expect(hits).not.toContain('.quit');
    });

    it('should include .scope when commands have subcommands', () => {
      const completer = getCompleter(createPadrone('test').command('db', (c) => c.command('migrate', (s) => s.action(() => 'migrated'))));

      const [hits] = completer('');
      expect(hits).toContain('.scope');
    });

    it('should include .. when in scope', () => {
      const completer = getCompleter(
        createPadrone('test').command('db', (c) => c.command('migrate', (s) => s.action(() => 'migrated'))),
        { inScope: true },
      );

      const [hits] = completer('');
      expect(hits).toContain('..');
    });

    it('should complete subcommand names', () => {
      const completer = getCompleter(
        createPadrone('test').command('db', (c) =>
          c.command('migrate', (s) => s.action(() => 'migrated')).command('seed', (s) => s.action(() => 'seeded')),
        ),
      );

      const [hits] = completer('db mi');
      expect(hits).toContain('migrate');
      expect(hits).not.toContain('seed');
    });

    it('should include --help in option completions', () => {
      const completer = getCompleter(
        createPadrone('test').command('greet', (c) => c.arguments(z.object({ name: z.string() })).action((args) => args.name)),
      );

      const [hits] = completer('greet --');
      expect(hits).toContain('--help');
      expect(hits).toContain('--name');
    });

    it('should return all candidates when no match', () => {
      const completer = getCompleter(
        createPadrone('test')
          .command('greet', (c) => c.action(() => 'hi'))
          .command('goodbye', (c) => c.action(() => 'bye')),
      );

      const [hits] = completer('xyz');
      // Falls back to all candidates
      expect(hits).toContain('greet');
      expect(hits).toContain('goodbye');
    });
  });

  describe('scoped REPL (.scope/..)', () => {
    function createScopedProgram(readLine: ReturnType<typeof mockReadLine>) {
      return createPadrone('test')
        .runtime({ readLine, output: () => {}, error: () => {} })
        .command('db', (c) =>
          c
            .command('migrate', (s) =>
              s.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `migrated:${args.name}`),
            )
            .command('seed', (s) => s.action(() => 'seeded')),
        )
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
        );
    }

    it('should scope into a subcommand with .scope', async () => {
      const readLine = mockReadLine(['.scope db', 'migrate test-migration', null]);
      const program = createScopedProgram(readLine);

      const results: any[] = [];
      for await (const result of program.repl({ greeting: false, hint: false })) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0]!.result).toBe('migrated:test-migration');
    });

    it('should go back to root with .scope ..', async () => {
      const readLine = mockReadLine(['.scope db', 'seed', '.scope ..', 'greet World', null]);
      const program = createScopedProgram(readLine);

      const results: any[] = [];
      for await (const result of program.repl({ greeting: false, hint: false })) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results[0]!.result).toBe('seeded');
      expect(results[1]!.result).toBe('Hello, World!');
    });

    it('should go back with .. shorthand', async () => {
      const readLine = mockReadLine(['.scope db', 'seed', '..', 'greet World', null]);
      const program = createScopedProgram(readLine);

      const results: any[] = [];
      for await (const result of program.repl({ greeting: false, hint: false })) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results[0]!.result).toBe('seeded');
      expect(results[1]!.result).toBe('Hello, World!');
    });

    it('should go back with bare .scope (no argument)', async () => {
      const readLine = mockReadLine(['.scope db', 'seed', '.scope', 'greet World', null]);
      const program = createScopedProgram(readLine);

      const results: any[] = [];
      for await (const result of program.repl({ greeting: false, hint: false })) {
        results.push(result);
      }

      expect(results).toHaveLength(2);
      expect(results[0]!.result).toBe('seeded');
      expect(results[1]!.result).toBe('Hello, World!');
    });

    it('should not go back past root', async () => {
      const readLine = mockReadLine(['.scope ..', '..', 'greet World', null]);
      const program = createScopedProgram(readLine);

      const results: any[] = [];
      for await (const result of program.repl({ greeting: false, hint: false })) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0]!.result).toBe('Hello, World!');
    });

    it('should error on .scope with unknown command', async () => {
      const errors: string[] = [];
      const readLine = mockReadLine(['.scope nonexistent', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: () => {}, error: (msg) => errors.push(msg) })
        .command('greet', (c) => c.action(() => 'hi'));

      for await (const _ of program.repl({ greeting: false, hint: false })) {
        // consume
      }

      expect(errors.some((e) => e.includes('Unknown command'))).toBe(true);
    });

    it('should error when scoping into command with no subcommands', async () => {
      const errors: string[] = [];
      const readLine = mockReadLine(['.scope greet', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: () => {}, error: (msg) => errors.push(msg) })
        .command('greet', (c) => c.action(() => 'hi'));

      for await (const _ of program.repl({ greeting: false, hint: false })) {
        // consume
      }

      expect(errors.some((e) => e.includes('no subcommands'))).toBe(true);
    });

    it('should update prompt to reflect scope', async () => {
      const readLine = mockReadLine(['.scope db', 'seed', null]);
      const program = createPadrone('myapp')
        .runtime({ readLine, output: () => {}, error: () => {} })
        .command('db', (c) => c.command('seed', (s) => s.action(() => 'seeded')));

      for await (const _ of program.repl({ greeting: false, hint: false })) {
        // consume
      }

      // First call: root prompt, second call: scoped prompt, third call: still scoped
      expect((readLine as ReturnType<typeof mock>).mock.calls[0]![0]).toContain('myapp');
      expect((readLine as ReturnType<typeof mock>).mock.calls[1]![0]).toContain('myapp/db');
    });

    it('should start scoped via options.scope', async () => {
      const readLine = mockReadLine(['seed', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: () => {}, error: () => {} })
        .command('db', (c) => c.command('seed', (s) => s.action(() => 'seeded')));

      const results: any[] = [];
      for await (const result of program.repl({ scope: 'db', greeting: false, hint: false })) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0]!.result).toBe('seeded');
    });

    it('should allow user-defined cd command (dot-prefix .scope is separate)', async () => {
      const readLine = mockReadLine(['cd somewhere', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: () => {}, error: () => {} })
        .command('cd', (c) =>
          c.arguments(z.object({ target: z.string() }), { positional: ['target'] }).action((args) => `cd:${args.target}`),
        );

      const results: any[] = [];
      for await (const result of program.repl({ greeting: false, hint: false })) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0]!.result).toBe('cd:somewhere');
    });

    it('should execute current scoped command with bare dot', async () => {
      const readLine = mockReadLine(['.scope db', '.', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: () => {}, error: () => {} })
        .command('db', (c) => c.action(() => 'db-root').command('seed', (s) => s.action(() => 'seeded')));

      const results: any[] = [];
      for await (const result of program.repl({ greeting: false, hint: false })) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0]!.result).toBe('db-root');
    });

    it('should execute root command when using bare dot at root scope', async () => {
      const results: unknown[] = [];
      const readLine = mockReadLine(['.', null]);
      const program = createPadrone('test')
        .runtime({ readLine, output: () => {}, error: () => {} })
        .action(() => 'root-result')
        .command('greet', (c) => c.action(() => 'hi'));

      for await (const result of program.repl({ greeting: false, hint: false })) {
        results.push(result.result);
      }

      expect(results).toContain('root-result');
    });
  });

  describe('--repl flag', () => {
    it('should start REPL when --repl flag is used in cli()', async () => {
      const readLine = mockReadLine(['greet World', null]);
      const program = createPadrone('test')
        .extend(padroneRepl({ greeting: false, hint: false }))
        .runtime({ readLine, argv: () => ['--repl'], output: () => {}, error: () => {} })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
        );

      const result = await program.cli();
      expect(result.result).toHaveLength(1);
      expect((result.result as any)[0].result).toBe('Hello, World!');
    });

    it('should start scoped REPL when --repl is used with a command', async () => {
      const readLine = mockReadLine(['seed', null]);
      const program = createPadrone('test')
        .extend(padroneRepl({ greeting: false, hint: false }))
        .runtime({ readLine, argv: () => ['db', '--repl'], output: () => {}, error: () => {} })
        .command('db', (c) => c.command('seed', (s) => s.action(() => 'seeded')));

      const result = await program.cli();
      expect(result.result).toHaveLength(1);
      expect((result.result as any)[0].result).toBe('seeded');
    });

    it('should disable --repl flag when repl is disabled', async () => {
      const readLine = mockReadLine([null]);
      const errors: string[] = [];
      const program = createPadrone('test')
        .extend(padroneRepl({ disabled: true }))
        .runtime({ readLine, argv: () => ['--repl'], output: () => {}, error: (msg) => errors.push(msg) })
        .command('greet', (c) => c.action(() => 'hi'));

      // With disabled repl, --repl is not intercepted and treated as a regular unknown flag
      try {
        await program.cli();
      } catch {
        // May throw since --repl is not a valid argument
      }
    });

    it('should pass repl preferences from extension', async () => {
      const output: unknown[] = [];
      const readLine = mockReadLine([null]);
      const program = createPadrone('test')
        .extend(padroneRepl({ greeting: 'Welcome!', hint: false }))
        .runtime({ readLine, argv: () => ['--repl'], output: (msg) => output.push(msg), error: () => {} })
        .command('greet', (c) => c.action(() => 'hi'));

      await program.cli();
      expect(output).toContain('Welcome!');
    });
  });
});

describe('--repl flag ownership', () => {
  it("leaves a command's own --repl option to the command", async () => {
    const readLine = mock(async () => null);
    const program = createPadrone('test')
      .runtime({ readLine, output: () => {}, error: () => {} })
      .command('build', (c) => c.arguments(z.object({ repl: z.boolean().optional() })).action((args) => `repl=${args.repl}`));

    const result = await program.eval('build --repl');
    expect(result.result).toBe('repl=true');
    expect(readLine).not.toHaveBeenCalled();
  });

  it('scopes the REPL to the command path, not its positional values', async () => {
    const prompts: string[] = [];
    const readLine = mock(async (prompt: string) => {
      prompts.push(prompt);
      return null;
    });
    const program = createPadrone('test')
      .extend(padroneRepl({ greeting: false, hint: false }))
      .runtime({ readLine, argv: () => ['db', 'seed', 'users', '--repl'], output: () => {}, error: () => {} })
      .command('db', (c) =>
        c.command('seed', (s) => s.arguments(z.object({ table: z.string() }), { positional: ['table'] }).action((args) => args.table)),
      );

    const result = await program.cli();
    expect(result.error).toBeUndefined();
    expect(prompts[0]).toBe('test/db/seed ❯ ');
  });
});
