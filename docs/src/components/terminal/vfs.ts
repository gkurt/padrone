/** A tiny in-memory file system for the web terminal (`ls`, `cat`, `>` redirects and the pizza config file). */
export function createVfs() {
  const files = new Map<string, string>([
    ['pizza.config.json', `${JSON.stringify({ address: '1 Padrone Way', store: 'downtown' }, null, 2)}\n`],
    [
      'README.md',
      [
        '# Padrone Pizza',
        '',
        'A demo CLI built with Padrone, running right here in your browser.',
        '',
        '- pizza.config.json holds your default address and store (padroneConfig).',
        '- Edit it with: echo \'{ "size": "large", "address": "7 Zod Ave" }\' > pizza.config.json',
        '- Environment variables work too: PIZZA_SIZE=small pizza order funghi -n',
        '',
      ].join('\n'),
    ],
  ]);

  const normalize = (path: string) => path.replace(/^(\.\/|~\/|\/home\/guest\/)/, '');

  return {
    list: () => [...files.keys()].sort(),
    read: (path: string) => files.get(normalize(path)),
    write: (path: string, content: string, append = false) =>
      files.set(normalize(path), (append ? (files.get(normalize(path)) ?? '') : '') + content),
    /**
     * `loadConfig` for `padroneConfig()`: the first of the candidate files that exists, parsed as JSON.
     * A single path comes from `--config <file>`, which must exist.
     */
    loadConfig(candidates: string | string[]): Record<string, unknown> | undefined {
      for (const file of Array.isArray(candidates) ? candidates : [candidates]) {
        const content = files.get(normalize(file));
        if (content === undefined) continue;
        try {
          return JSON.parse(content) as Record<string, unknown>;
        } catch (error) {
          throw new Error(`Invalid JSON in ${file}: ${(error as Error).message}`);
        }
      }
      if (typeof candidates === 'string') throw new Error(`Config file not found: ${candidates}`);
      return undefined;
    },
  };
}

export type Vfs = ReturnType<typeof createVfs>;
