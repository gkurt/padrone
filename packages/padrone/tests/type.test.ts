// biome-ignore-all lint/correctness/noUnusedVariables: This file is for testing TypeScript types, so unused variables are intentional.

import { expectTypeOf, test } from 'bun:test';
import type { DefineCommand, DefineCommandContext, PadroneBuilder, PadroneLogger, PadroneProgram, PadroneProgressContext } from 'padrone';
import { asyncSchema, createPadrone, defineCommand, defineInterceptor, padroneProgress } from 'padrone';
import type { PadroneTracer } from 'padrone/tracing';
import * as z from 'zod/v4';
import { createTasksProgram } from './common.ts';

/** This test verifies that PadroneBuilder does NOT have program-only methods */
test.skip('Types - Builder vs Program separation', async () => {
  // Builder should have these methods
  type BuilderKeys = keyof PadroneBuilder;
  expectTypeOf<'configure'>().toExtend<BuilderKeys>();
  expectTypeOf<'arguments'>().toExtend<BuilderKeys>();
  expectTypeOf<'action'>().toExtend<BuilderKeys>();
  expectTypeOf<'command'>().toExtend<BuilderKeys>();
  expectTypeOf<'~types'>().toExtend<BuilderKeys>();

  // Builder should NOT have these program-only methods
  type ProgramOnlyKeys = 'run' | 'cli' | 'parse' | 'stringify' | 'find' | 'api' | 'tool' | 'help' | 'completion';
  expectTypeOf<ProgramOnlyKeys>().not.toMatchObjectType<BuilderKeys>();

  // Program should have all methods
  type ProgramKeys = keyof PadroneProgram;
  expectTypeOf<'configure'>().toExtend<ProgramKeys>();
  expectTypeOf<'arguments'>().toExtend<ProgramKeys>();
  expectTypeOf<'action'>().toExtend<ProgramKeys>();
  expectTypeOf<'command'>().toExtend<ProgramKeys>();
  expectTypeOf<'run'>().toExtend<ProgramKeys>();
  expectTypeOf<'cli'>().toExtend<ProgramKeys>();
  expectTypeOf<'parse'>().toExtend<ProgramKeys>();
  expectTypeOf<'stringify'>().toExtend<ProgramKeys>();
  expectTypeOf<'find'>().toExtend<ProgramKeys>();
  expectTypeOf<'api'>().toExtend<ProgramKeys>();
  expectTypeOf<'tool'>().toExtend<ProgramKeys>();
  expectTypeOf<'help'>().toExtend<ProgramKeys>();
  expectTypeOf<'completion'>().toExtend<ProgramKeys>();

  // Verify builder chaining returns builder within command() callback
  createPadrone('test').command('cmd', (builder) => {
    // builder should be PadroneBuilder
    const afterargs = builder.arguments(z.object({ name: z.string() }));
    // afterargs should also be PadroneBuilder - program methods should NOT exist
    type AfterargsKeys = keyof typeof afterargs;
    expectTypeOf<'run'>().not.toMatchObjectType<AfterargsKeys>();
    expectTypeOf<'cli'>().not.toMatchObjectType<AfterargsKeys>();
    expectTypeOf<'parse'>().not.toMatchObjectType<AfterargsKeys>();

    return afterargs.action((args) => args.name);
  });
});

/** This test is skipped because it's only used to test the types of the program, not the runtime behavior. */
test.skip('Types', async () => {
  expectTypeOf(1).toEqualTypeOf<number>();

  const program = createTasksProgram();
  const parsed = await program.parse('list');
  const parsedNested = await program.parse('list extended');
  const parsedNested2 = await program.parse('list extended extended');

  expectTypeOf<(typeof parsed)['command']['path']>().toEqualTypeOf<'list'>();
  expectTypeOf<(typeof parsedNested)['command']['path']>().toEqualTypeOf<'list extended'>();
  expectTypeOf<(typeof parsedNested2)['command']['path']>().toEqualTypeOf<'list extended extended'>();

  type TNames = Extract<Parameters<typeof program.run>[0], string>;
  // Builtin commands (help, h, version) are included in the type
  expectTypeOf<'help'>().toExtend<TNames>();
  expectTypeOf<'version'>().toExtend<TNames>();
  expectTypeOf<'show'>().toExtend<TNames>();
  expectTypeOf<'list'>().toExtend<TNames>();
  expectTypeOf<'filter'>().toExtend<TNames>();
});

