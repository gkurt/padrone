import { afterAll, describe, expect, expectTypeOf, it, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnyPadroneCommand, PadroneCommandNotFound, PadroneEventHandler, PadroneHookContext } from 'padrone';
import { commandNotFound, createPadrone, defineInterceptor, padroneExternalCommands, padronePlugins } from 'padrone';
import * as z from 'zod/v4';
import { spawnCommand } from '../src/util/spawn.ts';

const quiet = { output: () => {}, error: () => {} };

const tempDirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'padrone-lifecycle-'));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** An executable shell script in `dir`. */
const script = (dir: string, name: string, body: string) => {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

/** Compile-time checks only, like tests/type.test.ts. */
test.skip('Types - hooks', () => {
  createPadrone('app')
    .context<{ db: string }>()
    .globalArgs(z.object({ verbose: z.boolean().default(false) }))
    .hook('preAction', (ctx) => {
      expectTypeOf(ctx.args.verbose).toEqualTypeOf<boolean>();
      expectTypeOf(ctx.context.db).toEqualTypeOf<string>();
      expectTypeOf(ctx.command).toEqualTypeOf<AnyPadroneCommand>();
      expectTypeOf(ctx.dryRun).toEqualTypeOf<boolean | undefined>();
      // @ts-expect-error not an arg
      ctx.args.nope;
    })
    .hook('postAction', (ctx, result) => {
      expectTypeOf(result).toBeUnknown();
      expectTypeOf(ctx.args.verbose).toEqualTypeOf<boolean>();
    })
    .command('deploy', (c) =>
      c
        .arguments(z.object({ env: z.enum(['dev', 'prod']) }))
        .hook('preAction', async (ctx) => {
          expectTypeOf(ctx.args.env).toEqualTypeOf<'dev' | 'prod'>();
          expectTypeOf(ctx.args.verbose).toEqualTypeOf<boolean>();
          expectTypeOf(ctx.context.db).toEqualTypeOf<string>();
        })
        .action((args) => args.env),
    );

  expectTypeOf<PadroneHookContext<{ a: number }>['args']>().toEqualTypeOf<{ a: number }>();

  // @ts-expect-error unknown hook name
  createPadrone('app').hook('preRun', () => {});
  // A hook keeps the builder's types
  const program = createPadrone('app')
    .command('x', (c) => c.action(() => 42))
    .hook('preAction', () => {});
  expectTypeOf(program.eval('x').result).toEqualTypeOf<number | undefined>();
});

describe('.hook()', () => {
  const makeProgram = (log: string[]) =>
    createPadrone('app')
      .runtime(quiet)
      .globalArgs(z.object({ verbose: z.boolean().optional() }))
      .hook('preAction', (ctx) => {
        log.push(`root:pre:${ctx.command.name}:${ctx.args.verbose ?? false}`);
      })
      .hook('postAction', (ctx, result) => {
        log.push(`root:post:${ctx.command.name}:${String(result)}`);
      })
      .command('db', (db) =>
        db
          .hook('preAction', () => {
            log.push('db:pre');
          })
          .hook('postAction', () => {
            log.push('db:post');
          })
          .command('migrate', (m) =>
            m.arguments(z.object({ to: z.string().optional() })).action((args) => {
              log.push('action');
              return `migrated ${args.to ?? 'latest'}`;
            }),
          ),
      )
      .command('fail', (c) =>
        c.action(() => {
          log.push('action');
          throw new Error('boom');
        }),
      );

  it('runs ancestors first before the action and last after it', () => {
    const log: string[] = [];
    const result = makeProgram(log).eval('db migrate --to 3 --verbose');
    expect(result.result).toBe('migrated 3');
    expect(log).toEqual(['root:pre:migrate:true', 'db:pre', 'action', 'db:post', 'root:post:migrate:migrated 3']);
  });

  it('stays synchronous with sync hooks and actions', () => {
    const log: string[] = [];
    const result = makeProgram(log).eval('db migrate');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.result).toBe('migrated latest');
  });

  it('skips postAction when the action fails', () => {
    const log: string[] = [];
    const result = makeProgram(log).eval('fail');
    expect(result.error).toBeInstanceOf(Error);
    expect(log).toEqual(['root:pre:fail:false', 'action']);
  });

  it('does not run hooks on sibling commands', () => {
    const log: string[] = [];
    makeProgram(log).eval('fail');
    expect(log).not.toContain('db:pre');
  });

  it('a failing preAction stops the action', () => {
    const log: string[] = [];
    const program = createPadrone('app')
      .runtime(quiet)
      .hook('preAction', () => {
        throw new Error('not logged in');
      })
      .command('deploy', (c) => c.action(() => log.push('action')));
    const result = program.eval('deploy');
    expect((result.error as Error).message).toBe('not logged in');
    expect(log).toEqual([]);
  });

  it('awaits async hooks', async () => {
    const log: string[] = [];
    const program = createPadrone('app')
      .runtime(quiet)
      .hook('preAction', async () => {
        await Promise.resolve();
        log.push('pre');
      })
      .hook('postAction', async (_ctx, result) => {
        await Promise.resolve();
        log.push(`post:${result}`);
      })
      .command('build', (c) =>
        c.action(async () => {
          log.push('action');
          return 'built';
        }),
      );
    const result = await program.eval('build');
    expect(result.result as unknown).toBe('built');
    expect(log).toEqual(['pre', 'action', 'post:built']);
  });

  it('runs for run(), with the given args', () => {
    const seen: unknown[] = [];
    const program = createPadrone('app')
      .runtime(quiet)
      .hook('preAction', (ctx) => {
        seen.push(ctx.caller, ctx.args);
      })
      .command('greet', (c) => c.arguments(z.object({ name: z.string() })).action((args) => `hi ${args.name}`));
    expect(program.run('greet', { name: 'Ada' }).result).toBe('hi Ada');
    expect(seen).toEqual(['run', { name: 'Ada' }]);
  });

  it('runs for dry runs with ctx.dryRun set', () => {
    const seen: unknown[] = [];
    const program = createPadrone('app')
      .runtime(quiet)
      .hook('preAction', (ctx) => {
        seen.push(ctx.dryRun ?? false);
      })
      .command('rm', (c) => c.action(() => 'removed').dryRun(() => 'would remove'));
    expect(program.eval('rm --dry-run').result).toBe('would remove');
    expect(program.eval('rm').result).toBe('removed');
    expect(seen).toEqual([true, false]);
  });

  it('gets the context and can emit events', () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .context<{ user: string }>()
      .hook('preAction', (ctx) => {
        expect(ctx.context.user).toBe('ada');
        expect(typeof ctx.emit).toBe('function');
      })
      .command('whoami', (c) => c.action((_args, ctx) => ctx.context.user));
    expect(program.eval('whoami', { context: { user: 'ada' } }).result).toBe('ada');
  });

  it('is immutable', () => {
    const log: string[] = [];
    const base = createPadrone('app')
      .runtime(quiet)
      .command('x', (c) => c.action(() => 'x'));
    base.hook('preAction', () => {
      log.push('pre');
    });
    base.eval('x');
    expect(log).toEqual([]);
  });
});

