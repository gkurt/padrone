export const SIZES = ['small', 'medium', 'large'] as const;
export const CHEESE = ['none', 'light', 'normal', 'extra'] as const;
export const STORES = ['downtown', 'harbor', 'uptown'] as const;
export const TOPPINGS = [
  'basil',
  'mushrooms',
  'olives',
  'onions',
  'peppers',
  'jalapenos',
  'pepperoni',
  'ham',
  'bacon',
  'pineapple',
] as const;
export const PIZZA_IDS = ['margherita', 'pepperoni', 'funghi', 'diavola', 'quattro-formaggi', 'hawaiian', 'ortolana'] as const;

export type Size = (typeof SIZES)[number];
export type Cheese = (typeof CHEESE)[number];
export type Store = (typeof STORES)[number];
export type Topping = (typeof TOPPINGS)[number];
export type PizzaId = (typeof PIZZA_IDS)[number];

export type Pizza = {
  id: PizzaId;
  name: string;
  description: string;
  price: number;
  veggie: boolean;
  spicy: boolean;
};

export const MENU: readonly Pizza[] = [
  { id: 'margherita', name: 'Margherita', description: 'Tomato, mozzarella and fresh basil', price: 9, veggie: true, spicy: false },
  { id: 'pepperoni', name: 'Pepperoni', description: 'Tomato, mozzarella and a lot of pepperoni', price: 11, veggie: false, spicy: false },
  { id: 'funghi', name: 'Funghi', description: 'Mushrooms, garlic, thyme and mozzarella', price: 10, veggie: true, spicy: false },
  { id: 'diavola', name: 'Diavola', description: 'Spicy salami, chili oil and mozzarella', price: 12, veggie: false, spicy: true },
  {
    id: 'quattro-formaggi',
    name: 'Quattro Formaggi',
    description: 'Mozzarella, gorgonzola, parmesan and fontina',
    price: 12,
    veggie: true,
    spicy: false,
  },
  { id: 'hawaiian', name: 'Hawaiian', description: 'Ham and pineapple. We do not judge.', price: 11, veggie: false, spicy: false },
  { id: 'ortolana', name: 'Ortolana', description: 'Grilled zucchini, eggplant and peppers', price: 11, veggie: true, spicy: false },
];

export const SIZE_FACTOR: Record<Size, number> = { small: 0.8, medium: 1, large: 1.3 };
export const TOPPING_PRICE = 1.5;
export const EXTRA_CHEESE_PRICE = 2;
export const DELIVERY_FEE = 3;

/** Coupon codes and their discount. `null` marks an expired code. */
export const COUPONS: Record<string, number | null> = { PADRONE: 0.2, TYPESAFE: 0.1, PIZZA2019: null };

export function findPizza(id: string): Pizza | undefined {
  return MENU.find((pizza) => pizza.id === id);
}

export function formatPrice(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