/** This test verifies that command aliases are properly typed */
test.skip('Types - Aliases', async () => {
  const programWithAliases = createPadrone('test')
    .command(['list', 'ls', 'l'], (c) =>
      c.arguments(z.object({ format: z.enum(['json', 'table']).default('table') })).action((args) => ({ items: [], format: args.format })),
    )
    .command(['delete', 'rm'], (c) =>
      c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => ({ deleted: args.name })),
    )
    .command('config', (c) =>
      c.command(['set', 's'], (sub) =>
        sub
          .arguments(z.object({ key: z.string(), value: z.string() }), { positional: ['key', 'value'] })
          .action((args) => ({ key: args.key, value: args.value })),
      ),
    );

  // Test that aliases are included in possible command names
  type TPossibleNames = Extract<Parameters<typeof programWithAliases.eval>[0], string>;
  expectTypeOf<TPossibleNames>().toExtend<(string & {}) | 'list' | 'ls' | 'l' | 'delete' | 'rm' | 'config' | 'config set' | 'config s'>();

  // Test that parse returns correct command type when using alias
  const parsedByName = programWithAliases.parse('list');
  const parsedByAlias = programWithAliases.parse('ls');
  expectTypeOf<(typeof parsedByName)['command']['path']>().toEqualTypeOf<'list'>();
  expectTypeOf<(typeof parsedByAlias)['command']['path']>().toEqualTypeOf<'list'>();

  // Test nested command with alias
  const parsedNestedByName = programWithAliases.parse('config set key value');
  const parsedNestedByAlias = programWithAliases.parse('config s key value');
  expectTypeOf<(typeof parsedNestedByName)['command']['path']>().toEqualTypeOf<'config set'>();
  expectTypeOf<(typeof parsedNestedByAlias)['command']['path']>().toEqualTypeOf<'config set'>();
});

test.skip('Types - Parsed command type', async () => {
  const program = createPadrone('test')
    .command('greet', (c) =>
      c
        .arguments(
          z.object({
            name: z.string().default('World'),
            excited: z.boolean().default(false),
          }),
        )
        .action((args) => {
          const greeting = `Hello, ${args.name}${args.excited ? '!' : '.'}`;
          return { greeting };
        }),
    )
    .command('sum', (c) =>
      c
        .arguments(
          z.object({
            numbers: z.array(z.number()),
          }),
        )
        .action((args) => {
          const total = args.numbers.reduce((a, b) => a + b, 0);
          return { total };
        }),
    );

  const parsedGreet = await program.parse('greet --name Alice --excited true');
  expectTypeOf<(typeof parsedGreet)['command']['path']>().toEqualTypeOf<'greet'>();

  const parsedString = await program.parse('sum --numbers 1 --numbers 2 --numbers 3' as string);
  expectTypeOf<(typeof parsedString)['command']['path']>().toExtend<'' | 'help' | 'version' | 'sum' | 'greet'>();
});