describe('commandNotFound', () => {
  const withHandler = (handler: PadroneEventHandler<PadroneCommandNotFound>) =>
    createPadrone('app')
      .runtime(quiet)
      .intercept(defineInterceptor({ name: 'fallback' }, () => ({})).on(commandNotFound, handler))
      .command('deploy', (c) => c.arguments(z.object({ env: z.string().optional() })).action((args) => `deployed ${args.env ?? 'dev'}`))
      .command('db', (db) => db.command('migrate', (m) => m.action(() => 'migrated')));

  it('lets a handler run something in place of the unknown command', async () => {
    const seen: unknown[] = [];
    const program = withHandler((event) => {
      seen.push(event.name, event.args, event.command.name, event.suggestions);
      if (event.name === 'deplo') event.handle((ctx) => `handled by ${ctx.command.path}`);
    });
    const result = await program.eval('deplo --env prod "two words"');
    expect(result.error).toBeUndefined();
    expect(result.result as unknown).toBe('handled by deplo');
    expect(seen).toEqual(['deplo', ['--env', 'prod', 'two words'], 'app', ['deploy']]);
  });

  it('takes argv input as given', async () => {
    const seen: unknown[] = [];
    const program = withHandler((event) => {
      seen.push(event.args);
      event.handle(() => 'ok');
    });
    expect((await program.eval(['plug', 'a b', '--x', '--', '-y'])).result).toBe('ok');
    expect(seen).toEqual([['a b', '--x', '--', '-y']]);
  });

  it('lets a handler reroute the input', async () => {
    const program = withHandler((event) => {
      if (event.name === 'ship') event.reroute(['deploy', ...event.args]);
    });
    expect((await program.eval('ship --env prod')).result as unknown).toBe('deployed prod');
  });

  it('reports the usual routing error when no handler takes it', async () => {
    const program = withHandler(() => {});
    const result = await program.eval('deplyo');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain('Unknown command: deplyo');
    expect((result.error as Error).message).toContain('deploy');
  });

  it('is emitted for unknown subcommands of a command group', async () => {
    const seen: string[] = [];
    const program = withHandler((event) => {
      seen.push(`${event.command.path}/${event.name}`);
      event.handle(() => 'sub');
    });
    expect((await program.eval('db migrat now')).result as unknown).toBe('sub');
    expect(seen).toEqual(['db/migrat']);
  });

  it('stays synchronous without handlers', () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .command('deploy', (c) => c.action(() => 'x'));
    const result = program.eval('nope');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('stops at the first handler that handles it', async () => {
    const calls: string[] = [];
    const program = createPadrone('app')
      .runtime(quiet)
      .intercept(
        defineInterceptor({ name: 'a' }, () => ({})).on(commandNotFound, (event) => {
          calls.push('a');
          event.handle(() => 'a');
        }),
      )
      .intercept(
        defineInterceptor({ name: 'b' }, () => ({})).on(commandNotFound, () => {
          calls.push('b');
        }),
      );
    expect((await program.eval('x')).result as unknown).toBe('a');
    expect(calls).toEqual(['a']);
  });

  it('runs the replacement through execute interceptors but not hooks', async () => {
    const log: string[] = [];
    const program = withHandler((event) => event.handle(() => 'r'))
      .intercept({ name: 'exec' }, () => ({
        execute(_ctx, next) {
          log.push('execute');
          return next();
        },
      }))
      .hook('preAction', () => {
        log.push('hook');
      });
    expect((await program.eval('whatever')).result as unknown).toBe('r');
    expect(log).toEqual(['execute']);
  });

  it('is not emitted for a leaf command with extra arguments', async () => {
    const seen: string[] = [];
    const program = withHandler((event) => {
      seen.push(event.name);
    });
    const result = await program.eval('db migrate extra');
    expect(result.error).toBeInstanceOf(Error);
    expect(seen).toEqual([]);
  });

  it('is not emitted for callers an interceptor leaves out', () => {
    const program = createPadrone('app')
      .runtime(quiet)
      .intercept(
        defineInterceptor({ name: 'local', callers: ['cli'] }, () => ({})).on(commandNotFound, (event) => event.handle(() => 'x')),
      );
    const result = program.eval('nope', { caller: 'serve' });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.error).toBeInstanceOf(Error);
  });
});

