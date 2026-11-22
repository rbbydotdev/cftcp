// Plain interactive bash over SSH: each line runs in @cloudflare/computer's
// Worker shell (just-bash in a Dynamic Worker) against the Workspace.
// The shell is stateless per command, so we carry cwd between lines.
import { LineEditor, crlf } from "./machine.mjs";
import { EXEC_ENV } from "./computer-tools.mjs";

const enc = new TextEncoder();
const MARK = "\x1f__cwd__";

export function bashPrompt(user, cwd, host = "do-box") {
  return `\x1b[1;32m${user}@${host}\x1b[0m:\x1b[1;34m${cwd}\x1b[0m$ `;
}

export class BashShell {
  constructor(workspace) {
    this.workspace = workspace;
    this.editor = new LineEditor();
  }

  async open(user) {
    this.user = user || "user";
    this.ws = await this.workspace;
    this.cwd = `/workspace/${this.user.replace(/[^\w.-]/g, "_")}`;
    await this.ws.fs.mkdir(this.cwd, { recursive: true });
    return enc.encode(`just-bash in a Dynamic Worker, files in the Durable Object's Workspace\r\n\r\n` + bashPrompt(this.user, this.cwd));
  }

  resize() {}

  async run(line) {
    // Append a marker with the final $PWD so `cd` carries over to the next line.
    const h = await this.ws.runtime.exec(`${line}\n__s=$?; printf '${MARK}%s' "$PWD"; exit $__s`, {
      backend: "worker-shell", cwd: this.cwd, encoding: "utf8", env: EXEC_ENV,
    });
    const r = await h.result();
    let out = r.stdout ?? "";
    const i = out.lastIndexOf(MARK);
    if (i >= 0) {
      this.cwd = out.slice(i + MARK.length) || this.cwd;
      out = out.slice(0, i);
    }
    let text = out + (r.stderr ?? "");
    if (text && !text.endsWith("\n")) text += "\n";
    return crlf(text);
  }

  async input(bytes) {
    const { echo, events } = this.editor.feed(bytes);
    let out = echo;
    for (const ev of events) {
      if (ev.type === "eof") return null;
      if (ev.type === "clear") out += "\x1b[H\x1b[2J";
      if (ev.type === "line") {
        if (/^\s*(exit|logout)\s*$/.test(ev.text)) return null;
        if (ev.text.trim()) {
          try {
            out += await this.run(ev.text);
          } catch (e) {
            out += crlf(`bash: ${e?.message ?? e}\n`);
          }
        }
      }
      out += bashPrompt(this.user, this.cwd);
    }
    return enc.encode(out);
  }
}
