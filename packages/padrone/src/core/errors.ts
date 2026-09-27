/**
 * Structured error hierarchy for Padrone CLI framework.
 *
 * All Padrone errors extend `PadroneError`, which carries an exit code,
 * optional suggestions, and context about which command/phase produced the error.
 * This allows callers to distinguish user errors (bad input) from bugs (unexpected throws)
 * and to present formatted, actionable error messages.
 */

import type { PadroneSignal } from './runtime.ts';

export type PadroneErrorOptions = {
  /** Process exit code. Defaults to 1. */
  exitCode?: number;
  /** Actionable suggestions shown to the user (e.g. "Use --env production"). */
  suggestions?: string[];
  /** The command path that produced the error (e.g. "deploy staging"). */
  command?: string;
  /** The phase where the error occurred. */
  phase?: 'parse' | 'validate' | 'execute' | 'config';
  /** Original cause for error chaining. */
  cause?: unknown;
};

/**
 * Base error class for all Padrone errors.
 * Carries structured metadata for user-friendly formatting and programmatic handling.
 *
 * @example
 * ```ts
 * throw new PadroneError('Something went wrong', {
 *   exitCode: 1,
 *   suggestions: ['Try --help for usage information'],
 * });
 * ```
 */
export class PadroneError extends Error {
  readonly exitCode: number;
  readonly suggestions: string[];
  readonly command?: string;
  readonly phase?: 'parse' | 'validate' | 'execute' | 'config';

  constructor(message: string, options?: PadroneErrorOptions) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'PadroneError';
    this.exitCode = options?.exitCode ?? 1;
    this.suggestions = options?.suggestions ?? [];
    this.command = options?.command;
    this.phase = options?.phase;
  }

  /**
   * Returns a serializable representation of the error,
   * suitable for non-terminal runtimes (web UIs, APIs, etc.).
   */
  toJSON(): {
    name: string;
    message: string;
    exitCode: number;
    suggestions: string[];
    command?: string;
    phase?: string;
  } {
    return {
      name: this.name,
      message: this.message,
      exitCode: this.exitCode,
      suggestions: this.suggestions,
      command: this.command,
      phase: this.phase,
    };
  }
}

/**
 * Thrown when command routing fails — unknown command, unexpected arguments, etc.
 */
export class RoutingError extends PadroneError {
  constructor(message: string, options?: PadroneErrorOptions) {
    super(message, { phase: 'parse', ...options });
    this.name = 'RoutingError';
  }
}

/**
 * Thrown when argument or schema validation fails.
 * Carries the structured issues from the schema validator.
 */
export class ValidationError extends PadroneError {
  readonly issues: readonly { path?: PropertyKey[]; message: string }[];

  constructor(message: string, issues: readonly { path?: PropertyKey[]; message: string }[], options?: PadroneErrorOptions) {
    super(message, { phase: 'validate', ...options });
    this.name = 'ValidationError';
    this.issues = issues;
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      issues: this.issues.map((i) => ({ path: i.path?.map(String), message: i.message })),
    };
  }
}

/**
 * Thrown when config file loading or validation fails.
 */
export class ConfigError extends PadroneError {
  constructor(message: string, options?: PadroneErrorOptions) {
    super(message, { phase: 'config', ...options });
    this.name = 'ConfigError';
  }
}

/**
 * Thrown from user action handlers to surface structured errors with exit codes and suggestions.
 * This is the primary error class users should throw from their command actions.
 *
 * @example
 * ```ts
 * throw new ActionError('Missing environment', {
 *   exitCode: 1,
 *   suggestions: ['Use --env production or --env staging'],
 * });
 * ```
 */
export class ActionError extends PadroneError {
  constructor(message: string, options?: PadroneErrorOptions) {
    super(message, { phase: 'execute', ...options });
    this.name = 'ActionError';
  }
}

/**
 * Thrown when command execution is interrupted by a process signal (SIGINT, SIGTERM, SIGHUP).
 * Carries the signal name and the conventional exit code (128 + signal number).
 */
export class SignalError extends PadroneError {
  readonly signal: PadroneSignal;

  constructor(signal: PadroneSignal, options?: { cause?: unknown }) {
    super(`Process interrupted by ${signal}`, { exitCode: signalExitCode(signal), cause: options?.cause });
    this.name = 'SignalError';
    this.signal = signal;
  }
}

/** Thrown by prompts (`ctx.prompt`, interactive fields) when the user cancels with Ctrl+C or Esc. Exits with 130, like SIGINT. */
export class PromptCancelledError extends PadroneError {
  constructor(message = 'Cancelled', options?: PadroneErrorOptions) {
    super(message, { exitCode: 130, ...options });
    this.name = 'PromptCancelledError';
  }
}

/**
 * Thrown by `ctx.prompt` when it can't ask and the prompt has no `default`: no interactive terminal (CI, piped input,
 * `--no-interactive`, `interactive: 'unsupported'`) or a remote caller (`serve`, `mcp`, `tool`).
 */
export class PromptUnavailableError extends PadroneError {
  constructor(message: string, options?: PadroneErrorOptions) {
    super(message, options);
    this.name = 'PromptUnavailableError';
  }
}

/** Maps a signal name to its conventional exit code (128 + signal number). */
export function signalExitCode(signal: PadroneSignal): number {
  const codes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  return codes[signal] ?? 1;
}
