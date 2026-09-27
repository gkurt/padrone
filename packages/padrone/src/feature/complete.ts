import { extractSchemaMetadata, getJsonSchema, getOptionArity, parsePositionalConfig } from '../core/args.ts';
import { findCommandByName, getGlobalArgs, resolveCommand } from '../core/commands.ts';
import { getDryRunFlagKeys, getInterceptorOptions, parseCommand } from '../core/validate.ts';
import type { AnyPadroneCommand, PadroneFieldMeta, PadroneSchema } from '../types/index.ts';
import type { ShellType } from '../util/shell-utils.ts';

/** The hidden subcommand shell scripts call: `<program> __complete <words typed after the program name>`. */
export const COMPLETE_COMMAND = '__complete';

type CompletionField = {
  name: string;
  /** Long names the option is typed as: its name and aliases. */
  longNames: string[];
  shortFlags: string[];
  takesValue: boolean;
  values?: string[];
  meta?: PadroneFieldMeta;
};

function schemaFields(
  schema: PadroneSchema | undefined,
  fieldsMeta: Record<string, PadroneFieldMeta | undefined> | undefined,
  autoAlias?: boolean,
) {
  if (!schema) return [];
  try {
    const jsonSchema = getJsonSchema(schema) as Record<string, any>;
    if (jsonSchema.type !== 'object' || !jsonSchema.properties) return [];
    const { flags, aliases } = extractSchemaMetadata(schema, fieldsMeta, autoAlias);
    return Object.entries(jsonSchema.properties as Record<string, any>).map(([name, prop]): CompletionField => {
      const arity = getOptionArity(prop);
      const values = (prop?.enum ?? prop?.items?.enum) as unknown[] | undefined;
      return {
        name,
        longNames: [name, ...Object.keys(aliases).filter((alias) => aliases[alias] === name)],
        shortFlags: Object.keys(flags).filter((flag) => flags[flag] === name),
        takesValue: arity !== 'flag' && !fieldsMeta?.[name]?.count,
        values: values?.map(String),
        meta: fieldsMeta?.[name],
      };
    });
  } catch {
    return [];
  }
}

/** The command's own fields, then the global fields it doesn't override. */
function commandFields(command: AnyPadroneCommand): CompletionField[] {
  const own = schemaFields(command.argsSchema, command.meta?.fields, command.meta?.autoAlias);
  const globals = getGlobalArgs(command);
  const ownNames = new Set(own.map((f) => f.name));
  const inherited = globals ? schemaFields(globals.schema, globals.meta?.fields, globals.meta?.autoAlias) : [];
  return [...own, ...inherited.filter((f) => !ownNames.has(f.name))];
}

function findOption(fields: CompletionField[], token: string): CompletionField | undefined {
  if (token.startsWith('--')) {
    const name = token.slice(2);
    return fields.find((f) => f.longNames.includes(name));
  }
  // `-abc` stacks flags: only the last one can take the next word as its value
  const flag = token.slice(1).at(-1);
  return flag ? fields.find((f) => f.shortFlags.includes(flag)) : undefined;
}

async function fieldValues(field: CompletionField | undefined, prefix: string, args: Record<string, unknown>, command: AnyPadroneCommand) {
  if (!field) return [];
  if (field.meta?.complete) {
    try {
      return [...(await field.meta.complete({ prefix, args, command: command.path }))];
    } catch {
      return [];
    }
  }
  return field.values ?? [];
}

/** Long flags of a built-in `help` / `version` command (`--help`, or the names given with `flags`); none when it's turned off. */
export function builtinLongFlags(rootCommand: AnyPadroneCommand, name: 'help' | 'version'): string[] {
  const found = rootCommand.commands?.find((c) => c.name === name);
  const command = found && resolveCommand(found);
  return (command?.flagNames ?? []).filter((flag) => flag.length > 1).map((flag) => `--${flag}`);
}

