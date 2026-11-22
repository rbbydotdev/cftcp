// The real pi (@earendil-works/pi-coding-agent): its own CLI entry point and
// TUI (InteractiveMode), running inside the Durable Object. What we change:
//   - the terminal is the SSH channel (SshTerminal),
//   - node:fs is the DO's disk (src/vfs.mjs, aliased at bundle time),
//   - project files live in the @cloudflare/computer Workspace; pi's read/write/
//     edit/bash tools (and `!cmd`) run against it, bash and run_js in Dynamic Workers,
//   - process.exit ends the SSH session instead of the isolate.
import { main } from "@earendil-works/pi-coding-agent";
import { computerExtension } from "./computer-tools.mjs";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { workersAiProvider, WORKERS_AI_DEFAULT_MODEL, WORKERS_AI_PROVIDER } from "./workers-ai.mjs";

const enc = new TextEncoder();

/** pi-tui Terminal over an SSH channel (mirrors pi-tui's ProcessTerminal). */
class SshTerminal {
  constructor(emit, cols, rows) {
    this.emit = emit;
    this.cols = cols || 80;
    this.rowsN = rows || 24;
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }
  get kittyProtocolActive() { return false; }
  get columns() { return this.cols; }
  get rows() { return this.rowsN; }
  start(onInput, onResize) {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.buffer = new StdinBuffer({ timeout: 10 });
    this.buffer.on("data", (seq) => this.inputHandler?.(seq));
    this.buffer.on("paste", (content) => this.inputHandler?.(`\x1b[200~${content}\x1b[201~`));
    this.write("\x1b[?2004h"); // bracketed paste
  }
  stop() {
    this.write("\x1b[?2004l");
    this.buffer?.destroy();
    this.buffer = undefined;
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }
  restoreOnExit(before, after) { this.write(before + after); }
  async drainInput() {}
  feed(data) { this.buffer?.process(data); }
  resize(cols, rows) {
    this.cols = cols;
    this.rowsN = rows;
    this.resizeHandler?.();
  }
  write(data) { this.emit(data); }
  moveBy(n) { if (n > 0) this.write(`\x1b[${n}B`); else if (n < 0) this.write(`\x1b[${-n}A`); }
  hideCursor() { this.write("\x1b[?25l"); }
  showCursor() { this.write("\x1b[?25h"); }
  clearLine() { this.write("\x1b[K"); }
  clearFromCursor() { this.write("\x1b[J"); }
  clearScreen() { this.write("\x1b[2J\x1b[H"); }
  setTitle(title) { this.write(`\x1b]0;${title}\x07`); }
  setProgress() {}
  setProgramStatus() {}
}

/**
 * Which provider/model pi should default to. The Workers AI binding (env.AI)
 * comes first: it needs no key, so a fresh deploy just works. PI_PROVIDER /
 * PI_MODEL override; API keys are the fallback when there's no binding.
 */
function defaultModel(env) {
  if (env.PI_PROVIDER) return { provider: env.PI_PROVIDER, model: env.PI_MODEL };
  if (env.AI?.run) return { provider: WORKERS_AI_PROVIDER, model: env.PI_MODEL || WORKERS_AI_DEFAULT_MODEL };
  if (env.OPENROUTER_API_KEY) return { provider: "openrouter", model: env.PI_MODEL || "~deepseek/deepseek-flash-latest" };
  if (env.CLOUDFLARE_ACCOUNT_ID && (env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_TOKEN)) {
    return env.CLOUDFLARE_GATEWAY_ID
      ? { provider: "cloudflare-ai-gateway", model: env.PI_MODEL }
      : { provider: "cloudflare-workers-ai", model: env.PI_MODEL || "@cf/moonshotai/kimi-k2.6" };
  }
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", model: env.PI_MODEL };
  return {};
}

