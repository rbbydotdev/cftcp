# Environment: pi inside a Cloudflare Durable Object

You are running inside a Cloudflare Durable Object, reached over SSH. This is not
a normal Linux machine. Read this before running commands.

## Your tools

- **`read` / `write` / `edit`**: the project's files. Prefer these for files.
- **`bash`**: [just-bash](https://github.com/vercel-labs/just-bash), a bash
  interpreter written in JavaScript, run in a fresh isolate (a Cloudflare Dynamic
  Worker) for each call. Pipes, redirects, loops, functions, `$(...)` and globbing
  work. Built-in commands: `ls cat cp mv rm mkdir touch find grep rg sed awk cut
  sort uniq head tail wc tr diff jq tar gzip base64 sha256sum date seq xargs tee
  printf echo env stat`, and a built-in `git` (init, add, commit, status, diff,
  log, …) that works on the project's files. Each call starts in the project
  directory; `cd` does not carry over between calls.
- **`run_js`**: runs an ES module in a fresh, isolated V8 runtime with
  `node:fs/promises` pointing at the project's files. Use it to **execute and test
  JavaScript you write**: pure logic, data processing, a module's self-test.
  `export default async function (input) { ... }`; the return value comes back to you.
  Use absolute paths with `node:fs` (relative fs paths resolve from `/workspace`).
  No DOM, no network, no npm packages.

- **`run_python`**: Python 3 (CPython on Pyodide, standard library only) in an
  isolated runtime. Define `async def main(fs, input):` and use `await fs.read(p)`,
  `await fs.write(p, text)`, `await fs.listdir(p)` for project files (relative
  paths); the return value comes back to you. First call can take a few seconds.
  No pip packages, no network.
- **`sql`**: one SQL statement against the project's own persistent SQLite
  database (real SQLite, in its own Durable Object). Use `?` + `params`. No
  BEGIN/COMMIT (each call is atomic), no ATTACH. It's for your data work; the web
  page can't reach it.

## Not available

`node`, `npm`, `npx`, `python3` in bash (use `run_python`), `sqlite3` (use `sql`), `curl`/`wget`, compilers, package
managers, `sudo`, background processes, servers, ports, `&` jobs. No network from
`bash` or `run_js`. Don't try to install things.

## Limits

- `bash` and `run_js` run in their own isolates, so heavy work there doesn't freeze
  the user's terminal, but each call still has a CPU-time limit. Keep commands and
  scripts short.
- Large binary files are possible but slow; text files are the sweet spot.

## Files

- Each SSH username is a project: you are working in `/workspace/<name>` (your
  current directory). Keep the project's files there.
- The disk persists in the Durable Object's SQLite (`@cloudflare/computer`
  Workspace). Everything survives reconnects and restarts.

## Building things

- **Use git for history:** `git init` once per project, and commit after each
  working change, so the user can see and undo what you did.
- **Make static web projects:** HTML, CSS and browser JavaScript (ES modules,
  `<script type="module">`). The *browser* can load libraries from a CDN
  (`https://esm.sh/...`, `https://cdn.jsdelivr.net/npm/...`); there is no npm
  install and no bundler.
- Keep logic in plain ES modules without DOM access where you can, so `run_js` can
  import and test them (`export { default } from "./test.js"` or inline code).
- **Preview:** files are served at `http://127.0.0.1:8787/<project>/` (the
  project's `index.html`). Tell the user that URL when you've built something.
  It's static file serving only; there is no backend.
