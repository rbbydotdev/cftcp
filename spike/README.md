# cftcp spike: SSH into a Durable Object running pi

```
ssh clicker@box ──TCP──▶ Worker connect() ──▶ Box DO connect(socket)
                                               ├─ russh (Rust → wasm32) ── SSH
                                               ├─ pi (@earendil-works/pi-coding-agent, real TUI)
                                               │    ├─ read/write/edit ─▶ @cloudflare/computer Workspace (DO SQLite)
                                               │    ├─ bash   ─▶ Worker shell: just-bash in a Dynamic Worker
                                               │    ├─ run_js ─▶ Codemode: ES module in a Dynamic Worker
                                               │    ├─ run_python ─▶ Pyodide in a Dynamic Worker (fs via PyFs RPC)
                                               │    └─ sql    ─▶ ProjectDb DO: one SQLite database per project
                                               └─ pi's own state (~/.pi): memfs → @cloudflare/shell Workspace
http://127.0.0.1:8787/<project>/ ─▶ static preview of /workspace/<project>
```

- **SSH username = project.** `ssh clicker@…` works in `/workspace/clicker`; an
  existing project resumes its last pi session (`--continue`).
- **pi** runs its real CLI entry (`main()`) and InteractiveMode. Changes:
  terminal = SSH channel; `node:fs` = memfs (pi's config/sessions only); project
  tools come from an inline extension (`box/computer-tools.mjs`); `process.exit`
  closes the session. One live pi session per DO (it uses the global `process`).
- **`ssh admin@…`** opens an admin TUI instead (name set by `ADMIN_USER`): a list of
  projects with an info card each (files, last change, preview link, pi sessions and
  last prompt, git head, database). ↑/↓/Tab or tap to select, Enter or [Enter] to open the project in pi in
  the same session (quitting pi returns to the list), `d` or [Remove] to
  delete a project (files, pi sessions, database; refused while it has a live pi
  session), `r` refresh, `q` quit.
- **`/AGENTS.md`** (from `box/AGENTS.md`, rewritten each boot) tells pi about the
  environment and its limits; pi loads it in every project.

## Run

From the repo root: `./try [project]` (see `./try --help`). `./try --mock demo`
runs real pi against a scripted local model (`dev/mock-llm.py`, scenarios
`clicker`, `sql`, `sqlcount`, `python`), no key needed. It goes through a local
stand-in for the Workers AI binding (`dev/fake-ai.mjs`), i.e. the same code path
as a deployed box.

**Models: no key needed when deployed.** The Worker's `AI` binding (Workers AI)
is pi's default provider (`cloudflare`, default model `@cf/moonshotai/kimi-k2.6`;
pick others with `/model`, or set `PI_MODEL`). It uses Cloudflare's pi-ai
provider (`agents/models/pi-ai`) via `box/workers-ai.mjs`, which lists only
`@cf/` models and caps output at 32k tokens (the catalog's maxTokens = context
window gets rejected by Workers AI). Usage bills to your Cloudflare account.

Optional other providers (Worker vars/secrets): `OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, or pi's own `/login`; `PI_PROVIDER` picks the default. Locally
(`./try` without `--mock`) there's no AI binding, so it asks for an OpenRouter key.

Build: `npm run build` (cargo + wasm-bindgen + `box/bundle.mjs`). Needs Rust 1.91
with `wasm32-unknown-unknown`, a wasm-capable clang (for `ring`) and
`wasm-bindgen-cli` matching `sshd/Cargo.lock`. Bundle ≈ 4.4 MB gzipped.

## How pi is made to run in workerd (`box/bundle.mjs`)

- `fs`/`fs/promises` → memfs (`box/vfs.mjs`); `graceful-fs` → plain fs.
- Each package's `import.meta.url` → its path under `/usr/lib/node_modules` on
  memfs, where its assets (package.json, themes, docs) are seeded.
- `main.js`: pass our terminal to `InteractiveMode`; `http-dispatcher.js`: keep
  workerd's native `fetch` (undici over node:tls lacks ALPN).
- Native addons and jiti stubbed; `PI_OFFLINE=1` (no fd/rg downloads, no update checks).

## Layout

- `sshd/` – wasm SSH server; `sshd/vendor/russh` = russh 0.65.2 + `cftcp patch`es
  (server on wasm32, timers via wasmtimer).
- `box/worker.mjs` – Worker + `Box` DO (`withWorkspace` + backends, preview, SSH).
- `box/realpi.mjs` – pi session; `box/workers-ai.mjs` – Workers AI provider for pi; `box/admin.mjs` – admin TUI; `box/computer-tools.mjs` – pi tools on the Workspace;
  `box/python.mjs` – run_python runner + PyFs.
- `box/machine.mjs`, `box/vfs.mjs` – pi's state disk; `box/shell.mjs` – `--bash`.
- `dev/mock-llm.py` – scripted model; `dev/fake-ai.mjs` – local stand-in for the AI binding.
- `probe/`, `probe-computer/`, `probe-python/` – capability probes.

## Known gaps

- Not yet tested with a real model reply, or deployed to Cloudflare.
- just-bash's `python3`/`sqlite3`/`js-exec` are Node-only (worker_threads); replaced by
  `run_python`, `sql` and `run_js`. Python is stdlib-only (no packages yet).
- pi warns about missing `fd`/`rg` (only affects `@` autocomplete).
- No SFTP/scp, `exec` requests or port forwarding; one DO for everything.
