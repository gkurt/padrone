import { truncate } from '../output/primitives.ts';
import { canAnimate } from './progress-renderer.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PadroneTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'rolling-back' | 'rolled-back';

/** Live state of a task, read by task list renderers. */
export type PadroneTaskState = {
  readonly title: string;
  readonly status: PadroneTaskStatus;
  /** The latest `update()` message while running (the previous attempt's error while retrying); the skip reason or error message after. */
  readonly message?: string;
  /** Set while a failed task is retried: the retry number (1 for the first retry) and how many retries it gets. */
  readonly retry?: { readonly count: number; readonly tries: number };
  readonly subtasks: readonly PadroneTaskState[];
};

/** Passed to each task's function. */
export type PadroneTaskContext = {
  /** Show a status line under the running task. */
  update(message: string): void;
  /** Change the task's title. */
  setTitle(title: string): void;
  /** Stop the task and mark it skipped, with an optional reason. */
  skip(reason?: string): never;
  /** Run subtasks, shown nested under this task. */
  tasks(tasks: readonly PadroneTask[], options?: PadroneTasksOptions): Promise<void>;
  /** Aborted when the command is cancelled (e.g. Ctrl+C). */
  signal: AbortSignal;
  /** Which retry this attempt is (`0` for the first attempt), and the error the previous attempt failed with. */
  retry: { count: number; error?: unknown };
};

export type PadroneTask = {
  title: string;
  task: (task: PadroneTaskContext) => unknown;
  /** Skip the task: `true`, or a reason. A function is called when the task's turn comes. */
  skip?: boolean | string | (() => boolean | string | Promise<boolean | string>);
  /** Run a failing task again: this many more times, or `{ tries, delay }` with a delay in milliseconds between attempts. */
  retry?: number | { tries: number; delay?: number };
  /**
   * Undo a failed task's partial work, once its retries are used up. The task is shown as rolled back, and `tasks()` still
   * fails with the task's error; an error the rollback throws replaces it.
   */
  rollback?: (task: PadroneTaskContext, error: unknown) => unknown;
};

/** Options for the built-in task list renderers, passed as `tasks(list, { rendererOptions })`. */
export type PadroneTaskRendererOptions = {
  /** Hide a task's subtasks once it's done or skipped, like listr2. Defaults to `false`. Only the live list collapses. */
  collapseSubtasks?: boolean;
};

export type PadroneTasksOptions = {
  /** Run tasks at the same time: `true` for all of them, or at most this many. Defaults to `false` (one after another). */
  concurrent?: boolean | number;
  /**
   * Stop starting tasks once one fails, and reject with its error. With `false`, every task runs and the first
   * failure is thrown at the end. Defaults to `true`.
   */
  exitOnError?: boolean;
  /** Options for the renderer; read by the outermost `tasks()` call, which creates it. */
  rendererOptions?: PadroneTaskRendererOptions;
};

/** Draws a task list. `update()` is called on every change; `done()` once every task settled. */
export type PadroneTaskListRenderer = (
  tasks: readonly PadroneTaskState[],
  options?: PadroneTaskRendererOptions,
) => {
  update(): void;
  pause(): void;
  resume(): void;
  done(): void;
};

/** `progress.tasks()`: runs tasks, drawing them as a list while they run. */
export type PadroneTasksFn = (tasks: readonly PadroneTask[], options?: PadroneTasksOptions) => Promise<void>;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type MutableTaskState = {
  title: string;
  status: PadroneTaskStatus;
  message?: string;
  retry?: { count: number; tries: number };
  subtasks: MutableTaskState[];
};

