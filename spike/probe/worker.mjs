export default {
  async fetch() {
    const r = { v8: globalThis.navigator?.userAgent, Suspending: typeof WebAssembly.Suspending, promising: typeof WebAssembly.promising };
    // Tiny valid module: (module) — tests runtime compilation from bytes (what a JIT needs).
    try { await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); r.dynamicCompile = "allowed"; }
    catch (e) { r.dynamicCompile = "blocked: " + e.message; }
    try { new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true }); r.sharedMemory = "ok"; } catch (e) { r.sharedMemory = e.message; }
    return Response.json(r);
  },
};
