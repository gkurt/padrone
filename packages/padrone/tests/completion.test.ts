import { describe, expect, it, mock } from 'bun:test';
import { createPadrone } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import * as z from 'zod/v4';

function createProgramWithEnums() {
  return createPadrone('myapp')
    .command('deploy', (c) =>
      c
        .arguments(
          z.object({
            env: z.enum(['staging', 'production', 'dev']),
            format: z.enum(['json', 'yaml', 'toml']).default('json'),
            verbose: z.boolean().default(false),
            count: z.number().optional(),
          }),
          {
            fields: {
              env: { description: 'Target environment' },
              format: { description: 'Output format', alias: 'fmt' },
            },
          },
        )
        .action((args) => args),
    )
    .command('list', (c) =>
      c
        .arguments(
          z.object({
            status: z.enum(['active', 'archived']).optional(),
          }),
        )
        .action(() => []),
    );
}

describe('Completion - option value completion', () => {
  describe('Bash', () => {
    it('should include case statement for enum options', async () => {
      const program = createProgramWithEnums();
      const script = await program.completion('bash');

      // Should have a case block for --env with its enum values
      expect(script).toContain('--env)');
      expect(script).toContain('staging production dev');

      // Should have a case block for --format with alias
      expect(script).toContain('--format');
      expect(script).toContain('json yaml toml');

      // Should have a case block for --status
      expect(script).toContain('--status)');
      expect(script).toContain('active archived');

      // Boolean and number options should NOT have value completion case branches
      expect(script).not.toMatch(/case.*\n[\s\S]*--verbose\)/);
      expect(script).not.toMatch(/case.*\n[\s\S]*--count\)/);
    });

    it('should include alias in case patterns', async () => {
      const program = createProgramWithEnums();
      const script = await program.completion('bash');

      // --format should have --fmt alias in the same case pattern
      expect(script).toMatch(/--format\|--fmt\)/);
    });
  });

  describe('Zsh', () => {
    it('should include value actions for enum options', async () => {
      const program = createProgramWithEnums();
      const script = await program.completion('zsh');

      // Zsh uses :(val1 val2) syntax for value completion
      expect(script).toContain(':(staging production dev)');
      expect(script).toContain(':(json yaml toml)');
      expect(script).toContain(':(active archived)');

      // Boolean options should not have value actions (no :(values) after description)
      expect(script).toMatch(/--verbose\[.*\]'$/m);
    });

    it('should include descriptions in option specs', async () => {
      const program = createProgramWithEnums();
      const script = await program.completion('zsh');

      expect(script).toContain('Target environment');
      expect(script).toContain('Output format');
    });
  });

  describe('Fish', () => {
    it('should include -xa with enum values', async () => {
      const program = createProgramWithEnums();
      const script = await program.completion('fish');

      // Fish uses -xa 'val1 val2' for exclusive value completions
      expect(script).toContain("-l env -d 'Target environment' -xa 'staging production dev'");
      expect(script).toContain("-xa 'json yaml toml'");
      expect(script).toContain("-xa 'active archived'");

      // Boolean options should not have -xa
      expect(script).toMatch(/complete.*-l verbose/);
      expect(script).not.toMatch(/-l verbose.*-xa/);
    });
  });

  describe('PowerShell', () => {
    it('should include switch cases for enum options', async () => {
      const program = createProgramWithEnums();
      const script = await program.completion('powershell');

      // PowerShell uses a switch on the previous word
      expect(script).toContain("'--env'");
      expect(script).toContain("'staging', 'production', 'dev'");
      expect(script).toContain("'json', 'yaml', 'toml'");
      expect(script).toContain("'active', 'archived'");

      // Boolean/number options should not have value completion cases in the switch
      expect(script).not.toMatch(/switch[\s\S]*'--verbose'/);
      expect(script).not.toMatch(/switch[\s\S]*'--count'/);
    });

    it('should include alias in switch patterns', async () => {
      const program = createProgramWithEnums();
      const script = await program.completion('powershell');

      // format should have fmt alias in same switch case
      expect(script).toMatch(/'--format', '--fmt'/);
    });
  });

  describe('No enums', () => {
    it('should not generate value completion blocks when no enums exist', async () => {
      const program = createPadrone('simple').command('run', (c) =>
        c.arguments(z.object({ name: z.string(), verbose: z.boolean().default(false) })).action((args) => args),
      );

      const bash = await program.completion('bash');
      expect(bash).not.toContain('case "$prev"');

      const ps = await program.completion('powershell');
      expect(ps).not.toContain('switch');
    });
  });
});

describe('Dynamic completion (__complete)', () => {
  const branches = mock(async ({ prefix }: { prefix: string }) => ['main', 'develop', `feature/${prefix || 'x'}`]);
  const program = createPadrone('git')
    .extend(padroneCompletion())
    .globalArgs(z.object({ profile: z.enum(['dev', 'prod']).optional() }))
    .command('checkout', (c) =>
      c
        .arguments(z.object({ branch: z.string(), force: z.boolean().optional(), dryRun: z.boolean().optional() }), {
          positional: ['branch'],
          fields: { branch: { complete: branches }, force: { flags: 'f' } },
        })
        .action(() => {}),
    )
    .command('remote', (c) =>
      c
        .command('add', (a) => a.arguments(z.object({ kind: z.enum(['fetch', 'push']) })).action(() => {}))
        .command('remove', (a) => a.action(() => {})),
    );

  const complete = async (...words: string[]) => {
    const output: string[] = [];
    const result = await program.eval(['__complete', ...words], { runtime: { output: (text) => output.push(String(text)) } });
    return { candidates: result.result as unknown as string[], output };
  };

  it('completes subcommands at each level', async () => {
    expect((await complete('')).candidates).toEqual(['checkout', 'remote']);
    expect((await complete('remote', 're')).candidates).toEqual(['remove']);
  });

  it('completes the command’s own option names, plus inherited globals', async () => {
    expect((await complete('checkout', '--')).candidates).toEqual(['--branch', '--force', '--dry-run', '--profile', '--help']);
    expect((await complete('remote', 'add', '--k')).candidates).toEqual(['--kind']);
  });

  it('completes option values from enums, including --opt=value and bash’s split form', async () => {
    expect((await complete('remote', 'add', '--kind', '')).candidates).toEqual(['fetch', 'push']);
    expect((await complete('remote', 'add', '--kind=p')).candidates).toEqual(['--kind=push']);
    expect((await complete('remote', 'add', '--kind', '=', 'f')).candidates).toEqual(['fetch']);
    expect((await complete('checkout', '--profile', 'p')).candidates).toEqual(['prod']);
  });

  it('calls a field’s complete callback for positionals, with the typed args', async () => {
    const { candidates, output } = await complete('checkout', '--force', 'fe');
    expect(candidates).toEqual(['feature/fe']);
    expect(output).toEqual(['feature/fe']);
    expect(branches).toHaveBeenLastCalledWith({ prefix: 'fe', args: { force: true }, command: 'checkout' });
  });

  it('offers nothing after the positionals are filled', async () => {
    expect((await complete('checkout', 'main', '')).candidates).toEqual([]);
  });

  it('generates scripts that call __complete', async () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell'] as const) {
      expect(await program.completion(shell)).toContain('git __complete');
    }
    expect(await createPadrone('git').completion('bash')).not.toContain('__complete');
  });
});
