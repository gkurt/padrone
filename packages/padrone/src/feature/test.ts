import { tokenizeInput } from '../core/parse.ts';
import type { InteractivePromptConfig, PadroneRuntime } from '../core/runtime.ts';
import type { AnyPadroneCommand, PadroneCommand, PadroneCommandResult, PadroneSchema } from '../types/index.ts';
import type { GetArguments, GetResults } from '../types/result.ts';
import type { Drained, PickCommandByPossibleCommands, PossibleCommands, SafeString, WithGlobalArgs } from '../util/type-utils.ts';

/**
 * Result from a single command execution in test mode.
 * Extends the standard PadroneCommandResult with captured I/O. `TCommand` is the command the input names
 * (as `eval()` infers it), so `args` and `result` are typed.
 */
export type TestCliResult<TCommand extends AnyPadroneCommand = AnyPadroneCommand> = {
  /** The matched command. */
  command: TCommand;
  /** Validated arguments (undefined if validation failed). */
  args: TestValue<TCommand, GetArguments<'out', TCommand>>;
  /** Action handler return value, awaited and with iterables collected (undefined if validation failed or no action). */
  result: TestValue<TCommand, Drained<GetResults<TCommand>>>;
  /** Validation issues, if any. */
  issues: { message: string; path?: PropertyKey[] }[] | undefined;
  /** All values passed to `runtime.output()`. */
  stdout: unknown[];
  /** All strings passed to `runtime.error()`. */
  stderr: string[];
  /** The thrown error, if the command threw (routing error, action error, etc.). Anything can be thrown, so it's `unknown`. */
  error?: unknown;
  /**
   * The exit code `cli()` sets: `0` on success, the error's `exitCode` (else 1) on an error, `1` for validation issues,
   * or the result's `exitCode` (e.g. 130 after SIGINT, or an external command's).
   */
  exitCode: number;
};

/**
 * A value that is only there when the command ran. `unknown` where the input doesn't name one command: a string that
 * isn't a literal, or a name no command has (an interceptor, like completion or `commandNotFound`, may answer it).
 */
type TestValue<TCommand, T> = 0 extends 1 & T ? unknown : true extends IsUnion<TCommand> ? unknown : T | undefined;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

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

/** The program's root as `eval()` sees it, to pick the command an input names. */
type TestRoot<TProgram> = TProgram extends {
  '~types': {
    argsSchema: infer A extends PadroneSchema;
    globals: infer G extends PadroneSchema;
    result: infer R;
    commands: infer C extends [...AnyPadroneCommand[]];
  };
}
  ? PadroneCommand<'', '', WithGlobalArgs<A, G>, R, C>
  : AnyPadroneCommand;

/** Inputs `eval()` recognizes for the program (command paths, optionally followed by arguments). */
type TestInput<TProgram> = PossibleCommands<[TestRoot<TProgram>], true, true>;

/** The command an input names. */
type TestCommand<TProgram, TInput> = [TInput] extends [never]
  ? AnyPadroneCommand
  : [TInput] extends [TestInput<TProgram> | SafeString]
    ? PickCommandByPossibleCommands<[TestRoot<TProgram>], TInput> extends infer C extends AnyPadroneCommand
      ? // Words that reach the program itself may name no command at all (`__complete ...`, a typo)
        TInput extends ''
        ? C
        : C['~types']['name'] extends ''
          ? AnyPadroneCommand
          : C
      : AnyPadroneCommand
    : AnyPadroneCommand;

/** The context the program declares (`.context<T>()`), or anything when it declares none. */
type TestContext<TProgram> = TProgram extends { '~types': { callerContext: infer C } } ? (unknown extends C ? unknown : C) : unknown;

/**
 * Fluent builder for setting up CLI test scenarios.
 */
