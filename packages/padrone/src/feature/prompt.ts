import { PromptCancelledError, PromptUnavailableError } from '../core/errors.ts';
import { REMOTE_CALLERS } from '../core/interceptors.ts';
import type { InteractivePromptConfig, ResolvedPadroneRuntime } from '../core/runtime.ts';
import { PROMPT_CANCEL } from '../core/runtime.ts';

// ── Types ────────────────────────────────────────────────────────────────

/** What prompts need from an execution: any action or interceptor context has it. */
export type PadronePromptContext = {
  runtime: ResolvedPadroneRuntime;
  caller: string;
  /** `--interactive` / `--no-interactive`, from the interactive extension. */
  interactive?: boolean;
  /** The `interactive` option of `eval()` / `cli()`. */
  evalInteractive?: boolean;
};

type PadronePromptBaseOptions = {
  /** The question. */
  message: string;
  /**
   * The key a runtime's `prompt` receives as `config.name`, which scripted answers use (`testCli().prompt({ [name]: answer })`).
   * Defaults to the step's key inside `group()`, else the message.
   */
  name?: string;
};

/** Options for `prompt.text()`. */
export type PadroneTextPromptOptions = PadronePromptBaseOptions & {
  /** Answer for a blank input, and the result when prompting isn't possible. */
  default?: string;
  /** Returns an error message to ask again, or nothing to accept the answer. */
  validate?: (value: string) => string | undefined | void;
};

/** Options for `prompt.password()`: a masked text prompt without a default. */
export type PadronePasswordPromptOptions = PadronePromptBaseOptions & {
  /** Returns an error message to ask again, or nothing to accept the answer. */
  validate?: (value: string) => string | undefined | void;
};

/** Options for `prompt.confirm()`. */
export type PadroneConfirmPromptOptions = PadronePromptBaseOptions & {
  /** Answer for a blank input, and the result when prompting isn't possible. */
  default?: boolean;
};

/** A choice of `select()` / `multiselect()`. `label` defaults to the value's string form; `hint` is shown after it. */
export type PadronePromptChoice<T> = { value: T; label?: string; hint?: string };

/** Options for `prompt.select()`. Choices are values or `{ value, label, hint }` objects. */
export type PadroneSelectPromptOptions<T> = PadronePromptBaseOptions & {
  choices: readonly (T | PadronePromptChoice<T>)[];
  /** Initially highlighted value, and the result when prompting isn't possible. */
  default?: T;
};

/** Options for `prompt.multiselect()`. */
export type PadroneMultiselectPromptOptions<T> = PadronePromptBaseOptions & {
  choices: readonly (T | PadronePromptChoice<T>)[];
  /** Initially selected values, and the result when prompting isn't possible. */
  default?: readonly T[];
  /** Asks again until at least one choice is selected. */
  required?: boolean;
};

/**
 * Steps of `prompt.group()`: each one gets the answers of the steps before it as `results`, and questions it asks without
 * a `name` are named after its key. Returning `undefined` skips a question.
 */
export type PadronePromptGroup<T> = {
  [K in keyof T]: (step: { results: Partial<Omit<T, K>> }) => T[K] | Promise<T[K]>;
};

/**
 * Prompt building blocks, like `@clack/prompts`: `ctx.prompt` in actions, `createPrompt(ctx)` in interceptors.
 * They ask through `runtime.prompt`, so a custom runtime or `testCli().prompt()` answers them.
 *
 * - Cancelling (Ctrl+C, Esc) throws a `PromptCancelledError` (check with `isPromptCancel`); an empty answer is `''`.
 * - Where they can't ask (CI, piped input, `--no-interactive`, `serve`/`mcp`/`tool` calls), they return their `default`,
 *   or throw a `PromptUnavailableError` without one, so nothing waits for input that can't come.
 */
