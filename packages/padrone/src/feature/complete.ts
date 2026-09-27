import { extractSchemaMetadata, getJsonSchema, getOptionArity, parsePositionalConfig } from '../core/args.ts';
import { findCommandByName, getGlobalArgs, resolveCommand } from '../core/commands.ts';
import { getDryRunFlagKeys, getInterceptorOptions, parseCommand } from '../core/validate.ts';
import { getHelpTopics } from '../output/help.ts';
import type { AnyPadroneCommand, PadroneCompletionItem, PadroneFieldMeta, PadroneSchema, PadroneValueHint } from '../types/index.ts';
import { offeredLongNames, type ShellType } from '../util/shell-utils.ts';

export { offeredLongNames };

/** The hidden subcommand for completion: `<program> __complete <words typed after the program name>` prints one candidate per line. */
export const COMPLETE_COMMAND = '__complete';

/**
 * Like `__complete`, for the generated scripts: prints `value<TAB>description` lines (the tab and description only when
 * there is one), then a directive line saying what the shell completes when no candidate matches.
 */
export const COMPLETE_DESCRIBED_COMMAND = '__complete2';

/**
 * What the shell completes when no candidate matches: file names, directories, files with the given extensions
 * (`ext:json,yaml`), command names, or nothing. Printed as the last line of `__complete2`, after a `:`.
 */
export type CompletionDirective = 'files' | 'dirs' | 'commands' | 'nofiles' | `ext:${string}`;

export type CompletionResult = { items: PadroneCompletionItem[]; directive: CompletionDirective };

type CompletionField = {
  name: string;
  /** Long names the option is typed as: its name and aliases. */
  longNames: string[];
  /** Long names offered as candidates (see `offeredLongNames`). */
  offeredNames: string[];
  shortFlags: string[];
  takesValue: boolean;
  /** Takes every following word up to the next option or `--` (`variadic: true` arrays). */
  variadic: boolean;
  description?: string;
  values?: PadroneCompletionItem[];
  hint?: PadroneValueHint;
  meta?: PadroneFieldMeta;
  /** Hidden options are never offered, deprecated ones only for a prefix nothing else matches. */
  hidden: boolean;
  deprecated: boolean;
};

/** A candidate; deprecated ones are only offered when no other candidate matches what's typed. */
type Candidate = PadroneCompletionItem & { deprecated?: boolean };

