import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnyPadroneCommand, PadroneConfigOptions } from 'padrone';
import { createPadrone, padroneConfig } from 'padrone';
import * as z from 'zod/v4';

let tempDir: string;
let userDir: string;
let env: Record<string, string | undefined>;
const originalCwd = process.cwd();

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-config-command-')));
  userDir = path.join(tempDir, 'xdg', 'app');
  env = { HOME: tempDir, XDG_CONFIG_HOME: path.join(tempDir, 'xdg') };
  fs.mkdirSync(path.join(tempDir, 'work'));
  process.chdir(path.join(tempDir, 'work'));
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const userFile = (name = 'config.json') => path.join(userDir, name);
const readUser = (name?: string) => JSON.parse(fs.readFileSync(userFile(name), 'utf-8'));
const writeUser = (data: unknown, name = 'config.json') => {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile(name), typeof data === 'string' ? data : JSON.stringify(data));
};

const parsedCommand = (program: { parse: (input: string) => unknown }, input: string) =>
  (program.parse(input) as { command: AnyPadroneCommand }).command;

function create(options: PadroneConfigOptions = {}, runtime: Record<string, unknown> = {}) {
  const program = createPadrone('app')
    .runtime({ env: () => env, output: () => {}, error: () => {}, ...runtime })
    .extend(padroneConfig({ command: true, ...options }))
    .globalArgs(z.object({ token: z.string().optional() }))
    .command('serve', (c) =>
      c
        .arguments(
          z.object({
            port: z.number().int().optional(),
            dryRun: z.boolean().optional(),
            db: z.object({ host: z.string(), port: z.number().optional() }).optional(),
          }),
        )
        .action((args) => args),
    );
  const run = async (input: string) => {
    const { result, error } = await program.eval(input);
    if (error) throw error;
    return result as any;
  };
  const fail = async (input: string) => ((await program.eval(input)).error as Error | undefined)?.message;
  return { program, run, fail };
}

