import { findCommandByName } from '../core/commands.ts';
import { ActionError, ConfigError, PadroneError } from '../core/errors.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { tokenizeInput } from '../core/parse.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, CommandTypesBase, PadroneInput } from '../types/index.ts';
import { getProgramDirs } from '../util/dirs.ts';
import { getRootCommand } from '../util/utils.ts';
import { passthroughSchema, quoteToken } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

export type PadroneAliasesOptions = {
  /**
   * Aliases the program defines, e.g. `{ co: 'checkout', up: 'deploy --env staging' }`.
   * Users' own aliases (`alias set`) with the same name take precedence.
   */
  aliases?: Record<string, string>;
  /** JSON file the user's aliases are kept in. Defaults to `aliases.json` in the program's config directory (`program.dirs.config`). */
  file?: string;
  /** Name of the command that manages aliases (`alias set|list|delete`), or `false` for none. Defaults to `'alias'`. */
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

async function writeAliases(file: string, aliases: AliasMap): Promise<void> {
  const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(aliases, null, 2)}\n`, 'utf-8');
}

// ── Expansion ────────────────────────────────────────────────────────────

/**
 * Expands an alias in the first word of `tokens`: `$1`, `$2`, … take the words after it (too few is an error), and the rest are appended.
 * Aliases of aliases expand too; a command of the same name always wins.
 */
export function expandAlias(tokens: readonly string[], aliases: AliasMap, root: AnyPadroneCommand): string[] | undefined {
  let current = [...tokens];
  const seen = new Set<string>();
  while (current.length > 0) {
    const [name, ...rest] = current;
    if (!name || name.startsWith('-') || seen.has(name) || !Object.hasOwn(aliases, name) || findCommandByName(name, root.commands)) break;
    seen.add(name);
    const used = new Set<number>();
    let needed = 0;
    const expanded = tokenizeInput(aliases[name]!).map((token) =>
      token.replace(/\$(\d+)/g, (placeholder, n: string) => {
        const index = Number(n) - 1;
        if (index < 0) return placeholder;
        needed = Math.max(needed, index + 1);
        used.add(index);
        return rest[index] ?? placeholder;
      }),
    );
    if (needed > rest.length) {
      throw new PadroneError(`Alias "${name}" needs ${needed} argument${needed === 1 ? '' : 's'}: ${aliases[name]}`, { phase: 'parse' });
    }
    current = [...expanded, ...rest.filter((_, i) => !used.has(i))];
  }
  return seen.size > 0 ? current : undefined;
}

/** The input as argv tokens (without a leading program name in a string from `eval()` / the REPL). */
export function inputTokens(input: PadroneInput | undefined, root: AnyPadroneCommand): string[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  const tokens = [...tokenizeInput(input)];
  return tokens[0] === root.name && !findCommandByName(root.name, root.commands) ? tokens.slice(1) : tokens;
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
 * People add their own with `<program> alias set co "checkout --force"`, list them with `alias list` and remove them with
 * `alias delete co`; they're kept in `aliases.json` in the program's config directory. `$1`, `$2`, … in an alias take the
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
      if (ctx.caller !== 'cli' && ctx.caller !== 'repl') return next();
      const root = ctx.command;
      const tokens = inputTokens(ctx.input, root);
      const first = tokens[0];
      // Nothing to expand: a known command, an option, or no input
      if (!first || first.startsWith('-') || findCommandByName(first, root.commands)) return next();
      return readAliases(aliasFile(options, root, ctx.runtime.env())).then((userAliases) => {
        const expanded = expandAlias(tokens, { ...staticAliases, ...userAliases }, root);
        return expanded ? next({ input: expanded }) : next();
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
        .configure({ description: 'Manage command aliases' })
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
            .configure({ description: 'List aliases' })
            .async()
            .action(async (_args, ctx) => {
              const aliases = { ...staticAliases, ...(await readAliases(fileFor(ctx.command, ctx.runtime.env()))) };
              const names = Object.keys(aliases).sort();
              if (names.length === 0) return 'No aliases';
              const width = Math.max(...names.map((n) => n.length)) + 2;
              return names.map((n) => `${n.padEnd(width)}${aliases[n]}`).join('\n');
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
