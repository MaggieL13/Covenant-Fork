<script lang="ts">
  import { resolveEffortForModel } from '@resonant/shared';

  let {
    models,
    model,
    modelAutonomous,
    thinkingEffort,
    onmodelchange,
    onautonomousmodelchange,
    onthinkingeffortchange,
  } = $props<{
    models: ReadonlyArray<{ id: string; label: string }>;
    model: string;
    modelAutonomous: string;
    thinkingEffort: string;
    onmodelchange?: (value: string) => void;
    onautonomousmodelchange?: (value: string) => void;
    onthinkingeffortchange?: (value: string) => void;
  }>();

  // Look up the human-readable label for a model id (falls back to the
  // raw id if the manifest doesn't carry a matching entry — happens for
  // legacy/exotic configs).
  function labelFor(id: string): string {
    return models.find((m: { id: string; label: string }) => m.id === id)?.label ?? id;
  }

  // When `thinkingEffort === 'auto'`, surface what each tier resolves
  // to so users can see the concrete value before committing. Mirrors
  // the backend resolver via the shared `resolveEffortForModel` helper.
  let autoChatResolved = $derived(resolveEffortForModel(model, 'auto'));
  let autoAutonomousResolved = $derived(resolveEffortForModel(modelAutonomous, 'auto'));

  // 'max' is documented as "Opus 4.6+ only" in the SDK type comments.
  // Picking it globally when the autonomous tier is on Sonnet/Haiku is a
  // quiet footgun: chat works, but autonomous wakes can fail at the API.
  // Surface a warning when the configured effort is max AND either
  // non-pulse model isn't an Opus variant. Match by id substring so
  // both pinned ids (`claude-opus-4-7`) and the family alias (`opus`)
  // count as Opus. Sonnet / Haiku / aliases / unknown future models all
  // trip the warning.
  function isOpus(id: string): boolean {
    return /opus/i.test(id);
  }
  let maxWarningTargets = $derived(
    thinkingEffort === 'max'
      ? [
          ...(isOpus(model) ? [] : [{ tier: 'chat', label: labelFor(model) }]),
          ...(isOpus(modelAutonomous) ? [] : [{ tier: 'autonomous', label: labelFor(modelAutonomous) }]),
        ]
      : [],
  );
</script>

<section class="section">
  <h3 class="section-title">Claude</h3>
  <p class="section-desc">Model selection and thinking behavior for the Claude Agent SDK.</p>

  <div class="field">
    <label class="field-label" for="pref-model">Chat Model</label>
    <select
      id="pref-model"
      class="field-select"
      value={model}
      onchange={(event) => onmodelchange?.((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each models as m}
        <option value={m.id}>{m.label}</option>
      {/each}
    </select>
    <span class="field-hint">Used when you send a message</span>
  </div>

  <div class="field">
    <label class="field-label" for="pref-model-auto">Autonomous Model</label>
    <select
      id="pref-model-auto"
      class="field-select"
      value={modelAutonomous}
      onchange={(event) => onautonomousmodelchange?.((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each models as m}
        <option value={m.id}>{m.label}</option>
      {/each}
    </select>
    <span class="field-hint">Used for scheduled wakes and autonomous actions</span>
  </div>

  <div class="field">
    <label class="field-label" for="pref-effort">Thinking Effort</label>
    <select
      id="pref-effort"
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
    <span class="field-hint">
      Applies to chat and autonomous turns. Pulse heartbeats don't use thinking.
    </span>
    {#if thinkingEffort === 'auto'}
      <span class="field-hint resolved-hint">
        Auto resolves to:
        Chat <strong>{labelFor(model)}</strong> → {autoChatResolved}
        · Autonomous <strong>{labelFor(modelAutonomous)}</strong> → {autoAutonomousResolved}
      </span>
    {/if}
    {#if maxWarningTargets.length > 0}
      <span class="field-hint warning-hint">
        ⚠️ Max may fail on non-Opus models. Your
        {maxWarningTargets.map((t) => `${t.tier} model is ${t.label}`).join(' and ')}.
        Switch to Auto, or pick XHigh, to avoid silent failures on those tiers.
      </span>
    {/if}
  </div>
</section>

<style>
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
</style>
