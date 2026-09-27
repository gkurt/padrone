// biome-ignore-all lint/correctness/noUnusedVariables: Type tests use unused variables intentionally.

import { describe, expect, expectTypeOf, it, test } from 'bun:test';
import type {
  ExtractInterceptorContext,
  ExtractInterceptorRequires,
  InferContext,
  InferContextProvided,
  InferInterceptorContext,
  InferInterceptorRequires,
} from 'padrone';
import { createPadrone, defineInterceptor } from 'padrone';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type User = { id: string; name: string };
type DbConnection = { query: (sql: string) => string[] };

const withAuth = defineInterceptor({ name: 'auth', order: -500 }, () => ({
  start(_ctx, next) {
    const user: User = { id: '1', name: 'Alice' };
    return next({ context: { user } });
  },
})).provides<{ user: User }>();

const withDb = defineInterceptor({ name: 'db', order: -600 }, () => ({
  start(_ctx, next) {
    const db: DbConnection = { query: () => ['row1'] };
    return next({ context: { db } });
  },
})).provides<{ db: DbConnection }>();

const plainInterceptor = defineInterceptor({ name: 'logger' }, () => ({
  execute(_ctx, next) {
    return next();
  },
}));

// Context-providing interceptor that requires db
const withAuthRequiresDb = defineInterceptor({ name: 'auth-requires-db', order: -500 }, () => ({
  start(_ctx, next) {
    const user: User = { id: '1', name: 'Alice' };
    return next({ context: { user } });
  },
}))
  .provides<{ user: User }>()
  .requires<{ db: DbConnection }>();

// Plain interceptor that requires auth (no provides)
const auditRequiresAuth = defineInterceptor({ name: 'audit' }, () => ({
  execute(_ctx, next) {
    return next();
  },
})).requires<{ user: User }>();

type Logger = { log: (msg: string) => void };

// Interceptor with optional requirement
const withAuthOptionalLogger = defineInterceptor({ name: 'auth-opt-logger', order: -500 }, () => ({
  start(_ctx, next) {
    const user: User = { id: '1', name: 'Alice' };
    return next({ context: { user } });
  },
}))
  .provides<{ user: User }>()
  .requires<{ db: DbConnection; logger?: Logger }>();

// ---------------------------------------------------------------------------
// Type tests
// ---------------------------------------------------------------------------

describe('context-providing interceptors — types', () => {
  test.skip('provides() brands the interceptor type', () => {
    expectTypeOf(withAuth).toHaveProperty('~context');
    expectTypeOf<ExtractInterceptorContext<typeof withAuth>>().toEqualTypeOf<{ user: User }>();
    expectTypeOf<InferInterceptorContext<typeof withAuth>>().toEqualTypeOf<{ user: User }>();
  });

  test.skip('plain interceptor has no ~context brand', () => {
    expectTypeOf<ExtractInterceptorContext<typeof plainInterceptor>>().toEqualTypeOf<unknown>();
  });

  test.skip('.intercept(contextInterceptor) adds to TContextProvided', () => {
    const program = createPadrone('test').intercept(withAuth);

    type Cmd = (typeof program)['~types']['command'];
    expectTypeOf<Cmd['~types']['contextProvided']>().toEqualTypeOf<{ user: User }>();
    // User-defined context is still unknown (no .context() called)
    expectTypeOf<Cmd['~types']['context']>().toEqualTypeOf<unknown>();
  });

  test.skip('multiple context interceptors accumulate via intersection', () => {
    const program = createPadrone('test').intercept(withDb).intercept(withAuth);

    type Cmd = (typeof program)['~types']['command'];
    expectTypeOf<Cmd['~types']['contextProvided']>().toEqualTypeOf<{ db: DbConnection } & { user: User }>();
  });

  test.skip('plain interceptor does not change TContextProvided', () => {
    const program = createPadrone('test').intercept(withAuth).intercept(plainInterceptor);

    type Cmd = (typeof program)['~types']['command'];
    expectTypeOf<Cmd['~types']['contextProvided']>().toEqualTypeOf<{ user: User }>();
  });

  test.skip('action handler sees merged context (TContext & TContextProvided)', () => {
    createPadrone('test')
      .context<{ tenant: string }>()
      .intercept(withAuth)
      .command('profile', (b) =>
        b.action((_args, ctx) => {
          expectTypeOf(ctx.context).toEqualTypeOf<{ tenant: string } & { user: User }>();
        }),
      );
  });

  test.skip('.context() preserves TContextProvided', () => {
    const program = createPadrone('test').intercept(withAuth).context<{ tenant: string }>();

    type Cmd = (typeof program)['~types']['command'];
    expectTypeOf<Cmd['~types']['context']>().toEqualTypeOf<{ tenant: string }>();
    expectTypeOf<Cmd['~types']['contextProvided']>().toEqualTypeOf<{ user: User }>();
  });

  test.skip('child commands inherit merged context from parent', () => {
    createPadrone('test')
      .context<{ tenant: string }>()
      .intercept(withAuth)
      .command('child', (b) =>
        b.action((_args, ctx) => {
          // Child sees parent's TContext & TContextProvided
          expectTypeOf(ctx.context).toEqualTypeOf<{ tenant: string } & { user: User }>();
        }),
      );
  });

  test.skip('ContextParam only requires user-defined context, not interceptor-provided', () => {
    const program = createPadrone('test')
      .context<{ tenant: string }>()
      .intercept(withAuth)
      .command('cmd', (b) => b.action(() => 'ok'));

    // cli() should only require { tenant: string }, not { user: User }
    type CliPrefs = NonNullable<Parameters<typeof program.cli>[0]>;
    expectTypeOf<CliPrefs['context']>().toEqualTypeOf<{ tenant: string }>();
  });

  test.skip('InferContext and InferContextProvided type helpers', () => {
    const program = createPadrone('test').context<{ tenant: string }>().intercept(withAuth);

    type Cmd = (typeof program)['~types']['command'];
    expectTypeOf<InferContext<Cmd>>().toEqualTypeOf<{ tenant: string }>();
    expectTypeOf<InferContextProvided<Cmd>>().toEqualTypeOf<{ user: User }>();
  });
});

