import { extractSchemaMetadata, getJsonSchema, getOptionArity } from '../core/args.ts';
import type { AnyPadroneCommand, PadroneGlobalArgsMeta, PadroneSchema } from '../types/index.ts';
import { detectShell, getRcFile, type ShellType, shellQuote, writeToRcFile } from '../util/shell-utils.ts';
import {
  bashFallback,
  bashReadLines,
  builtinFlags,
  type CompletionDirective,
  fishExtFunction,
  fishValueFlags,
  generateDynamicCompletion,
  hintDirective,
  indentLines,
  offeredLongNames,
  powershellFallback,
  zshAction,
} from './complete.ts';

export { detectShell, escapeRegExp, getRcFile, type ShellType, writeToRcFile } from '../util/shell-utils.ts';

/** The built-in `--help` / `--version` long flags (as renamed with `flags`), with descriptions; none for a built-in that's off. */
function builtinFlagSpecs(program: AnyPadroneCommand): { flag: string; description: string }[] {
  return [
    ...builtinFlags(program, 'help').map((flag) => ({ flag, description: 'Show help information' })),
    ...builtinFlags(program, 'version').map((flag) => ({ flag, description: 'Show version number' })),
  ];
}

/** Escapes text for a single-quoted Fish string. */
const fishQuote = (text: string) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Enum values the shells take as a word as is; others are quoted, as the scripts' value lists are evaluated. */
const plainWord = (value: string) => /^[\w.,:+/@=-]+$/.test(value);
const bashWord = (value: string) => (plainWord(value) ? value : shellQuote(value));
const fishWord = (value: string) => (plainWord(value) ? value : `'${fishQuote(value)}'`);
/** Zsh evals the `(a b)` action of an `_arguments` spec, which is single-quoted in the script. */
const zshWord = (value: string) => value.replace(/[^\w.,+/@-]/g, '\\$&').replace(/'/g, "'\\''");
/** PowerShell also takes typographic quotes as single quotes. */
const psQuote = (text: string) => `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;

/**
 * Collects all commands from a program recursively, leaving out hidden and deprecated ones.
 */
function collectAllCommands(cmd: AnyPadroneCommand): AnyPadroneCommand[] {
  const result: AnyPadroneCommand[] = [];

  if (cmd.commands) {
    for (const subcmd of cmd.commands) {
      if (!subcmd.hidden && !subcmd.deprecated) {
        result.push(subcmd);
        result.push(...collectAllCommands(subcmd));
      }
    }
  }

  return result;
}

interface ExtractedArg {
  name: string;
  /** Every name it's typed as (`--name`, `--alias`, `-n`), to match the word before a value. */
  patterns: string[];
  /** The names offered, as help shows them: short flags, then `offeredLongNames`. */
  offered: string[];
  /** Hidden and deprecated options aren't offered. */
  listed: boolean;
  takesValue: boolean;
  enum?: string[];
  description?: string;
  /** What to complete for the value, set only by a `hint`. */
  directive?: CompletionDirective;
  valueName?: string;
}

/**
 * Extracts all argument names from a command's schema, and from the global args it defines.
 */
function extractArguments(cmd: AnyPadroneCommand): ExtractedArg[] {
  return [...extractSchemaArguments(cmd.argsSchema, cmd.meta), ...extractSchemaArguments(cmd.globalArgsSchema, cmd.globalArgsMeta)];
}

function extractSchemaArguments(schema: PadroneSchema | undefined, meta: PadroneGlobalArgsMeta | undefined): ExtractedArg[] {
  const argList: ExtractedArg[] = [];

  if (!schema) return argList;

  try {
    const argsMeta = meta?.fields;
    const { flags, aliases } = extractSchemaMetadata(schema, argsMeta, meta?.autoAlias);
    const namesOf = (map: Record<string, string>, key: string) => Object.keys(map).filter((name) => map[name] === key);

    const jsonSchema = getJsonSchema(schema) as Record<string, any>;

    if (jsonSchema.type === 'object' && jsonSchema.properties) {
      for (const [key, prop] of Object.entries(jsonSchema.properties as Record<string, any>)) {
        const enumValues = (prop.enum ?? prop.items?.enum) as string[] | undefined;
        const optMeta = argsMeta?.[key];
        const hint = optMeta?.hint ?? prop.hint;
        const shortFlags = namesOf(flags, key).map((flag) => `-${flag}`);
        const optionAliases = namesOf(aliases, key);
        argList.push({
          name: key,
          patterns: [key, ...optionAliases].map((name) => `--${name}`).concat(shortFlags),
          offered: [...shortFlags, ...offeredLongNames(key, optionAliases).map((name) => `--${name}`)],
          listed: !(optMeta?.hidden ?? prop.hidden) && !(optMeta?.deprecated ?? prop.deprecated),
          takesValue: getOptionArity(prop) !== 'flag' && !(optMeta?.count ?? prop.count),
          enum: enumValues,
          description: optMeta?.description ?? prop.description,
          directive: hint ? hintDirective(hint) : undefined,
          valueName: optMeta?.valueName ?? prop.valueName,
        });
      }
    }
  } catch {
    // Ignore schema parsing errors
  }

  return argList;
}

/**
 * Collects unique args across all commands, preserving first-seen enum values.
 */
function collectUniqueArgs(program: AnyPadroneCommand, commands: AnyPadroneCommand[]): Map<string, ExtractedArg> {
  const seen = new Map<string, ExtractedArg>();

  for (const cmd of [program, ...commands]) {
    for (const arg of extractArguments(cmd)) {
      if (!seen.has(arg.name)) {
        seen.set(arg.name, arg);
      }
    }
  }

  return seen;
}

/**
 * Generates a Bash completion script for the program.
 */
export function generateBashCompletion(program: AnyPadroneCommand): string {
  const programName = program.name;
  const commands = collectAllCommands(program);
  const commandNames = commands.map((c) => c.name).join(' ');
  const uniqueArgs = collectUniqueArgs(program, commands);

  const allArguments = new Set<string>(builtinFlagSpecs(program).map((b) => b.flag));
  for (const arg of uniqueArgs.values()) if (arg.listed) for (const name of arg.offered) allArguments.add(name);

  const argsList = Array.from(allArguments).join(' ');

  // Build case branches for options with enum values
  const enumCases: string[] = [];
  for (const arg of uniqueArgs.values()) {
    if (!arg.enum || arg.enum.length === 0) continue;
    const values = arg.enum.map(bashWord).join(' ');
    enumCases.push(
      `      ${arg.patterns.join('|')}) for line in ${values}; do [[ "$line" == "$cur"* ]] && COMPREPLY+=("$line"); done; return 0 ;;`,
    );
  }
  const hinted = [...uniqueArgs.values()].filter((arg) => arg.directive && !arg.enum?.length);
  for (const arg of hinted) enumCases.push(`      ${arg.patterns.join('|')}) directive=':${arg.directive}' ;;`);

  const hintBlock = hinted.length
    ? `
    if [[ -n "$directive" ]]; then
      COMPREPLY=()
