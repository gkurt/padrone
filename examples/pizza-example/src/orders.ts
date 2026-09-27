import { ActionError, defineCommand, padroneAutoOutput, padroneProgress } from 'padrone';
import * as z from 'zod/v4';
import type { Kitchen, Order, OrderStatus } from './kitchen.ts';
import { findPizza, formatPrice } from './menu.ts';
import { sleep } from './sleep.ts';

const STATUSES = ['received', 'baking', 'on-the-way', 'delivered', 'cancelled'] as const satisfies readonly OrderStatus[];

const orderId = z.number().int().positive().describe('Order number');

function describeOrder(order: Order) {
  const pizza = findPizza(order.pizza)?.name ?? order.pizza;
  return `${order.quantity} × ${order.size} ${pizza}`;
}

function getOrder(kitchen: Kitchen, id: number): Order {
  const order = kitchen.find(id);
  if (order) return order;
  throw new ActionError(`Order #${id} not found`, { suggestions: ['Run "pizza orders list" to see your orders'] });
}

/** Commands defined in their own module. `.requires<T>()` types the context they expect from the program. */
const orderCommand = defineCommand().requires<{ kitchen: Kitchen }>();

export const listOrders = orderCommand.define((c) =>
  c
    .configure({ title: 'List your orders' })
    .arguments(
      z.object({
        status: z.array(z.enum(STATUSES)).optional().describe('Only orders with these statuses'),
        limit: z.number().int().positive().optional().describe('Show at most this many orders').meta({ flags: 'l' }),
      }),
    )
    // Returned rows are rendered as a table (or JSON with --json)
    .extend(padroneAutoOutput({ output: 'table' }))
    .action((args, ctx) =>
      ctx.context.kitchen.orders
        .filter((order) => !args.status || args.status.includes(order.status))
        .slice(0, args.limit)
        .map((order) => ({
          id: order.id,
          pizza: describeOrder(order),
          status: order.status,
          store: order.store,
          total: formatPrice(order.total),
        })),
    ),
);

export const showOrder = orderCommand.define((c) =>
  c
    .configure({ title: 'Show the details of an order' })
    .arguments(z.object({ id: orderId }), { positional: ['id'], interactive: ['id'] })
    // Rendered as aligned key/values in a terminal, or an object with --json
    .extend(padroneAutoOutput({ output: 'kv' }))
    .action((args, ctx) => {
      const order = getOrder(ctx.context.kitchen, args.id);
      return {
        Order: `#${order.id}`,
        Pizza: describeOrder(order),
        Toppings: order.toppings.join(', ') || '(none)',
        Cheese: order.cheese,
        Spice: order.spice ? '🌶'.repeat(order.spice) : 'mild',
        Delivery: order.delivery ? (order.address ?? 'yes') : 'pickup',
        Store: order.store,
        Status: order.status,
        Total: formatPrice(order.total),
        ...(order.note && { Note: order.note }),
        ...(order.coupon && { Coupon: order.coupon }),
      };
    }),
);

export const trackOrder = orderCommand.define((c) =>
  c
    .configure({ title: 'Watch an order go from the oven to your door' })
    .arguments(z.object({ id: orderId }), { positional: ['id'], interactive: ['id'] })
    .extend(
      padroneProgress({
        message: {
          progress: 'Tracking your order…',
          success: { message: 'Delivered. Buon appetito!', indicator: '🍕' },
          error: 'Stopped tracking',
        },
      }),
    )
    .action(async (args, ctx) => {
      const order = getOrder(ctx.context.kitchen, args.id);
      if (order.status === 'cancelled') throw new ActionError(`Order #${order.id} was cancelled`);
      const { progress, logger } = ctx.context;

      logger?.debug(`Tracking order #${order.id} from the ${order.store} store`);
      // A live task list with subtasks; Ctrl+C aborts `signal` and stops it
      await progress.tasks([
        { title: 'Order received', task: () => sleep(400, ctx.signal) },
        {
          title: 'Preparing',
          task: (t) =>
            t.tasks(
              [
                { title: 'Stretching the dough', task: () => sleep(700, ctx.signal) },
                { title: 'Adding sauce and cheese', task: () => sleep(600, ctx.signal) },
                {
                  title: 'Adding toppings',
                  skip: order.toppings.length === 0 && 'no extra toppings',
                  task: async (s) => {
                    for (const topping of order.toppings) {
                      s.update(topping);
                      await sleep(350, ctx.signal);
                    }
                  },
                },
              ],
              { concurrent: false },
            ),
        },
        {
          title: 'Baking at 450°C',
          task: async (t) => {
            order.status = 'baking';
            for (let s = 90; s > 0; s -= 15) {
              t.update(`${s}s left`);
              await sleep(250, ctx.signal);
            }
          },
        },
        {
          title: order.delivery ? `Delivering to ${order.address ?? 'you'}` : `Ready for pickup at ${order.store}`,
          task: async () => {
            order.status = 'on-the-way';
            await sleep(order.delivery ? 1200 : 300, ctx.signal);
          },
        },
      ]);
      order.status = 'delivered';
    }),
);

export const cancelOrder = orderCommand.define((c) =>
  c
    // mutation: padroneConfirm() asks before running it (skip with --yes)
    .configure({ title: 'Cancel an order', mutation: true })
    .arguments(z.object({ id: orderId }), { positional: ['id'], interactive: ['id'] })
    .action((args, ctx) => {
      const order = getOrder(ctx.context.kitchen, args.id);
      if (order.status === 'delivered') throw new ActionError(`Order #${order.id} was already delivered`, { exitCode: 2 });
      order.status = 'cancelled';
      return `Order #${order.id} cancelled. ${formatPrice(order.total)} will be refunded.`;
    })
    // --dry-run / -n runs this instead of the action
    .dryRun((args, ctx) => {
      const order = getOrder(ctx.context.kitchen, args.id);
      return `Would cancel order #${order.id} (${describeOrder(order)}) and refund ${formatPrice(order.total)}.`;
    }),
);
