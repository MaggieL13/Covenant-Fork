<script lang="ts">
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
      <option value="max">Max — always thinks deeply, no constraints</option>
      <option value="high">High — almost always thinks (default)</option>
      <option value="medium">Medium — thinks when needed, skips simple stuff</option>
      <option value="low">Low — minimal thinking, fastest responses</option>
    </select>
    <span class="field-hint">How much the model reasons before responding. Higher = smarter but slower</span>
  </div>
</section>
