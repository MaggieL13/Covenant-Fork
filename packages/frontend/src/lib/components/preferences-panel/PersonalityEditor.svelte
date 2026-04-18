<script lang="ts">
  let {
    editor,
    ontogglerawmode,
    onpersonalitycontentchange,
    onguidedpersonalitychange,
    onguidedcommstylechange,
    onguidedinterestschange,
    onguidedusercontextchange,
    onsave,
    onreset,
  } = $props<{
    editor: {
      rawMode: boolean;
      personalityContent: string;
      guidedPersonality: string;
      guidedCommStyle: string;
      guidedInterests: string;
      guidedUserContext: string;
      savingPersonality: boolean;
      personalityMessage: string | null;
    };
    ontogglerawmode?: (rawMode: boolean) => void;
    onpersonalitycontentchange?: (value: string) => void;
    onguidedpersonalitychange?: (value: string) => void;
    onguidedcommstylechange?: (value: string) => void;
    onguidedinterestschange?: (value: string) => void;
    onguidedusercontextchange?: (value: string) => void;
    onsave?: () => void;
    onreset?: () => void;
  }>();
</script>

<section class="section">
  <h3 class="section-title">Personality</h3>
  <p class="section-desc">Your companion's personality and behavior instructions.</p>

  <div class="mode-toggle">
    <button class="mode-btn" class:active={!editor.rawMode} onclick={() => ontogglerawmode?.(false)}>Guided</button>
    <button class="mode-btn" class:active={editor.rawMode} onclick={() => ontogglerawmode?.(true)}>Raw Editor</button>
  </div>

  {#if editor.rawMode}
    <textarea
      class="raw-editor"
      rows="16"
      placeholder="Write personality in markdown..."
      value={editor.personalityContent}
      oninput={(event) => onpersonalitycontentchange?.((event.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
  {:else}
    <div class="field">
      <label class="field-label" for="pref-personality">What's their personality like?</label>
      <textarea
        id="pref-personality"
        class="field-textarea"
        rows="3"
        placeholder="e.g. Warm, nerdy, a bit sarcastic..."
        value={editor.guidedPersonality}
        oninput={(event) => onguidedpersonalitychange?.((event.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>
    </div>
    <div class="field">
      <label class="field-label" for="pref-commstyle">How do they talk?</label>
      <textarea
        id="pref-commstyle"
        class="field-textarea"
        rows="3"
        placeholder="e.g. Casual, uses emojis..."
        value={editor.guidedCommStyle}
        oninput={(event) => onguidedcommstylechange?.((event.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>
    </div>
    <div class="field">
      <label class="field-label" for="pref-interests">What are they interested in?</label>
      <textarea
        id="pref-interests"
        class="field-textarea"
        rows="3"
        placeholder="e.g. Coding, music, cooking..."
        value={editor.guidedInterests}
        oninput={(event) => onguidedinterestschange?.((event.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>
    </div>
    <div class="field">
      <label class="field-label" for="pref-userctx">What should they know about you?</label>
      <textarea
        id="pref-userctx"
        class="field-textarea"
        rows="3"
        placeholder="e.g. Developer, has a cat named Pixel..."
        value={editor.guidedUserContext}
        oninput={(event) => onguidedusercontextchange?.((event.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>
    </div>
  {/if}

  <div class="personality-actions">
    <button class="save-btn" onclick={() => onsave?.()} disabled={editor.savingPersonality}>
      {editor.savingPersonality ? 'Saving...' : 'Save Personality'}
    </button>
    <button class="secondary-btn" onclick={() => onreset?.()}>Reset to Default</button>
  </div>
  {#if editor.personalityMessage}
    <p class="status-msg">{editor.personalityMessage}</p>
  {/if}
</section>

<style>
  .mode-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 1rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    width: fit-content;
  }

  .mode-btn {
    padding: 0.375rem 0.875rem;
    font-size: 0.8125rem;
    font-family: inherit;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }

  .mode-btn:not(:last-child) {
    border-right: 1px solid var(--border);
  }

  .mode-btn.active {
    background: var(--gold-ember);
    color: var(--text-primary);
  }

  .raw-editor {
    width: 100%;
    padding: 0.75rem;
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--text-primary);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: vertical;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .raw-editor:focus {
    outline: none;
    border-color: var(--gold-dim);
    box-shadow: 0 0 0 2px rgba(196, 168, 114, 0.08);
  }

  .field-textarea {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    font-family: inherit;
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: vertical;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .field-textarea:focus {
    outline: none;
    border-color: var(--gold-dim);
    box-shadow: 0 0 0 2px rgba(196, 168, 114, 0.08);
  }

  .personality-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
    align-items: center;
  }

  .secondary-btn {
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-family: var(--font-heading);
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: color var(--transition), border-color var(--transition);
  }

  .secondary-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .status-msg {
    font-size: 0.8125rem;
    color: var(--gold);
    margin: 0.5rem 0 0;
  }
</style>