/** This test verifies that interactive meta makes commands async */
test.skip('Types - Interactive', () => {
  const syncSchema = z.object({ name: z.string(), template: z.enum(['react', 'vue']), verbose: z.boolean().default(false) });

  const program = createPadrone('test')
    .command('no-interactive', (c) => c.arguments(syncSchema).action((args) => args.name))
    .command('interactive-true', (c) => c.arguments(syncSchema, { interactive: true }).action((args) => args.name))
    .command('interactive-fields', (c) => c.arguments(syncSchema, { interactive: ['name', 'template'] }).action((args) => args.name))
    .command('optional-interactive', (c) => c.arguments(syncSchema, { optionalInteractive: ['verbose'] }).action((args) => args.name))
    .command('both-interactive', (c) =>
      c.arguments(syncSchema, { interactive: ['name'], optionalInteractive: ['verbose'] }).action((args) => args.name),
    );

  // No interactive: sync
  const syncParsed = program.parse('no-interactive --name hello --template react');
  expectTypeOf(syncParsed).not.toMatchTypeOf<Promise<any>>();

  const syncCli = program.eval('no-interactive --name hello --template react');
  expectTypeOf(syncCli).not.toMatchTypeOf<Promise<any>>();

  // interactive: true → async
  const interactiveTrueParsed = program.parse('interactive-true --name hello --template react');
  expectTypeOf(interactiveTrueParsed).toMatchTypeOf<Promise<any>>();

  const interactiveTrueCli = program.eval('interactive-true --name hello --template react');
  expectTypeOf(interactiveTrueCli).toMatchTypeOf<Promise<any>>();

  // interactive: ['name', 'template'] → async
  const interactiveFieldsParsed = program.parse('interactive-fields --name hello --template react');
  expectTypeOf(interactiveFieldsParsed).toMatchTypeOf<Promise<any>>();

  // optionalInteractive: ['verbose'] → async
  const optionalParsed = program.parse('optional-interactive --name hello --template react');
  expectTypeOf(optionalParsed).toMatchTypeOf<Promise<any>>();

  // Both → async
  const bothCli = program.eval('both-interactive --name hello --template react');
  expectTypeOf(bothCli).toMatchTypeOf<Promise<any>>();
});

/** This test verifies that stdin meta makes commands async */
test.skip('Types - Stdin', () => {
  const program = createPadrone('test')
    .command('plain', (c) => c.arguments(z.object({ input: z.string().optional() })).action((args) => args.input))
    .command('piped', (c) => c.arguments(z.object({ input: z.string().optional() }), { stdin: 'input' }).action((args) => args.input));

  expectTypeOf(program.eval('plain')).not.toMatchTypeOf<Promise<any>>();
  expectTypeOf(program.eval('piped')).toMatchTypeOf<Promise<any>>();
});

