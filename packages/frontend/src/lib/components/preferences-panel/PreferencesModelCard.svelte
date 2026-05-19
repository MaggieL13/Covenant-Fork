<script lang="ts">
  import { onMount } from 'svelte';
  import { resolveEffortForModel, getEffortOptionsForProvider, coerceEffortForProvider, MODELS, type ProviderId } from '@resonant/shared';

  /**
   * Provider for a bare model id (e.g. `claude-sonnet-4-6`, `gpt-5.5`)
   * looked up via the shared manifest. Falls back to `'claude'` for
   * unknown ids — that's the pre-arc default and keeps the dropdown
   * showing something sensible if the manifest hasn't caught up to
   * an experimental id the user pasted in.
   */
  function providerForModelId(id: string): ProviderId {
    return MODELS.find((m) => m.id === id)?.provider ?? 'claude';
  }

  let {
    models,
    model,
    modelAutonomous,
    modelMemory,
    thinkingEffort,
    thinkingEffortAutonomous,
    onmodelchange,
    onautonomousmodelchange,
    onmemorymodelchange,
    onthinkingeffortchange,
    onautonomouseffortchange,
  } = $props<{
    models: ReadonlyArray<{ id: string; label: string }>;
    model: string;
    modelAutonomous: string;
    /** PR D: memory tier model — drives the ProviderHandoff summary call
     *  when a thread switches to a (runtime, provider, model_ref) combo
     *  with no prior session. Cheap-model default (Haiku); users can pick
     *  e.g. Sonnet for richer cross-provider summaries at higher cost
     *  per switch. No effort field — the call is one-shot read-only and
     *  doesn't use extended thinking. */
    modelMemory: string;
    thinkingEffort: string;
    /** Empty string means "match chat tier" (the default — autonomous
     *  inherits chat's effort, pre-PR-#10 behavior). Any other value is
     *  an explicit per-tier override. */
    thinkingEffortAutonomous: string;
    onmodelchange?: (value: string) => void;
    onautonomousmodelchange?: (value: string) => void;
    onmemorymodelchange?: (value: string) => void;
    onthinkingeffortchange?: (value: string) => void;
    onautonomouseffortchange?: (value: string) => void;
  }>();

  function labelFor(id: string): string {
    return models.find((m: { id: string; label: string }) => m.id === id)?.label ?? id;
  }

  function isOpus(id: string): boolean {
    return /opus/i.test(id);
  }

  // Auto resolution display per tier — driven by `$derived` so values
  // update live as the user changes either model dropdown.
  let autoChatResolved = $derived(resolveEffortForModel(model, 'auto'));
  let autoAutonomousResolved = $derived(resolveEffortForModel(modelAutonomous, 'auto'));

  // Provider-shaped effort options per tier. When the user switches the
  // model dropdown to a Codex entry, the effort dropdown re-renders with
  // Codex's vocabulary (none / minimal / low / medium / high / xhigh,
  // no `max`); Claude entries keep Claude's vocabulary (low / medium /
  // high / xhigh / max, no `none` / `minimal`). See
  // `shared/codex-runtime-lab-findings-2026-05-19.md` followup #4.
  let chatProvider = $derived(providerForModelId(model));
  let autonomousProvider = $derived(providerForModelId(modelAutonomous));
  let chatEffortOptions = $derived(getEffortOptionsForProvider(chatProvider));
  let autonomousEffortOptions = $derived(getEffortOptionsForProvider(autonomousProvider));

  // Model-change handlers that sanitize the effort selection when the
  // new provider's vocabulary doesn't include the previously-selected
  // value. Without this, switching from Claude to Codex would leave
  // `max` lingering in `thinkingEffort` (Codex has no `max`) and a
  // subsequent save would send a provider-mismatched value the runtime
  // silently re-maps. See `coerceEffortForProvider` doc.
  function handleChatModelChange(newModel: string) {
    onmodelchange?.(newModel);
    const newProvider = providerForModelId(newModel);
    const coerced = coerceEffortForProvider(newProvider, thinkingEffort);
    if (coerced !== thinkingEffort) {
      onthinkingeffortchange?.(coerced);
    }
  }

  function handleAutonomousModelChange(newModel: string) {
    onautonomousmodelchange?.(newModel);
    // Empty string is the "Match Chat" sentinel — that's user intent and
    // shouldn't be sanitized as if it were a real effort value. The
    // effective-effort computation below handles the mismatch case.
    if (thinkingEffortAutonomous === '') return;
    const newProvider = providerForModelId(newModel);
    const coerced = coerceEffortForProvider(newProvider, thinkingEffortAutonomous);
    if (coerced !== thinkingEffortAutonomous) {
      onautonomouseffortchange?.(coerced);
    }
  }

  // Self-heal on mount: if the saved config carries an effort that's
  // invalid for its tier's current model provider (e.g. config has
  // `thinking_effort: max` but the user's chat model is now Codex),
  // the dropdown would otherwise show no selection and a stale Save
  // would persist the invalid value. Fire the coerce-to-auto change
  // once on load so the UI lands in a self-consistent state. The
  // user-facing trade-off is a single immediate dirty-form mark on
  // open, which is the right behavior — the saved config WAS stale.
  onMount(() => {
    if (thinkingEffort) {
      const coerced = coerceEffortForProvider(chatProvider, thinkingEffort);
      if (coerced !== thinkingEffort) onthinkingeffortchange?.(coerced);
    }
    if (thinkingEffortAutonomous !== '') {
      const coerced = coerceEffortForProvider(autonomousProvider, thinkingEffortAutonomous);
      if (coerced !== thinkingEffortAutonomous) onautonomouseffortchange?.(coerced);
    }
  });

  // The autonomous-tier effort that's actually in effect right now.
  // When the override is unset (empty string), autonomous inherits from
  // chat — that's the back-compat fallback PR #10 preserves. When the
  // inherited value isn't valid for the autonomous provider (chat =
  // Codex with `none`, autonomous = Claude), the coercion downgrades to
  // `'auto'` so the user's display matches what the backend will
  // actually dispatch. `matchChatMismatchWarning` below surfaces the
  // mismatch so the user knows `none` won't carry over verbatim.
  let effectiveAutonomousEffort = $derived(
    thinkingEffortAutonomous || coerceEffortForProvider(autonomousProvider, thinkingEffort),
  );
  let matchChatMismatchWarning = $derived(
    thinkingEffortAutonomous === ''
      && thinkingEffort !== 'auto'
      && coerceEffortForProvider(autonomousProvider, thinkingEffort) === 'auto'
      && coerceEffortForProvider(chatProvider, thinkingEffort) === thinkingEffort
      ? `Chat effort "${thinkingEffort}" isn't valid on ${labelFor(modelAutonomous)} — autonomous wakes will use Auto.`
      : null,
  );

  // Max-effort warnings PER TIER. The dilemma the warning surfaced in
  // PR #9 (one tier wants Max, another can't accept it) is now resolvable
  // via the per-tier override, but the warning still has value when a
  // user explicitly picks Max on a non-Opus tier.
  let chatMaxWarning = $derived(
    thinkingEffort === 'max' && !isOpus(model)
      ? `Max may fail on ${labelFor(model)}. Consider Auto or XHigh.`
      : null,
  );
  let autonomousMaxWarning = $derived(
    effectiveAutonomousEffort === 'max' && !isOpus(modelAutonomous)
      ? `Max may fail on ${labelFor(modelAutonomous)}. Consider Auto or XHigh.`
      : null,
  );
