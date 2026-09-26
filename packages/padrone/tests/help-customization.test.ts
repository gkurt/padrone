import { describe, expect, it } from 'bun:test';
import { createPadrone, type HelpInfo } from 'padrone';
import * as z from 'zod/v4';

const deploy = z.object({ env: z.string(), force: z.boolean().optional() });

describe('declarative help customization', () => {
  const program = createPadrone('app').command('deploy', (c) =>
    c
      .configure({
        description: 'Deploy the app',
        help: { usage: 'app deploy <env> [--force]', before: 'Beta: this command may change.', after: 'Docs: https://example.com/deploy' },
      })
      .arguments(deploy, { positional: ['env'] })
      .action(() => 'deployed'),
  );

  it('replaces the usage line and adds text before and after', () => {
    const help = program.help('deploy', { format: 'text' });
    const lines = help.split('\n');
    expect(lines[0]).toBe('Beta: this command may change.');
    expect(help).toContain('Usage: app deploy <env> [--force]');
    expect(help.trimEnd().endsWith('Docs: https://example.com/deploy')).toBe(true);
  });

  it('is exposed in structured help', () => {
    const info = JSON.parse(program.help('deploy', { format: 'json' })) as HelpInfo;
    expect(info.before).toBe('Beta: this command may change.');
    expect(info.after).toBe('Docs: https://example.com/deploy');
    expect(info.usage.text).toBe('app deploy <env> [--force]');
  });

  it('applies to the minimal usage line', () => {
    expect(program.help('deploy', { detail: 'minimal' })).toBe('app deploy <env> [--force]');
  });

  it('applies only to the command that sets it', () => {
    expect(program.help('', { format: 'text' })).not.toContain('Beta:');
  });
});

describe('function help customization', () => {
  it('can modify the help info', () => {
    const program = createPadrone('app')
      .configure({
        version: '1.2.3',
        help: (info) => ({ ...info, after: `Version ${'1.2.3'}`, arguments: info.arguments?.filter((a) => a.name !== 'force') }),
      })
      .command('deploy', (c) => c.arguments(deploy, { positional: ['env'] }).action(() => 'deployed'));
    const help = program.help('deploy', { format: 'text' });
    expect(help).toContain('Version 1.2.3');
    expect(help).not.toContain('--force');
  });

  it('can return a final string, using the built-in renderer', () => {
    const program = createPadrone('app').command('deploy', (c) =>
      c
        .configure({ help: (info, ctx) => `== ${info.name} ==\n${ctx.render(info)}` })
        .arguments(deploy, { positional: ['env'] })
        .action(() => 'deployed'),
    );
    expect(program.help('deploy', { format: 'text' }).startsWith('== deploy ==\nUsage: app deploy')).toBe(true);
  });

  it('receives declarative parts, the command and the format', () => {
    let seen: { before?: string; format?: string; command?: unknown } = {};
    const program = createPadrone('app').command('deploy', (c) =>
      c
        .configure({
          help: (info, ctx) => {
            seen = { before: info.before, format: ctx.format, command: (ctx.command as { name: string }).name };
            return info;
          },
        })
        .action(() => 'deployed'),
    );
    program.help('deploy', { format: 'markdown' });
    expect(seen).toEqual({ before: undefined, format: 'markdown', command: 'deploy' });
  });

  it('applies to subcommands, and a nearer function wins', () => {
    const program = createPadrone('app')
      .configure({ help: () => 'root help' })
      .command('a', (c) => c.action(() => 'a'))
      .command('b', (c) => c.configure({ help: () => 'b help' }).action(() => 'b'));
    expect(program.help('a')).toBe('root help');
    expect(program.help('b')).toBe('b help');
  });

  it('is used by --help and the help command', () => {
    const program = createPadrone('app')
      .configure({ help: () => 'custom help' })
      .command('deploy', (c) => c.action(() => 'deployed'));
    expect(program.eval('deploy --help').result).toBe('custom help');
    expect(program.eval('help deploy').result).toBe('custom help');
  });
});

describe('renamed help and version flags', () => {
  it('uses custom help flags', () => {
    const program = createPadrone('app', { builtins: { help: { flags: ['info', '?'] } } }).command('deploy', (c) =>
      c.configure({ description: 'Deploy it' }).action(() => 'deployed'),
    );
    expect(program.eval('deploy --info').result).toContain('Deploy it');
    expect(program.eval(['deploy', '-?']).result).toContain('Deploy it');
    // --help is no longer a help flag
    expect(program.eval('deploy --help').argsResult?.issues?.[0]?.message).toBe('Unknown option: "help"');
  });

  it('points error hints at the custom flag, or the help command without flags', () => {
    for (const [flags, hint] of [
      [['info'], 'Run "app deploy --info" for usage.'],
      [[], 'Run "app help deploy" for usage.'],
    ] as const) {
      const errors: string[] = [];
      createPadrone('app', { builtins: { help: { flags } } })
        .runtime({ error: (msg) => errors.push(msg), argv: () => ['deploy', '--nope'] })
        .command('deploy', (c) => c.action(() => 'deployed'))
        .cli();
      expect(errors.at(-1)).toBe(`\n${hint}`);
    }
  });

  it('uses custom version flags', () => {
    const program = createPadrone('app', { builtins: { version: { flags: ['version'] } } })
      .configure({ version: '1.2.3' })
      .arguments(z.object({ verbose: z.boolean().optional().meta({ flags: 'v' }) }))
      .action((args) => args);
    expect(program.eval('--version').result as unknown).toBe('1.2.3');
    expect(program.eval('-V').argsResult?.issues?.[0]?.message).toBe('Unknown option: "V"');
  });
});
