/** The pager for this environment: `$PAGER`, then `fallback`, then `less -FRX` (none on Windows). `''` or `cat` means none. */
export function resolvePager(env: Record<string, string | undefined>, fallback?: string): string | undefined {
  const pager = env.PAGER ?? fallback ?? (typeof process !== 'undefined' && process.platform === 'win32' ? undefined : 'less -FRX');
  const trimmed = pager?.trim();
  return !trimmed || trimmed === 'cat' ? undefined : trimmed;
}

/** Exit code of a shell that couldn't find the command. */
const COMMAND_NOT_FOUND = 127;

/**
 * Shows `text` through `pager` (a shell command, like git's `core.pager`), waiting until it exits.
 * Resolves `false` when the pager couldn't be started, so the caller can print the text instead.
 */
export async function pageText(text: string, pager: string, env: Record<string, string | undefined>): Promise<boolean> {
  let spawn: typeof import('node:child_process').spawn;
  try {
    ({ spawn } = await import('node:child_process'));
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // `less` defaults like git: quit if one screen, keep colors, don't clear the screen
      child = spawn(pager, {
        shell: true,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...env, LESS: env.LESS ?? 'FRX', LV: env.LV ?? '-c' },
      });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code !== COMMAND_NOT_FOUND));
    // The pager may exit before reading everything (the user quit)
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);
  });
}

/** Options for `runtime.page()`. */
export type PadronePageOptions = {
  /** Page even when the text fits the terminal. */
  always?: boolean;
  /** The pager command when `$PAGER` isn't set. Defaults to `less -FRX` (none on Windows). */
  pager?: string;
};

type PageRuntime = {
  output: (...args: unknown[]) => void;
  env: () => Record<string, string | undefined>;
  format?: string;
  terminal?: { rows?: number; isTTY?: boolean };
};

/**
 * Shows `text` through the pager when it doesn't fit the terminal (or `always`), like `git log`; otherwise, and without
 * a terminal or a pager, it's written with `runtime.output`. Resolves once the pager exits.
 */
export async function pageWithRuntime(runtime: PageRuntime, text: string, options: PadronePageOptions = {}): Promise<void> {
  const rows = runtime.terminal?.rows;
  const fits = !rows || text.split('\n').length < rows;
  const usable = runtime.terminal?.isTTY === true && runtime.format !== 'json' && (options.always || !fits);
  const env = runtime.env();
  const command = usable ? resolvePager(env, options.pager) : undefined;
  if (command && (await pageText(text, command, env))) return;
  runtime.output(text);
}
