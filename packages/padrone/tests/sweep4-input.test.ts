import { afterAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InteractivePromptConfig } from 'padrone';
import { createPadrone, padroneAliases } from 'padrone';
import * as z from 'zod/v4';

const dir = mkdtempSync(join(tmpdir(), 'padrone-sweep4-input-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };
const message = (result: { error?: unknown }) => (result.error as Error | undefined)?.message;

describe('suggestions run: prompt', () => {
  it("doesn't ask with --no-interactive", async () => {
    const prompt = mock(async () => true);
    const program = createPadrone('app', { builtins: { suggestions: { run: 'prompt' } } })
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('deploy', (c) => c.action(() => 'deployed'));
    for (const flag of ['--no-interactive', '--interactive=false']) {
      const result = await program.cli({ runtime: { argv: () => ['dpeloy', flag] } });
      expect(message(result)).toContain('Did you mean "deploy"?');
    }
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('help pickSubcommand', () => {
  it("doesn't ask with --no-interactive", async () => {
    const prompt = mock(async () => 'migrate');
    const program = createPadrone('app', { builtins: { help: { pickSubcommand: true } } })
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('db', (c) => c.command('migrate', (m) => m.action(() => 'migrated')));
    const result = await program.cli({ runtime: { argv: () => ['db', '--no-interactive'] } });
    expect(prompt).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(String(result.result)).toContain('migrate');
  });
});

describe('option suggestions', () => {
  it("doesn't suggest hidden options", async () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('build', (c) =>
        c
          .arguments(z.object({ secretMode: z.boolean().optional(), debugInfo: z.boolean().optional().meta({ hidden: true }) }), {
            fields: { secretMode: { hidden: true } },
          })
          .action(() => 'built'),
      );
    const issues = (r: { argsResult?: { issues?: readonly { message: string }[] } }) => r.argsResult?.issues?.map((i) => i.message);
    expect(issues(program.eval('build --secret-mod'))).toEqual(['Unknown option: "secret-mod"']);
    expect(issues(program.eval('build --debug-inf'))).toEqual(['Unknown option: "debug-inf"']);
  });
});

describe('padroneAliases placeholders', () => {
  it('fails when an alias gets fewer arguments than its placeholders take', async () => {
    const run = mock((args: { branch: string }) => args.branch);
    const program = createPadrone('git')
      .runtime(quiet)
      .extend(padroneAliases({ file: join(dir, 'aliases.json'), aliases: { pr: 'checkout pr/$1', mv: 'checkout $1-$2' } }))
      .command('checkout', (c) => c.arguments(z.object({ branch: z.string() }), { positional: ['branch'] }).action(run));
    const cli = (...argv: string[]) => program.cli({ runtime: { argv: () => argv } });
    expect(message(await cli('pr'))).toBe('Alias "pr" needs 1 argument: checkout pr/$1');
    expect(message(await cli('mv', 'a'))).toBe('Alias "mv" needs 2 arguments: checkout $1-$2');
    expect(run).not.toHaveBeenCalled();
    expect((await cli('pr', '42')).result).toBe('pr/42');
  });
});

describe('interactive prompts', () => {
  it("doesn't prompt for object fields, which a text answer can't fill", async () => {
    const prompt = mock(async (config: InteractivePromptConfig) => (config.name === 'name' ? 'app' : 'localhost'));
    const program = createPadrone('app')
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('init', (c) =>
        c
          .arguments(z.object({ name: z.string(), db: z.object({ host: z.string() }), hosts: z.object({ name: z.string() }).array() }), {
            interactive: true,
          })
          .action((args) => args),
      );
    const result = await program.eval('init');
    expect(prompt.mock.calls.map(([config]) => config.name)).toEqual(['name']);
    expect(result.argsResult?.issues?.map((i) => i.path?.[0])).toEqual(['db', 'hosts']);
  });

  it('leaves an optional field unset when the answer is empty', async () => {
    const prompt = mock(async (config: InteractivePromptConfig) => (config.name === '_optionalFields' ? ['count', 'label'] : ''));
    const program = createPadrone('app')
      .runtime({ ...quiet, prompt, interactive: 'supported' })
      .command('init', (c) =>
        c
          .arguments(z.object({ count: z.number().optional(), label: z.string().default('none') }), { optionalInteractive: true })
          .action((args) => args),
      );
    const result = await program.eval('init');
    expect(prompt.mock.calls.map(([config]) => config.name)).toEqual(['_optionalFields', 'count', 'label']);
    expect(result.result).toEqual({ label: 'none' });
  });
});
