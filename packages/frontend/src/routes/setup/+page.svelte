<script lang="ts">
  import { onMount } from 'svelte';

  // --- State ---
  let step = $state(1);
  let saving = $state(false);
  let error = $state('');

  // Step 1
  let companionName = $state('');
  let userName = $state('');
  let timezone = $state('');
  let password = $state('');

  // Step 2
  let rawMode = $state(false);
  let rawPersonality = $state('');
  let personalityDesc = $state('');
  let commStyle = $state('');
  let interests = $state('');
  let userContext = $state('');
  let useDefault = $state(false);

  // Timezone options
  const timezones = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
    'America/Sao_Paulo',
    'America/Argentina/Buenos_Aires',
    'America/Asuncion',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Moscow',
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Asia/Kolkata',
    'Asia/Dubai',
    'Australia/Sydney',
    'Pacific/Auckland',
  ];

  onMount(() => {
    // Auto-detect timezone
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (timezones.includes(detected)) {
        timezone = detected;
      } else {
        // If detected timezone isn't in our list, add it at the top
        timezones.unshift(detected);
        timezone = detected;
      }
    } catch {
      timezone = 'America/New_York';
    }

    // Check if setup is already done
    checkSetupStatus();
  });

  async function checkSetupStatus() {
    try {
      const res = await fetch('/api/setup/status');
      if (res.ok) {
        const data = await res.json();
        if (!data.needsSetup) {
          window.location.href = '/chat';
        }
      }
    } catch {
      // Server not reachable — stay on page
    }
  }

  function assemblePersonality(): string {
    if (useDefault) return '';

    if (rawMode && rawPersonality.trim()) {
      return rawPersonality.trim();
    }

    const name = companionName || 'Echo';
    const sections: string[] = [];

    sections.push(`# ${name}'s Personality`);
    sections.push('');

    if (personalityDesc.trim()) {
      sections.push('## Personality');
      sections.push(personalityDesc.trim());
      sections.push('');
    }

    if (commStyle.trim()) {
      sections.push('## Communication Style');
      sections.push(commStyle.trim());
      sections.push('');
    }

    if (interests.trim()) {
      sections.push('## Interests');
      sections.push(interests.trim());
      sections.push('');
    }

    if (userContext.trim()) {
      sections.push('## About the User');
      sections.push(userContext.trim());
      sections.push('');
    }

    return sections.join('\n');
  }

  async function completeSetup() {
    saving = true;
    error = '';

    try {
      const personality = assemblePersonality();

      const res = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companionName: companionName || 'Echo',
          userName: userName || 'User',
          timezone,
          password: password || null,
          personality: personality || null,
          useDefault,
        }),
      });

      if (res.ok) {
        window.location.href = '/chat';
      } else {
        const data = await res.json().catch(() => ({}));
        error = data.error || 'Setup failed. Please try again.';
        saving = false;
      }
    } catch {
      error = 'Could not reach the server. Please try again.';
      saving = false;
    }
  }
</script>

