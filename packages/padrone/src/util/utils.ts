import type { AnyPadroneCommand } from '../types/index.ts';

export function getRootCommand(cmd: AnyPadroneCommand): AnyPadroneCommand {
  let current = cmd;
  while (current.parent) current = current.parent;
  return current;
}

/** Whether the environment is CI: `CI` or `CONTINUOUS_INTEGRATION` set to anything but `0` or `false`, like is-in-ci. */
export function isCI(env: Record<string, string | undefined>): boolean {
  const on = (value?: string) => !!value && value !== '0' && value.toLowerCase() !== 'false';
  return on(env.CI) || on(env.CONTINUOUS_INTEGRATION);
}

/**
 * The version of the package the running script belongs to: walks up from the script path (`process.argv[1]`, symlinks
 * resolved) to the nearest `package.json` with a `name`. Never the working directory, which is the user's project.
 * Resolves `undefined` without a script on disk (a compiled binary, the browser).
 */
export async function readScriptVersion(scriptPath: string | undefined = globalThis.process?.argv?.[1]): Promise<string | undefined> {
  if (!scriptPath) return undefined;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    let dir = path.dirname(fs.realpathSync(scriptPath));
    while (true) {
      const file = path.join(dir, 'package.json');
      const pkg = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as { name?: unknown; version?: unknown }) : undefined;
      if (typeof pkg?.name === 'string') return typeof pkg.version === 'string' ? pkg.version : undefined;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

/**
 * The program's version: the configured one (`.configure({ version })`), otherwise that of the package its script belongs
 * to (`readScriptVersion`), otherwise `'0.0.0'`. Synchronous when a version is configured.
 */
export function getVersion(explicitVersion?: string): string | Promise<string> {
  if (explicitVersion) return explicitVersion;
  return readScriptVersion().then((version) => version ?? '0.0.0');
}
