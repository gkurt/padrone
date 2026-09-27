import { resolveAllCommands } from '../core/commands.ts';
import type { PadroneMcpPreferences } from '../feature/mcp.ts';
import type { AnyPadroneBuilder, CommandTypesBase, PadroneCommand } from '../types/index.ts';
import type { PadroneSchema } from '../types/schema.ts';
import type { WithCommand } from '../util/type-utils.ts';
import { getRootCommand } from '../util/utils.ts';
import { passthroughSchema } from './utils.ts';

// ── Types ────────────────────────────────────────────────────────────────

type McpArgs = { transport?: string; port?: string; host?: string; basePath?: string };

type McpCommand = PadroneCommand<'mcp', '', PadroneSchema<McpArgs>, void, [], [], true>;

export type WithMcp<T> = WithCommand<T, 'mcp', McpCommand>;

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that adds the `mcp` command for starting a Model Context Protocol server.
 *
 * Usage:
 * ```ts
 * import { createPadrone } from 'padrone';
 * import { padroneMcp } from 'padrone/mcp';
 *
 * createPadrone('my-cli').extend(padroneMcp())
 * ```
 */
export function padroneMcp(defaults?: PadroneMcpPreferences): <T extends CommandTypesBase>(builder: T) => WithMcp<T> {
  return ((builder: AnyPadroneBuilder) =>
    builder.command('mcp', (c) =>
      c
        .configure({ description: 'Start a Model Context Protocol server', hidden: true })
        .arguments(
          passthroughSchema({
            transport: { type: 'string', description: 'Transport to serve over', enum: ['http', 'stdio'] },
            port: { type: 'string', description: 'Port for the HTTP transport' },
            host: { type: 'string', description: 'Host for the HTTP transport' },
            'base-path': { type: 'string', description: 'Base path for the HTTP transport' },
          }),
          {
            positional: ['transport'],
          },
        )
        .async()
        .action(async (args, ctx) => {
          const rootCommand = getRootCommand(ctx.command);
          resolveAllCommands(rootCommand);
          const { startMcpServer } = await import('../feature/mcp.ts');
          const transport = args.transport === 'stdio' || args.transport === 'http' ? args.transport : undefined;
          const port = args.port ? parseInt(args.port, 10) : undefined;
          const prefs: PadroneMcpPreferences = {
            ...defaults,
            transport: transport ?? defaults?.transport,
            port: port && !Number.isNaN(port) ? port : defaults?.port,
            host: args.host ?? defaults?.host,
            basePath: args['base-path'] ?? defaults?.basePath,
          };
          await startMcpServer(ctx.program, rootCommand, ctx.program.eval, prefs);
        }),
    )) as any;
}
