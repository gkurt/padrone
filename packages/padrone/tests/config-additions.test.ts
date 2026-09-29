import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PadroneConfigOptions, PadroneEnvOptions } from 'padrone';
import { createPadrone, defineInterceptor, padroneConfig, padroneEnv } from 'padrone';
import { padroneServe } from 'padrone/serve';
import * as z from 'zod/v4';
import { removeJsoncValue, setJsoncValue } from '../src/util/jsonc.ts';

let tempDir: string;
let userDir: string;
let env: Record<string, string | undefined>;
const originalCwd = process.cwd();

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-config-additions-')));
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
const writeUser = (text: string, name = 'config.json') => {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile(name), text);
};

type Loaded = Record<string, unknown> | undefined;

/** A program with a config loaded from `data` (a custom loader) and a few commands. */
function withConfig(data: Loaded, options: PadroneConfigOptions = {}, envOptions?: PadroneEnvOptions) {
  let program = createPadrone('app').runtime({ env: () => env, output: () => {}, error: () => {} }) as any;
  if (envOptions) program = program.extend(padroneEnv(envOptions));
  return program
    .extend(padroneConfig({ files: 'app.json', loadConfig: () => data, ...options }))
    .arguments(z.object({ port: z.number().optional() }))
    .action((args: unknown) => args)
    .command('serve', (c: any) =>
      c
        .arguments(
          z.object({ port: z.number().optional(), name: z.string().optional(), db: z.object({ host: z.string().optional() }).optional() }),
        )
        .action((args: unknown) => args),
    )
    .command('db', (c: any) =>
      c
        .arguments(z.object({ host: z.string().optional() }))
        .action((args: unknown) => args)
        .command('migrate', (m: any) =>
          m.arguments(z.object({ host: z.string().optional(), dryRun: z.boolean().optional() })).action((args: unknown) => args),
        ),
    );
}

const argsOf = async (program: any, input: string | string[], options?: Record<string, unknown>) => {
  const { args, error } = await program.eval(input, options);
  if (error) throw error;
  return args;
};
/** The error message, or the validation issues as `path: message` lines. */
const errorOf = async (program: any, input: string | string[], options?: Record<string, unknown>) => {
  const { error, argsResult } = await program.eval(input, options);
  const issues = (argsResult?.issues ?? []) as { path?: PropertyKey[]; message: string }[];
  return (error as Error | undefined)?.message ?? issues.map((i) => `${i.path?.join('.')}: ${i.message}`).join('\n');
};

describe('--config in help', () => {
  it('lists --config and -c', () => {
    const help = withConfig({}).help('serve', { format: 'text' });
    expect(help).toContain('--config');
    expect(help).toContain('-c');
  });

  it('shows no environment variable for --config, or for the options of built-in commands', () => {
    const help = withConfig({}, {}, { prefix: 'APP' }).help('serve', { format: 'text' });
    expect(help).toContain('APP_PORT');
    expect(help).not.toContain('APP_CONFIG');
    expect(withConfig({}, {}, { prefix: 'APP' }).help('help', { format: 'text' })).not.toContain('APP_DETAIL');
  });

  it('is left out with `flag: false`', () => {
    expect(withConfig({}, { flag: false }).help('serve', { format: 'text' })).not.toContain('--config');
  });
});

