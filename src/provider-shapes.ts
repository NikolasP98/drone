/**
 * Provider-specific request-shape translations.
 *
 * Pi-ai abstracts most request fields uniformly (system prompt, messages,
 * tools, ImageContent). A few pieces remain provider-specific because the
 * underlying APIs disagree on JSON shape — most notably the "force a tool
 * call" knob:
 *
 *   • Anthropic:   `{ type: "tool", name: <toolName> }`
 *   • OpenAI:      `{ type: "function", function: { name: <toolName> } }`
 *                  OR `"required"` (forces some tool, not a specific one)
 *   • Google:      `"required"` works via pi-ai's adapter
 *   • OpenRouter:  OpenAI-compatible (`"required"` works)
 *
 * Anthropic SILENTLY REJECTS `"required"`, so per-provider translation is
 * load-bearing. Confirmed by the comment in
 * `src/agents/llm-tools/forced-tool-call.ts` in the gateway:
 *
 *   > Pass toolChoice: "required" only for OpenAI/Google callers —
 *   > Anthropic silently rejects that value.
 *
 * This module centralizes those translations so drones can specify a
 * provider-agnostic intent ("force one tool call") and the runtime picks
 * the right shape. Add more functions here as new translations surface
 * (response_format JSON mode, system-message position, cache_control, …).
 */

/**
 * Returns the toolChoice request shape that forces the model to call
 * exactly one tool. When the drone only offers a single tool (as in
 * schema-only mode), every supported shape produces the same effect —
 * calling that one tool.
 *
 * The return type is `unknown` because the consumer (pi-ai) types
 * `ProviderStreamOptions` loosely and each provider parses the field
 * differently.
 */
export function forceToolCallShape(provider: string, toolName: string): unknown {
  const p = provider.toLowerCase().trim();
  // Anthropic and Bedrock-Anthropic share the same request shape.
  if (p === "anthropic" || p === "anthropic-bedrock" || p.includes("claude")) {
    return { type: "tool", name: toolName };
  }
  // OpenAI / OpenRouter / Azure-OpenAI / Google / Gemini and any other
  // OpenAI-compatible provider accept the generic "required" mode, which
  // forces *some* tool call. Since drone schema-only mode only offers one
  // tool, "required" is equivalent to "call that one tool".
  return "required";
}
