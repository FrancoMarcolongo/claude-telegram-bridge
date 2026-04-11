import type { Context, NextFunction } from "grammy";
import { getBridgePin } from "../../config.js";
import type { BridgeConfig } from "../../types.js";
import { logger } from "../../utils/logger.js";

interface PinState {
  verified: boolean;
  verifiedAt: number;
  failures: number;
  lockedUntil: number;
}

const PIN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAX_FAILURES = 3;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Per-user PIN state
const pinStates = new Map<number, PinState>();

export function createPinMiddleware(config: BridgeConfig) {
  return async (ctx: Context, next: NextFunction) => {
    if (!config.security.requirePin) {
      await next();
      return;
    }

    const pin = getBridgePin();
    if (!pin) {
      // PIN required in config but not set in .env — pass through
      await next();
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) return;

    const state = pinStates.get(userId) || {
      verified: false,
      verifiedAt: 0,
      failures: 0,
      lockedUntil: 0,
    };

    // Check lockout
    if (state.lockedUntil > Date.now()) {
      const remainingMin = Math.ceil((state.lockedUntil - Date.now()) / 60000);
      await ctx.reply(`Locked out. Try again in ${remainingMin} minutes.`);
      return;
    }

    // Check if already verified and not expired
    if (state.verified && Date.now() - state.verifiedAt < PIN_TTL_MS) {
      await next();
      return;
    }

    // Check if this message IS the PIN
    const text = ctx.message?.text?.trim();

    // Commands always pass through so /help works before auth
    if (text?.startsWith("/")) {
      // Only allow /start, /help, /pin before auth
      if (text === "/start" || text === "/help" || text.startsWith("/pin ")) {
        if (text.startsWith("/pin ")) {
          const attempt = text.slice(5).trim();
          await verifyPin(ctx, userId, attempt, pin, state);
          return;
        }
        await next();
        return;
      }
      await ctx.reply("Please authenticate first. Send: /pin <your-pin>");
      return;
    }

    // Treat any non-command text as a PIN attempt if not verified
    if (text) {
      await verifyPin(ctx, userId, text, pin, state);
      return;
    }

    await ctx.reply("Please authenticate first. Send: /pin <your-pin>");
  };
}

async function verifyPin(
  ctx: Context,
  userId: number,
  attempt: string,
  pin: string,
  state: PinState
): Promise<void> {
  // Delete the PIN message to keep it out of chat history
  try {
    if (ctx.message?.message_id) {
      await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id);
    }
  } catch { /* may lack permissions in some contexts */ }

  if (attempt === pin) {
    state.verified = true;
    state.verifiedAt = Date.now();
    state.failures = 0;
    state.lockedUntil = 0;
    pinStates.set(userId, state);
    logger.info({ userId }, "PIN verified");
    await ctx.reply("Authenticated. You can now send messages.");
  } else {
    state.failures++;
    if (state.failures >= MAX_FAILURES) {
      state.lockedUntil = Date.now() + LOCKOUT_MS;
      state.failures = 0;
      pinStates.set(userId, state);
      logger.warn({ userId }, "PIN lockout triggered");
      await ctx.reply(`Too many failed attempts. Locked for 15 minutes.`);
    } else {
      pinStates.set(userId, state);
      await ctx.reply(`Wrong PIN. ${MAX_FAILURES - state.failures} attempts remaining.`);
    }
  }
}

export function resetPinState(userId: number): void {
  pinStates.delete(userId);
}
