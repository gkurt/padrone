import { createPadrone, padroneAutoOutput, padroneProgress } from 'padrone';
import * as z from 'zod/v4';
import type { Kitchen } from './kitchen.ts';
import { formatPrice } from './menu.ts';
import { sleep } from './sleep.ts';

const INGREDIENTS = ['flour', 'tomatoes', 'mozzarella', 'basil', 'olive-oil'] as const;

/**
 * A standalone program for the staff, mounted into `pizza` with `.mount('admin', admin, { context })`.
 * It declares the context it needs; the mount maps the pizza context onto it.
 */
export const admin = createPadrone('admin')
  .configure({ title: 'Staff-only tools', description: 'Kitchen stats and restocking. Staff only, but we trust you.' })
  .context<{ kitchen: Kitchen; staff: string }>()
  .command('stats', (c) =>
    c
      .configure({ title: 'Show kitchen statistics' })
      .extend(padroneAutoOutput({ output: 'tree' }))
      .action((_args, ctx) => {
        const { orders, reviews } = ctx.context.kitchen;
        const revenue = orders.filter((o) => o.status !== 'cancelled').reduce((sum, o) => sum + o.total, 0);
        const rating = reviews.length ? (reviews.reduce((sum, r) => sum + r.stars, 0) / reviews.length).toFixed(1) : 'no reviews yet';
        const byStatus = Object.entries(Object.groupBy(orders, (o) => o.status)).map(([status, list]) => ({
          label: `${status}: ${list?.length ?? 0}`,
        }));
        return {
          label: `Kitchen report (by ${ctx.context.staff})`,
          children: [
            { label: `Orders: ${orders.length}`, children: byStatus },
            { label: `Revenue: ${formatPrice(revenue)}` },
            {
              label: `Rating: ${rating}`,
              children: reviews.map((r) => ({ label: `#${r.orderId} ${'★'.repeat(r.stars)} ${r.comment ?? ''}` })),
            },
          ],
        };
      }),
  )
  .command('restock', (c) =>
    c
      .configure({ title: 'Restock ingredients' })
      .arguments(
        z.object({
          ingredients: z
            .array(z.enum(INGREDIENTS))
            .default([...INGREDIENTS])
            .describe('What to restock (default: everything)'),
          fast: z.boolean().optional().describe('Pay for express delivery').meta({ flags: 'f' }),
        }),
        { positional: ['...ingredients'] },
      )
      // A progress bar with elapsed time and ETA
      .extend(
        padroneProgress({
          message: { progress: 'Restocking…', success: 'Pantry restocked' },
          bar: { width: 24, animation: 'pulse' },
          time: true,
          eta: true,
        }),
      )
      .action(async (args, ctx) => {
        const steps = args.ingredients.length * 4;
        for (let i = 1; i <= steps; i++) {
          const ingredient = args.ingredients[Math.floor((i - 1) / 4)];
          ctx.context.progress.update({ message: `Restocking ${ingredient}…`, progress: i / steps });
          await sleep(args.fast ? 60 : 180, ctx.signal);
        }
      }),
  );
