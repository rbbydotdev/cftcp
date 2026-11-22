// esbuild the Worker so the real pi (and friends) run in workerd:
//  - `fs`, `fs/promises` (+ node: forms) → the DO disk (box/vfs.mjs)
//  - other Node built-ins stay external (workerd's nodejs_compat provides them)
//  - each package's `import.meta.url` → its path under /usr/lib/node_modules on
//    the DO disk, where its runtime assets (package.json, themes, docs) are seeded
//  - pi's InteractiveMode gets our SSH terminal
//  - unused pi-ai providers are stubbed out (they're lazy import()s)
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const nm = join(root, "node_modules");
const INSTALL = "/usr/lib/node_modules";
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

// CommonJS so `require("fs")` is the live memfs object (graceful-fs patches it);
// ESM named imports resolve as property reads on it.
const vfsPath = JSON.stringify(join(root, "box/vfs.mjs"));
const shim = {
  fs: `module.exports = require(${vfsPath}).fs;`,
  "fs/promises": `module.exports = require(${vfsPath}).fs.promises;`,
};

/** Names a memfs-backed module must export (so `import { x } from "fs"` binds). */
function exportNames(mod) {
  const skip = mod === "fs" ? ["default", "promises"] : ["default", "constants"];
  return Object.keys(require_(`node:${mod}`)).filter((n) => /^[a-zA-Z_$][\w$]*$/.test(n) && !skip.includes(n));
}
function require_(m) { return process.getBuiltinModule(m); }

const DROP = /pi-ai\/dist\/providers\/(mistral|google-vertex|azure-openai-responses|openai-codex-responses|amazon-bedrock)\.js$/;

/** Runtime assets pi reads from its package dir, embedded and seeded onto the disk. */
function collectAssets() {
  const files = {};
  const add = (abs) => {
    if (!existsSync(abs) || statSync(abs).isDirectory()) return;
    files[`${INSTALL}/${relative(nm, abs)}`] = readFileSync(abs).toString("base64");
  };
  const scope = join(nm, "@earendil-works");
  for (const pkg of readdirSync(scope)) add(join(scope, pkg, "package.json"));
  const pi = join(scope, "pi-coding-agent");
  for (const f of ["README.md", "CHANGELOG.md"]) add(join(pi, f));
  for (const f of readdirSync(join(pi, "docs"))) if (f.endsWith(".md")) add(join(pi, "docs", f));
  for (const f of readdirSync(join(pi, "dist/modes/interactive/theme"))) if (f.endsWith(".json")) add(join(pi, "dist/modes/interactive/theme", f));
  for (const f of ["template.html", "template.css", "template.js"]) add(join(pi, "dist/core/export-html", f));
  return files;
}

const plugin = {
  name: "cftcp",
  setup(b) {
    // fs → DO disk; other builtins → external node:*
    b.onResolve({ filter: /^(node:)?[a-z0-9_/]+$/ }, (args) => {
      const name = args.path.replace(/^node:/, "");
      if (name === "fs" || name === "fs/promises") return { path: name, namespace: "fs-shim" };
      if (builtins.has(name) || builtins.has(name.split("/")[0])) return { path: `node:${name}`, external: true };
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "fs-shim" }, (args) => ({ contents: shim[args.path], loader: "js", resolveDir: root }));

    // graceful-fs only works around EMFILE on real disks; on memfs it's just fs.
    b.onResolve({ filter: /^graceful-fs$/ }, () => ({ path: "fs", namespace: "fs-shim" }));

    // Native addons / code loaders that can't run in workerd: stub, fail on use.
    b.onResolve({ filter: /^(node-liblzma|@mongodb-js\/zstd|koffi|jiti)(\/.*)?$|\.node$/ }, (args) => ({ path: args.path, namespace: "unavailable" }));
    b.onLoad({ filter: /.*/, namespace: "unavailable" }, (args) => ({
      contents: `const no = () => { throw new Error(${JSON.stringify(`${args.path} is not available in this Durable Object`)}); };
        export default new Proxy(no, { get: (_, k) => (k === "then" ? undefined : no) });
        export const createJiti = no;`,
      loader: "js",
    }));

    b.onResolve({ filter: /^virtual:assets$/ }, () => ({ path: "assets", namespace: "virtual" }));
    b.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({ contents: `export default ${JSON.stringify(collectAssets())};`, loader: "js" }));

    // just-bash's Node build (ReadWriteFs over node:fs, i.e. our disk).
    b.onResolve({ filter: /^just-bash$/ }, () => ({ path: join(nm, "just-bash/dist/bundle/index.js") }));


    // Per-file import.meta.url → install path on the DO disk; plus pi patches.
    b.onLoad({ filter: /node_modules\/.*\.(m?js|cjs)$/ }, (args) => {
      let src = readFileSync(args.path, "utf8");
      const isMain = /pi-coding-agent\/dist\/main\.js$/.test(args.path);
      const isDispatcher = /pi-coding-agent\/dist\/core\/http-dispatcher\.js$/.test(args.path);
      const patched = src.includes("import.meta.url") || isMain || isDispatcher;
      if (!patched) return undefined;
      src = src.replaceAll("import.meta.url", JSON.stringify(`file://${INSTALL}/${relative(nm, args.path)}`));
      if (isDispatcher) {
        // Keep workerd's native fetch; undici over node:tls can't do ALPN here.
        const before = src;
        src = src.replace("export function configureHttpDispatcher(", "export function configureHttpDispatcher() {}\nfunction __unusedConfigureHttpDispatcher(");
        if (src === before) throw new Error("pi http-dispatcher patch point not found");
      }
      if (isMain) {
        const before = src;
        src = src.replace("new InteractiveMode(runtime, {", "new InteractiveMode(runtime, { terminal: globalThis.__cftcpTerminal?.(),");
        if (src === before) throw new Error("pi main.js patch point not found");
      }
      return { contents: src, loader: "js" };
    });
  },
};

const t0 = Date.now();
const r = await build({
  entryPoints: [join(root, "box/worker.mjs")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "import", "default"],
  target: "es2023",
  external: ["cloudflare:*", "*.wasm"],
  loader: { ".md": "text" },
  banner: { js: `import { createRequire as __cftcpCreateRequire } from "node:module"; const require = __cftcpCreateRequire("file:///worker.js");` },
  define: { "location.href": '"https://box.local/"' },
  outfile: join(root, "dist/worker.js"),
  plugins: [plugin],
  minify: process.env.NO_MINIFY ? false : true,
  keepNames: true,
  logLevel: "warning",
  metafile: true,
});
const top = new Map();
for (const [k, v] of Object.entries(r.metafile.outputs["dist/worker.js"]?.inputs ?? Object.values(r.metafile.outputs)[0].inputs)) {
  const key = k.replace(/^node_modules\//, "").split("/").slice(0, k.includes("node_modules/@") ? 3 : 2).join("/");
  top.set(key, (top.get(key) ?? 0) + v.bytesInOutput);
}
console.log(`bundled in ${Date.now() - t0} ms; largest:`, [...top].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ${(n / 1024) | 0}K`).join(", "));
