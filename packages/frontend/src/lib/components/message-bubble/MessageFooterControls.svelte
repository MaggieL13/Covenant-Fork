<script lang="ts">
  import ReadAloudControl from '$lib/components/message-bubble/ReadAloudControl.svelte';

  type GroupedReaction = { emoji: string; count: number; users: string[] };

  let {
    role,
    isDeleted = false,
    isStreaming = false,
    groupedReactions = [],
    canReadAloud = false,
    readAloudState = 'idle',
    showHoverOnly = false,
    onToggleReaction,
    onAddReaction,
    onToggleReadAloud,
  } = $props<{
    role: string;
    isDeleted?: boolean;
    isStreaming?: boolean;
    groupedReactions?: GroupedReaction[];
    canReadAloud?: boolean;
    readAloudState?: 'idle' | 'loading' | 'playing';
    showHoverOnly?: boolean;
    onToggleReaction?: (emoji: string) => void;
    onAddReaction?: (emoji: string) => void;
    onToggleReadAloud?: () => void;
  }>();

  const QUICK_EMOJIS = ['❤️', '😂', '👍', '🔥', '😢', '✨'];
  let pickerOpen = $state(false);
  let pickerEl: HTMLDivElement | undefined = $state();

  function openReactionPicker() {
    pickerOpen = !pickerOpen;
  }

  function pickEmoji(emoji: string) {
    onAddReaction?.(emoji);
    pickerOpen = false;
  }

  function handlePickerClickOutside(e: MouseEvent) {
    if (pickerEl && !pickerEl.contains(e.target as Node)) {
      pickerOpen = false;
    }
  }

  $effect(() => {
    // ORDER: only attach the capture listener while the picker is open so emoji
    // clicks inside the picker can resolve before outside-dismissal runs.
    if (!pickerOpen) return;
    document.addEventListener('click', handlePickerClickOutside, true);
    return () => document.removeEventListener('click', handlePickerClickOutside, true);
  });
</script>

{#if role === 'user'}
  <div class="user-footer-left">
    <div class="reaction-picker-wrapper">
      <button class="reaction-add" onclick={openReactionPicker} title="Add reaction">+</button>
      {#if pickerOpen}
        <div class="reaction-quick-pick" bind:this={pickerEl}>
          {#each QUICK_EMOJIS as emoji}
            <button class="quick-emoji" onclick={() => pickEmoji(emoji)}>{emoji}</button>
          {/each}
        </div>
      {/if}
    </div>
    {#if groupedReactions.length > 0}
      {#each groupedReactions as { emoji, count }}
        <button class="reaction-chip" onclick={() => onToggleReaction?.(emoji)}>
          <span>{emoji}</span>
          {#if count > 1}<span class="reaction-count">{count}</span>{/if}
        </button>
      {/each}
    {/if}
  </div>
{:else if !isDeleted && (groupedReactions.length > 0 || !isStreaming)}
  <div class="reactions-row" class:reactions-hover-only={showHoverOnly}>
    {#if canReadAloud}
      <ReadAloudControl
        state={readAloudState}
        disabled={readAloudState === 'loading'}
        ontoggle={onToggleReadAloud}
      />
    {/if}
    {#if !showHoverOnly}
      {#each groupedReactions as reaction (reaction.emoji)}
        <button
          class="reaction-chip"
          class:mine={reaction.users.includes('user')}
          onclick={() => onToggleReaction?.(reaction.emoji)}
          title={reaction.users.join(', ')}
        >
          <span class="reaction-emoji">{reaction.emoji}</span>
          {#if reaction.count > 1}
            <span class="reaction-count">{reaction.count}</span>
          {/if}
        </button>
      {/each}
    {/if}
    <div class="reaction-picker-wrapper">
      <button class="reaction-add" onclick={openReactionPicker} title="Add reaction">+</button>
      {#if pickerOpen}
        <div class="reaction-quick-pick" bind:this={pickerEl}>
          {#each QUICK_EMOJIS as emoji}
            <button class="quick-emoji" onclick={() => pickEmoji(emoji)}>{emoji}</button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .reactions-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.25rem;
  }

  .reactions-hover-only {
    opacity: 0;
    transition: opacity 0.15s;
  }

  :global(.message:hover) .reactions-hover-only {
    opacity: 1;
  }

  .reaction-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    padding: 0.25rem 0.5rem;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.15s;
  }

  .reaction-chip:hover {
    background: var(--bg-hover);
    border-color: var(--border-hover);
  }

  .reaction-chip.mine {
    background: var(--bg-active);
    border-color: var(--accent);
  }

  .reaction-emoji {
    font-size: 0.9375rem;
    line-height: 1;
  }

  .reaction-count {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .reaction-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: 50%;
    color: var(--text-muted);
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.15s;
    line-height: 1;
  }

  .reaction-add:hover {
    border-color: var(--border-hover);
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  .reaction-picker-wrapper {
    position: relative;
    display: inline-flex;
  }

  .reaction-quick-pick {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 2px;
    padding: 4px 6px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    z-index: 10;
    white-space: nowrap;
  }

  .quick-emoji {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-size: 1.1rem;
    cursor: pointer;
    transition: background 0.12s;
  }

  .quick-emoji:hover {
    background: var(--bg-hover);
  }

  .user-footer-left {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
</style>
