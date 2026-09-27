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
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(`${editor} "${file}"`, { shell: true, stdio: 'inherit', env: env as NodeJS.ProcessEnv });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error(`Editor "${editor}" exited with code ${code}`);
    return fs.readFileSync(file, 'utf-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Opens a URL or file with the system's default app (`open`, `xdg-open` or `start`), without waiting for it. */
export async function openWithSystem(target: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const platform = process.platform;
  const [command, args] =
    platform === 'darwin'
      ? ['open', [target]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', target.replace(/&/g, '^&')]]
        : ['xdg-open', [target]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: platform === 'win32' });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
