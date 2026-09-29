import { defineInterceptor } from 'padrone';
import type { Kitchen } from './kitchen.ts';
import { COUPONS } from './menu.ts';

export type Discount = { label: string; rate: number };

/**
 * Records every command run (path, duration, outcome) in the kitchen's log, shown by `pizza history`.
 * The factory runs per execution, so its variables carry state across the phases of one run.
 */
export const auditLog = defineInterceptor({ name: 'audit-log', order: -10 })
  .requires<{ kitchen: Kitchen }>()
  .factory(() => {
    let startedAt = 0;
    let command: string | undefined;
    return {
      start(_ctx, next) {
        startedAt = performance.now();
        return next();
      },
      // The command is known once routing is done
      route(ctx, next) {
        command = ctx.command.path;
        return next();
      },
      // Runs after success and failure alike
      shutdown(ctx, next) {
        if (command) ctx.context.kitchen.log.push({ command, ms: performance.now() - startedAt, ok: !ctx.error, at: new Date() });
        return next();
      },
    };
  });

/** Happy hour is 3pm to 6pm, local time. */
export function isHappyHour(date = new Date()) {
  const hour = date.getHours();
  return hour >= 15 && hour < 18;
}

/**
 * Works out the discounts for the current run (happy hour, a redeemed coupon) and provides them
 * to the command as `ctx.context.discounts`, typed through `.provides<T>()`.
 */
export const discounts = defineInterceptor({ name: 'discounts' })
  .requires<{ kitchen: Kitchen }>()
  .factory(() => ({
    execute(ctx, next) {
      const list: Discount[] = [];
      if (isHappyHour()) list.push({ label: 'Happy hour (15% off)', rate: 0.15 });
      const coupon = ctx.context.kitchen.coupon;
      const rate = coupon ? COUPONS[coupon] : undefined;
      if (coupon && rate) list.push({ label: `Coupon ${coupon} (${rate * 100}% off)`, rate });
      return next({ context: { discounts: list } });
    },
  }))
  .provides<{ discounts: Discount[] }>();
