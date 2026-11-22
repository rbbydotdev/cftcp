// pi's own state: a synchronous node:fs (memfs, box/vfs.mjs) persisted to a
// @cloudflare/shell Workspace in DO SQLite. Holds ~/.pi (settings, sessions,
// login), pi's package assets and /AGENTS.md. Project files are NOT here; they
// live in the @cloudflare/computer Workspace (see worker.mjs, computer-tools.mjs).
import { Workspace } from "@cloudflare/shell";
import { fs as nodefs, WorkspacePersister, setOnWrite, seedAssets } from "./vfs.mjs";
import ASSETS from "virtual:assets";
import AGENTS_MD from "./AGENTS.md";

/** Tiny JSON key/value table in DO SQLite. */
export function kvStore(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
  return {
    get: (k) => {
      const r = sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
      return r ? JSON.parse(r.v) : undefined;
    },
    put: (k, v) => sql.exec("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, JSON.stringify(v)),
    delete: (k) => sql.exec("DELETE FROM kv WHERE k = ?", k),
  };
}

export class Machine {
  constructor(ctx, { hostname = "do-box", previewUrl } = {}) {
    this.previewUrl = previewUrl;
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.kv = kvStore(this.sql);
    this.hostname = hostname;
    this.envs = new Map(); // user -> env (cwd lives in env.PWD)
    this.nodefs = nodefs;
  }

  boot() {
    this.booting ??= this.#load();
    return this.booting;
  }

  async #load() {
    this.workspace = new Workspace({ sql: this.sql, namespace: "disk", name: () => this.hostname });
    this.persister = new WorkspacePersister(this.workspace);
    const t0 = Date.now();
    const n = await this.persister.load();
    seedAssets(ASSETS);
    // Environment notes pi loads as context in every project (it walks up from /workspace/<name>).
    nodefs.writeFileSync("/AGENTS.md", this.previewUrl ? AGENTS_MD.replaceAll("http://127.0.0.1:8787", this.previewUrl.replace(/\/$/, "")) : AGENTS_MD);
    setOnWrite(() => this.persister.schedule());
    console.log(`disk: loaded ${n} entries from Workspace in ${Date.now() - t0} ms`);
  }

  /** Make sure pending writes reach the Workspace (e.g. before a session ends). */
  flush() {
    return this.persister?.flush();
  }

  /** Per-user environment, created with a home directory on first login. */
  async login(user) {
    await this.boot();
    if (this.envs.has(user)) return this.envs.get(user);
    const home = `/home/${user}`;
    if (!nodefs.existsSync(home)) {
      nodefs.mkdirSync(home, { recursive: true });
      nodefs.writeFileSync(
        `${home}/README`,
        "pi's home inside a Cloudflare Durable Object. Projects live in /workspace/<name>.\n",
      );
    }
    const env = this.kv.get(`env:${user}`) ?? {
      HOME: home, USER: user, PWD: home, HOSTNAME: this.hostname, TERM: "xterm-256color",
    };
    this.envs.set(user, env);
    return env;
  }

}

/** Minimal PTY line discipline: echo, backspace, ^C, ^D, ^U, ^L, history. */
export class LineEditor {
  constructor() {
    this.line = "";
    this.history = [];
    this.histIdx = 0;
    this.esc = "";
    this.dec = new TextDecoder();
  }

  /** Feed raw bytes; returns { echo, events } where events are {type:"line"|"eof"|"interrupt"|"clear"}. */
  feed(bytes) {
    let echo = "";
    const events = [];
    for (const ch of this.dec.decode(bytes, { stream: true })) {
      if (this.esc || ch === "\x1b") {
        this.esc += ch;
        if (this.esc.length < 3) continue;
        const code = this.esc;
        this.esc = "";
        if ((code === "\x1b[A" || code === "\x1b[B") && this.history.length) {
          this.histIdx = Math.max(0, Math.min(this.history.length, this.histIdx + (code === "\x1b[A" ? -1 : 1)));
          const next = this.history[this.histIdx] ?? "";
          echo += "\b \b".repeat(this.line.length) + next;
          this.line = next;
        }
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        echo += "\r\n";
        const text = this.line;
        this.line = "";
        if (text.trim()) {
          this.history.push(text);
          this.histIdx = this.history.length;
        }
        events.push({ type: "line", text });
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          echo += "\b \b";
        }
      } else if (ch === "\x03") {
        this.line = "";
        echo += "^C\r\n";
        events.push({ type: "interrupt" });
      } else if (ch === "\x04") {
        if (!this.line) events.push({ type: "eof" });
      } else if (ch === "\x0c") {
        events.push({ type: "clear" });
      } else if (ch === "\x15") {
        echo += "\b \b".repeat(this.line.length);
        this.line = "";
      } else if (ch >= " ") {
        this.line += ch;
        echo += ch;
      }
    }
    return { echo, events };
  }
}

/** Convert LF to CRLF for the terminal. */
export const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
