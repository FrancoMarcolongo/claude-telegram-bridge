import type { Context, NextFunction } from "grammy";
import type { BridgeConfig } from "../../types.js";

export function createAuthMiddleware(config: BridgeConfig) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;

    // Silently ignore unauthorized users
    if (!userId || !config.telegram.allowedUserIds.includes(userId)) {
      return;
    }

    await next();
  };
}