/** This test verifies that command override/extension types work correctly */
test.skip('Types - Command override', () => {
  // Override builder receives existing command's args type
  const program = createPadrone('test')
    .command('greet', (c) =>
      c
        .arguments(z.object({ name: z.string(), loud: z.boolean().default(false) }), { positional: ['name'] })
        .action((args) => `hello ${args.name}`),
    )
    .command('other', (c) => c.action(() => 42 as const));

  // Override preserves existing args when no new .arguments() is called
  const overridden = program.command('greet', (c) => {
    return c.action((args) => {
      // args should have the original type: { name: string; loud: boolean }
      expectTypeOf(args).toEqualTypeOf<{ name: string; loud: boolean }>();
      return args.name.length;
    });
  });

  // Override result type replaces original
  const overriddenResult = overridden.eval('greet World');
  expectTypeOf(overriddenResult.result).toEqualTypeOf<number | undefined>();

  // base parameter in action has original handler's return type
  program.command('greet', (c) =>
    c.action((args, ctx, base) => {
      const original = base(args, ctx);
      expectTypeOf(original).toEqualTypeOf<string>();
      return { original, modified: true };
    }),
  );

  // base is typed as noop (returning void) for commands without an existing action
  createPadrone('test')
    .command('empty', (c) => c.configure({ title: 'Empty' }))
    .command('empty', (c) =>
      c.action((_args, _ctx, base) => {
        const result = base(_args, _ctx);
        expectTypeOf(result).toEqualTypeOf<void>();
        return 'filled';
      }),
    );

  // Override with new arguments changes args type
  program.command('greet', (c) =>
    c.arguments(z.object({ firstName: z.string(), lastName: z.string() })).action((args) => {
      expectTypeOf(args).toEqualTypeOf<{ firstName: string; lastName: string }>();
      return `${args.firstName} ${args.lastName}`;
    }),
  );

  // Other commands remain unaffected
  const otherResult = overridden.eval('other');
  expectTypeOf(otherResult.result).toEqualTypeOf<42 | undefined>();

  // Override preserves aliases in eval/parse type resolution
  const withAliases = createPadrone('test')
    .command(['greet', 'g', 'hi'], (c) => c.action(() => 'hello' as const))
    .command('greet', (c) => c.action(() => 'hello v2' as const));

  const aliasResult = withAliases.eval('g');
  expectTypeOf(aliasResult.result).toEqualTypeOf<'hello v2' | undefined>();

  const aliasResult2 = withAliases.eval('hi');
  expectTypeOf(aliasResult2.result).toEqualTypeOf<'hello v2' | undefined>();

  // Command count doesn't grow — override replaces, not appends
  type OverriddenCommands = (typeof overridden)['~types']['commands'];
  // Should still have exactly 4 commands: [help, version, greet, other]
  expectTypeOf<OverriddenCommands['length']>().toEqualTypeOf<4>();

  // Chained overrides compose correctly
  const chained = createPadrone('test')
    .command('foo', (c) => c.action(() => 'v1' as const))
    .command('foo', (c) =>
      c.action((_a, _r, base) => {
        expectTypeOf(base(_a, _r)).toEqualTypeOf<'v1'>();
        return 'v2' as const;
      }),
    )
    .command('foo', (c) =>
      c.action((_a, _r, base) => {
        expectTypeOf(base(_a, _r)).toEqualTypeOf<'v2'>();
        return 'v3' as const;
      }),
    );
  expectTypeOf(chained.eval('foo').result).toEqualTypeOf<'v3' | undefined>();

  // Override with subcommands: builder sees existing subcommands
  const withSubs = createPadrone('test')
    .command('db', (c) =>
      c.command('migrate', (s) => s.action(() => 'migrated' as const)).command('seed', (s) => s.action(() => 'seeded' as const)),
    )
    .command('db', (c) =>
      c.command('migrate', (s) =>
        s.action((_a, _r, base) => {
          expectTypeOf(base(_a, _r)).toEqualTypeOf<'migrated'>();
          return 'migrated-v2' as const;
        }),
      ),
    );

  expectTypeOf(withSubs.eval('db migrate').result).toEqualTypeOf<'migrated-v2' | undefined>();
  expectTypeOf(withSubs.eval('db seed').result).toEqualTypeOf<'seeded' | undefined>();
});

/** This test verifies that async commands return Promises and sync commands don't */
test.skip('Types - Async', () => {
  const syncSchema = z.object({ name: z.string() });
  const brandedSchema = asyncSchema(z.object({ name: z.string() }));

  const program = createPadrone('test')
    .command('sync-cmd', (c) => c.arguments(syncSchema).action((args) => args.name))
    .command('async-branded', (c) => c.arguments(brandedSchema).action((args) => args.name))
    .command('async-explicit', (c) =>
      c
        .arguments(syncSchema)
        .async()
        .action((args) => args.name),
    );

  // Sync command: parse and cli return plain values (not Promises)
  const syncParsed = program.parse('sync-cmd --name hello');
  expectTypeOf(syncParsed).not.toMatchTypeOf<Promise<any>>();

  const syncCli = program.eval('sync-cmd --name hello');
  expectTypeOf(syncCli).not.toMatchTypeOf<Promise<any>>();

  // Async branded: parse and cli return Promises
  const asyncBrandedParsed = program.parse('async-branded --name hello');
  expectTypeOf(asyncBrandedParsed).toMatchTypeOf<Promise<any>>();

  const asyncBrandedCli = program.eval('async-branded --name hello');
  expectTypeOf(asyncBrandedCli).toMatchTypeOf<Promise<any>>();

  // Async explicit: parse and cli return Promises
  const asyncExplicitParsed = program.parse('async-explicit --name hello');
  expectTypeOf(asyncExplicitParsed).toMatchTypeOf<Promise<any>>();

  const asyncExplicitCli = program.eval('async-explicit --name hello');
  expectTypeOf(asyncExplicitCli).toMatchTypeOf<Promise<any>>();

  // Builder: .async() is available on builder
  expectTypeOf<'async'>().toExtend<keyof PadroneBuilder>();
});

