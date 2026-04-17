<script lang="ts">
  import type { Player } from '$lib/uno/types';

  let { winner, onPlayAgain, onBackToChat } = $props<{
    winner: Player;
    onPlayAgain: () => void;
    onBackToChat: () => void;
  }>();
</script>

<div class="uno-modal-backdrop" role="dialog" aria-modal="true" aria-label="Round over">
  <div class="uno-winner">
    <span class="uno-winner__sigil" aria-hidden="true">{winner.sigil || '👑'}</span>
    <h2 class="uno-winner__title">{winner.name} wins the round</h2>
    <div class="uno-winner__actions">
      <button type="button" class="res-btn uno-winner__btn" onclick={onPlayAgain}>Play again</button>
      <button type="button" class="res-btn uno-winner__btn uno-winner__btn--secondary" onclick={onBackToChat}>Back to chat</button>
    </div>
  </div>
</div>
