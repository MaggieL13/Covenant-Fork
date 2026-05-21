/**
 * `ToolRegistry` — Covenant's central catalogue of runtime-agnostic
 * tools (PR E3b). The Codex tool-calling loop driver and any future
 * provider (OpenRouter, Ollama) ask the registry for available tools,
 * translates them to provider-native shapes via per-provider format
 * methods, and dispatches `execute()` calls when the model invokes
 * one.
 *
 * ## Why Covenant-owned (and not, say, MCP-passthrough)
 *
 * Claude SDK runs MCP servers internally — Covenant doesn't currently
 * own a tool executor surface that's runtime-agnostic. Building one
 * here means non-Claude runtimes (Codex, OpenRouter, Ollama, future
 * Gemini integration) can all share the same executor with the same
 * safety surface — path-confinement, timeouts, output budgets,
 * permission rules. MCP bridging (PR E3c) layers on top of THIS
 * registry rather than replacing it.
 *
 * ## What's in scope for E3b
 *
 * The registry itself + the three built-in read-only tools
 * (`read_file`, `list_files`, `search_text`). Bash, write_file, edit,
 * and any destructive tools are deliberately out — they need their
 * own design pre-route around sandboxing, confirmation flows, and
 * permission policy.
 */

/**
 * Per-call context passed to a tool's `execute()`. The runtime
 * assembles this fresh for every invocation; tools should not retain
 * references between calls.
 */
export interface ToolContext {
  /** Path-confinement scope root. Every tool's target paths get
   *  resolved against this via `assertPathInScope` before any fs
   *  operation. Typically `cfg.agent.cwd`. */
  scopeRoot: string;
  /** Aborts the in-flight tool call. Tools that issue async work
   *  (spawning processes, large file reads) should check / propagate
   *  this so the loop driver's abort signal reaches all the way
   *  through to interruptible work. Uses the global `AbortSignal`
   *  type — same one the rest of the runtime code base passes
   *  through (e.g. `AgentTurnInput.abortSignal`). */
  abortSignal?: AbortSignal;
}

/**
 * The single shape every Covenant tool implements. `parameters` is a
 * JSON Schema describing the expected argument object — used both for
 * the provider-format translation (Codex / pi-ai expect JSON Schema)
 * and for runtime arg validation inside `execute()`.
 *
 * `execute()` returns a string — the textual result the model sees as
 * the tool's output. Structured data (objects, errors) should be
 * `JSON.stringify`'d inside the tool before returning so the model
 * gets a consistent text-only interface regardless of result shape.
 * Tool-level errors that the model should see (e.g. "file not found")
 * also return as text (often a JSON-stringified `{error: "..."}`);
 * thrown errors are caught by the loop driver and rendered as
 * `isError: true` results.
 */
export interface CovenantTool {
  /** Stable identifier the model uses to invoke the tool. Must match
   *  `[a-zA-Z0-9_-]+` per OpenAI's tool-name rules. */
  name: string;
  /** Human-readable description the model reads to decide WHEN to
   *  call the tool. Keep it imperative and concise — long descriptions
   *  inflate the system prompt without helping selection. */
  description: string;
  /** JSON Schema for the arguments object. Used as both the
   *  declaration to the model AND the runtime contract for `execute`. */
  parameters: Record<string, unknown>;
  /** Executes the tool. `args` is the parsed argument object the
   *  model provided (already JSON-parsed by the loop driver). Returns
   *  the textual output the model will see. */
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

/**
 * Catalogue + lookup for `CovenantTool` instances. One registry per
 * backend process; tools register at startup (manifest flip + bootstrap
 * lives in PR E3b/6) and stay registered for the process lifetime.
 *
 * The registry doesn't enforce policy beyond name uniqueness — safety
 * (path-confinement, output budgets, ceiling iterations) lives in the
 * tools themselves and in the loop driver. Registry is pure catalogue.
 */
/**
 * OpenAI's function-name rule. pi-ai forwards `name` straight into
 * the `tools[].function.name` slot on the Responses API request;
 * anything outside this character set fails at API time with an
 * opaque 400 response. Enforce here so the failure surfaces at
 * registration, where the offending tool is identifiable, not 30
 * minutes later when the model first tries to call it.
 *
 * Pattern + length match the documented OpenAI constraint (1-64
 * chars, alphanumerics + underscore + hyphen).
 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const TOOL_NAME_MAX_LENGTH = 64;

export class ToolRegistry {
  private readonly tools = new Map<string, CovenantTool>();

  /**
   * Add a tool to the registry. Validates the name against OpenAI's
   * tool-name rules (`[a-zA-Z0-9_-]{1,64}`) and rejects duplicates.
   * Both checks throw with descriptive messages so bootstrap-order
   * bugs and bad tool definitions surface at the registration site,
   * not later as opaque 400s from the provider or silent overrides.
   * (Codex E3b/1 review catch.)
   */
  register(tool: CovenantTool): void {
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new Error(
        'ToolRegistry: tool name must be a non-empty string',
      );
    }
    if (tool.name.length > TOOL_NAME_MAX_LENGTH) {
      throw new Error(
        `ToolRegistry: tool name "${tool.name}" exceeds ${TOOL_NAME_MAX_LENGTH} characters`,
      );
    }
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `ToolRegistry: tool name "${tool.name}" must match ${TOOL_NAME_PATTERN.source} (alphanumerics, underscore, hyphen)`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(
        `ToolRegistry: tool "${tool.name}" is already registered`,
      );
    }
    this.tools.set(tool.name, tool);
  }

  /** Look up a tool by name. Returns `undefined` for unknown names so
   *  the loop driver can surface "unknown tool" as a structured
   *  tool-result error rather than crashing the turn. */
  get(name: string): CovenantTool | undefined {
    return this.tools.get(name);
  }

  /** List all registered tools in insertion order. Used by provider
   *  translation layers (`toCodexFormat` etc.) to enumerate the set
   *  for inclusion in the request. */
  list(): CovenantTool[] {
    return [...this.tools.values()];
  }

  /** Drop a tool by name. Returns `true` if removed, `false` if it
   *  wasn't registered. Mainly here for test isolation; production
   *  flows register-once-at-startup. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Number of currently-registered tools. Diagnostic. */
  size(): number {
    return this.tools.size;
  }
}

/**
 * Default singleton instance. The loop driver and any other backend
 * code that needs to dispatch tool calls reads from THIS. Tests should
 * either construct their own `ToolRegistry` for isolation or call
 * `unregister` in their `beforeEach` to clean up.
 */
export const toolRegistry = new ToolRegistry();