describe('padroneExternalCommands()', () => {
  const makeProgram = (path: string[], spawned: unknown[], code = 0, env: Record<string, string> = {}) =>
    createPadrone('app')
      .runtime({ ...quiet, env: () => ({ PATH: path.join(':'), ...env }) })
      .extend(
        padroneExternalCommands({
          spawn: async (file, args) => {
            spawned.push(file, args);
            return code;
          },
        }),
      )
      .command('deploy', (c) => c.action(() => 'deployed'));

  it('runs <program>-<name> from PATH with the words after the name', async () => {
    const empty = tempDir();
    const bin = tempDir();
    const file = script(bin, 'app-hello', 'exit 0');
    const spawned: unknown[] = [];
    const result = await makeProgram([empty, bin], spawned).eval('hello --name "Ada L" -- x');
    expect(result.error).toBeUndefined();
    expect(spawned).toEqual([file, ['--name', 'Ada L', '--', 'x']]);
  });

  it('passes the exit code on, and cli() exits with it', async () => {
    const bin = tempDir();
    script(bin, 'app-fail', 'exit 3');
    const codes: number[] = [];
    const program = makeProgram([bin], [], 3);
    const evaluated = await program.eval('fail');
    expect((evaluated as { exitCode?: number }).exitCode).toBe(3);
    await program.cli({ runtime: { argv: () => ['fail'], setExitCode: (code) => codes.push(code) } });
    expect(codes).toEqual([3]);
  });

  it("passes framework flags after the name on (the external command's own --help)", async () => {
    const bin = tempDir();
    script(bin, 'app-hello', 'exit 0');
    const spawned: unknown[] = [];
    const output: unknown[] = [];
    const program = makeProgram([bin], spawned).runtime({ output: (...args: unknown[]) => output.push(...args) });
    await program.cli({ runtime: { argv: () => ['hello', '--help', '-v'] } });
    expect(spawned[1]).toEqual(['--help', '-v']);
    expect(output).toEqual([]);
  });

  it('keeps built-in commands first, and reports unknown commands as usual', async () => {
    const bin = tempDir();
    script(bin, 'app-deploy', 'exit 0');
    const spawned: unknown[] = [];
    const program = makeProgram([bin], spawned);
    expect((await program.eval('deploy')).result).toBe('deployed');
    const missing = await program.eval('deplyo');
    expect((missing.error as Error).message).toContain('Unknown command: deplyo');
    expect(spawned).toEqual([]);
  });

  it('ignores files that are not executable, and a custom prefix and path', async () => {
    const bin = tempDir();
    writeFileSync(join(bin, 'app-plain'), 'not executable');
    const tool = script(bin, 'tool-x', 'exit 0');
    const spawned: unknown[] = [];
    const program = createPadrone('app')
      .runtime(quiet)
      .extend(
        padroneExternalCommands({
          prefix: 'tool-',
          path: [bin],
          spawn: async (file, args) => {
            spawned.push(file, args);
            return 0;
          },
        }),
      );
    expect((await program.eval('plain')).error).toBeInstanceOf(Error);
    await program.eval('x 1');
    expect(spawned).toEqual([tool, ['1']]);
  });

  it('never runs for remote callers', async () => {
    const bin = tempDir();
    script(bin, 'app-hello', 'exit 0');
    const spawned: unknown[] = [];
    const program = makeProgram([bin], spawned);
    for (const caller of ['serve', 'mcp', 'tool'] as const) {
      const result = await program.eval('hello', { caller });
      expect(result.error).toBeInstanceOf(Error);
    }
    expect(spawned).toEqual([]);
  });

  it('only looks up top-level names', async () => {
    const bin = tempDir();
    script(bin, 'app-db-x', 'exit 0');
    script(bin, 'app-x', 'exit 0');
    const spawned: unknown[] = [];
    const program = makeProgram([bin], spawned).command('db', (db) => db.command('migrate', (m) => m.action(() => 'm')));
    expect((await program.eval('db x')).error).toBeInstanceOf(Error);
    expect(spawned).toEqual([]);
  });

  it('lists the external commands in help and completion', async () => {
    const bin = tempDir();
    script(bin, 'app-hello', 'exit 0');
    script(bin, 'app-deploy', 'exit 0');
    const program = makeProgram([bin], []);
    const help = program.help(undefined, { format: 'text' });
    expect(help).toContain('External Commands');
    expect(help).toContain('Runs app-hello');
    expect(help).not.toContain('Runs app-deploy');
    expect(String((await program.eval('help')).result)).toContain('Runs app-hello');
    // Remote callers can't run them, so their help (and MCP / serve / tool() descriptions) leave them out
    expect(String((await program.eval('help', { caller: 'serve' })).result)).not.toContain('External Commands');
    const { getCompletions } = await import('../src/feature/complete.ts');
    const { getCommand } = await import('../src/core/commands.ts');
    expect(await getCompletions(getCommand(program), ['he'])).toEqual(['hello']);
  });

  it('suggests external commands for a typo', async () => {
    const bin = tempDir();
    script(bin, 'app-hello', 'exit 0');
    const result = await makeProgram([bin], []).eval('helol');
    expect((result.error as Error).message).toContain('"hello"');
  });

  it('can be left out of help', () => {
    const bin = tempDir();
    script(bin, 'app-hello', 'exit 0');
    const program = createPadrone('app')
      .runtime({ ...quiet, env: () => ({ PATH: bin }) })
      .extend(padroneExternalCommands({ list: false }));
    expect(program.help(undefined, { format: 'text' })).not.toContain('hello');
  });

  it.skipIf(process.platform === 'win32')('spawns the executable with the terminal stdio and no shell', async () => {
    const bin = tempDir();
    const out = join(bin, 'out.txt');
    script(bin, 'app-echo', `printf '%s|' "$@" > "$OUT"\nexit 2`);
    const program = createPadrone('app')
      .runtime({ ...quiet, env: () => ({ PATH: bin, OUT: out }) })
      .extend(padroneExternalCommands());
    const result = await program.eval(['echo', 'a b', '$HOME', ';', '*']);
    expect((result as { exitCode?: number }).exitCode).toBe(2);
    expect(readFileSync(out, 'utf-8')).toBe('a b|$HOME|;|*|');
  });
});

