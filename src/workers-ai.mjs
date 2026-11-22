// Workers AI through the Worker's `AI` binding: pi gets Cloudflare's models with
// no API key at all (the binding authenticates as the account).
//
// Uses Cloudflare's own pi-ai provider (`agents/models/pi-ai`, createAI), which
// calls env.AI.run and maps each model's quirks onto pi-ai's stream events
// (text, reasoning, tool calls). We register it in pi as provider "cloudflare"
// and only adjust the model list (see capModels).
import { createAI } from "agents/models/pi-ai";

/** Default when the binding is present; override with PI_MODEL or pi's /model. */
export const WORKERS_AI_DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
export const WORKERS_AI_PROVIDER = "cloudflare";

// The catalog lists most models with maxTokens = their context window, and pi
// asks for that many output tokens, which Workers AI rejects. Cap the output.
const MAX_OUTPUT_TOKENS = 32_768;

/**
 * Only Workers AI's own models (`@cf/…`), with output capped. The provider's
 * list also has AI Gateway catalog models (`anthropic/…`, …); those need gateway
 * billing or provider keys, so they stay out of pi's picker.
 */
function capModels(models) {
  return models
    .filter((m) => m.id.startsWith("@cf/"))
    .map((m) => (m.maxTokens > MAX_OUTPUT_TOKENS ? { ...m, maxTokens: MAX_OUTPUT_TOKENS } : m));
}

/** The pi-ai Provider for pi.registerProvider(), or null without a binding. */
export function workersAiProvider(binding) {
  if (!binding?.run) return null;
  const base = createAI({ binding }).provider;
  const p = Object.create(base);
  p.getModels = () => capModels(base.getModels());
  if (base.getAllModels) p.getAllModels = () => capModels(base.getAllModels());
  return p;
}
