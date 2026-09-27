/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests contain dotenv variable expansion syntax */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InteractivePromptConfig } from 'padrone';
import { createPadrone, padroneConfig, padroneConfirm, padroneEnv, padroneJson } from 'padrone';
import * as z from 'zod/v4';
import { createDefaultRuntime } from '../src/core/default-runtime.ts';
import { loadConfig } from '../src/extension/config-loader.ts';
import { loadEnvFiles, parseEnvFile } from '../src/util/dotenv.ts';
import { compileJq } from '../src/util/jq.ts';

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-sweep3-'));
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Temporarily sets `isTTY` on a process stream. */
function stubTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean | undefined): () => void {
  const own = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
  return () => {
    if (own) Object.defineProperty(stream, 'isTTY', own);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };
}

describe('interactive detection needs a terminal stdin', () => {
  it('disables prompting when stdin is not a TTY', () => {
    const env = { CI: process.env.CI, CONTINUOUS_INTEGRATION: process.env.CONTINUOUS_INTEGRATION };
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    const restoreOut = stubTTY(process.stdout, true);
    const restoreIn = stubTTY(process.stdin, undefined);
    try {
      expect(createDefaultRuntime().interactive).toBe('disabled');
      process.stdin.isTTY = true;
      expect(createDefaultRuntime().interactive).toBe('supported');
    } finally {
      restoreIn();
      restoreOut();
      for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
    }
  });
});

describe('confirm', () => {
  const create = (runtime: Record<string, unknown>) => {
    const prompt = mock(async () => true);
    const ran = mock(() => 'dropped');
    const program = createPadrone('db')
      .runtime({ output: () => {}, error: () => {}, setExitCode: () => {}, prompt, ...runtime })
      .extend(padroneConfirm())
      .command('drop', (c) => c.configure({ mutation: true }).action(ran));
    const cli = (...argv: string[]) => program.cli({ runtime: { argv: () => argv } });
    return { prompt, ran, cli };
  };

  it('fails instead of prompting when the runtime stdin is piped', async () => {
    const { prompt, ran, cli } = create({
      interactive: 'supported',
      stdin: { isTTY: false, text: async () => '', lines: async function* () {} },
    });
    const result = await cli('drop');
    expect((result.error as Error).message).toContain('needs confirmation');
    expect(prompt).not.toHaveBeenCalled();
    expect(ran).not.toHaveBeenCalled();
  });

  it('treats --no-interactive and -i=false like no terminal', async () => {
    const { prompt, ran, cli } = create({ interactive: 'supported' });
    for (const flag of ['--no-interactive', '-i=false', '--interactive=false']) {
      expect(((await cli('drop', flag)).error as Error).message).toContain('needs confirmation');
    }
    expect(prompt).not.toHaveBeenCalled();
    expect((await cli('drop', '--no-interactive', '--yes')).result).toBe('dropped');
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('prompts with -i even when the runtime is not interactive', async () => {
    const { prompt, cli } = create({ interactive: 'disabled' });
    expect((await cli('drop', '-i')).result).toBe('dropped');
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe('interactive prompting with piped stdin', () => {
  it('uses the stdin TTY state, not stdout, for the default runtime stdin', async () => {
    const restore = stubTTY(process.stdin, undefined);
    try {
      const prompt = mock(async () => 'Alice');
      const program = createPadrone('app')
        .runtime({ interactive: 'supported', prompt, terminal: { isTTY: true }, output: () => {}, error: () => {} })
        .command('greet', (c) =>
          c
            .arguments(z.object({ name: z.string(), data: z.string().optional() }), { interactive: true, stdin: 'data' })
            .action((args) => args.name),
        );
      expect((await program.eval('greet --data x')).argsResult?.issues).toBeDefined();
      expect(prompt).not.toHaveBeenCalled();
      expect((await program.eval('greet --data x -i')).result).toBe('Alice');
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});

describe('prompt answers are coerced', () => {
  const run = async (schema: z.ZodObject, answers: Record<string, unknown>) => {
    let calls = 0;
    // Re-prompting for an invalid answer would loop forever
    const prompt = mock(async (config: InteractivePromptConfig) => {
      if (++calls > 5) throw new Error(`re-prompted for ${config.name}`);
      return answers[config.name];
    });
    const errors: string[] = [];
    const program = createPadrone('app')
      .runtime({ interactive: 'supported', prompt, error: (text) => errors.push(text) })
      .command('run', (c) => c.arguments(schema, { interactive: true }).action((args) => args));
    const result = await program.eval('run');
    return { result, prompt, errors };
  };

  it('coerces text answers for number, integer and array fields', async () => {
    const { result, prompt, errors } = await run(z.object({ port: z.number(), count: z.number().int(), ids: z.array(z.number()) }), {
      port: '8080',
      count: '3',
      ids: '1, 2',
    });
    expect(result.args).toEqual({ port: 8080, count: 3, ids: [1, 2] });
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(errors).toEqual([]);
  });

  it('maps select and multiselect answers back to their choice values', async () => {
    const { result, prompt } = await run(z.object({ level: z.literal([1, 2]), sizes: z.array(z.literal([10, 20])) }), {
      level: '2',
      sizes: ['10', '20'],
    });
    expect(prompt.mock.calls.map(([config]) => config.type)).toEqual(['select', 'multiselect']);
    expect(result.args).toEqual({ level: 2, sizes: [10, 20] });
  });
});

describe('validate overrides reach execute', () => {
  it('shows .env variables in ctx.runtime.env() inside the action', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'FOO=from-file\n');
    const program = createPadrone('app')
      .extend(padroneEnv({ dir: tempDir }))
      .action((_args, ctx) => ctx.runtime.env().FOO);
    const result = await program.eval('', { runtime: { env: () => ({}), output: () => {} } });
    expect(result.result).toBe('from-file');
  });
});

describe('dotenv', () => {
  it('keeps single-quoted values literal', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), "PASS='pa$word'\nNAME=x\nRAW='${NAME}'\n");
    expect(loadEnvFiles({ dir: tempDir }, {})).toEqual({ PASS: 'pa$word', NAME: 'x', RAW: '${NAME}' });
  });

  it('expands references to variables a later file overrides, forward references and self-references', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'URL=http://$HOST\nHOST=base\nFWD=$LATER\nLATER=late\nP=$PATH:/x\nX=$Y\nY=$X\n');
    fs.writeFileSync(path.join(tempDir, '.env.local'), 'HOST=local\n');
    expect(loadEnvFiles({ dir: tempDir }, { PATH: '/bin' })).toMatchObject({
      URL: 'http://local',
      FWD: 'late',
      P: '/bin:/x',
      X: '',
      Y: '',
    });
  });

  it('expands chained references', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'A=hello\nB="$A world"\nC=$B!\n');
    expect(loadEnvFiles({ dir: tempDir }, {})).toMatchObject({ A: 'hello', B: 'hello world', C: 'hello world!' });
  });

  it('prefers process env in the lookup unless override', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'A=file\nB=$A\n');
    expect(loadEnvFiles({ dir: tempDir }, { A: 'proc' })).toMatchObject({ B: 'proc' });
    expect(loadEnvFiles({ dir: tempDir, override: true }, { A: 'proc' })).toMatchObject({ B: 'file' });
  });

  it('unescapes double-quoted values in one pass', () => {
    expect(parseEnvFile('P="C:\\\\new"')).toEqual({ P: 'C:\\new' });
    expect(parseEnvFile('Q="a\\\\\\"b"')).toEqual({ Q: 'a\\"b' });
  });
});

