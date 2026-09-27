import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import * as z from 'zod/v4';
import type { PadroneActionContext } from '../types/index.ts';
import { detectShell, getRcFile, type ShellType, shellQuote, writeToRcFile } from '../util/shell-utils.ts';

export const linkSchema = z.object({
  entry: z.string().optional().describe('Entry file (auto-detected from package.json bin field)'),
  name: z.string().optional().describe('Command name (auto-detected from package.json)'),
  script: z.string().optional().describe('Use a package.json script instead of bin entry (e.g. "start", "dev")'),
  pm: z.enum(['bun', 'npm', 'pnpm', 'yarn']).optional().describe('Package manager to use (auto-detected from lockfile)'),
  list: z.boolean().optional().default(false).describe('List all linked programs'),
  setup: z.boolean().optional().default(false).describe('Add ~/.padrone/bin to PATH in shell config'),
});

export const unlinkSchema = z.object({
  name: z.string().optional().describe('Program name to unlink (auto-detected from current directory)'),
});

type LinkArgs = z.infer<typeof linkSchema>;
type UnlinkArgs = z.infer<typeof unlinkSchema>;

interface LinkEntry {
  name: string;
  entry: string;
  dir: string;
  linkedAt: string;
}

type LinksData = Record<string, LinkEntry>;

function sanitizeBinName(name: string): string {
  // Strip npm scope (@org/name → name)
  const unscoped = name.startsWith('@') ? name.split('/').pop()! : name;
  // Replace any remaining path-unsafe chars
  return unscoped.replace(/[^a-zA-Z0-9._-]/g, '-');
}

const PADRONE_HOME = resolve(homedir(), '.padrone');
const BIN_DIR = resolve(PADRONE_HOME, 'bin');
const LINKS_FILE = resolve(PADRONE_HOME, 'links.json');

