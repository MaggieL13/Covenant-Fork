type OlderMessagesControllerOptions = {
  getContainer: () => HTMLElement | null;
  getActiveThreadId: () => string | null;
  loadOlderMessagesForThread: (threadId: string) => Promise<boolean>;
};

export function createOlderMessagesController({
  getContainer,
  getActiveThreadId,
  loadOlderMessagesForThread,
}: OlderMessagesControllerOptions) {
  let loadingOlder = $state(false);
  let hasMoreMessages = $state(true);

  function reset(): void {
    loadingOlder = false;
    hasMoreMessages = true;
  }

  async function loadMoreMessages(): Promise<void> {
    const threadId = getActiveThreadId();
    if (!threadId || loadingOlder || !hasMoreMessages) return;

    loadingOlder = true;
    const previousHeight = getContainer()?.scrollHeight ?? 0;

    try {
      hasMoreMessages = await loadOlderMessagesForThread(threadId);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const container = getContainer();
      if (container) {
        const newHeight = container.scrollHeight;
        container.scrollTop = newHeight - previousHeight;
      }
    } finally {
      loadingOlder = false;
    }
  }

  return {
    get loadingOlder() {
      return loadingOlder;
    },
    get hasMoreMessages() {
      return hasMoreMessages;
    },
    reset,
    loadMoreMessages,
  };
}
