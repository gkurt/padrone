import { resolveAllCommands } from '../core/commands.ts';
import type { AnyPadroneBuilder, CommandTypesBase, PadroneCommand } from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import { passthroughSchema } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

type ManArgs = { setup?: boolean; remove?: boolean };

type ManCommand = PadroneCommand<'man', '', PadroneSchema<ManArgs>, string, [], [], true>;

export type WithMan<T> = WithCommand<T, 'man', ManCommand>;

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds the `man` command for man page generation.
 *
 * Usage:
 * ```ts
 * import { createPadrone } from 'padrone';
 * import { padroneMan } from 'padrone/man';
 *
 * createPadrone('my-cli').extend(padroneMan())
 * ```
 */
export function padroneMan(): <T extends CommandTypesBase>(builder: T) => WithMan<T> {
  return ((builder: AnyPadroneBuilder) =>
    builder.command('man', (c) =>
      c
        .configure({ description: 'Generate man pages', hidden: true })
        .arguments(
          passthroughSchema({
            setup: { type: 'boolean', description: 'Install the man pages' },
            remove: { type: 'boolean', description: 'Remove installed man pages' },
          }),
        )
        .async()
        .action(async (args, ctx) => {
          const rootCommand = getRootCommand(ctx.command);
          resolveAllCommands(rootCommand);
          const { setupManPages, removeManPages, generateDocs } = await import('../docs/index.ts');
          if (args.setup) {
            const setupResult = await setupManPages(rootCommand);
            return `${setupResult.updated ? 'Updated' : 'Installed'} ${setupResult.written.length} man page(s) in ${setupResult.dir}`;
          }
          if (args.remove) {
            const removeResult = await removeManPages(rootCommand);
            return removeResult.removed.length > 0
              ? `Removed ${removeResult.removed.length} man page(s) from ${removeResult.dir}`
              : 'No man pages found to remove.';
          }
          const docsResult = generateDocs(rootCommand, { format: 'man' });
          return docsResult.pages[0]?.content ?? '';
        }),
    )) as any;
}