describe('per-command sections', () => {
  const data = { port: 1, serve: { port: 2, db: { host: 'serve-db' } }, db: { host: 'h', migrate: { dryRun: true } } };

  it('override top-level values for their command and its subcommands', async () => {
    const program = withConfig(data, { sections: true });
    expect(await argsOf(program, '')).toEqual({ port: 1 });
    expect(await argsOf(program, 'serve')).toEqual({ port: 2, db: { host: 'serve-db' } });
    expect(await argsOf(program, 'db')).toEqual({ host: 'h' });
    expect(await argsOf(program, 'db migrate')).toEqual({ host: 'h', dryRun: true });
    expect(await argsOf(program, 'db migrate --host cli')).toEqual({ host: 'cli', dryRun: true });
  });

  it("are 'auto' by default: a key named like a command is the value of the command's option of that name, else a section", async () => {
    const program = withConfig({ port: 1, db: { host: 'h', migrate: { dryRun: true } } });
    expect(await argsOf(program, 'serve')).toEqual({ port: 1, db: { host: 'h' } });
    expect(await argsOf(program, 'db migrate')).toEqual({ host: 'h', dryRun: true });
  });

  it('are off with `sections: false`', async () => {
    const program = withConfig({ port: 1, db: { host: 'h' } }, { sections: false });
    expect(await argsOf(program, 'db migrate')).toEqual({});
  });

  it('with sections, a top-level key naming a command is never an option value', async () => {
    const program = withConfig({ db: { host: 'h' } }, { sections: true });
    expect(await argsOf(program, 'serve')).toEqual({});
  });

  it('work inside profiles', async () => {
    const program = withConfig({ ...data, profiles: { prod: { serve: { port: 9 } } } }, { sections: true, profiles: true });
    expect(await argsOf(program, 'serve --profile prod')).toEqual({ port: 9, db: { host: 'serve-db' } });
  });
});

describe('built-in commands', () => {
  const capture = defineInterceptor({ id: 'capture', name: 'capture' }, () => ({
    execute: (ctx, next) => (ctx.command.name === 'serve' ? { result: ctx.args } : next()),
  }));

  it('get no values from config files or environment variables', async () => {
    env.APP_HOST = 'env-host';
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {} })
      .extend(padroneServe())
      .extend(padroneEnv({ prefix: 'APP' }))
      .extend(padroneConfig({ files: 'app.json', loadConfig: () => ({ port: 3000 }) }))
      .intercept(capture);
    expect((await program.eval('serve')).result as unknown).toEqual({});
  });

  it('get them with `builtins: true`', async () => {
    env.APP_HOST = 'env-host';
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {} })
      .extend(padroneServe())
      .extend(padroneEnv({ prefix: 'APP', builtins: true }))
      .extend(padroneConfig({ files: 'app.json', loadConfig: () => ({ port: 3000 }), builtins: true }))
      .intercept(capture);
    expect((await program.eval('serve')).result as unknown).toEqual({ port: '3000', host: 'env-host' });
  });

  it('include the config command group', async () => {
    env.APP_KEY = 'port';
    writeUser(JSON.stringify({ port: 1 }));
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {} })
      .extend(padroneEnv({ prefix: 'APP' }))
      .extend(padroneConfig({ command: true }))
      .command('serve', (c) => c.arguments(z.object({ port: z.number().optional() })).action((args) => args));
    expect(((await program.eval('config get')).error as Error | undefined)?.message).toBe('Usage: config get <key>');
    expect((await program.eval('config get port')).result as unknown).toBe(1);
  });

  it('can be marked with `builtin: true`', async () => {
    const program = createPadrone('app')
      .runtime({ env: () => ({ APP_NAME: 'env' }), output: () => {} })
      .extend(padroneEnv({ prefix: 'APP' }))
      .extend(padroneConfig({ files: 'app.json', loadConfig: () => ({ name: 'config' }) }))
      .command('tool', (c) =>
        c
          .configure({ builtin: true })
          .arguments(z.object({ name: z.string().optional() }))
          .action((args) => args)
          .command('sub', (s) => s.arguments(z.object({ name: z.string().optional() })).action((args) => args)),
      )
      .command('own', (c) => c.arguments(z.object({ name: z.string().optional() })).action((args) => args));
    expect((await program.eval('tool')).args).toEqual({});
    expect((await program.eval('tool sub')).args).toEqual({});
    expect((await program.eval('own')).args).toEqual({ name: 'env' });
  });
});

