type AutoScrollControllerOptions = {
  getContainer: () => HTMLElement | null;
  getActiveThreadId: () => string | null;
  getMessagesLength: () => number;
  getLoadingOlder: () => boolean;
  getHasMoreMessages: () => boolean;
  onReachTop: () => void | Promise<void>;
  bottomThreshold?: number;
  topThreshold?: number;
};

export function createAutoScrollController({
  getContainer,
  getActiveThreadId,
  getMessagesLength,
  getLoadingOlder,
  getHasMoreMessages,
  onReachTop,
  bottomThreshold = 100,
  topThreshold = 100,
}: AutoScrollControllerOptions) {
  let shouldAutoScroll = $state(true);

  function enableAutoScroll(): void {
    shouldAutoScroll = true;
  }

  function checkAutoScroll(): void {
    const container = getContainer();
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    shouldAutoScroll = scrollHeight - scrollTop - clientHeight < bottomThreshold;

    if (
      scrollTop < topThreshold &&
      !getLoadingOlder() &&
      getHasMoreMessages() &&
      getActiveThreadId() &&
      getMessagesLength() > 0
    ) {
      void onReachTop();
    }
  }

  function scrollToBottom(): void {
    const container = getContainer();
    if (!container || !shouldAutoScroll) return;

    container.scrollTop = container.scrollHeight;
  }

  function jumpToBottom(): void {
    const container = getContainer();
    if (!container) return;

    shouldAutoScroll = true;
    container.scrollTop = container.scrollHeight;
  }

  return {
    get shouldAutoScroll() {
      return shouldAutoScroll;
    },
    enableAutoScroll,
    checkAutoScroll,
    scrollToBottom,
    jumpToBottom,
  };
}
