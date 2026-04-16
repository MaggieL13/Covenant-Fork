type KeyboardShortcutsControllerOptions = {
  toggleSearch: () => void;
  isCanvasOpen: () => boolean;
  closeCanvas: () => void;
  isSidebarOpen: () => boolean;
  closeSidebar: () => void;
  isNewThreadOpen: () => boolean;
  closeNewThread: () => void;
  isStreaming: () => boolean;
  stopGeneration: () => void;
};

export function createKeyboardShortcutsController({
  toggleSearch,
  isCanvasOpen,
  closeCanvas,
  isSidebarOpen,
  closeSidebar,
  isNewThreadOpen,
  closeNewThread,
  isStreaming,
  stopGeneration,
}: KeyboardShortcutsControllerOptions) {
  function handleGlobalKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault();
      toggleSearch();
    }

    if (event.key === 'Escape' && isCanvasOpen()) {
      event.preventDefault();
      closeCanvas();
      return;
    }

    if (event.key === 'Escape' && isSidebarOpen()) {
      event.preventDefault();
      closeSidebar();
      return;
    }

    if (event.key === 'Escape' && isNewThreadOpen()) {
      event.preventDefault();
      closeNewThread();
    }

    if (event.key === 'Escape' && isStreaming()) {
      event.preventDefault();
      stopGeneration();
    }
  }

  return {
    handleGlobalKeydown,
  };
}