/** Joins the words bash splits at `=` (`--env`, `=`, `prod` → `--env=prod`); a trailing `=` stays, as the word being typed follows it. */
function joinSplitValues(words: readonly string[]): string[] {
  const joined: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '=' && joined.length > 0 && i + 1 < words.length) joined.push(`${joined.pop()}=${words[++i]}`);
    else joined.push(words[i]!);
  }
  return joined;
}

/**
 * Completion candidates for the word being typed. `words` are the words after the program name;
 * the last one is the word under the cursor (`''` when starting a new word).
 * Covers subcommands, option names, option values and positional values, per command:
 * enum values, and a field's `complete` callback.
 */
export async function getCompletions(rootCommand: AnyPadroneCommand, words: readonly string[]): Promise<string[]> {
  const current = words.at(-1) ?? '';
  const typed = joinSplitValues(words.slice(0, -1));

  // Bash splits `--opt=val` into `--opt`, `=`, `val`: complete `val` (or the word after a bare `=`) as the option's value
  const splitOption = current === '=' ? typed.at(-1) : typed.at(-1) === '=' ? typed.at(-2) : undefined;
  const valuePrefix = current === '=' ? '' : current;

  let command = rootCommand;
  let positionals = 0;
  let pending: CompletionField | undefined;
  // The next word is the value of an option an extension declares (`-c file.json`, `--log-level debug`)
  let extensionValue = false;
  let afterDoubleDash = false;
  for (const word of typed) {
    if (pending || extensionValue) {
      pending = undefined;
      extensionValue = false;
      continue;
    }
    if (word === '=') continue;
    if (word === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && word.startsWith('-') && word.length > 1) {
      if (word.includes('=')) continue;
      const option = findOption(commandFields(command), word);
      if (option?.takesValue) pending = option;
      else if (!option) {
        const name = word.startsWith('--') ? word.slice(2) : word.slice(1).at(-1);
        const arity = name ? getInterceptorOptions(command)[name] : undefined;
        extensionValue = arity === 'value' || arity === 'array' || arity === 'variadic';
      }
      continue;
    }
    // After `--` every word is a positional, as when the command runs
    const subcommand = positionals === 0 && !afterDoubleDash ? findCommandByName(word, command.commands) : undefined;
    if (subcommand) command = subcommand;
    else positionals++;
  }

  const fields = commandFields(command);
  let rawArgs: Record<string, unknown> = {};
  try {
    if (typed.length > 0) rawArgs = parseCommand([...typed], rootCommand, findCommandByName).rawArgs;
  } catch {
    // Completion works on partial input: keep going without the typed args
  }
  const filter = (candidates: string[], prefix = current) => [...new Set(candidates)].filter((c) => c.startsWith(prefix));

  if (splitOption?.startsWith('-') && !afterDoubleDash) {
    return filter(await fieldValues(findOption(fields, splitOption), valuePrefix, rawArgs, command), valuePrefix);
  }
  if (pending) return filter(await fieldValues(pending, current, rawArgs, command));
  // No known values: the shell falls back to file names
  if (extensionValue) return [];

  if (!afterDoubleDash && current.startsWith('-')) {
    const eq = current.indexOf('=');
    if (eq > 0) {
      const option = current.slice(0, eq);
      const values = await fieldValues(findOption(fields, option), current.slice(eq + 1), rawArgs, command);
      return filter(values.map((v) => `${option}=${v}`));
    }
    const names = fields.filter((f) => !f.meta?.hidden).flatMap((f) => f.longNames.map((n) => `--${n}`));
    const dryRun = getDryRunFlagKeys(command).includes('dry-run') ? ['--dry-run'] : [];
    return filter([...names, ...dryRun, ...builtinLongFlags(rootCommand, 'help')]);
  }

  const subcommands =
    positionals === 0 && !afterDoubleDash
      ? (command.commands ?? []).filter((c) => !c.hidden && c.name && c.name !== COMPLETE_COMMAND).map((c) => c.name)
      : [];
  const positional = parsePositionalConfig(command.meta?.positional ?? []);
  const slot = positional[positionals] ?? (positional.at(-1)?.variadic ? positional.at(-1) : undefined);
  const values = slot
    ? await fieldValues(
        fields.find((f) => f.name === slot.name),
        current,
        rawArgs,
        command,
      )
    : [];
  return filter([...subcommands, ...values]);
}

