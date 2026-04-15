<script lang="ts">
  import SearchPanel from '$lib/components/SearchPanel.svelte';

  let {
    open = false,
    onresult,
    onclose,
  } = $props<{
    open: boolean;
    onresult?: (result: { messageId: string; threadId: string }) => void;
    onclose?: () => void;
  }>();
</script>

{#if open}
  <SearchPanel onresult={onresult} onclose={onclose} />
{/if}
