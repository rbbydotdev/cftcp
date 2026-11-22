import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const d = new URL("./dist/", import.meta.url).pathname;
const { readdirSync } = await import("node:fs");
const modules = readdirSync(d).sort((a, b) => (b === "worker.js") - (a === "worker.js")).map((f) => ({ type: f.endsWith(".wasm") ? "CompiledWasm" : "ESModule", path: d + f }));
const opts = convertV4MiniflareOptions({
  modules, modulesRoot: d, compatibilityDate: "2026-11-01", compatibilityFlags: ["nodejs_compat", "experimental"],
  durableObjects: { BOX: { className: "Box", useSQLite: true } }, workerLoaders: { LOADER: {} },
});
const mf = new Miniflare(opts);
console.log(await (await mf.dispatchFetch("http://x/")).text());
await mf.dispose();