// ---------------------------------------------------------------------------
// Runtime tests
// ---------------------------------------------------------------------------

describe('context-providing interceptors — runtime', () => {
  it('interceptor can inject context via next({ context })', () => {
    let receivedContext: unknown;

    const program = createPadrone('test')
      .intercept(withAuth)
      .command('profile', (b) =>
        b.action((_args, ctx) => {
          receivedContext = ctx.context;
          return 'ok';
        }),
      );

    const result = program.eval('profile');
    expect(result.result).toBe('ok');
    expect(receivedContext).toMatchObject({ user: { id: '1', name: 'Alice' } });
  });

  it('multiple context interceptors compose at runtime', () => {
    let receivedContext: unknown;

    const program = createPadrone('test')
      .intercept(withDb)
      .intercept(withAuth)
      .command('query', (b) =>
        b.action((_args, ctx) => {
          receivedContext = ctx.context;
          return 'ok';
        }),
      );

    const result = program.eval('query');
    expect(result.result).toBe('ok');
    expect(receivedContext).toMatchObject({
      user: { id: '1', name: 'Alice' },
      db: { query: expect.any(Function) },
    });
  });

  it('interceptor-provided context merges with user-provided context', () => {
    let receivedContext: unknown;

    const program = createPadrone('test')
      .context<{ tenant: string }>()
      .intercept(withAuth)
      .command('profile', (b) =>
        b.action((_args, ctx) => {
          receivedContext = ctx.context;
          return 'ok';
        }),
      );

    const result = program.eval('profile', { context: { tenant: 'acme' } });
    expect(result.result).toBe('ok');
    expect(receivedContext).toMatchObject({
      tenant: 'acme',
      user: { id: '1', name: 'Alice' },
    });
  });

  it('.provides() returns the same function (no-op at runtime)', () => {
    const base = defineInterceptor({ name: 'test' }, () => ({}));
    const branded = base.provides<{ foo: string }>();
    // Same reference — provides() is identity
    expect(branded).toBe(base as any);
  });

  it('context flows to child commands', () => {
    let receivedContext: unknown;

    const program = createPadrone('test')
      .intercept(withAuth)
      .command('parent', (b) =>
        b.command('child', (b) =>
          b.action((_args, ctx) => {
            receivedContext = ctx.context;
            return 'ok';
          }),
        ),
      );

    const result = program.eval('parent child');
    expect(result.result).toBe('ok');
    expect(receivedContext).toMatchObject({ user: { id: '1', name: 'Alice' } });
  });
});

