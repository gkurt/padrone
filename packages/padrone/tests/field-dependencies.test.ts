import { describe, expect, it, mock } from 'bun:test';
import { createPadrone, type InteractivePromptConfig, padroneEnv } from 'padrone';
import * as z from 'zod/v4';

const issuesOf = (result: { argsResult?: { issues?: readonly { path?: readonly unknown[]; message: string }[] } }) =>
  result.argsResult?.issues?.map((i) => `${i.path?.join('.')}: ${i.message}`);

function createProgram() {
  return createPadrone('app').command('upload', (c) =>
    c
      .arguments(
        z.object({
          file: z.string().optional(),
          user: z.string().optional(),
          password: z.string().optional(),
          token: z
            .string()
            .optional()
            .meta({ requiredUnless: ['user', 'key'] }),
          key: z.string().optional(),
          format: z.enum(['file', 'url', 'stdout']).default('stdout'),
          output: z.string().optional(),
          port: z.number().optional(),
          host: z.string().optional(),
          ci: z
            .boolean()
            .optional()
            .meta({ implies: { format: 'file' } }),
        }),
        {
          positional: ['file'],
          fields: {
            user: { requires: 'password' },
            output: { requiredIf: [{ format: 'file' }, { format: 'url', ci: true }] },
            host: { requiredIf: { port: 80 } },
          },
        },
      )
      .action((args) => args),
  );
}

describe('requires', () => {
  it('reports a missing required option at its path', () => {
    const result = createProgram().eval(['upload', '--user', 'me']);
    expect(result.args).toBeUndefined();
    expect(issuesOf(result)).toEqual(['password: Option "--user" requires "--password"']);
  });

  it('passes when the required option is given', () => {
    expect(createProgram().eval(['upload', '--user', 'me', '--password', 'pw']).args).toMatchObject({ user: 'me', password: 'pw' });
  });

  it('accepts a list, reporting each missing option', () => {
    const program = createPadrone('app').command('x', (c) =>
      c
        .arguments(
          z.object({
            a: z
              .boolean()
              .optional()
              .meta({ requires: ['b', 'c'] }),
            b: z.string().optional(),
            c: z.string().optional(),
          }),
        )
        .action((args) => args),
    );
    expect(issuesOf(program.eval(['x', '--a']))).toEqual(['b: Option "--a" requires "--b"', 'c: Option "--a" requires "--c"']);
    expect(issuesOf(program.eval(['x', '--a', '--c', '1']))).toEqual(['b: Option "--a" requires "--b"']);
    expect(program.eval(['x']).args).toEqual({});
  });
});

describe('requiredUnless', () => {
  it('requires the option unless one of the others is given', () => {
    const program = createPadrone('app').command('login', (c) =>
      c
        .arguments(
          z.object({
            token: z
              .string()
              .optional()
              .meta({ requiredUnless: ['user', 'key'] }),
            user: z.string().optional(),
            key: z.string().optional(),
          }),
        )
        .action((args) => args),
    );
    expect(issuesOf(program.eval(['login']))).toEqual(['token: Option "--token" is required unless one of "--user", "--key" is used']);
    expect(program.eval(['login', '--key', 'k']).args).toEqual({ key: 'k' });
    expect(program.eval(['login', '--token', 't']).args).toEqual({ token: 't' });
  });

  it('names a single option', () => {
    const program = createPadrone('app').command('x', (c) =>
      c
        .arguments(z.object({ a: z.string().optional(), b: z.string().optional() }), { fields: { a: { requiredUnless: 'b' } } })
        .action((args) => args),
    );
    expect(issuesOf(program.eval(['x']))).toEqual(['a: Option "--a" is required unless "--b" is used']);
  });
});

describe('requiredIf', () => {
  it('requires the option when another has the given value', () => {
    const result = createProgram().eval(['upload', '--token', 't', '--format', 'file']);
    expect(issuesOf(result)).toEqual(['output: Option "--output" is required when "--format" is "file"']);
    expect(createProgram().eval(['upload', '--token', 't', '--format', 'file', '--output', 'o']).args).toMatchObject({ output: 'o' });
  });

  it('matches any condition, each needing all of its values', () => {
    expect(createProgram().eval(['upload', '--token', 't', '--format', 'url']).args).toMatchObject({ format: 'url' });
    expect(issuesOf(createProgram().eval(['upload', '--token', 't', '--format', 'url', '--ci']))).toContain(
      'output: Option "--output" is required when "--format" is "url" and "--ci" is true',
    );
  });

  it('ignores schema defaults', () => {
    const program = createPadrone('app').command('x', (c) =>
      c
        .arguments(z.object({ mode: z.string().default('file'), out: z.string().optional() }), {
          fields: { out: { requiredIf: { mode: 'file' } } },
        })
        .action((args) => args),
    );
    expect(program.eval(['x']).args).toEqual({ mode: 'file' });
    expect(issuesOf(program.eval(['x', '--mode', 'file']))).toEqual(['out: Option "--out" is required when "--mode" is "file"']);
  });

  it('compares the coerced value', () => {
    expect(issuesOf(createProgram().eval(['upload', '--token', 't', '--port', '80']))).toEqual([
      'host: Option "--host" is required when "--port" is 80',
    ]);
    expect(createProgram().eval(['upload', '--token', 't', '--port', '8080']).args).toMatchObject({ port: 8080 });
  });

  it('counts implied values', () => {
    // --ci implies --format=file, which requires --output
    expect(issuesOf(createProgram().eval(['upload', '--token', 't', '--ci']))).toEqual([
      'output: Option "--output" is required when "--format" is "file"',
    ]);
  });
});