/** Enum values, or the constants of a union of literals (`anyOf: [{ const, description }]`) with their descriptions. */
function enumItems(prop: Record<string, any> | undefined): PadroneCompletionItem[] | undefined {
  const values = (prop?.enum ?? prop?.items?.enum) as unknown[] | undefined;
  if (values) return values.map((value) => ({ value: String(value) }));
  const variants = (prop?.anyOf ?? prop?.oneOf ?? prop?.items?.anyOf ?? prop?.items?.oneOf) as Record<string, any>[] | undefined;
  if (!variants?.length || !variants.every((v) => v && 'const' in v)) return undefined;
  return variants.map((v) => ({ value: String(v.const), description: v.description }));
}

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
      const meta = fieldsMeta?.[name];
      const arity = getOptionArity(prop);
      const optionAliases = Object.keys(aliases).filter((alias) => aliases[alias] === name);
      return {
        name,
        longNames: [name, ...optionAliases],
        offeredNames: offeredLongNames(name, optionAliases),
        shortFlags: Object.keys(flags).filter((flag) => flags[flag] === name),
        takesValue: arity !== 'flag' && !(meta?.count ?? prop?.count),
        variadic: arity === 'array' && !!(meta?.variadic ?? prop?.variadic),
        description: meta?.description ?? prop?.description,
        values: enumItems(prop),
        hint: meta?.hint ?? prop?.hint,
        meta,
        hidden: !!(meta?.hidden ?? prop?.hidden),
        deprecated: !!(meta?.deprecated ?? prop?.deprecated),
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

/** The command's fields, then its default (`''`) subcommand's: options typed without a subcommand go to it. */
function routedFields(command: AnyPadroneCommand): CompletionField[] {
  const own = commandFields(command);
  const defaultCommand = findCommandByName('', command.commands);
  // Hidden ones (like the built-in `help`) aren't offered
  if (!defaultCommand || defaultCommand.hidden) return own;
  const ownNames = new Set(own.map((f) => f.name));
  return [...own, ...commandFields(defaultCommand).filter((f) => !ownNames.has(f.name))];
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

async function fieldValues(
  field: CompletionField | undefined,
  prefix: string,
  args: Record<string, unknown>,
  command: AnyPadroneCommand,
): Promise<PadroneCompletionItem[]> {
  if (!field) return [];
  if (field.meta?.complete) {
    try {
      const items = await field.meta.complete({ prefix, args, command: command.path });
      return items.map((item) => (typeof item === 'string' ? { value: item } : item));
    } catch {
      return [];
    }
  }
  return field.values ?? [];
}

/**
 * The directive for a value hint. Without one, values that have candidates (enum, `complete`) get no file fallback;
 * others (and unknown options) fall back to files.
 */
export function hintDirective(hint: PadroneValueHint | undefined, hasValues = false): CompletionDirective {
  if (!hint) return hasValues ? 'nofiles' : 'files';
  if (typeof hint === 'object') {
    const exts = hint.ext.map((ext) => ext.replace(/^\./, '')).filter((ext) => /^[\w.+-]+$/.test(ext));
    return exts.length ? `ext:${exts.join(',')}` : 'files';
  }
  return ({ file: 'files', dir: 'dirs', command: 'commands', url: 'nofiles', none: 'nofiles' } as const)[hint] ?? 'files';
}

const fieldDirective = (field: CompletionField | undefined) => hintDirective(field?.hint, !!(field?.values || field?.meta?.complete));

/** Flags of a built-in `help` / `version` command as typed (`--help`, `-h`, or the names given with `flags`); none when it's turned off. */
export function builtinFlags(rootCommand: AnyPadroneCommand, name: 'help' | 'version', short = false): string[] {
  const found = rootCommand.commands?.find((c) => c.name === name);
  const command = found && resolveCommand(found);
  return (command?.flagNames ?? []).filter((flag) => (flag.length === 1) === short).map((flag) => (short ? `-${flag}` : `--${flag}`));
}

/** Shells that can't pass an empty argument (Windows PowerShell 5.1) pass `""` for the word being typed. */
const unquoteEmpty = (word: string) => (word === '""' || word === "''" ? '' : word);

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
 * Completion candidates for the word being typed, with descriptions, and what the shell falls back to when none match.
 * `words` are the words after the program name; the last one is the word under the cursor (`''` when starting a new word).
 * Covers subcommands, option names, option values and positional values, per command:
 * enum values, a field's `complete` callback, and its `hint`.
 */
export async function getCompletionResult(rootCommand: AnyPadroneCommand, words: readonly string[]): Promise<CompletionResult> {
  const current = unquoteEmpty(words.at(-1) ?? '');
  const typed = joinSplitValues(words.slice(0, -1));

  // Bash splits `--opt=val` into `--opt`, `=`, `val`: complete `val` (or the word after a bare `=`) as the option's value
  const splitOption = current === '=' ? typed.at(-1) : typed.at(-1) === '=' ? typed.at(-2) : undefined;
  const valuePrefix = current === '=' ? '' : current;

  let command = rootCommand;
  const terms: string[] = [];
  let pending: CompletionField | undefined;
  // The next word is the value of an option an extension declares (`-c file.json`, `--log-level debug`)
  let extensionValue = false;
  let afterDoubleDash = false;
  // A variadic option takes the words after its value too, up to the next option or `--`
  let variadic: CompletionField | undefined;
  for (const word of typed) {
    if (pending || extensionValue) {
      variadic = pending?.variadic ? pending : undefined;
      pending = undefined;
      extensionValue = false;
      continue;
    }
    if (word === '=') continue;
    if (word === '--') {
      afterDoubleDash = true;
      variadic = undefined;
      continue;
    }
    if (!afterDoubleDash && word.startsWith('-') && word.length > 1) {
      variadic = undefined;
      if (word.includes('=')) continue;
      const option = findOption(routedFields(command), word);
      if (option?.takesValue) pending = option;
      else if (!option) {
        const name = word.startsWith('--') ? word.slice(2) : word.slice(1).at(-1);
        const arity = name ? getInterceptorOptions(command)[name] : undefined;
        extensionValue = arity === 'value' || arity === 'array' || arity === 'variadic' || arity === 'json';
      }
      continue;
    }
    if (variadic) continue;
    // After `--` every word is a positional, as when the command runs
    const subcommand = terms.length === 0 && !afterDoubleDash ? findCommandByName(word, command.commands) : undefined;
    if (subcommand) command = subcommand;
    else terms.push(word);
  }
  const positionals = terms.length;

  const fields = positionals === 0 ? routedFields(command) : commandFields(command);
  let rawArgs: Record<string, unknown> = {};
  try {
    if (typed.length > 0) rawArgs = parseCommand([...typed], rootCommand, findCommandByName).rawArgs;
  } catch {
    // Completion works on partial input: keep going without the typed args
  }
  const filter = (items: Candidate[], prefix = current): PadroneCompletionItem[] => {
    const seen = new Set<string>();
    const matches = items.filter(
      (i) => typeof i?.value === 'string' && i.value.startsWith(prefix) && !seen.has(i.value) && seen.add(i.value),
    );
    const active = matches.filter((i) => !i.deprecated);
    const typed = prefix.replace(/^--?/, '') !== '';
    return (active.length > 0 || !typed ? active : matches).map(({ deprecated: _, ...item }) => item);
  };

  if (splitOption?.startsWith('-') && !afterDoubleDash) {
    const option = findOption(fields, splitOption);
    return { items: filter(await fieldValues(option, valuePrefix, rawArgs, command), valuePrefix), directive: fieldDirective(option) };
  }
  if (pending) return { items: filter(await fieldValues(pending, current, rawArgs, command)), directive: fieldDirective(pending) };
  if (extensionValue) return { items: [], directive: 'files' };
  if (variadic && !current.startsWith('-')) {
    return { items: filter(await fieldValues(variadic, current, rawArgs, command)), directive: fieldDirective(variadic) };
  }

  if (!afterDoubleDash && current.startsWith('-')) {
    const eq = current.indexOf('=');
    if (eq > 0) {
      const name = current.slice(0, eq);
      const option = findOption(fields, name);
      const values = await fieldValues(option, current.slice(eq + 1), rawArgs, command);
      return { items: filter(values.map((v) => ({ ...v, value: `${name}=${v.value}` }))), directive: fieldDirective(option) };
    }
    // `-` and `-x` also get short flags, like cobra and clap
    const short = !current.startsWith('--');
    const names = fields
      .filter((f) => !f.hidden)
      .flatMap((f) =>
        [...(short ? f.shortFlags.map((s) => `-${s}`) : []), ...f.offeredNames.map((n) => `--${n}`)].map(
          (value): Candidate => ({ value, description: f.description, deprecated: f.deprecated }),
        ),
      );
    const dryRunKeys = getDryRunFlagKeys(command);
    const dryRunFlags = [...(short && dryRunKeys.includes('n') ? ['-n'] : []), ...(dryRunKeys.includes('dry-run') ? ['--dry-run'] : [])];
    const dryRun = dryRunFlags.map((value) => ({ value, description: 'Show what would change without changing anything' }));
    const helpFlags = [...(short ? builtinFlags(rootCommand, 'help', true) : []), ...builtinFlags(rootCommand, 'help')];
    const help = helpFlags.map((value) => ({ value, description: 'Show help information' }));
    return { items: filter([...names, ...dryRun, ...help]), directive: 'nofiles' };
  }

  const visibleCommands = (cmd: AnyPadroneCommand): Candidate[] =>
    (cmd.commands ?? [])
      .filter((c) => !c.hidden && c.name && c.name !== COMPLETE_COMMAND)
      .map((c) => ({ value: c.name, description: c.title ?? c.description, deprecated: !!c.deprecated }));
  const subcommands = positionals === 0 && !afterDoubleDash ? visibleCommands(command) : [];
  // `help <word>...`: the built-in help command takes a command path (`help db migrate`) or a help topic
  const helpWord = !afterDoubleDash && !!command.flagNames && command.name === 'help' && !!command.parent && !command.parent.parent;
  if (helpWord) {
    let target: AnyPadroneCommand | undefined = rootCommand;
    for (const term of terms) target = target && findCommandByName(term, target.commands);
    if (target) subcommands.push(...visibleCommands(target));
    if (positionals === 0) {
      subcommands.push(
        ...getHelpTopics(rootCommand).map(([name, topic]) => ({ value: name, description: topic.description ?? topic.title })),
      );
    }
  }
  const positional = parsePositionalConfig(command.meta?.positional ?? []);
  const slot = positional[positionals] ?? (positional.at(-1)?.variadic ? positional.at(-1) : undefined);
  const slotField = slot && fields.find((f) => f.name === slot.name);
  const values = slotField ? await fieldValues(slotField, current, rawArgs, command) : [];
  // With nothing left to type but subcommands, or every positional filled, there's nothing to fall back to
  const directive = slotField && !helpWord ? fieldDirective(slotField) : subcommands.length || positional.length ? 'nofiles' : 'files';
  return { items: filter([...subcommands, ...values]), directive };
}

/** Completion candidates for the word being typed (see `getCompletionResult`), without descriptions. */
export async function getCompletions(rootCommand: AnyPadroneCommand, words: readonly string[]): Promise<string[]> {
  return (await getCompletionResult(rootCommand, words)).items.map((item) => item.value);
}

/** The `__complete2` output: `value<TAB>description` lines (descriptions on one line), then `:<directive>`. */
export function formatCompletionResult({ items, directive }: CompletionResult): string {
  const lines = items
    .filter((item) => !/[\t\n\r]/.test(item.value))
    .map(({ value, description }) => {
      const text = description?.split('\n', 1)[0]?.replace(/\s+/g, ' ').trim();
      return text ? `${value}\t${text}` : value;
    });
  return [...lines, `:${directive}`].join('\n');
}

// ── Shell fallbacks, shared with the static scripts in completion.ts ─────────

/**
 * Bash: appends each output line of `command` to the array `target`, using the caller's `line` variable. Unlike
 * `target=($(command))`, candidates aren't split at spaces or expanded as globs (`src/*`).
 */
export const bashReadLines = (command: string, target = 'COMPREPLY') =>
  `while IFS= read -r line; do ${target}+=("$line"); done < <(${command})`;

/** Bash: fills `COMPREPLY` for `$directive` from `$cur` (with a local `line`); `:files` leaves it to `complete -o default`. */
export const bashFallback = `case "$directive" in
  :nofiles) compopt +o default +o bashdefault 2>/dev/null ;;
  :commands)
    compopt +o default +o bashdefault 2>/dev/null
    ${bashReadLines('compgen -c -- "$cur"')} ;;
  :dirs)
    compopt +o default +o bashdefault -o filenames 2>/dev/null
    ${bashReadLines('compgen -d -- "$cur"')} ;;
  :ext:*)
    compopt +o default +o bashdefault -o filenames 2>/dev/null
    ${bashReadLines('compgen -d -- "$cur"')}
    local ext rest="\${directive#:ext:},"
    while [[ -n "$rest" ]]; do
      ext="\${rest%%,*}"
      rest="\${rest#*,}"
      ${bashReadLines('compgen -f -X "!*.$ext" -- "$cur"')}
    done ;;
esac`;

/** Zsh: the completion action for a directive, as used in `_arguments` specs. */
export function zshAction(directive: CompletionDirective): string {
  if (directive.startsWith('ext:')) return `_files -g "*.(${directive.slice(4).replace(/,/g, '|')})"`;
  return { files: '_files', dirs: '_files -/', commands: '_command_names -e', nofiles: ' ' }[directive as 'files'] ?? '_files';
}

/** Fish: a function printing the files (and directories) under the current token with one of the given extensions. */
export const fishExtFunction = (name: string) => `function ${name}
  set -l path (string replace -r -- '^-[^=]*=' '' (commandline -ct))
  __fish_complete_path $path | string match -r -- "^[^\\t]*(?:/|\\.(?:"(string join '|' (string escape --style=regex -- $argv))"))(?:\\t.*)?\\$"
end`;

/** Fish: the `complete` flags for an option value with this directive. */
export function fishValueFlags(directive: CompletionDirective, extFunction: string): string {
  if (directive.startsWith('ext:')) return `-x -a '(${extFunction} ${directive.slice(4).replace(/,/g, ' ')})'`;
  return (
    { files: '-r -F', dirs: "-x -a '(__fish_complete_directories)'", commands: "-x -a '(__fish_complete_command)'", nofiles: '-x' }[
      directive as 'files'
    ] ?? '-r -F'
  );
}

/** PowerShell: completion results for `$directive` from `$wordToComplete`; `:files` returns nothing, so PowerShell completes paths. */
export const powershellFallback = `$path = $wordToComplete -replace '^-[^=]*=', ''
  $prefix = $wordToComplete.Substring(0, $wordToComplete.Length - $path.Length) + ($path -replace '[^\\\\/]*$', '')
  switch -Wildcard ($directive) {
    ':nofiles' { return '' }
    ':commands' {
      return Get-Command -Name "$path*" -ErrorAction Ignore | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_.Name, $_.Name, 'Command', $_.Name) }
    }
    ':dirs' {
      return Get-ChildItem -Directory -Path "$path*" -ErrorAction Ignore | ForEach-Object { [System.Management.Automation.CompletionResult]::new("$prefix$($_.Name)", $_.Name, 'ProviderContainer', $_.Name) }
    }
    ':ext:*' {
      $pattern = '\\.(' + (($directive.Substring(5) -split ',' | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')$'
      return Get-ChildItem -Path "$path*" -ErrorAction Ignore | Where-Object { $_.PSIsContainer -or $_.Name -match $pattern } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new("$prefix$($_.Name)", $_.Name, $(if ($_.PSIsContainer) { 'ProviderContainer' } else { 'ProviderItem' }), $_.Name)
      }
    }
  }`;

/**
 * Shell scripts that ask the program for candidates (`<program> __complete2 ...`), with descriptions where the shell
 * shows them, falling back to what the directive line says.
 */
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
  local lines=() line
  ${bashReadLines(`${programName} ${COMPLETE_DESCRIBED_COMMAND} "\${words[@]:1}" 2>/dev/null`, 'lines')}
  # The last line says what to complete when nothing matches (\`:files\`, \`:dirs\`, \`:ext:json,yaml\`, \`:commands\`, \`:nofiles\`)
  local directive=":files" n=\${#lines[@]}
  if [[ $n -gt 0 && "\${lines[n - 1]}" == :* ]]; then
    directive="\${lines[n - 1]}"
    unset "lines[n - 1]"
  fi
  # Bash replaces only the part of the word after its last \`:\`, and inserts candidates as typed: escape spaces and quotes
  local colon_prefix=""
  [[ "$cur" == *:* ]] && colon_prefix="\${cur%"\${cur##*:}"}"
  COMPREPLY=()
  for line in "\${lines[@]}"; do
    line="\${line%%$'\\t'*}"
    COMPREPLY+=("$(printf '%q' "\${line#"$colon_prefix"}")")
  done
  [[ \${#COMPREPLY[@]} -gt 0 ]] && return 0
  [[ "$cur" == "=" ]] && cur=""
${indentLines(bashFallback, 1)}
}
complete -o default -F ${fn} ${programName}
${end}`;
    case 'zsh':
      return `#compdef ${programName}
${begin}
# ${programName} command completion script for Zsh
# Installation: ${programName} completion zsh >> ~/.zshrc
${fn}() {
  local -a lines items
  local line directive=":files"
  lines=("\${(@f)$(${programName} ${COMPLETE_DESCRIBED_COMMAND} "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  # The last line says what to complete when nothing matches (\`:files\`, \`:dirs\`, \`:ext:json,yaml\`, \`:commands\`, \`:nofiles\`)
  if [[ "\${lines[-1]}" == :* ]]; then
    directive="\${lines[-1]}"
    lines[-1]=()
  fi
  for line in "\${lines[@]}"; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == *$'\\t'* ]]; then
      items+=("\${\${line%%$'\\t'*}//:/\\\\:}:\${line#*$'\\t'}")
    else
      items+=("\${line//:/\\\\:}")
    fi
  done
  (( \${#items} )) && _describe -t values value items && return 0
  [[ "\${words[CURRENT]}" == -*=* ]] && compset -P '*='
  case "$directive" in
    :nofiles) return 1 ;;
    :commands) _command_names -e ;;
    :dirs) _files -/ ;;
    :ext:*) _files -g "*.(\${\${directive#:ext:}//,/|})" ;;
    *) _files ;;
  esac
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
${fishExtFunction(`${fn}_ext`)}
function ${fn}
  set -l typed (commandline -opc)
  set -l current (commandline -ct)
  set -l lines (${programName} ${COMPLETE_DESCRIBED_COMMAND} $typed[2..-1] "$current" 2>/dev/null)
  # The last line says what to complete when nothing matches (:files, :dirs, :ext:json,yaml, :commands, :nofiles)
  set -l directive :files
  if set -q lines[1]; and string match -q -- ':*' $lines[-1]
    set directive $lines[-1]
    set -e lines[-1]
  end
  if set -q lines[1]
    printf '%s\\n' $lines
    return
  end
  set -l path (string replace -r -- '^-[^=]*=' '' $current)
  # Fish matches candidates against the whole word: keep its \`--opt=\` part
  set -l prefix (string match -r -- '^-[^=]*=' $current)
  switch $directive
    case ':nofiles'
    case ':commands'
      __fish_complete_command
    case ':dirs'
      __fish_complete_directories $path
    case ':ext:*'
      ${fn}_ext (string split , (string replace ':ext:' '' $directive))
    case '*'
      __fish_complete_path $path
  end | string replace -r -- '^' "$prefix"
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
  # Windows PowerShell 5.1 drops empty arguments to native commands: pass "" for the word being typed (the program takes it as empty)
  if ($wordToComplete -eq '') { $words += '""' }
  $lines = @(& ${programName} ${COMPLETE_DESCRIBED_COMMAND} @words 2>$null)
  # The last line says what to complete when nothing matches (:files, :dirs, :ext:json,yaml, :commands, :nofiles)
  $directive = ':files'
  if ($lines.Count -gt 0 -and $lines[-1] -like ':*') {
    $directive = $lines[-1]
    $lines = @($lines | Select-Object -SkipLast 1)
  }
  $results = @($lines | Where-Object { $_ } | ForEach-Object {
    $value, $description = $_ -split "\`t", 2
    [System.Management.Automation.CompletionResult]::new($value, $value, 'ParameterValue', $(if ($description) { $description } else { $value }))
  })
  if ($results.Count -gt 0) { return $results }
  ${powershellFallback}
}
${end}`;
  }
}

/** Indents every line by `level` levels of two spaces. */
export function indentLines(text: string, level: number): string {
  const pad = '  '.repeat(level);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}
