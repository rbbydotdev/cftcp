// run_python: CPython (Pyodide) in a Dynamic Worker. The isolate is cached per
// project, so after the first cold start (~seconds) runs take milliseconds. The
// code reaches the project's files through `fs`, an RPC binding (PyFs) back into
// the Durable Object, confined to /workspace/<project>.
import { WorkerEntrypoint } from "cloudflare:workers";

const RUNNER = `from workers import WorkerEntrypoint, Response
import json, sys, io, traceback

class Fs:
    """The project's files (paths relative to the project, or absolute under it)."""
    def __init__(self, b): self._b = b
    async def read(self, path): return await self._b.read(path)
    async def write(self, path, text): await self._b.write(path, str(text))
    async def listdir(self, path="."): return _py(await self._b.listdir(path))
    async def exists(self, path): return bool(await self._b.exists(path))

def _py(v):
    return list(v.to_py()) if hasattr(v, "to_py") else list(v)

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        req = json.loads(await request.text())
        out = io.StringIO()
        old = (sys.stdout, sys.stderr)
        sys.stdout = sys.stderr = out
        ok, value = True, None
        try:
            ns = {"__name__": "__main__"}
            exec(compile(req["source"], "main.py", "exec"), ns)
            if callable(ns.get("main")):
                value = ns["main"](Fs(self.env.FS), req.get("input"))
                if hasattr(value, "__await__"):
                    value = await value
        except BaseException:
            ok = False
            traceback.print_exc()
        finally:
            sys.stdout, sys.stderr = old
        return Response(json.dumps({"ok": ok, "output": out.getvalue(), "value": value}, default=repr))
`;

/** File access for Python, scoped to one project (props: { boxId, root }). */
export class PyFs extends WorkerEntrypoint {
  #path(p) {
    const root = this.ctx.props.root;
    const abs = p.startsWith("/") ? p : `${root}/${p}`;
    const parts = [];
    for (const s of abs.split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") parts.pop();
      else parts.push(s);
    }
    const norm = "/" + parts.join("/");
    if (norm !== root && !norm.startsWith(root + "/")) throw new Error(`path outside the project: ${p}`);
    return norm;
  }
  #box() { return this.env.BOX.get(this.env.BOX.idFromString(this.ctx.props.boxId)); }
  read(p) { return this.#box().wsRead(this.#path(p)); }
  write(p, text) { return this.#box().wsWrite(this.#path(p), text); }
  listdir(p = ".") { return this.#box().wsList(this.#path(p)); }
  exists(p) { return this.#box().wsExists(this.#path(p)); }
}

/** Run `source` for a project. Returns { ok, output, value }. */
export async function runPython({ loader, exports, boxId, project, source, input, timeoutMs = 120_000 }) {
  const root = `/workspace/${project}`;
  const worker = loader.get(`py:${project}`, () => ({
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["python_workers"],
    mainModule: "main.py",
    modules: { "main.py": { py: RUNNER } },
    env: { FS: exports.PyFs({ props: { boxId, root } }) },
    globalOutbound: null, // no network
  }));
  let res;
  try {
    res = await worker.getEntrypoint().fetch("http://python/", {
      method: "POST",
      body: JSON.stringify({ source, input: input ?? null }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === "TimeoutError") throw new Error(`run_python timed out after ${timeoutMs / 1000}s`);
    throw e;
  }
  if (!res.ok) throw new Error(`python runner: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}
