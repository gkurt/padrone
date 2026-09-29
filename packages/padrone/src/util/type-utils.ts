import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PadroneBuilder, PadroneProgram } from '../types/builder.ts';
import type { AnyPadroneCommand, PadroneCommand } from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';

/**
 * Use this type instead of `any` when you intend to fix it later
 * @deprecated Please replace with an actual type
 */
export type TODO<TCast = any, _TReason = unknown> = TCast;

export type SafeString = string & {};
type IsUnknown<T> = unknown extends T ? true : false;
type IsAny<T> = any extends T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;

export type IsGeneric<T> = IsAny<T> extends true ? true : IsUnknown<T> extends true ? true : IsNever<T> extends true ? true : false;

/**
 * Detects whether a schema has been branded as async via the `'~async'` property.
 * Standard Schema V1's `validate()` always types its return as `Result | Promise<Result>`
 * regardless of whether the schema is actually async, so we rely on an explicit brand instead.
 *
 * Use `asyncSchema(schema)` to brand a schema, or check for the `{ '~async': true }` property.
 */
export type IsAsyncSchema<T> = IsAny<T> extends true ? false : T extends { '~async': true } ? true : false;

/**
 * Computes the new TAsync flag when a schema is added to a builder.
 * Once TAsync is `true`, it stays `true`. Otherwise, checks if the new schema is branded async.
 */
export type OrAsync<TExisting extends boolean, TSchema> = TExisting extends true
  ? true
  : IsAsyncSchema<TSchema> extends true
    ? true
    : false;

/**
 * Detects whether argument meta contains interactive or optionalInteractive configuration.
 * When either is `true` or a `string[]`, the command requires async execution for prompting.
 */
export type HasInteractive<TMeta> = TMeta extends { interactive: true | readonly string[] }
  ? true
  : TMeta extends { optionalInteractive: true | readonly string[] }
    ? true
    : false;

/** Whether a field in the meta's `fields` has `fromFile: true` (a `-` value reads stdin). */
type HasFromFile<TMeta> = TMeta extends { fields: infer F }
  ? true extends { [K in keyof F]: F[K] extends { fromFile: true } ? true : never }[keyof F]
    ? true
    : false
  : false;

/**
 * Combines schema-level async detection with meta-level interactive and stdin detection.
 * Returns `true` if the existing async flag is set, the schema is branded async, or the meta has interactive fields
 * or reads stdin (piped input is read asynchronously), including `fromFile` fields.
 */
export type OrAsyncMeta<TExisting extends boolean, TMeta> = TExisting extends true
  ? true
  : HasInteractive<TMeta> extends true
    ? true
    : TMeta extends { stdin: string }
      ? true
      : HasFromFile<TMeta>;

/**
 * Unwraps a result type by resolving Promises and collecting iterables into arrays.
 * - `AsyncIterable<U>` → `U[]`
 * - `Iterable<U>` (excluding strings) → `U[]`
 * - `Promise<U>` → `Drained<U>` (recursively unwraps)
 * - `T` → `T`
 */
export type Drained<T> =
  T extends Promise<infer U>
    ? Drained<U>
    : T extends AsyncIterable<infer U>
      ? U[]
      : T extends string
        ? T
        : T extends Iterable<infer U>
          ? U[]
          : T;

/**
 * A sync value augmented with Promise-like methods (.then, .catch, .finally).
 * Unlike a real Promise, properties of T are accessible synchronously.
 */
export type Thenable<T> = T & PromiseLike<T> & { catch: Promise<T>['catch']; finally: Promise<T>['finally'] };

/**
 * Conditionally wraps a type in Promise based on the TAsync flag.
 * - `true` → `Promise<T>`
 * - `false` → `T & Thenable<T>` (thenable: supports `.then()`, `.catch()`, `.finally()`, and `await`)
 * - `boolean` (union of true|false) → `Promise<T>` (safe default when async-ness is uncertain)
 * - `any` → `T` (for generic/any typed commands like AnyPadroneCommand)
 */
export type MaybePromise<T, TAsync> = IsAny<TAsync> extends true ? T : true extends TAsync ? Promise<T> : Thenable<T>;

type SplitString<TName extends string, TSplitBy extends string = ' '> = TName extends `${infer FirstPart}${TSplitBy}${infer RestParts}`
  ? [FirstPart, ...SplitString<RestParts, TSplitBy>]
  : [TName];

