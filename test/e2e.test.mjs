// End-to-end: real SSH sessions into the built box (dist/), with pi talking to
// the Workers AI binding's stand-in (test/fake-ai.mjs → test/mock-llm.py).
// Run: npm test   (needs `npm run build` first, plus ssh and python3)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBox } from "./miniflare.mjs";

const here = new URL(".", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "cftcp-e2e-"));
const key = join(dir, "id_ed25519");
let box, model, modelLog = "", sshPort, httpPort;

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * Run a command without blocking the event loop (Miniflare serves the SSH port
 * from this process, and the model's log arrives on it).
 */
function run(cmd, args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { timeout: timeoutMs });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** One SSH session as `user`; steps: [{ send, until, timeout }]. Returns [{ ok, out }]. */
async function ssh(user, steps) {
  const file = join(dir, `steps-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(steps));
  const r = await run("python3", [join(here, "ssh.py"), String(sshPort), user, key, file]);
  return r.stdout.split(/^@@step \d+ /m).slice(1).map((s) => ({ ok: s.startsWith("ok"), out: s.slice(s.indexOf("\n") + 1) }));
}

before(async () => {
  assert.ok(existsSync(join(here, "../dist/worker.js")), "build first: npm run build");
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const aiPort = await freePort();
  [sshPort, httpPort] = [await freePort(), await freePort()];
  model = spawn("python3", [join(here, "mock-llm.py"), String(aiPort), "clicker"]);
  model.stderr.on("data", (d) => (modelLog += d));
  box = await startBox({
    sshPort, httpPort, stateDir: join(dir, "state"),
    aiUrl: `http://127.0.0.1:${aiPort}/v1`,
    authorizedKeys: readFileSync(`${key}.pub`, "utf8"),
  });
});

after(async () => {
  await box?.stop();
  model?.kill();
});

test("a new project: pi starts on Workers AI with no key and builds with its tools", async () => {
  const [start, , build] = await ssh("clicker", [
    { until: "ripgrep not found", timeout: 30 },
    { timeout: 3 }, // let startup finish
    { send: "make a clicker\r", until: "remembers its count", timeout: 60 },
    { send: "/quit\r", timeout: 3 },
  ]);
  assert.ok(start.ok, `pi didn't start on the Workers AI default model:\n${start.out.slice(-1500)}`);
  assert.ok(build.ok, `pi didn't finish the task:\n${build.out.slice(-2000)}`);

  const requests = modelLog.split("\n").filter((l) => l.startsWith("mock-llm:"));
  assert.equal(requests.length, 5, `expected 5 model turns, got:\n${modelLog}`);
  for (const r of requests) {
    assert.match(r, /model=@cf\/moonshotai\/kimi-k2\.6 /);
    const max = Number(/max_tokens=(\d+)/.exec(r)?.[1] ?? 0);
    assert.ok(max <= 32768, `output tokens not capped: ${r}`);
    assert.match(r, /AGENTS\.md in context: True/);
  }
});

test("the preview serves what pi wrote", async () => {
  const res = await fetch(`http://127.0.0.1:${httpPort}/clicker/clicker/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Built by pi in a Durable Object/);
  assert.equal((await fetch(`http://127.0.0.1:${httpPort}/admin/`)).status, 404);
});

test("admin: lists the project, Enter opens it in pi, quitting pi comes back", async () => {
  const [list, inPi, , back] = await ssh("admin", [
    { until: "ssh clicker@", timeout: 20 },
    { send: "\r", until: "kimi-k2\\.6", timeout: 30 }, // pi resumed, status bar shows the model
    { timeout: 3 },
    { send: "/quit\r", until: "q quit", timeout: 15 },
    { send: "q", timeout: 2 },
  ]);
  assert.ok(list.ok, `admin didn't list the project:\n${list.out.slice(-1500)}`);
  assert.ok(inPi.ok, `Enter didn't open pi:\n${inPi.out.slice(-1500)}`);
  assert.ok(back.ok, `quitting pi didn't return to admin:\n${back.out.slice(-1500)}`);
});

test("an unknown SSH key is refused", async () => {
  const other = join(dir, "other");
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", other]);
  const r = await run("ssh", ["-p", String(sshPort), "-i", other, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "clicker@127.0.0.1"], 10_000); // refused promptly, also after other sessions
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Permission denied \(publickey\)/);
});
