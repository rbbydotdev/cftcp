// Local stand-in for the Workers AI binding (env.AI), for `./try --mock`:
// env.AI.run(model, inputs, { returnRawResponse }) is answered by the scripted
// OpenAI-compatible mock (dev/mock-llm.py), so the real keyless code path
// (box/workers-ai.mjs → agents/models/pi-ai → env.AI.run) runs without an account.
import { WorkerEntrypoint } from "cloudflare:workers";

export class FakeAI extends WorkerEntrypoint {
  async run(model, inputs, options = {}) {
    const res = await fetch(`${this.env.MOCK_AI_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, ...inputs }),
    });
    if (options.returnRawResponse) return res;
    return inputs.stream ? res.body : res.json();
  }
}

export default { fetch: () => new Response("fake AI binding", { status: 404 }) };
