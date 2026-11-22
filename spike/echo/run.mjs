import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: new URL("./worker.mjs", import.meta.url).pathname,
  compatibilityDate: "2026-11-01",
  durableObjects: { BOX: "Box" },
  connectHandlers: [{ protocol: "tcp", port: 2222 }],
}));
await mf.ready; console.log("ready on 2222");
