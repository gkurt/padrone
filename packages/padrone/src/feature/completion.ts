import { extractSchemaMetadata, getJsonSchema } from '../core/args.ts';
import type { AnyPadroneCommand, PadroneGlobalArgsMeta, PadroneSchema } from '../types/index.ts';
import { detectShell, getRcFile, type ShellType, writeToRcFile } from '../util/shell-utils.ts';
import { generateDynamicCompletion } from './complete.ts';

export { detectShell, escapeRegExp, getRcFile, type ShellType, writeToRcFile } from '../util/shell-utils.ts';

/**
 * Collects all commands from a program recursively.
 */
function collectAllCommands(cmd: AnyPadroneCommand): AnyPadroneCommand[] {
  const result: AnyPadroneCommand[] = [];

  if (cmd.commands) {
    for (const subcmd of cmd.commands) {
      if (!subcmd.hidden) {
        result.push(subcmd);
        result.push(...collectAllCommands(subcmd));
      }
    }
  }

  return result;
}

interface ExtractedArg {
  name: string;
  alias?: string;
  isBoolean: boolean;
  enum?: string[];
  description?: string;
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
    const { aliases } = extractSchemaMetadata(schema, argsMeta, meta?.autoAlias);

    // Build reverse map: argName → aliasName
    const argToAlias: Record<string, string> = {};
    for (const [aliasName, argName] of Object.entries(aliases)) {
      if (!argToAlias[argName]) argToAlias[argName] = aliasName;
    }

    const jsonSchema = getJsonSchema(schema) as Record<string, any>;

