import { describe, expect, it } from 'bun:test';
import { testCli } from 'padrone/test';
import { createKitchen, createPizza } from '../src/pizza.ts';

function setup(config?: Record<string, unknown>) {
  const kitchen = createKitchen();
  const pizza = createPizza({ loadConfig: () => config });
  return { kitchen, cli: () => testCli(pizza).context({ kitchen }) };
}

describe('pizza', () => {
  it('lists the menu, filtered and sorted', async () => {
    const { cli } = setup();
    const { result } = await cli().run('menu --veggie --sort price');
    expect(result?.map((p) => p.id)).toEqual(['margherita', 'funghi', 'ortolana', 'quattro-formaggi']);
  });

  it('rejects conflicting menu filters', async () => {
    const { cli } = setup();
    const { issues } = await cli().run('menu --veggie --spicy');
    expect(issues?.[0]?.message).toContain('cannot be used with');
  });

  it('places an order in the kitchen from the context', async () => {
    const { cli, kitchen } = setup();
    const { result } = await cli().run('order margherita --size large -t basil -t olives -ppp --pickup');
    expect(result).toMatchObject({ order: '#3', pizza: '1 × large Margherita' });
    expect(kitchen.find(3)).toMatchObject({ toppings: ['basil', 'olives'], spice: 3, delivery: false, status: 'received' });
  });

  it('quotes an order with --dry-run without placing it', async () => {
    const { cli, kitchen } = setup();
    const { result } = await cli().run('order funghi --party --address "1 Main St" --dry-run');
    expect(result).toContain('5 × large Funghi');
    expect(kitchen.orders).toHaveLength(2);
  });

  it('asks for an address when delivering without one', async () => {
    const { cli } = setup();
    const { error } = await cli().run('order funghi');
    expect((error as Error).message).toBe('Where should we deliver?');
  });

  it('reads the address and size from the config file', async () => {
    const { cli, kitchen } = setup({ address: '7 Zod Ave', size: 'small' });
    await cli().run('order funghi');
    expect(kitchen.find(3)).toMatchObject({ address: '7 Zod Ave', size: 'small' });
  });

  it('reads options from PIZZA_* environment variables', async () => {
    const { cli, kitchen } = setup();
    await cli().env({ PIZZA_SIZE: 'large', PIZZA_STORE: 'harbor' }).run('order funghi --pickup');
    expect(kitchen.find(3)).toMatchObject({ size: 'large', store: 'harbor' });
  });

  it('validates coupons asynchronously and applies them to the next order', async () => {
    const { cli, kitchen } = setup();
    expect((await cli().run('redeem nope')).issues?.[0]?.message).toBe('Unknown coupon code');
    expect((await cli().run('redeem pizza2019')).issues?.[0]?.message).toBe('This coupon has expired');
    await cli().run('redeem padrone');
    await cli().run('order margherita --pickup');
    expect(kitchen.find(3)).toMatchObject({ coupon: 'PADRONE' });
  });

  it('reads a review comment from stdin', async () => {
    const { cli, kitchen } = setup();
    await cli().stdin('Best crust in town\n').run('review 1 --stars 5');
    expect(kitchen.reviews).toEqual([{ orderId: 1, stars: 5, comment: 'Best crust in town' }]);
  });

  it('requires stars or a comment for a review', async () => {
    const { cli } = setup();
    const { issues } = await cli().run('review 1');
    expect(issues?.[0]?.message).toContain('At least one of');
  });

  it('cancels an order, or shows what it would do with --dry-run', async () => {
    const { cli, kitchen } = setup();
    expect((await cli().run('orders cancel 2 -n')).result).toContain('Would cancel order #2');
    expect(kitchen.find(2)?.status).toBe('baking');
    await cli().run('orders cancel 2');
    expect(kitchen.find(2)?.status).toBe('cancelled');
  });

  it('runs the mounted admin program with the mapped context', async () => {
    const { cli } = setup();
    const { result } = await cli().run('admin stats');
    expect(result?.label).toBe('Kitchen report (by you)');
  });

  it('records every command in the audit log', async () => {
    const { cli, kitchen } = setup();
    await cli().run('menu');
    await cli().run('orders ls');
    expect(kitchen.log.map((entry) => entry.command)).toEqual(['menu', 'orders list']);
  });

  it('streams answers from the chef', async () => {
    const { cli } = setup();
    const { result } = await cli().run('chef ask what about pineapple');
    expect(result).toHaveLength(3);
  });

  it('completes pizza names and coupon codes', async () => {
    const { cli } = setup();
    expect((await cli().run('__complete order m')).result).toEqual(['margherita']);
    expect((await cli().run('__complete redeem P')).result).toEqual(['PADRONE', 'PIZZA2019']);
  });

  it('keeps the context in the REPL', async () => {
    const { cli, kitchen } = setup();
    await cli().repl(['order hawaiian --pickup --yes', 'orders show 3']);
    expect(kitchen.find(3)?.pizza).toBe('hawaiian');
  });
});
