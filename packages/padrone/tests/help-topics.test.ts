import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPadrone, padroneHelp } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import { generateDocs } from '../src/docs/index.ts';

const ENV_TOPIC = '# Environment\n\n- `APP_TOKEN`: the API token';

const makeProgram = (options: { pager?: boolean } = {}) =>
  createPadrone('app', {
    builtins: {
      help: {
        ...options,
        topics: {
          environment: { title: 'Environment variables', description: 'Variables that configure app', content: ENV_TOPIC },
          formatting: { content: ({ format }) => `Formatting (${format})` },
          deploy: { description: 'Hidden by the deploy command', content: 'topic' },
        },
      },
    },
  })
    .command('deploy', (c) => c.configure({ description: 'Deploy it' }).action(() => 'deployed'))
    .command('status', (c) => c.action(() => 'ok'));

const quiet = { output: () => {}, format: 'text' as const };

const capture = (argv: string[], runtime: Record<string, unknown> = {}) => {
  const output: unknown[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: {
      argv: () => argv,
      format: 'text' as const,
      output: (...args: unknown[]) => output.push(...args),
      error: (text: string) => errors.push(text),
      setExitCode: () => {},
      ...runtime,
    },
  };
};

describe('help topics', () => {
  it('prints a topic with `help <topic>`, as is', async () => {
    const c = capture(['help', 'environment']);
    await makeProgram().cli({ runtime: c.runtime });
    expect(c.output).toEqual([ENV_TOPIC]);
    expect(makeProgram().eval('help environment --format markdown', { runtime: quiet }).result).toBe(ENV_TOPIC);
  });

  it('calls a function topic with the format', () => {
    expect(makeProgram().eval('help formatting', { runtime: quiet }).result).toBe('Formatting (text)');
    expect(makeProgram().eval('help formatting -f markdown', { runtime: quiet }).result).toBe('Formatting (markdown)');
  });

  it('prints { topic, title, content } as JSON', () => {
    const program = makeProgram();
    expect(program.eval('help environment', { runtime: { ...quiet, format: 'json' } }).result).toEqual({
      topic: 'environment',
      title: 'Environment variables',
      content: ENV_TOPIC,
    });
    expect(JSON.parse(program.eval('help environment --format json', { runtime: quiet }).result as string)).toMatchObject({
      topic: 'environment',
    });
  });

  it('lists topics in the program help, leaving out those a command hides', () => {
    const help = makeProgram().help(undefined, { format: 'text' });
    expect(help).toContain('Additional help topics:\n  environment  Variables that configure app\n  formatting');
    expect(help).not.toContain('Hidden by the deploy command');
    expect(makeProgram().help('status', { format: 'text' })).not.toContain('Additional help topics');
    expect(createPadrone('plain').help(undefined, { format: 'text' })).not.toContain('Additional help topics');
  });

  it('lets a command of the same name win', () => {
    expect(makeProgram().eval('help deploy', { runtime: quiet }).result).toContain('Deploy it');
  });

  it('suggests topic names for `help <unknown>`', async () => {
    const c = capture(['help', 'enviroment']);
    await makeProgram().cli({ runtime: c.runtime });
    expect(c.errors[0]).toBe('Unknown command: enviroment\n\n  Did you mean "environment"?');
  });

  it('pages a long topic', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-topic-'));
    const file = path.join(dir, 'paged.txt');
    const c = capture(['help', 'environment'], {
      terminal: { isTTY: true, rows: 2, columns: 80 },
      env: () => ({ PAGER: `cat > '${file}'` }),
    });
    await makeProgram({ pager: true }).cli({ runtime: c.runtime });
    const paged = fs.readFileSync(file, 'utf-8');
    fs.rmSync(dir, { recursive: true, force: true });
    expect(c.output).toEqual([]);
    expect(paged).toContain('APP_TOKEN');
  });

  it('works through padroneHelp() too', () => {
    const program = createPadrone('app', { builtins: { help: false } }).extend(
      padroneHelp({ topics: { auth: { content: 'Log in first' } } }),
    );
    expect(program.eval('help auth', { runtime: quiet }).result).toBe('Log in first');
  });

  it('completes topics after `help`', async () => {
    const program = makeProgram().extend(padroneCompletion());
    const complete = async (...words: string[]) =>
      (await program.eval(['__complete', ...words], { runtime: { output: () => {} } })).result as unknown as string[];
    expect(await complete('help', '')).toEqual(['deploy', 'status', 'environment', 'formatting']);
    expect(await complete('help', 'e')).toEqual(['environment']);
  });

  it('generates a Markdown page per topic, linked from the index', () => {
    const { pages } = generateDocs(makeProgram(), { frontmatter: (info) => ({ title: info.title ?? info.name }) });
    const topic = pages.find((p) => p.path === 'topics/environment.md');
    expect(topic?.content).toBe(`---\ntitle: "Environment variables"\n---\n\n# Environment variables\n\n${ENV_TOPIC}\n`);
    expect(pages.find((p) => p.path === 'topics/formatting.md')?.content).toContain('Formatting (markdown)');
    expect(pages.some((p) => p.path === 'topics/deploy.md')).toBe(false);
    expect(pages[0]!.content).toContain('## Help Topics\n\n- [environment](topics/environment.md) — Variables that configure app');
  });
});