/** This test verifies that readonly arrays are accepted in configuration */
test.skip('Types - Readonly arrays in configuration', () => {
  // Readonly positional array
  const positional = ['source', '...files'] as const;
  createPadrone('test').command('copy', (c) =>
    c.arguments(z.object({ source: z.string(), files: z.array(z.string()) }), { positional }).action((args) => args),
  );

  // Readonly interactive array
  const interactive = ['name', 'template'] as const;
  createPadrone('test').command('init', (c) =>
    c.arguments(z.object({ name: z.string(), template: z.string() }), { interactive }).action((args) => args),
  );

  // Readonly optionalInteractive array
  const optionalInteractive = ['verbose'] as const;
  createPadrone('test').command('build', (c) =>
    c.arguments(z.object({ verbose: z.boolean().default(false) }), { optionalInteractive }).action((args) => args),
  );

  // Readonly fields with flags and alias
  const flags = ['v', 'V'] as const;
  const alias = ['dry-run', 'no-cache'] as const;
  createPadrone('test').command('deploy', (c) =>
    c
      .arguments(z.object({ verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }), {
        fields: {
          verbose: { flags, alias },
        },
      })
      .action((args) => args),
  );

  // Inline readonly arrays (as const satisfies)
  createPadrone('test').command('run', (c) =>
    c
      .arguments(z.object({ file: z.string(), args: z.array(z.string()) }), {
        positional: ['file', '...args'] as const,
        interactive: ['file'] as const,
      })
      .action((args) => args),
  );
});

/** This test verifies DefineCommand type and defineCommand helper for split-file command definitions */
test.skip('Types - DefineCommand', () => {
  const schema = z.object({ name: z.string(), verbose: z.boolean().default(false) });

  // DefineCommand type: contextually types the builder, return type is widened to CommandTypesBase
  const withType: DefineCommand = (c) => c.arguments(schema).action((args) => `hello ${args.name}`);

  // Works with .command()
  createPadrone('test').command('greet', withType);

  // DefineCommand with context requires the parent to provide that context
  type Ctx = { db: { find: (id: string) => string } };
  const withContext: DefineCommand<Ctx> = (c) =>
    c.arguments(z.object({ id: z.string() })).action((args, ctx) => ctx.context.db.find(args.id));

  createPadrone('test').context<Ctx>().command('find', withContext);

  // Check if builder if still strongly typed
  createPadrone('test').command('find', (builder) => {
    expectTypeOf(builder).not.toBeAny();
    return builder;
  });

  // @ts-expect-error Check if builder fails on arbitrary return type
  createPadrone('test').command('find', (_b) => 5);

  const withContextAnon: DefineCommand = (c) => c.arguments(z.object({ id: z.string() })).action((args) => `hello ${args.id}`);

  createPadrone('test').context<Ctx>().command('find', withContextAnon);

  const withContextNotAny: DefineCommand = (c) =>
    c.arguments(z.object({ id: z.string() })).action((_args, ctx) => expectTypeOf(ctx.context).not.toBeAny());

  createPadrone('test').context<Ctx>().command('find', withContextNotAny);

  const dbInterceptor = defineInterceptor({ name: '' })
    .factory(() => ({}))
    .provides<Ctx>();
  const withContextInferred: DefineCommand = (c) =>
    c
      .intercept(dbInterceptor)
      .arguments(z.object({ id: z.string() }))
      .action((_args, ctx) => expectTypeOf(ctx.context.db).not.toBeAny());

  createPadrone('test').context<Ctx>().command('find', withContextInferred);

  // defineCommand helper: preserves full return type
  const withHelper = defineCommand((c) => c.arguments(schema).action((args) => `hello ${args.name}`));

  const program2 = createPadrone('test').command('greet', withHelper);

  // Return type is preserved — parent knows the exact result
  const result2 = program2.eval('greet --name World');
  expectTypeOf(result2.result).toEqualTypeOf<string | undefined>();

  // defineCommand with context
  const withHelperCtx = defineCommand<Ctx>((c) =>
    c.arguments(z.object({ id: z.string() })).action((args, ctx) => ctx.context.db.find(args.id)),
  );

  createPadrone('test').context<Ctx>().command('find', withHelperCtx);

  // defineCommand preserves subcommand types
  const withSubs = defineCommand((c) =>
    c
      .command('list', (s) => s.action(() => 'listed' as const))
      .command('add', (s) => s.arguments(z.object({ item: z.string() })).action((args) => args.item)),
  );

  const program3 = createPadrone('test').command('items', withSubs);
  const listResult = program3.eval('items list');
  // Result is the union of all possible subcommand results under 'items'
  expectTypeOf(listResult.result).toExtend<'listed' | string | void | undefined>();
});

