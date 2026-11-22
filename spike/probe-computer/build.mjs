import { build } from "esbuild";
import { builtinModules } from "node:module";
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
await build({
  entryPoints: ["probe-computer/worker.mjs"], bundle: true, format: "esm", platform: "neutral",
  mainFields: ["module", "main"], conditions: ["workerd", "worker", "import", "default"],
  define: { "import.meta.url": "\"file:///worker.js\"" },
  external: ["cloudflare:*", "*.wasm"], outdir: "probe-computer/dist", splitting: true, logLevel: "warning",
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr("file:///worker.js");` },
  plugins: [{ name: "probe", setup(b) {
    b.onResolve({ filter: /^(node:)?[a-z0-9_/]+$/ }, (a) => {
      const n = a.path.replace(/^node:/, "");
      if (builtins.has(n) || builtins.has(n.split("/")[0])) return { path: `node:${n}`, external: true };
    });
    b.onResolve({ filter: /^(node-liblzma|@mongodb-js\/zstd|koffi)(\/.*)?$|\.node$/ }, (a) => ({ path: a.path, namespace: "na" }));
    b.onLoad({ filter: /.*/, namespace: "na" }, () => ({ contents: "module.exports = {};", loader: "js" }));
  } }],
});
