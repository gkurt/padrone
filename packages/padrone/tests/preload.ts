import { afterEach } from 'bun:test';
import { createConsoleMocker } from './console-mocker.ts';

// Force a consistent terminal width in tests to avoid non-deterministic output
process.stdout.columns = 120;

createConsoleMocker('outside-test');

// cli() runs that end with an error set process.exitCode through the default runtime;
// reset it so an expected failure doesn't fail the test run (bun still exits 1 on failed tests).
afterEach(() => {
  process.exitCode = 0;
});
