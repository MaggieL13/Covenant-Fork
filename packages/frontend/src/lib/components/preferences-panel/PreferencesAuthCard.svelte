<script lang="ts">
  let {
    hasPassword,
    newPassword,
    onpasswordchange,
  } = $props<{
    hasPassword: boolean;
    newPassword: string;
    onpasswordchange?: (value: string) => void;
  }>();
</script>

<section class="section">
  <h3 class="section-title">Security</h3>
  <p class="section-desc">
    {#if hasPassword}
      Password is set. Leave blank to keep current password.
    {:else}
      No password set. Access is open to anyone on the network.
    {/if}
  </p>

  <div class="field">
    <label class="field-label" for="pref-password">
      {hasPassword ? 'Change Password' : 'Set Password'}
    </label>
    <input
      id="pref-password"
      type="password"
      class="field-input"
      value={newPassword}
      oninput={(event) => onpasswordchange?.((event.currentTarget as HTMLInputElement).value)}
      placeholder="Leave blank to keep unchanged"
    />
  </div>
</section>
