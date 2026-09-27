/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests contain dotenv variable expansion syntax */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPadrone, padroneEnv } from 'padrone';
import * as z from 'zod/v4';
import { expandVariables, parseEnvFile, resolveEnvFiles } from '../src/util/dotenv.ts';

// ── parseEnvFile ────────────────────────────────────────────────────────

describe('parseEnvFile', () => {
  it('should parse basic key=value pairs', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('should skip empty lines and comments', () => {
    expect(parseEnvFile('# comment\n\nFOO=bar\n  # indented comment\n')).toEqual({ FOO: 'bar' });
  });

  it('should handle empty values', () => {
    expect(parseEnvFile('EMPTY=')).toEqual({ EMPTY: '' });
  });

  it('should skip lines without =', () => {
    expect(parseEnvFile('NO_EQUALS\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('should strip export prefix', () => {
    expect(parseEnvFile('export FOO=bar\nexport BAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('should handle double-quoted values', () => {
    expect(parseEnvFile('FOO="hello world"')).toEqual({ FOO: 'hello world' });
  });

  it('should handle single-quoted values', () => {
    expect(parseEnvFile("FOO='hello world'")).toEqual({ FOO: 'hello world' });
  });

  it('should handle backtick-quoted values', () => {
    expect(parseEnvFile('FOO=`hello world`')).toEqual({ FOO: 'hello world' });
  });

  it('should preserve spaces in quoted values', () => {
    expect(parseEnvFile('FOO="  spaced  "')).toEqual({ FOO: '  spaced  ' });
  });

  it('should handle multiline double-quoted values', () => {
    const content = 'KEY="line1\nline2\nline3"';
    expect(parseEnvFile(content)).toEqual({ KEY: 'line1\nline2\nline3' });
  });

  it('should handle multiline single-quoted values', () => {
    const content = "KEY='line1\nline2'";
    expect(parseEnvFile(content)).toEqual({ KEY: 'line1\nline2' });
  });

  it('should unescape double-quoted escape sequences', () => {
    expect(parseEnvFile('FOO="hello\\nworld"')).toEqual({ FOO: 'hello\nworld' });
    expect(parseEnvFile('FOO="tab\\there"')).toEqual({ FOO: 'tab\there' });
    expect(parseEnvFile('FOO="escaped\\\\"')).toEqual({ FOO: 'escaped\\' });
    expect(parseEnvFile('FOO="say \\"hi\\""')).toEqual({ FOO: 'say "hi"' });
  });

  it('should strip inline comments from unquoted values', () => {
    expect(parseEnvFile('FOO=bar # this is a comment')).toEqual({ FOO: 'bar' });
  });

  it('should not strip # inside quoted values', () => {
    expect(parseEnvFile('FOO="bar # not a comment"')).toEqual({ FOO: 'bar # not a comment' });
  });

  it('should trim whitespace from keys and unquoted values', () => {
    expect(parseEnvFile('  FOO  =  bar  ')).toEqual({ FOO: 'bar' });
  });

  it('should handle = in values', () => {
    expect(parseEnvFile('FOO=bar=baz')).toEqual({ FOO: 'bar=baz' });
  });
});

// ── expandVariables ─────────────────────────────────────────────────────

describe('expandVariables', () => {
  it('should expand $VAR', () => {
    expect(expandVariables('$FOO', { FOO: 'bar' })).toBe('bar');
  });

  it('should expand ${VAR}', () => {
    expect(expandVariables('${FOO}', { FOO: 'bar' })).toBe('bar');
  });

  it('should expand mixed text and variables', () => {
    expect(expandVariables('hello $NAME!', { NAME: 'world' })).toBe('hello world!');
  });

  it('should resolve undefined variables to empty string', () => {
    expect(expandVariables('$MISSING', {})).toBe('');
  });

  it('should handle ${VAR:-default} when empty', () => {
    expect(expandVariables('${FOO:-fallback}', { FOO: '' })).toBe('fallback');
  });

  it('should handle ${VAR:-default} when unset', () => {
    expect(expandVariables('${FOO:-fallback}', {})).toBe('fallback');
  });

  it('should use value for ${VAR:-default} when set', () => {
    expect(expandVariables('${FOO:-fallback}', { FOO: 'real' })).toBe('real');
  });

  it('should handle ${VAR-default} when unset', () => {
    expect(expandVariables('${FOO-fallback}', {})).toBe('fallback');
  });

  it('should use empty value for ${VAR-default} when set but empty', () => {
    expect(expandVariables('${FOO-fallback}', { FOO: '' })).toBe('');
  });

  it('should handle escaped \\$', () => {
    expect(expandVariables('\\$FOO', { FOO: 'bar' })).toBe('$FOO');
  });

  it('should expand variables in default values', () => {
    expect(expandVariables('${MISSING:-$FOO}', { FOO: 'bar' })).toBe('bar');
  });

  it('should handle trailing $', () => {
    expect(expandVariables('price$', {})).toBe('price$');
  });

  it('should handle $ followed by non-word char', () => {
    expect(expandVariables('$!foo', {})).toBe('$!foo');
  });
});

// ── resolveEnvFiles ─────────────────────────────────────────────────────

describe('resolveEnvFiles', () => {
  it('should return only .env when no modes and no local', () => {
    expect(resolveEnvFiles([], false)).toEqual(['.env']);
  });

  it('should skip base files when base=false', () => {
    expect(resolveEnvFiles(['production'], true, false)).toEqual(['.env.production', '.env.production.local']);
  });

  it('should return empty when base=false and no modes', () => {
    expect(resolveEnvFiles([], true, false)).toEqual([]);
  });

  it('should include .env.local by default', () => {
    expect(resolveEnvFiles([])).toEqual(['.env', '.env.local']);
  });

  it('should include mode-specific files', () => {
    expect(resolveEnvFiles(['production'])).toEqual(['.env', '.env.local', '.env.production', '.env.production.local']);
  });

  it('should handle multiple modes', () => {
    expect(resolveEnvFiles(['staging', 'production'])).toEqual([
      '.env',
      '.env.local',
      '.env.staging',
      '.env.staging.local',
      '.env.production',
      '.env.production.local',
    ]);
  });

  it('should skip .local files when local=false', () => {
    expect(resolveEnvFiles(['production'], false)).toEqual(['.env', '.env.production']);
  });
});

// ── Integration: padroneEnv with .env files ─────────────────────────────

describe('padroneEnv with .env files', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-env-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeEnv(name: string, content: string) {
    fs.writeFileSync(path.join(tempDir, name), content);
  }

  it('should load .env file values into args', async () => {
    writeEnv('.env', 'PORT=3000\nHOST=localhost');

    const program = createPadrone('test-cli').command('serve', (c) =>
      c
        .arguments(z.object({ port: z.coerce.number().optional(), host: z.string().optional() }))
        .extend(
          padroneEnv(
            z
              .object({ PORT: z.string().optional(), HOST: z.string().optional() })
              .transform((e) => ({ port: e.PORT ? Number(e.PORT) : undefined, host: e.HOST })),
            { modes: [], dir: tempDir },
          ),
        )
        .action((args) => args),
    );

    const result = await program.eval('serve');
    expect(result.args?.port).toBe(3000);
    expect(result.args?.host).toBe('localhost');
  });

  it('should respect file loading order (later overrides earlier)', async () => {
    writeEnv('.env', 'PORT=3000');
    writeEnv('.env.production', 'PORT=8080');

    const program = createPadrone('test-cli').command('serve', (c) =>
      c
        .arguments(z.object({ port: z.coerce.number().optional() }))
        .extend(
          padroneEnv(
            z.object({ PORT: z.string().optional() }).transform((e) => ({ port: e.PORT ? Number(e.PORT) : undefined })),
            { modes: ['production'], dir: tempDir },
          ),
        )
        .action((args) => args),
    );

    const result = await program.eval('serve');
    expect(result.args?.port).toBe(8080);
  });

  it('should load .env.local files', async () => {
    writeEnv('.env', 'SECRET=base');
    writeEnv('.env.local', 'SECRET=local-override');

    const program = createPadrone('test-cli').command('run', (c) =>
      c
        .arguments(z.object({ secret: z.string().optional() }))
        .extend(
          padroneEnv(
            z.object({ SECRET: z.string().optional() }).transform((e) => ({ secret: e.SECRET })),
            { modes: [], dir: tempDir },
          ),
        )
        .action((args) => args),
    );

    const result = await program.eval('run');
    expect(result.args?.secret).toBe('local-override');
  });

  it('should skip .local files when local=false', async () => {
    writeEnv('.env', 'VAL=base');
    writeEnv('.env.local', 'VAL=local');

    const program = createPadrone('test-cli').command('run', (c) =>
      c
        .arguments(z.object({ val: z.string().optional() }))
        .extend(
          padroneEnv(
            z.object({ VAL: z.string().optional() }).transform((e) => ({ val: e.VAL })),
            { modes: [], local: false, dir: tempDir },
          ),
        )
        .action((args) => args),
    );

    const result = await program.eval('run');
    expect(result.args?.val).toBe('base');
  });

  it('should skip base .env file when base=false', async () => {
    writeEnv('.env', 'PORT=3000');
    writeEnv('.env.production', 'HOST=prod.example.com');

    const program = createPadrone('test-cli').command('serve', (c) =>
      c
        .arguments(z.object({ port: z.coerce.number().optional(), host: z.string().optional() }))
        .extend(
          padroneEnv(
            z
              .object({ PORT: z.string().optional(), HOST: z.string().optional() })
              .transform((e) => ({ port: e.PORT ? Number(e.PORT) : undefined, host: e.HOST })),
            { modes: ['production'], dir: tempDir, base: false },
          ),
        )
        .action((args) => args),
    );

    const result = await program.eval('serve');
    expect(result.args?.port).toBeUndefined();
    expect(result.args?.host).toBe('prod.example.com');
  });

  it('should prefer process.env over file values by default', async () => {
    writeEnv('.env', 'API_KEY=from-file');

    const program = createPadrone('test-cli').command('run', (c) =>
      c
        .arguments(z.object({ apiKey: z.string().optional() }))
        .extend(
          padroneEnv(
            z.object({ API_KEY: z.string().optional() }).transform((e) => ({ apiKey: e.API_KEY })),
            { modes: [], dir: tempDir },
          ),
        )
        .action((args) => args),
    );

    const result = await program.runtime({ env: () => ({ API_KEY: 'from-process' }) }).eval('run');
    expect(result.args?.apiKey).toBe('from-process');
  });

  it('should allow file values to override process.env with override=true', async () => {
    writeEnv('.env', 'API_KEY=from-file');

    const program = createPadrone('test-cli').command('run', (c) =>
      c
        .arguments(z.object({ apiKey: z.string().optional() }))
        .extend(
          padroneEnv(
            z.object({ API_KEY: z.string().optional() }).transform((e) => ({ apiKey: e.API_KEY })),
            { modes: [], dir: tempDir, override: true },
          ),
        )
        .action((args) => args),
    );

    const result = await program.runtime({ env: () => ({ API_KEY: 'from-process' }) }).eval('run');
    expect(result.args?.apiKey).toBe('from-file');
  });

  it('should prefer CLI args over env file values', async () => {
    writeEnv('.env', 'PORT=3000');

    const program = createPadrone('test-cli').command('serve', (c) =>
      c
        .arguments(z.object({ port: z.coerce.number().optional() }))
        .extend(
          padroneEnv(
            z.object({ PORT: z.string().optional() }).transform((e) => ({ port: e.PORT ? Number(e.PORT) : undefined })),
            { modes: [], dir: tempDir },
          ),
        )
        .action((args) => args),
    );

    const result = await program.eval('serve --port=9999');
    expect(result.args?.port).toBe(9999);
  });

  it('should expand variables in env files', async () => {
    writeEnv('.env', 'BASE=/app\nPATH_FULL=$BASE/bin');

    const program = createPadrone('test-cli').command('run', (c) =>
      c
        .arguments(z.object({ pathFull: z.string().optional() }))
        .extend(
          padroneEnv(
            z.object({ PATH_FULL: z.string().optional() }).transform((e) => ({ pathFull: e.PATH_FULL })),
            { modes: [], dir: tempDir },
          ),
        )
        .action((args) => args),
    );

    const result = await program.eval('run');
    expect(result.args?.pathFull).toBe('/app/bin');
  });

  it('should work without schema (options only)', async () => {
    writeEnv('.env', 'port=3000\nhost=localhost');

    const program = createPadrone('test-cli').command('serve', (c) =>
      c
        .arguments(z.object({ port: z.coerce.number().optional(), host: z.string().optional() }))
        .extend(padroneEnv({ modes: [], dir: tempDir }))
        .action((args) => args),
    );

    const result = await program.eval('serve');
    expect(result.args?.port).toBe(3000);
    expect(result.args?.host).toBe('localhost');
  });

  it('should handle missing .env files gracefully', async () => {
    const program = createPadrone('test-cli').command('run', (c) =>
      c
        .arguments(z.object({ val: z.string().optional() }))
        .extend(padroneEnv({ modes: ['production'], dir: tempDir }))
        .action((args) => args),
    );

    const result = await program.eval('run');
    expect(result.args?.val).toBeUndefined();
  });
});

describe('padroneEnv file options', () => {
  it('loads .env when only dir is given', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-env-dir-'));
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=1234\n');
    const program = createPadrone('test')
      .extend(padroneEnv({ dir, vars: { port: 'PORT' } }))
      .arguments(z.object({ port: z.coerce.number().optional() }))
      .action((args) => args.port);

    const result = await program.eval('', { runtime: { env: () => ({}), output: () => {} } });
    expect(result.result).toBe(1234);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('padroneEnv prefix', () => {
  const program = createPadrone('test')
    .extend(padroneEnv({ prefix: 'MY_APP', vars: { token: 'API_TOKEN' } }))
    .arguments(
      z.object({
        dryRun: z.boolean().optional(),
        port: z.coerce.number().optional(),
        token: z.string().optional(),
      }),
    )
    .action((args) => args);
  const run = (input: string, env: Record<string, string>) => program.eval(input, { runtime: { env: () => env, output: () => {} } });

  it('reads every option from a prefixed variable, CLI flags first', async () => {
    const env = { MY_APP_DRY_RUN: 'true', MY_APP_PORT: '8080' };
    expect((await run('', env)).args).toEqual({ dryRun: true, port: 8080 });
    expect((await run('--port 1', env)).args).toEqual({ dryRun: true, port: 1 });
  });

  it('prefers the variables named in vars', async () => {
    expect((await run('', { API_TOKEN: 'a', MY_APP_TOKEN: 'b' })).args).toEqual({ token: 'a' });
  });

  it('shows the variables in help', () => {
    const help = program.help(undefined, { format: 'text' });
    expect(help).toContain('MY_APP_DRY_RUN');
    expect(help).toContain('API_TOKEN');
  });
});
