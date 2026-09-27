import {
  ActionError,
  createPadrone,
  type PadroneConfigOptions,
  padroneAutoOutput,
  padroneConfig,
  padroneConfirm,
  padroneEnv,
  padroneJson,
  padroneLogger,
  padroneProgress,
  padroneTiming,
} from 'padrone';
import { padroneCompletion } from 'padrone/completion';
import * as z from 'zod/v4';
import { admin } from './admin.ts';
import { chef } from './chef.ts';
import { auditLog, discounts } from './interceptors.ts';
import { type Kitchen, quote } from './kitchen.ts';
import { CHEESE, COUPONS, findPizza, formatPrice, MENU, PIZZA_IDS, SIZES, STORES, TOPPINGS } from './menu.ts';
import { cancelOrder, listOrders, showOrder, trackOrder } from './orders.ts';
import { sleep } from './sleep.ts';

export type { Kitchen } from './kitchen.ts';
export { createKitchen } from './kitchen.ts';

export type PizzaOptions = {
  /** Where `pizza.config.json` comes from. Defaults to the file system; the website reads it from its virtual one. */
  loadConfig?: PadroneConfigOptions['loadConfig'];
};

const orderSchema = z.object({
  pizza: z.enum(PIZZA_IDS).describe('The pizza to order'),
  size: z.enum(SIZES).default('medium').describe('Pizza size'),
  toppings: z.array(z.enum(TOPPINGS)).default([]).describe('Extra toppings ($1.50 each)'),
  cheese: z.enum(CHEESE).default('normal').describe('How much cheese'),
  extraCheese: z.boolean().optional().describe('Add extra cheese'),
  quantity: z.number().int().min(1).max(20).default(1).describe('How many pizzas'),
  spice: z.number().int().max(5).default(0).describe('Chili level, repeat the flag for more heat'),
  delivery: z.boolean().default(true).describe('Deliver the order'),
  address: z.string().optional().describe('Delivery address'),
  party: z.boolean().optional().describe('Party mode: five large pizzas'),
  note: z.string().max(80).optional().describe('A note for the kitchen'),
});