<div class="setup-page">
  <div class="setup-card">
    <!-- Progress dots -->
    <div class="progress">
      {#each [1, 2, 3] as s}
        <button
          class="dot"
          class:active={step === s}
          class:done={step > s}
          onclick={() => { if (s < step) step = s; }}
          aria-label="Step {s}"
          disabled={s > step}
        >
          {#if step > s}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          {:else}
            {s}
          {/if}
        </button>
      {/each}
    </div>

    <!-- Step 1: Meet Your Companion -->
    {#if step === 1}
      <div class="step">
        <h2>Meet Your Companion</h2>
        <p class="subtitle">Let's set up the basics.</p>

        <label class="field">
          <span class="field-label">What should they be called?</span>
          <input type="text" bind:value={companionName} placeholder="Echo" />
        </label>

        <label class="field">
          <span class="field-label">And your name?</span>
          <input type="text" bind:value={userName} placeholder="Your name" />
        </label>

        <label class="field">
          <span class="field-label">Your timezone</span>
          <select bind:value={timezone}>
            {#each timezones as tz}
              <option value={tz}>{tz.replace(/_/g, ' ')}</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span class="field-label">
            Set a password <span class="optional">(optional — leave blank for local use)</span>
          </span>
          <input type="password" bind:value={password} placeholder="Optional" />
        </label>

        <button class="btn primary" onclick={() => step = 2}>Next</button>
      </div>
    {/if}

    <!-- Step 2: Give Them a Soul -->
    {#if step === 2}
      <div class="step">
        <h2>Give Them a Soul</h2>
        <p class="subtitle">Describe who {companionName || 'they'} should be.</p>

        <div class="mode-toggle">
          <button class="toggle-btn" class:active={!rawMode} onclick={() => rawMode = false}>Guided</button>
          <button class="toggle-btn" class:active={rawMode} onclick={() => rawMode = true}>Raw Editor</button>
        </div>

        {#if rawMode}
          <textarea
            bind:value={rawPersonality}
            class="raw-editor"
            rows="16"
            placeholder="Write your companion's personality in markdown..."
          ></textarea>
        {:else}
          <label class="field">
            <span class="field-label">What's their personality like?</span>
            <textarea bind:value={personalityDesc} rows="3"
              placeholder="e.g. Warm and nerdy, a bit sarcastic but always kind..."
            ></textarea>
          </label>

          <label class="field">
            <span class="field-label">How do they talk?</span>
            <textarea bind:value={commStyle} rows="3"
              placeholder="e.g. Casual, uses emojis sometimes, drops in references..."
            ></textarea>
          </label>

          <label class="field">
            <span class="field-label">What are they interested in?</span>
            <textarea bind:value={interests} rows="3"
              placeholder="e.g. Coding, music production, cooking, space..."
            ></textarea>
          </label>

          <label class="field">
            <span class="field-label">Anything they should know about you?</span>
            <textarea bind:value={userContext} rows="3"
              placeholder="e.g. I'm a developer, I have a cat named Pixel..."
            ></textarea>
          </label>
        {/if}

        <div class="step-actions">
          <button class="btn secondary" onclick={() => step = 1}>Back</button>
          <button class="btn primary" onclick={() => step = 3}>Next</button>
          <button class="btn skip" onclick={() => { useDefault = true; step = 3; }}>
            Use default personality
          </button>
        </div>
      </div>
    {/if}

    <!-- Step 3: You're All Set -->
    {#if step === 3}
      <div class="step">
        <h2>You're All Set!</h2>
        <p class="subtitle">Here's what we've configured:</p>

        <div class="summary">
          <div class="summary-item">
            <span class="summary-label">Companion</span>
            <span class="summary-value">{companionName || 'Echo'}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Your name</span>
            <span class="summary-value">{userName || 'User'}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Timezone</span>
            <span class="summary-value">{timezone.replace(/_/g, ' ')}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Password</span>
            <span class="summary-value">{password ? 'Set' : 'None (local only)'}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Personality</span>
            <span class="summary-value">{useDefault ? 'Default' : 'Custom'}</span>
          </div>
        </div>

        {#if error}
          <div class="error-message" role="alert">{error}</div>
        {/if}

        <div class="step-actions">
          <button class="btn secondary" onclick={() => { useDefault = false; step = 2; }}>Back</button>
          <button class="btn primary launch" onclick={completeSetup} disabled={saving}>
            {saving ? 'Setting up...' : 'Start Chatting \u2192'}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* ─── Page shell ─── */
  .setup-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    background: var(--bg-primary);
    padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1rem calc(env(safe-area-inset-bottom, 0px) + 1rem);
    position: relative;
    overflow-y: auto;
  }

  /* Subtle radial glow — violet from center */
  .setup-page::before {
    content: '';
    position: fixed;
    top: 30%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 700px;
    height: 500px;
    background: radial-gradient(ellipse, var(--gold-ember) 0%, transparent 70%);
    pointer-events: none;
  }

  /* ─── Card — gothic sanctum feel ─── */
  .setup-card {
    width: 100%;
    max-width: 560px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-image: linear-gradient(
      135deg,
      rgba(155, 114, 207, 0.3),
      rgba(155, 114, 207, 0.05) 30%,
      rgba(155, 114, 207, 0.05) 70%,
      rgba(155, 114, 207, 0.3)
    ) 1;
    border-radius: var(--radius-card);
    padding: var(--space-8) var(--space-6);
    position: relative;
    z-index: 1;
    box-shadow: var(--shadow-lg);
  }

  @media (max-width: 600px) {
    .setup-card {
      padding: var(--space-6) var(--space-4);
      border-radius: var(--radius);
    }
  }

  /* ─── Progress dots ─── */
  .progress {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    margin-bottom: var(--space-8);
  }

  .dot {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-sm);
    font-weight: 600;
    border: 2px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-muted);
    transition: all var(--transition);
    cursor: default;
  }

  .dot.active {
    border-color: var(--accent);
    background: var(--gold-glow);
    color: var(--accent-hover);
    box-shadow: 0 0 12px rgba(155, 114, 207, 0.2);
  }

  .dot.done {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }

  .dot:disabled:not(.done) {
    cursor: default;
    opacity: 1;
  }

  /* ─── Step content ─── */
  .step {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  h2 {
    font-family: var(--font-heading);
    font-size: var(--text-2xl);
    font-weight: 600;
    color: var(--text-primary);
    text-align: center;
    letter-spacing: -0.01em;
  }

  .subtitle {
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-base);
    margin-top: calc(var(--space-2) * -1);
  }

  /* ─── Form fields ─── */
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .field-label {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .optional {
    color: var(--text-muted);
    font-weight: 400;
  }

  .field input,
  .field select,
  .field textarea {
    width: 100%;
    padding: 0.75rem 1rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-primary);
    font-size: var(--text-base);
    font-family: var(--font-body);
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .field input:focus,
  .field select:focus,
  .field textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(155, 114, 207, 0.2), 0 0 20px rgba(155, 114, 207, 0.1);
  }

  .field input::placeholder,
  .field textarea::placeholder {
    color: var(--text-muted);
  }

  .field select {
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237d8494' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 1rem center;
    padding-right: 2.5rem;
  }

  .field textarea {
    resize: vertical;
    min-height: 4rem;
    line-height: 1.5;
  }

  /* ─── Mode toggle (Guided / Raw) ─── */
  .mode-toggle {
    display: flex;
    gap: 2px;
    background: var(--bg-tertiary);
    border-radius: 10px;
    padding: 3px;
    border: 1px solid var(--border);
  }

  .toggle-btn {
    flex: 1;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-muted);
    background: transparent;
    transition: all var(--transition);
    cursor: pointer;
    border: none;
  }

  .toggle-btn.active {
    background: var(--bg-surface);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm);
  }

  .toggle-btn:hover:not(.active) {
    color: var(--text-secondary);
  }

  /* Raw editor */
  .raw-editor {
    width: 100%;
    padding: 1rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.6;
    resize: vertical;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .raw-editor:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(155, 114, 207, 0.2), 0 0 20px rgba(155, 114, 207, 0.1);
  }

  .raw-editor::placeholder {
    color: var(--text-muted);
  }

  /* ─── Buttons ─── */
  .btn {
    padding: 0.75rem 1.5rem;
    border-radius: 10px;
    font-size: var(--text-base);
    font-weight: 600;
    font-family: var(--font-body);
    cursor: pointer;
    border: none;
    transition: all var(--transition);
    min-height: 44px;
  }

  .btn:active:not(:disabled) {
    transform: scale(0.97);
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn.primary {
    width: 100%;
    background: linear-gradient(135deg, #8b5cf6, #7c3aed);
    color: #fff;
    border: 1px solid rgba(155, 114, 207, 0.3);
  }

  .btn.primary:hover:not(:disabled) {
    background: linear-gradient(135deg, #9b72cf, #8b5cf6);
    box-shadow: 0 0 20px rgba(155, 114, 207, 0.3);
  }

  .btn.secondary {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }

  .btn.secondary:hover:not(:disabled) {
    border-color: var(--border-hover);
    color: var(--text-primary);
  }

  .btn.skip {
    width: 100%;
    background: transparent;
    color: var(--text-muted);
    font-weight: 400;
    font-size: var(--text-sm);
    padding: 0.5rem;
  }

  .btn.skip:hover {
    color: var(--text-secondary);
  }

  .btn.launch {
    font-size: var(--text-md);
    padding: 1rem;
    letter-spacing: 0.01em;
  }

  /* ─── Step actions ─── */
  .step-actions {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .step-actions .btn.primary {
    flex: 1;
  }

  .step-actions .btn.secondary {
    flex: 0 0 auto;
  }

  .step-actions .btn.skip {
    flex-basis: 100%;
  }

  /* ─── Summary ─── */
  .summary {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--border);
    border-radius: 10px;
    overflow: hidden;
  }

  .summary-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--bg-tertiary);
  }

  .summary-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-weight: 500;
  }

  .summary-value {
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: 500;
    text-align: right;
  }

  /* ─── Error ─── */
  .error-message {
    background: rgba(180, 60, 60, 0.1);
    border: 1px solid rgba(180, 60, 60, 0.2);
    color: #c07070;
    padding: 0.75rem;
    border-radius: 10px;
    font-size: var(--text-sm);
    text-align: center;
  }

  /* ─── Responsive ─── */
  @media (max-width: 480px) {
    .step-actions {
      flex-direction: column;
    }
    .step-actions .btn.secondary {
      order: 1;
    }
    .step-actions .btn.primary {
      order: 0;
    }
    .step-actions .btn.skip {
      order: 2;
    }
  }
</style>