${indentLines(bashFallback, 3)}
      return 0
    fi
`
    : '';
  const enumBlock =
    enumCases.length > 0
      ? `
    # Complete option values
    local directive=""
    case "$prev" in
${enumCases.join('\n')}
    esac
${hintBlock}
`
      : '\n';

  return `###-begin-${programName}-completion-###
#
# ${programName} command completion script
#
# Installation: ${programName} completion >> ~/.bashrc  (or ~/.zshrc)
# Or, maybe: ${programName} completion > /usr/local/etc/bash_completion.d/${programName}
#

if type complete &>/dev/null; then
  _${programName}_completion() {
    local cur prev words cword line
    if type _get_comp_words_by_ref &>/dev/null; then
      _get_comp_words_by_ref -n = -n @ -n : -w words -i cword
    else
      cword="$COMP_CWORD"
      words=("\${COMP_WORDS[@]}")
    fi

    cur="\${words[cword]}"
    prev="\${words[cword-1]}"

    local commands="${commandNames}"
    local args="${argsList}"
${enumBlock}    COMPREPLY=()
    # Complete args when current word starts with -
    if [[ "$cur" == -* ]]; then
      ${bashReadLines('compgen -W "$args" -- "$cur"')}
      return 0
    fi

    # Complete commands
    ${bashReadLines('compgen -W "$commands" -- "$cur"')}
  }
  complete -o bashdefault -o default -F _${programName}_completion ${programName}