/** This test verifies defineCommand works with extensions like padroneProgress */
test.skip('Types - DefineCommand with extensions', () => {
  // defineCommand + .extend(padroneProgress()) should provide progress in context
  const withProgress = defineCommand((c) =>
    c
      .extend(padroneProgress('Loading...'))
      .arguments(z.object({ id: z.string() }))
      .action((args, ctx) => {
        expectTypeOf(ctx.context.progress).toEqualTypeOf<PadroneProgressContext>();
        ctx.context.progress.update('halfway');
        return args.id;
      }),
  );

  const program = createPadrone('test').command('load', withProgress);
  const result = program.eval('load --id abc');
  expectTypeOf(result.result).toEqualTypeOf<string | undefined>();
});

/** This test verifies DefineCommandContext provides optional logger, tracing, progress by default */
test.skip('Types - DefineCommandContext default context', () => {
  // DefineCommandContext interface has optional logger, tracing, progress
  expectTypeOf<DefineCommandContext>().toHaveProperty('logger');
  expectTypeOf<DefineCommandContext['logger']>().toEqualTypeOf<PadroneLogger | undefined>();
  expectTypeOf<DefineCommandContext['tracing']>().toEqualTypeOf<PadroneTracer | undefined>();
  expectTypeOf<DefineCommandContext['progress']>().toEqualTypeOf<PadroneProgressContext | undefined>();

  // defineCommand action handler has access to optional logger, tracing, progress
  defineCommand((c) =>
    c.action((_args, ctx) => {
      expectTypeOf(ctx.context.logger).toEqualTypeOf<PadroneLogger | undefined>();
      expectTypeOf(ctx.context.tracing).toEqualTypeOf<PadroneTracer | undefined>();
      expectTypeOf(ctx.context.progress).toEqualTypeOf<PadroneProgressContext | undefined>();
    }),
  );

  // DefineCommand type alias also gets DefineCommandContext
  const cmd: DefineCommand = (c) =>
    c.action((_args, ctx) => {
      expectTypeOf(ctx.context.logger).toEqualTypeOf<PadroneLogger | undefined>();
    });
});