describe('nested env variables', () => {
  const program = (options: PadroneEnvOptions = { prefix: 'APP' }) =>
    createPadrone('app')
      .runtime({ output: () => {} })
      .extend(padroneEnv(options))
      .arguments(
        z.object({
          db: z.object({ host: z.string().optional(), maxConns: z.number().optional(), port: z.number().optional() }).optional(),
        }),
      )
      .action((args) => args);
  const run = (vars: Record<string, string>, input = '', options?: PadroneEnvOptions) =>
    argsOf(program(options), input, { runtime: { env: () => vars } });

  it('reach into objects with a double underscore', async () => {
    expect(await run({ APP_DB__HOST: 'h', APP_DB__MAX_CONNS: '5' })).toEqual({ db: { host: 'h', maxConns: 5 } });
  });

  it('fill nested keys under the command line', async () => {
    expect(await run({ APP_DB__HOST: 'h', APP_DB__MAX_CONNS: '5' }, '--db.host cli')).toEqual({ db: { host: 'cli', maxConns: 5 } });
  });

  it('take dotted keys in vars', async () => {
    expect(await run({ DATABASE_PORT: '5432' }, '', { vars: { 'db.port': 'DATABASE_PORT' } })).toEqual({ db: { port: 5432 } });
  });

  it('ignore other prefixes and unknown options', async () => {
    expect(await run({ OTHER_DB__HOST: 'h', APP_NOPE__X: '1' })).toEqual({});
  });
});

describe('empty env variables', () => {
  const program = (options: PadroneEnvOptions) =>
    createPadrone('app')
      .runtime({ output: () => {} })
      .extend(padroneEnv(options))
      .arguments(z.object({ port: z.number().optional(), name: z.string().optional() }))
      .action((args) => args);

  it('count as unset by default', async () => {
    expect(await argsOf(program({ prefix: 'APP' }), '', { runtime: { env: () => ({ APP_PORT: '', APP_NAME: '' }) } })).toEqual({});
  });

  it('are empty values with `allowEmpty`', async () => {
    const vars = { APP_NAME: '' };
    expect(await argsOf(program({ prefix: 'APP', allowEmpty: true }), '', { runtime: { env: () => vars } })).toEqual({ name: '' });
  });

  it('count as unset for an env schema too', async () => {
    const schema = z.object({ PORT: z.coerce.number().optional() }).transform((e) => ({ port: e.PORT }));
    const p = createPadrone('app')
      .runtime({ output: () => {} })
      .extend(padroneEnv(schema))
      .arguments(z.object({ port: z.number().optional() }))
      .action((args) => args);
    expect(await argsOf(p, '', { runtime: { env: () => ({ PORT: '' }) } })).toEqual({});
  });
});

describe('sources in validation errors', () => {
  it('name the environment variable', async () => {
    const program = withConfig(undefined, {}, { prefix: 'APP' });
    env.APP_PORT = 'abc';
    expect(await errorOf(program, 'serve')).toContain('(from APP_PORT)');
    expect(await errorOf(program, 'serve --port abc')).not.toContain('(from');
  });

  it('name the config file', async () => {
    fs.writeFileSync('app.json', JSON.stringify({ port: 'abc' }));
    fs.writeFileSync('other.json', JSON.stringify({ name: ['x'] }));
    const program = createPadrone('app')
      .runtime({ output: () => {}, error: () => {} })
      .extend(padroneConfig({ files: 'app.json' }))
      .arguments(z.object({ port: z.number().optional(), name: z.string().optional() }))
      .action((args) => args);
    expect(await errorOf(program, '')).toContain('(from app.json)');
    expect(await errorOf(program, '--config other.json')).toContain('(from other.json)');
  });

  it('name the file in schema errors', async () => {
    fs.writeFileSync('app.json', JSON.stringify({ port: 'abc' }));
    const program = createPadrone('app')
      .runtime({ output: () => {}, error: () => {} })
      .extend(padroneConfig({ files: 'app.json', schema: z.object({ port: z.number().optional() }) }))
      .arguments(z.object({ port: z.number().optional() }))
      .action((args) => args);
    expect(await errorOf(program, '')).toStartWith('Invalid config file app.json:');
  });
});

