import { afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleMocker } from './console-mocker.ts';

// Force a consistent terminal width in tests to avoid non-deterministic output
process.stdout.columns = 120;

createConsoleMocker('outside-test');

// cli() runs that end with an error set process.exitCode through the default runtime;
// reset it so an expected failure doesn't fail the test run (bun still exits 1 on failed tests).
afterEach(() => {
  process.exitCode = 0;
});

// Tests that run a program's commands for real (an upgrade records its previous version) never touch the user's state directory
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'padrone-test-state-'));
process.on('exit', () => rmSync(process.env.XDG_STATE_HOME!, { recursive: true, force: true }));
