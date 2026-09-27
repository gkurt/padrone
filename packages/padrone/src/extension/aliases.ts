import { findCommandByName } from '../core/commands.ts';
import { resolveStdinAlways } from '../core/default-runtime.ts';
import { ActionError, ConfigError, PadroneError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { tokenizeInput } from '../core/parse.ts';
import { thenMaybe } from '../core/results.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase } from '../types/index.ts';
import { getProgramDirs } from '../util/dirs.ts';
import { fileErrorReason } from '../util/files.ts';
import { getRootCommand } from '../util/utils.ts';
import { parseFlatYaml, toYaml } from '../util/yaml.ts';
import { expandResponseFiles, responseFilesOptions } from './response-files.ts';
import { aliasNamesKey } from './suggestions.ts';
import { inputTokens, isRemoteCaller, passthroughSchema, quoteToken } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type PadroneAliasesOptions = {
  /**
   * Aliases the program defines, e.g. `{ co: 'checkout', up: 'deploy --env staging' }`.
   * Users' own aliases (`alias set`) with the same name take precedence.
   */
  aliases?: Record<string, string>;
  /** JSON file the user's aliases are kept in. Defaults to `aliases.json` in the program's config directory (`program.dirs.config`). */
  file?: string;
  /**
   * Name of the command that manages aliases (`alias set|list|delete|import|export`), or `false` for none.
   * Defaults to `'alias'`.
   */
  command?: string | false;
};

type AliasMap = Record<string, string>;

// ── Storage ──────────────────────────────────────────────────────────────

function aliasFile(options: PadroneAliasesOptions, root: AnyPadroneCommand, env: Record<string, string | undefined>): string {
  if (options.file) return options.file;
  const dirs = getProgramDirs(root.name, env);
  return `${dirs.config}${globalThis.process?.platform === 'win32' ? '\\' : '/'}aliases.json`;
}

async function readAliases(file: string): Promise<AliasMap> {
  const fs = await import('node:fs');
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    }
  } catch (err) {
    throw new ConfigError(`Invalid aliases file ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  throw new ConfigError(`Invalid aliases file ${file}: must be an object of alias names to commands`);
}

async function writeText(file: string, text: string): Promise<void> {
  const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
}

const writeAliases = (file: string, aliases: AliasMap) => writeText(file, `${JSON.stringify(aliases, null, 2)}\n`);

const sorted = (aliases: AliasMap): AliasMap =>
  Object.fromEntries(
    Object.keys(aliases)
      .sort()
      .map((name) => [name, aliases[name]!]),
  );

const isJsonFile = (file: string) => /\.jsonc?$/i.test(file);

/** The data in an imported file: JSON (`.json`, or text starting with `{`), else YAML (a flat `name: command` mapping without Bun). */
function parseImport(text: string, file: string): unknown {
  if (isJsonFile(file) || (!/\.ya?ml$/i.test(file) && /^\s*\{/.test(text))) {
    try {
      return JSON.parse(text);
    } catch (err) {
      if (isJsonFile(file)) throw err;
    }
  }
  const yaml = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML;
  return yaml ? yaml.parse(text) : parseFlatYaml(text);
}

/** Why an imported alias can't be added, if it can't. */
function importProblem(alias: string, expansion: unknown, root: AnyPadroneCommand): string | undefined {
  if (typeof expansion !== 'string') return `"${alias}" must be a string`;
  if (!expansion.trim()) return `"${alias}" is empty`;
  if (!ALIAS_NAME.test(alias)) return `invalid alias name "${alias}"`;
  if (findCommandByName(alias, root.commands)) return `"${alias}" is already a command`;
  return undefined;
}

const plural = (count: number) => `${count} alias${count === 1 ? '' : 'es'}`;

// ── Expansion ────────────────────────────────────────────────────────────

const PLACEHOLDER = /\$(\d+|@)/g;

/** The words of an alias with its placeholders filled from `rest`, the words typed after it. */
function fillPlaceholders(name: string, alias: string, words: readonly string[], rest: readonly string[]): string[] {
  const indexes = words.flatMap((word) => [...word.matchAll(PLACEHOLDER)].map((match) => Number(match[1])).filter((n) => n > 0));
  const needed = Math.max(0, ...indexes);
  if (needed > rest.length) {
    throw new PadroneError(`Alias "${name}" needs ${needed} argument${needed === 1 ? '' : 's'}: ${alias}`, { phase: 'parse' });
  }
  const used = new Set(indexes.map((n) => n - 1));
  const remaining = rest.filter((_, i) => !used.has(i));
  const filled = words.flatMap((word) =>
    word === '$@'
      ? remaining
      : [
          word.replace(PLACEHOLDER, (placeholder, key: string) =>
            key === '@' ? remaining.join(' ') : (rest[Number(key) - 1] ?? placeholder),
          ),
        ],
  );
  return words.some((word) => word.includes('$@')) ? filled : [...filled, ...remaining];
}

/**
 * Expands an alias in the first word of `tokens`: `$1`, `$2`, … take the words after it (too few is an error), `$@` takes
 * the words no `$N` takes, and without `$@` those are appended. Aliases of aliases expand too; a command of the same name
 * always wins. `expandWords` expands the alias's own words before the placeholders are filled (e.g. response files).
 */
export function expandAlias(
  tokens: readonly string[],
  aliases: AliasMap,
  root: AnyPadroneCommand,
  expandWords?: (words: string[]) => string[] | Promise<string[]>,
): string[] | undefined | Promise<string[] | undefined> {
  const seen = new Set<string>();
  const expand = (current: string[]): string[] | undefined | Promise<string[] | undefined> => {
    const [name, ...rest] = current;
    if (!name || name.startsWith('-') || seen.has(name) || !Object.hasOwn(aliases, name) || findCommandByName(name, root.commands)) {
      return seen.size > 0 ? current : undefined;
    }
    seen.add(name);
    const words = [...tokenizeInput(aliases[name]!)];
    return thenMaybe(expandWords ? expandWords(words) : words, (expanded) =>
      expand(fillPlaceholders(name, aliases[name]!, expanded, rest)),
    );
  };
  return expand([...tokens]);
}

/**
 * `alias set <name> …` with everything after the name kept as the expansion, options included
 * (`alias set co checkout --force`): a `--` goes after the name unless one is already there.
 */
function withLiteralExpansion(tokens: readonly string[], commandName: string): string[] | undefined {
  const [command, sub, name, next] = tokens;
  if (command !== commandName || sub !== 'set' || !name || name.startsWith('-') || next === undefined || next === '--') return undefined;
  return [...tokens.slice(0, 3), '--', ...tokens.slice(3)];
}

/**
 * Joins `alias set` words into the stored expansion. One word is kept as typed (`alias set st "status --short"`);
 * of several, a word with spaces or quotes is quoted so it expands back into one word.
 */
function joinExpansion(words: readonly string[]): string {
  if (words.length === 1) return words[0]!.trim();
  return words.map(quoteToken).join(' ');
}

// ── Extension ────────────────────────────────────────────────────────────

const ALIAS_NAME = /^[^\s-][^\s]*$/;

/**
 * Extension for command aliases, like `gh alias` or git aliases: the first word of the input is expanded before routing.
 * People add their own with `<program> alias set co "checkout --force"`, list them with `alias list` (as YAML) and remove them
 * with `alias delete co`; they're kept in `aliases.json` in the program's config directory. `alias import <file|->` adds the
 * aliases in a YAML or JSON file (existing ones are kept unless `--clobber`), and `alias export [file]` writes the user's
 * aliases as YAML (JSON with `--json` or a `.json` file), like `gh alias import`. `$1`, `$2`, … in an alias take the
 * words after it (`alias set pr "checkout pr/$1"`), and other words are appended. Only `cli()` and the REPL expand aliases.
 *
 * ```ts
 * createPadrone('my-cli').extend(padroneAliases({ aliases: { co: 'checkout' } }))
 * // my-cli co main          → my-cli checkout main
 * // my-cli alias set st "status --short"
 * ```
 */
export function padroneAliases(options: PadroneAliasesOptions = {}): <T extends CommandTypesBase>(builder: T) => T {
  const staticAliases = options.aliases ?? {};
  const commandName = options.command === undefined ? 'alias' : options.command;

  const interceptor = defineInterceptor({ id: 'padrone:aliases', name: 'padrone:aliases', order: -1500, async: true }, () => ({
    parse(ctx, next) {
      if (isRemoteCaller(ctx.caller)) return next();
      const root = ctx.command;
      const tokens = inputTokens(ctx.input, root);
      const literal = commandName !== false && withLiteralExpansion(tokens, commandName);
      if (literal) return next({ input: literal });
      if (ctx.caller !== 'cli' && ctx.caller !== 'repl') return next();
      const first = tokens[0];
      // Nothing to expand: a known command, an option, or no input
      if (!first || first.startsWith('-') || findCommandByName(first, root.commands)) return next();
      const responseFiles = responseFilesOptions(root);
      const expandWords = responseFiles
        ? (words: string[]) => expandResponseFiles(words, responseFiles.prefix, undefined, responseFiles.relativeTo)
        : undefined;
      return readAliases(aliasFile(options, root, ctx.runtime.env())).then((userAliases) => {
        const aliases = { ...staticAliases, ...userAliases };
        // An unknown command may have meant an alias, so suggestions offers their names
        return thenMaybe(expandAlias(tokens, aliases, root, expandWords), (expanded) =>
          expanded ? next({ input: expanded }) : next({ [aliasNamesKey]: Object.keys(aliases) }),
        );
      });
    },
  }));

  return ((builder: AnyPadroneBuilder) => {
    const result = builder.intercept(interceptor);
    if (commandName === false) return result;

    const fileFor = (command: AnyPadroneCommand, env: Record<string, string | undefined>) =>
      aliasFile(options, getRootCommand(command), env);

    return result.command(commandName, (c) =>
      c
        .configure({ description: 'Manage command aliases', builtin: true })
        .command('set', (s) =>
          s
            .configure({ description: 'Add or replace an alias', mutation: true })
            .arguments(
              passthroughSchema({
                name: { type: 'string', description: 'The alias' },
                expansion: { type: 'string[]', description: 'The command it runs, e.g. "checkout --force"' },
              }),
              { positional: ['name', '...expansion'] },
            )
            .async()
            .action(async (args, ctx) => {
              const { name } = args;
              const expansion = args.expansion && joinExpansion(args.expansion);
              if (!name || !expansion) throw new ActionError(`Usage: ${commandName} set <name> <command...>`);
              if (!ALIAS_NAME.test(name)) throw new ActionError(`Invalid alias name "${name}": no spaces, and it can't start with "-"`);
              const root = getRootCommand(ctx.command);
              if (findCommandByName(name, root.commands)) throw new ActionError(`"${name}" is already a command`);
              const file = fileFor(ctx.command, ctx.runtime.env());
              const aliases = await readAliases(file);
              const replaced = Object.hasOwn(aliases, name);
              await writeAliases(file, { ...aliases, [name]: expansion });
              return `${replaced ? 'Changed' : 'Added'} alias "${name}" → "${expansion}"`;
            }),
        )
        .command(['list', 'ls'], (l) =>
          l
            .configure({ description: 'List aliases (as YAML that `import` reads)' })
            .async()
            .action(async (_args, ctx) => {
              const aliases = { ...staticAliases, ...(await readAliases(fileFor(ctx.command, ctx.runtime.env()))) };
              return Object.keys(aliases).length === 0 ? 'No aliases' : toYaml(sorted(aliases));
            }),
        )
        .command('import', (i) =>
          i
            .configure({ description: 'Add the aliases in a YAML or JSON file', mutation: true })
            .arguments(
              passthroughSchema({
                file: { type: 'string', description: 'The file, or - for stdin' },
                clobber: { type: 'boolean', description: 'Overwrite aliases that already exist' },
              }),
              { positional: ['file'], fields: { file: { hint: 'file' } } },
            )
            .async()
            .action(async (args, ctx) => {
              if (!args.file) throw new ActionError(`Usage: ${commandName} import <file|->`);
              const stdin = args.file === '-';
              const name = stdin ? 'stdin' : args.file;
              let data: unknown;
              try {
                const text = stdin
                  ? await resolveStdinAlways(ctx.runtime).text()
                  : (await import('node:fs')).readFileSync(args.file, 'utf-8');
                data = parseImport(text, stdin ? '' : args.file);
              } catch (err) {
                throw new ActionError(`Cannot import ${name}: ${fileErrorReason(err)}`, { cause: err });
              }
              if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new ActionError(`Cannot import ${name}: must be an object of alias names to commands`);
              }
              const root = getRootCommand(ctx.command);
              const problems = Object.entries(data).flatMap(([alias, expansion]) => {
                const problem = importProblem(alias, expansion, root);
                return problem ? [problem] : [];
              });
              if (problems.length) throw new ActionError(`Cannot import ${name}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

              const file = fileFor(ctx.command, ctx.runtime.env());
              const aliases = await readAliases(file);
              const imported: AliasMap = {};
              const skipped: string[] = [];
              for (const [alias, expansion] of Object.entries(data as AliasMap)) {
                const exists = Object.hasOwn(aliases, alias);
                if (exists && aliases[alias] === expansion.trim()) continue;
                if (exists && !args.clobber) skipped.push(alias);
                else imported[alias] = expansion.trim();
              }
              if (Object.keys(imported).length) await writeAliases(file, { ...aliases, ...imported });
              const lines = [`Imported ${plural(Object.keys(imported).length)}`];
              if (skipped.length) {
                const exist = skipped.length === 1 ? 'that already exists' : 'that already exist';
                lines.push(`Skipped ${plural(skipped.length)} ${exist}: ${skipped.join(', ')} (use --clobber to overwrite)`);
              }
              return lines.join('\n');
            }),
        )
        .command('export', (e) =>
          e
            .configure({ description: "Print or save the user's aliases as YAML or JSON" })
            .arguments(
              passthroughSchema({
                file: { type: 'string', description: 'The file to write (JSON for .json), else stdout' },
                json: { type: 'boolean', description: 'Write JSON instead of YAML' },
              }),
              { positional: ['file'], fields: { file: { hint: 'file' } } },
            )
            .async()
            .action(async (args, ctx) => {
              const aliases = sorted(await readAliases(fileFor(ctx.command, ctx.runtime.env())));
              const toFile = args.file && args.file !== '-' ? args.file : undefined;
              const text = args.json || (toFile && isJsonFile(toFile)) ? JSON.stringify(aliases, null, 2) : toYaml(aliases);
              if (!toFile) return text;
              await writeText(toFile, `${text}\n`);
              return `Exported ${plural(Object.keys(aliases).length)} to ${toFile}`;
            }),
        )
        .command(['delete', 'rm'], (d) =>
          d
            .configure({ description: 'Remove an alias', mutation: true })
            .arguments(passthroughSchema({ name: { type: 'string', description: 'The alias' } }), { positional: ['name'] })
            .async()
            .action(async (args, ctx) => {
              if (!args.name) throw new ActionError(`Usage: ${commandName} delete <name>`);
              const file = fileFor(ctx.command, ctx.runtime.env());
              const aliases = await readAliases(file);
              if (!Object.hasOwn(aliases, args.name)) {
                throw new ActionError(
                  Object.hasOwn(staticAliases, args.name) ? `"${args.name}" is built into the program` : `No alias "${args.name}"`,
                );
              }
              const { [args.name]: _removed, ...rest } = aliases;
              await writeAliases(file, rest);
              return `Removed alias "${args.name}"`;
            }),
        ),
    );
  }) as any;
}
