import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const flags = process.argv.slice(2);
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: new URL("./worker.mjs", import.meta.url).pathname, compatibilityDate: "2026-11-01", compatibilityFlags: flags }));
console.log(flags.join(",") || "(no flags)", await (await mf.dispatchFetch("http://x/")).text());
await mf.dispose();
