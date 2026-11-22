// pi's tools on @cloudflare/computer: project files live in the Durable
// Object's Workspace (/workspace/<project>), and commands run in Dynamic
// Workers, off the DO's own thread.
//   bash   → WorkerShellBackend (just-bash in a fresh isolate)
//   run_js → CodemodeBackend (an ES module in a fresh isolate, node:fs = the Workspace)
//   read/write/edit → workspace.fs
import {
  createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const enc = new TextEncoder();

/** Env for every shell/JS run (git in the Worker shell needs an identity). */
export const EXEC_ENV = {
  GIT_AUTHOR_NAME: "pi", GIT_AUTHOR_EMAIL: "pi@do-box.local",
  GIT_COMMITTER_NAME: "pi", GIT_COMMITTER_EMAIL: "pi@do-box.local",
};

async function bytesOf(ws, path) {
  const stream = await ws.fs.readFile(path, {});
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Run `source` on a backend, streaming stdout/stderr to onData. Returns
 * {exitCode, stdout, stderr, value, status}. (A handle is either streamed or
 * awaited with result(), never both, so the result is built from the events.)
 */
export async function execStreaming(ws, source, { backend, cwd, signal, timeoutMs, onData, input }) {
  const handle = await ws.runtime.exec(source, { backend, cwd, encoding: "utf8", timeoutMs, input, env: EXEC_ENV });
  const onAbort = () => handle.kill("SIGTERM").catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const r = { exitCode: 1, stdout: "", stderr: "", value: undefined, status: "failed" };
  try {
    const reader = handle.getReader();
    for (;;) {
      const { value: ev, done } = await reader.read();
      if (done) break;
      if (ev.name === "stdout" || ev.name === "stderr") {
        r[ev.name] += ev.value ?? "";
        if (ev.value) onData?.(ev.value);
      } else if (ev.name === "exit") {
        r.exitCode = ev.code;
        r.value = ev.result;
        r.status = signal?.aborted ? "killed" : ev.code === 0 ? "completed" : "failed";
      }
    }
    return r;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

const fileOps = (ws) => ({
  readFile: async (p) => Buffer.from(await bytesOf(ws, p)),
  access: async (p) => {
    if (!(await ws.fs.stat(p))) throw Object.assign(new Error(`ENOENT: no such file, '${p}'`), { code: "ENOENT" });
  },
  writeFile: (p, content) => ws.fs.writeFile(p, content),
  mkdir: (d) => ws.fs.mkdir(d, { recursive: true }),
});

/** A pi InlineExtension that swaps in the Workspace-backed tools. */
export function computerExtension(ws, cwd, descriptions, db, python) {
  return {
    name: "cloudflare-computer",
    factory: (pi) => {
      const ops = fileOps(ws);
      pi.registerTool(createReadToolDefinition(cwd, { operations: ops }));
      pi.registerTool(createWriteToolDefinition(cwd, { operations: ops }));
      pi.registerTool(createEditToolDefinition(cwd, { operations: ops }));

      const bashOps = {
        async exec(command, dir, { onData, signal, timeout }) {
          const r = await execStreaming(ws, command, {
            backend: "worker-shell", cwd: dir, signal, timeoutMs: timeout ? timeout * 1000 : undefined,
            onData: (s) => onData(Buffer.from(s)),
          });
          return { exitCode: r.exitCode ?? 1 };
        },
      };
      const bash = createBashToolDefinition(cwd, { operations: bashOps });
      if (descriptions["worker-shell"]) bash.description = `${bash.description}\n\n${descriptions["worker-shell"]}`;
      pi.registerTool(bash);
      pi.on("user_bash", () => ({ operations: bashOps }));

      if (db) pi.registerTool({
        name: "sql",
        label: "sql",
        description:
          "Run one SQL statement against this project's own SQLite database (real SQLite in a dedicated " +
          "Durable Object; it persists). Use it for data work: create tables, load rows, query, aggregate. " +
          "Use `?` placeholders with `params`. One statement per call. BEGIN/COMMIT/SAVEPOINT are not " +
          "allowed (each call is atomic on its own), nor ATTACH. List tables with " +
          "`SELECT name FROM sqlite_master WHERE type='table'`. The browser can't reach this database; " +
          "it is for you, not for the web page.",
        promptSnippet: "sql: run SQL on the project's persistent SQLite database",
        parameters: Type.Object({
          query: Type.String({ description: "One SQL statement." }),
          params: Type.Optional(Type.Array(Type.Any(), { description: "Values for `?` placeholders." })),
        }),
        executionMode: "sequential",
        async execute(_id, { query, params }) {
          const r = await db.query(query, params ?? []);
          const lines = [];
          if (r.columns.length) {
            lines.push(r.columns.join(" | "));
            for (const row of r.rows) lines.push(row.map((v) => (v === null ? "NULL" : String(v))).join(" | "));
            lines.push(`(${r.rows.length} row${r.rows.length === 1 ? "" : "s"}${r.truncated ? ", truncated at 200" : ""})`);
          } else {
            lines.push(`ok: ${r.rowsWritten} row(s) written`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details: r };
        },
      });

      if (python) pi.registerTool({
        name: "run_python",
        label: "run_python",
        description:
          "Run Python 3 (CPython on Pyodide, standard library only) in an isolated runtime. Use it for data " +
          "work, scripts, calculations and testing Python code. Define `async def main(fs, input):` to get " +
          "the project's files and a JSON input; its return value comes back to you, and print() output is " +
          "captured. `fs` has `await fs.read(path)`, `await fs.write(path, text)`, `await fs.listdir(path)`, " +
          "`await fs.exists(path)`, with paths relative to the project (text files only). Without `main`, " +
          "the code just runs. No network, no pip packages, no `open()` on project files (use `fs`). " +
          "The first call may take a few seconds while Python starts; later calls are fast.",
        promptSnippet: "run_python: run Python 3 (stdlib) with async fs access to the project",
        parameters: Type.Object({
          source: Type.String({ description: "Python source. Optionally define `async def main(fs, input):`." }),
          input: Type.Optional(Type.Any({ description: "JSON value passed as `input`." })),
        }),
        async execute(_id, { source, input }) {
          const r = await python(source, input);
          const parts = [];
          if (r.output) parts.push(`output:\n${r.output}`);
          if (r.value !== null && r.value !== undefined) parts.push(`return value:\n${JSON.stringify(r.value, null, 2)}`);
          if (!parts.length) parts.push("(no output)");
          const text = parts.join("\n\n");
          if (!r.ok) throw new Error(text);
          return { content: [{ type: "text", text }], details: { value: r.value } };
        },
      });

      pi.registerTool({
        name: "run_js",
        label: "run_js",
        description:
          "Run JavaScript in a fresh, isolated V8 runtime against this project's files. Use it to execute and " +
          "test code you've written (pure logic, data processing, module self-tests), since `bash` has no node.\n" +
          `This project is at ${cwd}. Use absolute paths with node:fs (e.g. "${cwd}/app.js"); relative ` +
          "imports (`import x from \"./lib.js\"`) resolve from the project directory.\n\n" +
          (descriptions.codemode ?? ""),
        promptSnippet: "run_js: execute an ES module (default export gets `input`) in an isolate with node:fs = the project",
        parameters: Type.Object({
          source: Type.String({ description: "ES module source. Put the work in `export default async function (input) { ... }`." }),
          input: Type.Optional(Type.Any({ description: "JSON value passed to the default export." })),
        }),
        async execute(_id, { source, input }, signal) {
          let out = "";
          const r = await execStreaming(ws, source, {
            backend: "codemode", cwd, signal, input, timeoutMs: 60_000, onData: (s) => (out += s),
          });
          const parts = [];
          if (out) parts.push(`output:\n${out}`);
          if (r.stderr && !out.includes(r.stderr)) parts.push(`stderr:\n${r.stderr}`);
          if (r.value !== undefined) parts.push(`return value:\n${JSON.stringify(r.value, null, 2)}`);
          parts.push(`status: ${r.status}, exit code ${r.exitCode}`);
          const text = parts.join("\n\n");
          if (r.status !== "completed" || r.exitCode) throw new Error(text);
          return { content: [{ type: "text", text }], details: { value: r.value } };
        },
      });
    },
  };
}

export { enc };
