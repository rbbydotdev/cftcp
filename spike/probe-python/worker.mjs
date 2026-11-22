const PY = `from workers import WorkerEntrypoint, Response
import json, statistics

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        data = [3, 1, 4, 1, 5, 9, 2, 6]
        return Response(json.dumps({"sum": sum(data), "median": statistics.median(data), "py": __import__("sys").version.split()[0]}))
`;
export default {
  async fetch(req, env) {
    const t0 = Date.now();
    try {
      const w = env.LOADER.get("py-probe", () => ({
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["python_workers"],
        mainModule: "main.py",
        modules: { "main.py": { py: PY } },
        globalOutbound: null,
      }));
      const r = await w.getEntrypoint().fetch("http://x/");
      return new Response(`python (${Date.now() - t0} ms): ${r.status} ${await r.text()}\n`);
    } catch (e) {
      return new Response(`python FAILED (${Date.now() - t0} ms): ${e?.stack ?? e}\n`);
    }
  },
};
