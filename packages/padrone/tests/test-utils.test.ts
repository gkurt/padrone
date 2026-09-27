import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneConfig, padroneEnv } from 'padrone';
import { testCli } from 'padrone/test';
import * as z from 'zod/v4';

describe('testCli', () => {
  describe('basic eval', () => {
    const program = createPadrone('test')
      .command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      )
      .command('add', (c) => c.arguments(z.object({ a: z.coerce.number(), b: z.coerce.number() })).action((args) => args.a + args.b));

    it('should run a command with .args() and return result', async () => {
      const result = await testCli(program).args('greet World').run();

      expect(result.result).toBe('Hello, World!');
      expect(result.args).toEqual({ name: 'World' });
      expect(result.command.name).toBe('greet');
      expect(result.issues).toBeUndefined();
    });

    it('should accept input directly in run()', async () => {
      const result = await testCli(program).run('greet Alice');

      expect(result.result).toBe('Hello, Alice!');
    });

    it('should override .args() when run() receives input', async () => {
      const result = await testCli(program).args('greet Alice').run('greet Bob');

      expect(result.result).toBe('Hello, Bob!');
    });

    it('should capture validation errors as issues', async () => {
      const result = await testCli(program).run('greet');

      expect(result.issues).toBeDefined();
      expect(result.issues!.length).toBeGreaterThan(0);
    });

    it('should run named options', async () => {
      const result = await testCli(program).run('add --a=2 --b=3');

      expect(result.result).toBe(5);
    });
  });

  describe('stdout/stderr capture', () => {
    it('should capture output from runtime.output()', async () => {
      const program = createPadrone('test').command('hello', (c) =>
        c.action((_args, { runtime: rt }) => {
          rt.output('line 1');
          rt.output('line 2');
          return 'done';
        }),
      );

      const result = await testCli(program).run('hello');

      expect(result.stdout).toContain('line 1');
      expect(result.stdout).toContain('line 2');
      expect(result.result).toBe('done');
    });

    it('should capture thrown errors', async () => {
      const program = createPadrone('test').command('fail', (c) =>
        c.action(() => {
          throw new Error('something broke');
        }),
      );

      const result = await testCli(program).run('fail');

      expect(result.error).toBeDefined();
      expect(result.stderr.some((s) => s.includes('something broke'))).toBe(true);
    });
  });

  describe('env vars', () => {
    it('should provide environment variables via .env()', async () => {
      const program = createPadrone('test').command('deploy', (c) =>
        c
          .arguments(z.object({ target: z.string().default('staging') }))
          .extend(padroneEnv(z.object({ DEPLOY_TARGET: z.string().optional() }).transform((e) => ({ target: e.DEPLOY_TARGET }))))
          .action((args) => `deployed to ${args.target}`),
      );

      const result = await testCli(program).env({ DEPLOY_TARGET: 'production' }).run('deploy');

      expect(result.result).toBe('deployed to production');
    });
  });

  describe('interactive prompts', () => {
    it('should mock interactive prompt answers via .prompt()', async () => {
      const program = createPadrone('test').command('init', (c) =>
        c
          .arguments(
            z.object({
              name: z.string(),
              template: z.enum(['react', 'vue', 'svelte']),
            }),
            { interactive: true },
          )
          .action((args) => args),
      );

      const result = await testCli(program).prompt({ name: 'myapp', template: 'react' }).run('init');

      expect(result.args).toEqual({ name: 'myapp', template: 'react' });
      expect(result.issues).toBeUndefined();
    });
  });

  describe('config files', () => {
    it('should load config via padroneConfig loadConfig option', async () => {
      const program = createPadrone('test').command('serve', (c) =>
        c
          .arguments(z.object({ port: z.number().default(3000) }))
          .extend(padroneConfig({ files: ['app.config.json'], loadConfig: () => ({ port: 8080 }) }))
          .action((args) => `serving on ${args.port}`),
      );

      const result = await testCli(program).run('serve');

      expect(result.result).toBe('serving on 8080');
    });
  });

  describe('subcommand routing', () => {
    it('should route to nested subcommands', async () => {
      const program = createPadrone('test').command('db', (c) =>
        c
          .command('migrate', (s) =>
            s.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `migrated:${args.name}`),
          )
          .command('seed', (s) => s.action(() => 'seeded')),
      );

      const migrate = await testCli(program).run('db migrate v1');
      expect(migrate.result).toBe('migrated:v1');
      expect(migrate.command.name).toBe('migrate');

      const seed = await testCli(program).run('db seed');
      expect(seed.result).toBe('seeded');
    });

    it('should report routing errors for unknown commands', async () => {
      const program = createPadrone('test').command('greet', (c) => c.action(() => 'hi'));

      const result = await testCli(program).run('nonexistent');

      expect(result.error).toBeDefined();
      expect(result.stderr.some((s) => s.includes('nonexistent'))).toBe(true);
    });
  });

  describe('REPL testing', () => {
    it('should run a sequence of REPL inputs', async () => {
      const program = createPadrone('test')
        .command('greet', (c) =>
          c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
        )
        .command('add', (c) => c.arguments(z.object({ a: z.coerce.number(), b: z.coerce.number() })).action((args) => args.a + args.b));

      const { results } = await testCli(program).repl(['greet World', 'add --a=2 --b=3']);

      expect(results).toHaveLength(2);
      expect(results[0]!.result).toBe('Hello, World!');
      expect(results[1]!.result).toBe(5);
    });

    it('should capture REPL errors in stderr', async () => {
      const program = createPadrone('test')
        .command('boom', (c) =>
          c.action(() => {
            throw new Error('kaboom');
          }),
        )
        .command('ok', (c) => c.action(() => 'fine'));

      const { results, stderr } = await testCli(program).repl(['boom', 'ok']);

      expect(stderr.some((s) => s.includes('kaboom'))).toBe(true);
      expect(results.some((r) => r.result === 'fine')).toBe(true);
    });

    it('should handle .exit in REPL', async () => {
      const program = createPadrone('test').command('greet', (c) => c.action(() => 'hi'));

      const { results } = await testCli(program).repl(['greet', '.exit', 'greet']);

      expect(results).toHaveLength(1);
    });
  });

  describe('context', () => {
    const program = createPadrone('test')
      .context<{ user: string }>()
      .command('whoami', (c) => c.action((_args, ctx) => ctx.context.user));

    it('passes the context to run()', async () => {
      const result = await testCli(program).context({ user: 'alice' }).run('whoami');
      expect(result.result).toBe('alice');
    });

    it('passes the context to repl()', async () => {
      const { results } = await testCli(program).context({ user: 'bob' }).repl(['whoami']);
      expect(results[0]!.result).toBe('bob');
    });
  });

  describe('builder reuse', () => {
    it('should allow running multiple commands from the same builder', async () => {
      const program = createPadrone('test').command('greet', (c) =>
        c.arguments(z.object({ name: z.string() }), { positional: ['name'] }).action((args) => `Hello, ${args.name}!`),
      );

      const builder = testCli(program);

      const r1 = await builder.run('greet Alice');
      const r2 = await builder.run('greet Bob');

      expect(r1.result).toBe('Hello, Alice!');
      expect(r2.result).toBe('Hello, Bob!');
    });
  });
});