elif type compdef &>/dev/null; then
  _${programName}_completion() {
    local si=$IFS
    local commands="${commandNames}"
    local args="${argsList}"

    if [[ "\${words[CURRENT]}" == -* ]]; then
      compadd -- \${=args}
    else
      compadd -- \${=commands}
    fi
    IFS=$si
  }
  compdef _${programName}_completion ${programName}
elif type compctl &>/dev/null; then
  _${programName}_completion() {
    local commands="${commandNames}"
    local args="${argsList}"

    if [[ "\${words[CURRENT]}" == -* ]]; then
      reply=(\${=args})
    else
      reply=(\${=commands})
    fi
  }
  compctl -K _${programName}_completion ${programName}
fi
###-end-${programName}-completion-###`;
}

/**
 * Generates a Zsh completion script for the program.
 */
export function generateZshCompletion(program: AnyPadroneCommand, descriptions = true): string {
  const programName = program.name;
  const commands = collectAllCommands(program);

  // Generate command completions with descriptions
  const commandCompletions = commands
    .map((cmd) => {
      const desc = cmd.description || cmd.title || '';
      const escapedDesc = desc.replace(/'/g, "'\\''").replace(/:/g, '\\:');
      return descriptions ? `      '${cmd.name}:${escapedDesc}'` : `      '${cmd.name}'`;
    })
    .join('\n');

  // Collect all args with descriptions and enum values
  const argumentCompletions = builtinFlagSpecs(program).map((b) => `      '${b.flag}${descriptions ? `[${b.description}]` : ''}'`);

  const uniqueArgs = collectUniqueArgs(program, commands);

  for (const arg of uniqueArgs.values()) {
    if (!arg.listed) continue;
    const desc = arg.description || '';
    const escapedDesc = desc.replace(/'/g, "'\\''").replace(/\[/g, '\\[').replace(/\]/g, '\\]');

    // Zsh value spec: `:label:action`, with enum values as `(val1 val2)`
    const label = arg.valueName?.replace(/[:'[\]]/g, '') || ' ';
    const action = arg.enum?.length
      ? `(${arg.enum.map(zshWord).join(' ')})`
      : arg.directive
        ? zshAction(arg.directive)
        : arg.takesValue
          ? '_files'
          : '';
    const valueAction = action ? `:${label}:${action}` : '';

    const spec = `${descriptions ? `[${escapedDesc}]` : ''}${valueAction}'`;
    argumentCompletions.push(arg.offered.length > 1 ? `      {${arg.offered.join(',')}}'${spec}` : `      '${arg.offered[0]}${spec}`);
  }

  return `#compdef ${programName}
###-begin-${programName}-completion-###
#
# ${programName} command completion script for Zsh
#
# Installation: ${programName} completion >> ~/.zshrc
# Or: ${programName} completion > ~/.zsh/completions/_${programName}
#

_${programName}() {
  local -a commands
  local -a args

  commands=(
${commandCompletions}
  )

  args=(
${argumentCompletions.join('\n')}
  )

  _arguments -s \\
    $args \\
    '1: :->command' \\
    '*::arg:->args'

  case "$state" in
    command)
      _describe 'command' commands
      ;;
  esac
}

_${programName}
###-end-${programName}-completion-###`;
}

/**
 * Generates a Fish completion script for the program.
 */
export function generateFishCompletion(program: AnyPadroneCommand, descriptions = true): string {
  const programName = program.name;
  const commands = collectAllCommands(program);

  const lines: string[] = [
    `###-begin-${programName}-completion-###`,
    '#',
    `# ${programName} command completion script for Fish`,
    '#',
    `# Installation: ${programName} completion > ~/.config/fish/completions/${programName}.fish`,
    '#',
    '',
    `# Clear existing completions`,
    `complete -c ${programName} -e`,
    '',
    '# Commands',
  ];

  const describe = (text: string | undefined) => (descriptions ? ` -d '${fishQuote(text ?? '')}'` : '');
  for (const cmd of commands) {
    lines.push(`complete -c ${programName} -n "__fish_use_subcommand" -a "${cmd.name}"${describe(cmd.description || cmd.title)}`);
  }

  lines.push('');
  lines.push('# Global arguments');
  for (const b of builtinFlagSpecs(program)) lines.push(`complete -c ${programName} -l ${b.flag.slice(2)}${describe(b.description)}`);

  const uniqueArgs = collectUniqueArgs(program, commands);

  const extFunction = `__${programName.replace(/[^A-Za-z0-9_]/g, '_')}_complete_ext`;
  if ([...uniqueArgs.values()].some((arg) => arg.directive?.startsWith('ext:'))) lines.push('', fishExtFunction(extFunction));

  for (const arg of uniqueArgs.values()) {
    if (!arg.listed) continue;
    // Fish: -xa 'val1 val2' provides exclusive value completions; -r takes a value (files by default)
    const valueFlag = arg.enum?.length
      ? ` -xa '${fishQuote(arg.enum.map(fishWord).join(' '))}'`
      : arg.directive
        ? ` ${fishValueFlags(arg.directive, extFunction)}`
        : arg.takesValue
          ? ' -r'
          : '';

    const names = arg.offered.map((name) => (name.startsWith('--') ? `-l ${name.slice(2)}` : `-s ${name.slice(1)}`)).join(' ');
    lines.push(`complete -c ${programName} ${names}${describe(arg.description)}${valueFlag}`);
  }

  lines.push(`###-end-${programName}-completion-###`);

  return lines.join('\n');
}

/**
 * Generates a PowerShell completion script for the program.
 */
export function generatePowerShellCompletion(program: AnyPadroneCommand): string {
  const programName = program.name;
  const commands = collectAllCommands(program);
  const uniqueArgs = collectUniqueArgs(program, commands);

  const commandNames = commands.map((c) => psQuote(c.name)).join(', ');

  const argNames = builtinFlagSpecs(program).map((b) => psQuote(b.flag));
  for (const arg of uniqueArgs.values()) if (arg.listed) argNames.push(...arg.offered.map(psQuote));

  // Build switch cases for option value completion
  const enumCases: string[] = [];
  for (const arg of uniqueArgs.values()) {
    if (!arg.enum || arg.enum.length === 0) continue;
    const values = arg.enum.map(psQuote).join(', ');
    enumCases.push(`      ${arg.patterns.map(psQuote).join(', ')} { @(${values}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
      }; return }`);
  }
  const hinted = [...uniqueArgs.values()].filter((arg) => arg.directive && !arg.enum?.length);
  for (const arg of hinted) enumCases.push(`      ${arg.patterns.map(psQuote).join(', ')} { $directive = ':${arg.directive}' }`);
  const hintBlock = hinted.length
    ? `  if ($directive) {
    ${powershellFallback.replace(/\n/g, '\n  ')}
    return
  }
`
    : '';

  const enumBlock =
    enumCases.length > 0
      ? `
  # Complete option values
  # The word before the one being completed (the last element when starting a new word)
  $elements = @($commandAst.CommandElements | Where-Object { $_.Extent.EndOffset -le $cursorPosition })
  $prevWord = if ($wordToComplete -eq '') { "$($elements[-1])" } else { "$($elements[-2])" }
  $directive = ''
  switch ($prevWord) {
${enumCases.join('\n')}
  }
${hintBlock}
`
      : '\n';

  return `###-begin-${programName}-completion-###
#
# ${programName} command completion script for PowerShell
#
# Installation: ${programName} completion >> $PROFILE
#

Register-ArgumentCompleter -Native -CommandName ${programName} -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $commands = @(${commandNames})
  $args = @(${argNames.join(', ')})
${enumBlock}  if ($wordToComplete -like '-*') {
    $args | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  } else {
    $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  }
}
###-end-${programName}-completion-###`;
}

/** Which completion script to generate. */
export type CompletionScriptOptions = {
  /**
   * `'dynamic'` scripts ask the program for candidates on each tab press (`__complete2`); `'static'` ones list them up front.
   * Defaults to dynamic when `padroneCompletion()` is registered (it answers `__complete2`), else static.
   */
  mode?: 'dynamic' | 'static';
  /** Show candidates' descriptions where the shell supports it. Defaults to `true`. */
  descriptions?: boolean;
};

/**
 * Generates a completion script for the specified shell.
 */
export function generateCompletion(program: AnyPadroneCommand, shell: ShellType, options: CompletionScriptOptions = {}): string {
  const descriptions = options.descriptions ?? true;
  // With `padroneCompletion()` the program answers `__complete` itself, so the script can ask it (per-command, dynamic values)
  const answers = program.interceptors?.some((i) => i.meta.id === 'padrone:completion' && !i.meta.disabled);
  if (answers && options.mode !== 'static') return generateDynamicCompletion(program.name, shell, descriptions);
  switch (shell) {
    case 'bash':
      return generateBashCompletion(program);
    case 'zsh':
      return generateZshCompletion(program, descriptions);
    case 'fish':
      return generateFishCompletion(program, descriptions);
    case 'powershell':
      return generatePowerShellCompletion(program);
    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }
}

/**
 * Gets the installation instructions for a shell completion script.
 */
export function getCompletionInstallInstructions(programName: string, shell: ShellType | undefined): string {
  switch (shell) {
    case 'bash':
      return `# Add to ~/.bashrc:
${programName} completion bash >> ~/.bashrc

# Or install system-wide:
${programName} completion bash > /usr/local/etc/bash_completion.d/${programName}`;

    case 'zsh':
      return `# Add to ~/.zshrc:
${programName} completion zsh >> ~/.zshrc

# Or add to completions directory:
${programName} completion zsh > ~/.zsh/completions/_${programName}`;

    case 'fish':
      return `# Install to Fish completions:
${programName} completion fish > ~/.config/fish/completions/${programName}.fish`;

    case 'powershell':
      return `# Add to PowerShell profile:
${programName} completion powershell >> $PROFILE`;

    default:
      return `# Run: ${programName} completion <shell>
# Supported shells: bash, zsh, fish, powershell`;
  }
}

/**
 * Generates the completion output with automatic shell detection.
 * If shell is not specified, detects the current shell and provides instructions.
 */
export async function generateCompletionOutput(
  program: AnyPadroneCommand,
  shell?: ShellType,
  env?: Record<string, string | undefined>,
  options?: CompletionScriptOptions,
): Promise<string> {
  const programName = program.name;

  if (shell) {
    return generateCompletion(program, shell, options);
  }

  // Auto-detect shell and provide instructions
  const detectedShell = await detectShellFromEnv(env);

  if (detectedShell) {
    // Commented out, so evaluating the output only loads the script
    const instructions = getCompletionInstallInstructions(programName, detectedShell)
      .split('\n')
      .map((line) => (line.startsWith('#') ? line : `# ${line}`.trimEnd()))
      .join('\n');
    const script = generateCompletion(program, detectedShell, options);

    return `# Detected shell: ${detectedShell}
#
${instructions}
#
# Or evaluate directly (temporary, for current session only):
# eval "$(${programName} completion ${detectedShell})"

${script}`;
  }

  // Could not detect shell - provide usage info
  return `# Shell auto-detection failed.
#
# Usage: ${programName} completion <shell>
#
# Supported shells:
#   bash       - Bash completion script
#   zsh        - Zsh completion script
#   fish       - Fish completion script
#   powershell - PowerShell completion script
#
# Example:
#   ${programName} completion bash >> ~/.bashrc
#   ${programName} completion zsh >> ~/.zshrc
#   ${programName} completion fish > ~/.config/fish/completions/${programName}.fish
#   ${programName} completion powershell >> $PROFILE`;
}

/**
 * Detects the shell from a runtime's environment (`runtime.env()`). With the process's own environment (or none),
 * the process's parent is also checked.
 */
export async function detectShellFromEnv(env?: Record<string, string | undefined>): Promise<ShellType | undefined> {
  if (!env || (typeof process !== 'undefined' && env === process.env)) return detectShell();
  const shell = env.SHELL ?? '';
  const found = (['zsh', 'bash', 'fish'] as const).find((name) => shell.includes(name));
  if (found) return found;
  if (env.PSModulePath || env.POWERSHELL_DISTRIBUTION_CHANNEL) return 'powershell';
  return undefined;
}

export interface SetupCompletionsResult {
  /** The file that was written to. */
  file: string;
  /** Whether an existing completion block was replaced (true) or a new one was appended (false). */
  updated: boolean;
}

export type SetupCompletionsOptions = {
  /** The environment whose `HOME` (or `USERPROFILE`) and PowerShell `PROFILE` locate the config file. Defaults to the process's. */
  env?: Record<string, string | undefined>;
  /** Flags the snippet passes to `completion <shell>` (e.g. `['--static']`). */
  flags?: readonly string[];
};

/**
 * Sets up shell completions by writing an eval snippet to the appropriate shell config file.
 * Uses marker comments for idempotency — re-running replaces the existing block.
 */
export async function setupCompletions(
  programName: string,
  shell: ShellType,
  options: SetupCompletionsOptions = {},
): Promise<SetupCompletionsResult> {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const env = options.env ?? globalThis.process?.env ?? {};
  const home = env.HOME || env.USERPROFILE || homedir();

  const beginMarker = `###-begin-${programName}-completion-###`;
  const endMarker = `###-end-${programName}-completion-###`;
  const evalCmd = [programName, 'completion', shell, ...(options.flags ?? [])].join(' ');
  const snippet = buildSetupSnippet(evalCmd, shell, beginMarker, endMarker);

  if (shell === 'fish') {
    const completionsDir = join(home, '.config', 'fish', 'completions');
    const filePath = join(completionsDir, `${programName}.fish`);
    mkdirSync(completionsDir, { recursive: true });
    const existed = existsSync(filePath);
    writeFileSync(filePath, `${snippet}\n`);
    return { file: filePath, updated: existed };
  }

  const rcFile = await getRcFile(shell, home, env);
  if (!rcFile) {
    throw new Error(`Could not determine config file for ${shell}.`);
  }

  return writeToRcFile(rcFile, snippet, beginMarker, endMarker);
}

function buildSetupSnippet(evalCmd: string, shell: ShellType, beginMarker: string, endMarker: string): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
      return `${beginMarker}\neval "$(${evalCmd})"\n${endMarker}`;
    case 'fish':
      return `${beginMarker}\n${evalCmd} | source\n${endMarker}`;
    case 'powershell':
      return `${beginMarker}\n${evalCmd} | Invoke-Expression\n${endMarker}`;
  }
}