function readLinks(): LinksData {
  if (!existsSync(LINKS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LINKS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeLinks(links: LinksData) {
  mkdirSync(PADRONE_HOME, { recursive: true });
  writeFileSync(LINKS_FILE, `${JSON.stringify(links, null, 2)}\n`);
}

export interface DetectedEntry {
  entry: string;
  name: string;
  /** Full run command prefix parsed from scripts (e.g. "bun --conditions=padrone@dev") */
  runPrefix?: string;
  /** When set, the shim should run this script via the package manager instead of the entry directly */
  scriptCommand?: string;
}

function parseRunPrefix(script: string, entryRelative: string, dir: string): string | undefined {
  // Split script into tokens and find the one that resolves to the same path as the entry
  const entryResolved = resolve(dir, entryRelative);
  const tokens = script.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (resolve(dir, token) === entryResolved) {
      const prefix = tokens.slice(0, i).join(' ');
      return prefix || undefined;
    }
  }
  return undefined;
}

export function detectEntry(dir: string, options?: { script?: string }): DetectedEntry | undefined {
  const pkgPath = resolve(dir, 'package.json');
  if (!existsSync(pkgPath)) return undefined;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const scripts = pkg.scripts as Record<string, string> | undefined;

    // When --script is specified, use the package.json script directly
    if (options?.script) {
      const scriptName = options.script;
      if (!scripts?.[scriptName]) return undefined;
      const name = pkg.name || basename(dir);
      return { entry: resolve(dir, 'package.json'), name, scriptCommand: scriptName };
    }

    let entryRelative: string | undefined;
    let name: string | undefined;

    // Try bin field first
    if (pkg.bin) {
      if (typeof pkg.bin === 'string') {
        entryRelative = pkg.bin;
        name = pkg.name || basename(dir);
      } else {
        const binEntries = Object.entries(pkg.bin);
        if (binEntries.length > 0) {
          [name, entryRelative] = binEntries[0] as [string, string];
        }
      }
    }

    // Fallback to main/module
    if (!entryRelative) {
      const main = pkg.module || pkg.main;
      if (main) {
        entryRelative = main;
        name = pkg.name || basename(dir);
      }
    }

    if (!entryRelative || !name) return undefined;

    // Check start/dev scripts for runtime flags
    let runPrefix: string | undefined;
    if (scripts) {
      for (const key of ['start', 'dev']) {
        if (scripts[key]) {
          runPrefix = parseRunPrefix(scripts[key], entryRelative!, dir);
          if (runPrefix) break;
        }
      }
    }

    return { entry: resolve(dir, entryRelative), name, runPrefix };
  } catch {
    // Invalid package.json
  }

  return undefined;
}

function isInPath(dir: string): boolean {
  const pathEnv = process.env.PATH || '';
  return pathEnv.split(':').includes(dir);
}

const PATH_BEGIN_MARKER = '###-begin-padrone-path-###';
const PATH_END_MARKER = '###-end-padrone-path-###';

function buildPathSnippet(shell: ShellType, binDir: string): string {
  switch (shell) {
    case 'fish':
      return `${PATH_BEGIN_MARKER}\nfish_add_path "${binDir}"\n${PATH_END_MARKER}`;
    case 'powershell':
      return `${PATH_BEGIN_MARKER}\n$env:PATH = "${binDir}" + [IO.Path]::PathSeparator + $env:PATH\n${PATH_END_MARKER}`;
    default:
      return `${PATH_BEGIN_MARKER}\nexport PATH="${binDir}:$PATH"\n${PATH_END_MARKER}`;
  }
}

async function setupPath(shell: ShellType): Promise<{ file: string; updated: boolean }> {
  const rcFile = await getRcFile(shell);
  if (!rcFile) {
    throw new Error(`Could not determine config file for ${shell}.`);
  }

  const snippet = buildPathSnippet(shell, BIN_DIR);
  return writeToRcFile(rcFile, snippet, PATH_BEGIN_MARKER, PATH_END_MARKER);
}

function detectPackageManager(dir: string): string {
  let current = dir;
  while (true) {
    if (existsSync(resolve(current, 'bun.lock')) || existsSync(resolve(current, 'bun.lockb'))) return 'bun';
    if (existsSync(resolve(current, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(resolve(current, 'yarn.lock'))) return 'yarn';
    if (existsSync(resolve(current, 'package-lock.json'))) return 'npm';
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return 'npm';
}

function detectRuntime(dir: string): string {
  const pm = detectPackageManager(dir);
  return pm === 'bun' ? 'bun' : 'node';
}

function createShim(name: string, entry: string, dir: string, runPrefix?: string, scriptCommand?: string, pm?: string) {
  mkdirSync(BIN_DIR, { recursive: true });
  const shimPath = resolve(BIN_DIR, sanitizeBinName(name));

  let shim: string;
  if (scriptCommand) {
    const resolvedPm = pm ?? detectPackageManager(dir);
    const cwdFlag = `${resolvedPm === 'npm' ? '--prefix' : resolvedPm === 'pnpm' ? '--dir' : '--cwd'}=${shellQuote(dir)}`;
    shim = [
      '#!/usr/bin/env sh',
      `# Linked by padrone — do not edit`,
      `${resolvedPm} ${cwdFlag} run ${shellQuote(scriptCommand)} -- "$@"`,
      '',
    ].join('\n');
  } else {
    const prefix = runPrefix ?? detectRuntime(dir);
    shim = ['#!/usr/bin/env sh', `# Linked by padrone — do not edit`, `${prefix} ${shellQuote(entry)} "$@"`, ''].join('\n');
  }

  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
}

function removeShim(name: string) {
  const shimPath = resolve(BIN_DIR, sanitizeBinName(name));
  if (existsSync(shimPath)) {
    rmSync(shimPath);
  }
}

export async function runLink(args: LinkArgs, ctx: PadroneActionContext) {
  const { output, error } = ctx.runtime;

  if (args.list) {
    const links = readLinks();
    const entries = Object.values(links);
    if (entries.length === 0) {
      output('No linked programs.');
      return;
    }
    output('Linked programs:');
    for (const link of entries) {
      output(`  ${link.name} → ${link.entry}`);
    }
    return;
  }

  const dir = process.cwd();

  let entry: string;
  let name: string;
  let runPrefix: string | undefined;
  let scriptCommand: string | undefined;

  const resolvedArg = args.entry ? resolve(dir, args.entry) : undefined;

  // Determine the target directory: if a folder or package.json was passed, use that
  let targetDir: string | undefined;
  if (resolvedArg) {
    if (existsSync(resolvedArg) && statSync(resolvedArg).isDirectory()) {
      targetDir = resolvedArg;
    } else if (basename(resolvedArg) === 'package.json' && existsSync(resolvedArg)) {
      targetDir = dirname(resolvedArg);
    }
  }

  if (targetDir || !resolvedArg) {
    // Detect entry from the target directory's package.json
    const detected = detectEntry(targetDir ?? dir, { script: args.script });
    if (!detected) {
      if (args.script) {
        error(`Script "${args.script}" not found in package.json.`);
      } else {
        error('Could not detect entry point. Provide an entry file or add a "bin" field to package.json.');
      }
      process.exit(1);
    }
    entry = detected.entry;
    name = sanitizeBinName(args.name || detected.name);
    runPrefix = detected.runPrefix;
    scriptCommand = detected.scriptCommand;
  } else {
    if (args.script) {
      error('--script cannot be used with an explicit entry file.');
      process.exit(1);
    }
    // Explicit file path
    entry = resolvedArg;
    name = sanitizeBinName(args.name || basename(entry).replace(/\.[cm]?[jt]sx?$/, ''));
  }

  const GENERIC_NAMES = new Set(['cli', 'index', 'main', 'app', 'bin', 'start', 'src', 'run', 'server', 'program']);
  if (GENERIC_NAMES.has(name)) {
    error(`"${name}" is too generic to use as a command name. Use --name to specify one.`);
    process.exit(1);
  }

  if (!scriptCommand && !existsSync(entry)) {
    error(`Entry file not found: ${entry}`);
    process.exit(1);
  }

  const entryDir = targetDir ?? (existsSync(resolve(dirname(entry), 'package.json')) ? dirname(entry) : dir);

  createShim(name, entry, entryDir, runPrefix, scriptCommand, args.pm);

  const links = readLinks();
  links[name] = {
    name,
    entry,
    dir: entryDir,
    linkedAt: new Date().toISOString(),
  };
  writeLinks(links);

  output(`Linked ${name} → ${scriptCommand ? `${scriptCommand} (script)` : entry}`);

  if (!isInPath(BIN_DIR)) {
    if (args.setup) {
      const shell = await detectShell();
      if (!shell) {
        error('Could not detect shell. Add the PATH manually:');
        error(`  export PATH="${BIN_DIR}:$PATH"`);
        return;
      }
      const result = await setupPath(shell);
      const verb = result.updated ? 'Updated' : 'Added';
      output(`${verb} PATH in ${result.file}`);
      output('Restart your shell or run:');
      output(`  export PATH="${BIN_DIR}:$PATH"`);
    } else {
      output('');
      output(`Add ${BIN_DIR} to your PATH to use "${name}" globally:`);
      output(`  export PATH="${BIN_DIR}:$PATH"`);
      output('Or re-run with --setup to do it automatically.');
    }
  }
}

export async function runUnlink(args: UnlinkArgs, ctx: PadroneActionContext) {
  const { output, error } = ctx.runtime;
  const links = readLinks();

  let name = args.name ? sanitizeBinName(args.name) : undefined;

  if (!name) {
    const dir = process.cwd();
    const detected = detectEntry(dir);
    if (detected) {
      name = sanitizeBinName(detected.name);
    }
  }

  if (!name) {
    error('Could not detect program name. Provide the name to unlink.');
    process.exit(1);
  }

  if (!links[name]) {
    error(`"${name}" is not linked.`);
    process.exit(1);
  }

  removeShim(name);
  delete links[name];
  writeLinks(links);

  output(`Unlinked ${name}`);
}
