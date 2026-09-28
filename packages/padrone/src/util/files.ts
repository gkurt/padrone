type NodeFs = typeof import('node:fs');

// Loaded synchronously where the runtime allows it (`process.getBuiltinModule`), else eagerly in the background
let fs: NodeFs | undefined = globalThis.process?.getBuiltinModule?.('node:fs');
if (!fs && typeof process !== 'undefined') {
  import('node:fs').then(
    (mod) => {
      fs ??= mod;
    },
    () => {},
  );
}

/** Reads a UTF-8 file (a relative path is relative to cwd): synchronously once `node:fs` is loaded. */
export function readTextFile(path: string): string | Promise<string> {
  if (fs) return fs.readFileSync(path, 'utf-8');
  return import('node:fs').then((mod) => (fs ??= mod).readFileSync(path, 'utf-8'));
}

/** Appends UTF-8 text to a file, creating it: synchronously once `node:fs` is loaded. */
export function appendTextFile(path: string, text: string): void | Promise<void> {
  if (fs) return fs.appendFileSync(path, text, 'utf-8');
  return import('node:fs').then((mod) => (fs ??= mod).appendFileSync(path, text, 'utf-8'));
}

/** A short reason a file couldn't be read (`file not found`), for error messages. */
export function fileErrorReason(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === 'ENOENT') return 'file not found';
  if (code === 'EISDIR') return 'is a directory';
  if (code === 'EACCES') return 'permission denied';
  return err instanceof Error ? err.message : String(err);
}

/**
 * Writes `text` to `path` through a temp file and a rename, so a reader never sees half a file, creating the directory
 * (mode `0700` with `private`, and the file `0600`). The temp file is removed when the rename fails.
 */
export async function writeTextFileAtomic(path: string, text: string, options: { private?: boolean } = {}): Promise<void> {
  const [nodeFs, nodePath] = await Promise.all([import('node:fs'), import('node:path')]);
  nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true, ...(options.private && { mode: 0o700 }) });
  const temp = `${path}.${globalThis.process?.pid ?? 0}.${Date.now()}.tmp`;
  nodeFs.writeFileSync(temp, text, { encoding: 'utf-8', flag: 'wx', ...(options.private && { mode: 0o600 }) });
  try {
    nodeFs.renameSync(temp, path);
  } catch (err) {
    nodeFs.rmSync(temp, { force: true });
    throw err;
  }
}
