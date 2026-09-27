import {
  type Cheese,
  COUPONS,
  DELIVERY_FEE,
  EXTRA_CHEESE_PRICE,
  findPizza,
  type PizzaId,
  SIZE_FACTOR,
  type Size,
  type Store,
  TOPPING_PRICE,
  type Topping,
} from './menu.ts';

export type OrderStatus = 'received' | 'baking' | 'on-the-way' | 'delivered' | 'cancelled';

export type OrderInput = {
  pizza: PizzaId;
  size: Size;
  toppings: Topping[];
  cheese: Cheese;
  quantity: number;
  spice: number;
  delivery: boolean;
  address?: string;
  note?: string;
  store: Store;
};

export type Order = OrderInput & { id: number; status: OrderStatus; total: number; coupon?: string; placedAt: Date };

export type QuoteLine = { item: string; amount: number };
export type Quote = { lines: QuoteLine[]; total: number };

export type Review = { orderId: number; stars: number; comment?: string };

export type LogEntry = { command: string; ms: number; ok: boolean; at: Date };

export function quote(input: OrderInput, discounts: { label: string; rate: number }[] = []): Quote {
  const pizza = findPizza(input.pizza);
  if (!pizza) throw new Error(`Unknown pizza: ${input.pizza}`);

  const unit = pizza.price * SIZE_FACTOR[input.size];
  const lines: QuoteLine[] = [{ item: `${input.quantity} × ${input.size} ${pizza.name}`, amount: unit * input.quantity }];
  if (input.toppings.length > 0) {
    lines.push({ item: `Toppings (${input.toppings.join(', ')})`, amount: input.toppings.length * TOPPING_PRICE * input.quantity });
  }
  if (input.cheese === 'extra') lines.push({ item: 'Extra cheese', amount: EXTRA_CHEESE_PRICE * input.quantity });
  if (input.delivery) lines.push({ item: 'Delivery', amount: DELIVERY_FEE });

  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  for (const discount of discounts) lines.push({ item: discount.label, amount: -subtotal * discount.rate });

  const total = Math.max(
    0,
    lines.reduce((sum, line) => sum + line.amount, 0),
  );
  return { lines, total: Math.round(total * 100) / 100 };
}

/** An in-memory pizzeria. Every program invocation receives one through the typed context. */
export function createKitchen() {
  let nextId = 1;
  const orders: Order[] = [];
  const reviews: Review[] = [];
  const log: LogEntry[] = [];
  let coupon: string | undefined;

  const kitchen = {
    orders,
    reviews,
    log,
    get coupon() {
      return coupon;
    },
    redeem(code: string) {
      coupon = code;
      return COUPONS[code] ?? 0;
    },
    place(input: OrderInput, total: number): Order {
      const order: Order = { ...input, id: nextId++, status: 'received', total, coupon, placedAt: new Date() };
      coupon = undefined;
      orders.push(order);
      return order;
    },
    find(id: number) {
      return orders.find((order) => order.id === id);
    },
  };

  // A couple of orders so there is something to look at
  kitchen.place(
    {
      pizza: 'margherita',
      size: 'large',
      toppings: ['basil'],
      cheese: 'normal',
      quantity: 1,
      spice: 0,
      delivery: false,
      store: 'downtown',
    },
    13.65,
  ).status = 'delivered';
  kitchen.place(
    {
      pizza: 'diavola',
      size: 'medium',
      toppings: ['jalapenos', 'olives'],
      cheese: 'extra',
      quantity: 2,
      spice: 3,
      delivery: true,
      address: '42 Schema St',
      store: 'harbor',
    },
    37,
  ).status = 'baking';

  return kitchen;
}

export type Kitchen = ReturnType<typeof createKitchen>;
