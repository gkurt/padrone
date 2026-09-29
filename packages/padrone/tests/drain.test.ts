import { describe, expect, expectTypeOf, it } from 'bun:test';
import {
  ActionError,
  asyncSchema,
  createPadrone,
  type Drained,
  defineInterceptor,
  type PadroneDrainResult,
  padroneAutoOutput,
} from 'padrone';
import * as z from 'zod/v4';

describe('drain()', () => {
  describe('sync commands', () => {
    it('should drain a simple value', async () => {
      const program = createPadrone('app').command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      );

      const { value, error } = await program.eval('greet World').drain();
      expect(error).toBeUndefined();
      expect(value).toBe('Hello, World!');
    });

    it('should drain undefined result', async () => {
      const program = createPadrone('app').command('noop', (c) => c.action(() => {}));

      const { value, error } = await program.eval('noop').drain();
      expect(error).toBeUndefined();
      expect(value).toBeUndefined();
    });

    it('should drain a Promise result', async () => {
      const program = createPadrone('app').command('fetch', (c) => c.action(async () => 'fetched'));

      const { value, error } = await program.eval('fetch').drain();
      expect(error).toBeUndefined();
      expect(value).toBe('fetched');
    });

    it('should drain an Iterable result', async () => {
      const program = createPadrone('app').command('gen', (c) =>
        c.action(function* () {
          yield 1;
          yield 2;
          yield 3;
        }),
      );

      const { value, error } = await program.eval('gen', {}).drain();
      expect(error).toBeUndefined();
      expect(value).toEqual([1, 2, 3]);
    });

    it('should drain an AsyncIterable result', async () => {
      const program = createPadrone('app').command('stream', (c) =>
        c.action(async function* () {
          yield 'a';
          yield 'b';
          yield 'c';
        }),
      );

      const { value, error } = await program.eval('stream', {}).drain();
      expect(error).toBeUndefined();
      expect(value).toEqual(['a', 'b', 'c']);
    });

    it('should catch errors from Promise results', async () => {
      const program = createPadrone('app').command('fail-async', (c) => c.action(() => Promise.reject(new Error('async boom'))));

      const { value, error } = await program.eval('fail-async').drain();
      expect(value).toBeUndefined();
      expect(error).toBeDefined();
      expect((error as Error).message).toBe('async boom');
    });

    it('should catch errors from AsyncIterable results', async () => {
      const program = createPadrone('app').command('fail-stream', (c) =>
        c.action(async function* () {
          yield 'ok';
          throw new Error('stream boom');
        }),
      );

      const { value, error } = await program.eval('fail-stream', {}).drain();
      expect(value).toBeUndefined();
      expect(error).toBeDefined();
      expect((error as Error).message).toBe('stream boom');
    });
  });

  describe('async commands', () => {
    it('should drain from async eval', async () => {
      const program = createPadrone('app').command('cmd', (c) =>
        c.arguments(asyncSchema(z.object({ name: z.string() }))).action((args) => `hi ${args.name}`),
      );

      const { value, error } = await program.eval('cmd --name World').drain();
      expect(error).toBeUndefined();
      expect(value).toBe('hi World');
    });
  });

  describe('cli()', () => {
    it('should drain from cli', async () => {
      const program = createPadrone('app')
        .runtime({ argv: () => ['greet', 'World'] })
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
        );

      const { value, error } = await program.cli().drain();
      expect(error).toBeUndefined();
      expect(value).toBe('Hello, World!');
    });
  });

  describe('run()', () => {
    it('should drain from run', async () => {
      const program = createPadrone('app').command('add', (c) =>
        c.arguments(z.object({ a: z.coerce.number(), b: z.coerce.number() })).action((args) => args.a + args.b),
      );

      const { value, error } = await program.run('add', { a: 2, b: 3 }).drain();
      expect(error).toBeUndefined();
      expect(value).toBe(5);
    });
  });

  describe('builtin commands', () => {
    it('eval() help result should have drain()', async () => {
      const program = createPadrone('app')
        .configure({ version: '1.0.0' })
        .command('greet', (c) => c.action(() => 'hi'));

      const result = program.eval('--help');
      expect(typeof result.drain).toBe('function');
      const { value, error } = await result.drain();
      expect(error).toBeUndefined();
      expect(value as any).toContain('app');
    });

    it('eval() version result should have drain()', async () => {
      const program = createPadrone('app')
        .configure({ version: '2.5.0' })
        .command('greet', (c) => c.action(() => 'hi'));

      const result = program.eval('--version');
      expect(typeof result.drain).toBe('function');
      const { value, error } = await result.drain();
      expect(error).toBeUndefined();
      expect(value as any).toBe('2.5.0');
    });

    it('eval() help result should be thenable', async () => {
      const program = createPadrone('app')
        .configure({ version: '1.0.0' })
        .command('greet', (c) => c.action(() => 'hi'));

      const result = await program.eval('--help');
      expect(result.result as any).toContain('app');
    });

    it('eval() version result should be thenable', async () => {
      const program = createPadrone('app')
        .configure({ version: '3.0.0' })
        .command('greet', (c) => c.action(() => 'hi'));

      const result = await program.eval('--version');
      expect(result.result as any).toBe('3.0.0');
    });

    it('cli() help result should have drain()', async () => {
      const program = createPadrone('app')
        .configure({ version: '1.0.0' })
        .runtime({ argv: () => ['--help'] })
        .command('greet', (c) => c.action(() => 'hi'));

      const result = program.cli();
      expect(typeof result.drain).toBe('function');
      const { value, error } = await result.drain();
      expect(error).toBeUndefined();
      expect(value).toContain('app');
    });

    it('cli() version result should have drain()', async () => {
      const program = createPadrone('app')
        .configure({ version: '4.0.0' })
        .runtime({ argv: () => ['--version'] })
        .command('greet', (c) => c.action(() => 'hi'));

      const result = program.cli();
      expect(typeof result.drain).toBe('function');
      const { value, error } = await result.drain();
      expect(error).toBeUndefined();
      expect(value).toBe('4.0.0');
    });

    it('cli() help result should be thenable', async () => {
      const program = createPadrone('app')
        .configure({ version: '1.0.0' })
        .runtime({ argv: () => ['--help'] })
        .command('greet', (c) => c.action(() => 'hi'));

      const result = await program.cli();
      expect(result.result).toContain('app');
    });
  });

  describe('never-throw behavior', () => {
    it('eval() should return error instead of throwing on action error', () => {
      const program = createPadrone('app').command('fail', (c) =>
        c.action(() => {
          throw new Error('boom');
        }),
      );

      const result = program.eval('fail');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('boom');
      expect(result.result).toBeUndefined();
    });

    it('eval() should return error for routing errors', () => {
      const program = createPadrone('app').command('exists', (c) => c.action(() => 'ok'));

      const result = program.eval('nonexistent');
      expect(result.error).toBeDefined();
    });

    it('cli() should return error instead of throwing on validation error', () => {
      const program = createPadrone('app')
        .runtime({ argv: () => ['greet'] })
        .command('greet', (c) => c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => args.name));

      const result = program.cli();
      expect(result.error).toBeDefined();
      expect(result.result).toBeUndefined();
    });

    it('run() should return error instead of throwing', () => {
      const program = createPadrone('app').command('fail', (c) =>
        c.arguments(z.object({ x: z.number() })).action(() => {
          throw new ActionError('oops');
        }),
      );

      const result = program.run('fail', { x: 1 });
      expect(result.error).toBeInstanceOf(ActionError);
      expect(result.result).toBeUndefined();
    });

    it('run() should return error for unknown command', () => {
      const program = createPadrone('app').command('exists', (c) => c.action(() => 'ok'));

      const result = program.run('nope' as any, {});
      expect(result.error).toBeDefined();
    });

    it('drain() should pass through error from failed pipeline', async () => {
      const program = createPadrone('app').command('fail', (c) =>
        c.action(() => {
          throw new Error('pipeline error');
        }),
      );

      const { value, error } = await program.eval('fail').drain();
      expect(value).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('pipeline error');
    });
  });

  describe('finalized results', () => {
    it('gives the same answer when drained twice, even for an unconsumed iterator', async () => {
      const program = createPadrone('app')
        .extend(padroneAutoOutput({ disabled: true }))
        .command('gen', (c) =>
          c.action(function* () {
            yield 1;
            yield 2;
          }),
        );

      const result = program.eval('gen');
      expect(await result.drain()).toEqual({ value: [1, 2] });
      expect(await result.drain()).toEqual({ value: [1, 2] });
    });

    it('reports a drain error once, for cli()', async () => {
      const exitCodes: number[] = [];
      const program = createPadrone('app')
        .extend(padroneAutoOutput({ disabled: true }))
        .runtime({ argv: () => ['boom'], output: () => {}, error: () => {}, setExitCode: (code) => exitCodes.push(code) })
        .command('boom', (c) =>
          c.action(async function* () {
            yield 1;
            throw new Error('late');
          }),
        );

      const result = program.cli();
      await result.drain();
      await result.drain();
      expect(exitCodes).toEqual([1]);
    });

    it('adds drain() to a plain result returned by a start interceptor', async () => {
      const program = createPadrone('app')
        .intercept(defineInterceptor({ name: 'short-circuit' }, () => ({ start: () => ({ result: 'early' }) })))
        .command('x', (c) => c.action(() => 'late'));

      expect(await program.eval('x').drain()).toEqual({ value: 'early' });
    });
  });

  describe('types', () => {
    it('should infer Drained type correctly', () => {
      // Simple value
      expectTypeOf<Drained<string>>().toEqualTypeOf<string>();
      expectTypeOf<Drained<number>>().toEqualTypeOf<number>();

      // Promise unwrapping
      expectTypeOf<Drained<Promise<string>>>().toEqualTypeOf<string>();
      expectTypeOf<Drained<Promise<Promise<number>>>>().toEqualTypeOf<number>();

      // Iterable collection
      expectTypeOf<Drained<Iterable<number>>>().toEqualTypeOf<number[]>();

      // AsyncIterable collection
      expectTypeOf<Drained<AsyncIterable<string>>>().toEqualTypeOf<string[]>();

      // Promise<AsyncIterable> unwrapping
      expectTypeOf<Drained<Promise<AsyncIterable<number>>>>().toEqualTypeOf<number[]>();

      // String stays string (not char array)
      expectTypeOf<Drained<string>>().toEqualTypeOf<string>();
    });

    it('should have drain() on eval sync result', () => {
      const program = createPadrone('app').command('cmd', (c) => c.action(() => 42));

      const result = program.eval('cmd');
      expectTypeOf(result.drain).toBeFunction();
      expectTypeOf(result.drain()).toEqualTypeOf<Promise<PadroneDrainResult<number>>>();
    });

    it('should have drain() on eval async result', () => {
      const program = createPadrone('app').command('cmd', (c) => c.async().action(() => 42));

      const result = program.eval('cmd');
      expectTypeOf(result.drain).toBeFunction();
      expectTypeOf(result.drain()).toEqualTypeOf<Promise<PadroneDrainResult<number>>>();
    });

    it('should have drain() on cli result', () => {
      const program = createPadrone('app').command('cmd', (c) => c.action(() => 'hello'));

      const result = program.cli();
      expectTypeOf(result.drain).toBeFunction();
    });

    it('should have drain() on run result', () => {
      const program = createPadrone('app').command('cmd', (c) => c.arguments(z.object({ x: z.number() })).action((args) => args.x * 2));

      const result = program.run('cmd', { x: 5 });
      expectTypeOf(result.drain).toBeFunction();
      expectTypeOf(result.drain()).toEqualTypeOf<Promise<PadroneDrainResult<number>>>();
    });

    it('should have drain() available on eval result', () => {
      const program = createPadrone('app').command('gen', (c) =>
        c.action(async function* () {
          yield 1;
          yield 2;
        }),
      );

      const result = program.eval('gen');
      expectTypeOf(result.drain).toBeFunction();
      // PadroneDrainResult resolves AsyncGenerator<number> to number[]
      expectTypeOf<Drained<AsyncGenerator<number, void, unknown>>>().toEqualTypeOf<number[]>();
    });
  });
});
