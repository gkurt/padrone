import type { StandardSchemaV1 } from '@standard-schema/spec';
import { ValidationError } from '../core/errors.ts';
import { formatIssueMessages } from '../core/validate.ts';
import type { PadroneSchema } from '../types/index.ts';
import { concatBytes } from '../util/stream.ts';

/**
 * Configuration for wrapping an external CLI tool.
 */
export type WrapConfig<TCommandArgs extends PadroneSchema = PadroneSchema, TWrapArgs extends PadroneSchema = TCommandArgs> = {
  /**
   * The command to execute (e.g., 'git', 'docker', 'npm').
   */
  command: string;
  /**
   * Optional fixed arguments that always precede the arguments (e.g., ['commit'] for 'git commit').
   */
  args?: string[];
  /**
   * Positional argument configuration for the external command.
   * If not provided, defaults to the wrapping command's positional configuration.
   */
  positional?: string[];
  /**
   * Whether to inherit stdio streams (stdin, stdout, stderr) from the parent process.
   * Default: true
   */
  inheritStdio?: boolean;
  /**
   * Optional schema that transforms command arguments to external CLI arguments.
   * The schema's input type should match the command arguments, and its output type defines
   * the arguments expected by the external command.
   * If not provided, command arguments are passed through as-is.
   */
  schema?: TWrapArgs | ((commandArguments: TCommandArgs) => TWrapArgs);
  /**
   * `'--'` puts the positional values after a `--`, so a value starting with `-` can't be read as an option
   * by the wrapped tool (`rm -- -file`). Defaults to `false`: positionals follow the options directly.
   */
  separator?: '--' | false;
  /** How options with a value are passed: `'separate'` (default) as `--key value`, `'equals'` as `--key=value`. */
  flagStyle?: 'separate' | 'equals';
};

/** How `wrap()` turns arguments into the wrapped command's argv (see `WrapConfig`). */
export type WrapArgvOptions = Pick<WrapConfig, 'separator' | 'flagStyle'>;

/**
 * Result from executing a wrapped CLI tool.
 */
export type WrapResult = {
  /**
   * The exit code of the process.
   */
  exitCode: number;
  /**
   * Standard output from the process (only if inheritStdio is false).
   */
  stdout?: string;
  /**
   * Standard error from the process (only if inheritStdio is false).
   */
  stderr?: string;
  /**
   * Whether the process exited successfully (exit code 0).
   */
  success: boolean;
};

/**
 * Converts parsed arguments to CLI arguments for an external command: options first (`--key value`, booleans as bare
 * flags, arrays repeated), then the positionals in order.
 */
export function argsToCliArgs(
  input: Record<string, unknown> | undefined,
  positional: readonly string[] = [],
  { separator = false, flagStyle = 'separate' }: WrapArgvOptions = {},
): string[] {
  const args: string[] = [];

  // Handle undefined or null input
  if (!input) return args;

  const positionalValues: Record<string, unknown> = {};
  const regularArguments: Record<string, unknown> = {};

  // Separate positional and regular arguments
  for (const [key, value] of Object.entries(input)) {
    if (positional.includes(key) || positional.includes(`...${key}`)) {
      positionalValues[key] = value;
    } else {
      regularArguments[key] = value;
    }
  }

  // Add regular arguments first
  for (const [key, value] of Object.entries(regularArguments)) {
    if (value === undefined || value === null) continue;

    // Use the key as-is with -- prefix
    const flag = `--${key}`;
    const option = (item: unknown) => {
      if (flagStyle === 'equals') args.push(`${flag}=${String(item)}`);
      else args.push(flag, String(item));
    };

    if (typeof value === 'boolean') {
      if (value) args.push(flag);
    } else if (Array.isArray(value)) {
      // For arrays, add the flag multiple times
      for (const item of value) option(item);
    } else {
      option(value);
    }
  }

  const positionalArgs: string[] = [];

  // Add positional arguments in the specified order
  for (const posKey of positional) {
    const isVariadic = posKey.startsWith('...');
    const key = isVariadic ? posKey.slice(3) : posKey;
    const value = positionalValues[key];

    if (value === undefined || value === null) continue;

    if (isVariadic && Array.isArray(value)) {
      positionalArgs.push(...value.map(String));
    } else {
      positionalArgs.push(String(value));
    }
  }

  if (separator && positionalArgs.length > 0) args.push(separator);
  return [...args, ...positionalArgs];
}

/**
 * Creates an action handler that wraps an external CLI tool.
 * @param config - Configuration for wrapping the external command (includes optional schema)
 * @param commandArguments - The command's arguments schema
 * @param commandPositional - Default positional config from the wrapping command
 */
export function createWrapHandler<TCommandArgs extends PadroneSchema, TWrapArgs extends PadroneSchema>(
  config: WrapConfig<TCommandArgs, TWrapArgs>,
  commandArguments: TCommandArgs,
  commandPositional?: readonly string[],
): (args: StandardSchemaV1.InferOutput<TCommandArgs>) => Promise<WrapResult> {
  return async (args: StandardSchemaV1.InferOutput<TCommandArgs>): Promise<WrapResult> => {
    const { command, args: fixedArgs = [], inheritStdio = true, positional = commandPositional, schema: wrapSchema } = config;
    const argvOptions: WrapArgvOptions = { separator: config.separator, flagStyle: config.flagStyle };

    // Get the wrap schema (handle function or direct schema)
    const schema = wrapSchema ? (typeof wrapSchema === 'function' ? wrapSchema(commandArguments) : wrapSchema) : commandArguments;

    // Transform command arguments to external CLI arguments using the wrap schema
    const validationResult = schema['~standard'].validate(args);

    const processResult = (result: StandardSchemaV1.Result<unknown>) => {
      if (result.issues) {
        throw new ValidationError(`Wrap schema validation failed:\n${formatIssueMessages(result.issues)}`, result.issues as any);
      }
      return result.value;
    };

    const externalArguments =
      validationResult instanceof Promise ? await validationResult.then(processResult) : processResult(validationResult);

    // Convert arguments to CLI arguments
    const regularArgs = argsToCliArgs(externalArguments as Record<string, unknown>, positional, argvOptions);

    // Combine fixed args and regular args
    const allArgs = [...fixedArgs, ...regularArgs];

    // Execute the external command
    const { spawn } = await import('node:child_process');

    return new Promise<WrapResult>((resolve, reject) => {
      const proc = spawn(command, allArgs, {
        stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];

      if (!inheritStdio) {
        proc.stdout!.on('data', (chunk: Uint8Array) => stdoutChunks.push(chunk));
        proc.stderr!.on('data', (chunk: Uint8Array) => stderrChunks.push(chunk));
      }

      const decoder = new TextDecoder();
      proc.on('error', reject);
      proc.on('close', (code) => {
        const exitCode = code ?? 1;
        resolve({
          exitCode,
          stdout: inheritStdio ? undefined : decoder.decode(concatBytes(stdoutChunks)),
          stderr: inheritStdio ? undefined : decoder.decode(concatBytes(stderrChunks)),
          success: exitCode === 0,
        });
      });
    });
  };
}
