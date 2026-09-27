import { describe, expect, it, mock } from 'bun:test';
import { createPadrone, padroneConfirm } from 'padrone';
import * as z from 'zod/v4';

const createProgram = (
  prompt?: (config: { message: string; type: string }) => Promise<unknown>,
  options?: Parameters<typeof padroneConfirm>[0],
) => {
  const ran = mock(() => 'dropped');
  const errors: string[] = [];
  const program = createPadrone('db')
    .runtime({
      output: () => {},
      error: (text) => errors.push(text),
      setExitCode: () => {},
      prompt,
      interactive: prompt ? 'supported' : 'unsupported',
    })
    .extend(padroneConfirm(options))
    .command('drop', (c) => c.configure({ mutation: true }).action(ran))
    .command('list', (c) => c.action(() => 'tables'));
  const cli = (...argv: string[]) => program.cli({ runtime: { argv: () => argv } });
  return { program, ran, errors, cli };
};

describe('padroneConfirm', () => {
  it('asks before running a mutation command', async () => {
    const prompt = mock(async () => true);
    const { ran, cli } = createProgram(prompt);
    const result = await cli('drop');
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ type: 'confirm', message: 'Run "drop"?' }));
    expect(ran).toHaveBeenCalled();
    expect(result.result).toBe('dropped');
  });

  it('aborts when the answer is no', async () => {
    const { ran, errors, cli } = createProgram(async () => false);
    const result = await cli('drop');
    expect(ran).not.toHaveBeenCalled();
    expect((result.error as Error).message).toBe('Aborted');
    expect(errors).toEqual(['Aborted']);
  });

  it('skips the question with --yes or -y', async () => {
    const prompt = mock(async () => false);
    const { ran, cli } = createProgram(prompt);
    await cli('drop', '--yes');
    await cli('drop', '-y');
    expect(prompt).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('fails without a terminal to ask in, unless --yes is passed', async () => {
    const { ran, cli } = createProgram();
    const result = await cli('drop');
    expect((result.error as Error).message).toBe('"drop" needs confirmation: pass --yes (or set DB_YES=1) to run it without a prompt');
    expect(ran).not.toHaveBeenCalled();
    await cli('drop', '--yes');
    expect(ran).toHaveBeenCalled();
  });

  it('leaves other commands and eval() alone', async () => {
    const prompt = mock(async () => false);
    const { program, ran, cli } = createProgram(prompt);
    expect((await cli('list')).result).toBe('tables');
    expect((await program.eval('drop')).result).toBe('dropped');
    expect(prompt).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalled();
  });

  it('supports a custom message and predicate', async () => {
    const prompt = mock(async () => true);
    const { cli } = createProgram(prompt, { when: (command) => command.name === 'list', message: (command) => `Really ${command.name}?` });
    await cli('list');
    await cli('drop');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ message: 'Really list?' }));
  });
});

describe('padroneConfirm with interactive fields', () => {
  it('accepts --yes on a command that prompts for its args', async () => {
    const program = createPadrone('db')
      .runtime({ output: () => {}, error: () => {}, setExitCode: () => {}, prompt: async () => 'users', interactive: 'supported' })
      .extend(padroneConfirm())
      .command('drop', (c) =>
        c
          .configure({ mutation: true })
          .arguments(z.object({ table: z.string() }), { interactive: ['table'] })
          .action((args) => `dropped ${args.table}`),
      );
    const result = await program.cli({ runtime: { argv: () => ['drop', '--yes'] } });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('dropped users');
  });
});