describe('provided values', () => {
  it('counts positionals', () => {
    const program = createPadrone('app').command('x', (c) =>
      c
        .arguments(z.object({ src: z.string().optional(), dest: z.string().optional().meta({ requires: 'src' }) }), {
          positional: ['src'],
        })
        .action((args) => args),
    );
    expect(program.eval(['x', 'a', '--dest', 'b']).args).toEqual({ src: 'a', dest: 'b' });
    expect(issuesOf(program.eval(['x', '--dest', 'b']))).toEqual(['src: Option "--dest" requires "--src"']);
  });

  it('counts env values', async () => {
    const program = (env: Record<string, string>) =>
      createPadrone('app')
        .runtime({ env: () => env })
        .extend(padroneEnv({ vars: { password: 'APP_PASSWORD' } }))
        .command('login', (c) =>
          c
            .arguments(z.object({ user: z.string().optional().meta({ requires: 'password' }), password: z.string().optional() }))
            .action((args) => args),
        );
    expect((await program({ APP_PASSWORD: 'pw' }).eval('login --user me')).args).toEqual({ user: 'me', password: 'pw' });
    expect(issuesOf(await program({}).eval('login --user me'))).toEqual(['password: Option "--user" requires "--password"']);
  });
});

describe('global args', () => {
  const program = () =>
    createPadrone('app')
      .globalArgs(
        z.object({
          profile: z.string().optional(),
          region: z
            .string()
            .optional()
            .meta({ requiredIf: { profile: 'prod' } }),
          apiKey: z.string().optional(),
        }),
        { fields: { apiKey: { requiredUnless: 'profile' } } },
      )
      .command('deploy', (c) => c.arguments(z.object({ force: z.boolean().optional() })).action((args) => args))
      .command('status', (c) => c.arguments(z.object({ apiKey: z.string().default('local') })).action((args) => args));

  it('checks global field rules in subcommands', () => {
    expect(issuesOf(program().eval(['deploy', '--profile', 'prod']))).toEqual([
      'region: Option "--region" is required when "--profile" is "prod"',
    ]);
    expect(issuesOf(program().eval(['deploy']))).toEqual(['apiKey: Option "--api-key" is required unless "--profile" is used']);
    expect(program().eval(['deploy', '--profile', 'prod', '--region', 'eu']).args).toEqual({ profile: 'prod', region: 'eu' });
  });

  it('skips rules for globals the command overrides', () => {
    expect(program().eval(['status']).args).toEqual({ apiKey: 'local' });
  });
});

describe('help', () => {
  it('shows requires, requiredIf and requiredUnless notes', () => {
    const help = createProgram().help('upload');
    expect(help).toContain('(requires --password)');
    expect(help).toContain('(required if --format=file or --format=url and --ci)');
    expect(help).toContain('(required if --port=80)');
    expect(help).toContain('(required unless --user or --key)');
  });
});

describe('interactive prompting', () => {
  const program = (prompt: (config: InteractivePromptConfig) => Promise<unknown>, interactive: true | string[]) =>
    createPadrone('app')
      .runtime({ interactive: 'supported', prompt })
      .command('upload', (c) =>
        c
          .arguments(
            z.object({
              format: z.enum(['file', 'stdout']).default('stdout'),
              output: z
                .string()
                .optional()
                .meta({ requiredIf: { format: 'file' } }),
              verbose: z.boolean().optional(),
            }),
            { interactive: interactive as ['output'] },
          )
          .action((args) => args),
      );

  it('prompts for a field made required by requiredIf', async () => {
    const prompt = mock(async (config: InteractivePromptConfig) => (config.name === 'output' ? 'out.txt' : undefined));
    const result = await program(prompt, true).eval('upload --format file');
    expect(result.args).toEqual({ format: 'file', output: 'out.txt' });
    expect(prompt.mock.calls.map(([config]) => config.name)).toEqual(['output']);
  });

  it('does not prompt when the condition does not match', async () => {
    const prompt = mock(async () => 'x');
    expect((await program(prompt, true).eval('upload')).args).toEqual({ format: 'stdout' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('reports the field when it is not interactive', async () => {
    const prompt = mock(async () => 'x');
    const result = await program(prompt, ['verbose']).eval('upload --format file --verbose');
    expect(issuesOf(result)).toEqual(['output: Option "--output" is required when "--format" is "file"']);
  });
});
