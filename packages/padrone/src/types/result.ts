import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PadroneSignal } from '../core/runtime.ts';
import type { Drained, IsGeneric, MaybePromise } from '../util/type-utils.ts';
import type { AnyPadroneCommand } from './command.ts';

type EmptyRecord = Record<string, never>;

type NormalizeArguments<TArgs> = IsGeneric<TArgs> extends true ? void | EmptyRecord : TArgs;
export type GetArguments<TDir extends 'in' | 'out', TCommand extends AnyPadroneCommand> = TDir extends 'in'
  ? NormalizeArguments<TCommand['~types']['argsInput']>
  : NormalizeArguments<TCommand['~types']['argsOutput']>;

export type GetResults<TCommand extends AnyPadroneCommand> = ReturnType<NonNullable<TCommand['action']>>;

/**
 * Result of `drain()` — a discriminated union that never throws.
 * On success, `value` holds the fully resolved/collected result; on failure, `error` holds the error.
 */
export type PadroneDrainResult<TResult> = { value: Drained<TResult>; error?: never } | { error: unknown; value?: never };

/**
 * Result returned by `eval()`, `cli()`, and `run()`. Never thrown — errors are captured in the `error` field.
 * Discriminated union: check `error` to distinguish success from failure.
 *
 * On success: `command`, `args`, `argsResult`, `result` are populated; `error` is absent.
 * On failure: `error` is populated; `command` may be present if routing succeeded.
 */
export type PadroneCommandResult<TCommand extends AnyPadroneCommand = AnyPadroneCommand> =
  | (PadroneParseResult<TCommand> & {
      result: GetResults<TCommand>;
      error?: never;
      /** The signal that caused cancellation, if any. */
      signal?: PadroneSignal;
      /** Suggested exit code (e.g. 130 for SIGINT). Present when a signal caused termination. */
      exitCode?: number;
      /** Flattens the result: awaits Promises, collects iterables, catches errors. Never throws. */
      drain: () => Promise<PadroneDrainResult<GetResults<TCommand>>>;
    })
  | {
      command?: TCommand;
      args?: GetArguments<'out', TCommand>;
      argsResult?: StandardSchemaV1.Result<GetArguments<'out', TCommand>>;
      error: unknown;
      result?: never;
      /** The signal that caused cancellation, if any. */
      signal?: PadroneSignal;
      /** Suggested exit code (e.g. 130 for SIGINT). Present when a signal caused termination. */
      exitCode?: number;
      /** Returns `{ error }` since there is no result to drain. */
      drain: () => Promise<PadroneDrainResult<GetResults<TCommand>>>;
    };

/**
 * Like `MaybePromise<PadroneCommandResult<TCommand>, TAsync>` but ensures `drain()` is available
 * at the outer level in all cases — both sync (Thenable) and async (Promise).
 */
export type MaybePromiseCommandResult<TCommand extends AnyPadroneCommand, TAsync> = MaybePromise<PadroneCommandResult<TCommand>, TAsync> & {
  drain: () => Promise<PadroneDrainResult<GetResults<TCommand>>>;
};

export type PadroneParseResult<TCommand extends AnyPadroneCommand = AnyPadroneCommand> = {
  command: TCommand;
  args?: GetArguments<'out', TCommand>;
  argsResult?: StandardSchemaV1.Result<GetArguments<'out', TCommand>>;
  /** `--dry-run` / `-n` was given (only on commands with a dry-run handler). */
  dryRun?: boolean;
};

export type PadroneAPI<TCommand extends AnyPadroneCommand> = PadroneAPICommand<TCommand> & {
  [K in TCommand['~types']['commands'][number] as K['name']]: PadroneAPI<K>;
};

type PadroneAPICommand<TCommand extends AnyPadroneCommand> = (args: GetArguments<'in', TCommand>) => GetResults<TCommand>;
