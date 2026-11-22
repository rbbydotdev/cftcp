// `ssh admin@box`: a small full-screen TUI over the box's projects.
//   ↑/↓, j/k, Tab/Shift-Tab, mouse click or wheel: select a project
//   Enter / o / click [Enter]: open the project in pi (quit pi to come back here)
//   d / Delete / click [Remove]: remove it (files, pi sessions, SQL database)
//   r: refresh   q / Esc / Ctrl-C: quit
// Narrow terminals (phones) get the list on top and the card below it.
import { EXEC_ENV } from "./computer-tools.mjs";

const enc = new TextEncoder();
const ESC = "\x1b[";
// Tokyo Night (night) in 24-bit color. Every style ends by restoring BASE, so
// the theme background stays painted across the whole screen.
const T = {
  bg: "#1a1b26", bgDark: "#16161e", sel: "#283457", border: "#3b4261",
  fg: "#c0caf5", fgDark: "#a9b1d6", comment: "#565f89",
  blue: "#7aa2f7", cyan: "#7dcfff", purple: "#bb9af7", green: "#9ece6a",
  red: "#f7768e", yellow: "#e0af68", orange: "#ff9e64",
};
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
const BASE = `${ESC}38;2;${rgb(T.fg)};48;2;${rgb(T.bg)}m`;
const paint = (fg, bg) => {
  const code = `${ESC}${[fg && `38;2;${rgb(fg)}`, bg && `48;2;${rgb(bg)}`].filter(Boolean).join(";")}m`;
  return (s) => `${code}${s}${BASE}`;
};
const style = {
  bold: (s) => `${ESC}1m${s}${ESC}22m`,
  dim: paint(T.comment),
  border: paint(T.border),
  label: paint(T.blue),
  name: paint(T.purple),
  link: paint(T.cyan),
  hash: paint(T.orange),
  red: paint(T.red),
  green: paint(T.green),
  yellow: paint(T.yellow),
  sel: paint(T.fg, T.sel),
  selMark: paint(T.blue, T.sel),
  selMeta: paint(T.fgDark, T.sel),
  badge: paint(T.bg, T.blue),
  bar: paint(T.fgDark, T.bgDark),
  btn: paint(T.fg, T.border),
  btnKey: paint(T.blue, T.border),
  danger: paint(T.bg, T.red),
};
/** Fill the rest of the line with the bar color (title/footer rows). */
const BAR_FILL = `${ESC}48;2;${rgb(T.bgDark)}m${ESC}K`;

const size = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
/** Printable, single-width-ish text, cut/padded to w columns. */
function fit(s, w, pad = true) {
  s = String(s).replace(/[^\x20-\x7e\u00a0-\u024f\u2000-\u206f\u2190-\u25ff]/g, "?");
  if (w <= 0) return "";
  if (s.length > w) s = w > 1 ? s.slice(0, w - 1) + "…" : s.slice(0, w);
  return pad ? s.padEnd(w) : s;
}
const sessionDir = (agentDir, project) => `${agentDir}/sessions/--workspace-${project}--`;

export class AdminShell {
  /** @param opts { workspace, machine, env, isLive(project), livePi(), enter(project) } */
  constructor({ workspace, machine, env, isLive, livePi, enter }) {
    Object.assign(this, { workspace, machine, env, isLive: isLive ?? (() => false), livePi: livePi ?? (() => null), enter });
    this.chunks = [];
    this.waiter = null;
    this.closed = false;
    this.projects = [];
    this.sel = 0;
    this.top = 0; // first visible list row
    this.modal = null; // { kind: "confirm", project } | { kind: "msg", text }
    this.status = "";
    this.regions = []; // clickable: { row, c0, c1, action }
    this.extra = new Map(); // project -> lazily loaded { git, db }
  }

