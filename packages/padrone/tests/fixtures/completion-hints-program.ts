// A program run as a subprocess by completion-hints.test.ts: the generated shell scripts call it for candidates.
import { createPadrone } from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import * as z from 'zod/v4';

const program = createPadrone('hintcli')
  .extend(padroneCompletion())
  .command('deploy', (c) =>
    c
      .configure({ description: 'Deploy the app' })
      .arguments(
        z.object({
          target: z.string().optional(),
          config: z.string().optional(),
          out: z.string().optional(),
          shell: z.string().optional(),
          url: z.string().optional(),
          log: z.string().optional(),
          env: z.enum(['dev', 'prod']).optional(),
          force: z.boolean().optional(),
        }),
        {
          positional: ['target'],
          fields: {
            target: { complete: () => [{ value: 'web', description: 'Web frontend' }, 'api'] },
            config: { description: 'Config file', hint: { ext: ['json', '.yaml'] } },
            out: { description: 'Output directory', hint: 'dir' },
            shell: { hint: 'command' },
            url: { hint: 'url' },
          },
        },
      )
      .action(() => {}),
  )
  .command('build', (c) => c.configure({ description: 'Build it' }).action(() => {}));

await program.cli().drain();
