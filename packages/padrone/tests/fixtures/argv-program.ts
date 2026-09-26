// A program run as a subprocess by argv.test.ts: real process.argv, the default runtime.
import { createPadrone } from 'padrone';
import * as z from 'zod/v4';

const program = createPadrone('t')
  .command('g', (c) =>
    c
      .arguments(
        z.object({
          family: z.string().optional(),
          chars: z.union([z.boolean(), z.string()]).default(false).meta({ flags: 'c' }),
          s: z.string().optional().meta({ flags: 's' }),
          n: z.number().optional(),
        }),
        { positional: ['family'] },
      )
      .action((args) => {
        console.log(JSON.stringify(args));
      }),
  )
  .command('fail', (c) =>
    c.action(() => {
      throw new Error('boom');
    }),
  );

await program.cli().drain();
