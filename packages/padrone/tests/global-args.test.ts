import { describe, expect, it } from 'bun:test';
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';
import { buildInputSchema, getCommand, resolveCommand } from '../src/core/commands.ts';

const issuesOf = (result: { argsResult?: { issues?: readonly { path?: readonly unknown[]; message: string }[] } }) =>
  result.argsResult?.issues?.map((i) => `${i.path?.join('.')}: ${i.message}`);

function createProgram() {
  return createPadrone('app')
    .globalArgs(
      z.object({
        verbose: z.boolean().optional().meta({ flags: 'v' }),
        profile: z.string().default('default'),
        format: z.enum(['text', 'json']).optional(),
      }),
    )
    .arguments(z.object({ dryRun: z.boolean().optional() }))
    .action((args) => args)
    .command('deploy', (c) =>
      c
        .arguments(z.object({ env: z.string(), replicas: z.number().optional() }), { positional: ['env'] })
        .action((args) => args)
        .command('status', (s) => s.action((args) => args)),
    )
    .command('logs', (c) => c.action((args) => args))
    .command('scale', (c) =>
      // Overrides the global `verbose` with its own definition
      c.arguments(z.object({ verbose: z.number().optional() })).action((args) => args),
    )
    .command('cloud', (c) =>
      c
        .globalArgs((inherited) => inherited.extend({ region: z.string().optional().meta({ flags: 'r' }) }))
        .command('up', (u) => u.action((args) => args)),
    );
}

describe('globalArgs', () => {
  it('merges global args into a subcommand, after the subcommand name', () => {
    expect(createProgram().eval(['deploy', 'prod', '-v', '--profile', 'ci']).args).toEqual({
      env: 'prod',
      verbose: true,
      profile: 'ci',
    });
  });

  it('accepts global args before the subcommand name', () => {
    expect(createProgram().eval(['-v', '--profile', 'ci', 'deploy', 'prod']).args).toEqual({ env: 'prod', verbose: true, profile: 'ci' });
  });

  it('applies global defaults', () => {
    expect(createProgram().eval(['deploy', 'prod']).args).toEqual({ env: 'prod', profile: 'default' });
  });

  it('reaches nested subcommands and commands without their own arguments', () => {
    expect(createProgram().eval(['deploy', 'status', '--format', 'json']).args).toEqual({ format: 'json', profile: 'default' });
    expect(createProgram().eval(['logs', '-v']).args).toEqual({ verbose: true, profile: 'default' });
  });

  it('applies to the command that defines them', () => {
    expect(createProgram().eval(['--dry-run', '-v']).args).toEqual({ dryRun: true, verbose: true, profile: 'default' });
  });

  it('lets a subcommand override a global with its own field', () => {
    expect(createProgram().eval(['scale', '--verbose', '3']).args).toEqual({ verbose: 3, profile: 'default' });
    // The override's flags don't include the global `-v`
    expect(issuesOf(createProgram().eval(['scale', '-v']))).toEqual(['v: Unknown option: "v"']);
  });

  it('lets a subcommand extend the globals for its subtree', () => {
    expect(createProgram().eval(['cloud', 'up', '-r', 'eu', '-v']).args).toEqual({ region: 'eu', verbose: true, profile: 'default' });
    expect(issuesOf(createProgram().eval(['logs', '--region', 'eu']))).toEqual(['region: Unknown option: "region"']);
  });

  it('validates global args', () => {
    expect(issuesOf(createProgram().eval(['logs', '--format', 'xml']))).toEqual(['format: Invalid option: expected one of "text"|"json"']);
  });

  it('reports errors from both the command and the globals', () => {
    const issues = issuesOf(createProgram().eval(['deploy', '--format', 'xml']));
    expect(issues).toHaveLength(2);
    expect(issues?.join('\n')).toContain('format:');
    expect(issues?.join('\n')).toContain('env:');
  });

  it('still rejects unknown options', () => {
    expect(issuesOf(createProgram().eval(['deploy', 'prod', '--nope']))).toEqual(['nope: Unknown option: "nope"']);
  });

  it('works with parse()', () => {
    expect(createProgram().parse(['deploy', 'prod', '-v']).args).toEqual({ env: 'prod', verbose: true, profile: 'default' });
  });
});

describe('globalArgs help', () => {
  it('lists global args under "Global Options", leaving out overridden ones', () => {
    const program = createProgram();
    const deployHelp = program.help('deploy');
    expect(deployHelp).toContain('Global Options:');
    expect(deployHelp).toContain('--profile');
    expect(deployHelp).toContain('-v, --verbose');

    const scaleHelp = program.help('scale');
    expect(scaleHelp.split('Global Options:')[1]).not.toContain('--verbose');
    expect(program.help('cloud up')).toContain('-r, --region');
  });

  it('snapshot', () => {
    expect(createProgram().help('deploy')).toMatchSnapshot();
  });
});

describe('globalArgs in tool input schemas', () => {
  it('merges global properties into the input schema used by MCP and serve', () => {
    const program = createProgram();
    const deploy = getCommand(program).commands!.find((c) => c.name === 'deploy')!;
    const schema = buildInputSchema(resolveCommand(deploy)) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(['env', 'format', 'profile', 'replicas', 'verbose']);
    expect(schema.required).toContain('env');

    const scale = resolveCommand(getCommand(program).commands!.find((c) => c.name === 'scale')!);
    expect((buildInputSchema(scale) as { properties: Record<string, { type: string }> }).properties.verbose?.type).toBe('number');
  });
});