// ---------------------------------------------------------------------------
// Requires — type tests
// ---------------------------------------------------------------------------

describe('context requires — types', () => {
  test.skip('requires() brands the interceptor with ~contextRequires', () => {
    expectTypeOf<ExtractInterceptorRequires<typeof withAuthRequiresDb>>().toEqualTypeOf<{ db: DbConnection }>();
    expectTypeOf<InferInterceptorRequires<typeof withAuthRequiresDb>>().toEqualTypeOf<{ db: DbConnection }>();
  });

  test.skip('interceptor without requires has no ~contextRequires brand', () => {
    expectTypeOf<ExtractInterceptorRequires<typeof withAuth>>().toEqualTypeOf<unknown>();
  });

  test.skip('.intercept() accepts requires-interceptor when context is satisfied', () => {
    // db is provided first, so authRequiresDb is valid
    const program = createPadrone('test').intercept(withDb).intercept(withAuthRequiresDb);

    type Cmd = (typeof program)['~types']['command'];
    expectTypeOf<Cmd['~types']['contextProvided']>().toEqualTypeOf<{ db: DbConnection } & { user: User }>();
  });

  test.skip('plain interceptor with requires accepted when context is satisfied', () => {
    // auth provides { user }, so audit interceptor (requires user) is valid
    const program = createPadrone('test').intercept(withAuth).intercept(auditRequiresAuth);

    type Cmd = (typeof program)['~types']['command'];
    // audit doesn't provide anything, so contextProvided stays { user: User }
    expectTypeOf<Cmd['~types']['contextProvided']>().toEqualTypeOf<{ user: User }>();
  });

  test.skip('optional requirements pass even when optional field is absent', () => {
    // withAuthOptionalLogger requires { db: DbConnection; logger?: Logger }
    // db is available, logger is not — should still compile because logger is optional
    const program = createPadrone('test').intercept(withDb).intercept(withAuthOptionalLogger);

    type Cmd = (typeof program)['~types']['command'];
    expectTypeOf<Cmd['~types']['contextProvided']>().toEqualTypeOf<{ db: DbConnection } & { user: User }>();
  });

  test.skip('.provides().requires() preserves both brands', () => {
    expectTypeOf(withAuthRequiresDb).toHaveProperty('~context');
    expectTypeOf(withAuthRequiresDb).toHaveProperty('~contextRequires');
    expectTypeOf<ExtractInterceptorContext<typeof withAuthRequiresDb>>().toEqualTypeOf<{ user: User }>();
    expectTypeOf<ExtractInterceptorRequires<typeof withAuthRequiresDb>>().toEqualTypeOf<{ db: DbConnection }>();
  });

  // NOTE: The following test verifies that .intercept() REJECTS an interceptor when
  // required context is not satisfied. Uncomment to manually verify the compile error.
  // test.skip('.intercept() rejects requires-interceptor when context is NOT satisfied', () => {
  //   // @ts-expect-error — db is not in context, so withAuthRequiresDb should be rejected
  //   createPadrone('test').intercept(withAuthRequiresDb);
  // });
});

// ---------------------------------------------------------------------------
// Requires — runtime tests
// ---------------------------------------------------------------------------

describe('context requires — runtime', () => {
  it('.requires() returns a new interceptor with the same meta', () => {
    const base = defineInterceptor({ id: 'test', name: 'test' }, () => ({}));
    const branded = base.requires<{ db: DbConnection }>();
    expect(branded).not.toBe(base as any);
    expect([branded.id, branded.name]).toEqual(['test', 'test']);
  });

  it('requires-interceptor works at runtime when context is provided', () => {
    let receivedContext: unknown;

    const program = createPadrone('test')
      .intercept(withDb)
      .intercept(withAuthRequiresDb)
      .command('cmd', (b) =>
        b.action((_args, ctx) => {
          receivedContext = ctx.context;
          return 'ok';
        }),
      );

    const result = program.eval('cmd');
    expect(result.result).toBe('ok');
    expect(receivedContext).toMatchObject({
      db: { query: expect.any(Function) },
      user: { id: '1', name: 'Alice' },
    });
  });
});