describe('spawnCommand()', () => {
  it('spawns executables directly', () => {
    expect(spawnCommand('/bin/app-x', ['a b', '&'], 'linux')).toEqual(['/bin/app-x', ['a b', '&'], false]);
    expect(spawnCommand('C:\\bin\\app-x.exe', ['a b'], 'win32')).toEqual(['C:\\bin\\app-x.exe', ['a b'], false]);
  });

  it('runs Windows batch files under cmd.exe with escaped arguments', () => {
    const [command, args, verbatim] = spawnCommand('C:\\bin\\app-x.cmd', ['a b', 'x&calc', 'say "hi"'], 'win32', 'C:\\cmd.exe');
    expect(command).toBe('C:\\cmd.exe');
    expect(verbatim).toBe(true);
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toBe('"C:\\bin\\app-x.cmd ^^^"a^^^ b^^^" ^^^"x^^^&calc^^^" ^^^"say^^^ \\^^^"hi\\^^^"^^^""');
  });

  it('refuses a line break in an argument for a batch file, which cmd.exe would run as a new command', () => {
    expect(() => spawnCommand('C:\\bin\\app-x.cmd', ['a\r\ncalc'], 'win32')).toThrow('line break');
    expect(spawnCommand('/bin/app-x', ['a\nb'], 'linux')[1]).toEqual(['a\nb']);
  });
});

