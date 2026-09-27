import { createKitchen, createPizza } from '@padrone/pizza-example';
import { FitAddon, init, Terminal } from 'ghostty-web';
import { useCallback, useRef, useState } from 'react';
import { createLineEditor } from './terminal/line-editor.ts';
import { installProcessShim } from './terminal/runtime.ts';
import { createShell, type Shell } from './terminal/shell.ts';
import { createVfs } from './terminal/vfs.ts';

const terminalTheme = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  black: '#32344a',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#ad8ee6',
  cyan: '#449dab',
  white: '#9699a8',
  brightBlack: '#444b6a',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#acb0d0',
};

const SUGGESTIONS = [
  'pizza --help',
  'pizza menu',
  'pizza order',
  'pizza order diavola -ppp --pickup --dry-run',
  'pizza orders track 2',
  'pizza chef ask how do you make the dough?',
  'pizza admin restock --fast',
  "pizza menu --json --jq '.[].pizza'",
  'pizza ordr',
  'pizza repl',
];

const GREETING = [
  '\x1b[1mWelcome to the Padrone playground!\x1b[0m 🍕',
  'A real Padrone CLI runs right here in your browser: \x1b[1;33mpizza\x1b[0m.',
  '',
  `Try \x1b[36mpizza menu\x1b[0m, \x1b[36mpizza order\x1b[0m or \x1b[36mpizza --help\x1b[0m.`,
  '\x1b[2mTab completes commands and flags, ↑/↓ browse history, Ctrl+C cancels. Type "help" for more.\x1b[0m',
  '',
  '',
].join('\n');

type Playground = { shell: Shell; focus: () => void };

async function startTerminal(el: HTMLDivElement): Promise<Playground> {
  await init();

  const term = new Terminal({
    // Phones get more columns out of a smaller font
    fontSize: el.clientWidth < 640 ? 11 : 14,
    cursorBlink: true,
    cursorStyle: 'bar',
    convertEol: true,
    scrollback: 10000,
    fontFamily: 'Monaco, Menlo, "Courier New", monospace',
    theme: terminalTheme,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(el);
  fitAddon.fit();
  fitAddon.observeResize();

  // Ghostty renders an absolutely-positioned textarea for input capture: keep it inside the terminal
  el.style.position = 'relative';
  el.style.caretColor = 'transparent';
  const textarea = el.querySelector('textarea');
  if (textarea) {
    textarea.style.pointerEvents = 'none';
    textarea.style.caretColor = 'transparent';
  }

  installProcessShim(term);

  const editor = createLineEditor(term);
  term.onData((data) => editor.onData(data));

  const vfs = createVfs();
  const kitchen = createKitchen();
  const pizza = createPizza({ loadConfig: (files) => vfs.loadConfig(files) });
  // Completion runs the program's own `__complete` command, as the shell scripts from `pizza completion` do
  const completer = pizza.runtime({ output: () => {}, error: () => {}, interactive: 'unsupported', terminal: { isTTY: false } });

  const shell = createShell({
    term,
    editor,
    vfs,
    programs: {
      pizza: {
        description: 'Padrone Pizza, the demo CLI (try "pizza --help")',
        run: async (runtime) => {
          await pizza.runtime(runtime).cli({ context: { kitchen } }).drain();
        },
        complete: async (words) => {
          const { result } = await completer.eval(['__complete', ...words], { context: { kitchen } });
          return Array.isArray(result) ? result.map(String) : [];
        },
      },
    },
  });

  term.focus();
  void shell.start(GREETING);
  return { shell, focus: () => term.focus() };
}

export function TerminalRender() {
  const playgroundRef = useRef<Promise<Playground> | null>(null);
  const [ready, setReady] = useState(false);

  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el || playgroundRef.current) return;
    playgroundRef.current = startTerminal(el);
    void playgroundRef.current.then(() => setReady(true));
  }, []);

  const run = async (command: string) => {
    const playground = await playgroundRef.current;
    playground?.focus();
    await playground?.shell.type(command);
  };

  return (
    <div className="not-content flex flex-col gap-3">
      <div className="scheme-dark w-full rounded-xl overflow-hidden shadow-2xl border border-[#2a2b3d]">
        <div className="bg-[#1a1b26] px-4 py-3 flex items-center gap-2 border-b border-[#2a2b3d]">
          <div className="size-3 rounded-full bg-[#f7768e]" />
          <div className="size-3 rounded-full bg-[#e0af68]" />
          <div className="size-3 rounded-full bg-[#9ece6a]" />
          <span className="ml-2 text-gray-300 text-sm font-medium">guest@padrone: ~</span>
        </div>
        <div ref={ref} data-terminal className="h-[26rem] p-1 bg-[#1a1b26]" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="opacity-70">Try:</span>
        {SUGGESTIONS.map((command) => (
          <button
            key={command}
            type="button"
            disabled={!ready}
            onClick={() => void run(command)}
            className="cursor-pointer rounded-md border border-[#2a2b3d] bg-[#1a1b26] px-2 py-1 font-mono text-xs text-[#a9b1d6] hover:border-[#7aa2f7] hover:text-[#c0caf5] disabled:opacity-50"
          >
            {command}
          </button>
        ))}
      </div>
    </div>
  );
}
