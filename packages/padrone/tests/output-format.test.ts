import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneFormat, padroneJson } from 'padrone';
import * as z from 'zod/v4';

const capture = () => {
  const output: unknown[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: { output: (...args: unknown[]) => output.push(...args), error: (text: string) => errors.push(text), setExitCode: () => {} },
  };
};

const users = [
  { id: 2, name: 'Bob', email: 'bob@example.com', admin: false },
  { id: 1, name: 'Alice, A.', email: 'alice@example.com', admin: true },
  { id: 3, name: 'Carol "C"', email: null, admin: false },
];

const withCommands = <T extends ReturnType<typeof createPadrone>>(program: T) =>
  program
    .command('users', (c) => c.action(() => users))
    .command('user', (c) =>
      c.arguments(z.object({ id: z.coerce.number() }), { positional: ['id'] }).action((args) => users.find((u) => u.id === args.id)),
    )
    .command('greet', (c) => c.action(() => 'hello'))
    .command('stream', (c) =>
      c.action(function* () {
        yield* users;
      }),
    )
    .command('fail', (c) =>
      c.action(() => {
        throw new Error('boom');
      }),
    );

describe('padroneJson({ fields })', () => {
  const program = withCommands(createPadrone('app').extend(padroneJson({ fields: true })));

  it('prints only the selected fields of an object, each array item and each streamed item', () => {
    const { output, runtime } = capture();
    program.eval('user 1 --json=name,id', { runtime });
    program.eval('users --json=id', { runtime });
    program.eval('stream --json=name', { runtime });
    expect(output).toEqual([
      JSON.stringify({ name: 'Alice, A.', id: 1 }, null, 2),
      JSON.stringify([{ id: 2 }, { id: 1 }, { id: 3 }], null, 2),
      '{"name":"Bob"}',
      '{"name":"Alice, A."}',
      '{"name":"Carol \\"C\\""}',
    ]);
  });

  it('keeps the whole result for a bare --json, and returns the full result', () => {
    const { output, runtime } = capture();
    const res = program.eval('user 2 --json', { runtime });
    expect(output).toEqual([JSON.stringify(users[0], null, 2)]);
    expect(program.eval('user 2 --json=id', { runtime: capture().runtime }).result).toEqual(users[0]);
    expect(res.result).toEqual(users[0]);
  });

  it('never takes a following positional as the field list', () => {
    const { output, runtime } = capture();
    program.eval('user --json 3', { runtime });
    expect(JSON.parse(output[0] as string)).toEqual(users[2]);
  });

  it('applies --jq and --template after field selection', () => {
    const { output, runtime } = capture();
    program.eval(['users', '--json=name,id', '--jq', '.[0] | keys | join(",")'], { runtime });
    program.eval(['users', '--json=name', '--template', '{{.name}}/{{.id}}'], { runtime });
    expect(output).toEqual(['id,name', 'Bob/', 'Alice, A./', 'Carol "C"/']);
  });

  it('fails on a field the result does not have, as JSON', () => {
    const { output, runtime } = capture();
    program.cli({ runtime: { ...runtime, argv: () => ['users', '--json=nope'] } });
    const { error } = JSON.parse(output[0] as string);
    expect(error.message).toBe('Unknown JSON field: "nope". Available fields: id, name, email, admin');
  });

  it('leaves results that are not objects as they are', () => {
    const { output, runtime } = capture();
    program.eval('greet --json=a', { runtime });
    expect(output).toEqual(['"hello"']);
  });
});

