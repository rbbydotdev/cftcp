// The Durable Object's disk.
//
//   pi, just-bash, …  ──node:fs (sync)──▶  memfs volume  ──write-behind──▶  @cloudflare/shell Workspace
//                                                                            (DO SQLite, the real store)
//
// Workspace is Cloudflare's SQLite-backed filesystem for Durable Objects. Its API
// is async, but pi uses lots of sync node:fs calls, so a memfs volume is the
// live, synchronous view: loaded from the Workspace at boot, and changes are
// flushed back shortly after each write. src/bundle.mjs aliases `fs`,
// `node:fs`, `fs/promises` and `node:fs/promises` to this volume.
import { Volume, createFsFromVolume } from "memfs";

export const vol = new Volume();
export const fs = createFsFromVolume(vol);

// Unix-ish skeleton so tools that expect these paths are happy.
for (const d of ["/tmp", "/home", "/etc", "/usr/bin", "/bin", "/dev"]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync("/dev/null", "");

// Not persisted: devices, and package assets re-seeded from the bundle on boot.
const EPHEMERAL = /^\/(dev|proc|usr\/lib\/node_modules)(\/|$)|^\/AGENTS\.md$/;
const sig = (st) => `${st.mode}|${st.size}|${st.mtimeMs}`;

export class WorkspacePersister {
  /** @param {import("@cloudflare/shell").Workspace} ws */
  constructor(ws) {
    this.ws = ws;
    this.seen = new Map(); // path -> signature last flushed
    this.timer = null;
    this.flushing = Promise.resolve();
  }

  /** Copy the whole Workspace into the volume. */
  async load() {
    let count = 0;
    const links = [];
    const walk = async (dir) => {
      for (let offset = 0; ; offset += 1000) {
        const page = await this.ws.readDir(dir, { limit: 1000, offset });
        for (const e of page) {
          count++;
          if (e.type === "directory") {
            fs.mkdirSync(e.path, { recursive: true });
            await walk(e.path);
          } else if (e.type === "symlink") {
            links.push(e);
          } else {
            const bytes = await this.ws.readFileBytes(e.path);
            fs.mkdirSync(e.path.replace(/\/[^/]*$/, "") || "/", { recursive: true });
            fs.writeFileSync(e.path, bytes ?? new Uint8Array());
            const t = new Date(e.updatedAt);
            fs.utimesSync(e.path, t, t);
          }
        }
        if (page.length < 1000) break;
      }
    };
    await walk("/");
    for (const l of links) try { fs.symlinkSync(l.target, l.path); } catch {}
    this.snapshot(); // what we just loaded is already persisted
    return count;
  }

  /** Coalesce bursts of writes into one flush shortly after. */
  schedule(ms = 250) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
  }

  /** Flush now (serialized); resolves when the Workspace is up to date. */
  flush() {
    this.flushing = this.flushing.then(() => this.#flush()).catch((e) => console.error("vfs flush failed", e));
    return this.flushing;
  }

  /** Current volume state: path -> {st, sig}. */
  #scan() {
    const out = new Map();
    const walk = (dir) => {
      let names;
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
        if (EPHEMERAL.test(path)) continue;
        let st;
        try { st = fs.lstatSync(path); } catch { continue; }
        out.set(path, { st, sig: sig(st) });
        if (st.isDirectory()) walk(path);
      }
    };
    walk("/");
    return out;
  }

  snapshot() {
    this.seen = new Map([...this.#scan()].map(([p, v]) => [p, v.sig]));
  }

  async #flush() {
    const now = this.#scan();
    // Deletions first (deepest first), so a dir replaced by a file works.
    const gone = [...this.seen.keys()].filter((p) => !now.has(p)).sort((a, b) => b.length - a.length);
    for (const p of gone) {
      await this.ws.rm(p, { recursive: true, force: true }).catch(() => {});
      this.seen.delete(p);
    }
    for (const [path, { st, sig: s }] of [...now].sort((a, b) => a[0].length - b[0].length)) {
      if (this.seen.get(path) === s) continue;
      if (st.isDirectory()) await this.ws.mkdir(path, { recursive: true });
      else if (st.isSymbolicLink()) {
        await this.ws.rm(path, { force: true }).catch(() => {});
        await this.ws.symlink(fs.readlinkSync(path), path);
      } else await this.ws.writeFileBytes(path, fs.readFileSync(path));
      this.seen.set(path, s);
    }
  }
}

// Mark the disk dirty on any mutating call so the persister flushes soon.
let onWrite = () => {};
export const setOnWrite = (fn) => { onWrite = fn; };
const MUTATORS = ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "rename", "copyFile", "symlink",
  "link", "chmod", "utimes", "truncate", "mkdtemp", "write", "cp", "close", "createWriteStream"];
/** Replace obj[key] with wrap(orig), whether it's a plain property or a getter. */
function hook(obj, key, wrap) {
  const orig = obj[key];
  if (typeof orig !== "function") return;
  const wrapped = wrap(orig);
  try {
    Object.defineProperty(obj, key, { value: wrapped, writable: true, configurable: true, enumerable: true });
  } catch {}
}
for (const name of MUTATORS) {
  for (const key of [name, `${name}Sync`]) {
    hook(fs, key, (orig) => function (...args) {
      try { return orig.apply(this, args); } finally { onWrite(); }
    });
  }
  hook(fs.promises, name, (orig) => async function (...args) {
    try { return await orig.apply(this, args); } finally { onWrite(); }
  });
}

/** Install bundled package assets (pi's package.json, themes, docs…) into the volume. */
export function seedAssets(assets) {
  for (const [path, b64] of Object.entries(assets)) {
    fs.mkdirSync(path.replace(/\/[^/]*$/, ""), { recursive: true });
    fs.writeFileSync(path, Buffer.from(b64, "base64"));
  }
}
