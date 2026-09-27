import type { InteractivePromptConfig, PadroneRuntime } from '../core/runtime.ts';
import type { AnyPadroneCommand, PadroneCommandResult } from '../types/index.ts';

/**
 * Result from a single command execution in test mode.
 * Extends the standard PadroneCommandResult with captured I/O.
 */
export type TestCliResult = {
  /** The matched command. */
  command: AnyPadroneCommand;
  /** Validated arguments (undefined if validation failed). */
  args: unknown;
  /** Action handler return value (undefined if validation failed or no action). */
  result: unknown;
  /** Validation issues, if any. */
  issues: { message: string; path?: PropertyKey[] }[] | undefined;
  /** All values passed to `runtime.output()`. */
  stdout: unknown[];
  /** All strings passed to `runtime.error()`. */
  stderr: string[];
  /** The thrown error, if the command threw (routing error, action error, etc.). */
  error?: unknown;
};

/**
 * Result from a REPL test session.
 */
export type TestReplResult = {
  /** One entry per successfully executed command (validation errors are captured in stderr, not here). */
  results: Omit<TestCliResult, 'stdout' | 'stderr'>[];
  /** All output from the entire REPL session. */
  stdout: unknown[];
  /** All errors from the entire REPL session. */
  stderr: string[];
};

/**
 * Fluent builder for setting up CLI test scenarios.
 */
export type TestCliBuilder = {
  /** Set the CLI input string (e.g. `'deploy --env production'`). */
  args(input: string): TestCliBuilder;
  /** Set environment variables visible to the command. */
  env(vars: Record<string, string | undefined>): TestCliBuilder;
  /**
   * Provide mock answers for interactive prompts. Keys are field names, and prompt names for `ctx.prompt` (a `group()` step's key,
   * its `name`, else its message). `PROMPT_CANCEL` as an answer cancels that prompt.
   */
  prompt(answers: Record<string, unknown>): TestCliBuilder;
  /** Provide mock stdin data (simulates piped input). */
  stdin(data: string): TestCliBuilder;
  /** The context commands receive (`ctx.context`), as passed to `cli()` / `eval()`. */
  context(value: unknown): TestCliBuilder;
  /**
   * Execute a single command via `eval()` and return the result with captured I/O.
   * @param input - Optional CLI input string. Overrides `.args()` if provided.
   */
  run(input?: string): Promise<TestCliResult>;
  /**
   * Run a REPL session with the given sequence of inputs.
   * Each string in the array is fed as one line of input.
   * The session ends after all inputs are consumed (EOF).
   */
  repl(inputs: string[]): Promise<TestReplResult>;
};

/**
 * Creates a fluent test builder for a Padrone program.
 * Captures all I/O and provides a clean interface for assertions.
 *
 * Works with any test framework (bun:test, vitest, jest, node:test, etc.).
 *
 * @example
 * ```ts
 * import { testCli } from 'padrone/test'
 *
 * const result = await testCli(myProgram)
 *   .args('deploy --env production')
 *   .env({ API_KEY: 'xxx' })
 *   .run()
 *
 * expect(result.result).toBe('Deployed')
 * expect(result.stdout).toContain('Deploying...')
 * ```
 *
 * @example
 * ```ts
 * // Shorthand: pass input directly to run()
 * const result = await testCli(myProgram).run('deploy --env production')
 * ```
 *
 * @example
 * ```ts
 * // Test interactive prompts
 * const result = await testCli(myProgram)
 *   .args('init')
 *   .prompt({ name: 'myapp', template: 'react' })
 *   .run()
 *
 * expect(result.args).toEqual({ name: 'myapp', template: 'react' })
 * ```
 *
 * @example
 * ```ts
 * // Test REPL sessions
 * const { results } = await testCli(myProgram)
 *   .repl(['greet World', 'add --a=2 --b=3'])
 *
 * expect(results[0].result).toBe('Hello, World!')
 * expect(results[1].result).toBe(5)
 * ```
 */
/**
 * Any program-like object that has `eval`, `runtime`, and `repl` methods.
 * Avoids strict variance issues with `AnyPadroneProgram`.
 */
