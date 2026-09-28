/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests contain dotenv variable expansion syntax */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PadroneConfigContext, PadroneConfigOptions, PadroneEnvOptions } from 'padrone';
import { createPadrone, defineConfig, padroneAliases, padroneConfig, padroneEnv, padroneResponseFiles } from 'padrone';
import * as z from 'zod/v4';
import { expandVariables, loadEnvFiles } from '../src/util/dotenv.ts';
import { parseFlatYaml, toYaml } from '../src/util/yaml.ts';

let tempDir: string;
let work: string;
const originalCwd = process.cwd();
const quiet = { output: () => {}, error: () => {}, setExitCode: () => {} };

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-config-env-apis-')));
  work = path.join(tempDir, 'work');
  fs.mkdirSync(work);
  process.chdir(work);
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
const message = (result: { error?: unknown }) => (result.error as Error | undefined)?.message;

function configProgram(options: PadroneConfigOptions, env: Record<string, string | undefined> = {}) {
  return createPadrone('app')
    .runtime({ ...quiet, env: () => env })
    .extend(padroneConfig(options))
    .arguments(z.object({ port: z.number().optional(), host: z.string().optional() }))
    .action((args) => args)
    .command('serve', (c) => c.arguments(z.object({ port: z.number().optional(), host: z.string().optional() })).action((args) => args));
}

describe('function configs', () => {
  it('calls a default-exported function with the command, env, profile and env name', async () => {
    write(
      'app.config.mjs',
      'export default (ctx) => ({ port: ctx.command === "serve" ? 1 : 2, host: [ctx.env.HOST_X, ctx.profile, ctx.envName].join("/"), profiles: { work: {} } })',
    );
    const program = configProgram({ files: 'app.config.mjs', profiles: true }, { HOST_X: 'h', NODE_ENV: 'test' });
    expect((await program.eval('serve --profile work')).result).toEqual({ port: 1, host: 'h/work/test' });
    expect((await program.eval('')).result).toEqual({ port: 2, host: 'h//test' });
  });

  it('refuses script configs with `scripts: false`, but still reads data configs and --config files', async () => {
    write('app.config.mjs', 'export default () => ({ host: "script" })');
    const refused = await configProgram({ files: 'app.config.mjs', scripts: false }).eval('serve');
    expect(message(refused)).toContain('Refusing to run the script config');
    write('app.json', '{ "host": "json" }');
    expect((await configProgram({ files: 'app.json', scripts: false }).eval('serve')).result).toEqual({ host: 'json' });
    const explicit = await configProgram({ files: 'app.json', scripts: false }).eval('serve --config app.config.mjs');
    expect(explicit.result).toEqual({ host: 'script' });
  });

  it('asks `scripts` per file (absolute path)', async () => {
    const file = write('app.config.mjs', 'export default () => ({ host: "script" })');
    const seen: string[] = [];
    const scripts = async (f: string) => {
      seen.push(f);
      return false;
    };
    expect(message(await configProgram({ files: 'app.config.mjs', scripts }).eval('serve'))).toContain('Refusing');
    expect(seen).toEqual([file]);
    expect((await configProgram({ files: 'app.config.mjs', scripts: () => true }).eval('serve')).result).toEqual({ host: 'script' });
  });

  it('awaits an async function', async () => {
    write('app.config.mjs', 'export default async ({ command }) => ({ host: `from ${command || "root"}` })');
    expect((await configProgram({ files: 'app.config.mjs' }).eval('serve')).result).toEqual({ host: 'from serve' });
  });

  it('follows extends from a function config and to one', async () => {
    write('base.mjs', 'export default ({ command }) => ({ port: command ? 10 : 20, host: "base" })');
    write('app.config.mjs', 'export default () => ({ extends: "./base.mjs", host: "own" })');
    expect((await configProgram({ files: 'app.config.mjs' }).eval('serve')).result).toEqual({ port: 10, host: 'own' });
  });

  it("still doesn't let a data config extend a function config", async () => {
    write('base.mjs', 'export default () => ({ port: 1 })');
    write('app.json', JSON.stringify({ extends: './base.mjs' }));
    expect(message(await configProgram({ files: 'app.json' }).eval('serve'))).toContain('only a script config can extend a script');
  });

  it('rejects a function that returns something other than an object', async () => {
    write('app.config.mjs', 'export default () => 42');
    expect(message(await configProgram({ files: 'app.config.mjs' }).eval('serve'))).toContain('must be an object');
  });

  it('gives defineConfig() back as is', () => {
    const data = { port: 1 };
    const fn = (ctx: PadroneConfigContext) => ({ port: ctx.command.length });
    expect(defineConfig(data)).toBe(data);
    expect(defineConfig(fn)).toBe(fn);
    const typed = defineConfig<{ port?: number }>(async () => ({ port: 3 }));
    expect(typeof typed).toBe('function');
  });
});