/** Shell scripts that ask the program for candidates (`<program> __complete ...`), falling back to file names. */
export function generateDynamicCompletion(programName: string, shell: ShellType): string {
  const fn = `_${programName.replace(/[^A-Za-z0-9_]/g, '_')}_completion`;
  const begin = `###-begin-${programName}-completion-###`;
  const end = `###-end-${programName}-completion-###`;
  switch (shell) {
    case 'bash':
      return `${begin}
# ${programName} command completion script
# Installation: ${programName} completion bash >> ~/.bashrc
${fn}() {
  # Bash splits words at \`:\` (\`db:migrate\` → \`db\` \`:\` \`migrate\`): join them back up to the cursor
  local words=() i word last
  for ((i = 0; i <= COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    last=$((\${#words[@]} - 1))
    if [[ $last -ge 1 && ( "$word" == ":" || "\${words[last]}" == *: ) ]]; then
      words[last]+="$word"
    else
      words+=("$word")
    fi
  done
  local cur="\${words[\${#words[@]} - 1]}"
  local IFS=$'\\n'
  local candidates=($(${programName} ${COMPLETE_COMMAND} "\${words[@]:1}" 2>/dev/null))
  # Bash replaces only the part of the word after its last \`:\`, and inserts candidates as typed: escape spaces and quotes
  local colon_prefix=""
  [[ "$cur" == *:* ]] && colon_prefix="\${cur%"\${cur##*:}"}"
  COMPREPLY=()
  local candidate
  for candidate in "\${candidates[@]}"; do COMPREPLY+=("$(printf '%q' "\${candidate#"$colon_prefix"}")"); done
}
complete -o default -F ${fn} ${programName}
${end}`;
    case 'zsh':
      return `#compdef ${programName}
${begin}
# ${programName} command completion script for Zsh
# Installation: ${programName} completion zsh >> ~/.zshrc
${fn}() {
  local -a candidates
  candidates=("\${(@f)$(${programName} ${COMPLETE_COMMAND} "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ -n "\${candidates[1]}" ]]; then
    compadd -- "\${candidates[@]}"
  else
    _files
  fi
}
if [[ "\${zsh_eval_context[-1]}" == loadautofunc ]]; then
  ${fn} "$@"
else
  compdef ${fn} ${programName}
fi
${end}`;
    case 'fish':
      return `${begin}
# ${programName} command completion script for Fish
# Installation: ${programName} completion fish > ~/.config/fish/completions/${programName}.fish
function ${fn}
  set -l typed (commandline -opc)
  set -l current (commandline -ct)
  set -l candidates (${programName} ${COMPLETE_COMMAND} $typed[2..-1] "$current" 2>/dev/null)
  if test (count $candidates) -gt 0
    printf '%s\\n' $candidates
  else
    __fish_complete_path "$current"
  end
end
complete -c ${programName} -e
complete -c ${programName} -f -a '(${fn})'
${end}`;
    case 'powershell':
      return `${begin}
# ${programName} command completion script for PowerShell
# Installation: ${programName} completion powershell >> $PROFILE
Register-ArgumentCompleter -Native -CommandName ${programName} -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | Where-Object { $_.Extent.EndOffset -le $cursorPosition } | ForEach-Object { $_.ToString() })
  if ($wordToComplete -eq '') { $words += '' }
  & ${programName} ${COMPLETE_COMMAND} @words 2>$null | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
${end}`;
  }
}
