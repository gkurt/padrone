import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneConfig, padroneEnv, padroneLogger } from 'padrone';
import * as z from 'zod/v4';

const issuesOf = (result: { argsResult?: { issues?: readonly { path?: readonly unknown[]; message: string }[] } }) =>
  result.argsResult?.issues?.map((i) => `${i.path?.join('.')}: ${i.message}`);

function createProgram() {
  return createPadrone('app')
    .command('build', (c) =>
      c
        .arguments(
          z.object({
            file: z.string().optional(),
            verbose: z.boolean().optional().meta({ flags: 'v' }),
            quiet: z.boolean().optional().meta({ flags: 'q' }),
            num: z.number().optional().meta({ flags: 'n' }),
            out: z.string().optional().meta({ flags: 'o' }),
            name: z.string().optional(),
            title: z.string().optional(),
            offset: z.number().optional(),
            tags: z.string().array().optional(),
            cache: z.union([z.boolean(), z.string()]).optional(),
            noCache: z.boolean().optional(),
            user: z.object({ id: z.number().optional(), admin: z.boolean().optional() }).optional(),
          }),
          { positional: ['file'] },
        )
        .action((args) => args),
    )
    .command('group', (c) =>
      c.command('sub', (s) =>
        s
          .arguments(z.object({ file: z.string().optional(), verbose: z.boolean().optional() }), { positional: ['file'] })
          .action((args) => args),
      ),
    );
}

