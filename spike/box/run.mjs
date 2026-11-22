import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.PORT ?? 2222);
const httpPort = Number(process.env.HTTP_PORT ?? 8787);
const box = {
  name: "do-box",
  modules: [
    { type: "ESModule", path: root + "dist/worker.js" },
    { type: "CompiledWasm", path: root + "dist/cftcp_sshd_bg.wasm" },
  ],
  modulesRoot: root + "dist",
  compatibilityDate: "2026-11-01",
  compatibilityFlags: ["nodejs_compat", "experimental"],
  workerLoaders: { LOADER: {} },
  durableObjects: { BOX: { className: "Box", useSQLite: true }, DB: { className: "ProjectDb", useSQLite: true } },
  bindings: {
    SHELL_MODE: process.env.SHELL_MODE ?? "pi",
    // Local dev only: open preview, and "any key" when no key file is given.
    PREVIEW_PUBLIC: "1",
    PREVIEW_URL: `http://127.0.0.1:${httpPort}`,
    SSH_HOST: `127.0.0.1 -p ${port}`,
    ALLOW_ANY_KEY: process.env.AUTHORIZED_KEYS_FILE ? "0" : "1",
    // Pass through model config and provider API keys if set.
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^PI_(PROVIDER|MODEL|BASE_URL)$|_API_KEY$|^CLOUDFLARE_(ACCOUNT_ID|GATEWAY_ID|API_TOKEN)$|^MOCK_(LLM|AI)_URL$|^(IDLE_TIMEOUT_MIN|MAX_SESSION_HOURS|RUN_TIMEOUT_S)$/.test(k))), AUTHORIZED_KEYS: process.env.AUTHORIZED_KEYS_FILE ? readFileSync(process.env.AUTHORIZED_KEYS_FILE, "utf8") : "" },
  connectHandlers: [{ protocol: "tcp", port }],
};
// MOCK_AI_URL: a local stand-in for the Workers AI binding (dev/fake-ai.mjs),
// so the keyless default path runs against the scripted mock model.
const workers = [box];
if (process.env.MOCK_AI_URL) {
  box.serviceBindings = { AI: { name: "fake-ai", entrypoint: "FakeAI" } };
  // The real binding isn't an RPC hop; this one is, and the pi-ai adapter passes a signal.
  box.compatibilityFlags = [...box.compatibilityFlags, "enable_abortsignal_rpc"];
  workers.push({
    name: "fake-ai",
    modules: [{ type: "ESModule", path: root + "dev/fake-ai.mjs" }],
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["enable_abortsignal_rpc"],
    bindings: { MOCK_AI_URL: process.env.MOCK_AI_URL },
  });
}
const opts = convertV4MiniflareOptions({ host: "127.0.0.1", port: httpPort, workers });
// v4 `durableObjectsPersist` is dropped by the converter; v5 uses one root.
opts.resourcePersistencePath = process.env.STATE_DIR ?? root + ".state";
const mf = new Miniflare(opts);
await mf.ready;
console.log(`do-box sshd listening on 127.0.0.1:${port}; preview http://127.0.0.1:${httpPort}/`);
