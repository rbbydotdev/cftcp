import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: new URL("./worker.mjs", import.meta.url).pathname,
  compatibilityDate: "2026-11-01", compatibilityFlags: ["nodejs_compat", "experimental"], workerLoaders: { LOADER: {} },
}));
console.log(await (await mf.dispatchFetch("http://x/")).text());
console.log(await (await mf.dispatchFetch("http://x/")).text());
await mf.dispose();