    if (jsonSchema.type === 'object' && jsonSchema.properties) {
      for (const [key, prop] of Object.entries(jsonSchema.properties as Record<string, any>)) {
        const enumValues = (prop.enum ?? prop.items?.enum) as string[] | undefined;
        const optMeta = argsMeta?.[key];
        argList.push({
          name: key,
          alias: argToAlias[key],
          isBoolean: prop?.type === 'boolean',
          enum: enumValues,
          description: optMeta?.description ?? prop.description,
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

  // Collect all option names
  const allArguments = new Set<string>();
  allArguments.add('--help');
  allArguments.add('--version');

  for (const arg of uniqueArgs.values()) {
    allArguments.add(`--${arg.name}`);
    if (arg.alias) allArguments.add(`--${arg.alias}`);
  }

  const argsList = Array.from(allArguments).join(' ');

  // Build case branches for options with enum values
  const enumCases: string[] = [];
  for (const arg of uniqueArgs.values()) {
    if (!arg.enum || arg.enum.length === 0) continue;
    const values = arg.enum.join(' ');
    const patterns = [`--${arg.name}`];
    if (arg.alias) patterns.push(`--${arg.alias}`);
    enumCases.push(`      ${patterns.join('|')}) COMPREPLY=($(compgen -W "${values}" -- "$cur")); return 0 ;;`);
  }

  const enumBlock =
    enumCases.length > 0
      ? `
    # Complete option values
    case "$prev" in
${enumCases.join('\n')}
    esac

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
    local cur prev words cword
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
${enumBlock}    # Complete args when current word starts with -
    if [[ "$cur" == -* ]]; then
      COMPREPLY=($(compgen -W "$args" -- "$cur"))
      return 0
    fi

    # Complete commands
    COMPREPLY=($(compgen -W "$commands" -- "$cur"))
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
export function generateZshCompletion(program: AnyPadroneCommand): string {
  const programName = program.name;
  const commands = collectAllCommands(program);

  // Generate command completions with descriptions
  const commandCompletions = commands
    .map((cmd) => {
      const desc = cmd.description || cmd.title || '';
      const escapedDesc = desc.replace(/'/g, "'\\''").replace(/:/g, '\\:');
      return `      '${cmd.name}:${escapedDesc}'`;
    })
    .join('\n');

  // Collect all args with descriptions and enum values
  const argumentCompletions: string[] = [];
  argumentCompletions.push("      '--help[Show help information]'");
  argumentCompletions.push("      '--version[Show version number]'");

  const uniqueArgs = collectUniqueArgs(program, commands);

  for (const arg of uniqueArgs.values()) {
    const desc = arg.description || '';
    const escapedDesc = desc.replace(/'/g, "'\\''").replace(/\[/g, '\\[').replace(/\]/g, '\\]');

    // Zsh action spec for enum values: :label:(val1 val2 val3)
    const valueAction = arg.enum?.length ? `: :(${arg.enum.join(' ')})` : '';

    if (arg.alias) {
      argumentCompletions.push(`      {--${arg.alias},--${arg.name}}'[${escapedDesc}]${valueAction}'`);
    } else {
      argumentCompletions.push(`      '--${arg.name}[${escapedDesc}]${valueAction}'`);
    }
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
export function generateFishCompletion(program: AnyPadroneCommand): string {
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

  for (const cmd of commands) {
    const desc = cmd.description || cmd.title || '';
    const escapedDesc = desc.replace(/'/g, "\\'");
    lines.push(`complete -c ${programName} -n "__fish_use_subcommand" -a "${cmd.name}" -d '${escapedDesc}'`);
  }

  lines.push('');
  lines.push('# Global arguments');
  lines.push(`complete -c ${programName} -l help -d 'Show help information'`);
  lines.push(`complete -c ${programName} -l version -d 'Show version number'`);

  const uniqueArgs = collectUniqueArgs(program, commands);

  for (const arg of uniqueArgs.values()) {
    const desc = arg.description || '';
    const escapedDesc = desc.replace(/'/g, "\\'");
    // Fish: -xa 'val1 val2' provides exclusive value completions
    const valueFlag = arg.enum?.length ? ` -xa '${arg.enum.join(' ')}'` : '';

    if (arg.alias) {
      // An alias is another long name; \`-s\` is for single-character options
      const aliasFlag = arg.alias.length === 1 ? `-s ${arg.alias}` : `-l ${arg.alias}`;
      lines.push(`complete -c ${programName} -l ${arg.name} ${aliasFlag} -d '${escapedDesc}'${valueFlag}`);
    } else {
      lines.push(`complete -c ${programName} -l ${arg.name} -d '${escapedDesc}'${valueFlag}`);
    }
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

  const commandNames = commands.map((c) => `'${c.name}'`).join(', ');

  // Collect all option names
  const argNames: string[] = ["'--help'", "'--version'"];
  for (const arg of uniqueArgs.values()) {
    argNames.push(`'--${arg.name}'`);
    if (arg.alias) argNames.push(`'--${arg.alias}'`);
  }

  // Build switch cases for option value completion
  const enumCases: string[] = [];
  for (const arg of uniqueArgs.values()) {
    if (!arg.enum || arg.enum.length === 0) continue;
    const values = arg.enum.map((v) => `'${v}'`).join(', ');
    const patterns = [`'--${arg.name}'`];
    if (arg.alias) patterns.push(`'--${arg.alias}'`);
    enumCases.push(`      ${patterns.join(', ')} { @(${values}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
      }; return }`);
  }

  const enumBlock =
    enumCases.length > 0
      ? `
  # Complete option values
  # The word before the one being completed (the last element when starting a new word)
  $elements = @($commandAst.CommandElements | Where-Object { $_.Extent.EndOffset -le $cursorPosition })
  $prevWord = if ($wordToComplete -eq '') { "$($elements[-1])" } else { "$($elements[-2])" }
  switch ($prevWord) {
${enumCases.join('\n')}
  }

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

/**
 * Generates a completion script for the specified shell.
 */
export function generateCompletion(program: AnyPadroneCommand, shell: ShellType): string {
  // With `padroneCompletion()` the program answers `__complete` itself, so the script can ask it (per-command, dynamic values)
  const dynamic = program.interceptors?.some((i) => i.meta.id === 'padrone:completion' && !i.meta.disabled);
  if (dynamic) return generateDynamicCompletion(program.name, shell);
  switch (shell) {
    case 'bash':
      return generateBashCompletion(program);
    case 'zsh':
      return generateZshCompletion(program);
    case 'fish':
      return generateFishCompletion(program);
    case 'powershell':
      return generatePowerShellCompletion(program);
    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }
}

/**
 * Gets the installation instructions for a shell completion script.
 */
export function getCompletionInstallInstructions(programName: string, shell: ShellType): string {
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
export async function generateCompletionOutput(program: AnyPadroneCommand, shell?: ShellType): Promise<string> {
  const programName = program.name;

  if (shell) {
    return generateCompletion(program, shell);
  }

  // Auto-detect shell and provide instructions
  const detectedShell = await detectShell();

  if (detectedShell) {
    const instructions = getCompletionInstallInstructions(programName, detectedShell);
    const script = generateCompletion(program, detectedShell);

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

export interface SetupCompletionsResult {
  /** The file that was written to. */
  file: string;
  /** Whether an existing completion block was replaced (true) or a new one was appended (false). */
  updated: boolean;
}

/**
 * Sets up shell completions by writing an eval snippet to the appropriate shell config file.
 * Uses marker comments for idempotency — re-running replaces the existing block.
 */
export async function setupCompletions(programName: string, shell: ShellType): Promise<SetupCompletionsResult> {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');

  const beginMarker = `###-begin-${programName}-completion-###`;
  const endMarker = `###-end-${programName}-completion-###`;
  const snippet = buildSetupSnippet(programName, shell, beginMarker, endMarker);

  if (shell === 'fish') {
    const completionsDir = join(homedir(), '.config', 'fish', 'completions');
    const filePath = join(completionsDir, `${programName}.fish`);
    mkdirSync(completionsDir, { recursive: true });
    const existed = existsSync(filePath);
    writeFileSync(filePath, `${snippet}\n`);
    return { file: filePath, updated: existed };
  }

  const rcFile = await getRcFile(shell);
  if (!rcFile) {
    throw new Error(`Could not determine config file for ${shell}.`);
  }

  return writeToRcFile(rcFile, snippet, beginMarker, endMarker);
}

function buildSetupSnippet(programName: string, shell: ShellType, beginMarker: string, endMarker: string): string {
  const evalCmd = `${programName} completion ${shell}`;

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