export type TestCliBuilder<TProgram = unknown, TArgsInput = string> = {
  /** Set the CLI input string (e.g. `'deploy --env production'`). */
  args<const TInput extends TestInput<TProgram>>(input: TInput | SafeString): TestCliBuilder<TProgram, TInput>;
  /** Set environment variables visible to the command. */
  env(vars: Record<string, string | undefined>): TestCliBuilder<TProgram, TArgsInput>;
  /**
   * Provide mock answers for interactive prompts. Keys are field names, and prompt names for `ctx.prompt` (a `group()` step's key,
   * its `name`, else its message). `PROMPT_CANCEL` as an answer cancels that prompt.
   */
  prompt(answers: Record<string, unknown>): TestCliBuilder<TProgram, TArgsInput>;
  /** Provide mock stdin data (simulates piped input). */
  stdin(data: string): TestCliBuilder<TProgram, TArgsInput>;
  /** The context commands receive (`ctx.context`), as passed to `cli()` / `eval()`: typed as the one the program declares. */
  context(value: TestContext<TProgram>): TestCliBuilder<TProgram, TArgsInput>;
  /**
   * Execute a single command via `eval()` and return the result with captured I/O.
   * @param input - Optional CLI input string. Overrides `.args()` if provided.
   */
  run<const TInput extends TestInput<TProgram> = never>(
    input?: TInput | SafeString,
  ): Promise<TestCliResult<TestCommand<TProgram, [TInput] extends [never] ? TArgsInput : TInput>>>;
  /**
   * Execute a single command the way `cli()` runs it (the `cli` caller): with `padroneConfirm()`'s question, deprecation
   * warnings and errors printed to `stderr` as a user sees them, and `exitCode` as `cli()` sets it.
   * @param input - Optional CLI input string, split like a shell would. Overrides `.args()` if provided.
   */
  cli<const TInput extends TestInput<TProgram> = never>(
    input?: TInput | SafeString,
  ): Promise<TestCliResult<TestCommand<TProgram, [TInput] extends [never] ? TArgsInput : TInput>>>;
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
  cli: (prefs?: any) => any;
  runtime: (runtime: PadroneRuntime) => TestableProgram;
  repl: (options?: any) => AsyncIterable<any>;
};

export function testCli<TProgram extends TestableProgram>(program: TProgram): TestCliBuilder<TProgram> {
  let input: string | undefined;
  let envVars: Record<string, string | undefined> | undefined;
  let promptAnswers: Record<string, unknown> | undefined;
  let stdinData: string | undefined;
  let context: unknown;

  // The input's type only narrows the result types: at runtime every builder is this one
  const builder: TestCliBuilder<any, any> = {
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

    async run(runInput?: string): Promise<any> {
      const stdout: unknown[] = [];
      const stderr: string[] = [];

      const runtime = buildRuntime(stdout, stderr, { envVars, promptAnswers, stdinData });
      const testProgram = program.runtime(runtime);

      const evalResult = await testProgram.eval(runInput ?? input ?? '', context === undefined ? {} : { context });
      if (evalResult.error) {
        stderr.push(evalResult.error instanceof Error ? evalResult.error.message : String(evalResult.error));
      }
      return toTestResult(evalResult, stdout, stderr, resultExitCode(evalResult));
    },

    async cli(runInput?: string): Promise<any> {
      const stdout: unknown[] = [];
      const stderr: string[] = [];
      let exitCode = 0;

      const runtime = buildRuntime(stdout, stderr, { envVars, promptAnswers, stdinData });
      const argv = [...tokenizeInput(runInput ?? input ?? '')];
      const testProgram = program.runtime({ ...runtime, argv: () => argv, setExitCode: (code) => (exitCode = code) });

      // cli() prints its errors itself, and sets the exit code
      const cliResult = await testProgram.cli(context === undefined ? {} : { context });
      return toTestResult(cliResult, stdout, stderr, exitCode);
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
          exitCode: resultExitCode(r),
        });
      }

      return { results, stdout, stderr };
    },
  };

  return builder;
}

/** The exit code `cli()` would set for an `eval()` result. */
function resultExitCode(result: PadroneCommandResult): number {
  if (result.exitCode !== undefined) return result.exitCode;
  if (result.error !== undefined) {
    const code = (result.error as { exitCode?: unknown } | null)?.exitCode;
    return typeof code === 'number' ? code : 1;
  }
  return result.argsResult?.issues ? 1 : 0;
}

function toTestResult(evalResult: PadroneCommandResult, stdout: unknown[], stderr: string[], exitCode: number): TestCliResult {
  return {
    exitCode,
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
