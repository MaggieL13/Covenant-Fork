<script lang="ts">
  interface McpServer {
    name: string;
    type: 'url' | 'sse' | 'stdio' | 'http';
    url?: string;
    command?: string;
    args?: string[];
  }

  let {
    servers,
    draft,
    message,
    onservernamechange,
    onservertypechange,
    onserverurlchange,
    onservercommandchange,
    onserverargschange,
    onaddserver,
    onremoveserver,
  } = $props<{
    servers: McpServer[];
    draft: {
      newServerName: string;
      newServerType: 'url' | 'sse' | 'stdio';
      newServerUrl: string;
      newServerCommand: string;
      newServerArgs: string;
    };
    message: string | null;
    onservernamechange?: (value: string) => void;
    onservertypechange?: (value: 'url' | 'sse' | 'stdio') => void;
    onserverurlchange?: (value: string) => void;
    onservercommandchange?: (value: string) => void;
    onserverargschange?: (value: string) => void;
    onaddserver?: () => void;
    onremoveserver?: (name: string) => void;
  }>();
</script>

<section class="section">
  <h3 class="section-title">MCP Servers</h3>
  <p class="section-desc">Connect external tools and services to your companion.</p>

  {#if servers.length === 0}
    <p class="empty-state">No MCP servers configured.</p>
  {:else}
    {#each servers as server}
      <div class="mcp-server-card">
        <div class="server-header">
          <strong class="server-name">{server.name}</strong>
          <span class="server-type">{server.type}</span>
          <button class="remove-btn" onclick={() => onremoveserver?.(server.name)}>Remove</button>
        </div>
        <div class="server-detail">
          {#if server.type === 'url' || server.type === 'http' || server.type === 'sse'}
            <span class="server-url">{server.url}</span>
          {:else}
            <span class="server-cmd">{server.command} {(server.args || []).join(' ')}</span>
          {/if}
        </div>
      </div>
    {/each}
  {/if}

  <details class="add-server-form">
    <summary class="add-server-summary">+ Add Server</summary>
    <div class="form-fields">
      <div class="field">
        <label class="field-label" for="mcp-name">Server Name</label>
        <input
          id="mcp-name"
          type="text"
          class="field-input"
          placeholder="e.g. my-tools"
          value={draft.newServerName}
          oninput={(event) => onservernamechange?.((event.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <div class="field">
        <label class="field-label" for="mcp-type">Type</label>
        <select
          id="mcp-type"
          class="field-select"
          value={draft.newServerType}
          onchange={(event) => onservertypechange?.((event.currentTarget as HTMLSelectElement).value as 'url' | 'sse' | 'stdio')}
        >
          <option value="url">URL (HTTP)</option>
          <option value="sse">SSE</option>
          <option value="stdio">Command (stdio)</option>
        </select>
      </div>
      {#if draft.newServerType === 'url' || draft.newServerType === 'sse'}
        <div class="field">
          <label class="field-label" for="mcp-url">URL</label>
          <input
            id="mcp-url"
            type="text"
            class="field-input"
            placeholder="http://localhost:8080/mcp"
            value={draft.newServerUrl}
            oninput={(event) => onserverurlchange?.((event.currentTarget as HTMLInputElement).value)}
          />
        </div>
      {:else}
        <div class="field">
          <label class="field-label" for="mcp-cmd">Command</label>
          <input
            id="mcp-cmd"
            type="text"
            class="field-input"
            placeholder="e.g. npx"
            value={draft.newServerCommand}
            oninput={(event) => onservercommandchange?.((event.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <label class="field-label" for="mcp-args">Arguments (space-separated)</label>
          <input
            id="mcp-args"
            type="text"
            class="field-input"
            placeholder="e.g. -y @my/mcp-server"
            value={draft.newServerArgs}
            oninput={(event) => onserverargschange?.((event.currentTarget as HTMLInputElement).value)}
          />
        </div>
      {/if}
      <button class="save-btn" onclick={() => onaddserver?.()} disabled={!draft.newServerName.trim()}>Add Server</button>
    </div>
  </details>

  {#if message}
    <p class="status-msg">{message}</p>
  {/if}
  <p class="info-note">Server restart required for MCP changes to take effect.</p>
</section>

<style>
  .empty-state {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-style: italic;
    padding: 0.5rem 0;
  }

  .mcp-server-card {
    padding: 0.75rem;
    margin-bottom: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
  }

  .server-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .server-name {
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .server-type {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    padding: 0.125rem 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 3px;
  }

  .remove-btn {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    transition: color var(--transition), border-color var(--transition);
  }

  .remove-btn:hover {
    color: #e05252;
    border-color: #e05252;
  }

  .server-detail {
    margin-top: 0.375rem;
  }

  .server-url,
  .server-cmd {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.75rem;
    color: var(--text-muted);
    word-break: break-all;
  }

  .add-server-form {
    margin-top: 0.75rem;
  }

  .add-server-summary {
    font-size: 0.8125rem;
    color: var(--gold);
    cursor: pointer;
    padding: 0.375rem 0;
    letter-spacing: 0.02em;
  }

  .add-server-summary:hover {
    color: var(--text-primary);
  }

  .form-fields {
    padding: 0.75rem 0 0;
  }

  .status-msg {
    font-size: 0.8125rem;
    color: var(--gold);
    margin: 0.5rem 0 0;
  }

  .info-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
    font-style: italic;
  }
</style>
