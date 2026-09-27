import type { Terminal } from 'ghostty-web';
import { type InteractivePromptConfig, REPL_SIGINT } from 'padrone';
import type { LineEditor } from './line-editor.ts';

const QUESTION = '\x1b[32m?\x1b[0m';
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;

/** Removes the line a finished `readLine` left behind (e.g. the empty prompt after Ctrl+D). */
export const ERASE_PREVIOUS_LINE = '\x1b[1A\r\x1b[K';

/** Thrown when a prompt is cancelled with Ctrl+C, like Enquirer does. */
export class PromptCancelledError extends Error {
  constructor() {
    super('Prompt cancelled');
    this.name = 'PromptCancelledError';
  }
}

type Choice = { label: string; value: unknown };

/** `runtime.prompt` for the web terminal: input, password, confirm, select and multiselect prompts drawn with ANSI. */
export function createPrompt(term: Terminal, editor: LineEditor) {
  const answered = (message: string, answer: string) => term.write(`${QUESTION} ${bold(message)} ${cyan(answer)}\r\n`);

  async function list(config: InteractivePromptConfig, choices: Choice[], multi: boolean): Promise<unknown> {
    let active = Math.max(
      0,
      choices.findIndex((c) => c.value === config.default),
    );
    const picked = new Set<number>(
      multi && Array.isArray(config.default) ? choices.flatMap((c, i) => ((config.default as unknown[]).includes(c.value) ? [i] : [])) : [],
    );
    const hint = multi ? '(↑↓ move, space toggle, a all, enter confirm)' : '(↑↓ move, enter select)';
    let drawn = 0;

    const draw = () => {
      let out = drawn > 0 ? `\x1b[${drawn}A\r\x1b[J` : '';
      out += `${QUESTION} ${bold(config.message)} ${dim(hint)}\r\n`;
      choices.forEach((choice, i) => {
        const pointer = i === active ? cyan('❯') : ' ';
        const box = multi ? (picked.has(i) ? '\x1b[32m◉\x1b[0m ' : dim('◯ ')) : '';
        out += ` ${pointer} ${box}${i === active ? cyan(choice.label) : choice.label}\r\n`;
      });
      drawn = choices.length + 1;
      term.write(`\x1b[?25l${out}`);
    };
    const clear = () => term.write(`\x1b[${drawn}A\r\x1b[J\x1b[?25h`);

    draw();
    while (true) {
      const key = await editor.readKey();
      if (key === '\x1b[A' || key === 'k') active = (active - 1 + choices.length) % choices.length;
      else if (key === '\x1b[B' || key === 'j' || key === '\t') active = (active + 1) % choices.length;
      else if (multi && key === ' ') picked.has(active) ? picked.delete(active) : picked.add(active);
      else if (multi && key === 'a') {
        if (picked.size === choices.length) picked.clear();
        else for (const i of choices.keys()) picked.add(i);
      } else if (key === '\r') {
        clear();
        if (!multi) {
          answered(config.message, choices[active]!.label);
          return choices[active]!.value;
        }
        const selected = choices.filter((_, i) => picked.has(i));
        answered(config.message, selected.map((c) => c.label).join(', ') || dim('none'));
        return selected.map((c) => c.value);
      } else if (key === '\x03') {
        clear();
        term.write(`${QUESTION} ${bold(config.message)} ${dim('cancelled')}\r\n`);
        throw new PromptCancelledError();
      }
      draw();
    }
  }

  async function ask(question: string, options: { mask?: boolean; initial?: string } = {}): Promise<string> {
    const answer = await editor.readLine(question, options);
    if (answer === REPL_SIGINT || answer === null) throw new PromptCancelledError();
    return answer;
  }

  return async function prompt(config: InteractivePromptConfig): Promise<unknown> {
    const choices = config.choices ?? [];
    if ((config.type === 'select' || config.type === 'multiselect') && choices.length > 0) {
      return list(config, choices, config.type === 'multiselect');
    }

    if (config.type === 'confirm') {
      const hint = dim(config.default ? '(Y/n)' : '(y/N)');
      while (true) {
        const answer = (await ask(`${QUESTION} ${bold(config.message)} ${hint} `)).trim().toLowerCase();
        if (!answer) return Boolean(config.default);
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
      }
    }

    const hint = config.default !== undefined && config.type !== 'password' ? ` ${dim(`(${String(config.default)})`)}` : '';
    const answer = await ask(`${QUESTION} ${bold(config.message)}${hint} `, { mask: config.type === 'password' });
    return answer === '' ? config.default : answer;
  };
}

/** `runtime.editor` for the web terminal: edits the text line by line, finished with Ctrl+D. */
export function createEditor(term: Terminal, editor: LineEditor) {
  return async (text: string): Promise<string> => {
    term.write(`${dim('── editor ── one line at a time: enter adds a line, Ctrl+D saves, Ctrl+C discards')}\r\n`);
    const lines = text.replace(/\n$/, '').split('\n');
    for (const line of lines) term.write(`${dim('│')} ${line}\r\n`);
    while (true) {
      const line = await editor.readLine(`${dim('│')} `);
      if (line === REPL_SIGINT) throw new PromptCancelledError();
      if (line === null) {
        term.write(ERASE_PREVIOUS_LINE);
        break;
      }
      lines.push(line);
    }
    term.write(`${dim('── saved ──')}\r\n`);
    return `${lines.join('\n')}\n`;
  };
}

/** `runtime.page` for the web terminal: a tiny `more` that shows one screen at a time. */
export function createPager(term: Terminal, editor: LineEditor) {
  return async (text: string, options?: { always?: boolean }) => {
    const lines = text.replace(/\n$/, '').split('\n');
    const pageSize = Math.max(term.rows - 1, 3);
    if (lines.length <= pageSize && !options?.always) {
      term.write(`${lines.join('\r\n')}\r\n`);
      return;
    }
    let shown = 0;
    let count = pageSize;
    while (shown < lines.length) {
      const next = lines.slice(shown, shown + count);
      term.write(`${next.join('\r\n')}\r\n`);
      shown += next.length;
      if (shown >= lines.length) break;
      term.write(`\x1b[7m-- More (${Math.round((shown / lines.length) * 100)}%) -- space: page, enter: line, q: quit\x1b[0m`);
      const key = await editor.readKey();
      term.write('\r\x1b[K');
      if (key === 'q' || key === '\x03' || key === '\x1b') break;
      count = key === '\r' || key === '\x1b[B' ? 1 : pageSize;
    }
  };
}
