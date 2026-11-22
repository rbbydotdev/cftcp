import { DurableObject } from "cloudflare:workers";
import { getWorkspace, withWorkspace, WorkspaceServiceProxy } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import python from "@cloudflare/computer/shell/python";
import sqlite from "@cloudflare/computer/shell/sqlite";
import jsExec from "@cloudflare/computer/shell/js-exec";
import jq from "@cloudflare/computer/shell/jq";

export { WorkspaceServiceProxy };

export class Box extends withWorkspace(class extends DurableObject {}, (self) => ({
  storage: self.ctx.storage,
  backends: [
    new CodemodeBackend({ loader: self.env.LOADER }),
    new WorkerShellBackend({
      loader: self.env.LOADER,
      workspace: { binding: "BOX", id: self.ctx.id.toString() },
      ctx: self.ctx,
      commands: [python, sqlite, jsExec, jq],
    }),
  ],
})) {}

async function run(ws, label, source, opts) {
  const t0 = Date.now();
  try {
    const h = await ws.runtime.exec(source, { encoding: "utf8", ...opts });
    const r = await h.result();
    return `${label} (${Date.now() - t0} ms): ${JSON.stringify(r).slice(0, 400)}`;
  } catch (e) {
    return `${label} FAILED (${Date.now() - t0} ms): ${e?.stack ?? e}`.slice(0, 600);
  }
}

export default {
  async fetch(req, env) {
    const ws = await getWorkspace(env.BOX.getByName("probe"));
    const out = [];
    await ws.fs.mkdir("/workspace", { recursive: true });
    await ws.fs.writeFile("/workspace/hello.txt", "hello from the workspace\n");
    out.push("backends: " + JSON.stringify(await ws.runtime.backends?.() ?? "n/a"));
    out.push(await run(ws, "codemode", `import { readFile, writeFile } from "node:fs/promises";
      export default async (input) => { const t = await readFile("/workspace/hello.txt", "utf8");
        await writeFile("/workspace/from-js.txt", "written by codemode\\n"); return { upper: t.toUpperCase(), sum: input.a + input.b }; }`,
      { backend: "codemode", input: { a: 2, b: 40 } }));
    out.push(await run(ws, "shell", "cd /workspace && cat hello.txt from-js.txt && ls -la | wc -l", { backend: "worker-shell" }));
    out.push(await run(ws, "python", "python3 -c 'print(6*7)'", { backend: "worker-shell" }));
    out.push(await run(ws, "sqlite", "sqlite3 :memory: 'select 2+2'", { backend: "worker-shell" }));
    out.push(await run(ws, "js-exec", "js-exec -c 'console.log([1,2,3].map(x=>x*2))'", { backend: "worker-shell" }));
    return new Response(out.join("\n") + "\n");
  },
};
