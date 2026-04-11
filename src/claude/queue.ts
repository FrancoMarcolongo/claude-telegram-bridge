import { logger } from "../utils/logger.js";

interface QueuedItem<T> {
  data: T;
  resolve: (value: void) => void;
}

export class MessageQueue {
  private queues = new Map<number, QueuedItem<() => Promise<void>>[]>();
  private processing = new Map<number, boolean>();

  async enqueue(chatId: number, task: () => Promise<void>): Promise<{ position: number; queued: boolean }> {
    if (!this.queues.has(chatId)) {
      this.queues.set(chatId, []);
    }

    if (!this.processing.get(chatId)) {
      // Not busy — execute immediately
      this.processing.set(chatId, true);
      try {
        await task();
      } finally {
        this.processing.set(chatId, false);
        this.processNext(chatId);
      }
      return { position: 0, queued: false };
    }

    // Already processing — queue it
    const queue = this.queues.get(chatId)!;
    return new Promise<{ position: number; queued: boolean }>((resolve) => {
      const position = queue.length + 1;
      queue.push({
        data: async () => {
          try {
            await task();
          } finally {
            this.processing.set(chatId, false);
            this.processNext(chatId);
          }
        },
        resolve: () => resolve({ position, queued: true }),
      });
      // Resolve immediately with position info
      resolve({ position, queued: true });
    });
  }

  private async processNext(chatId: number): Promise<void> {
    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    this.processing.set(chatId, true);

    logger.debug({ chatId, remaining: queue.length }, "Processing next queued message");
    await next.data();
  }

  getQueueLength(chatId: number): number {
    return this.queues.get(chatId)?.length || 0;
  }

  isProcessing(chatId: number): boolean {
    return this.processing.get(chatId) || false;
  }

  clear(chatId: number): number {
    const queue = this.queues.get(chatId);
    const count = queue?.length || 0;
    this.queues.set(chatId, []);
    return count;
  }
}
