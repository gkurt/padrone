import { shellQuote } from '#src/util/shell-utils.ts';

/** Options for `runtime.editor()`. */
export type PadroneEditorOptions = {
  /** File extension for the temporary file, so the editor picks the right mode (e.g. `'.md'`). Defaults to `'.txt'`. */
  extension?: string;
};

/**
 * Opens `text` in the user's editor (`$VISUAL`, `$EDITOR`, then `vi` / `notepad`), waits for it to close and resolves
 * with the saved text, like `git commit`. Rejects when the editor exits with an error.
 */
export async function openInEditor(
  text: string,
  env: Record<string, string | undefined>,
  options: PadroneEditorOptions = {},
): Promise<string> {
  const [{ spawn }, fs, os, path] = await Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
  const windows = process.platform === 'win32';
  const editor = env.VISUAL || env.EDITOR || (windows ? 'notepad' : 'vi');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-'));
  const extension = options.extension ? (options.extension.startsWith('.') ? options.extension : `.${options.extension}`) : '.txt';
  const file = path.join(dir, `edit${extension}`);
  try {
    fs.writeFileSync(file, text, 'utf-8');
    // Through the shell, so an editor with arguments (`code --wait`) works
    const quoted = windows ? `"${file}"` : shellQuote(file);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(`${editor} ${quoted}`, { shell: true, stdio: 'inherit', env: env as NodeJS.ProcessEnv });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error(`Editor "${editor}" exited with code ${code}`);
    return fs.readFileSync(file, 'utf-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The command that opens `target` on `platform`. On Windows it's `cmd /d /s /c "start "" ^"<target>^""`, spawned with
 * `windowsVerbatimArguments`: every cmd metacharacter of the target (`&`, `|`, `%`, `^`, spaces, …) is `^`-escaped so cmd
 * passes it to `start` literally, and a `"` (not valid in paths) is URL-encoded. Targets with control characters are refused,
 * and on other platforms a target starting with `-` gets a `./` so it isn't taken as an option.
 */
export function systemOpenCommand(target: string, platform: string = process.platform): [command: string, args: string[]] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(target)) throw new Error('Cannot open a target with control characters');
  // A leading dash would be read as an option by `open` / `xdg-open`
  const arg = target.startsWith('-') ? `./${target}` : target;
  if (platform === 'darwin') return ['open', [arg]];
  if (platform !== 'win32') return ['xdg-open', [arg]];
  const escaped = `"${target.replace(/"/g, '%22')}"`.replace(/[()[\]%!^"`<>&|;, *?]/g, '^$&');
  return ['cmd', ['/d', '/s', '/c', `"start "" ${escaped}"`]];
}

/** Opens a URL or file with the system's default app (`open`, `xdg-open` or `start`), without waiting for it. */
export async function openWithSystem(target: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const platform = process.platform;
  const [command, args] = systemOpenCommand(target, platform);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: platform === 'win32' });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
