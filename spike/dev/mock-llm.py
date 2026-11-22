#!/usr/bin/env python3
"""Scripted OpenAI-compatible chat endpoint for testing pi without an API key.

Each request's step = number of tool results already in the conversation.
The script makes pi build a tiny HTML/JS project with its real tools.
Usage: python3 dev/mock-llm.py [port] [clicker|sql]   (default 9999 clicker), logs to stderr.
"""
import http.server, json, sys, time

HTML = """<!doctype html>
<html>
<head><meta charset="utf-8"><title>Clicker</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
button{font-size:2rem;padding:.5em 1em;border-radius:12px}</style></head>
<body><div><h1>Built by pi in a Durable Object</h1>
<button id="b">clicks: 0</button></div>
<script src="app.js"></script></body>
</html>
"""
JS = """let n = Number(localStorage.getItem("n") || 0);
const b = document.getElementById("b");
const show = () => (b.textContent = `clicks: ${n}`);
b.onclick = () => { n++; localStorage.setItem("n", n); show(); };
show();
"""

STEPS = [
    ("I'll create the project.", "write", {"path": "clicker/index.html", "content": HTML}),
    (None, "write", {"path": "clicker/app.js", "content": JS}),
    ("Let me check it.", "bash", {"command": "cd clicker && ls -la && wc -l index.html app.js && grep -c onclick app.js"}),
    ("And run a quick check in an isolate.", "run_js", {"source": "import { readFile } from 'node:fs/promises';\nexport default async () => { const s = await readFile('/workspace/clicker/clicker/app.js', 'utf8'); return { lines: s.trim().split('\\n').length, hasClickHandler: s.includes('onclick') }; }"}),
    ("Done: `~/clicker/index.html` + `app.js`, a click counter that remembers its count.", None, None),
]

SQL_STEPS = [
    ("Creating a table.", "sql", {"query": "CREATE TABLE IF NOT EXISTS sales (region TEXT, amount REAL)"}),
    (None, "sql", {"query": "INSERT INTO sales VALUES (?, ?), (?, ?), (?, ?)", "params": ["eu", 10, "us", 25.5, "eu", 4.5]}),
    ("Totals by region:", "sql", {"query": "SELECT region, SUM(amount) AS total, COUNT(*) AS n FROM sales GROUP BY region ORDER BY total DESC"}),
    ("eu: 14.5 over 2 sales, us: 25.5 over 1.", None, None),
]
COUNT_STEPS = [
    ("Checking the database.", "sql", {"query": "SELECT COUNT(*) AS n, SUM(amount) AS total FROM sales"}),
    ("The sales table is still there.", None, None),
]
PY_SRC = """import csv, io, statistics
async def main(fs, input):
    rows = list(csv.DictReader(io.StringIO(await fs.read("data.csv"))))
    temps = [float(r["temp"]) for r in rows]
    report = f"days={len(temps)} mean={statistics.mean(temps):.2f} max={max(temps)}\\n"
    await fs.write("report.txt", report)
    print("wrote report.txt")
    return {"mean": round(statistics.mean(temps), 2), "files": await fs.listdir(".")}
"""
PY_STEPS = [
    ("Saving the data.", "write", {"path": "data.csv", "content": "day,temp\nmon,21.5\ntue,23\nwed,19.5\n"}),
    ("Crunching it in Python.", "run_python", {"source": PY_SRC}),
    (None, "bash", {"command": "cat report.txt"}),
    ("Mean temperature is 21.33.", None, None),
]
if len(sys.argv) > 2 and sys.argv[2] == "python":
    STEPS = PY_STEPS
if len(sys.argv) > 2 and sys.argv[2] == "sql":
    STEPS = SQL_STEPS
if len(sys.argv) > 2 and sys.argv[2] == "sqlcount":
    STEPS = COUNT_STEPS


def chunk(delta, finish=None):
    return {"id": "mock", "object": "chat.completion.chunk", "created": int(time.time()), "model": "mock-1",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        msgs = body.get("messages", [])
        step = min(sum(1 for m in msgs if m.get("role") == "tool"), len(STEPS) - 1)
        text, tool, args = STEPS[step]
        print(f"mock-llm: step {step} ({tool or 'final'}), {len(msgs)} messages, tools offered: "
              f"{[t['function']['name'] for t in body.get('tools', [])]}, AGENTS.md in context: "
              f"{'Environment: pi inside a Cloudflare Durable Object' in json.dumps(msgs)}", file=sys.stderr, flush=True)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def send(obj):
            self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
            self.wfile.flush()

        send(chunk({"role": "assistant"}))
        if text:
            for word in text.split(" "):
                send(chunk({"content": word + " "}))
                time.sleep(0.02)
        if tool:
            send(chunk({"tool_calls": [{"index": 0, "id": f"call_{step}", "type": "function",
                                        "function": {"name": tool, "arguments": json.dumps(args)}}]}))
            send(chunk({}, "tool_calls"))
        else:
            send(chunk({}, "stop"))
        send({**chunk({}), "choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}})
        self.wfile.write(b"data: [DONE]\n\n")


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 9999), H).serve_forever()