describe('config command', () => {
  it('is not added by default', async () => {
    const program = createPadrone('app').extend(padroneConfig({ files: ['config.json'] }));
    expect(parsedCommand(program, 'config get port').name).toBe('app');
  });

  it('sets, gets and unsets values in the user config file', async () => {
    const { run, fail } = create();
    expect(await run('config set port 8080')).toContain(userFile());
    await run('config set db.host localhost');
    expect(readUser()).toEqual({ port: 8080, db: { host: 'localhost' } });
    expect(await run('config get port')).toBe(8080);
    expect(await run('config get db')).toEqual({ host: 'localhost' });
    expect(await run('serve')).toEqual({ port: 8080, db: { host: 'localhost' } });

    await run('config unset db.host');
    expect(readUser()).toEqual({ port: 8080 });
    expect(await fail('config unset db.host')).toContain('"db.host" is not set');
    expect(await fail('config get db.host')).toBe('"db.host" is not set');
  });

  it('does not fill its own arguments from config files', async () => {
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {} })
      .extend(padroneConfig({ command: true }))
      .command('run', (c) => c.arguments(z.looseObject({})).action((args) => args));
    writeUser({ key: 'port', port: 1 });
    expect(((await program.eval('config get')).error as Error).message).toBe('Usage: config get <key>');
  });

  it('coerces values by the option schema and stores aliases under the option name', async () => {
    const { run } = create();
    await run('config set dry-run yes');
    await run('config set token abc');
    await run(`config set db '{"host":"h","port":5}'`);
    expect(readUser()).toEqual({ dryRun: true, token: 'abc', db: { host: 'h', port: 5 } });
  });

  it('rejects invalid values and keys no command has', async () => {
    const { fail } = create();
    expect(await fail('config set port abc')).toContain('Invalid value for "port"');
    expect(await fail('config set port 1.5')).toContain('Invalid value for "port"');
    expect(await fail('config set nope 1')).toContain('Unknown config key "nope"');
    expect(await fail('config set __proto__.x 1')).toContain('Invalid config key');
    expect(fs.existsSync(userFile())).toBe(false);
  });

  it('accepts unknown keys when a command schema is loose', async () => {
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {} })
      .extend(padroneConfig({ command: true }))
      .command('run', (c) => c.arguments(z.looseObject({ port: z.number().optional() })).action((args) => args));
    await program.eval('config set anything 42');
    expect(readUser()).toEqual({ anything: '42' });
  });

  it('validates against the config schema when one is given', async () => {
    const { run, fail } = create({ schema: z.object({ server: z.object({ port: z.number() }).optional() }) });
    await run('config set server.port 3000');
    expect(readUser()).toEqual({ server: { port: 3000 } });
    expect(await fail('config set server.port x')).toContain('Invalid value for "server.port"');
    expect(await fail('config set port 1')).toContain('Unknown config key "port"');
  });

  it('writes the first of `files` in the user config directory', async () => {
    const { run } = create({ files: ['.apprc', 'config.json'] });
    await run('config set port 1');
    expect(JSON.parse(fs.readFileSync(userFile('.apprc'), 'utf-8'))).toEqual({ port: 1 });
    writeUser({ port: 2 }, 'config.json');
    fs.rmSync(userFile('.apprc'));
    await run('config set port 3');
    expect(readUser()).toEqual({ port: 3 });
  });

  it('refuses to write YAML, TOML and script config files', async () => {
    writeUser('port: 1\n', 'config.yaml');
    const { fail } = create({ files: ['config.yaml'] });
    expect(await fail('config set port 2')).toContain('only JSON config files can be changed');
    expect(await fail('config unset port')).toContain('only JSON config files can be changed');
    expect(await create({ files: ['config.toml'] }).fail('config set port 2')).toContain('No JSON file name');
  });

  it('lists the effective values with the file each comes from', async () => {
    writeUser({ port: 1, db: { host: 'user-host' } });
    fs.writeFileSync('config.json', JSON.stringify({ port: 2 }));
    const { run } = create({ merge: true });
    const lines = (await run('config list')).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^port=2\\s+${path.join(tempDir, 'work', 'config.json')}$`));
    expect(lines[1]).toMatch(new RegExp(`^db\\.host=user-host\\s+${userFile()}$`));
    expect(await create().run('config list')).toMatch(/^port=2/);
  });

  it('shows the loaded files and the one `set` writes', async () => {
    const { run } = create({ merge: true });
    expect(await run('config path')).toBe(`User config: ${userFile()}\nNo config files found`);
    fs.writeFileSync('config.json', '{}');
    writeUser({});
    expect((await run('config path')).split('\n')).toEqual([
      `User config: ${userFile()}`,
      'Loaded (lowest precedence first):',
      `  ${userFile()}`,
      `  ${path.join(tempDir, 'work', 'config.json')}`,
    ]);
  });

  it('edits the user file in the editor and only saves parseable configs', async () => {
    let edited = '{ "port": 5 }';
    const seen: string[] = [];
    const editor = async (text: string, options?: { extension?: string }) => {
      seen.push(`${options?.extension}:${text}`);
      return edited;
    };
    const { run, fail } = create({}, { editor });
    expect(await run('config edit')).toBe(`Saved ${userFile()}`);
    expect(seen).toEqual(['.json:{\n}\n']);
    expect(readUser()).toEqual({ port: 5 });

    edited = '{ "port": ';
    expect(await fail('config edit')).toStartWith('Not saved: Invalid config file');
    expect(readUser()).toEqual({ port: 5 });
    edited = '{ "port": 5 }';
    expect(await run('config edit')).toBe('No changes');
  });

  it('marks set, unset and edit as mutations and takes a custom name', async () => {
    const { program } = create({ command: 'settings' });
    expect(parsedCommand(program, 'settings set a b').parent?.name).toBe('settings');
    const mutation = (input: string) => parsedCommand(program, input).mutation;
    expect([mutation('settings set a b'), mutation('settings unset a'), mutation('settings edit'), mutation('settings get a')]).toEqual([
      true,
      true,
      true,
      undefined,
    ]);
  });
});

describe('config profiles', () => {
  const profileConfig = {
    port: 1,
    db: { host: 'local', port: 5432 },
    profiles: { work: { port: 2, db: { host: 'work-db' } }, ci: { port: 3 } },
  };

  it('applies the profile selected by --profile over the top-level values', async () => {
    writeUser(profileConfig);
    const { run, fail } = create({ profiles: true });
    expect(await run('serve')).toEqual({ port: 1, db: { host: 'local', port: 5432 } });
    expect(await run('serve --profile work')).toEqual({ port: 2, db: { host: 'work-db', port: 5432 } });
    expect(await fail('serve --profile nope')).toBe('Unknown profile "nope". Available profiles: work, ci');
  });

  it('selects a profile from the environment and from a top-level `profile` key', async () => {
    writeUser({ ...profileConfig, profile: 'ci' });
    const { run } = create({ profiles: true });
    expect((await run('serve')).port).toBe(3);
    env.APP_PROFILE = 'work';
    expect((await run('serve')).port).toBe(2);
    expect((await run('serve --profile ci')).port).toBe(3);
  });

  it('fails for a requested profile when no config is found', async () => {
    const { fail } = create({ profiles: true });
    expect(await fail('serve --profile work')).toBe('Unknown profile "work": no profiles are defined');
  });

  it('applies to an explicit --config file', async () => {
    fs.writeFileSync('other.json', JSON.stringify(profileConfig));
    const { run } = create({ profiles: true });
    expect((await run('serve -c other.json --profile ci')).port).toBe(3);
  });

  it('takes a custom flag and environment variable', async () => {
    writeUser(profileConfig);
    const { run } = create({ profiles: { flag: 'env', env: 'APP_ENV' } });
    expect((await run('serve --env work')).port).toBe(2);
    env.APP_ENV = 'ci';
    expect((await run('serve')).port).toBe(3);
    expect(await run('config get port --env work')).toBe(2);
  });

  it('reads and writes inside a profile with `config --profile`', async () => {
    writeUser(profileConfig);
    const { run } = create({ profiles: true });
    expect(await run('config get port --profile work')).toBe(2);
    expect(await run('config get db.port --profile work')).toBe(5432);
    await run('config set port 9 --profile staging');
    await run('config unset port --profile ci');
    expect(readUser().profiles).toEqual({ work: { port: 2, db: { host: 'work-db' } }, staging: { port: 9 } });
    expect((await run('config list --profile staging')).split('\n')[0]).toBe('Profile: staging');
    expect(await run('config list --profile work')).toContain('db.host=work-db');
  });

  it('shows --profile and its environment variable in help', async () => {
    const { program } = create({ profiles: true });
    const help = program.help('serve');
    expect(help).toContain('--profile');
    expect(help).toContain('APP_PROFILE');
    expect(create().program.help('serve')).not.toContain('--profile');
  });
});