export function createPizza(options: PizzaOptions = {}) {
  return (
    createPadrone('pizza', {
      builtins: {
        // `pizza orders` asks which subcommand to run; typos offer to run the closest command
        help: { pickSubcommand: true },
        suggestions: { run: 'prompt' },
      },
    })
      .configure({
        title: 'Padrone Pizza',
        description: 'Order pizza from the command line. Every flag is type-checked, validated and tab-completable.',
        version: '2.1.0',
        help: { after: 'Start with "pizza menu", then "pizza order". Run "pizza <command> --help" for details.' },
      })
      // Typed context: every command receives the kitchen passed to cli()/eval()
      .context<{ kitchen: Kitchen }>()
      // Global args: accepted by every command, before or after its name
      .globalArgs(z.object({ store: z.enum(STORES).default('downtown').describe('Which pizzeria to order from') }))
      .extend(padroneLogger({ shortFlags: true }))
      .extend(padroneTiming())
      .extend(padroneJson())
      .extend(padroneConfirm({ message: (command) => (command.name === 'order' ? 'Place this order?' : `Really ${command.name}?`) }))
      .extend(padroneEnv({ prefix: 'PIZZA' }))
      .extend(padroneConfig({ files: 'pizza.config.json', loadConfig: options.loadConfig }))
      .extend(padroneCompletion())
      .intercept(auditLog)
      .intercept(discounts)

      .command(['menu', 'm'], (c) =>
        c
          .configure({ title: 'Show the menu', group: 'Ordering' })
          .arguments(
            z.object({
              veggie: z.boolean().optional().describe('Only vegetarian pizzas'),
              spicy: z.boolean().optional().describe('Only spicy pizzas'),
              maxPrice: z.number().positive().optional().describe('Hide pizzas above this price'),
              sort: z.enum(['name', 'price']).default('name').describe('Sort order'),
            }),
            { fields: { veggie: { conflicts: 'spicy' } } },
          )
          .extend(padroneAutoOutput({ output: 'table' }))
          .action((args) =>
            MENU.filter((p) => (!args.veggie || p.veggie) && (!args.spicy || p.spicy) && (!args.maxPrice || p.price <= args.maxPrice))
              .toSorted((a, b) => (args.sort === 'price' ? a.price - b.price : a.name.localeCompare(b.name)))
              .map((p) => ({
                id: p.id,
                pizza: p.name,
                price: formatPrice(p.price),
                '': [p.veggie && '🌱', p.spicy && '🌶'].filter(Boolean).join(''),
              })),
          ),
      )

      .command(['order', 'o'], (c) =>
        c
          .configure({
            title: 'Order a pizza',
            description:
              'Places an order. Missing choices are asked for interactively (--no-interactive skips the questions, -i asks all of them).',
            group: 'Ordering',
            mutation: true,
            examples: [
              'pizza order margherita --size large -t basil -t olives',
              'pizza order diavola -ppp --pickup',
              'pizza order funghi --party --dry-run',
            ],
          })
          .async()
          .extend(padroneAutoOutput({ output: 'kv' }))
          .arguments(orderSchema, {
            positional: ['pizza'],
            interactive: ['pizza'],
            optionalInteractive: ['size', 'toppings'],
            fields: {
              size: { flags: 's' },
              toppings: { flags: 't' },
              quantity: { flags: 'q' },
              spice: { flags: 'p', count: true },
              extraCheese: { deprecated: 'Use --cheese extra instead' },
              delivery: { negative: 'pickup' },
              address: { flags: 'a' },
              party: { implies: { size: 'large', quantity: 5 } },
            },
          })
          .action(async (args, ctx) => {
            const input = toOrderInput(args);
            const { lines, total } = quote(input, ctx.context.discounts);
            ctx.context.logger.debug(`Quote: ${lines.map((l) => `${l.item} ${formatPrice(l.amount)}`).join(', ')}`);
            await sleep(600, ctx.signal);
            const order = ctx.context.kitchen.place(input, total);
            ctx.context.logger.info(`Order #${order.id} sent to the ${order.store} kitchen`);
            return {
              order: `#${order.id}`,
              pizza: `${input.quantity} × ${input.size} ${findPizza(input.pizza)?.name}`,
              total: formatPrice(total),
              next: `pizza orders track ${order.id}`,
            };
          })
          // --dry-run / -n shows the price breakdown without ordering
          .dryRun((args, ctx) => {
            const { lines, total } = quote(toOrderInput(args), ctx.context.discounts);
            return [
              ...lines.map((l) => `${l.item.padEnd(40)} ${formatPrice(l.amount).padStart(8)}`),
              `${'Total'.padEnd(40)} ${formatPrice(total).padStart(8)}`,
            ].join('\n');
          })
          .extend(padroneProgress({ message: { progress: 'Sending your order to the kitchen…', success: 'Order placed!' } })),
      )

      .command('orders', (c) =>
        c
          .configure({ title: 'Manage your orders', group: 'Ordering' })
          .command(['list', 'ls'], listOrders)
          .command('show', showOrder)
          .command('track', trackOrder)
          .command('cancel', cancelOrder),
      )

      .command('redeem', (c) =>
        c
          .configure({ title: 'Redeem a coupon for your next order', group: 'Ordering' })
          .async()
          .arguments(
            z.object({
              code: z
                .string()
                .transform((code) => code.toUpperCase())
                // Async validation: checked against the "coupon service" before the action runs
                .refine(async (code) => {
                  await sleep(400);
                  return COUPONS[code] !== undefined;
                }, 'Unknown coupon code')
                .refine((code) => COUPONS[code] !== null, 'This coupon has expired')
                .describe('Coupon code'),
            }),
            { positional: ['code'], fields: { code: { complete: () => Object.keys(COUPONS) } } },
          )
          .action((args, ctx) => {
            const rate = ctx.context.kitchen.redeem(args.code);
            return `Coupon ${args.code} applied: ${rate * 100}% off your next order.`;
          }),
      )

      .command('review', (c) =>
        c
          .configure({ title: 'Review an order', group: 'Ordering', examples: ['echo "Best crust in town" | pizza review 1 --stars 5'] })
          .arguments(
            z.object({
              id: z.number().int().positive().describe('Order number'),
              stars: z.number().int().min(1).max(5).optional().describe('Rating from 1 to 5'),
              comment: z.string().optional().describe('What did you think? Also read from stdin'),
            }),
            {
              positional: ['id'],
              stdin: 'comment',
              atLeastOne: ['stars', 'comment'],
              fields: { stars: { flags: 'r' }, comment: { flags: 'm' } },
            },
          )
          .action((args, ctx) => {
            const order = ctx.context.kitchen.find(args.id);
            if (!order) throw new ActionError(`Order #${args.id} not found`, { suggestions: ['Run "pizza orders list"'] });
            ctx.context.kitchen.reviews.push({ orderId: order.id, stars: args.stars ?? 3, comment: args.comment?.trim() });
            return `Thanks for reviewing order #${order.id}! ${'★'.repeat(args.stars ?? 0)}`;
          }),
      )

      .command('history', (c) =>
        c
          .configure({ title: 'Commands you ran in this session', group: 'Session' })
          .extend(padroneAutoOutput({ output: 'table' }))
          .action((_args, ctx) =>
            ctx.context.kitchen.log.map((entry) => ({
              time: entry.at.toLocaleTimeString(),
              command: entry.command,
              took: `${entry.ms.toFixed(0)}ms`,
              ok: entry.ok ? '✔' : '✖',
            })),
          ),
      )

      .command('docs', (c) =>
        c
          .configure({ title: 'Open the Padrone docs', group: 'Session' })
          .async()
          .action(async (_args, ctx) => {
            await ctx.runtime.open('https://gkurt.com/padrone/');
            return 'Opened https://gkurt.com/padrone/';
          }),
      )

      .command('feedback', (c) =>
        c
          .configure({ title: 'Write feedback in your editor', group: 'Session' })
          .async()
          .action(async (_args, ctx) => {
            const text = await ctx.runtime.editor('# What should we cook next?\n', { extension: '.md' });
            const lines = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
            return lines.length ? `Thanks! We got ${lines.length} line(s) of feedback.` : 'No feedback written.';
          }),
      )

      .extend(chef)

      .mount('admin', admin.configure({ group: 'Staff' }), { context: (ctx) => ({ kitchen: ctx.kitchen, staff: 'you' }) })

      .command('deliver', (c) =>
        c
          .configure({ title: 'Track an order', deprecated: 'Use "pizza orders track" instead', group: 'Ordering' })
          .async()
          .arguments(z.object({ id: z.number().int().positive().describe('Order number') }), { positional: ['id'] })
          // Runs the new command through the full pipeline
          .action(async (args, ctx) => {
            await ctx.program.eval(['orders', 'track', String(args.id)], { context: ctx.context }).result;
          }),
      )

      .command('pineapple', (c) =>
        c.configure({ hidden: true }).action(() => '🍍 You found the secret command. We still will not put it on a Margherita.'),
      )
  );
}

function toOrderInput(args: z.output<typeof orderSchema> & { store: (typeof STORES)[number] }) {
  if (args.delivery && !args.address) {
    throw new ActionError('Where should we deliver?', {
      suggestions: ['Pass --address "1 Main St"', 'Or pick it up yourself with --pickup', 'Or set "address" in pizza.config.json'],
    });
  }
  return {
    pizza: args.pizza,
    size: args.size,
    toppings: args.toppings,
    cheese: args.extraCheese ? ('extra' as const) : args.cheese,
    quantity: args.quantity,
    spice: args.spice,
    delivery: args.delivery,
    address: args.delivery ? args.address : undefined,
    note: args.note,
    store: args.store,
  };
}

export const pizza = createPizza();
export default pizza;