describe("padroneJson({ fields: 'required' })", () => {
  const program = withCommands(createPadrone('app').extend(padroneJson({ fields: 'required' })));

  it('takes the field list as the next argument', () => {
    const { output, runtime } = capture();
    program.eval('users --json id,name', { runtime });
    expect(JSON.parse(output[0] as string)).toEqual(users.map(({ id, name }) => ({ id, name })));
  });

  it('lists the fields of the result for a bare --json', () => {
    const { output, errors, runtime } = capture();
    program.cli({ runtime: { ...runtime, argv: () => ['users', '--json'] } });
    expect(output).toEqual([]);
    expect(errors.join('\n')).toContain('Specify one or more comma-separated fields for `--json`: id, name, email, admin');
  });

  it('checks declared fields before the command runs', () => {
    let ran = false;
    const declared = createPadrone('app')
      .extend(padroneJson({ fields: 'required', availableFields: (command) => (command.name === 'repo' ? ['name', 'url'] : undefined) }))
      .command('repo', (c) =>
        c.action(() => {
          ran = true;
          return { name: 'padrone', url: 'https://example.com', stars: 1 };
        }),
      );

    const bare = capture();
    declared.cli({ runtime: { ...bare.runtime, argv: () => ['repo', '--json'] } });
    expect(bare.errors.join('\n')).toContain('Specify one or more comma-separated fields for `--json`: name, url');

    const unknown = capture();
    declared.cli({ runtime: { ...unknown.runtime, argv: () => ['repo', '--json', 'stars'] } });
    expect(JSON.parse(unknown.output[0] as string).error.message).toBe('Unknown JSON field: "stars". Available fields: name, url');
    expect(ran).toBe(false);

    const ok = capture();
    declared.eval('repo --json url', { runtime: ok.runtime });
    expect(JSON.parse(ok.output[0] as string)).toEqual({ url: 'https://example.com' });
  });
});

