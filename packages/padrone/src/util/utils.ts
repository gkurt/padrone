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

async function readVersionFromPackageJson(): Promise<string> {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    let dir = process.cwd();

    // Walk up the directory tree looking for package.json
    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.version) return pkg.version;
      }
      const parentDir = path.dirname(dir);
      if (parentDir === dir) break; // Reached root
      dir = parentDir;
    }
  } catch {
    // Ignore errors (e.g., fs not available in browser)
  }
  return '0.0.0';
}

/**
 * Attempts to get the version from various sources:
 * 1. Explicit version set on the command
 * 2. npm_package_version environment variable (set by npm/yarn/pnpm when running scripts)
 * 3. package.json in current or parent directories
 *
 * Returns synchronously when an explicit version or env var is available.
 * Falls back to async package.json discovery otherwise.
 */
export function getVersion(explicitVersion?: string): string | Promise<string> {
  if (explicitVersion) return explicitVersion;

  if (typeof process !== 'undefined' && process.env?.npm_package_version) {
    return process.env.npm_package_version;
  }

  if (typeof process !== 'undefined') return readVersionFromPackageJson();

  return '0.0.0';
}