type JoinString<TParts extends string[], TJoinBy extends string = ' '> = TParts extends [
  infer FirstPart extends string,
  ...infer RestParts extends string[],
]
  ? RestParts extends []
    ? FirstPart
    : `${FirstPart}${TJoinBy}${JoinString<RestParts, TJoinBy>}`
  : TParts extends []
    ? ''
    : TParts[number];

type SplitLastSpace<S extends string> =
  SplitString<S> extends [...infer Init extends string[], infer Last extends string]
    ? Init extends []
      ? [S, never]
      : [JoinString<Init>, Last]
    : [S, never];

type AnyPartExtends<U, T> = [U] extends [never] ? false : U extends any ? (U extends T ? true : never) : never extends true ? true : false;

export type FullCommandName<TName extends string, TParentName extends string = ''> = TParentName extends ''
  ? TName
  : `${TParentName} ${TName}`;

/**
 * Generate full alias paths by combining parent path with each alias.
 */
type FullAliasPaths<TAliases extends string[], TParentName extends string = ''> = TAliases extends [
  infer First extends string,
  ...infer Rest extends string[],
]
  ? FullCommandName<First, TParentName> | FullAliasPaths<Rest, TParentName>
  : never;

/**
 * Get all paths for a command including its primary path and all alias paths.
 */
type GetCommandPathsAndAliases<TCommand extends AnyPadroneCommand> = TCommand['~types']['path'] extends infer Path extends string
  ? TCommand['~types']['aliases'] extends infer Aliases extends string[]
    ? TCommand['~types']['parentName'] extends infer ParentName extends string
      ? Path | FullAliasPaths<Aliases, ParentName>
      : Path
    : Path
  : never;

/**
 * Find a direct child command in a tuple by name.
 * Unlike PickCommandByName, this does NOT flatten — it only checks direct children by their `name` field.
 * Uses indexed access (O(1) depth) instead of recursive tuple walking.
 */
export type FindDirectChild<TCommands extends AnyPadroneCommand[], TName extends string> = Extract<
  TCommands[number],
  { '~types': { name: TName } }
>;

/**
 * Replace a command in a tuple by name, or append if not found.
 * Used by `.command()` override semantics: re-registering a name replaces that entry.
 * Uses mapped type (O(1) depth) instead of recursive tuple walking.
 */
export type ReplaceOrAppendCommand<TCommands extends [...AnyPadroneCommand[]], TName extends string, TNew extends AnyPadroneCommand> =
  HasDirectChild<TCommands, TName> extends true ? ReplaceInTuple<TCommands, TName, TNew> : [...TCommands, TNew];

type HasDirectChild<TCommands extends AnyPadroneCommand[], TName extends string> = TName extends TCommands[number]['~types']['name']
  ? true
  : false;

type ReplaceInTuple<TCommands extends AnyPadroneCommand[], TName extends string, TNew extends AnyPadroneCommand> = {
  [K in keyof TCommands]: TCommands[K] extends AnyPadroneCommand
    ? TCommands[K]['~types']['name'] extends TName
      ? TNew
      : TCommands[K]
    : TCommands[K];
};

type NoArgs = void | undefined;

export type EmptyRecord = Record<string, never>;

/** The args an action (and `result.args`) gets from a schema: `{}` for a command without arguments, as at runtime. */
export type ArgsOutput<TSchema extends PadroneSchema> = OutputArgs<StandardSchemaV1.InferOutput<TSchema>>;
type OutputArgs<T> = IsGeneric<T> extends true ? T : T extends NoArgs ? Record<string, never> : T;

/** Global args merged under a command's own args; the command's own fields win. */
type MergeGlobalArgs<TGlobal, TOwn> = [Exclude<TGlobal, NoArgs>] extends [never]
  ? TOwn
  : [Exclude<TOwn, NoArgs>] extends [never]
    ? Exclude<TGlobal, NoArgs>
    : Omit<Exclude<TGlobal, NoArgs>, keyof Exclude<TOwn, NoArgs>> & Exclude<TOwn, NoArgs>;

/**
 * The args schema a command effectively accepts: its own, plus the global args in effect.
 * Without global args (`PadroneSchema<void>`), this is the command's own schema unchanged.
 */