describe('padronePlugins()', () => {
  /** A plugin module file exporting an extension that adds `command`. */
  const pluginFile = (dir: string, name: string, command: string) => {
    const file = join(dir, name);
    writeFileSync(file, `export default (program) => program.command('${command}', (c) => c.action(() => '${command} from plugin'));\n`);
    return file;
  };
  const manifest = (dir: string, plugins: unknown[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify({ plugins }));
  };
  const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'plugins.json'), 'utf-8')).plugins;
  const makeProgram = (options: Parameters<typeof padronePlugins>[0], runtime: object = quiet) =>
    createPadrone('app')
      .runtime(runtime)
      .extend(padronePlugins(options))
      .command('own', (c) => c.action(() => 'own'));

  it('stays synchronous without plugins', () => {
    const dir = tempDir();
    const result = makeProgram({ dir }).eval('own');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.result).toBe('own');
  });

  it('loads linked plugins from plugins.json before routing', async () => {
    const dir = tempDir();
    const src = tempDir();
    manifest(dir, [{ name: 'hello', link: pluginFile(src, 'hello.mjs', 'hello') }]);
    const program = makeProgram({ dir });
    expect((await program.eval('hello')).result as unknown).toBe('hello from plugin');
    expect((await program.eval('own')).result).toBe('own');
    const help = (await program.eval('help')).result as unknown as string;
    expect(help).toContain('hello');
  });

  it('works with cli(), --help and shell completion', async () => {
    const dir = tempDir();
    const src = tempDir();
    manifest(dir, [{ name: 'hello', link: pluginFile(src, 'hello.mjs', 'hello') }]);
    const output: unknown[] = [];
    const program = makeProgram({ dir }, { output: (...args: unknown[]) => output.push(...args), error: () => {} });
    await program.cli({ runtime: { argv: () => ['hello'] } });
    expect(output).toEqual(['hello from plugin']);
    output.length = 0;
    await program.cli({ runtime: { argv: () => ['--help'], format: 'text' } });
    expect(String(output[0])).toContain('hello');
    output.length = 0;
    const { padroneCompletion } = await import('padrone/completion');
    await program.extend(padroneCompletion()).cli({ runtime: { argv: () => ['__complete', 'hel'] } });
    expect(output).toEqual(['hello']);
  });

  it("runs a plugin's own interceptors, error and shutdown phases included", async () => {
    const log: string[] = [];
    const program = makeProgram({
      dir: tempDir(),
      packages: ['audit'],
      import: async () => ({
        default: (p: ReturnType<typeof createPadrone>) =>
          p.intercept({ name: 'audit' }, () => ({
            execute(ctx, next) {
              log.push(`execute ${ctx.command.name}`);
              return next();
            },
            shutdown(ctx, next) {
              log.push(`shutdown ${ctx.command.name}`);
              return next();
            },
          })),
      }),
    });
    await program.eval('own');
    expect(log).toEqual(['execute own', 'shutdown own']);
  });

  it('loads a package directory through its package.json entry', async () => {
    const dir = tempDir();
    const pkg = join(dir, 'node_modules', '@acme', 'tools');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@acme/tools', version: '1.2.3', exports: { '.': { import: './dist/index.mjs' } } }),
    );
    pluginFile(join(pkg, 'dist'), 'index.mjs', 'tools');
    manifest(dir, [{ name: '@acme/tools', spec: '@acme/tools@1' }]);
    expect((await makeProgram({ dir }).eval('tools')).result as unknown).toBe('tools from plugin');
  });

  it('mounts a plugin that exports a program, and loads `packages` with `import`', async () => {
    const dir = tempDir();
    const imported: string[] = [];
    const program = makeProgram({
      dir,
      packages: ['greeter'],
      import: async (specifier) => {
        imported.push(specifier);
        return { default: createPadrone('greet').action(() => 'hi from greeter') };
      },
    });
    expect((await program.eval('greet')).result as unknown).toBe('hi from greeter');
    expect(imported).toEqual(['greeter']);
  });

  it('reports a plugin that fails to load and runs without it', async () => {
    const dir = tempDir();
    const src = tempDir();
    const broken = join(src, 'broken.mjs');
    writeFileSync(broken, 'export default 42;\n');
    manifest(dir, [
      { name: 'broken', link: broken },
      { name: 'hello', link: pluginFile(src, 'hello.mjs', 'hello') },
    ]);
    const errors: string[] = [];
    const program = makeProgram({ dir }, { output: () => {}, error: (text: string) => errors.push(text) });
    expect((await program.eval('hello')).result as unknown).toBe('hello from plugin');
    expect(errors).toEqual(['Plugin "broken" failed to load: "broken" doesn\'t export a padrone extension or program']);
  });

  describe('plugins command', () => {
    it('links, lists and unlinks a local plugin', async () => {
      const dir = tempDir();
      const src = tempDir();
      const pkgDir = join(src, 'my-plugin');
      mkdirSync(pkgDir);
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'my-plugin', version: '0.1.0', main: 'main.mjs' }));
      pluginFile(pkgDir, 'main.mjs', 'mine');
      const program = makeProgram({ dir, command: true });

      expect((await program.eval(`plugins link ${pkgDir}`)).result as unknown).toBe(`Linked plugin my-plugin → ${pkgDir}`);
      expect(readManifest(dir)).toEqual([{ name: 'my-plugin', link: pkgDir }]);
      expect((await program.eval('mine')).result as unknown).toBe('mine from plugin');
      expect((await program.eval('plugins list')).result as unknown).toBe(`my-plugin  0.1.0 (link: ${pkgDir})`);
      expect((await program.eval('plugins uninstall my-plugin')).result as unknown).toBe('Unlinked plugin my-plugin');
      expect(readManifest(dir)).toEqual([]);
      expect((await program.eval('mine')).error).toBeInstanceOf(Error);
    });

    it('installs and uninstalls with the package manager, without running it for real', async () => {
      const dir = tempDir();
      const commands: { command: readonly string[]; cwd: string }[] = [];
      const exec = async (command: readonly string[], { cwd }: { cwd: string }) => {
        commands.push({ command, cwd });
        const pkgFile = join(cwd, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'));
        if (command[1] === 'install') {
          const target = join(cwd, 'node_modules', 'deployer');
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'deployer', version: '2.0.0', main: 'index.mjs' }));
          pluginFile(target, 'index.mjs', 'ship');
          pkg.dependencies = { ...pkg.dependencies, deployer: '^2.0.0' };
        } else {
          delete pkg.dependencies?.deployer;
        }
        writeFileSync(pkgFile, JSON.stringify(pkg));
        return 0;
      };
      const program = makeProgram({ dir, command: true, packageManager: 'npm', exec });

      expect((await program.eval('plugins install deployer@2')).result as unknown).toBe('Installed plugin deployer@2.0.0');
      expect(commands).toEqual([{ command: ['npm', 'install', 'deployer@2'], cwd: dir }]);
      expect(readManifest(dir)).toEqual([{ name: 'deployer', spec: 'deployer@2' }]);
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).private).toBe(true);
      expect((await program.eval('ship')).result as unknown).toBe('ship from plugin');

      expect((await program.eval('plugins uninstall deployer')).result as unknown).toBe('Uninstalled plugin deployer');
      expect(commands.at(-1)).toEqual({ command: ['npm', 'uninstall', 'deployer'], cwd: dir });
      expect(readManifest(dir)).toEqual([]);
    });

    it('installs with --ignore-scripts when asked', async () => {
      const dir = tempDir();
      const commands: (readonly string[])[] = [];
      const program = makeProgram({
        dir,
        command: true,
        packageManager: 'npm',
        ignoreScripts: true,
        exec: async (command) => {
          commands.push(command);
          return 1;
        },
      });
      await program.eval('plugins install deployer');
      expect(commands[0]).toEqual(['npm', 'install', '--ignore-scripts', 'deployer']);
    });

    it('ignores manifest entries whose names could escape node_modules or look like options', async () => {
      const dir = tempDir();
      manifest(dir, [
        { name: '../../evil', spec: 'x' },
        { name: '-g', spec: 'x' },
      ]);
      const errors: string[] = [];
      const program = makeProgram({ dir, command: true }, { output: () => {}, error: (m: string) => errors.push(m) });
      expect((await program.eval('plugins list')).result as unknown).toBe('No plugins installed');
      expect(errors).toEqual([]);
    });

    it('writes the manifest privately', async () => {
      const dir = tempDir();
      const src = tempDir();
      const program = makeProgram({ dir, command: true });
      await program.eval(`plugins link ${pluginFile(src, 'p.mjs', 'p')}`);
      if (process.platform !== 'win32') expect(statSync(join(dir, 'plugins.json')).mode & 0o077).toBe(0);
    });

    it('uses the chosen package manager', async () => {
      const dir = tempDir();
      const commands: (readonly string[])[] = [];
      const program = makeProgram({
        dir,
        command: true,
        packageManager: 'pnpm',
        exec: async (command) => {
          commands.push(command);
          return 1;
        },
      });
      const result = await program.eval('plugins install x');
      expect((result.error as Error).message).toBe('"pnpm add x" failed with exit code 1');
      expect(commands).toEqual([['pnpm', 'add', 'x']]);
    });

    it('removes a package that is not a plugin again', async () => {
      const dir = tempDir();
      const commands: (readonly string[])[] = [];
      const exec = async (command: readonly string[], { cwd }: { cwd: string }) => {
        commands.push(command);
        if (command[1] === 'add') {
          const target = join(cwd, 'node_modules', 'lodash');
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'lodash', main: 'index.mjs' }));
          writeFileSync(join(target, 'index.mjs'), 'export default { chunk() {} };\n');
        }
        return 0;
      };
      const program = makeProgram({ dir, command: true, packageManager: 'bun', exec });
      const result = await program.eval('plugins install lodash');
      expect((result.error as Error).message).toContain(`"lodash" isn't a plugin`);
      expect(commands).toEqual([
        ['bun', 'add', 'lodash'],
        ['bun', 'remove', 'lodash'],
      ]);
    });

    it('rejects a package spec that looks like an option', async () => {
      const commands: unknown[] = [];
      const program = makeProgram({
        dir: tempDir(),
        command: true,
        exec: async (command) => {
          commands.push(command);
          return 0;
        },
      });
      const result = await program.eval(['plugins', 'install', '--', '--global']);
      expect((result.error as Error).message).toBe('Invalid package "--global"');
      expect(commands).toEqual([]);
    });

    it('lists nothing when no plugins are installed', async () => {
      expect((await makeProgram({ dir: tempDir(), command: true }).eval('plugins list')).result as unknown).toBe('No plugins installed');
    });

    it('is only available on the command line', async () => {
      const program = makeProgram({ dir: tempDir(), command: true });
      const result = await program.eval('plugins list', { caller: 'serve' });
      expect((result.error as Error).message).toContain('only available on the command line');
    });
  });
});
