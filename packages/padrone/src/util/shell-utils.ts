/**
 * Convert a camelCase string to kebab-case.
 * Returns null if the string has no uppercase letters (no conversion needed).
 */
export function camelToKebab(str: string): string | null {
  if (!/[A-Z]/.test(str)) return null;
  return str.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/** The long names an option is offered as, like help shows them: the kebab-case alias in place of a camelCase name, then the other aliases. */
export function offeredLongNames(name: string, aliases: readonly string[]): string[] {
  const kebab = camelToKebab(name);
  const primary = kebab && aliases.includes(kebab) ? kebab : name;
  return [primary, ...aliases.filter((alias) => alias !== primary)];
}

export type ShellType = 'bash' | 'zsh' | 'fish' | 'powershell';

/**
 * Detects the current shell from environment variables and process info.
 * @returns The detected shell type, or undefined if unknown
 */
export async function detectShell(): Promise<ShellType | undefined> {
  if (typeof process === 'undefined') return undefined;

  // Method 1: Check SHELL environment variable (most common)
  const shellEnv = process.env.SHELL || '';
  if (shellEnv.includes('zsh')) return 'zsh';
  if (shellEnv.includes('bash')) return 'bash';
  if (shellEnv.includes('fish')) return 'fish';

  // Method 2: Check Windows-specific shells
  if (process.env.PSModulePath || process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
    return 'powershell';
  }

  // Method 3: Check parent process on Unix-like systems
  try {
    const ppid = process.ppid;
    if (ppid) {
      const { execSync } = (await import('node:child_process')) as typeof import('node:child_process');
      const processName = execSync(`ps -p ${ppid} -o comm=`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      if (processName.includes('zsh')) return 'zsh';
      if (processName.includes('bash')) return 'bash';
      if (processName.includes('fish')) return 'fish';
    }
  } catch {
    // Ignore errors (e.g., ps not available)
  }

  return undefined;
}

export async function getRcFile(
  shell: ShellType,
  home?: string,
  env: Record<string, string | undefined> | undefined = globalThis.process?.env,
): Promise<string | null> {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const h = home ?? homedir();
  switch (shell) {
    case 'bash':
      return join(h, '.bashrc');
    case 'zsh':
      return join(h, '.zshrc');
    case 'fish':
      return join(h, '.config', 'fish', 'config.fish');
    case 'powershell':
      return env?.PROFILE || join(h, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
    default:
      return null;
  }
}

/** Quotes text as one word for a POSIX shell (`it's` → `'it'\''s'`). */
export const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Writes a snippet to a shell config file using begin/end markers for idempotency.
 * If a block with the same begin marker exists, it is replaced. Otherwise the snippet is appended.
 */
export async function writeToRcFile(
  rcFile: string,
  snippet: string,
  beginMarker: string,
  endMarker: string,
): Promise<{ file: string; updated: boolean }> {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const existing = existsSync(rcFile) ? readFileSync(rcFile, 'utf-8') : '';

  if (existing.includes(beginMarker)) {
    const pattern = new RegExp(`${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`);
    writeFileSync(
      rcFile,
      existing.replace(pattern, () => snippet),
    );
    return { file: rcFile, updated: true };
  }

  mkdirSync(dirname(rcFile), { recursive: true });
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(rcFile, `${existing}${separator}\n${snippet}\n`);
  return { file: rcFile, updated: false };
}
