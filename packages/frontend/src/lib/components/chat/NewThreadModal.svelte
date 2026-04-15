<script lang="ts">
  let {
    open = false,
    name = '',
    creating = false,
    onclose,
    onsubmit,
    onnamechange,
  } = $props<{
    open: boolean;
    name: string;
    creating: boolean;
    onclose?: () => void;
    onsubmit?: () => void;
    onnamechange?: (value: string) => void;
  }>();

  function handleInput(event: Event) {
    onnamechange?.((event.currentTarget as HTMLInputElement).value);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      onsubmit?.();
    }
  }
</script>

{#if open}
  <div class="modal-backdrop" role="presentation">
    <button class="modal-backdrop-btn" onclick={onclose} aria-hidden="true" tabindex="-1"></button>
    <div class="thread-modal" role="dialog" aria-modal="true" aria-label="New thread">
      <div class="thread-modal-header">
        <div>
          <span class="thread-modal-eyebrow">New thread</span>
          <h2 class="thread-modal-title">Start a conversation</h2>
        </div>
        <button class="thread-modal-close" onclick={onclose} aria-label="Close" disabled={creating}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <input
        class="thread-modal-input"
        type="text"
        placeholder="Leave blank for today's daily thread"
        value={name}
        oninput={handleInput}
        onkeydown={handleKeydown}
        disabled={creating}
      />
      <div class="thread-modal-actions">
        <button class="thread-modal-btn cancel" onclick={onclose} disabled={creating}>Cancel</button>
        <button class="thread-modal-btn create" onclick={onsubmit} disabled={creating}>
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-backdrop-btn {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
  }

  .thread-modal {
    position: relative;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    width: 90%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    animation: modalRise 0.2s ease-out;
  }

  .thread-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .thread-modal-eyebrow {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .thread-modal-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-top: 0.25rem;
  }

  .thread-modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.25rem;
  }

  .thread-modal-close:hover { color: var(--text-primary); }

  .thread-modal-input {
    height: 44px;
    padding: 0 1rem;
    background: var(--bg-input, var(--bg-tertiary));
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: var(--font-body);
    width: 100%;
  }

  .thread-modal-input:focus {
    outline: none;
    border-color: var(--gold-dim);
  }

  .thread-modal-input::placeholder {
    color: var(--text-muted);
  }

  .thread-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .thread-modal-btn {
    height: 40px;
    padding: 0 1.25rem;
    border-radius: 0.625rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .thread-modal-btn.cancel {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }

  .thread-modal-btn.cancel:hover { border-color: var(--border-hover); color: var(--text-primary); }

  .thread-modal-btn.create {
    background: var(--gold-dim);
    border: none;
    color: var(--bg-primary);
  }

  .thread-modal-btn.create:hover { opacity: 0.9; }
  .thread-modal-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  @keyframes modalRise {
    from {
      opacity: 0;
      transform: translateY(0.5rem) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
</style>
