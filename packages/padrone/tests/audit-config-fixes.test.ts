import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPadrone, padroneConfig } from 'padrone';
import * as z from 'zod/v4';
import { stripJsonc } from '../src/extension/config-loader.ts';
import { expandResponseFiles } from '../src/extension/response-files.ts';

let tempDir: string;
const originalCwd = process.cwd();
beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'padrone-audit-')));
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('stripJsonc', () => {
  it('removes comments and trailing commas', () => {
    expect(JSON.parse(stripJsonc('{"a":1, // c\n "b":[1,2,/* x */],\n}'))).toEqual({ a: 1, b: [1, 2] });
  });

  it('does not backtrack on a comma followed by many comment markers', () => {
    const start = performance.now();
    stripJsonc(`{"a":1,${'// '.repeat(200)}x\n"b":2}`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('response files', () => {
  it('caps the files expanded from a self-referencing fan-out', async () => {
    const file = path.join(tempDir, 'fan.txt');
    fs.writeFileSync(file, `${`@${file} `.repeat(5)}\n`);
    const start = performance.now();
    await expect(Promise.resolve().then(() => expandResponseFiles([`@${file}`]))).rejects.toThrow(
      /nested more than|response files expanded/,
    );
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe('config set', () => {
  it('redacts a sensitive value it echoes and keeps a new user config file private', async () => {
    const userDir = path.join(tempDir, 'xdg', 'app');
    const env = { HOME: tempDir, XDG_CONFIG_HOME: path.join(tempDir, 'xdg') };
    const program = createPadrone('app')
      .runtime({ env: () => env, output: () => {}, error: () => {} })
      .extend(padroneConfig({ command: true }))
      .command('login', (c) =>
        c.arguments(z.object({ token: z.string().optional().meta({ sensitive: true }), name: z.string().optional() })).action((a) => a),
      );
    const secret = await program.eval('config set token hunter2');
    expect(String(secret.result)).not.toContain('hunter2');
    expect(String(secret.result)).toContain('[redacted]');
    const plain = await program.eval('config set name bob');
    expect(String(plain.result)).toContain('name = bob');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(userDir, 'config.json')).mode & 0o077).toBe(0);
    }
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'config.json'), 'utf-8')).token).toBe('hunter2');
  });
});
