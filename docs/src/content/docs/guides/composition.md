---
title: Program Composition
description: Compose programs together and override commands with mount and merge
---

Padrone provides two powerful mechanisms for building large CLIs from smaller pieces: **mounting** programs as subcommands and **overriding** existing commands with merged behavior.

## Mounting Programs

Use `.mount()` to compose an existing Padrone program as a subcommand of another program. All nested commands, arguments, handlers, interceptors, and schemas are recursively re-pathed under the new name.

```typescript
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

// Build independent programs
const users = createPadrone('users')
  .command('list', (c) => c.action(() => 'listing users'))
  .command('create', (c) =>
    c
      .arguments(z.object({ name: z.string() }))
      .action((args) => `created ${args.name}`)
  );

const roles = createPadrone('roles')
  .command('list', (c) => c.action(() => 'listing roles'))
  .command('assign', (c) =>
    c
      .arguments(z.object({ user: z.string(), role: z.string() }))
      .action((args) => `assigned ${args.role} to ${args.user}`)
  );

// Compose into a parent program
const admin = createPadrone('admin')
  .configure({ version: '1.0.0' })
  .mount('users', users)
  .mount('roles', roles);

// Commands are now:
// admin users list
// admin users create --name Alice
// admin roles list
// admin roles assign --user Alice --role editor
```

### Mount with Aliases

Pass an array as the first argument to add aliases:

```typescript
const app = createPadrone('app')
  .mount(['admin', 'adm'], admin);

// Both work:
// app admin users list
// app adm users list
```

### Configuring at Mount Time

Since builders are immutable, you can call `.configure()` on the program inline to set metadata like `group`, `title`, or `description` without mutating the original:

```typescript
const app = createPadrone('app')
  .mount('users', users.configure({ group: 'Resources' }))
  .mount('roles', roles.configure({ group: 'Resources' }));
```

This works with any builder method — you can also add interceptors or arguments at mount time:

```typescript
.mount('admin', admin.intercept(auditInterceptor))
```

### Mount with Context Transform

When your parent program uses a typed context, you can transform it for the mounted program:

```typescript
type AppContext = { db: Database; logger: Logger };

const users = createPadrone('users')
  .context<{ db: Database }>()
  .command('list', (c) =>
    c.action((args, { context }) => context.db.query('SELECT * FROM users'))
  );

const app = createPadrone('app')
  .context<AppContext>()
  .mount('users', users, {
    context: (appCtx) => ({ db: appCtx.db }),
  });

app.cli({ context: { db: createDb(), logger: createLogger() } });
```

The `context` option is a function that receives the parent's context and returns the context expected by the mounted program.

### What Gets Mounted

- All nested commands and their subcommands
- Arguments, schemas, and action handlers
- Interceptors registered on the mounted program or its commands
- Aliases on nested commands
- Context transforms (composed with mount-level transform if provided)

The mounted program's root-level `version` is dropped to avoid conflicts with the parent.

### Type Safety

Mount preserves full type inference. `eval()`, `find()`, `run()`, and `api()` all correctly resolve the mounted command paths:

```typescript
// Fully typed — TypeScript knows 'users create' exists and its args
admin.run('users create', { name: 'Alice' });

const api = admin.api();
api.users.create({ name: 'Bob' });
```

## Commands in Separate Files

For a command defined in a file of its own, wrap the builder function in `defineCommand()`. The program keeps its full type (args, result and subcommands), under the name it's added with:

```typescript
// commands/remove.ts
import { defineCommand } from 'padrone';

export const remove = defineCommand((c) =>
  c
    .describe('Remove bookmarks')
    .arguments(z.object({ ids: z.array(z.number()) }), { positional: ['...ids'] })
    .action((args) => store.remove(args.ids)),
);

// A command that uses the program's context: pass its type, then the builder function
export const list = defineCommand<{ store: Store }>()((c) => c.action((_args, ctx) => ctx.context.store.items));

// A command that reads the program's global args: pass the schema's type too.
// The result of defineCommand<...>() can be kept and reused for every command.
export const command = defineCommand<{ store: Store }, typeof globals>();
export const stats = command((c) => c.action((args, ctx) => (args.verbose ? ctx.context.store.items : ctx.context.store.items.length)));

// cli.ts
export const globals = z.object({ verbose: z.boolean().default(false) });
const program = createPadrone('bm')
  .context<{ store: Store }>()
  .globalArgs(globals)
  .command(['remove', 'rm'], remove)
  .command('list', list)
  .command('stats', stats);
program.run('rm', { ids: [1], verbose: true }, { context: { store } }); // typed args (global ones too) and result
```

`defineCommand().requires<{ logger: PadroneLogger }>().define(fn)` declares context that an interceptor must provide: added to a program that doesn't provide it, `.command()` returns a `DefineCommandRequiresError` type, so the next use of the program is a type error.

## Command Override

Re-registering a command with the same name merges the new definition with the existing one instead of duplicating it.

### Basic Override

```typescript
const program = createPadrone('app')
  .command('deploy', (c) =>
    c
      .arguments(z.object({ target: z.string() }))
      .action((args) => `deploying to ${args.target}`)
  )
  // Override: new config is shallow-merged, handler receives `base`
  .command('deploy', (c) =>
    c
      .configure({ description: 'Enhanced deploy with logging' })
      .action((args, ctx, base) => {
        console.log('Pre-deploy hook');
        const result = base(args, ctx);
        console.log('Post-deploy hook');
        return result;
      })
  );
```

### The `base` Parameter

When overriding a command, the `.action()` handler receives a third `base` parameter — a reference to the previous handler. This lets you wrap, extend, or conditionally delegate to the original behavior:

```typescript
.command('build', (c) =>
  c.action((args, ctx, base) => {
    // Call the original handler
    const original = base(args, ctx);

    // Extend with additional behavior
    return { ...original, enhanced: true };
  })
)
```

### What Gets Merged

When a command is re-registered with the same name:

| Aspect | Behavior |
|--------|----------|
| Configuration | Shallow-merged (new overrides old) |
| Handler | New handler replaces old; old available as `base` |
| Arguments/schema | New replaces old if provided |
| Subcommands | Recursively merged by name |
| Aliases | Preserved from original if override doesn't specify new ones |

### Recursive Subcommand Merge

Overriding a parent command also merges its subcommands by name:

```typescript
const program = createPadrone('app')
  .command('db', (c) =>
    c
      .command('migrate', (c) => c.action(() => 'migrate'))
      .command('seed', (c) => c.action(() => 'seed'))
  )
  // Add a new subcommand to 'db' without losing existing ones
  .command('db', (c) =>
    c.command('reset', (c) => c.action(() => 'reset'))
  );

// All three work:
// app db migrate
// app db seed
// app db reset
```

## Combining Mount and Override

Mount and override compose naturally. You can mount a program and then override specific commands:

```typescript
const base = createPadrone('base')
  .command('serve', (c) =>
    c
      .arguments(z.object({ port: z.number().default(3000) }))
      .action((args) => `serving on ${args.port}`)
  );

const app = createPadrone('app')
  .mount('api', base)
  // Override the mounted command
  .command('api', (c) =>
    c.command('serve', (c) =>
      c.action((args, ctx, base) => {
        console.log('Custom pre-serve logic');
        return base(args, ctx);
      })
    )
  );
```
