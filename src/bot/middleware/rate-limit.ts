import type { Context, NextFunction } from "grammy";
import type { BridgeConfig } from "../../types.js";

interface RateState {
  timestamps: number[];
}

const userRates = new Map<number, RateState>();

export function createRateLimitMiddleware(config: BridgeConfig) {
  const maxPerMinute = config.telegram.rateLimitPerMinute;

  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Commands bypass rate limiting
    if (ctx.message?.text?.startsWith("/")) {
      await next();
      return;
    }

    const now = Date.now();
    const state = userRates.get(userId) || { timestamps: [] };

    // Remove timestamps older than 1 minute
    state.timestamps = state.timestamps.filter((t) => now - t < 60_000);

    if (state.timestamps.length >= maxPerMinute) {
      const oldestInWindow = state.timestamps[0];
      const waitSec = Math.ceil((60_000 - (now - oldestInWindow)) / 1000);
      await ctx.reply(`Rate limited. Try again in ${waitSec}s.`);
      return;
    }

    state.timestamps.push(now);
    userRates.set(userId, state);

    await next();
  };
}