describe('env without a schema', () => {
  it('lets process env beat file values unless override', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'port=3000\n');
    const create = (override: boolean) =>
      createPadrone('app')
        .extend(padroneEnv({ dir: tempDir, override }))
        .arguments(z.object({ port: z.coerce.number().optional() }))
        .action((args) => args.port);
    const runtime = { env: () => ({ port: '4000' }), output: () => {} };
    expect((await create(false).eval('', { runtime })).result).toBe(4000);
    expect((await create(true).eval('', { runtime })).result).toBe(3000);
  });
});

describe('valuesForCommand', () => {
  it('ignores keys that name Object.prototype members', () => {
    const program = createPadrone('app')
      .extend(padroneConfig({ files: ['app.json'], loadConfig: () => ({ toString: 'x', constructor: 'y', hasOwnProperty: 1, name: 'n' }) }))
      .arguments(z.object({ name: z.string() }))
      .action((args) => args);
    const result = program.eval('');
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ name: 'n' });
  });
});

describe('--json after an unknown command', () => {
  const capture = () => {
    const output: unknown[] = [];
    const errors: string[] = [];
    return {
      output,
      errors,
      runtime: { output: (...args: unknown[]) => output.push(...args), error: (text: string) => errors.push(text), setExitCode: () => {} },
    };
  };
  const program = createPadrone('app')
    .extend(padroneJson())
    .command('greet', (c) => c.action(() => 'hello'));

  for (const argv of [['--json=yes'], ['--json=1'], ['--jq', '.x'], ['--jq=.x'], ['--template', '{{.x}}']]) {
    it(`prints the routing error as JSON with ${argv.join(' ')}`, () => {
      const { output, errors, runtime } = capture();
      program.cli({ runtime: { ...runtime, argv: () => ['nope', ...argv] } });
      expect(errors).toEqual([]);
      expect(JSON.parse(output[0] as string).error.name).toBe('RoutingError');
    });
  }

  it('keeps text errors with --json=false', () => {
    const { output, errors, runtime } = capture();
    program.cli({ runtime: { ...runtime, argv: () => ['nope', '--json=false'] } });
    expect(output).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('jq 1.7 compatibility', () => {
  const jq = (expression: string, input: unknown) => compileJq(expression)(input);

  it('has() on arrays rejects negative indexes', () => {
    expect(jq('has(-1), has(0), has(2)', [1, 2])).toEqual([false, true, false]);
    expect(() => jq('has("a")', [1])).toThrow();
    expect(() => jq('has(0)', { a: 1 })).toThrow();
  });

  it('tonumber accepts only number syntax', () => {
    expect(jq('tonumber', '1.5e2')).toEqual([150]);
    for (const input of ['', ' 1 ', '0x10', 'Infinity', 'abc']) expect(() => jq('tonumber', input)).toThrow();
  });

  it('to_entries on arrays uses numeric keys', () => {
    expect(jq('to_entries', ['a', 'b'])).toEqual([
      [
        { key: 0, value: 'a' },
        { key: 1, value: 'b' },
      ],
    ]);
    expect(() => jq('to_entries', 'x')).toThrow();
  });

  it('select emits once per truthy output', () => {
    expect(jq('select(true, false, 1)', 'x')).toEqual(['x', 'x']);
  });

  it('floors fractional indexes and counts string length in code points', () => {
    expect(jq('.[1.7]', [1, 2, 3])).toEqual([2]);
    expect(jq('length', 'a😀')).toEqual([2]);
  });
});

describe('extensionless rc files', () => {
  it('allow comments and trailing commas', async () => {
    const file = path.join(tempDir, '.myapprc');
    fs.writeFileSync(file, '{\n  // comment\n  "port": 1, /* inline */\n  "tags": ["a",],\n}\n');
    expect(await loadConfig(file)).toEqual({ port: 1, tags: ['a'] });
  });
});
