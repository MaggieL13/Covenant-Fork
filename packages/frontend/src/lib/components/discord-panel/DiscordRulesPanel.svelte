<script lang="ts">
  import type { Snippet } from 'svelte';

  interface RulesData {
    servers: Record<string, { id: string }>;
    channels: Record<string, { id: string }>;
    users: Record<string, { id: string }>;
  }

  let {
    showRules,
    rulesLoading,
    rules,
    rulesSection,
    ontoggleopen,
    onselectsection,
    children,
  } = $props<{
    showRules: boolean;
    rulesLoading: boolean;
    rules: RulesData | null;
    rulesSection: 'servers' | 'channels' | 'users';
    ontoggleopen?: () => void;
    onselectsection?: (section: 'servers' | 'channels' | 'users') => void;
    children?: Snippet;
  }>();
</script>

<section class="section">
  <button class="collapsible-header" onclick={() => ontoggleopen?.()}>
    <h3 class="section-title">Rules</h3>
    <span class="chevron" class:open={showRules}>&#9656;</span>
  </button>

  {#if showRules}
    {#if rulesLoading && !rules}
      <p class="loading">Loading rules...</p>
    {:else if rules}
      <nav class="rules-tabs">
        <button class="rules-tab" class:active={rulesSection === 'servers'} onclick={() => onselectsection?.('servers')}>
          Servers ({Object.keys(rules.servers).length})
        </button>
        <button class="rules-tab" class:active={rulesSection === 'channels'} onclick={() => onselectsection?.('channels')}>
          Channels ({Object.keys(rules.channels).length})
        </button>
        <button class="rules-tab" class:active={rulesSection === 'users'} onclick={() => onselectsection?.('users')}>
          Users ({Object.keys(rules.users).length})
        </button>
      </nav>

      {@render children?.()}
    {/if}
  {/if}
</section>

<style>
  .section {
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .section:last-of-type {
    border-bottom: none;
  }

  .section-title {
    font-family: var(--font-body);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: 0;
    margin-bottom: 0.5rem;
  }

  .collapsible-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
  }

  .collapsible-header .section-title {
    margin-bottom: 0;
  }

  .chevron {
    color: var(--text-muted);
    transition: transform 0.2s ease;
    font-size: 0.75rem;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .loading {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    text-align: center;
    padding: 2rem;
  }

  .rules-tabs {
    display: flex;
    gap: 0;
    margin: 0.75rem 0 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .rules-tab {
    appearance: none;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: 0.75rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .rules-tab:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .rules-tab.active {
    color: var(--text-primary);
    background: var(--bg-active);
    border-bottom-color: transparent;
    border-radius: var(--radius-sm);
  }
</style>
