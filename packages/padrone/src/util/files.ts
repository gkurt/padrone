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

/** A short reason a file couldn't be read (`file not found`), for error messages. */
export function fileErrorReason(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === 'ENOENT') return 'file not found';
  if (code === 'EISDIR') return 'is a directory';
  if (code === 'EACCES') return 'permission denied';
  return err instanceof Error ? err.message : String(err);
}
