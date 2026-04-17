<script lang="ts">
  import type { CommandRegistryEntry } from '@resonant/shared';
  import CommandPalette from '../CommandPalette.svelte';

  let {
    visible,
    filter,
    commands,
    onselect,
    onclose,
    onregisterapi,
  } = $props<{
    visible: boolean;
    filter: string;
    commands: CommandRegistryEntry[];
    onselect: (command: CommandRegistryEntry) => void;
    onclose: () => void;
    onregisterapi?: (api: { handleKey: (event: KeyboardEvent) => boolean }) => void;
  }>();

  let paletteRef = $state<CommandPalette | undefined>();

  $effect(() => {
    // ORDER: register the live palette key handler only after the inner CommandPalette instance has bound so parent key delegation targets the current panel.
    onregisterapi?.({
      handleKey: (event: KeyboardEvent) => paletteRef?.handleKey(event) ?? false,
    });
  });
</script>

{#if visible}
  <CommandPalette
    bind:this={paletteRef}
    filter={filter}
    commands={commands}
    onselect={onselect}
    onclose={onclose}
  />
{/if}