describe('padroneFormat', () => {
  const program = withCommands(createPadrone('app').extend(padroneFormat({ tableFlags: true })));
  const run = (input: string | string[]) => {
    const { output, runtime } = capture();
    program.eval(input, { runtime });
    return output;
  };

  it('prints text by default', () => {
    expect(run('greet')).toEqual(['hello']);
    expect(run('users')).toEqual([users]);
  });

  it('prints JSON with -o json', () => {
    expect(run('users -o json')).toEqual([JSON.stringify(users, null, 2)]);
    expect(run('stream --output=json')).toEqual(users.map((u) => JSON.stringify(u)));
  });

  it('prints YAML', () => {
    expect(run('user 1 -o yaml')).toEqual(['id: 1\nname: Alice, A.\nemail: alice@example.com\nadmin: true']);
    const docs = run('stream -o yaml') as string[];
    expect(docs).toHaveLength(3);
    expect(docs[0]).toBe('---\nid: 2\nname: Bob\nemail: bob@example.com\nadmin: false');
    expect(Bun.YAML.parse(run('users -o yaml')[0] as string)).toEqual(users);
  });

  it('prints CSV with RFC 4180 quoting, and TSV', () => {
    expect(run('users -o csv')).toEqual([
      'id,name,email,admin\n2,Bob,bob@example.com,false\n1,"Alice, A.",alice@example.com,true\n3,"Carol ""C""",,false',
    ]);
    expect(run('user 2 -o tsv')).toEqual(['id\tname\temail\tadmin\n2\tBob\tbob@example.com\tfalse']);
  });

  it('prints streamed items one row each, the header with the first', () => {
    expect(run('stream -o csv --columns id')).toEqual(['id', '2', '1', '3']);
  });

  it('selects columns, sorts and drops the header', () => {
    expect(run('users -o csv --columns name,id --sort id')).toEqual(['name,id\n"Alice, A.",1\nBob,2\n"Carol ""C""",3']);
    expect(run(['users', '-o', 'csv', '--columns', 'id', '--sort', '-id', '--no-header'])).toEqual(['3\n2\n1']);
    expect(run('stream -o tsv --columns id --sort id')).toEqual(['id\n1\n2\n3']);
  });

  it('renders a table', () => {
    const [table] = run('users -o table --columns id,name --sort name --no-header') as string[];
    expect(table!.split('\n')).toEqual([' 1 │ Alice, A. ', ' 2 │ Bob       ', ' 3 │ Carol "C" ']);
    const [streamed] = run('stream -o table --columns id') as string[];
    expect(streamed!.split('\n')[0]).toContain('id');
  });

  it('prints results that are not objects as text', () => {
    expect(run('greet -o csv')).toEqual(['hello']);
  });

  it('rejects unknown formats and columns', () => {
    const format = capture();
    program.cli({ runtime: { ...format.runtime, argv: () => ['users', '-o', 'xml'] } });
    expect(format.errors.join('\n')).toContain('Invalid output format "xml". Expected one of: text, json, yaml, csv, tsv, table');

    const column = capture();
    program.cli({ runtime: { ...column.runtime, argv: () => ['users', '-o', 'csv', '--sort', 'nope'] } });
    expect(column.errors.join('\n')).toContain('Unknown column: "nope". Available columns: id, name, email, admin');
  });

  it('prints errors as JSON under -o json, including routing errors', () => {
    const failed = capture();
    program.cli({ runtime: { ...failed.runtime, argv: () => ['fail', '-o', 'json'] } });
    expect(failed.errors).toEqual([]);
    expect(JSON.parse(failed.output[0] as string)).toEqual({ error: { name: 'Error', message: 'boom' } });

    const routing = capture();
    program.cli({ runtime: { ...routing.runtime, argv: () => ['nope', '--output=json'] } });
    expect(JSON.parse(routing.output[0] as string).error.name).toBe('RoutingError');
  });

  it('restricts formats and sets the default', () => {
    const limited = withCommands(
      createPadrone('app').extend(padroneFormat({ formats: ['text', 'csv'], default: 'csv', flags: ['format', 'F'] })),
    );
    const { output, errors, runtime } = capture();
    limited.eval('user 1', { runtime });
    limited.eval('user 1 -F text', { runtime });
    expect(output).toEqual(['id,name,email,admin\n1,"Alice, A.",alice@example.com,true', users[1]]);
    limited.cli({ runtime: { ...runtime, argv: () => ['users', '--format', 'yaml'] } });
    expect(errors.join('\n')).toContain('Expected one of: text, csv');
  });

  it('works when applied to a single command', () => {
    const scoped = createPadrone('app').command('info', (c) => c.extend(padroneFormat()).action(() => ({ ok: true })));
    const { output, runtime } = capture();
    scoped.eval('info -o yaml', { runtime });
    expect(output).toEqual(['ok: true']);
  });

  it("leaves a command's own --output option alone", () => {
    const own = createPadrone('app')
      .extend(padroneFormat())
      .command('build', (c) =>
        c.arguments(z.object({ output: z.string() }), { fields: { output: { flags: 'o' } } }).action((args) => args),
      );
    const { output, runtime } = capture();
    own.eval('build -o dist', { runtime });
    expect(output).toEqual([{ output: 'dist' }]);
  });

  it('does not affect remote callers', async () => {
    const tool = program.tool();
    const result = await (tool as any).execute({ command: 'users -o csv' }, { toolCallId: '1', messages: [] });
    expect(JSON.stringify(result)).toContain('Alice');
  });

  it('lists --output in help', () => {
    const help = program.help(undefined, { all: true, format: 'text' });
    expect(help).toContain('--output, -o <format>');
    expect(help).toContain('--no-header');
  });
});

describe('padroneFormat with padroneJson', () => {
  const program = withCommands(
    createPadrone('app')
      .extend(padroneJson({ fields: true }))
      .extend(padroneFormat()),
  );

  it('treats -o json like --json, and lets --json and --jq take precedence', () => {
    const run = (input: string) => {
      const { output, runtime } = capture();
      program.eval(input, { runtime });
      return output;
    };
    expect(run('users -o json')).toEqual(run('users --json'));
    expect(run('user 1 -o csv --json=id')).toEqual([JSON.stringify({ id: 1 }, null, 2)]);
    expect(run(`users -o yaml --jq .[0].id`)).toEqual(['2']);
    expect(run('users -o json --json=id')).toEqual([JSON.stringify([{ id: 2 }, { id: 1 }, { id: 3 }], null, 2)]);
  });
});
