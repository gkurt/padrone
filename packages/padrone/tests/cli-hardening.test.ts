import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneConfig, padroneLogger } from 'padrone';
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
  });
});