class SkipSignal {
  constructor(readonly reason?: string) {}
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Runs `tasks`, recording their state in `states` (appended to) and calling `notify` on every change. */
export async function runTaskList(
  tasks: readonly PadroneTask[],
  options: PadroneTasksOptions,
  states: MutableTaskState[],
  notify: () => void,
  signal: AbortSignal,
): Promise<void> {
  const own: MutableTaskState[] = tasks.map((task) => ({ title: task.title, status: 'pending', subtasks: [] }));
  states.push(...own);
  notify();

  const limit = options.concurrent === true ? tasks.length : Math.max(1, Math.floor(Number(options.concurrent) || 1));
  const exitOnError = options.exitOnError ?? true;
  const errors: unknown[] = [];
  let next = 0;

  const fail = (state: MutableTaskState, err: unknown) => {
    state.status = 'failed';
    state.message = errorMessage(err);
    errors.push(err);
  };

  const contextFor = (state: MutableTaskState, retry: PadroneTaskContext['retry']): PadroneTaskContext => ({
    update(message) {
      state.message = message;
      notify();
    },
    setTitle(title) {
      state.title = title;
      notify();
    },
    skip(reason) {
      throw new SkipSignal(reason);
    },
    tasks: (subtasks, subOptions) => runTaskList(subtasks, subOptions ?? {}, state.subtasks, notify, signal),
    signal,
    retry,
  });

  const runOne = async (task: PadroneTask, state: MutableTaskState) => {
    let skip: boolean | string | undefined;
    try {
      skip = typeof task.skip === 'function' ? await task.skip() : task.skip;
    } catch (err) {
      fail(state, err);
      return notify();
    }
    if (skip) {
      state.status = 'skipped';
      if (typeof skip === 'string') state.message = skip;
      return notify();
    }

    const tries = Math.max(0, Math.floor((typeof task.retry === 'object' ? task.retry.tries : task.retry) || 0));
    const delay = typeof task.retry === 'object' ? (task.retry.delay ?? 0) : 0;
    let error: unknown;
    for (let count = 0; ; count++) {
      state.status = 'running';
      notify();
      try {
        await task.task(contextFor(state, count === 0 ? { count } : { count, error }));
        state.status = 'done';
        state.message = undefined;
        state.retry = undefined;
        return notify();
      } catch (err) {
        if (err instanceof SkipSignal) {
          state.status = 'skipped';
          state.message = err.reason;
          state.retry = undefined;
          return notify();
        }
        error = err;
        if (count >= tries || signal.aborted) break;
        state.retry = { count: count + 1, tries };
        state.message = errorMessage(err);
        state.subtasks.length = 0;
        notify();
        if (delay > 0) await sleep(delay, signal);
        if (signal.aborted) break;
      }
    }

    state.retry = undefined;
    if (!task.rollback) {
      fail(state, error);
      return notify();
    }
    state.status = 'rolling-back';
    state.message = undefined;
    notify();
    try {
      await task.rollback(contextFor(state, { count: 0, error }), error);
      state.status = 'rolled-back';
      state.message = errorMessage(error);
      errors.push(error);
    } catch (rollbackError) {
      fail(state, rollbackError);
    }
    notify();
  };

  const worker = async () => {
    while (next < tasks.length) {
      if ((errors.length > 0 && exitOnError) || signal.aborted) return;
      const i = next++;
      await runOne(tasks[i]!, own[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));

  if (errors.length > 0) throw errors[0];
  if (signal.aborted) throw signal.reason;
}

export const noopTaskRenderer: PadroneTaskListRenderer = () => ({ update() {}, pause() {}, resume() {}, done() {} });

// ---------------------------------------------------------------------------
// Terminal renderers
// ---------------------------------------------------------------------------

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
type FinishedStatus = Exclude<PadroneTaskStatus, 'running' | 'rolling-back'>;
const ICONS: Record<FinishedStatus, string> = { pending: '◻', done: '✔', failed: '✖', skipped: '↓', 'rolled-back': '↩' };

const isActive = (state: PadroneTaskState) => state.status === 'running' || state.status === 'rolling-back';
const isFinished = (state: PadroneTaskState) => state.status !== 'pending' && !isActive(state);

function finishedLine(state: PadroneTaskState, indent: string): string {
  const icon = ICONS[state.status as FinishedStatus];
  if (state.status === 'skipped') return `${indent}${icon} ${state.title} [${state.message ? `skipped: ${state.message}` : 'skipped'}]`;
  const tag = state.status === 'rolled-back' ? ' [rolled back]' : '';
  return `${indent}${icon} ${state.title}${tag}${state.message ? `: ${state.message}` : ''}`;
}

/** ` [retry 1/3]` or ` [rolling back]` after a running task's title. */
const activeTag = (state: PadroneTaskState) =>
  state.status === 'rolling-back' ? ' [rolling back]' : state.retry ? ` [retry ${state.retry.count}/${state.retry.tries}]` : '';

/**
 * Prints task lists as plain lines on stderr, like listr2's simple renderer: `❯ Title` when a task starts, `  › message`
 * for updates, `↻` for retries, then `✔` / `✖` / `↓` / `↩` when it finishes. Used by `createTerminalTaskList` when stderr
 * can't be redrawn (not a TTY, `TERM=dumb`, CI), and usable as `taskRenderer` to get log-friendly output everywhere.
 */
export const createSimpleTaskList: PadroneTaskListRenderer = (tasks) => {
  const stderr = (globalThis.process as NodeJS.Process | undefined)?.stderr;
  const write = (line: string) => stderr?.write?.(`${line}\n`);
  const seen = new Map<PadroneTaskState, { status: PadroneTaskStatus; message?: string; retry?: number }>();

  const report = (state: PadroneTaskState, indent: string) => {
    const prev = seen.get(state);
    if (prev && prev.status === state.status && prev.message === state.message && prev.retry === state.retry?.count) return;
    seen.set(state, { status: state.status, message: state.message, retry: state.retry?.count });
    if (state.status === 'pending') return;
    if (isFinished(state)) return write(finishedLine(state, indent));
    if (state.status === 'rolling-back') return write(`${indent}↩ ${state.title}${activeTag(state)}`);
    if (state.retry && prev?.retry !== state.retry.count) {
      return write(`${indent}↻ ${state.title}${activeTag(state)}${state.message ? `: ${state.message}` : ''}`);
    }
    if (prev?.status !== 'running') return write(`${indent}❯ ${state.title}`);
    if (state.message) write(`${indent}  › ${state.message}`);
  };

  // A task's start comes before its subtasks' lines, its result after them
  const flush = (list: readonly PadroneTaskState[], indent: string) => {
    for (const state of list) {
      if (!isFinished(state)) report(state, indent);
      flush(state.subtasks, `${indent}  `);
      if (isFinished(state)) report(state, indent);
    }
  };
  return { update: () => flush(tasks, ''), pause() {}, resume() {}, done: () => flush(tasks, '') };
};

/**
 * Draws tasks on stderr: a live list with spinners on a TTY, redrawn as tasks progress.
 * Without a TTY (or with `TERM=dumb`, or in CI), it prints plain start and finish lines instead (`createSimpleTaskList`).
 */
export const createTerminalTaskList: PadroneTaskListRenderer = (tasks, options) => {
  const stderr = (globalThis.process as NodeJS.Process | undefined)?.stderr;
  if (!stderr || !canAnimate(stderr)) return createSimpleTaskList(tasks, options);

  const write = stderr.write.bind(stderr);
  const startedAt = Date.now();
  let lineCount = 0;
  let paused = false;
  let finished = false;

  const lines = (list: readonly PadroneTaskState[], indent: string): string[] =>
    list.flatMap((state) => {
      const spinner = SPINNER[Math.floor((Date.now() - startedAt) / 80) % SPINNER.length]!;
      const head = isActive(state)
        ? `${indent}${spinner} ${state.title}${activeTag(state)}`
        : state.status === 'pending'
          ? `${indent}${ICONS.pending} ${state.title}`
          : finishedLine(state, indent);
      const detail = isActive(state) && state.message ? [`${indent}  › ${state.message}`] : [];
      const collapsed = options?.collapseSubtasks && (state.status === 'done' || state.status === 'skipped');
      return [head, ...detail, ...(collapsed ? [] : lines(state.subtasks, `${indent}  `))];
    });

  const clear = () => {
    for (let i = 0; i < lineCount; i++) write(i === 0 ? '\x1b[2K\r' : '\x1b[1A\x1b[2K\r');
    lineCount = 0;
  };

  const render = () => {
    if (paused || finished) return;
    const columns = stderr.columns || 80;
    // One row per line, so `clear()` erases all of them
    const block = lines(tasks, '')
      .flatMap((line) => line.split('\n'))
      .map((line) => truncate(line, columns - 1));
    clear();
    write(block.join('\n'));
    lineCount = block.length;
  };

  const timer = setInterval(render, 80);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();

  return {
    update: render,
    pause() {
      if (paused || finished) return;
      clear();
      paused = true;
    },
    resume() {
      if (!paused || finished) return;
      paused = false;
      render();
    },
    done() {
      if (finished) return;
      clearInterval(timer);
      paused = false;
      render();
      finished = true;
      if (lineCount > 0) write('\n');
      lineCount = 0;
    },
  };
};