export type PadronePrompt = {
  /** Whether prompts can ask here; when `false` they return their `default` or throw. */
  readonly available: boolean;
  /** Asks for a line of text. */
  text(options: string | PadroneTextPromptOptions): Promise<string>;
  /** Asks for a secret with masked input. */
  password(options: string | PadronePasswordPromptOptions): Promise<string>;
  /** Asks a yes/no question. */
  confirm(options: string | PadroneConfirmPromptOptions): Promise<boolean>;
  /** Asks to pick one of `choices` and resolves with its value. */
  select<const T>(options: PadroneSelectPromptOptions<T>): Promise<T>;
  /** Asks to pick any of `choices` and resolves with their values. */
  multiselect<const T>(options: PadroneMultiselectPromptOptions<T>): Promise<T[]>;
  /**
   * Runs the steps in order and resolves with their answers by key. TypeScript can't infer the answer of a step that reads
   * `results` (it's `unknown`); pass the answers' type (`group<{ name: string; admin?: boolean }>(...)`) to type it.
   */
  group<T>(steps: PadronePromptGroup<T>): Promise<T>;
};

// ── Helpers ──────────────────────────────────────────────────────────────

const isRemote = (caller: string) => (REMOTE_CALLERS as readonly string[]).includes(caller);

/**
 * Whether the runtime can ask the user here: a `prompt` backend, not `interactive: 'unsupported'`, not a remote caller, then
 * `--interactive` / `--no-interactive` or eval's `interactive` option, else an interactive runtime whose stdin isn't piped.
 */
export function canPrompt(ctx: PadronePromptContext): boolean {
  const { runtime } = ctx;
  if (!runtime.prompt || runtime.interactive === 'unsupported' || isRemote(ctx.caller)) return false;
  return (
    ctx.interactive ??
    ctx.evalInteractive ??
    (runtime.interactive === 'forced' || (runtime.interactive !== 'disabled' && runtime.stdin?.isTTY !== false))
  );
}

/** Asks through `runtime.prompt`, turning a `PROMPT_CANCEL` answer into a `PromptCancelledError`. */
export async function askRuntime(runtime: ResolvedPadroneRuntime, config: InteractivePromptConfig): Promise<unknown> {
  const answer = await runtime.prompt!(config);
  if (answer === PROMPT_CANCEL) throw new PromptCancelledError();
  return answer;
}

/** Whether a value or error is a prompt cancellation: `PROMPT_CANCEL` or a `PromptCancelledError`. */
export function isPromptCancel(value: unknown): value is PromptCancelledError | typeof PROMPT_CANCEL {
  return value === PROMPT_CANCEL || value instanceof PromptCancelledError;
}

/** The choice an answer names: backends may answer with a value's string form (Enquirer answers with choice names). */
export function choiceValue(choices: readonly { value: unknown }[], answer: unknown): unknown {
  return choices.find((c) => c.value === answer || String(c.value) === String(answer))?.value ?? answer;
}

const isChoice = <T>(choice: T | PadronePromptChoice<T>): choice is PadronePromptChoice<T> =>
  !!choice && typeof choice === 'object' && 'value' in choice;

const toChoices = <T>(choices: readonly (T | PadronePromptChoice<T>)[]) =>
  choices.map((choice) => {
    const { value, label, hint } = isChoice(choice) ? choice : { value: choice, label: undefined, hint: undefined };
    return { value: value as unknown, label: `${label ?? String(value)}${hint ? ` — ${hint}` : ''}` };
  });

const toBoolean = (answer: unknown, fallback: boolean) =>
  typeof answer === 'boolean' ? answer : answer === undefined || answer === '' ? fallback : /^(y|yes|true|1)$/i.test(String(answer).trim());

// ── Prompts ──────────────────────────────────────────────────────────────