export type WithGlobalArgs<TArgs extends PadroneSchema, TGlobals extends PadroneSchema> = [
  Exclude<StandardSchemaV1.InferOutput<TGlobals>, NoArgs>,
] extends [never]
  ? TArgs
  : PadroneSchema<
      MergeGlobalArgs<StandardSchemaV1.InferInput<TGlobals>, StandardSchemaV1.InferInput<TArgs>>,
      MergeGlobalArgs<StandardSchemaV1.InferOutput<TGlobals>, StandardSchemaV1.InferOutput<TArgs>>
    >;

/**
 * Utility type for extensions that add a command to a builder/program.
 * Replaces the boilerplate `With*<T>` pattern used across all extension files.
 */
export type WithCommand<T, TName extends string, TCmd extends AnyPadroneCommand> = T extends {
  '~types': {
    programName: infer PN extends string;
    name: infer N extends string;
    parentName: infer PaN extends string;
    argsSchema: infer A extends PadroneSchema;
    result: infer R;
    commands: infer C extends [...AnyPadroneCommand[]];
    async: infer AS extends boolean;
    context: infer CTX;
    contextProvided: infer CTXP;
    callerContext: infer CC;
    globals: infer G extends PadroneSchema;
  };
}
  ? T extends { run: any }
    ? PadroneProgram<PN, N, PaN, A, R, ReplaceOrAppendCommand<C, TName, TCmd>, any, AS, CTX, CTXP, G, CC>
    : PadroneBuilder<PN, N, PaN, A, R, ReplaceOrAppendCommand<C, TName, TCmd>, any, AS, CTX, CTXP, G>
  : T;

/**
 * Utility type for extensions that register a context-providing interceptor.
 * Extends `TContextProvided` with `TProvides` while preserving all other builder/program type params.
 */
export type WithInterceptor<T, TProvides> = T extends {
  '~types': {
    programName: infer PN extends string;
    name: infer N extends string;
    parentName: infer PaN extends string;
    argsSchema: infer A extends PadroneSchema;
    result: infer R;
    commands: infer C extends [...AnyPadroneCommand[]];
    async: infer AS extends boolean;
    context: infer CTX;
    contextProvided: infer CTXP;
    callerContext: infer CC;
    globals: infer G extends PadroneSchema;
  };
}
  ? T extends { run: any }
    ? PadroneProgram<PN, N, PaN, A, R, C, any, AS, CTX, CTXP & TProvides, G, CC>
    : PadroneBuilder<PN, N, PaN, A, R, C, any, AS, CTX, CTXP & TProvides, G>
  : T;

/**
 * Utility type for extensions that force the builder/program into async mode.
 * Sets `TAsync` to `true` while preserving all other type params.
 */
export type WithAsync<T> = T extends {
  '~types': {
    programName: infer PN extends string;
    name: infer N extends string;
    parentName: infer PaN extends string;
    argsSchema: infer A extends PadroneSchema;
    result: infer R;
    commands: infer C extends [...AnyPadroneCommand[]];
    async: any;
    context: infer CTX;
    contextProvided: infer CTXP;
    callerContext: infer CC;
    globals: infer G extends PadroneSchema;
  };
}
  ? T extends { run: any }
    ? PadroneProgram<PN, N, PaN, A, R, C, any, true, CTX, CTXP, G, CC>
    : PadroneBuilder<PN, N, PaN, A, R, C, any, true, CTX, CTXP, G>
  : T;

export type PickCommandByName<
  TCommands extends AnyPadroneCommand[],
  TName extends string | AnyPadroneCommand,
> = TName extends AnyPadroneCommand
  ? TName
  : FlattenCommands<TCommands> extends infer Cmd extends AnyPadroneCommand
    ? Cmd extends AnyPadroneCommand
      ? TName extends GetCommandPathsAndAliases<Cmd>
        ? Cmd
        : never
      : never
    : never;

export type FlattenCommands<TCommands extends AnyPadroneCommand[]> = TCommands extends []
  ? never
  : number extends TCommands['length']
    ? IsAny<TCommands[number]> extends true
      ? never
      : TCommands[number]
    : TCommands[number] extends infer Cmd extends AnyPadroneCommand
      ? Cmd | FlattenCommands<Cmd['~types']['commands']>
      : never;

