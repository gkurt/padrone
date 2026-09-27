import type { Terminal } from 'ghostty-web';
import { REPL_SIGINT } from 'padrone';

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences requires ESC
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const visibleLength = (text: string) => [...text.replace(ANSI_PATTERN, '')].length;

/** Candidates for the word under the cursor: the text from `from` to the cursor is replaced by the chosen one. */
export type Completion = { candidates: string[]; from: number };
export type Completer = (line: string) => Completion | Promise<Completion>;

export type ReadLineOptions = {
  history?: string[];
  complete?: Completer;
  /** Echo `*` instead of the typed characters. */
  mask?: boolean;
  initial?: string;
};

export type ReadLineResult = string | typeof REPL_SIGINT | null;

function commonPrefix(words: string[]): string {
  if (words.length === 0) return '';
  let prefix = words[0]!;
  for (const word of words) while (!word.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * A readline-like editor on top of a ghostty terminal: cursor keys, history, Ctrl shortcuts and async tab completion.
 * While no line is being read, keys go to `onIdleKey` (e.g. Ctrl+C for a running command) or a raw key reader.
 */
export function createLineEditor(term: Terminal) {
  let line = '';
  let cursor = 0;
  let prompt = '';
  let cursorRow = 0;
  let options: ReadLineOptions = {};
  let historyIndex = 0;
  let draft = '';
  let completing = false;
  let resolveLine: ((value: ReadLineResult) => void) | null = null;
  let rawKeyReader: ((key: string) => void) | null = null;
  let onIdleKey: ((key: string) => void) | undefined;

  const shown = (text: string) => (options.mask ? '*'.repeat([...text].length) : text);

  function render() {
    const cols = Math.max(term.cols, 1);
    const promptLength = visibleLength(prompt);
    const end = promptLength + visibleLength(shown(line));
    const at = promptLength + visibleLength(shown(line.slice(0, cursor)));

    let out = cursorRow > 0 ? `\x1b[${cursorRow}A` : '';
    out += `\r\x1b[J${prompt}${shown(line)}`;
    // A full last row leaves the cursor in the margin: move it to the next row
    if (end > 0 && end % cols === 0) out += ' \b';
    const endRow = Math.floor(end / cols);
    const row = Math.floor(at / cols);
    if (endRow > row) out += `\x1b[${endRow - row}A`;
    out += '\r';
    if (at % cols > 0) out += `\x1b[${at % cols}C`;
    cursorRow = row;
    term.write(out);
  }

  function finish(value: ReadLineResult, echo = '') {
    cursor = line.length;
    render();
    term.write(`${echo}\r\n`);
    cursorRow = 0;
    const resolve = resolveLine;
    resolveLine = null;
    resolve?.(value);
  }

  function setLine(value: string) {
    line = value;
    cursor = value.length;
    render();
  }

  function recallHistory(step: number) {
    const history = options.history;
    if (!history?.length) return;
    const index = Math.min(Math.max(historyIndex + step, 0), history.length);
    if (index === historyIndex) return;
    if (historyIndex === history.length) draft = line;
    historyIndex = index;
    setLine(index === history.length ? draft : history[index]!);
  }

  async function complete() {
    if (!options.complete || completing) return;
    completing = true;
    try {
      const before = line.slice(0, cursor);
      const { candidates, from } = await options.complete(before);
      // The line changed while completing
      if (!resolveLine || line.slice(0, cursor) !== before || candidates.length === 0) return;
      const word = before.slice(from);
      const unique = [...new Set(candidates)];
      const prefix = unique.length === 1 ? `${unique[0]}${unique[0]!.endsWith('=') ? '' : ' '}` : commonPrefix(unique);
      if (prefix.length > word.length) {
        line = line.slice(0, from) + prefix + line.slice(cursor);
        cursor = from + prefix.length;
        render();
        return;
      }
      if (unique.length > 1) {
        const width = Math.max(...unique.map((c) => c.length)) + 2;
        const perRow = Math.max(1, Math.floor(term.cols / width));
        const rows: string[] = [];
        for (let i = 0; i < unique.length; i += perRow)
          rows.push(
            unique
              .slice(i, i + perRow)
              .map((c) => c.padEnd(width))
              .join('')
              .trimEnd(),
          );
        const saved = cursor;
        cursor = line.length;
        render();
        term.write(`\r\n\x1b[2m${rows.join('\r\n')}\x1b[0m\r\n`);
        cursorRow = 0;
        cursor = saved;
        render();
      }
    } finally {
      completing = false;
    }
  }

  function insert(text: string) {
    line = line.slice(0, cursor) + text + line.slice(cursor);
    cursor += text.length;
    render();
  }

  function handleKey(key: string) {
    switch (key) {
      case '\r':
      case '\n':
        return finish(line);
      case '\x03':
        line = '';
        return finish(REPL_SIGINT, '^C');
      case '\x04':
        if (line.length === 0) return finish(null);
        if (cursor < line.length) {
          line = line.slice(0, cursor) + line.slice(cursor + 1);
          render();
        }
        return;
      case '\x7f':
      case '\b':
        if (cursor === 0) return;
        line = line.slice(0, cursor - 1) + line.slice(cursor);
        cursor--;
        return render();
      case '\x1b[3~':
        if (cursor === line.length) return;
        line = line.slice(0, cursor) + line.slice(cursor + 1);
        return render();
      case '\t':
        return void complete();
      case '\x1b[D':
      case '\x02':
        if (cursor > 0) cursor--;
        return render();
      case '\x1b[C':
      case '\x06':
        if (cursor < line.length) cursor++;
        return render();
      case '\x1b[H':
      case '\x1bOH':
      case '\x1b[1~':
      case '\x01':
        cursor = 0;
        return render();
      case '\x1b[F':
      case '\x1bOF':
      case '\x1b[4~':
      case '\x05':
        cursor = line.length;
        return render();
      case '\x1b[A':
      case '\x10':
        return recallHistory(-1);
      case '\x1b[B':
      case '\x0e':
        return recallHistory(1);
      case '\x15':
        line = line.slice(cursor);
        cursor = 0;
        return render();
      case '\x0b':
        line = line.slice(0, cursor);
        return render();
      case '\x17': {
        const start = line.slice(0, cursor).replace(/\S+\s*$/, '').length;
        line = line.slice(0, start) + line.slice(cursor);
        cursor = start;
        return render();
      }
      case '\x0c':
        term.write('\x1b[H\x1b[2J');
        cursorRow = 0;
        return render();
    }
    if (key.startsWith('\x1b')) return;
    // Typed characters or a paste: a pasted newline submits the line
    const [first, ...rest] = key.replace(/\r\n?/g, '\n').split('\n');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: drops control characters from typed text
    const text = first!.replace(/[\x00-\x1f\x7f]/g, '');
    if (text) insert(text);
    if (rest.length > 0) finish(line);
  }

  return {
    /** Feed `term.onData` into this. */
    onData(data: string) {
      if (rawKeyReader) {
        const reader = rawKeyReader;
        rawKeyReader = null;
        return reader(data);
      }
      if (resolveLine) return handleKey(data);
      onIdleKey?.(data);
    },
    readLine(promptText: string, readOptions: ReadLineOptions = {}): Promise<ReadLineResult> {
      prompt = promptText;
      options = readOptions;
      line = readOptions.initial ?? '';
      cursor = line.length;
      cursorRow = 0;
      historyIndex = readOptions.history?.length ?? 0;
      draft = '';
      render();
      return new Promise((resolve) => {
        resolveLine = resolve;
      });
    },
    /** Resolves with the next key press, for select prompts and the pager. */
    readKey(): Promise<string> {
      return new Promise((resolve) => {
        rawKeyReader = resolve;
      });
    },
    /** Called with keys pressed while nothing is reading input. */
    set onIdleKey(handler: ((key: string) => void) | undefined) {
      onIdleKey = handler;
    },
    get busy() {
      return resolveLine !== null || rawKeyReader !== null;
    },
  };
}

export type LineEditor = ReturnType<typeof createLineEditor>;
