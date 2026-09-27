import { resolveAllCommands } from '../core/commands.ts';
import type { AnyPadroneCommand } from '../types/index.ts';
import { getHelpTopics } from './help.ts';

export type HelpSearchEntry = { name: string; description?: string };

/** What `help --search <term>` found: commands by their full path, and help topics. */
export type HelpSearchResult = { commands: HelpSearchEntry[]; topics: HelpSearchEntry[] };

/**
 * Searches the command tree and help topics for every word of `term`, ignoring case, like `npm help-search`:
 * visible commands by name, aliases, title and description; topics by name, title, description and text.
 */
export function searchHelp(rootCommand: AnyPadroneCommand, term: string): HelpSearchResult {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...texts: (string | undefined)[]) => {
    const text = texts.join('\n').toLowerCase();
    return words.every((word) => text.includes(word));
  };

  resolveAllCommands(rootCommand);
  const commands: HelpSearchEntry[] = [];
  const visit = (command: AnyPadroneCommand) => {
    for (const sub of command.commands ?? []) {
      if (sub.hidden || !sub.name) continue;
      if (matches(sub.name, ...(sub.aliases ?? []), sub.title, sub.description)) {
        commands.push({ name: sub.path, description: sub.title ?? sub.description });
      }
      visit(sub);
    }
  };
  visit(rootCommand);

  const topics = getHelpTopics(rootCommand)
    .filter(([name, topic]) => matches(name, topic.title, topic.description, typeof topic.content === 'string' ? topic.content : undefined))
    .map(([name, topic]) => ({ name, description: topic.description ?? topic.title }));
  return { commands, topics };
}

/** The search result as text: a section each for commands and topics, or a line saying nothing matched. */
export function formatHelpSearch(result: HelpSearchResult, term: string): string {
  const entries = [...result.commands, ...result.topics];
  if (entries.length === 0) return `No commands or help topics match "${term}".`;
  const width = Math.max(...entries.map((entry) => entry.name.length));
  const section = (title: string, list: HelpSearchEntry[]) =>
    list.length
      ? [`${title}:`, ...list.map((e) => `  ${e.description ? `${e.name.padEnd(width)}  ${e.description.split('\n', 1)[0]}` : e.name}`)]
      : [];
  const commands = section('Commands', result.commands);
  const topics = section('Help topics', result.topics);
  return [...commands, ...(commands.length && topics.length ? [''] : []), ...topics].join('\n');
}