/** First-login pi config in ~/.pi/agent (never overwrites the user's own edits). */
function writeConfig(nodefs, agentDir, env) {
  nodefs.mkdirSync(agentDir, { recursive: true });
  const settingsPath = `${agentDir}/settings.json`;
  // npm test: always go through the stand-in AI binding, whatever an earlier run saved.
  if (env.MOCK_AI_URL && env.AI?.run) {
    const settings = nodefs.existsSync(settingsPath) ? JSON.parse(nodefs.readFileSync(settingsPath, "utf8")) : {};
    Object.assign(settings, { defaultProvider: WORKERS_AI_PROVIDER, defaultModel: WORKERS_AI_DEFAULT_MODEL });
    nodefs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  if (!nodefs.existsSync(settingsPath)) {
    const { provider, model } = defaultModel(env);
    const settings = { quietStartup: false };
    if (provider) settings.defaultProvider = provider;
    if (model) settings.defaultModel = model;
    nodefs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  const modelsPath = `${agentDir}/models.json`;
  if (!nodefs.existsSync(modelsPath)) {
    // DeepSeek V4.1 Flash is newer than pi's built-in model table.
    const models = {
      providers: {
        openrouter: {
          models: [
            { id: "~deepseek/deepseek-flash-latest", name: "DeepSeek Flash (latest, V4.1)", reasoning: true,
              input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
            { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", reasoning: true,
              input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
          ],
        },
      },
    };
    nodefs.writeFileSync(modelsPath, JSON.stringify(models, null, 2) + "\n");
  }
}

/**
 * Point the isolate's `process` at this user's session. `process` is global
 * to the isolate, so this supports one live pi session per Durable Object.
 */
function prepareProcess(home, agentDir, env, onExit) {
  const pe = process.env;
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") pe[k] = v;
  if (!pe.CLOUDFLARE_API_KEY && pe.CLOUDFLARE_API_TOKEN) pe.CLOUDFLARE_API_KEY = pe.CLOUDFLARE_API_TOKEN;
  Object.assign(pe, {
    HOME: home, USER: home.split("/").pop(), SHELL: "/bin/bash", TERM: "xterm-256color", COLORTERM: "truecolor",
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  });
  process.cwd = () => home;
  process.chdir = () => {};
  for (const s of [process.stdin, process.stdout, process.stderr]) {
    try { Object.defineProperty(s, "isTTY", { value: true, configurable: true }); } catch {}
  }
  process.exit = (code) => onExit(code ?? 0);
}

export class RealPiShell {
  constructor(machine, workspace, env, runners = {}) {
    this.machine = machine;
    this.runners = runners;
    this.workspace = workspace;
    this.env = env;
    this.chunks = [];
    this.waiter = null;
    this.closed = false;
  }

  emit(s) {
    if (this.closed || !s) return;
    this.chunks.push(typeof s === "string" ? enc.encode(s) : s);
    this.waiter?.();
  }

  /** Streamed output for the sshd; null ends the channel. */
  async read() {
    while (!this.chunks.length && !this.closed) await new Promise((r) => (this.waiter = r));
    this.waiter = null;
    if (this.chunks.length) {
      const all = this.chunks.splice(0);
      const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of all) { out.set(c, o); o += c.length; }
      return out;
    }
    return null;
  }

  /**
   * The SSH username is the project: `ssh clicker@box` works in /projects/clicker,
   * continuing its latest pi session if it exists. One shared home (~/.pi has
   * your login and settings) for all projects.
   */
  async open(sshUser, cols, rows) {
    const project = (sshUser || "scratch").replace(/[^\w.-]/g, "_");
    this.user = "user";
    const env = await this.machine.login(this.user);
    const home = env.HOME;
    const nodefs = this.machine.nodefs;
    // Project files live in the Workspace; memfs keeps a same-named empty dir so
    // pi's own sync cwd checks (and its AGENTS.md walk up to /) work.
    const cwd = `/workspace/${project}`;
    this.project = project;
    (globalThis.__cftcpLive ??= new Set()).add(project); // admin won't remove a live project
    const existed = nodefs.existsSync(cwd);
    nodefs.mkdirSync(cwd, { recursive: true });
    const ws = await this.workspace;
    await ws.fs.mkdir(cwd, { recursive: true });
    const descriptions = Object.fromEntries((ws.runtime.backends?.() ?? []).map((b) => [b.id, b.description]));
    const agentDir = `${home}/.pi/agent`;
    writeConfig(nodefs, agentDir, this.env);
    prepareProcess(home, agentDir, this.env, (code) => this.close(code));
    process.cwd = () => cwd;
    this.terminal = new SshTerminal((s) => this.emit(s), cols, rows);
    globalThis.__cftcpTerminal = () => this.terminal;
    const args = existed && nodefs.existsSync(`${agentDir}/sessions`) ? ["--continue"] : [];
    const db = this.env.DB?.getByName(project);
    const python = this.runners.python && ((source, input) => this.runners.python(project, source, input));
    const extensionFactories = [computerExtension(ws, cwd, descriptions, db, python)];
    const workersAi = workersAiProvider(this.env.AI);
    if (workersAi) extensionFactories.push({ name: "workers-ai", factory: (pi) => pi.registerProvider(workersAi) });
    main(args, { extensionFactories })
      .catch((e) => this.emit(`\r\n\x1b[31mpi crashed: ${String(e?.stack ?? e).replace(/\n/g, "\r\n")}\x1b[0m\r\n`))
      .finally(() => this.close(0));
    return new Uint8Array(0);
  }

  async input(bytes) {
    this.decoder ??= new TextDecoder();
    this.terminal?.feed(this.decoder.decode(bytes, { stream: true }));
    return new Uint8Array(0);
  }

  resize(cols, rows) { this.terminal?.resize(cols, rows); }

  /**
   * The SSH connection dropped: make pi exit the way a terminal hangup would.
   * Esc interrupts a running turn, Ctrl+C clears the editor, Ctrl+D exits (only
   * when the editor is empty). If pi hasn't exited after a few seconds, clean up anyway.
   */
  async hangup() {
    if (this.closed || !this.terminal) return this.close();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const key of ["\x1b", "\x03", "\x04"]) { this.terminal.feed(key); await sleep(300); }
    for (let i = 0; i < 20 && !this.closed; i++) await sleep(250);
    await this.close();
  }

  async close() {
    if (this.closed) return;
    globalThis.__cftcpLive?.delete(this.project);
    await this.machine.flush();
    this.closed = true;
    this.waiter?.();
  }
}
