import { describe, expect, it, mock } from 'bun:test';
import { createPadrone, type InteractivePromptConfig, redactArgs } from 'padrone';
import * as z from 'zod/v4';
import { buildInputSchema, getCommand, resolveCommand } from '../src/core/commands.ts';

function createProgram(prompt?: (config: InteractivePromptConfig) => Promise<unknown>) {
  return createPadrone('app')
    .runtime({ interactive: 'supported', ...(prompt && { prompt }) })
    .globalArgs(
      z.object({
        apiKey: z
          .string()
          .default('global-default-key')
          .meta({ sensitive: true, examples: ['sk-global'] }),
      }),
    )
    .command('login', (c) =>
      c
        .arguments(
          z.object({
            user: z.string().default('admin'),
            token: z
              .string()
              .min(12)
              .default('default-secret')
              .meta({ sensitive: true, examples: ['tok-example'] }),
            password: z.string().optional(),
            db: z.object({ host: z.string().optional(), secret: z.string().optional().meta({ sensitive: true }) }).optional(),
            hosts: z.array(z.object({ name: z.string(), key: z.string().meta({ sensitive: true }) })).optional(),
          }),
          { fields: { password: { sensitive: true } }, interactive: ['token', 'password'] },
        )
        .action((args) => args),
    );
}

const loginCommand = () => resolveCommand(getCommand(createProgram()).commands!.find((c) => c.name === 'login')!);

describe('help', () => {
  it('hides defaults and examples of sensitive fields', () => {
    const help = createProgram().help('login', { format: 'text' });
    expect(help).toContain('(default: admin)');
    expect(help).not.toContain('default-secret');
    expect(help).not.toContain('tok-example');
    expect(help).not.toContain('global-default-key');
    expect(help).not.toContain('sk-global');
  });

  it('leaves them out of the JSON help info', () => {
    const help = createProgram().help('login', { format: 'json' });
    expect(help).not.toContain('default-secret');
    expect(help).not.toContain('global-default-key');
  });
});

describe('input schema', () => {
  it('marks sensitive properties writeOnly without defaults or examples', () => {
    const { properties } = buildInputSchema(loginCommand()) as { properties: Record<string, any> };
    expect(properties.token).toMatchObject({ type: 'string', writeOnly: true });
    expect(properties.token.default).toBeUndefined();
    expect(properties.token.examples).toBeUndefined();
    expect(properties.password.writeOnly).toBe(true);
    expect(properties.apiKey).toMatchObject({ writeOnly: true });
    expect(properties.apiKey.default).toBeUndefined();
    expect(properties.db.properties.secret.writeOnly).toBe(true);
    expect(properties.user).toEqual({ type: 'string', default: 'admin' });
  });
});

describe('interactive prompts', () => {
  it('prompt sensitive fields as passwords without a default', async () => {
    const prompt = mock(async (config: InteractivePromptConfig) => (config.name === 'token' ? 'typed-secret-value' : 'pw'));
    const result = await createProgram(prompt).eval('login --interactive');
    expect(result.args).toMatchObject({ token: 'typed-secret-value', password: 'pw' });
    const configs = prompt.mock.calls.map(([config]) => config);
    expect(configs.map((c) => [c.name, c.type, c.default])).toEqual([
      ['token', 'password', undefined],
      ['password', 'password', undefined],
    ]);
  });

  it('does not show the current value of a sensitive field', async () => {
    const prompt = mock(async (config: InteractivePromptConfig) => (config.type === 'multiselect' ? [] : 'value'));
    await createPadrone('app')
      .runtime({ interactive: 'supported', prompt })
      .command('x', (c) =>
        c
          .arguments(z.object({ token: z.string().optional().meta({ sensitive: true }), name: z.string().optional() }), {
            optionalInteractive: true,
          })
          .action((args) => args),
      )
      .eval('x --token hunter2secret --name bob --interactive');
    const select = prompt.mock.calls.find(([config]) => config.type === 'multiselect')![0];
    expect(select.choices!.map((choice) => choice.label)).toEqual(['token (current: [redacted])', 'name (current: bob)']);
  });
});

describe('validation errors', () => {
  it('do not echo the value', async () => {
    const result = await createProgram().eval('login --token short-pass');
    expect(result.args).toBeUndefined();
    expect(JSON.stringify(result.argsResult?.issues)).not.toContain('short-pass');
  });
});

describe('redactArgs', () => {
  it('replaces sensitive values, nested and global ones too', () => {
    const args = {
      user: 'me',
      token: 't0ken',
      password: 'pw',
      apiKey: 'k',
      db: { host: 'h', secret: 's' },
      hosts: [{ name: 'a', key: 'k1' }],
    };
    expect(redactArgs(loginCommand(), args)).toEqual({
      user: 'me',
      token: '[redacted]',
      password: '[redacted]',
      apiKey: '[redacted]',
      db: { host: 'h', secret: '[redacted]' },
      hosts: [{ name: 'a', key: '[redacted]' }],
    });
    expect(args.token).toBe('t0ken');
  });

  it('leaves unset fields and commands without sensitive fields alone', () => {
    expect(redactArgs(loginCommand(), { user: 'me', token: undefined })).toEqual({ user: 'me', token: undefined });
    const plain = createPadrone('app').command('x', (c) => c.arguments(z.object({ a: z.string() })).action(() => {}));
    expect(redactArgs(resolveCommand(getCommand(plain).commands![0]!), { a: 'b' })).toEqual({ a: 'b' });
  });
});
