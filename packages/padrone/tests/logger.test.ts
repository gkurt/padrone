import { describe, expect, it } from 'bun:test';
import { createPadrone, padroneLogger } from 'padrone';

function createCapture() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    runtime: {
      output: (...args: unknown[]) => output.push(args.map(String).join(' ')),
      error: (text: string) => errors.push(text),
    },
  };
}

describe('logger', () => {
  it('should inject logger into context', () => {
    const { runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger())
      .command('test', (c) =>
        c.action((_args, ctx) => {
          expect(ctx.context.logger).toBeDefined();
          expect(typeof ctx.context.logger.info).toBe('function');
          expect(typeof ctx.context.logger.debug).toBe('function');
          expect(typeof ctx.context.logger.warn).toBe('function');
          expect(typeof ctx.context.logger.error).toBe('function');
          expect(typeof ctx.context.logger.child).toBe('function');
          return 'ok';
        }),
      );

    const result = program.eval('test');
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('ok');
  });

  it('should respect default log level (info)', () => {
    const { output, errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger())
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.debug('hidden');
          ctx.context.logger.info('visible');
          ctx.context.logger.warn('also visible');
          ctx.context.logger.error('error visible');
        }),
      );

    program.eval('test');
    expect(output).toEqual([]);
    expect(errors).toEqual(['[INFO] visible', '[WARN] also visible', '[ERROR] error visible']);
  });

  it('should show debug messages when level is debug', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'debug' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.debug('debug msg');
          ctx.context.logger.info('info msg');
        }),
      );

    program.eval('test');
    expect(errors).toEqual(['[DEBUG] debug msg', '[INFO] info msg']);
  });

  it('should suppress all messages when level is silent', () => {
    const { output, errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'silent' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.debug('nope');
          ctx.context.logger.info('nope');
          ctx.context.logger.warn('nope');
          ctx.context.logger.error('nope');
        }),
      );

    program.eval('test');
    expect(output).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('should only show error when level is error', () => {
    const { output, errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'error' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.info('hidden');
          ctx.context.logger.warn('hidden');
          ctx.context.logger.error('shown');
        }),
      );

    program.eval('test');
    expect(output).toEqual([]);
    expect(errors).toEqual(['[ERROR] shown']);
  });

  it('should support prefix', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'info', prefix: '[my-app]' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.info('hello');
        }),
      );

    program.eval('test');
    expect(errors).toEqual(['[INFO] [my-app] hello']);
  });

  it('should support timestamps', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'info', timestamps: true }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.info('hello');
        }),
      );

    program.eval('test');
    expect(errors).toHaveLength(1);
    // Should contain an ISO timestamp
    expect(errors[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] hello$/);
  });

  it('should support child loggers with labels', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'debug' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          const db = ctx.context.logger.child('db');
          db.debug('connecting');
          db.info('connected');
          db.warn('slow query');
          db.error('connection lost');
        }),
      );

    program.eval('test');
    expect(errors).toEqual(['[DEBUG] [db] connecting', '[INFO] [db] connected', '[WARN] [db] slow query', '[ERROR] [db] connection lost']);
  });

  it('should support nested child loggers', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'info' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          const db = ctx.context.logger.child('db');
          const pool = db.child('pool');
          pool.info('acquired connection');
        }),
      );

    program.eval('test');
    expect(errors).toEqual(['[INFO] [db] [pool] acquired connection']);
  });

  it('should serialize non-string arguments as JSON', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'info' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.info('data:', { key: 'value' });
        }),
      );

    program.eval('test');
    expect(errors).toEqual(['[INFO] data: {"key":"value"}']);
  });

  it('should expose the current log level', () => {
    const { runtime } = createCapture();
    let capturedLevel: string | undefined;
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'warn' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          capturedLevel = ctx.context.logger.level;
        }),
      );

    program.eval('test');
    expect(capturedLevel).toBe('warn');
  });

  it('should preserve child logger level from parent', () => {
    const { runtime } = createCapture();
    let capturedLevel: string | undefined;
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'error' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          const child = ctx.context.logger.child('sub');
          capturedLevel = child.level;
        }),
      );

    program.eval('test');
    expect(capturedLevel).toBe('error');
  });

  it('should show trace messages when level is trace', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'trace' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.trace('trace msg');
          ctx.context.logger.debug('debug msg');
          ctx.context.logger.info('info msg');
        }),
      );

    program.eval('test');
    expect(errors).toEqual(['[TRACE] trace msg', '[DEBUG] debug msg', '[INFO] info msg']);
  });

  it('should hide trace messages at debug level', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .extend(padroneLogger({ level: 'debug' }))
      .command('test', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.trace('hidden');
          ctx.context.logger.debug('shown');
        }),
      );

    program.eval('test');
    expect(errors).toEqual(['[DEBUG] shown']);
  });

  describe('context-based config', () => {
    it('should read log level from context', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .context<{ loggerConfig: { level: 'debug' } }>()
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.debug('debug msg');
            ctx.context.logger.info('info msg');
          }),
        );

      program.eval('test', { context: { loggerConfig: { level: 'debug' } } });
      expect(errors).toEqual(['[DEBUG] debug msg', '[INFO] info msg']);
    });

    it('should let constructor config override context config', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .context<{ loggerConfig: { level: 'debug' } }>()
        .extend(padroneLogger({ level: 'warn' }))
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.debug('hidden');
            ctx.context.logger.info('hidden');
            ctx.context.logger.warn('shown');
          }),
        );

      program.eval('test', { context: { loggerConfig: { level: 'debug' } } });
      expect(errors).toEqual(['[WARN] shown']);
    });

    it('should read timestamps from context', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .context<{ loggerConfig: { timestamps: boolean } }>()
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('hello');
          }),
        );

      program.eval('test', { context: { loggerConfig: { timestamps: true } } });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*\[INFO\] hello$/);
    });

    it('should let CLI flags override context config', () => {
      const { output, errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .context<{ loggerConfig: { level: 'debug' } }>()
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.debug('nope');
            ctx.context.logger.error('nope');
          }),
        );

      program.eval('test --silent', { context: { loggerConfig: { level: 'debug' } } });
      expect(output).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  describe('format specifiers', () => {
    it('should substitute %s with string value', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('hello %s', 'world');
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] hello world']);
    });

    it('should substitute %d and %i with truncated integers', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('count: %d, index: %i', 3.7, 2.1);
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] count: 3, index: 2']);
    });

    it('should substitute %f with float value', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('value: %f', 3.14);
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] value: 3.14']);
    });

    it('should substitute %j with JSON', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('data: %j', { a: 1 });
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] data: {"a":1}']);
    });

    it('should substitute %o and %O with object representation', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('%o %O', { x: 1 }, [2]);
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] {"x":1} [2]']);
    });

    it('should escape %% as literal percent', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('100%% complete');
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] 100% complete']);
    });

    it('should append extra args after specifiers are consumed', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('hello %s', 'world', 'extra', 42);
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] hello world extra 42']);
    });

    it('should leave unconsumed specifiers as-is when args are exhausted', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('%s and %s', 'one');
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] one and %s']);
    });

    it('should not interpret specifiers when first arg is not a string', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info(42, '%s', 'hello');
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] 42 %s hello']);
    });

    it('should work with multiple mixed specifiers', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('user %s has %d items worth %f total', 'alice', 3, 29.99);
          }),
        );

      program.eval('test');
      expect(errors).toEqual(['[INFO] user alice has 3 items worth 29.99 total']);
    });
  });

  describe('CLI flag overrides', () => {
    it('should set trace level with --trace', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.trace('trace msg');
            ctx.context.logger.debug('debug msg');
          }),
        );

      program.eval('test --trace');
      expect(errors).toEqual(['[TRACE] trace msg', '[DEBUG] debug msg']);
    });

    it('should set debug level with --verbose', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.debug('debug msg');
          }),
        );

      program.eval('test --verbose');
      expect(errors).toEqual(['[DEBUG] debug msg']);
    });

    it('should set debug level with --debug', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.debug('seen');
          }),
        );

      program.eval('test --debug');
      expect(errors).toEqual(['[DEBUG] seen']);
    });

    it('should set silent level with --silent', () => {
      const { output, errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger({ level: 'debug' }))
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.debug('nope');
            ctx.context.logger.error('nope');
          }),
        );

      program.eval('test --silent');
      expect(output).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('should set silent level with --quiet', () => {
      const { output, errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('nope');
            ctx.context.logger.error('nope');
          }),
        );

      program.eval('test --quiet');
      expect(output).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('should set explicit level with --log-level=warn', () => {
      const { output, errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.info('hidden');
            ctx.context.logger.warn('shown');
            ctx.context.logger.error('shown');
          }),
        );

      program.eval('test --log-level=warn');
      expect(output).toEqual([]);
      expect(errors).toEqual(['[WARN] shown', '[ERROR] shown']);
    });

    it('should override config level with CLI flag', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger({ level: 'error' }))
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.debug('seen via --verbose');
          }),
        );

      program.eval('test --verbose');
      expect(errors).toEqual(['[DEBUG] seen via --verbose']);
    });

    it('should reflect CLI-overridden level in logger.level', () => {
      const { runtime } = createCapture();
      let capturedLevel: string | undefined;
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger({ level: 'info' }))
        .command('test', (c) =>
          c.action((_args, ctx) => {
            capturedLevel = ctx.context.logger.level;
          }),
        );

      program.eval('test --verbose');
      expect(capturedLevel).toBe('debug');
    });

    it('should not pass --verbose to the command args', () => {
      const { runtime } = createCapture();
      let rawResult: unknown;
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((args) => {
            rawResult = args;
          }),
        );

      program.eval('test --verbose');
      expect(rawResult).toEqual({});
    });

    it('should ignore --no-verbose (negated flag)', () => {
      const { errors, runtime } = createCapture();
      const program = createPadrone('app')
        .runtime(runtime)
        .extend(padroneLogger())
        .command('test', (c) =>
          c.action((_args, ctx) => {
            ctx.context.logger.debug('hidden');
            ctx.context.logger.info('shown');
          }),
        );

      program.eval('test --no-verbose');
      expect(errors).toEqual(['[INFO] shown']);
    });
  });
});