describe('--profile from remote callers', () => {
  const data = { port: 1, profiles: { prod: { port: 2 } } };

  it('is an unknown option by default', async () => {
    const program = withConfig(data, { profiles: true });
    for (const caller of ['serve', 'mcp', 'tool']) {
      const result = await program.eval(['serve', '--profile', 'prod'], { caller });
      expect(result.argsResult?.issues?.[0]?.message).toBe('Unknown option "--profile"');
    }
    expect(await argsOf(program, ['serve', '--profile', 'prod'])).toEqual({ port: 2 });
  });

  it('is read with `remote: true`', async () => {
    const program = withConfig(data, { profiles: { remote: true } });
    expect(await argsOf(program, ['serve', '--profile', 'prod'], { caller: 'serve' })).toEqual({ port: 2 });
  });

  it('leaves the profile variable of the program to remote callers', async () => {
    env.APP_PROFILE = 'prod';
    expect(await argsOf(withConfig(data, { profiles: true }), ['serve'], { caller: 'mcp' })).toEqual({ port: 2 });
  });
});

describe('lenient scalar coercion', () => {
  it('coerces config numbers and booleans to the option type', async () => {
    const program = createPadrone('app')
      .runtime({ output: () => {} })
      .extend(padroneConfig({ files: 'app.json', loadConfig: () => ({ name: 123, port: '8080', verbose: 1, tags: [1, true] }) }))
      .arguments(
        z.object({ name: z.string(), port: z.number(), verbose: z.boolean(), tags: z.array(z.string()), count: z.number().optional() }),
      )
      .action((args) => args);
    expect(await argsOf(program, '')).toEqual({ name: '123', port: 8080, verbose: true, tags: ['1', 'true'] });
  });

  it('coerces before the config schema validates', async () => {
    const program = createPadrone('app')
      .runtime({ output: () => {} })
      .extend(padroneConfig({ files: 'app.json', loadConfig: () => ({ name: 123 }), schema: z.object({ name: z.string() }) }))
      .arguments(z.object({ name: z.string() }))
      .action((args) => args);
    expect(await argsOf(program, '')).toEqual({ name: '123' });
  });
});

describe('JSONC editing', () => {
  const text = `{
  // The port
  "port": 1, // inline
  /* database */
  "db": {
    "host": "a", // host
  },
}
`;

  it('replaces a value in place', () => {
    expect(setJsoncValue(text, ['port'], 2)).toBe(text.replace('"port": 1', '"port": 2'));
  });

  it('adds keys after the last one, keeping comments and trailing commas', () => {
    expect(setJsoncValue(text, ['db', 'port'], 5432)).toBe(
      text.replace('"host": "a", // host\n', '"host": "a", // host\n    "port": 5432,\n'),
    );
    expect(setJsoncValue('{\n  "a": 1 // one\n}\n', ['b'], true)).toBe('{\n  "a": 1, // one\n  "b": true\n}\n');
    expect(setJsoncValue('{}', ['a', 'b'], 1)).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
    expect(setJsoncValue('', ['a'], 1)).toBe('{\n  "a": 1\n}\n');
    expect(setJsoncValue('{ "a": 1 }', ['b'], 2)).toBe('{ "a": 1, "b": 2 }');
  });

  it('removes a key with its comma and same-line comment, and objects left empty', () => {
    expect(removeJsoncValue(text, ['port'])).toBe(text.replace('  "port": 1, // inline\n', ''));
    expect(removeJsoncValue('{\n  "a": 1, // one\n  "b": 2 // two\n}\n', ['b'])).toBe('{\n  "a": 1 // one\n}\n');
    expect(removeJsoncValue('{ "a": 1, "b": 2 }', ['a'])).toBe('{ "b": 2 }');
    expect(JSON.parse(removeJsoncValue('{"x": 0, "db": {"host": "a"}}', ['db', 'host'])!)).toEqual({ x: 0 });
    expect(removeJsoncValue(text, ['nope'])).toBeUndefined();
  });

  it('keeps comments in `config set` and `config unset`', async () => {
    writeUser(text);
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {} })
      .extend(padroneConfig({ command: true }))
      .arguments(
        z.object({ port: z.number().optional(), db: z.object({ host: z.string().optional(), port: z.number().optional() }).optional() }),
      )
      .action((args) => args);
    await argsOf(program, 'config set port 2');
    await argsOf(program, 'config set db.port 5432');
    await argsOf(program, 'config unset db.host');
    const written = fs.readFileSync(userFile(), 'utf-8');
    expect(written).toContain('// The port');
    expect(written).toContain('"port": 2, // inline');
    expect(written).toContain('/* database */');
    expect(await argsOf(program, '')).toEqual({ port: 2, db: { port: 5432 } });
  });
});

