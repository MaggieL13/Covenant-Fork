<script lang="ts">
  interface UserRule {
    id: string;
    name: string;
    context?: string;
    allowedServers?: string[];
    blockedServers?: string[];
    trustLevel: 'full' | 'standard' | 'limited';
    relationship?: string;
  }

  type AddFormField = 'newRuleId' | 'newRuleName';

  let {
    rules,
    expandedRules,
    addForm,
    actionLoading,
    ontogglerule,
    onsaverule,
    ondeleterule,
    onstartadd,
    oncanceladd,
    onconfirmadd,
    onaddformupdate,
  } = $props<{
    rules: UserRule[];
    expandedRules: Set<string>;
    addForm: { addingRule: string | null; newRuleId: string; newRuleName: string };
    actionLoading: string | null;
    ontogglerule?: (key: string) => void;
    onsaverule?: (rule: UserRule) => void;
    ondeleterule?: (id: string) => void;
    onstartadd?: () => void;
    oncanceladd?: () => void;
    onconfirmadd?: () => void;
    onaddformupdate?: (key: AddFormField, value: string) => void;
  }>();
</script>

<div class="rules-list">
  {#each rules as rule (rule.id)}
    {@const key = `user-${rule.id}`}
    <div class="rule-card">
      <button class="rule-header" onclick={() => ontogglerule?.(key)}>
        <span class="rule-name">{rule.name}</span>
        <span class="rule-id">{rule.id}</span>
        <span class="chevron small" class:open={expandedRules.has(key)}>&#9656;</span>
      </button>
      {#if expandedRules.has(key)}
        <div class="rule-body">
          <label class="form-group">
            <span class="form-label">Name</span>
            <input type="text" class="form-input" bind:value={rule.name} />
          </label>
          <label class="form-group">
            <span class="form-label">Trust level</span>
            <select class="form-input" bind:value={rule.trustLevel}>
              <option value="full">Full</option>
              <option value="standard">Standard</option>
              <option value="limited">Limited</option>
            </select>
          </label>
          <label class="form-group">
            <span class="form-label">Relationship</span>
            <input type="text" class="form-input" bind:value={rule.relationship} />
          </label>
          <label class="form-group">
            <span class="form-label">Context</span>
            <textarea class="form-textarea" bind:value={rule.context} rows="3"></textarea>
          </label>
          <label class="form-group">
            <span class="form-label">Allowed servers (IDs)</span>
            <input
              type="text"
              class="form-input"
              value={(rule.allowedServers || []).join(', ')}
              onchange={(e) => rule.allowedServers = (e.currentTarget as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean)}
            />
          </label>
          <label class="form-group">
            <span class="form-label">Blocked servers (IDs)</span>
            <input
              type="text"
              class="form-input"
              value={(rule.blockedServers || []).join(', ')}
              onchange={(e) => rule.blockedServers = (e.currentTarget as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean)}
            />
          </label>
          <div class="rule-actions">
            <button class="btn btn-primary" onclick={() => onsaverule?.(rule)} disabled={actionLoading === `save-user-${rule.id}`}>
              {actionLoading === `save-user-${rule.id}` ? 'Saving...' : 'Save'}
            </button>
            <button class="btn btn-danger" onclick={() => ondeleterule?.(rule.id)} disabled={actionLoading === `delete-user-${rule.id}`}>
              {actionLoading === `delete-user-${rule.id}` ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/each}

  {#if addForm.addingRule === 'user'}
    <div class="rule-card add-form">
      <label class="form-group">
        <span class="form-label">User ID</span>
        <input type="text" class="form-input" value={addForm.newRuleId} oninput={(e) => onaddformupdate?.('newRuleId', (e.currentTarget as HTMLInputElement).value)} placeholder="Discord user ID" />
      </label>
      <label class="form-group">
        <span class="form-label">Name</span>
        <input type="text" class="form-input" value={addForm.newRuleName} oninput={(e) => onaddformupdate?.('newRuleName', (e.currentTarget as HTMLInputElement).value)} placeholder="User name" />
      </label>
      <div class="rule-actions">
        <button class="btn btn-primary" onclick={() => onconfirmadd?.()} disabled={!addForm.newRuleId || !addForm.newRuleName}>Add</button>
        <button class="btn btn-muted" onclick={() => oncanceladd?.()}>Cancel</button>
      </div>
    </div>
  {:else}
    <button class="btn btn-muted add-btn" onclick={() => onstartadd?.()}>+ Add user rule</button>
  {/if}
</div>

<style>
  .chevron.small {
    font-size: 0.625rem;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .rules-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-top: 0.5rem;
  }

  .rule-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .rule-card.add-form {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .rule-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    text-align: left;
  }

  .rule-header:hover {
    background: var(--bg-hover);
  }

  .rule-name {
    font-size: 0.8125rem;
    color: var(--text-primary);
    flex: 1;
  }

  .rule-id {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-family: var(--font-mono, monospace);
  }

  .rule-body {
    padding: 0.75rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .rule-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .add-btn {
    margin-top: 0.5rem;
    width: 100%;
    text-align: center;
    padding: 0.5rem;
  }
</style>
