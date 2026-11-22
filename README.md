<img src="assets/icon.svg" width="64" height="64" alt="">

# cftcp

Build apps from any SSH client, on your own Cloudflare account.

```sh
ssh myidea@box.your-domain.dev     # a new name makes a project; an existing one resumes it
ssh admin@box.your-domain.dev      # every project at a glance; Enter opens one
```

You land in [pi](https://github.com/earendil-works/pi), a coding agent, running
inside a Cloudflare Durable Object. It uses Workers AI through the Worker's `AI`
binding, so there's no model key to set up. Files, pi sessions and each project's
SQLite database persist in the Durable Object; nothing runs while you're away.

## Use it

**Deploy:** see [DEPLOY.md](DEPLOY.md). You need a Cloudflare account on Workers
Paid, a domain on a Pro plan (for the Spectrum TCP app), and an SSH key. In short:

```sh
npx wrangler login
npm run deploy
npm run keys          # who can log in: uploads ~/.ssh/id_ed25519.pub (or pass .pub files)
```

then create the Spectrum app (DEPLOY.md, step 3).

**Run locally:** `npm run dev -- <project>` (or `npm run dev -- admin`). It runs
`wrangler dev` with the same `wrangler.jsonc` you deploy, SSHes in on port 2222, and
serves previews at
`http://127.0.0.1:8787/<project>/`. pi uses your real Workers AI (the binding is
proxied to your account), so run `npx wrangler login` once; usage is billed as in
production. Local state lives in `.wrangler/state`.

**Test:** `npm test` (after `npm run build`). End-to-end over real SSH sessions:
a new project where pi builds an app through its tools, the preview, the admin
screen's Enter → pi → back, and key refusal. The model is the one stand-in: a
scripted endpoint (`test/mock-llm.py`) behind a fake `AI` binding (`test/fake-ai.mjs`),
so the test runs offline and repeatably; everything else is the production build.

## What you get

- **SSH username = project.** `ssh clicker@…` works in `/workspace/clicker` and
  resumes the project's last pi session.
- **`ssh admin@…`** (name set by `ADMIN_USER`): a list of projects with an info card
  each (files, last change, preview link, pi sessions and last prompt, git head,
  database). ↑/↓/Tab or tap to select; Enter (or [Enter]) opens the project in pi in
  the same session, and quitting pi returns to the list; `d` (or [Remove]) deletes a
  project (files, pi sessions, database; refused while pi has it open); `r` refresh,
  `q` quit.
- **Models:** Workers AI by default (provider `cloudflare`, model
  `@cf/moonshotai/kimi-k2.6`). `/model` in pi switches between the `@cf/` models, or
  set `PI_MODEL`. Optional other providers via secrets: `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`, or pi's own `/login`; `PI_PROVIDER` picks the default.
- **pi's tools** work on the project's files in the Durable Object: `read`/`write`/`edit`,
  `bash` (just-bash in a Dynamic Worker), `run_js`, `run_python` (Pyodide) and `sql`
  (the project's SQLite database). `/AGENTS.md` (from `src/AGENTS.md`) tells pi what
  the environment can and can't do.
- **Preview:** `/<project>/` serves the project's files over HTTP, behind
  `PREVIEW_TOKEN` when deployed.

## How it works

```
ssh myidea@box ──TCP──▶ Spectrum ──▶ Worker connect() ──▶ Box DO connect(socket)
                                                           ├─ russh (Rust → wasm32): the SSH server
                                                           ├─ pi (@earendil-works/pi-coding-agent, real TUI)
                                                           │    ├─ model ──────▶ env.AI (Workers AI) via agents/models/pi-ai
                                                           │    ├─ read/write/edit ─▶ @cloudflare/computer Workspace (DO SQLite)
                                                           │    ├─ bash ───────▶ just-bash in a Dynamic Worker
                                                           │    ├─ run_js ─────▶ ES module in a Dynamic Worker
                                                           │    ├─ run_python ─▶ Pyodide in a Dynamic Worker
                                                           │    └─ sql ────────▶ ProjectDb DO: one SQLite database per project
                                                           └─ pi's own state (~/.pi): memfs → @cloudflare/shell Workspace
https://…/<project>/ ─▶ static preview of /workspace/<project>
```

pi runs its real CLI entry (`main()`) and InteractiveMode, with these changes
(`src/bundle.mjs`, `src/realpi.mjs`):

- The terminal is the SSH channel; `process.exit` ends the session; a dropped
  connection makes pi exit like a terminal hangup.
- `fs`/`fs/promises` → memfs (`src/vfs.mjs`), holding only pi's config and sessions;
  `graceful-fs` → plain fs.
- Each package's `import.meta.url` → its path under `/usr/lib/node_modules` on memfs,
  where its assets (package.json, themes, docs) are seeded.
- `main.js`: pass our terminal to `InteractiveMode`; `http-dispatcher.js`: keep
  workerd's native `fetch` (undici over node:tls lacks ALPN).
- Native addons and jiti stubbed; `PI_OFFLINE=1` (no fd/rg downloads, no update checks).
- Project tools come from an inline extension (`src/computer-tools.mjs`); the
  Workers AI provider from `src/workers-ai.mjs`, which wraps Cloudflare's
  `agents/models/pi-ai`, lists only `@cf/` models and caps output at 32k tokens
  (the catalog's maxTokens equals the context window, which Workers AI rejects).
- One live pi session per Durable Object (pi uses the global `process`).

## Build

`npm run build` (cargo + wasm-bindgen + `src/bundle.mjs` → `dist/`). Needs Rust 1.91
with `wasm32-unknown-unknown`, a wasm-capable clang (for `ring`) and
`wasm-bindgen-cli` matching `sshd/Cargo.lock`. Bundle ≈ 4.4 MB gzipped.

## Layout

- `src/worker.mjs` – Worker + `Box` DO (Workspace + backends, preview, SSH routing).
- `src/realpi.mjs` – pi session; `src/workers-ai.mjs` – Workers AI provider;
  `src/admin.mjs` – admin TUI; `src/computer-tools.mjs` – pi's tools on the Workspace;
  `src/python.mjs` – run_python runner; `src/machine.mjs`, `src/vfs.mjs` – pi's state disk.
- `sshd/` – the wasm SSH server; `sshd/vendor/russh` = russh 0.65.2 + `cftcp patch`es
  (server on wasm32, timers via wasmtimer).
- `test/` – end-to-end test, its Miniflare setup, SSH driver and model stand-in.
- `scripts/dev.sh` – local run (`npm run dev`); `scripts/keys.sh` – `npm run keys`; `wrangler.jsonc` – the deployed config,
  also used locally.

## Known gaps

- Not yet deployed to a real account, nor run against a real Workers AI model.
  `wrangler.jsonc` uses the `experimental` compatibility flag (for pi's `bash`
  backend), which production may refuse; see DEPLOY.md.
- just-bash's `python3`/`sqlite3`/`js-exec` are Node-only; replaced by `run_python`,
  `sql` and `run_js`. Python is stdlib-only (no packages yet).
- pi warns about missing `fd`/`rg` (only affects `@` autocomplete).
- No SFTP/scp, `exec` requests or port forwarding; one Durable Object for everything.
- wasmtimer timers can stop firing in workerd after an earlier session's timers
  were dropped; the sshd avoids relying on them (`sshd/vendor/russh/src/rt_time.rs`).
