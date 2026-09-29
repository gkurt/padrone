import type {
  AnyPadroneCommand,
  CommandTypesBase,
  PadroneCommand,
  PadroneContextInterceptor,
  PadroneInterceptorFn,
} from '../types/index.ts';
import type { PickCommandByName, PossibleCommands } from './type-utils.ts';

/**
 * Extracts the input type of the arguments schema from a command.
 * @example
 * ```ts
 * type Args = InferArgsInput<typeof myCommand>;
 * ```
 */
export type InferArgsInput<T extends AnyPadroneCommand> = T['~types']['argsInput'];

/**
 * Extracts the output type of the arguments schema from a command.
 * @example
 * ```ts
 * type Args = InferArgsOutput<typeof myCommand>;
 * ```
 */
export type InferArgsOutput<T extends AnyPadroneCommand> = T['~types']['argsOutput'];

/**
 * Extracts the user-defined context type from a command (excludes interceptor-provided context).
 * @example
 * ```ts
 * type Ctx = InferContext<typeof myCommand>;
 * ```
 */
export type InferContext<T extends AnyPadroneCommand> = T['~types']['context'];

/**
 * Extracts the interceptor-provided context type from a command.
 * @example
 * ```ts
 * type Provided = InferContextProvided<typeof myCommand>;
 * ```
 */
export type InferContextProvided<T extends AnyPadroneCommand> = T['~types']['contextProvided'];

/**
 * Extracts the context type that a context-providing interceptor injects.
 * @example
 * ```ts
 * type AuthCtx = InferInterceptorContext<typeof withAuth>;
 * ```
 */
export type InferInterceptorContext<T extends PadroneContextInterceptor<any>> = T['~context'];

/**
 * Extracts the required context type from an interceptor with `.requires()`.
 * @example
 * ```ts
 * type Requires = InferInterceptorRequires<typeof withAuth>;
 * ```
 */
export type InferInterceptorRequires<T extends PadroneInterceptorFn & { '~contextRequires': any }> = T['~contextRequires'] extends (
  ctx: infer R,
) => void
  ? R
  : unknown;

/**
 * Gets a command type by its path from a program or command tree.
 * Supports both full paths (e.g., "config set") and alias paths.
 * @example
 * ```ts
 * const program = createPadrone('cli')
 *   .command('config', c => c
 *     .command('set', c => c.arguments(...).action(...))
 *     .command('get', c => c.arguments(...).action(...))
 *   );
 *
 * type SetCommand = InferCommand<typeof program, 'config set'>;
 * type GetCommand = InferCommand<typeof program, 'config get'>;
 * ```
 */
export type InferCommand<
  T extends AnyPadroneCommand | CommandTypesBase,
  TPath extends PossibleCommands<InferCommandTree<T>, true, true>,
> = PickCommandByName<InferCommandTree<T>, Extract<TPath, string | AnyPadroneCommand>>;

/** The command tree `InferCommand` looks paths up in: a program's (or builder's) commands under an unnamed root, or the command itself. */
type InferCommandTree<T> = T extends { '~types': { programName: string; commands: infer C extends AnyPadroneCommand[] } }
  ? [PadroneCommand<'', '', any, any, C>]
  : T extends AnyPadroneCommand
    ? [T]
    : never;