describe('padroneLogger value formatting', () => {
  const run = async (log: (logger: any) => void, config?: Parameters<typeof padroneLogger>[0], env: Record<string, string> = {}) => {
    const output: string[] = [];
    const errors: string[] = [];
    const program = createPadrone('test')
      .extend(padroneLogger(config))
      .command('x', (c) => c.action((_args, ctx) => log(ctx.context.logger)));
    await program.eval('x', { runtime: { output: (...a) => output.push(a.join(' ')), error: (t) => errors.push(t), env: () => env } });
    return { output, errors };
  };

  it('prints errors with their stack instead of {}', async () => {
    const { errors } = await run((logger) => logger.error(new Error('boom')));
    expect(errors[0]).toStartWith('[ERROR] Error: boom');
  });

  it('does not throw on bigints or circular objects', async () => {
    const value: Record<string, unknown> = { n: 1n };
    value.self = value;
    const { errors } = await run((logger) => logger.info(value));
    expect(errors).toEqual(['[INFO] {"n":"1","self":"[Circular]"}']);
  });

  it('keeps repeated references that are not circular', async () => {
    const shared = { a: 1 };
    const { errors } = await run((logger) => logger.info({ x: shared, y: shared }));
    expect(errors).toEqual(['[INFO] {"x":{"a":1},"y":{"a":1}}']);
  });

  it('reads the level from the env variable', async () => {
    const { errors } = await run((logger) => logger.debug('hidden?'), { env: 'TEST_LOG_LEVEL' }, { TEST_LOG_LEVEL: 'DEBUG' });
    expect(errors).toEqual(['[DEBUG] hidden?']);
  });

  it('writes trace, debug and info to stdout with stdout: true', async () => {
    const { output, errors } = await run(
      (logger) => {
        logger.info('to stdout');
        logger.warn('to stderr');
      },
      { stdout: true },
    );
    expect(output).toEqual(['[INFO] to stdout']);
    expect(errors).toEqual(['[WARN] to stderr']);
  });

  it('writes JSON lines with format: json', async () => {
    const { errors } = await run(
      (logger) => {
        logger.child('db').info({ userId: 7 }, 'signed in as %s', 'ann');
        logger.error(new Error('boom'));
      },
      { format: 'json', prefix: 'app' },
    );
    const [info, error] = errors.map((line) => JSON.parse(line));
    expect(info).toEqual({ time: expect.any(String), level: 'info', prefix: 'app', name: 'db', msg: 'signed in as ann', userId: 7 });
    expect(error).toMatchObject({ level: 'error', msg: 'boom', err: { name: 'Error', message: 'boom' } });
    expect(error.err.stack).toContain('boom');
  });

  it('colors level labels on color terminals', async () => {
    const errors: string[] = [];
    const program = createPadrone('test')
      .extend(padroneLogger())
      .command('x', (c) => c.action((_args, ctx) => ctx.context.logger.warn('careful')));
    program.eval('x', { runtime: { format: 'ansi', error: (t) => errors.push(t), output: () => {} } });
    program.eval('x --no-color', { runtime: { format: 'ansi', error: (t) => errors.push(t), output: () => {} } });
    expect(errors).toEqual(['\x1b[33m[WARN]\x1b[0m careful', '[WARN] careful']);
  });
});