type TestableProgram = {
  eval: (input: string, prefs?: any) => any;
  runtime: (runtime: PadroneRuntime) => TestableProgram;
  repl: (options?: any) => AsyncIterable<any>;
};

export function testCli(program: TestableProgram): TestCliBuilder {
  let input: string | undefined;
  let envVars: Record<string, string | undefined> | undefined;
  let promptAnswers: Record<string, unknown> | undefined;
  let stdinData: string | undefined;
  let context: unknown;

  const builder: TestCliBuilder = {
    args(args: string) {
      input = args;
      return builder;
    },
    env(vars) {
      envVars = vars;
      return builder;
    },
    prompt(answers) {
      promptAnswers = answers;
      return builder;
    },
    stdin(data: string) {
      stdinData = data;
      return builder;
    },
    context(value) {
      context = value;
      return builder;
    },

    async run(runInput?: string) {
      const stdout: unknown[] = [];
      const stderr: string[] = [];

      const runtime = buildRuntime(stdout, stderr, { envVars, promptAnswers, stdinData });
      const testProgram = program.runtime(runtime);

      const evalResult = await testProgram.eval(runInput ?? input ?? '', context === undefined ? {} : { context });
      if (evalResult.error) {
        stderr.push(evalResult.error instanceof Error ? evalResult.error.message : String(evalResult.error));
      }
      return toTestResult(evalResult, stdout, stderr);
    },

    async repl(inputs: string[]) {
      const stdout: unknown[] = [];
      const stderr: string[] = [];

      const runtime = buildRuntime(stdout, stderr, {
        envVars,
        promptAnswers,
        readLine: createMockReadLine(inputs),
      });

      const testProgram = program.runtime(runtime);
      const results: Omit<TestCliResult, 'stdout' | 'stderr'>[] = [];

      for await (const r of testProgram.repl({ greeting: false, hint: false, ...(context !== undefined && { context }) })) {
        results.push({
          command: r.command!,
          args: r.args,
          result: r.result,
          issues: r.argsResult?.issues as TestCliResult['issues'],
        });
      }

      return { results, stdout, stderr };
    },
  };

  return builder;
}

function toTestResult(evalResult: PadroneCommandResult, stdout: unknown[], stderr: string[]): TestCliResult {
  return {
    command: evalResult.command!,
    args: evalResult.args,
    result: evalResult.result,
    error: evalResult.error,
    issues: evalResult.argsResult?.issues as TestCliResult['issues'],
    stdout,
    stderr,
  };
}

function buildRuntime(
  stdout: unknown[],
  stderr: string[],
  opts: {
    envVars?: Record<string, string | undefined>;
    promptAnswers?: Record<string, unknown>;
    readLine?: (prompt: string) => Promise<string | null>;
    stdinData?: string;
  },
): PadroneRuntime {
  const runtime: PadroneRuntime = {
    output: (...args: unknown[]) => stdout.push(...args),
    error: (text: string) => stderr.push(text),
  };

  if (opts.envVars) {
    runtime.env = () => opts.envVars!;
  }

  if (opts.promptAnswers) {
    runtime.interactive = 'supported';
    runtime.prompt = async (config: InteractivePromptConfig) => opts.promptAnswers![config.name];
  }

  if (opts.readLine) {
    runtime.readLine = opts.readLine;
  }

  if (opts.stdinData !== undefined) {
    runtime.stdin = {
      isTTY: false,
      async text() {
        return opts.stdinData!;
      },
      async *lines() {
        const lines = opts.stdinData!.split('\n');
        // Remove trailing empty line from final newline (matches readline behavior)
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        for (const line of lines) {
          yield line;
        }
      },
    };
  } else {
    // No stdin data: simulate a TTY (no piped input) to avoid reading from process.stdin
    runtime.stdin = {
      isTTY: true,
      async text() {
        return '';
      },
      async *lines() {
        // no lines
      },
    };
  }

  return runtime;
}

function createMockReadLine(inputs: string[]): (prompt: string) => Promise<string | null> {
  let index = 0;
  return async (_prompt: string): Promise<string | null> => {
    if (index >= inputs.length) return null;
    return inputs[index++] ?? null;
  };
}
