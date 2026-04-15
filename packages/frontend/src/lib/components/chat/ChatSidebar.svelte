<script lang="ts">
  import ThreadList from '$lib/components/ThreadList.svelte';
  import type { ThreadSummary } from '@resonant/shared';

  let {
    open,
    collapsed,
    threads,
    activeThreadId,
    ontogglesidebar,
    onselect,
    oncreate,
    ondelete,
    loadThreads,
  } = $props<{
    open: boolean;
    collapsed: boolean;
    threads: ThreadSummary[];
    activeThreadId: string | null;
    ontogglesidebar?: () => void;
    onselect?: (threadId: string) => void | Promise<void>;
    oncreate?: () => void | Promise<void>;
    ondelete?: (threadId: string) => void;
    loadThreads?: () => Promise<void> | void;
  }>();
</script>

{#if open}
  <button class="sidebar-overlay" onclick={ontogglesidebar} aria-label="Close sidebar"></button>
{/if}

<div class="sidebar" class:open={open} class:collapsed={collapsed}>
  <ThreadList
    {threads}
    {activeThreadId}
    {onselect}
    {oncreate}
    {ondelete}
    {loadThreads}
  />
</div>

<style>
  .sidebar-overlay {
    display: none;
  }

  .sidebar {
    width: var(--sidebar-width);
    height: 100%;
    flex-shrink: 0;
    background: var(--bg-primary);
    border-right: 1px solid var(--border);
    transition: width var(--transition-slow), opacity var(--transition);
    overflow: hidden;
  }

  .sidebar.collapsed {
    width: 0;
    border-right: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: 768px) {
    .sidebar-overlay {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 99;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s;
    }

    .sidebar-overlay:has(+ .sidebar.open) {
      opacity: 1;
      pointer-events: auto;
    }

    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      transform: translateX(-100%);
      transition: transform 0.3s;
      z-index: 100;
      width: 80%;
      max-width: 20rem;
    }

    .sidebar.open {
      transform: translateX(0);
    }
  }
</style>