describe('padroneLogger verbosity stacking', () => {
  const levelOf = (input: string, config?: Parameters<typeof padroneLogger>[0]) => {
    let level: string | undefined;
    const program = createPadrone('test')
      .configure({ version: '1.0.0' })
      .extend(padroneLogger(config))
      .action((_args, ctx) => {
        level = ctx.context.logger.level;
      });
    const result = program.eval(input, { runtime: { output: () => {}, error: () => {} } });
    return { level, result: result.result };
  };

  it('counts repeated --verbose', () => {
    expect(levelOf('--verbose').level).toBe('debug');
    expect(levelOf('--verbose --verbose').level).toBe('trace');
    expect(levelOf('--no-verbose').level).toBe('info');
  });

  it('adds -v, -vv and -q with shortFlags', () => {
    expect(levelOf('-v', { shortFlags: true }).level).toBe('debug');
    expect(levelOf('-vv', { shortFlags: true }).level).toBe('trace');
    expect(levelOf('-q', { shortFlags: true }).level).toBe('silent');
  });

  it('leaves -v to the version builtin without shortFlags', () => {
    expect(levelOf('-v').result).toBe('1.0.0');
  });
});

describe('padroneLogger registered on a command', () => {
  it('reads the log-level flags', () => {
    const { errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime(runtime)
      .command('sync', (c) =>
        c.extend(padroneLogger()).action((_args, ctx) => {
          ctx.context.logger.debug('debug msg');
        }),
      );

    const result = program.eval('sync --verbose');
    expect(result.argsResult?.issues).toBeUndefined();
    expect(errors).toEqual(['[DEBUG] debug msg']);
  });
});

describe('padroneLogger under JSON output', () => {
  it('writes every level to stderr so stdout stays JSON', () => {
    const { output, errors, runtime } = createCapture();
    const program = createPadrone('app')
      .runtime({ ...runtime, format: 'json' })
      .extend(padroneLogger())
      .command('info', (c) =>
        c.action((_args, ctx) => {
          ctx.context.logger.info('starting');
          return { ok: true };
        }),
      );

    program.eval('info');
    expect(errors).toEqual(['[INFO] starting']);
    expect(output).toEqual([JSON.stringify({ ok: true }, null, 2)]);
  });
});
