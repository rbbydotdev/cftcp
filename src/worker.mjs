import { DurableObject } from "cloudflare:workers";
import { getWorkspace, withWorkspace, WorkspaceServiceProxy } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import jq from "@cloudflare/computer/shell/jq";
import { createGitClient } from "@cloudflare/computer/git";
import wasmModule from "../sshd/pkg/cftcp_sshd_bg.wasm";
import { Machine } from "./machine.mjs";
import { RealPiShell } from "./realpi.mjs";
import { AdminShell } from "./admin.mjs";
import { PyFs, runPython } from "./python.mjs";
import { initSync, serve, generateHostKey } from "../sshd/pkg/cftcp_sshd.js";

initSync({ module: wasmModule });

// The Worker shell's Dynamic Worker reaches this DO's Workspace through this proxy.
export { WorkspaceServiceProxy };
// run_python's Dynamic Worker reads/writes project files through this.
export { PyFs };

const TYPES = {
  html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", gif: "image/gif", txt: "text/plain", md: "text/plain",
};
const html = (body) => new Response(`<!doctype html><meta charset=utf-8><title>do-box</title>${body}`, {
  headers: { "content-type": "text/html; charset=utf-8" },
});

class BoxBase extends DurableObject {
  /** @cloudflare/computer Workspace: project files + Dynamic Worker backends. */
  get workspace() {
    return (this._ws ??= getWorkspace(this));
  }
  /** pi's own state (sync node:fs over memfs) and the SSH user env. */
  get machine() {
    return (this._machine ??= new Machine(this.ctx, { previewUrl: this.env.PREVIEW_URL }));
  }

  async hostKey() {
    let key = await this.ctx.storage.get("ssh_host_ed25519_key");
    if (!key) { key = generateHostKey(); await this.ctx.storage.put("ssh_host_ed25519_key", key); }
    return key;
  }

  /**
   * The SSH username picks the shell: ADMIN_USER (default "admin") → admin TUI, else a project.
   * From the admin TUI, Enter on a project switches this same session into pi for it;
   * quitting pi returns to the admin TUI.
   */
  makeShell() {
    const adminUser = this.env.ADMIN_USER || "admin";
    const admin = () => new AdminShell({
      workspace: this.workspace, machine: this.machine, env: this.env,
      isLive: (p) => !!globalThis.__cftcpLive?.has(p),
      livePi: () => [...(globalThis.__cftcpLive ?? [])][0],
      enter: (project) => router.queue({ user: project, make: pi, then: { user: adminUser, make: admin } }),
    });
    const pi = () => new RealPiShell(this.machine, this.workspace, this.env, {
      python: (project, source, input) => runPython({
        loader: this.env.LOADER, exports: this.ctx.exports, boxId: this.ctx.id.toString(), project, source, input,
        timeoutMs: Number(this.env.RUN_TIMEOUT_S ?? 120) * 1000,
      }),
    });
    const router = new RouterShell((user) => (user === adminUser ? admin() : pi()));
    return router;
  }

  // RPC for PyFs (run_python's file access); PyFs confines paths to the project.
  async wsRead(path) { return (await this.workspace).fs.readFile(path, "utf8"); }
  async wsWrite(path, text) {
    const fs = (await this.workspace).fs;
    await fs.mkdir(path.replace(/\/[^/]*$/, "") || "/", { recursive: true });
    await fs.writeFile(path, text);
  }
  async wsList(path) { return (await (await this.workspace).fs.readdir(path)).map((e) => e.name + (e.isDirectory ? "/" : "")); }
  async wsExists(path) { return !!(await (await this.workspace).fs.stat(path).catch(() => null)); }