</script>

<section class="section">
  <h3 class="section-title">Claude</h3>
  <p class="section-desc">Model selection and thinking behavior for the Claude Agent SDK.</p>

  <div class="field">
    <label class="field-label" for="pref-provider">Provider</label>
    <select id="pref-provider" class="field-select" disabled value="claude">
      <option value="claude">Claude (more providers coming)</option>
    </select>
    <span class="field-hint">
      Currently locked to Claude. Multi-provider support is planned.
    </span>
  </div>

  <div class="tier-grid">
    <div class="tier-col">
      <h4 class="tier-title">Chat</h4>
      <p class="tier-sub">Interactive turns — when you send a message</p>

      <div class="field">
        <label class="field-label" for="pref-chat-model">Model</label>
        <select
          id="pref-chat-model"
          class="field-select"
          value={model}
          onchange={(event) => handleChatModelChange((event.currentTarget as HTMLSelectElement).value)}
        >
          {#each models as m}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label class="field-label" for="pref-chat-effort">Thinking Effort</label>
        <select
          id="pref-chat-effort"
          class="field-select"
          value={thinkingEffort}
          onchange={(event) => onthinkingeffortchange?.((event.currentTarget as HTMLSelectElement).value)}
        >
          {#each chatEffortOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
        {#if thinkingEffort === 'auto'}
          <span class="field-hint resolved-hint">
            Auto on <strong>{labelFor(model)}</strong> → {autoChatResolved}
          </span>
        {/if}
        {#if chatMaxWarning}
          <span class="field-hint warning-hint">⚠️ {chatMaxWarning}</span>
        {/if}
      </div>
    </div>

    <div class="tier-col">
      <h4 class="tier-title">Autonomous</h4>
      <p class="tier-sub">Wakes, watchers, scribe, impulses — when the agent acts on its own</p>

      <div class="field">
        <label class="field-label" for="pref-auto-model">Model</label>
        <select
          id="pref-auto-model"
          class="field-select"
          value={modelAutonomous}
          onchange={(event) => handleAutonomousModelChange((event.currentTarget as HTMLSelectElement).value)}
        >
          {#each models as m}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label class="field-label" for="pref-auto-effort">Thinking Effort</label>
        <select
          id="pref-auto-effort"
          class="field-select"
          value={thinkingEffortAutonomous}
          onchange={(event) => onautonomouseffortchange?.((event.currentTarget as HTMLSelectElement).value)}
        >
          <!-- Empty string = "match chat tier" — preserves pre-PR-#10
               back-compat behavior when the user hasn't customized.
               Stays first regardless of provider; options below are
               provider-shaped per the autonomous-tier model selection. -->
          <option value="">Match Chat (currently {thinkingEffort})</option>
          {#each autonomousEffortOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
        {#if effectiveAutonomousEffort === 'auto'}
          <span class="field-hint resolved-hint">
            Auto on <strong>{labelFor(modelAutonomous)}</strong> → {autoAutonomousResolved}
          </span>
        {/if}
        {#if autonomousMaxWarning}
          <span class="field-hint warning-hint">⚠️ {autonomousMaxWarning}</span>
        {/if}
        {#if matchChatMismatchWarning}
          <span class="field-hint warning-hint">⚠️ {matchChatMismatchWarning}</span>
        {/if}
      </div>
    </div>
  </div>

  <div class="memory-row">
    <h4 class="tier-title">Memory</h4>
    <p class="tier-sub">
      Cross-provider continuity — generates a short summary of prior conversation
      when you switch models mid-thread and no session exists for the new combo.
      One-shot, read-only, no tools or thinking. Defaults to Haiku (cheap +
      reliable for short summaries); pick a heavier model only if you want
      richer cross-provider handoffs at higher per-switch cost.
    </p>

    <div class="field">
      <label class="field-label" for="pref-memory-model">Model</label>
      <select
        id="pref-memory-model"
        class="field-select"
        value={modelMemory}
        onchange={(event) => onmemorymodelchange?.((event.currentTarget as HTMLSelectElement).value)}
      >
        {#each models as m}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
      <span class="field-hint">
        Falls back to extractive summary (no model call) if this model is unavailable.
      </span>
    </div>
  </div>

  <p class="footer-hint">
    ⓘ Pulse heartbeats configured in the Orchestrator tab. Pulse never uses thinking,
    so there's no effort field for that tier.
  </p>
</section>

<style>
  .tier-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
    margin-top: 0.75rem;
  }
  @media (max-width: 720px) {
    .tier-grid {
      grid-template-columns: 1fr;
    }
  }
  .tier-col {
    border: 1px solid rgba(155, 114, 207, 0.2);
    border-radius: 0.5rem;
    padding: 0.875rem;
    background: rgba(255, 255, 255, 0.015);
  }
  .tier-title {
    margin: 0 0 0.125rem 0;
    font-size: 0.95rem;
  }
  .tier-sub {
    margin: 0 0 0.75rem 0;
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .resolved-hint {
    margin-top: 0.25rem;
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .resolved-hint strong {
    color: var(--text);
    font-weight: 500;
  }
  .warning-hint {
    margin-top: 0.375rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.25rem;
    background: rgba(220, 180, 80, 0.1);
    color: rgb(200, 160, 80);
    font-size: 0.75rem;
  }
  .memory-row {
    margin-top: 1rem;
    border: 1px solid rgba(155, 114, 207, 0.2);
    border-radius: 0.5rem;
    padding: 0.875rem;
    background: rgba(255, 255, 255, 0.015);
  }
  .footer-hint {
    margin-top: 1rem;
    color: var(--text-muted);
    font-size: 0.75rem;
  }
</style>
