# Provider Runtime Contract

Covenant can speak to providers that have very different native shapes:
Claude SDK sessions, Codex OAuth via pi-ai, OpenRouter chat completions, and
local Ollama. The backend should keep one Covenant-shaped contract at the
edge so the rest of the app does not become provider-specific.

## Runtime Boundary

Every provider runtime accepts the same turn input:

- thread and model identity
- system prompt plus optional cross-provider handoff
- normalized user/assistant history in chronological order
- abort signal, tier, platform, thinking effort, and optional session id

Every runtime emits `AgentRuntimeEvent` from
`packages/backend/src/services/runtimes/types.ts`.

Native provider events must be translated at the runtime boundary. Agent
service, UI streaming, database persistence, and future memory layers should
consume only normalized events.

## Storage Invariants

These rules are load-bearing for continuity:

- `messages.content` stores final assistant/user dialogue text only.
- `text_delta` is the only assistant stream event that may append to final
  assistant content.
- `thinking_delta` may be displayed and stored in `metadata.segments`, but it
  must never be replayed as assistant dialogue.
- Tool calls, diagnostics, auth prompts, rate limits, and suppressed events may
  be displayed or logged, but they must not become replay history.
- Replay history must stay chronological. Newest-first history makes older
  scenes look current to stateless providers.

## Provider Policies

Claude SDK:

- Can use native session resume where available.
- Still benefits from explicit summaries and root anchors for long chats.
- Tool/thinking events are normalized before UI/storage.

Codex OAuth:

- pi-ai sends the full message list each turn with `store: false`.
- `responseId` is persisted as prompt-cache affinity and debug/audit state, not
  as Claude-style resume.
- `text_delta` is a true delta and is concatenated directly.
- `thinking_delta` is buffered into larger blocks for the UI and kept out of
  final assistant text.

OpenRouter:

- Treat as stateless chat completion by default.
- Use clean chronological replay plus summaries/root anchors.
- Capability detection should decide whether reasoning, tools, vision, and
  structured outputs are enabled for a specific model.

Ollama:

- Treat as local stateless chat by default.
- Use the same replay/summarization policy as OpenRouter.
- Health and model availability checks belong in the runtime/auth layer, not
  scattered through AgentService.

## Debugging Native Events

Codex supports local native event logging:

```powershell
$env:CODEX_EVENT_LOG='true'
```

This logs sanitized pi-ai event shape: event type, content index, text lengths,
response id presence, usage presence, and stop reason. It does not log message
content by default.

For a short local-only content preview while chasing display corruption:

```powershell
$env:CODEX_EVENT_LOG_CONTENT='true'
```

Turn that off after debugging. The normal app should rely on normalized events,
not provider-native logs.

## Future Runtime Work

The next provider revamp steps should be small and stacked:

- Keep the Codex history-order fix and tests.
- Add provider capability manifests for tools, vision, reasoning, resume, and
  local/network requirements.
- Move auth/health checks behind provider-specific runtime adapters.
- Add OpenRouter as stateless replay plus capability-gated extras.
- Add Ollama as local stateless replay plus health/model checks.
- Add shared summary/root-anchor injection so long roleplay sessions keep their
  durable facts even when raw history falls out of the context window.