  /** Browser preview: /<project>/<path> serves /workspace/<project>/<path>. */
  async fetch(request) {
    const url = new URL(request.url);
    // Preview is private unless PREVIEW_PUBLIC=1: needs ?token=PREVIEW_TOKEN once (then a cookie).
    if (this.env.PREVIEW_PUBLIC !== "1") {
      const token = this.env.PREVIEW_TOKEN;
      const cookie = /(?:^|;\s*)box_preview=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      const given = url.searchParams.get("token");
      if (!token || (given !== token && cookie !== token)) return new Response("not found", { status: 404 });
      if (given === token) {
        url.searchParams.delete("token");
        return new Response(null, { status: 302, headers: {
          location: url.pathname + url.search,
          "set-cookie": `box_preview=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        } });
      }
    }
    const fs = this.workspace.fs;
    const stat = (p) => fs.stat(p).catch(() => null);
    const rel = decodeURIComponent(url.pathname).split("/").filter((s) => s && s !== "." && s !== "..").join("/");
    if (!rel) {
      const names = (await stat("/workspace")) ? await fs.readdir("/workspace") : [];
      const items = names.filter((e) => e.isDirectory).map((e) => `<li><a href="/${e.name}/">${e.name}</a></li>`).join("");
      return html(`<h1>Projects</h1><ul>${items || "<li>no projects yet: ssh newname@… to make one</li>"}</ul>`);
    }
    let path = `/workspace/${rel}`;
    let st = await stat(path);
    if (st?.isDirectory) {
      if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/`, 301);
      const index = `${path}/index.html`;
      if (!(await stat(index))) {
        const list = (await fs.readdir(path)).map((e) => `<li><a href="${e.name}${e.isDirectory ? "/" : ""}">${e.name}</a></li>`).join("");
        return html(`<h1>${rel}</h1><ul>${list}</ul>`);
      }
      path = index;
      st = await stat(path);
    }
    if (!st) return new Response("not found", { status: 404 });
    const type = TYPES[path.split(".").pop()] ?? "application/octet-stream";
    return new Response(await fs.readFile(path, {}), {
      headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" },
    });
  }

  async connect(socket) {
    // The sshd treats an empty key list as "accept any key", so no keys = refuse everyone.
    const keys = (this.env.AUTHORIZED_KEYS ?? "").trim();
    if (!keys) {
      console.error("refusing SSH: AUTHORIZED_KEYS is not set (wrangler secret put AUTHORIZED_KEYS)");
      await socket.close();
      return;
    }
    const key = await this.hostKey();
    const shell = withSessionLimits(this.makeShell(), socket, this.env);
    try {
      await serve(socket.readable, socket.writable, key, keys, shell);
    } finally {
      shell.stopLimits();
      await shell.hangup().catch(() => {}); // connection gone: end the shell (pi exits, admin closes)
    }
  }
}

/**
 * Time limits for one SSH session, so a forgotten connection doesn't keep the
 * Durable Object awake (and billed) forever:
 *   IDLE_TIMEOUT_MIN  (default 30): no input from you AND no output (pi working
 *                     counts as output) for this long → disconnect.
 *   MAX_SESSION_HOURS (default 8): hard cap per connection.
 */
function withSessionLimits(shell, socket, env) {
  const idleMs = Number(env.IDLE_TIMEOUT_MIN ?? 30) * 60_000;
  const maxMs = Number(env.MAX_SESSION_HOURS ?? 8) * 3_600_000;
  const start = Date.now();
  let last = start;
  const touch = () => { last = Date.now(); };
  const input = shell.input.bind(shell);
  shell.input = async (bytes) => { touch(); return input(bytes); };
  shell.onActivity = touch; // RouterShell calls it on output
  const tick = Math.max(1_000, Math.min(30_000, idleMs / 4));
  const timer = setInterval(() => {
    const now = Date.now();
    const idleText = idleMs >= 60_000 ? `${Math.round(idleMs / 60_000)} min` : `${Math.round(idleMs / 1000)} s`;
    const reason = now - last >= idleMs ? `idle for ${idleText}`
      : now - start >= maxMs ? `session limit of ${env.MAX_SESSION_HOURS ?? 8} h reached` : null;
    if (!reason) return;
    clearInterval(timer);
    shell.emit?.(`\r\n\x1b[33mdo-box: disconnecting (${reason}). Reconnect to pick up where you left off.\x1b[0m\r\n`);
    setTimeout(async () => {
      await shell.close?.().catch(() => {});
      await socket.close().catch(() => {});
    }, 500);
  }, tick);
  shell.stopLimits = () => clearInterval(timer);
  return shell;
}

/**
 * Picks the real shell once the SSH username is known (open()), and forwards
 * the sshd's calls to it. Has read() only if the chosen shell streams output.
 *
 * queue({ user, make, then }) hands the session to another shell once the
 * current one ends (its read() returns null): make() is opened as `user`, and
 * `then` (same shape) is queued after it, e.g. admin → pi → back to admin.
 */
class RouterShell {
  constructor(pick) { this.pick = pick; }
  async open(user, cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.inner = this.pick(user);
    if (this.inner.read) this.read = () => this.#read();
    return this.inner.open(user, cols, rows);
  }
  queue(next) { this.next = next; }
  async #read() {
    for (;;) {
      const out = await this.inner.read();
      if (out) { this.onActivity?.(); return out; }
      const next = this.next;
      this.next = next?.then;
      if (!next || this.closing) return null;
      this.inner = next.make();
      const first = await this.inner.open(next.user, this.cols, this.rows);
      if (first?.length) return first;
    }
  }
  input(bytes) { return this.inner.input(bytes); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; this.inner?.resize(cols, rows); }
  emit(s) { this.inner?.emit?.(s); }
  close() { this.closing = true; return this.inner?.close?.(); }
  hangup() { this.closing = true; return this.inner?.hangup ? this.inner.hangup() : this.inner?.close?.(); }
}

export class Box extends withWorkspace(BoxBase, (self) => ({
  storage: self.ctx.storage,
  git: createGitClient(),
  backends: [
    new WorkerShellBackend({
      loader: self.env.LOADER,
      workspace: { binding: "BOX", id: self.ctx.id.toString() },
      ctx: self.ctx,
      commands: [jq],
    }),
    new CodemodeBackend({ loader: self.env.LOADER }),
  ],
})) {}

/** One SQLite database per project, for pi's `sql` tool (env.DB.getByName(project)). */
export class ProjectDb extends DurableObject {
  query(sql, params = [], { maxRows = 200 } = {}) {
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const rows = [];
    for (const row of cursor.raw()) {
      if (rows.length >= maxRows) break;
      rows.push(row);
    }
    return {
      columns: cursor.columnNames,
      rows,
      truncated: rows.length >= maxRows,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
      databaseSize: this.ctx.storage.sql.databaseSize,
    };
  }
  /** Wipe this project's database (admin → remove project). */
  async destroy() { await this.ctx.storage.deleteAll(); }
}

export default {
  fetch: (request, env) => env.BOX.getByName("default").fetch(request),
  async connect(socket, env) {
    const up = env.BOX.getByName("default").connect("box:22", { allowHalfOpen: true, secureTransport: "off" });
    await up.opened;
    await Promise.allSettled([socket.readable.pipeTo(up.writable), up.readable.pipeTo(socket.writable)]);
  },
};
