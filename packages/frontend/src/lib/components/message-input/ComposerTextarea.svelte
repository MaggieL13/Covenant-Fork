<script lang="ts">
  let {
    content,
    oninput,
    onkeydown,
    onpaste,
    onregisterrefs,
  } = $props<{
    content: string;
    oninput?: (event: Event) => void;
    onkeydown?: (event: KeyboardEvent) => void;
    onpaste?: (event: ClipboardEvent) => void;
    onregisterrefs?: (refs: { getTextarea: () => HTMLTextAreaElement | null }) => void;
  }>();

  let textarea: HTMLTextAreaElement | null = null;

  $effect(() => {
    // ORDER: the parent must receive a live textarea getter after binding so focus, resize, selection, and cursor logic keep targeting the current DOM node.
    onregisterrefs?.({ getTextarea: () => textarea });
  });
</script>

<div class="composer-textarea-shell">
  <textarea
    bind:this={textarea}
    value={content}
    oninput={oninput}
    onkeydown={onkeydown}
    onpaste={onpaste}
    placeholder="Type a message..."
    rows="1"
    aria-label="Message input"
  ></textarea>
</div>

<style>
  .composer-textarea-shell {
    flex: 1;
    min-width: 0;
  }

  textarea {
    width: 100%;
    min-width: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0.6rem 0.75rem;
    color: var(--text-primary);
    font-size: 1rem;
    line-height: 1.6;
    resize: none;
    max-height: 200px;
    overflow-y: auto;
  }

  textarea:focus {
    outline: none;
  }

  textarea::placeholder {
    color: var(--text-muted);
  }

  @media (max-width: 768px) {
    textarea {
      padding: 0.625rem 0.75rem;
    }
  }
</style>
