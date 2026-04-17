<script lang="ts">
  let { visible, onclick } = $props<{ visible: boolean; onclick: () => void }>();
</script>

{#if visible}
  <button type="button" class="uno-call-btn" onclick={onclick} aria-label="Call UNO">
    UNO!
  </button>
{/if}