describe('config --local and --file', () => {
  const create = (options: PadroneConfigOptions = {}) => {
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {}, editor: async (text: string) => `${text.trim().slice(0, -1)}  "port": 7\n}\n` })
      .extend(padroneConfig({ command: true, ...options }))
      .arguments(z.object({ port: z.number().optional() }))
      .action((args) => args);
    const run = async (input: string) => {
      const { result, error } = await program.eval(input);
      if (error) throw error;
      return result as any;
    };
    return { program, run };
  };
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

  it('writes, reads and removes values in the project config file', async () => {
    writeUser(JSON.stringify({ port: 9 }));
    const { run } = create();
    const local = path.join(process.cwd(), 'config.json');
    expect(await run('config set port 1 --local')).toContain(local);
    expect(read(local)).toEqual({ port: 1 });
    expect(read(userFile())).toEqual({ port: 9 });
    expect(await run('config get port --local')).toBe(1);
    expect(await run('config path --local')).toBe(local);
    expect(await run('config list --local')).toBe(`port=1  ${local}`);
    await run('config unset port --local');
    expect(read(local)).toEqual({});
  });

  it('finds the project config in a parent directory with searchParents', async () => {
    const parent = path.join(tempDir, 'config.json');
    fs.writeFileSync(parent, JSON.stringify({ port: 3 }));
    const { run } = create({ searchParents: true });
    await run('config set port 4 --local');
    expect(read(parent)).toEqual({ port: 4 });
  });

  it('uses the file given with --file', async () => {
    const { run } = create();
    await run('config set port 5 --file custom.json');
    expect(read('custom.json')).toEqual({ port: 5 });
    expect(await run('config get port --file custom.json')).toBe(5);
    await run('config unset port --file custom.json');
    expect(read('custom.json')).toEqual({});
    await run('config edit --file edited.json');
    expect(read('edited.json')).toEqual({ port: 7 });
  });

  it('refuses --local with --file', async () => {
    const { program } = create();
    expect(((await program.eval('config get port --local --file x.json')).error as Error | undefined)?.message).toBe(
      'Use --local or --file, not both',
    );
  });
});

describe('config set with sections', () => {
  it('validates a section key against its command', async () => {
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {} })
      .extend(padroneConfig({ command: true, sections: true }))
      .arguments(z.object({ name: z.string().optional() }))
      .action((args) => args)
      .command('serve', (c) => c.arguments(z.object({ port: z.number().optional() })).action((args) => args));
    const errorMessage = async (input: string) => ((await program.eval(input)).error as Error | undefined)?.message;
    expect(await errorMessage('config set serve.port 3')).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(userFile(), 'utf-8'))).toEqual({ serve: { port: 3 } });
    expect((await program.eval('serve')).args).toEqual({ port: 3 });
    expect(await errorMessage('config set serve.port abc')).toContain('Invalid value for "serve.port"');
    expect(await errorMessage('config set serve.name x')).toContain('Unknown config key "serve.name"');
  });
});