/**
 * Get all command paths including alias paths for all commands.
 */
type GetCommandPathsOrAliases<TCommands extends AnyPadroneCommand[]> = GetCommandPathsAndAliases<FlattenCommands<TCommands>>;

/**
 * Find all the commands that are prefixed with a command name or alias.
 * This is needed to avoid matching other commands when followed by a space and another word.
 * For example, let's say `level1` and `level1 level2` are commands.
 * Then `level1 ${string}` would also match `level1 level2`,
 * and it would cause `level1 level2` to not show up in the autocomplete.
 * By excluding those cases, we can ensure autocomplete works correctly.
 */
type PrefixedCommands<TCommands extends AnyPadroneCommand[]> =
  GetCommandPathsOrAliases<TCommands> extends infer CommandNames
    ? CommandNames extends string
      ? AnyPartExtends<GetCommandPathsOrAliases<TCommands>, `${CommandNames} ${string}`> extends true
        ? never
        : `${CommandNames} ${string}`
      : never
    : never;

/**
 * The possible commands are the commands that can be parsed by the program.
 * This includes the string that are exact matches to a command name or alias, and strings that are prefixed with a command name or alias.
 */
export type PossibleCommands<
  TCommands extends AnyPadroneCommand[],
  TWithPrefixed extends boolean = false,
  TWithObjects extends boolean = false,
  TWithFallback extends boolean = true,
> =
  | GetCommandPathsOrAliases<TCommands>
  | (TWithPrefixed extends true ? PrefixedCommands<TCommands> : never)
  | (TWithObjects extends true ? FlattenCommands<TCommands> : never)
  | (TWithFallback extends true ? SafeString : never);

type CommandIsUnknownable<TCommand> =
  IsGeneric<TCommand> extends true ? true : string extends TCommand ? true : SafeString extends TCommand ? true : false;

/**
 * Match a string to a command by the possible commands.
 * This is done by recursively splitting the string by the last space, and then checking if the prefix is a valid command name or alias.
 * This is needed to avoid matching the top-level command when there are nested commands.
 */
/**
 * Recursively re-paths a command's children under a new parent path.
 * Used by `mount()` to update all nested command paths when a program is mounted as a subcommand.
 */
/** Commands moved under a new parent path, with the global args in effect there (`TGlobals`) merged into their args. */
export type RepathCommands<
  TCommands extends [...AnyPadroneCommand[]],
  TNewParentPath extends string,
  TGlobals extends PadroneSchema = PadroneSchema<void>,
> = TCommands extends [infer First extends AnyPadroneCommand, ...infer Rest extends AnyPadroneCommand[]]
  ? [RepathCommand<First, TNewParentPath, TGlobals>, ...RepathCommands<Rest, TNewParentPath, TGlobals>]
  : [];

type RepathCommand<TCommand extends AnyPadroneCommand, TNewParentName extends string, TGlobals extends PadroneSchema> = PadroneCommand<
  TCommand['~types']['name'],
  TNewParentName,
  WithGlobalArgs<TCommand['~types']['argsSchema'], TGlobals>,
  TCommand['~types']['result'],
  RepathCommands<TCommand['~types']['commands'], FullCommandName<TCommand['~types']['name'], TNewParentName>, TGlobals>,
  TCommand['~types']['aliases'],
  OrAsync<TCommand['~types']['async'], TGlobals>,
  TCommand['~types']['context'],
  TCommand['~types']['contextProvided']
>;

export type PickCommandByPossibleCommands<
  TCommands extends AnyPadroneCommand[],
  TCommand extends PossibleCommands<TCommands, true, true> | SafeString,
> =
  CommandIsUnknownable<TCommand> extends true
    ? FlattenCommands<TCommands>
    : TCommand extends AnyPadroneCommand
      ? TCommand
      : TCommand extends string
        ? TCommand extends GetCommandPathsOrAliases<TCommands>
          ? PickCommandByName<TCommands, TCommand>
          : SplitLastSpace<TCommand> extends [infer Prefix extends string, infer Rest]
            ? IsNever<Rest> extends true
              ? PickCommandByName<TCommands, Prefix>
              : PickCommandByPossibleCommands<TCommands, Prefix>
            : never
        : never;
