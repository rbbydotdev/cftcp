import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: new URL("./node.mjs", import.meta.url).pathname, compatibilityDate: "2026-11-01", compatibilityFlags: ["nodejs_compat"] }));
console.log(JSON.stringify(JSON.parse(await (await mf.dispatchFetch("http://x/")).text()), null, 1));
await mf.dispose();
