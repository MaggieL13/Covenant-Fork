import type { Message } from '@resonant/shared';

type ReadObserverControllerOptions = {
  getSentinel: () => HTMLElement | null;
  getActiveThreadId: () => string | null;
  getMessages: () => Message[];
  sendRead: (threadId: string, beforeId: string) => void;
  threshold?: number;
};

export function createReadObserverController({
  getSentinel,
  getActiveThreadId,
  getMessages,
  sendRead,
  threshold = 0.1,
}: ReadObserverControllerOptions) {
  let observer: IntersectionObserver | null = null;

  function cleanup(): void {
    observer?.disconnect();
    observer = null;
  }

  function setup(): void {
    cleanup();

    const sentinel = getSentinel();
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;

    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const threadId = getActiveThreadId();
        const messages = getMessages();
        if (!threadId || messages.length === 0) continue;

        const lastMessage = messages[messages.length - 1];
        if (lastMessage.role === 'companion' && !lastMessage.read_at) {
          sendRead(threadId, lastMessage.id);
        }
      }
    }, { threshold });

    observer.observe(sentinel);
  }

  return {
    setup,
    cleanup,
  };
}
