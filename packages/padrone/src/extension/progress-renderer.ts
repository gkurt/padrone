import type {
  PadroneBarConfig,
  PadroneProgress,
  PadroneProgressOptions,
  PadroneProgressShow,
  PadroneProgressUpdate,
  PadroneSpinnerConfig,
  PadroneSpinnerPreset,
} from '../core/runtime.ts';

// ---------------------------------------------------------------------------
// Spinner presets & resolution
// ---------------------------------------------------------------------------

const spinnerPresets: Record<PadroneSpinnerPreset, string[]> = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  line: ['-', '\\', '|', '/'],
  arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
  bounce: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
};

type ResolvedSpinnerConfig = { frames: string[]; interval: number; show: PadroneProgressShow };

function resolveSpinnerConfig(config?: PadroneSpinnerConfig): ResolvedSpinnerConfig {
  if (config === false) return { frames: [], interval: 80, show: 'never' };
  if (config === true) return { frames: spinnerPresets.dots, interval: 80, show: 'always' };
  if (typeof config === 'string') return { frames: spinnerPresets[config], interval: 80, show: 'auto' };
  if (typeof config === 'object') {
    return {
      frames: config.frames ?? spinnerPresets.dots,
      interval: config.interval ?? 80,
      show: config.show ?? 'auto',
    };
  }
  return { frames: spinnerPresets.dots, interval: 80, show: 'auto' };
}

// ---------------------------------------------------------------------------
// Bar resolution & rendering
// ---------------------------------------------------------------------------

type ResolvedBarConfig = {
  width: number;
  filled: string;
  empty: string;
  animation: 'bounce' | 'slide' | 'pulse';
  show: PadroneProgressShow;
};

const defaultBarConfig: ResolvedBarConfig = { width: 20, filled: '█', empty: '░', animation: 'bounce', show: 'auto' };

function resolveBarConfig(bar: boolean | PadroneBarConfig | undefined): ResolvedBarConfig | undefined {
  if (bar === false) return undefined;
  if (!bar) return { ...defaultBarConfig };
  if (bar === true) return { ...defaultBarConfig, show: 'always' };
  return {
    width: Math.max(1, Math.floor(bar.width ?? 20)),
    filled: bar.filled ?? '█',
    empty: bar.empty ?? '░',
    animation: bar.animation ?? 'bounce',
    show: bar.show ?? 'always',
  };
}

const SEGMENT_RATIO = 0.25;
const pulseGradient = ['░', '▒', '▓', '█', '▓', '▒', '░'];

function formatIndeterminate(cfg: ResolvedBarConfig, frame: number): string {
  const { width, filled, empty, animation } = cfg;
  const pad = ''.padStart(4);

  if (animation === 'pulse') {
    const idx = frame % pulseGradient.length;
    return `${pad} ${pulseGradient[idx]!.repeat(width)}`;
  }

  const seg = Math.min(width, Math.max(2, Math.round(width * SEGMENT_RATIO)));
  const travel = width - seg;
  if (travel === 0) return `${pad} ${filled.repeat(width)}`;

  if (animation === 'slide') {
    const offset = frame % (travel + 1);
    return `${pad} ${empty.repeat(offset)}${filled.repeat(seg)}${empty.repeat(travel - offset)}`;
  }

  // bounce (default)
  const cycle = travel * 2;
  const pos = frame % cycle;
  const offset = pos <= travel ? pos : cycle - pos;
  return `${pad} ${empty.repeat(offset)}${filled.repeat(seg)}${empty.repeat(width - offset - seg)}`;
}

