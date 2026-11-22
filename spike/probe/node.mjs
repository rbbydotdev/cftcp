const mods = ["stream","fs","util","path","child_process","os","buffer","events","crypto","https","http","url","assert","process","tty","net","tls","zlib","readline","module","worker_threads","perf_hooks","string_decoder","timers","dns","async_hooks"];
export default {
  async fetch() {
    const out = {};
    for (const m of mods) {
      try {
        const mod = await import("node:" + m);
        out[m] = Object.keys(mod).length + " exports";
      } catch (e) { out[m] = "ERR " + e.message.slice(0, 80); }
    }
    try { const cp = await import("node:child_process"); cp.spawn("ls"); out.spawn = "ok"; } catch (e) { out.spawn = "ERR " + e.message.slice(0, 80); }
    try { const os = await import("node:os"); out.homedir = os.homedir(); out.platform = os.platform(); } catch (e) { out.homedir = e.message; }
    out.stdout = typeof process?.stdout?.write; out.isTTY = process?.stdout?.isTTY; out.env = typeof process.env;
    try { new Function("return 1")(); out.newFunction = "ok"; } catch (e) { out.newFunction = "ERR " + e.message.slice(0, 60); }
    return Response.json(out);
  },
};
