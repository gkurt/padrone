// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PadroneTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** Live state of a task, read by task list renderers. */
export type PadroneTaskState = {
  readonly title: string;
  readonly status: PadroneTaskStatus;
  /** The latest `update()` message while running; the skip reason or error message after. */
  readonly message?: string;
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
};

export type PadroneTask = {
  title: string;
  task: (task: PadroneTaskContext) => unknown;
  /** Skip the task: `true`, or a reason. A function is called when the task's turn comes. */
  skip?: boolean | string | (() => boolean | string | Promise<boolean | string>);
};

export type PadroneTasksOptions = {
  /** Run tasks at the same time: `true` for all of them, or at most this many. Defaults to `false` (one after another). */
  concurrent?: boolean | number;
  /**
   * Stop starting tasks once one fails, and reject with its error. With `false`, every task runs and the first
   * failure is thrown at the end. Defaults to `true`.
   */
  exitOnError?: boolean;
};

/** Draws a task list. `update()` is called on every change; `done()` once every task settled. */
export type PadroneTaskListRenderer = (tasks: readonly PadroneTaskState[]) => {
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

type MutableTaskState = { title: string; status: PadroneTaskStatus; message?: string; subtasks: MutableTaskState[] };

class SkipSignal {
  constructor(readonly reason?: string) {}
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
    state.message = err instanceof Error ? err.message : String(err);
    errors.push(err);
  };

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

    state.status = 'running';
    notify();
    const context: PadroneTaskContext = {
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
    };
    try {
      await task.task(context);
      state.status = 'done';
      state.message = undefined;
    } catch (err) {
      if (err instanceof SkipSignal) {
        state.status = 'skipped';
        state.message = err.reason;
      } else {
        fail(state, err);
      }
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
// Terminal renderer
// ---------------------------------------------------------------------------

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ICONS: Record<Exclude<PadroneTaskStatus, 'running'>, string> = { pending: '◻', done: '✔', failed: '✖', skipped: '↓' };

function finishedLine(state: PadroneTaskState, indent: string): string {
  const reason = state.message ? (state.status === 'skipped' ? ` [skipped: ${state.message}]` : `: ${state.message}`) : '';
  return `${indent}${ICONS[state.status as keyof typeof ICONS]} ${state.title}${state.status === 'skipped' && !state.message ? ' [skipped]' : reason}`;
}

/**
 * Draws tasks on stderr: a live list with spinners on a TTY, redrawn as tasks progress.
 * Without a TTY, each task is printed once it finishes.
 */
export const createTerminalTaskList: PadroneTaskListRenderer = (tasks) => {
  const proc = globalThis.process as NodeJS.Process | undefined;
  const stderr = proc?.stderr;

  if (!stderr?.isTTY) {
    const printed = new Set<PadroneTaskState>();
    const flush = (list: readonly PadroneTaskState[], indent: string) => {
      for (const state of list) {
        flush(state.subtasks, `${indent}  `);
        if (printed.has(state) || state.status === 'pending' || state.status === 'running') continue;
        printed.add(state);
        stderr?.write?.(`${finishedLine(state, indent)}\n`);
      }
    };
    return { update: () => flush(tasks, ''), pause() {}, resume() {}, done: () => flush(tasks, '') };
  }

  const write = stderr.write.bind(stderr);
  const startedAt = Date.now();
  let lineCount = 0;
  let paused = false;
  let finished = false;

  const lines = (list: readonly PadroneTaskState[], indent: string): string[] =>
    list.flatMap((state) => {
      const spinner = SPINNER[Math.floor((Date.now() - startedAt) / 80) % SPINNER.length]!;
      const head =
        state.status === 'running'
          ? `${indent}${spinner} ${state.title}`
          : state.status === 'pending'
            ? `${indent}${ICONS.pending} ${state.title}`
            : finishedLine(state, indent);
      const detail = state.status === 'running' && state.message ? [`${indent}  › ${state.message}`] : [];
      return [head, ...detail, ...lines(state.subtasks, `${indent}  `)];
    });

  const clear = () => {
    for (let i = 0; i < lineCount; i++) write(i === 0 ? '\x1b[2K\r' : '\x1b[1A\x1b[2K\r');
    lineCount = 0;
  };

  const render = () => {
    if (paused || finished) return;
    const columns = stderr.columns || 80;
    const block = lines(tasks, '').map((line) => (line.length >= columns ? `${line.slice(0, columns - 2)}…` : line));
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
