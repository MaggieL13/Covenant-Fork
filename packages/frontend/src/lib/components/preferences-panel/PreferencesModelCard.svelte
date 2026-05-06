<script lang="ts">
  import { resolveEffortForModel } from '@resonant/shared';

  let {
    models,
    model,
    modelAutonomous,
    thinkingEffort,
    thinkingEffortAutonomous,
    onmodelchange,
    onautonomousmodelchange,
    onthinkingeffortchange,
    onautonomouseffortchange,
  } = $props<{
    models: ReadonlyArray<{ id: string; label: string }>;
    model: string;
    modelAutonomous: string;
    thinkingEffort: string;
    /** Empty string means "match chat tier" (the default — autonomous
     *  inherits chat's effort, pre-PR-#10 behavior). Any other value is
     *  an explicit per-tier override. */
    thinkingEffortAutonomous: string;
    onmodelchange?: (value: string) => void;
    onautonomousmodelchange?: (value: string) => void;
    onthinkingeffortchange?: (value: string) => void;
    onautonomouseffortchange?: (value: string) => void;
  }>();

  function labelFor(id: string): string {
    return models.find((m: { id: string; label: string }) => m.id === id)?.label ?? id;
  }

  function isOpus(id: string): boolean {
    return /opus/i.test(id);
  }

  // The autonomous-tier effort that's actually in effect right now.
  // When the override is unset (empty string), autonomous inherits from
  // chat — that's the back-compat fallback PR #10 preserves. Used for
  // both the dynamic resolution display and the Max-warning logic.
  let effectiveAutonomousEffort = $derived(
    thinkingEffortAutonomous || thinkingEffort,
  );

  // Auto resolution display per tier — driven by `$derived` so values
  // update live as the user changes either model dropdown.
  let autoChatResolved = $derived(resolveEffortForModel(model, 'auto'));
  let autoAutonomousResolved = $derived(resolveEffortForModel(modelAutonomous, 'auto'));

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
          onchange={(event) => onmodelchange?.((event.currentTarget as HTMLSelectElement).value)}
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
          <option value="auto">Auto — picks safely per model (recommended)</option>
          <option value="max">Max — frontier reasoning, spend freely (Opus 4.6+ only)</option>
          <option value="xhigh">XHigh — deep agentic/coding work</option>
          <option value="high">High — solid reasoning</option>
          <option value="medium">Medium — thinks when needed</option>
          <option value="low">Low — minimal thinking, fastest responses</option>
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
          onchange={(event) => onautonomousmodelchange?.((event.currentTarget as HTMLSelectElement).value)}
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
               back-compat behavior when the user hasn't customized. -->
          <option value="">Match Chat (currently {thinkingEffort})</option>
          <option value="auto">Auto — picks safely per model (recommended)</option>
          <option value="max">Max — frontier reasoning, spend freely (Opus 4.6+ only)</option>
          <option value="xhigh">XHigh — deep agentic/coding work</option>
          <option value="high">High — solid reasoning</option>
          <option value="medium">Medium — thinks when needed</option>
          <option value="low">Low — minimal thinking, fastest responses</option>
        </select>
        {#if effectiveAutonomousEffort === 'auto'}
          <span class="field-hint resolved-hint">
            Auto on <strong>{labelFor(modelAutonomous)}</strong> → {autoAutonomousResolved}
          </span>
        {/if}
        {#if autonomousMaxWarning}
          <span class="field-hint warning-hint">⚠️ {autonomousMaxWarning}</span>
        {/if}
      </div>
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
  .footer-hint {
    margin-top: 1rem;
    color: var(--text-muted);
    font-size: 0.75rem;
  }
</style>
