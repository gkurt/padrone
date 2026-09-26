import { describe, expect, it } from 'bun:test';
import { createPadrone } from 'padrone';
import { commandSymbol } from '../src/core/commands.ts';
import { createServeHandler } from '../src/feature/serve.ts';

describe('serve cancellation', () => {
  it('aborts the command when the request is aborted', async () => {
    let reason: unknown;
    const program = createPadrone('test').command('wait', (c) =>
      c.async().action(
        (_args, ctx) =>
          new Promise<string>((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              reason = ctx.signal.reason;
              reject(new Error('aborted'));
            });
            setTimeout(() => resolve('finished'), 1000);
          }),
      ),
    );
    const handler = createServeHandler((program as any)[commandSymbol], program.eval.bind(program) as any);
    const controller = new AbortController();
    const response = handler(
      new Request('http://localhost/wait', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort('client gone'), 20);
    expect((await response).status).toBeGreaterThanOrEqual(400);
    expect(reason).toBe('client gone');
  });
});