  emit(s) {
    if (this.closed || !s) return;
    this.chunks.push(enc.encode(s));
    this.waiter?.();
  }
  async read() {
    while (!this.chunks.length && !this.closed) await new Promise((r) => (this.waiter = r));
    this.waiter = null;
    if (!this.chunks.length) return null;
    const all = this.chunks.splice(0);
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of all) { out.set(c, o); o += c.length; }
    return out;
  }

  async open(_user, cols, rows) {
    this.cols = cols || 80;
    this.rows = rows || 24;
    this.ws = await this.workspace;
    const env = await this.machine.login("user");
    this.agentDir = `${env.HOME}/.pi/agent`;
    // alt screen, hide cursor, mouse clicks + wheel (SGR encoding)
    this.emit(`\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h${BASE}\x1b[2J`);
    this.status = "loading…";
    this.render();
    await this.load();
    return new Uint8Array(0);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.emit(`${BASE}\x1b[2J`);
    this.render();
  }

  async close() {
    if (this.closed) return;
    this.emit(`\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l`);
    await this.machine.flush();
    // let the restore sequence go out before the channel ends
    await new Promise((r) => setTimeout(r, 50));
    this.closed = true;
    this.waiter?.();
  }

  // ---------- data ----------

  async load() {
    const fs = this.ws.fs;
    const keep = this.projects[this.sel]?.name;
    const dirs = (await fs.stat("/workspace").catch(() => null))
      ? (await fs.readdir("/workspace")).filter((e) => e.isDirectory) : [];
    const projects = [];
    for (const d of dirs) projects.push(await this.scan(d.name));
    projects.sort((a, b) => b.changed - a.changed);
    this.projects = projects;
    const i = projects.findIndex((p) => p.name === keep);
    this.sel = Math.max(0, Math.min(i >= 0 ? i : this.sel, projects.length - 1));
    this.status = "";
    this.render();
    this.loadExtra();
  }

  /** Files (outside .git), size, last change, pi sessions. */
  async scan(name) {
    const fs = this.ws.fs;
    const root = `/workspace/${name}`;
    const p = { name, files: 0, bytes: 0, changed: 0, git: false, index: false, sessions: 0, lastSession: 0, lastAsk: "" };
    const walk = async (dir, depth) => {
      if (depth > 12 || p.files > 5000) return;
      for (const e of await fs.readdir(dir).catch(() => [])) {
        if (dir === root && e.name === ".git") { p.git = true; continue; }
        if (dir === root && e.name === "index.html") p.index = true;
        p.changed = Math.max(p.changed, e.mtime ?? 0);
        if (e.isDirectory) await walk(`${dir}/${e.name}`, depth + 1);
        else { p.files++; p.bytes += e.size ?? 0; }
      }
    };
    await walk(root, 0);
    if (p.changed < 1e12) p.changed *= 1000; // seconds → ms if needed

    const nodefs = this.machine.nodefs;
    const sdir = sessionDir(this.agentDir, name);
    try {
      const files = nodefs.readdirSync(sdir).filter((f) => f.endsWith(".jsonl"));
      p.sessions = files.length;
      let newest = null;
      for (const f of files) {
        const m = nodefs.statSync(`${sdir}/${f}`).mtimeMs;
        if (m > p.lastSession) { p.lastSession = m; newest = f; }
      }
      if (newest) p.lastAsk = lastUserText(nodefs.readFileSync(`${sdir}/${newest}`, "utf8"));
    } catch {}
    p.changed = Math.max(p.changed, p.lastSession); // a chat counts as activity too
    return p;
  }

  /** Slower bits for the selected project: git head, database. Cached. */
  async loadExtra() {
    const p = this.projects[this.sel];
    if (!p || this.extra.has(p.name)) return;
    const x = { git: p.git ? "…" : "no repo", db: "…" };
    this.extra.set(p.name, x);
    this.render();
    const tasks = [];
    if (p.git) tasks.push((async () => {
      try {
        const h = await this.ws.runtime.exec("git log --oneline -1", {
          backend: "worker-shell", cwd: `/workspace/${p.name}`, encoding: "utf8", env: EXEC_ENV, timeoutMs: 15_000,
        });
        const r = await h.result();
        x.git = (r.stdout ?? "").trim().split("\n")[0] || "no commits";
      } catch (e) { x.git = `? ${e?.message ?? e}`; }
    })());
    tasks.push((async () => {
      try {
        const db = this.env.DB?.getByName(p.name);
        if (!db) { x.db = "n/a"; return; }
        const r = await db.query("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\'");
        const t = r.rows[0]?.[0] ?? 0;
        x.db = t ? `${t} table${t === 1 ? "" : "s"} · ${size(r.databaseSize)}` : "empty";
      } catch (e) { x.db = `? ${e?.message ?? e}`; }
    })());
    await Promise.all(tasks);
    this.render();
  }

  async remove(name) {
    if (this.isLive(name)) {
      this.modal = { kind: "msg", text: `${name} has a pi session open right now. Exit it first.` };
      return this.render();
    }
    this.modal = null;
    this.status = `removing ${name}…`;
    this.render();
    const errs = [];
    await this.ws.fs.rm(`/workspace/${name}`, { recursive: true, force: true }).catch((e) => errs.push(`files: ${e.message}`));
    const nodefs = this.machine.nodefs;
    for (const p of [`/workspace/${name}`, sessionDir(this.agentDir, name)]) {
      try { nodefs.rmSync(p, { recursive: true, force: true }); } catch (e) { errs.push(`${p}: ${e.message}`); }
    }
    await this.machine.flush();
    try { await this.env.DB?.getByName(name).destroy(); } catch (e) { errs.push(`db: ${e.message}`); }
    this.extra.delete(name);
    await this.load();
    this.status = errs.length ? style.red(`removed ${name}, with errors: ${errs.join("; ")}`) : style.green(`removed ${name}`);
    this.render();
  }

  // ---------- input ----------

  async input(bytes) {
    this.decoder ??= new TextDecoder();
    const s = this.decoder.decode(bytes, { stream: true });
    const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|\x1b|[\s\S]/g;
    for (const m of s.matchAll(re)) {
      if (this.closed) break;
      if (m[1] !== undefined) { if (m[4] === "M") await this.mouse(+m[1], +m[2], +m[3]); continue; }
      await this.key(m[0], s === "\x1b");
    }
    return new Uint8Array(0);
  }

  async mouse(b, x, y) {
    if (b === 64) return this.move(-1);
    if (b === 65) return this.move(1);
    if (b !== 0) return;
    const hit = this.regions.find((r) => r.row === y && x >= r.c0 && x <= r.c1);
    if (hit) await hit.action();
  }

  async key(k, loneEsc) {
    if (this.modal?.kind === "confirm") {
      const name = this.modal.project;
      if (k === "y" || k === "Y") return this.remove(name);
      if (k === "n" || k === "N" || k === "q" || (k === "\x1b" && loneEsc) || k === "\x03" || k === "\r") {
        this.modal = null;
        return this.render();
      }
      return;
    }
    if (this.modal?.kind === "msg") { this.modal = null; return this.render(); }
    switch (k) {
      case "\x1b[A": case "\x1bOA": case "k": case "\x1b[Z": return this.move(-1);
      case "\x1b[B": case "\x1bOB": case "j": case "\t": return this.move(1);
      case "\x1b[5~": return this.move(-this.listRows());
      case "\x1b[6~": return this.move(this.listRows());
      case "\x1b[H": case "\x1bOH": case "g": return this.move(-Infinity);
      case "\x1b[F": case "\x1bOF": case "G": return this.move(Infinity);
      case "\r": case "o": case "O": return this.enterProject();
      case "d": case "D": case "\x1b[3~": case "\x7f": return this.askRemove();
      case "r": case "R": this.status = "refreshing…"; this.extra.clear(); this.render(); return this.load();
      case "q": case "Q": case "\x03": case "\x04": return this.close();
      case "\x1b": if (loneEsc) return this.close(); return;
      case "\x0c": return this.render();
    }
  }

  move(d) {
    if (!this.projects.length) return;
    const n = this.projects.length;
    if (d === Infinity) this.sel = n - 1;
    else if (d === -Infinity) this.sel = 0;
    else if (Math.abs(d) === 1) this.sel = (this.sel + d + n) % n; // wraps, so Tab cycles
    else this.sel = Math.max(0, Math.min(n - 1, this.sel + d));
    this.render();
    this.loadExtra();
  }

  /** Hand this SSH session to pi for the selected project (back here when pi quits). */
  async enterProject() {
    const p = this.projects[this.sel];
    if (!p || !this.enter) return;
    const busy = this.livePi();
    if (busy) {
      this.modal = { kind: "msg", text: busy === p.name
        ? `${p.name} already has a pi session open in another connection.`
        : `pi is running for ${busy} in another connection. This box runs one pi session at a time for now.` };
      return this.render();
    }
    this.enter(p.name);
    await this.close();
  }

  askRemove() {
    const p = this.projects[this.sel];
    if (p) { this.modal = { kind: "confirm", project: p.name }; this.render(); }
  }

  // ---------- drawing ----------

  wide() { return this.cols >= 76; }
  listW() { return this.wide() ? Math.min(34, Math.floor(this.cols * 0.4)) : this.cols; }
  listRows() {
    const body = this.rows - 2; // title + footer
    return this.wide() ? body : Math.max(3, Math.min(this.projects.length || 1, Math.floor(body * 0.4)));
  }

  render() {
    if (this.closed) return;
    const W = this.cols, H = this.rows;
    const screen = Array.from({ length: H }, () => "");
    const regions = [];
    const put = (row, text) => { if (row >= 1 && row <= H) screen[row - 1] = text; };

    // title
    const total = this.projects.reduce((n, p) => n + p.bytes, 0);
    const badge = " do-box admin ";
    const info = `  ${this.projects.length} project${this.projects.length === 1 ? "" : "s"} · ${size(total)}`;
    put(1, style.badge(style.bold(fit(badge, W, false))) + style.bar(fit(info, Math.max(0, W - badge.length), false)) + BAR_FILL);

    // list
    const lw = this.listW(), lr = this.listRows();
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + lr) this.top = this.sel - lr + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.projects.length - lr)));
    const listLines = [];
    for (let i = 0; i < lr; i++) {
      const p = this.projects[this.top + i];
      if (!p) { listLines.push(" ".repeat(lw)); continue; }
      const idx = this.top + i;
      const meta = ` ${ago(p.changed).replace(" ago", "")}`;
      const nameW = Math.max(4, lw - 3 - meta.length);
      const name = fit(` ${fit(p.name, nameW)}`, lw - 1 - meta.length - 1);
      listLines.push(idx === this.sel
        ? style.selMark("▸") + style.sel(name) + style.selMeta(meta + " ")
        : " " + name + style.dim(meta + " "));
      regions.push({ row: 2 + i, c0: 1, c1: lw, action: () => { this.sel = idx; this.render(); this.loadExtra(); } });
    }
    if (!this.projects.length) listLines[0] = fit(this.status ? "" : " no projects yet", lw);

    // card
    const cardX = this.wide() ? lw + 3 : 1; // 1-based column
    const cardW = this.wide() ? W - lw - 2 : W;
    const cardTop = this.wide() ? 2 : 2 + lr;
    const cardH = this.wide() ? H - 2 : H - 2 - lr;
    const card = this.card(cardW, cardH, cardTop, cardX, regions);

    for (let r = 0; r < H - 2; r++) {
      const row = r + 2;
      if (this.wide()) {
        put(row, (listLines[r] ?? " ".repeat(lw)) + style.border("│") + " " + (card[r] ?? ""));
      } else {
        put(row, r < lr ? listLines[r] : card[r - lr] ?? "");
      }
    }

    // footer: clickable hints
    let col = 1, foot = "";
    const btn = (label, action) => {
      const [k, ...rest] = label.trim().split(" ");
      foot += style.btn(" ") + style.bold(style.btnKey(k)) + style.btn(` ${rest.join(" ")} `) + style.bar(" ");
      regions.push({ row: H, c0: col, c1: col + label.length - 1, action });
      col += label.length + 1;
    };
    if (this.modal?.kind === "confirm") {
      btn(" y remove ", () => this.remove(this.modal.project));
      btn(" n cancel ", () => { this.modal = null; this.render(); });
    } else {
      btn(" ↑↓ move ", () => this.move(1));
      btn(" ⏎ open ", () => this.enterProject());
      btn(" d remove ", () => this.askRemove());
      btn(" r refresh ", () => this.key("r"));
      btn(" q quit ", () => this.close());
    }
    const st = this.status ? " " + this.status : "";
    put(H, foot + style.bar(st) + BAR_FILL);

    this.regions = regions;
    this.emit(`\x1b[H${BASE}` + screen.map((l) => BASE + l + "\x1b[K").join("\r\n") + BASE + "\x1b[J");
  }

  /** The info card (or confirm dialog) as lines of width w. */
  card(w, h, top, left, regions) {
    const lines = [];
    const p = this.projects[this.sel];
    const inner = w - 4;
    const box = (rows, color = style.border) => {
      lines.push(color("┌" + "─".repeat(w - 2) + "┐"));
      for (const r of rows) {
        const plain = typeof r === "string" ? r : r.plain;
        const shown = typeof r === "string" ? fit(r, inner) : r.styled + " ".repeat(Math.max(0, inner - plain.length));
        lines.push(color("│") + " " + shown + " " + color("│"));
      }
      lines.push(color("└" + "─".repeat(w - 2) + "┘"));
    };
    if (w < 20 || h < 4) return lines;

    if (this.modal?.kind === "msg") {
      box(["", ...wrap(this.modal.text, inner), "", "press any key"], style.yellow);
      return lines;
    }
    if (!p) {
      const host = this.env.SSH_HOST || "<host>";
      box(["", "No projects yet.", "", "Make one by connecting with a new name:", `  ssh myproject@${host}`, ""]);
      return lines;
    }
    if (this.modal?.kind === "confirm") {
      box([
        "",
        { plain: `Remove ${p.name}?`, styled: style.bold(style.red(fit(`Remove ${p.name}?`, inner, false))) },
        "",
        `• ${p.files} file${p.files === 1 ? "" : "s"} (${size(p.bytes)})${p.git ? " and its git history" : ""}`,
        `• ${p.sessions} pi session${p.sessions === 1 ? "" : "s"}`,
        "• its SQL database",
        "",
        "This can't be undone.  y = remove, n = cancel",
      ], style.red);
      return lines;
    }

    const x = this.extra.get(p.name) ?? {};
    const preview = this.env.PREVIEW_URL ? `${this.env.PREVIEW_URL.replace(/\/$/, "")}/${p.name}/` : `/${p.name}/`;
    const host = this.env.SSH_HOST;
    const label = (k, v, paintVal = (s) => s) => {
      const key = fit(k, 9);
      const val = fit(v, Math.max(1, inner - 10), false);
      return { plain: `${key} ${val}`, styled: style.label(key) + " " + paintVal(val) };
    };
    const gitPaint = (v) => { const [h, ...m] = v.split(" "); return /^[0-9a-f]{6,}$/.test(h) ? style.hash(h) + " " + m.join(" ") : style.dim(v); };
    const live = this.isLive(p.name);
    const rows = [
      { plain: p.name + (live ? "  ● live" : ""), styled: style.bold(style.name(fit(p.name, inner - 8, false))) + (live ? style.green("  ● live") : "") },
      "",
      label("Files", `${p.files} · ${size(p.bytes)}`),
      label("Changed", p.changed ? `${ago(p.changed)} · ${new Date(p.changed).toISOString().slice(0, 16).replace("T", " ")}` : "never"),
      label("Preview", p.index ? preview : "no index.html", p.index ? style.link : style.dim),
      label("pi", p.sessions ? `${p.sessions} session${p.sessions === 1 ? "" : "s"} · last ${ago(p.lastSession)}` : "no sessions"),
      label("Last ask", p.lastAsk ? `"${p.lastAsk}"` : "-", p.lastAsk ? style.yellow : style.dim),
      label("Git", x.git ?? (p.git ? "…" : "no repo"), gitPaint),
      label("Database", x.db ?? "…"),
      label("Open", `ssh ${p.name}@${host || "<host>"}`, style.green),
      "",
    ];
    box(rows.slice(0, Math.max(0, h - 4)));
    // [ Enter ] [ Remove ] buttons under the card
    const enterB = " Enter ", removeB = " Remove ";
    lines.push(" " + style.bold(style.badge(enterB)) + " " + style.bold(style.danger(removeB)));
    const row = top + lines.length - 1;
    regions.push({ row, c0: left + 1, c1: left + enterB.length, action: () => this.enterProject() });
    const r0 = left + enterB.length + 2;
    regions.push({ row, c0: r0, c1: r0 + removeB.length - 1, action: () => this.askRemove() });
    return lines;
  }
}

function wrap(text, w) {
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > w) { out.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
}

/** Last user prompt in a pi session file (JSONL). */
function lastUserText(jsonl) {
  const lines = jsonl.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      const m = e.message ?? e;
      if (m?.role !== "user") continue;
      const c = m.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
      if (text.trim()) return text.replace(/\s+/g, " ").trim();
    } catch {}
  }
  return "";
}