function formatBar(progress: number | undefined, cfg: ResolvedBarConfig, frame: number): string {
  if (progress === undefined) return formatIndeterminate(cfg, frame);
  const { width, filled, empty } = cfg;
  const clamped = Number.isNaN(progress) ? 0 : Math.max(0, Math.min(1, progress));
  const filledCount = Math.round(clamped * width);
  const pct = `${Math.round(clamped * 100)}%`.padStart(4);
  return `${pct} ${filled.repeat(filledCount)}${empty.repeat(width - filledCount)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseUpdate(value: PadroneProgressUpdate): { message?: string; progress?: number; indeterminate?: boolean; time?: boolean } {
  if (typeof value === 'string') return { message: value };
  if (typeof value === 'number') return { progress: value };
  return value;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function estimateEta(samples: { time: number; progress: number }[]): number | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const progressDelta = last.progress - first.progress;
  if (progressDelta <= 0) return undefined;
  const timeDelta = last.time - first.time;
  const rate = progressDelta / timeDelta;
  const remaining = 1 - last.progress;
  if (remaining <= 0) return 0;
  return remaining / rate;
}

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

/** Factory function that creates a `PadroneProgress`. */
export type PadroneProgressRenderer = (message: string, options?: PadroneProgressOptions) => PadroneProgress;

// ---------------------------------------------------------------------------
// Default terminal renderer
// ---------------------------------------------------------------------------

/**
 * Creates a terminal progress indicator (spinner, bar, or both).
 * When stderr is not a TTY, nothing is animated and only the final success/error line is printed.
 */
export function createTerminalProgress(message: string, options?: PadroneProgressOptions): PadroneProgress {
  const spinnerCfg = resolveSpinnerConfig(options?.spinner);
  const successIcon = options?.successIndicator ?? '✔';
  const errorIcon = options?.errorIndicator ?? '✖';
  const barCfg = resolveBarConfig(options?.bar);

  const formatFinal = (icon: string, msg: string) => (icon ? `${icon} ${msg}\n` : `${msg}\n`);

  const proc = globalThis.process as NodeJS.Process | undefined;
  if (!proc?.stderr?.isTTY) {
    // No animation: only the final status line is printed, using the latest message.
    let text = message;
    let done = false;
    const finish = (msg: string | null | undefined, icon: string) => {
      if (done) return;
      done = true;
      const finalMsg = msg === null ? '' : (msg ?? text);
      if (finalMsg) proc?.stderr?.write?.(formatFinal(icon, finalMsg));
    };
    return {
      update(value) {
        const { message: msg } = parseUpdate(value);
        if (msg !== undefined) text = msg;
      },
      eta: { start() {}, stop() {}, reset() {} },
      succeed: (msg, opts) => finish(msg, opts?.indicator ?? successIcon),
      fail: (msg, opts) => finish(msg, opts?.indicator ?? errorIcon),
      stop() {
        done = true;
      },
      pause() {},
      resume() {},
    };
  }

  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires matching ESC
  const ansiPattern = /\x1b\[[0-9;]*m/g;

  const showTime = options?.time ?? false;
  let etaEnabled = options?.eta ?? false;

  const createdAt = Date.now();
  let barFrame = 0;
  let text = message;
  let progress: number | undefined;
  let indeterminate = false;
  let stopped = false;
  let paused = false;
  let timeEnabled = showTime;
  let startTime = showTime ? Date.now() : 0;
  const etaSamples: { time: number; progress: number }[] = [];
  let etaMs: number | undefined;
  let etaCalculatedAt = 0;

  const stderr = proc.stderr;
  const writeStderr = stderr.write.bind(stderr);
  let prevLineCount = 0;

  const clearLines = () => {
    if (prevLineCount > 1) {
      // Move cursor up and clear each wrapped line above the current one
      for (let i = 1; i < prevLineCount; i++) writeStderr('\x1b[1A\x1b[2K');
    }
    writeStderr('\x1b[2K\r');
    prevLineCount = 0;
  };

  /** Count how many terminal rows `str` occupies, accounting for line wrapping. */
  const lineCount = (str: string): number => {
    const cols = stderr.columns || 80;
    // Strip ANSI escape sequences for accurate width measurement
    const visible = str.replace(ansiPattern, '');
    return Math.max(1, Math.ceil(visible.length / cols));
  };

  const render = () => {
    if (paused || stopped) return;

    const barVisible = barCfg && (barCfg.show === 'always' || (barCfg.show === 'auto' && (progress !== undefined || indeterminate)));
    const spinnerVisible = spinnerCfg.show === 'always' || (spinnerCfg.show === 'auto' && !barVisible);

    let line = '';
    if (barVisible) line += formatBar(progress, barCfg!, barFrame);
    const hasEta = etaEnabled && progress !== undefined && progress < 1 && etaMs !== undefined;
    if (timeEnabled || hasEta) {
      const parts: string[] = [];
      if (timeEnabled) parts.push(`⏱ ${formatDuration(Date.now() - startTime)}`);
      if (hasEta) {
        const elapsed = Date.now() - etaCalculatedAt;
        parts.push(`ETA ${formatDuration(Math.max(0, etaMs! - elapsed))}`);
      }
      if (line) line += ' ';
      line += parts.join(' | ');
    }
    if (spinnerVisible) {
      if (line) line += ' ';
      // Derived from elapsed time so the spinner keeps its own speed when the bar ticks faster
      const spinnerFrame = Math.floor((Date.now() - createdAt) / spinnerCfg.interval) % (frames.length || 1);
      line += frames[spinnerFrame] ?? '';
    }
    if (text) {
      if (line) line += ' ';
      line += text;
    }

    if (line) {
      clearLines();
      writeStderr(line);
      prevLineCount = lineCount(line);
    } else {
      clearLines();
    }
  };

  const { frames } = spinnerCfg;
  const barAnimated = !!barCfg && barCfg.show !== 'never';
  const tickInterval = barAnimated ? Math.min(80, spinnerCfg.interval) : spinnerCfg.interval;

  let timer: ReturnType<typeof setInterval> | undefined;
  /** Starts the redraw loop. Also needed without spinner/bar so elapsed time and ETA keep counting. */
  const ensureTimer = () => {
    if (timer || stopped) return;
    timer = setInterval(() => {
      barFrame++;
      render();
    }, tickInterval);
    // Prevent the timer from keeping the process alive on uncaught errors
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  };

  if (spinnerCfg.show !== 'never' || barAnimated || timeEnabled || etaEnabled) ensureTimer();
  render();

  const clear = () => {
    if (stopped) return;
    stopped = true;
    paused = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    clearLines();
  };

  const eta = {
    start() {
      if (stopped) return;
      etaEnabled = true;
      ensureTimer();
      render();
    },
    stop() {
      if (stopped) return;
      etaEnabled = false;
      etaMs = undefined;
      render();
    },
    reset() {
      if (stopped) return;
      etaSamples.length = 0;
      etaMs = undefined;
      etaCalculatedAt = 0;
      render();
    },
  };

  return {
    update(value) {
      if (stopped) return;
      const parsed = parseUpdate(value);
      if (parsed.message !== undefined) text = parsed.message;
      if (parsed.progress !== undefined) {
        progress = parsed.progress;
        if (etaEnabled) {
          const now = Date.now();
          // Progress moved backwards (a new phase started): estimate from scratch
          if (parsed.progress < (etaSamples[etaSamples.length - 1]?.progress ?? 0)) etaSamples.length = 0;
          // Only the first and latest samples are used
          if (etaSamples.length > 1) etaSamples.pop();
          etaSamples.push({ time: now, progress: parsed.progress });
          const estimated = estimateEta(etaSamples);
          if (estimated !== undefined) {
            etaMs = estimated;
            etaCalculatedAt = now;
          }
        }
      }
      if (parsed.indeterminate !== undefined) {
        indeterminate = parsed.indeterminate;
        if (indeterminate) progress = undefined;
      }
      if (parsed.time !== undefined) {
        if (parsed.time && !timeEnabled) {
          timeEnabled = true;
          startTime = Date.now();
          ensureTimer();
        } else if (!parsed.time) {
          timeEnabled = false;
        }
      }
      render();
    },
    eta,
    succeed(msg, opts) {
      if (stopped) return;
      clear();
      if (msg === null) return;
      const finalMsg = msg ?? text;
      const icon = opts?.indicator ?? successIcon;
      if (finalMsg) writeStderr(formatFinal(icon, finalMsg));
    },
    fail(msg, opts) {
      if (stopped) return;
      clear();
      if (msg === null) return;
      const finalMsg = msg ?? text;
      const icon = opts?.indicator ?? errorIcon;
      if (finalMsg) writeStderr(formatFinal(icon, finalMsg));
    },
    stop() {
      clear();
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      clearLines();
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      render();
    },
  };
}