/** Prompt building blocks for an execution: `createPrompt(ctx)` from any interceptor phase context (actions get `ctx.prompt`). */
export function createPrompt(ctx: PadronePromptContext): PadronePrompt {
  const { runtime } = ctx;
  /** The key of the `group()` step running, which names its questions. */
  let stepKey: string | undefined;
  const normalize = <O extends PadronePromptBaseOptions>(options: string | O) => {
    const opts = (typeof options === 'string' ? { message: options } : options) as O;
    return { ...opts, name: opts.name ?? stepKey ?? opts.message };
  };

  /** Asks until `validate` accepts, or returns the fallback (or throws) when it can't ask. */
  const ask = async (
    config: InteractivePromptConfig,
    fallback: { value: unknown } | undefined,
    validate?: (answer: unknown) => string | undefined | void,
  ): Promise<unknown> => {
    if (!canPrompt(ctx)) {
      if (fallback) return fallback.value;
      const where = isRemote(ctx.caller) ? `in a "${ctx.caller}" call` : 'without an interactive terminal';
      throw new PromptUnavailableError(`Cannot prompt for "${config.message}" ${where}`, {
        suggestions: ['Pass the value as an option or argument instead'],
      });
    }
    let current = config;
    while (true) {
      const answer = await askRuntime(runtime, current);
      const error = validate?.(answer);
      if (!error) return answer;
      runtime.error(error);
      // A masked prompt never gets the typed value back as its default
      if (config.type !== 'password' && typeof answer === 'string') current = { ...config, default: answer };
    }
  };

  const textPrompt = async (options: string | PadroneTextPromptOptions, type: 'input' | 'password') => {
    const opts = normalize(options);
    const toText = (answer: unknown) =>
      (answer === undefined || answer === '') && opts.default !== undefined ? opts.default : String(answer ?? '');
    const fallback = opts.default === undefined ? undefined : { value: opts.default };
    const config: InteractivePromptConfig = { name: opts.name, message: opts.message, type, default: opts.default };
    return toText(await ask(config, fallback, opts.validate && ((answer) => opts.validate!(toText(answer)))));
  };

  const prompt: PadronePrompt = {
    get available() {
      return canPrompt(ctx);
    },
    text: (options) => textPrompt(options, 'input'),
    password: (options) => textPrompt({ ...normalize(options), default: undefined }, 'password'),
    async confirm(options) {
      const opts = normalize(options);
      const fallback = opts.default === undefined ? undefined : { value: opts.default };
      const answer = await ask({ name: opts.name, message: opts.message, type: 'confirm', default: opts.default }, fallback);
      return toBoolean(answer, opts.default ?? false);
    },
    async select<T>(options: PadroneSelectPromptOptions<T>) {
      const opts = normalize(options);
      const choices = toChoices(opts.choices);
      const fallback = opts.default === undefined ? undefined : { value: opts.default };
      const answer = await ask({ name: opts.name, message: opts.message, type: 'select', choices, default: opts.default }, fallback);
      return (answer === undefined && opts.default !== undefined ? opts.default : choiceValue(choices, answer)) as T;
    },
    async multiselect<T>(options: PadroneMultiselectPromptOptions<T>) {
      const opts = normalize(options);
      const choices = toChoices(opts.choices);
      const toValues = (answer: unknown) => (Array.isArray(answer) ? answer.map((a) => choiceValue(choices, a)) : []) as T[];
      const config: InteractivePromptConfig = {
        name: opts.name,
        message: opts.message,
        type: 'multiselect',
        choices,
        default: opts.default,
      };
      const fallback = opts.default === undefined ? undefined : { value: [...opts.default] };
      const validate = opts.required
        ? (answer: unknown) => (toValues(answer).length ? undefined : 'Select at least one option')
        : undefined;
      return toValues(await ask(config, fallback, validate));
    },
    async group<T>(steps: PadronePromptGroup<T>) {
      const results: Record<string, unknown> = {};
      const outer = stepKey;
      try {
        for (const key of Object.keys(steps) as (keyof T & string)[]) {
          stepKey = key;
          results[key] = await steps[key]({ results: { ...results } as Partial<Omit<T, typeof key>> });
        }
      } finally {
        stepKey = outer;
      }
      return results as T;
    },
  };
  return prompt;
}