describe('bounded parent search', () => {
  const inDir = (sub: string) => {
    const dir = path.join(tempDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    process.chdir(dir);
  };

  it('stops at stopDir, inclusive', async () => {
    write(path.join(tempDir, 'app.json'), JSON.stringify({ port: 1 }));
    inDir('work/a/b');
    const program = (stopDir: string) => configProgram({ files: ['app.json'], searchParents: true, stopDir });
    expect((await program(path.join(tempDir, 'work')).eval('serve')).result).toEqual({});
    expect((await program(tempDir).eval('serve')).result).toEqual({ port: 1 });
    // Relative to cwd
    expect((await program('../..').eval('serve')).result).toEqual({});
  });

  it("stops at the project root with searchParents: 'project'", async () => {
    write(path.join(tempDir, 'app.json'), JSON.stringify({ port: 1 }));
    write(path.join(work, 'package.json'), '{}');
    inDir('work/a/b');
    const program = configProgram({ files: ['app.json'], searchParents: 'project' });
    expect((await program.eval('serve')).result).toEqual({});
    write(path.join(work, 'app.json'), JSON.stringify({ port: 2 }));
    expect((await program.eval('serve')).result).toEqual({ port: 2 });
  });

  it('treats a .git directory or file as the project root, and merges only inside it', async () => {
    write(path.join(tempDir, 'app.json'), JSON.stringify({ host: 'outside' }));
    fs.mkdirSync(path.join(work, '.git'));
    write(path.join(work, 'app.json'), JSON.stringify({ host: 'root', port: 1 }));
    write(path.join(work, 'a', 'app.json'), JSON.stringify({ port: 2 }));
    inDir('work/a/b');
    const program = configProgram({ files: ['app.json'], searchParents: 'project', merge: true });
    expect((await program.eval('serve')).result).toEqual({ host: 'root', port: 2 });
  });

  it("searches only cwd with 'project' when there is no project root", async () => {
    write(path.join(tempDir, 'app.json'), JSON.stringify({ port: 1 }));
    inDir('work/a');
    expect((await configProgram({ files: ['app.json'], searchParents: 'project' }).eval('serve')).result).toEqual({});
  });

  it('keeps searching up to the filesystem root with searchParents: true', async () => {
    write(path.join(tempDir, 'app.json'), JSON.stringify({ port: 1 }));
    inDir('work/a/b');
    expect((await configProgram({ files: ['app.json'], searchParents: true }).eval('serve')).result).toEqual({ port: 1 });
  });

  it('passes the bounds to a custom loader', async () => {
    let received: unknown;
    const program = configProgram({
      files: ['app.json'],
      searchParents: 'project',
      stopDir: '/x',
      loadConfig: (_files, _xdg, search) => {
        received = search;
        return {};
      },
    });
    await program.eval('serve');
    expect(received).toMatchObject({ parents: 'project', stopDir: '/x' });
  });
});

describe('per-environment overrides', () => {
  const data = { port: 1, host: 'base', $production: { port: 2 }, $env: { staging: { port: 3 } } };

  it('applies $<name> and $env.<name> for NODE_ENV', async () => {
    const run = async (env: Record<string, string>) =>
      (await configProgram({ files: 'app.json', loadConfig: () => data }, env).eval('serve')).result;
    expect(await run({})).toEqual({ port: 1, host: 'base' });
    expect(await run({ NODE_ENV: 'production' })).toEqual({ port: 2, host: 'base' });
    expect(await run({ NODE_ENV: 'staging' })).toEqual({ port: 3, host: 'base' });
  });

  it('takes the name from envName', async () => {
    const run = async (envName: PadroneConfigOptions['envName'], env: Record<string, string> = {}) =>
      (await configProgram({ files: 'app.json', loadConfig: () => data, envName }, env).eval('serve')).result;
    expect(await run('production')).toEqual({ port: 2, host: 'base' });
    expect(await run((env) => env.APP_ENV, { APP_ENV: 'staging', NODE_ENV: 'production' })).toEqual({ port: 3, host: 'base' });
    expect(await run(false, { NODE_ENV: 'production' })).toEqual({ port: 1, host: 'base' });
  });

  it('never applies $ keys as values, even to a schema that takes any key', async () => {
    const program = createPadrone('app')
      .runtime({ ...quiet, env: () => ({ NODE_ENV: 'production' }) })
      .extend(padroneConfig({ files: 'app.json', loadConfig: () => ({ a: 1, $production: { b: 2 }, $test: { c: 3 }, $env: {} }) }))
      .arguments(z.looseObject({}))
      .action((args) => args);
    expect((await program.eval('')).result).toEqual({ a: 1, b: 2 });
    const off = createPadrone('app')
      .runtime({ ...quiet, env: () => ({}) })
      .extend(padroneConfig({ files: 'app.json', envName: false, loadConfig: () => ({ a: 1, $production: { b: 2 } }) }))
      .arguments(z.looseObject({}))
      .action((args) => args);
    expect((await off.eval('')).result).toEqual({ a: 1 });
  });

  it('applies the overrides of the selected profile, and before sections', async () => {
    const program = configProgram(
      {
        files: 'app.json',
        profiles: true,
        sections: true,
        loadConfig: () => ({
          port: 1,
          $production: { port: 2, host: 'prod' },
          profiles: { work: { $production: { port: 4 } } },
          serve: { host: 'serve' },
        }),
      },
      { NODE_ENV: 'production' },
    );
    expect((await program.eval('serve')).result).toEqual({ port: 2, host: 'serve' });
    expect((await program.eval('serve --profile work')).result).toEqual({ port: 4, host: 'serve' });
  });

  it('reads NODE_ENV from .env files padroneEnv() loads', async () => {
    write('.env', 'NODE_ENV=production');
    const program = createPadrone('app')
      .runtime({ ...quiet, env: () => ({}) })
      .extend(padroneEnv({ dir: '.' }))
      .extend(padroneConfig({ files: 'app.json', loadConfig: () => data }))
      .arguments(z.object({ port: z.number().optional() }))
      .action((args) => args);
    expect((await program.eval('')).result).toEqual({ port: 2 });
  });

  it('shows the overridden values in config get and config list', async () => {
    const env = { XDG_CONFIG_HOME: path.join(tempDir, 'xdg'), HOME: tempDir, NODE_ENV: 'production' };
    const file = write(path.join(tempDir, 'xdg', 'app', 'config.json'), JSON.stringify({ port: 1, $production: { port: 2 } }));
    const program = configProgram({ command: true }, env);
    expect<unknown>((await program.eval('config get port')).result).toBe(2);
    expect<unknown>((await program.eval('config list')).result).toBe(`port=2  ${file}`);
  });

  it('names the file an invalid override comes from', async () => {
    write('app.json', JSON.stringify({ $production: { port: 'x' } }));
    const result = await configProgram({ files: 'app.json' }, { NODE_ENV: 'production' }).eval('serve');
    expect(result.argsResult?.issues?.[0]?.message).toContain('(from app.json)');
  });
});

describe('env arrays and nested keys', () => {
  function envProgram(options: PadroneEnvOptions, env: Record<string, string>) {
    return createPadrone('app')
      .runtime({ ...quiet, env: () => env })
      .extend(padroneEnv(options))
      .arguments(
        z.object({
          tags: z.string().array().optional(),
          ports: z.number().array().optional(),
          name: z.string().optional(),
          items: z.object({ id: z.number() }).array().optional(),
          db: z.object({ host: z.string().optional(), replicas: z.string().array().optional() }).optional(),
        }),
      )
      .action((args) => args);
  }

  it('splits a variable for an array option on commas', async () => {
    const env = { APP_TAGS: 'a, b,,c', APP_PORTS: '1,2', APP_NAME: 'x,y', APP_DB__REPLICAS: 'r1,r2' };
    expect((await envProgram({ prefix: 'APP' }, env).eval('')).result).toEqual({
      tags: ['a', 'b', 'c'],
      ports: [1, 2],
      name: 'x,y',
      db: { replicas: ['r1', 'r2'] },
    });
    expect((await envProgram({ vars: { tags: 'TAGS' } }, { TAGS: 'a,b' }).eval('')).result).toEqual({ tags: ['a', 'b'] });
  });

  it('reads a JSON array as is, and leaves arrays of objects to JSON', async () => {
    const env = { APP_TAGS: '["a,b", "c"]', APP_ITEMS: '[{"id": 1}]' };
    expect((await envProgram({ prefix: 'APP' }, env).eval('')).result).toEqual({ tags: ['a,b', 'c'], items: [{ id: 1 }] });
  });

  it('takes another separator, or none', async () => {
    expect((await envProgram({ prefix: 'APP', arraySeparator: ';' }, { APP_TAGS: 'a,b;c' }).eval('')).result).toEqual({
      tags: ['a,b', 'c'],
    });
    expect((await envProgram({ prefix: 'APP', arraySeparator: false }, { APP_TAGS: 'a,b' }).eval('')).result).toEqual({
      tags: ['a,b'],
    });
  });

  it('lets command-line values win', async () => {
    expect((await envProgram({ prefix: 'APP' }, { APP_TAGS: 'a,b' }).eval(['--tags', 'z'])).result).toEqual({ tags: ['z'] });
  });

  it('takes another separator for nested keys', async () => {
    const env = { APP_DB_HOST: 'flat', APP_DB__HOST: 'double', 'APP_DB.HOST': 'dot' };
    expect((await envProgram({ prefix: 'APP', nestedSeparator: '.' }, env).eval('')).result).toEqual({ db: { host: 'dot' } });
    expect((await envProgram({ prefix: 'APP' }, env).eval('')).result).toEqual({ db: { host: 'double' } });
  });
});

describe('dotenv operators', () => {
  it('fails on ${VAR:?message} when unset or empty, and ${VAR?message} when unset', () => {
    expect(() => expandVariables('${A:?A is required}', {})).toThrow('A: A is required');
    expect(() => expandVariables('${A:?A is required}', { A: '' })).toThrow('A: A is required');
    expect(() => expandVariables('${A:?}', {})).toThrow('A: is not set or empty');
    expect(expandVariables('${A:?x}', { A: 'ok' })).toBe('ok');
    expect(() => expandVariables('${A?needs $B}', { B: 'b' })).toThrow('A: needs b');
    expect(expandVariables('[${A?x}]', { A: '' })).toBe('[]');
  });

  it('substitutes ${VAR:+alt} when set and non-empty, and ${VAR+alt} when set', () => {
    expect(expandVariables('[${A:+on}]', { A: '1' })).toBe('[on]');
    expect(expandVariables('[${A:+on}]', { A: '' })).toBe('[]');
    expect(expandVariables('[${A:+on}]', {})).toBe('[]');
    expect(expandVariables('[${A+on}]', { A: '' })).toBe('[on]');
    expect(expandVariables('[${A+on}]', {})).toBe('[]');
    expect(expandVariables('${A:+--host=${B}}', { A: 'x', B: 'h' })).toBe('--host=h');
  });

  it('keeps ${VAR:-default} and ${VAR-default}', () => {
    expect(expandVariables('${A:-d}|${A-d}|${B:-d}|${B-d}', { A: '' })).toBe('d||d|d');
  });

  it('names the variable and the file when a required variable is missing', async () => {
    write('.env', 'OK=1\nURL=postgres://${DB_HOST:?set DB_HOST in .env.local}/app');
    expect(() => loadEnvFiles({ dir: '.' }, {})).toThrow('.env: URL needs DB_HOST: set DB_HOST in .env.local');
    expect(loadEnvFiles({ dir: '.' }, { DB_HOST: 'db' })).toEqual({ OK: '1', URL: 'postgres://db/app' });
    const program = createPadrone('app')
      .runtime({ ...quiet, env: () => ({}) })
      .extend(padroneEnv({ dir: '.' }))
      .action(() => 'ran');
    expect(message(await program.eval(''))).toContain('URL needs DB_HOST: set DB_HOST in .env.local');
  });
});

describe('response files relativeTo', () => {
  const program = (relativeTo?: 'cwd' | 'file') =>
    createPadrone('app')
      .runtime(quiet)
      .extend(padroneResponseFiles({ relativeTo }))
      .arguments(z.object({ verbose: z.boolean().optional(), name: z.string().optional() }))
      .action((args) => args);

  beforeEach(() => {
    write(path.join(tempDir, 'args', 'outer.txt'), '--name x\n@inner.txt');
    write(path.join(tempDir, 'args', 'inner.txt'), '--verbose');
  });

  it('resolves nested response files relative to cwd by default', async () => {
    expect(message(await program().eval(['@../args/outer.txt']))).toContain('Cannot read response file "inner.txt"');
    write('inner.txt', '--verbose');
    expect((await program('cwd').eval(['@../args/outer.txt'])).result).toEqual({ name: 'x', verbose: true });
  });

  it("resolves nested response files relative to the including file with relativeTo: 'file'", async () => {
    expect((await program('file').eval(['@../args/outer.txt'])).result).toEqual({ name: 'x', verbose: true });
    write(path.join(tempDir, 'args', 'deep', 'outer.txt'), `@../inner.txt\n@${path.join(tempDir, 'args', 'abs.txt')}`);
    write(path.join(tempDir, 'args', 'abs.txt'), '--name abs');
    expect((await program('file').eval(['@../args/deep/outer.txt'])).result).toEqual({ name: 'abs', verbose: true });
  });
});

describe('alias import and export', () => {
  const create = (file = path.join(tempDir, 'aliases.json'), aliases: Record<string, string> = { up: 'deploy' }, stdin?: string) =>
    createPadrone('git')
      .runtime({
        ...quiet,
        ...(stdin !== undefined && { stdin: { isTTY: false, text: async () => stdin, async *lines() {} } }),
      })
      .extend(padroneAliases({ file, aliases }))
      .command('checkout', (c) =>
        c
          .arguments(z.object({ branch: z.string().optional(), force: z.boolean().optional() }), { positional: ['branch'] })
          .action((a) => a),
      )
      .command('deploy', (c) => c.action(() => 'deployed'));
  const stored = (file = path.join(tempDir, 'aliases.json')) => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const run = async (program: ReturnType<typeof create>, ...argv: string[]) => {
    const result = await program.cli({ runtime: { argv: () => argv } });
    if (result.error) throw result.error;
    return result.result;
  };

  it('imports aliases from a JSON or YAML file', async () => {
    const program = create();
    write('a.json', JSON.stringify({ co: 'checkout --force' }));
    expect(await run(program, 'alias', 'import', 'a.json')).toBe('Imported 1 alias');
    write('a.yaml', 'st: status --short\n# comment\npr: "checkout pr/$1"\n');
    expect(await run(program, 'alias', 'import', 'a.yaml')).toBe('Imported 2 aliases');
    expect(stored()).toEqual({ co: 'checkout --force', st: 'status --short', pr: 'checkout pr/$1' });
    expect(await run(program, 'pr', '7')).toEqual({ branch: 'pr/7' });
  });

  it('imports from stdin with -', async () => {
    const program = create(undefined, {}, 'co: checkout\n');
    expect(await run(program, 'alias', 'import', '-')).toBe('Imported 1 alias');
    expect(stored()).toEqual({ co: 'checkout' });
  });

  it('skips aliases that exist unless --clobber', async () => {
    const program = create();
    write(path.join(tempDir, 'aliases.json'), JSON.stringify({ co: 'checkout', st: 'status' }));
    write('a.json', JSON.stringify({ co: 'checkout --force', st: 'status', lg: 'log' }));
    expect(await run(program, 'alias', 'import', 'a.json')).toBe(
      'Imported 1 alias\nSkipped 1 alias that already exists: co (use --clobber to overwrite)',
    );
    expect(stored()).toEqual({ co: 'checkout', st: 'status', lg: 'log' });
    expect(await run(program, 'alias', 'import', 'a.json', '--clobber')).toBe('Imported 1 alias');
    expect(stored().co).toBe('checkout --force');
  });

  it('refuses invalid aliases without importing any', async () => {
    const program = create();
    write('a.json', JSON.stringify({ ok: 'checkout', checkout: 'deploy', '-x': 'deploy', n: 1 }));
    const result = await program.cli({ runtime: { argv: () => ['alias', 'import', 'a.json'] } });
    expect(message(result)).toBe(
      'Cannot import a.json:\n  - "checkout" is already a command\n  - invalid alias name "-x"\n  - "n" must be a string',
    );
    expect(fs.existsSync(path.join(tempDir, 'aliases.json'))).toBe(false);
    write('b.json', '[1]');
    expect(message(await program.cli({ runtime: { argv: () => ['alias', 'import', 'b.json'] } }))).toContain(
      'must be an object of alias names to commands',
    );
  });

  it('lists aliases as YAML that imports back', async () => {
    const program = create();
    write(path.join(tempDir, 'aliases.json'), JSON.stringify({ co: 'checkout --force', pr: 'checkout pr/$1', 'w:x': 'a: b' }));
    const listed = (await run(program, 'alias', 'list')) as string;
    expect(listed).toBe('co: checkout --force\npr: "checkout pr/$1"\nup: deploy\nw:x: "a: b"');
    write('listed.yaml', listed);
    const other = create(path.join(tempDir, 'other.json'), {});
    await run(other, 'alias', 'import', 'listed.yaml');
    expect(stored(path.join(tempDir, 'other.json'))).toEqual({ co: 'checkout --force', pr: 'checkout pr/$1', up: 'deploy', 'w:x': 'a: b' });
  });

  it("exports the user's aliases as YAML or JSON, to stdout or a file", async () => {
    const program = create();
    write(path.join(tempDir, 'aliases.json'), JSON.stringify({ co: 'checkout' }));
    expect(await run(program, 'alias', 'export')).toBe('co: checkout');
    expect(await run(program, 'alias', 'export', '--json')).toBe('{\n  "co": "checkout"\n}');
    expect(await run(program, 'alias', 'export', 'out.json')).toBe('Exported 1 alias to out.json');
    expect(JSON.parse(fs.readFileSync('out.json', 'utf-8'))).toEqual({ co: 'checkout' });
    await run(program, 'alias', 'export', 'out.yml');
    expect(fs.readFileSync('out.yml', 'utf-8')).toBe('co: checkout\n');
  });

  it('reads the flat YAML the emitter writes without a YAML parser', () => {
    const aliases = { co: 'checkout --force', pr: 'checkout pr/$1', 'w:x': 'a: b', q: 'it\'s "quoted"', n: 'true' };
    expect(parseFlatYaml(toYaml(aliases))).toEqual(aliases);
    expect(parseFlatYaml("# c\na: 'it''s'  # trailing\nb: plain value # note\n\nc: \"x\"\n")).toEqual({
      a: "it's",
      b: 'plain value',
      c: 'x',
    });
    expect(() => parseFlatYaml('a:\n  nested: x')).toThrow();
  });
});