/** This test verifies defineCommand().requires().define() brands callbacks and validates at .command() */
test.skip('Types - defineCommand().requires()', () => {
  type AdminDB = { query: (sql: string) => string[] };

  // .requires() adds the required type to context and brands the callback
  const adminCommand = defineCommand()
    .requires<{ adminDb: AdminDB }>()
    .define((c) =>
      c.action((_args, ctx) => {
        // adminDb is required (not optional)
        expectTypeOf(ctx.context.adminDb).toEqualTypeOf<AdminDB>();
        // DefineCommandContext optionals are still available
        expectTypeOf(ctx.context.logger).toEqualTypeOf<PadroneLogger | undefined>();
        return { test: 5 };
      }),
    );

  // Branded callback has '~contextRequires' phantom property
  expectTypeOf(adminCommand).toHaveProperty('~contextRequires');

  // Registering on a program that provides the context: no error
  const adminInterceptor = defineInterceptor({ name: 'admin' }, () => ({
    execute(_ctx, next) {
      return next({ context: { adminDb: { query: (sql: string) => [sql] } } });
    },
  })).provides<{ adminDb: AdminDB }>();

  const program = createPadrone('test').intercept(adminInterceptor).command('admin', adminCommand);
  expectTypeOf(program.eval).toBeFunction();

  // Registering on a program WITHOUT the context: returns DefineCommandRequiresError
  const badProgram = createPadrone('test').command('admin', adminCommand);
  expectTypeOf(badProgram).toHaveProperty('~error');
});

test('function-form arguments infer the extended schema, with meta', () => {
  createPadrone('app')
    .arguments(z.object({ verbose: z.boolean().optional() }))
    .command('rm', (c) =>
      c
        .arguments((parent) => parent.extend({ file: z.string() }), { positional: ['file'] })
        .action((args) => {
          expectTypeOf(args).toEqualTypeOf<{ verbose?: boolean; file: string }>();
          return args.file;
        }),
    );
});

test('globalArgs are merged into args, and a subcommand can override or extend them', () => {
  const program = createPadrone('app')
    .globalArgs(z.object({ verbose: z.boolean().optional(), profile: z.string().default('default') }))
    .command('deploy', (c) =>
      c.arguments(z.object({ env: z.string() }), { positional: ['env'] }).action((args) => {
        expectTypeOf(args).toEqualTypeOf<{ verbose?: boolean; profile: string } & { env: string }>();
        return args.env;
      }),
    )
    .command('logs', (c) =>
      c.action((args) => {
        expectTypeOf(args).toEqualTypeOf<{ verbose?: boolean; profile: string }>();
      }),
    )
    .command('scale', (c) =>
      c.arguments(z.object({ verbose: z.number().optional() })).action((args) => {
        expectTypeOf(args.verbose).toEqualTypeOf<number | undefined>();
        expectTypeOf(args.profile).toEqualTypeOf<string>();
      }),
    )
    .command('cloud', (c) =>
      c
        .globalArgs((inherited) => inherited.extend({ region: z.string().optional() }))
        .command('up', (u) =>
          u.action((args) => {
            expectTypeOf(args.region).toEqualTypeOf<string | undefined>();
            expectTypeOf(args.profile).toEqualTypeOf<string>();
          }),
        ),
    );

  program.run('deploy', { env: 'prod', verbose: true });
  expectTypeOf(program.parse('deploy prod')).toMatchTypeOf<{ args?: { env: string; profile: string } }>();

  // Without globalArgs, args types are unchanged
  createPadrone('plain').command('x', (c) =>
    c.arguments(z.object({ a: z.string() })).action((args) => {
      expectTypeOf(args).toEqualTypeOf<{ a: string }>();
    }),
  );
});

test('interactive globalArgs make every command in the subtree async', () => {
  const program = createPadrone('app')
    .globalArgs(z.object({ token: z.string() }), { interactive: true })
    .command('logs', (c) => c.action((args) => args.token));
  expectTypeOf(program.eval('logs')).toMatchTypeOf<Promise<any>>();

  const plain = createPadrone('app')
    .globalArgs(z.object({ token: z.string() }))
    .command('logs', (c) => c.action((args) => args.token));
  expectTypeOf(plain.eval('logs')).not.toMatchTypeOf<Promise<any>>();
});