describe('CLI hardening', () => {
  describe('boolean flags never swallow positionals or commands', () => {
    it('keeps a positional after a long boolean flag', () => {
      expect(createProgram().eval(['build', '--verbose', 'x.txt']).args).toEqual({ verbose: true, file: 'x.txt' });
    });

    it('keeps a positional after a short boolean flag', () => {
      expect(createProgram().eval(['build', '-v', 'x.txt']).args).toEqual({ verbose: true, file: 'x.txt' });
    });

    it('keeps a positional after a stack of boolean flags', () => {
      expect(createProgram().eval(['build', '-vq', 'x.txt']).args).toEqual({ verbose: true, quiet: true, file: 'x.txt' });
    });

    it('routes to a subcommand that follows an unknown-to-parent boolean flag', () => {
      const result = createProgram().eval(['group', '--verbose', 'sub', 'a.txt']);
      expect(result.command?.path).toBe('group sub');
      expect(result.args).toEqual({ verbose: true, file: 'a.txt' });
    });

    it('still accepts an explicit boolean word after a flag', () => {
      expect(createProgram().eval(['build', '--verbose', 'false', 'x.txt']).args).toEqual({ verbose: false, file: 'x.txt' });
    });

    it('uses the default subcommand schema for options typed at the root', () => {
      const program = createPadrone('app').command('', (c) =>
        c
          .arguments(z.object({ file: z.string().optional(), verbose: z.boolean().optional() }), { positional: ['file'] })
          .action((args) => args),
      );
      expect(program.eval(['--verbose', 'x.txt']).args).toEqual({ verbose: true, file: 'x.txt' });
    });

    it('keeps a subcommand after built-in flags like --help', () => {
      const result = createProgram().eval(['--help', 'build']);
      expect(result.command?.name).toBe('build');
    });
  });

  describe('option values', () => {
    it('reads an attached short value (-n5, -ofile)', () => {
      expect(createProgram().eval(['build', '-n5', '-oout.txt']).args).toEqual({ num: 5, out: 'out.txt' });
    });

    it('reads an attached short value after boolean flags in a stack (-vn5)', () => {
      expect(createProgram().eval(['build', '-vn5']).args).toEqual({ verbose: true, num: 5 });
    });

    it('reads -o=value', () => {
      expect(createProgram().eval(['build', '-o=out.txt']).args).toEqual({ out: 'out.txt' });
    });

    it('takes a value starting with a dash for options that require a value', () => {
      expect(createProgram().eval(['build', '--name', '-foo']).args).toEqual({ name: '-foo' });
      expect(createProgram().eval(['build', '-o', '-']).args).toEqual({ out: '-' });
    });

    it('takes negative numbers as values', () => {
      expect(createProgram().eval(['build', '--offset', '-5']).args).toEqual({ offset: -5 });
      expect(createProgram().eval(['build', '-n', '-5']).args).toEqual({ num: -5 });
    });

    it('keeps bracketed text as a string for non-array options', () => {
      expect(createProgram().eval(['build', '--title=[WIP]']).args).toEqual({ title: '[WIP]' });
      expect(createProgram().eval('build --title=[WIP]').args).toEqual({ title: '[WIP]' });
    });

    it('still splits bracket syntax for array options', () => {
      expect(createProgram().eval(['build', '--tags=[a,b]']).args).toEqual({ tags: ['a', 'b'] });
    });

    it('uses the last value when a non-array option is repeated', () => {
      expect(createProgram().eval(['build', '--name', 'a', '--name', 'b']).args).toEqual({ name: 'b' });
    });

    it('accumulates repeated array options', () => {
      expect(createProgram().eval(['build', '--tags', 'a', '--tags', 'b']).args).toEqual({ tags: ['a', 'b'] });
    });

    it('treats an optional-value option as boolean when bare and as a string when given a value', () => {
      expect(createProgram().eval(['build', '--cache']).args).toEqual({ cache: true });
      expect(createProgram().eval(['build', '--cache', 'dir']).args).toEqual({ cache: 'dir' });
      expect(createProgram().eval(['build', '--cache', '--verbose']).args).toEqual({ cache: true, verbose: true });
    });

    it('resolves the arity of nested options', () => {
      expect(createProgram().eval(['build', '--user.admin', 'x.txt', '--user.id', '7']).args).toEqual({
        user: { admin: true, id: 7 },
        file: 'x.txt',
      });
    });

    it('treats a known `no-` option as itself rather than as a negation', () => {
      expect(createProgram().eval(['build', '--no-cache']).args).toEqual({ noCache: true });
    });

    it('reports an option missing its value', () => {
      const result = createProgram().eval(['build', '--name']);
      expect(result.args).toBeUndefined();
      expect(issuesOf(result)).toEqual(['name: Option "--name" requires a value']);
      expect(issuesOf(createProgram().eval(['build', '-o']))).toEqual(['out: Option "-o" requires a value']);
    });

    it('does not take `--` as an option value', () => {
      expect(issuesOf(createProgram().eval(['build', '--name', '--', 'x']))).toEqual(['name: Option "--name" requires a value']);
    });

    it('reports a missing value from parse() too', () => {
      expect(issuesOf(createProgram().parse(['build', '--name']))).toEqual(['name: Option "--name" requires a value']);
    });
  });

  describe('positionals', () => {
    it('keeps a lone dash as a positional', () => {
      expect(createProgram().eval(['build', '-']).args).toEqual({ file: '-' });
    });

    it('does not drop an argv positional that equals the program name', () => {
      const program = createPadrone('greet')
        .arguments(z.object({ name: z.string() }), { positional: ['name'] })
        .action((args) => args);
      expect(program.eval(['greet']).args).toEqual({ name: 'greet' });
      // A string input may still start with the program name
      expect(program.eval('greet greet' as string).args).toEqual({ name: 'greet' });
    });
  });

  describe('prototype safety', () => {
    it('never writes to Object.prototype', () => {
      const result = createProgram().eval(['build', '--__proto__.polluted=1', '--constructor.prototype.polluted2=1']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
      expect(result.args).toBeUndefined();
      expect(issuesOf(result)?.join('\n')).toContain('Unknown option');
    });

    it('reports --constructor as an unknown option', () => {
      expect(issuesOf(createProgram().eval(['build', '--constructor']))?.join('\n')).toContain('Unknown option: "constructor"');
    });
  });

  describe('framework flags declared by extensions', () => {
    it('reads --config as a value and keeps the subcommand', () => {
      let loadedPath: string | undefined;
      const program = createPadrone('app')
        .extend(
          padroneConfig({
            loadConfig: (path) => {
              loadedPath = String(path);
              return { name: 'from-config' };
            },
          }),
        )
        .command('build', (c) => c.arguments(z.object({ name: z.string().optional() })).action((args) => args));
      return Promise.resolve(program.eval(['-c', 'conf.json', 'build'])).then((result) => {
        expect(result.command?.name).toBe('build');
        expect(loadedPath).toContain('conf.json');
      });
    });

    it('treats logger flags as booleans', () => {
      const program = createPadrone('app')
        .extend(padroneLogger())
        .command('build', (c) => c.arguments(z.object({ file: z.string().optional() }), { positional: ['file'] }).action((args) => args));
      expect(program.eval(['build', '--debug', 'x.txt']).args).toEqual({ file: 'x.txt' });
    });

    it('leaves a command its own --verbose even with the logger enabled', () => {
      const program = createPadrone('app')
        .extend(padroneLogger())
        .command('build', (c) => c.arguments(z.object({ verbose: z.boolean().optional() })).action((args) => args));
      expect(program.eval(['build', '--verbose']).args).toEqual({ verbose: true });
    });
  });
});

describe('CLI strictness', () => {
  const positionalProgram = () =>
    createPadrone('app')
      .command('rm', (c) => c.arguments(z.object({ file: z.string() }), { positional: ['file'] }).action((args) => args))
      .command('cp', (c) =>
        c.arguments(z.object({ files: z.string().array(), dest: z.string() }), { positional: ['...files', 'dest'] }).action((args) => args),
      )
      .command('run', (c) => c.arguments(z.object({ verbose: z.boolean().optional() })).action((args) => args))
      .command('calc', (c) => c.arguments(z.object({ n: z.number() })).action((args) => args));

  it('rejects too many positionals instead of joining them', () => {
    const result = positionalProgram().eval(['rm', 'a', 'b']);
    expect(result.args).toBeUndefined();
    expect(issuesOf(result)).toEqual([': Too many arguments: expected at most 1, got 2 (unexpected: b)']);
  });

  it('still lets a variadic positional take everything', () => {
    expect(positionalProgram().eval(['cp', 'a', 'b', 'c', 'dest']).args).toEqual({ files: ['a', 'b', 'c'], dest: 'dest' });
  });

  it('rejects positionals for a command that declares none', () => {
    expect(issuesOf(positionalProgram().eval(['run', './extra']))).toEqual([': Unexpected argument: ./extra']);
    expect(issuesOf(positionalProgram().eval(['run', '--', 'a', 'b']))).toEqual([': Unexpected arguments: a b']);
  });

  it('only coerces decimal numbers', () => {
    expect(positionalProgram().eval(['calc', '--n', '1.5e3']).args).toEqual({ n: 1500 });
    expect(positionalProgram().eval(['calc', '--n', '.5']).args).toEqual({ n: 0.5 });
    for (const bad of ['0x10', 'Infinity', ' 5', '', 'NaN']) {
      expect(positionalProgram().eval(['calc', '--n', bad]).args).toBeUndefined();
    }
  });
});

describe('deprecation warnings', () => {
  const deprecatedProgram = (errors: string[], argv: string[]) =>
    createPadrone('app')
      .runtime({ error: (msg) => errors.push(msg), argv: () => argv })
      .command('build', (c) =>
        c
          .arguments(
            z.object({
              oldFlag: z.boolean().optional(),
              legacy: z.string().optional().meta({ deprecated: true }),
              newFlag: z.boolean().optional(),
            }),
            { fields: { oldFlag: { deprecated: 'Use --new-flag instead' } } },
          )
          .action(() => 'built'),
      )
      .command('old', (c) => c.configure({ deprecated: 'Use "app build"' }).action(() => 'old'));

  it('warns when a deprecated option is used from the CLI', () => {
    const errors: string[] = [];
    const result = deprecatedProgram(errors, ['build', '--old-flag', '--legacy', 'x']).cli();
    expect(result.result).toBe('built');
    expect(errors).toEqual([
      'Warning: option "--old-flag" is deprecated: Use --new-flag instead',
      'Warning: option "--legacy" is deprecated',
    ]);
  });

  it('warns when a deprecated command is used from the CLI', () => {
    const errors: string[] = [];
    deprecatedProgram(errors, ['old']).cli();
    expect(errors).toEqual(['Warning: command "old" is deprecated: Use "app build"']);
  });

  it('does not warn for options that are not used, or for eval()', () => {
    const errors: string[] = [];
    deprecatedProgram(errors, ['build', '--new-flag']).cli();
    deprecatedProgram(errors, []).eval(['build', '--old-flag']);
    expect(errors).toEqual([]);
  });
});

describe('parser fuzzing', () => {
  const pieces = [
    'build',
    'group',
    'sub',
    'help',
    'x.txt',
    '-',
    '--',
    '-v',
    '-q',
    '-n',
    '-n5',
    '-vq',
    '-vn',
    '-o',
    '-oout',
    '--verbose',
    '--no-verbose',
    '--name',
    '--name=',
    '--name=a=b',
    '--tags',
    '--tags=[a,b]',
    '--tags=[',
    '--cache',
    '--user.id',
    '--user.admin',
    '--__proto__.x=1',
    '--constructor',
    '--prototype.y',
    '--no-',
    '---',
    '-=',
    '--=x',
    '-5',
    '-.5',
    '1e3',
    '""',
    "'",
    '[a,b]',
    'true',
    'off',
    '--help',
    '-h',
    '--version',
    '--repl',
    '--color',
    'é',
    ' ',
  ];

  // Deterministic PRNG so failures are reproducible
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  it('never throws or touches prototypes on random argv and string input', () => {
    for (let run = 0; run < 1500; run++) {
      const argv = Array.from({ length: Math.floor(random() * 7) }, () => pieces[Math.floor(random() * pieces.length)]!);
      const program = createProgram();
      const results = [program.parse(argv), program.parse(argv.join(' '))];
      for (const result of results) expect(result).toBeDefined();
      expect(Object.keys(Object.prototype)).toEqual([]);
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    }
  });
});

describe('schema inheritance', () => {
  const rootSchema = z.object({ verbose: z.boolean().optional().meta({ flags: 'v' }), profile: z.string().optional() });

  it('passes the parent schema to a subcommand extending it', () => {
    const program = createPadrone('app')
      .arguments(rootSchema)
      .command('rm', (c) => c.arguments((parent) => parent.extend({ file: z.string() }), { positional: ['file'] }).action((args) => args));
    expect(program.eval(['rm', 'x', '-v']).args).toEqual({ file: 'x', verbose: true });
    expect(program.eval(['-v', 'rm', 'x']).args).toEqual({ file: 'x', verbose: true });
    expect(program.eval(['--profile', 'dev', 'rm', 'x']).args).toEqual({ file: 'x', profile: 'dev' });
  });

  it('uses the final parent schema even when it is defined after the subcommand', () => {
    // Types follow definition order, so the parent schema isn't typed yet here; the runtime still resolves it
    const program = createPadrone('app')
      .command('rm', (c) =>
        c
          .arguments((parent) => (parent as unknown as typeof rootSchema).extend({ file: z.string() }), { positional: ['file'] })
          .action((args) => args),
      )
      .arguments(rootSchema);
    expect(program.eval(['rm', '-v', 'x']).args).toEqual({ file: 'x', verbose: true });
  });
});

describe('env extension', () => {
  const envProgram = (env: Record<string, string>) =>
    createPadrone('app')
      .runtime({ env: () => env })
      .extend(
        padroneEnv(
          z.object({ PORT: z.coerce.number().optional(), HOST: z.string().optional(), TOKEN: z.string() }).transform((e) => ({
            port: e.PORT,
            host: e.HOST,
            token: e.TOKEN,
          })),
        ),
      )
      .command('serve', (c) =>
        c
          .arguments(z.object({ port: z.number().default(3000), host: z.string().default('localhost'), token: z.string().optional() }))
          .action((args) => args),
      );

  it('reports a set but invalid variable instead of silently ignoring all of them', async () => {
    const result = await envProgram({ PORT: 'abc', HOST: 'h.example', TOKEN: 't' }).eval('serve');
    expect(result.args).toBeUndefined();
    expect(issuesOf(result)?.[0]).toStartWith('PORT: Invalid environment variable:');
  });

  it('applies valid variables', async () => {
    const result = await envProgram({ PORT: '8080', HOST: 'h.example', TOKEN: 't' }).eval('serve');
    expect(result.args).toEqual({ port: 8080, host: 'h.example', token: 't' });
  });

  it('leaves a missing required variable to the CLI or defaults', async () => {
    const result = await envProgram({ PORT: '8080' }).eval('serve --token cli');
    expect(result.args).toEqual({ port: 3000, host: 'localhost', token: 'cli' });
  });
});

describe('command options named like built-in flags', () => {
  it('keeps a root --version option for the command', () => {
    const program = createPadrone('rel')
      .configure({ version: '1.0.0' })
      .arguments(z.object({ version: z.string().optional() }))
      .action((args) => args);
    expect(program.eval(['--version', '2.0.0']).args).toEqual({ version: '2.0.0' });
  });

  it('keeps a --color option for the command', () => {
    const program = createPadrone('app').command('paint', (c) => c.arguments(z.object({ color: z.string() })).action((args) => args));
    expect(program.eval(['paint', '--color', 'red']).args).toEqual({ color: 'red' });
  });

  it('still handles the built-in flags when the command has no such option', () => {
    const program = createPadrone('app')
      .configure({ version: '1.0.0' })
      .command('x', (c) => c.action(() => 'x'));
    expect(program.eval(['--version']).result).toBe('1.0.0');
  });
});

describe('padroneEnv vars', () => {
  const varsProgram = (env: Record<string, string>) =>
    createPadrone('app')
      .runtime({ env: () => env })
      .extend(padroneEnv({ vars: { port: 'APP_PORT', token: ['API_TOKEN', 'TOKEN'], tags: 'APP_TAGS' } }))
      .command('serve', (c) =>
        c
          .arguments(
            z.object({
              port: z.number().default(3000).describe('Port'),
              token: z.string().optional(),
              tags: z.string().array().optional(),
            }),
          )
          .action((args) => args),
      );

  it('reads mapped variables, coerced by the command schema', async () => {
    expect((await varsProgram({ APP_PORT: '8080', TOKEN: 't', APP_TAGS: 'x' }).eval('serve')).args).toEqual({
      port: 8080,
      token: 't',
      tags: ['x'],
    });
  });

  it('uses the first variable that is set, and lets the CLI win', async () => {
    const program = varsProgram({ API_TOKEN: 'first', TOKEN: 'second', APP_PORT: '8080' });
    expect((await program.eval('serve --port 9000')).args).toEqual({ port: 9000, token: 'first' });
  });

  it('reports an invalid value through the command schema', async () => {
    const result = await varsProgram({ APP_PORT: 'abc' }).eval('serve');
    expect(result.args).toBeUndefined();
    expect(issuesOf(result)?.[0]).toStartWith('port:');
  });

  it('shows the variables in help', () => {
    const help = varsProgram({}).help('serve', { format: 'text' });
    expect(help).toContain('(env: APP_PORT)');
    expect(help).toContain('(env: API_TOKEN, TOKEN)');
    const info = JSON.parse(varsProgram({}).help('serve', { format: 'json' })) as { arguments: { name: string; env?: unknown }[] };
    expect(info.arguments.find((a) => a.name === 'port')?.env).toBe('APP_PORT');
  });

  it('can be combined with an env schema', async () => {
    const program = createPadrone('app')
      .runtime({ env: () => ({ APP_PORT: '8080', APP_HOST: 'h.example' }) })
      .extend(
        padroneEnv(
          z.object({ APP_HOST: z.string().optional() }).transform((e) => ({ host: e.APP_HOST })),
          { vars: { port: 'APP_PORT' } },
        ),
      )
      .command('serve', (c) => c.arguments(z.object({ port: z.number(), host: z.string() })).action((args) => args));
    expect((await program.eval('serve')).args).toEqual({ port: 8080, host: 'h.example' });
  });
});
