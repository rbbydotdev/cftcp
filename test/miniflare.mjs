// The box under test: the built Worker (dist/) in Miniflare, with the Workers AI
// binding replaced by test/fake-ai.mjs (answered by the scripted model in
// test/mock-llm.py). Everything else is the production code path.
//   startBox({ sshPort, httpPort, stateDir, aiUrl, authorizedKeys }) → { stop() }
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = new URL("..", import.meta.url).pathname;

export async function startBox({ sshPort, httpPort, stateDir, aiUrl, authorizedKeys }) {
  const box = {
    name: "do-box",
    modules: [
      { type: "ESModule", path: root + "dist/worker.js" },
      { type: "CompiledWasm", path: root + "dist/cftcp_sshd_bg.wasm" },
    ],
    modulesRoot: root + "dist",
    compatibilityDate: "2026-11-01",
    // enable_abortsignal_rpc: the stand-in AI binding is an RPC hop (the real one isn't),
    // and the pi-ai adapter passes an AbortSignal.
    compatibilityFlags: ["nodejs_compat", "experimental", "enable_abortsignal_rpc"],
    workerLoaders: { LOADER: {} },
    durableObjects: { BOX: { className: "Box", useSQLite: true }, DB: { className: "ProjectDb", useSQLite: true } },
    serviceBindings: { AI: { name: "fake-ai", entrypoint: "FakeAI" } },
    bindings: {
      PREVIEW_PUBLIC: "1",
      PREVIEW_URL: `http://127.0.0.1:${httpPort}`,
      SSH_HOST: `127.0.0.1 -p ${sshPort}`,
      AUTHORIZED_KEYS: authorizedKeys,
      MOCK_AI_URL: aiUrl,
    },
    connectHandlers: [{ protocol: "tcp", port: sshPort }],
  };
  const fakeAi = {
    name: "fake-ai",
    modules: [{ type: "ESModule", path: root + "test/fake-ai.mjs" }],
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["enable_abortsignal_rpc"],
    bindings: { MOCK_AI_URL: aiUrl },
  };
  const opts = convertV4MiniflareOptions({ host: "127.0.0.1", port: httpPort, workers: [box, fakeAi] });
  opts.resourcePersistencePath = stateDir;
  const mf = new Miniflare(opts);
  await mf.ready;
  return { stop: () => mf.dispose() };
}
