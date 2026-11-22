#!/usr/bin/env python3
"""Drive one interactive SSH session through a real pty, like a person at a terminal.

Usage: ssh.py <port> <user> <key> <steps.json>
steps.json: [{"send": "text\\r" | null, "until": "regex" | null, "timeout": seconds}, ...]
Each step sends its text, then reads the screen until `until` matches (or for
`timeout` seconds without one). Prints each step's output, escape codes stripped,
after an "@@step N ok|timeout" marker.
"""
import fcntl, json, os, pty, re, select, struct, sys, termios, time

port, user, key, steps = sys.argv[1], sys.argv[2], sys.argv[3], json.load(open(sys.argv[4]))
pid, fd = pty.fork()
if pid == 0:
    os.execvp("ssh", ["ssh", "-tt", "-p", port, "-i", key, "-o", "IdentitiesOnly=yes",
                      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
                      "-o", "LogLevel=ERROR", f"{user}@127.0.0.1"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

ANSI = re.compile(r"\x1b\[[0-9;?<>]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1b[=>()][0-9A-Za-z]?")


def read_until(pattern, seconds):
    out, end = "", time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                out += ANSI.sub("", os.read(fd, 65536).decode("utf8", "replace"))
            except OSError:
                break
            if pattern and re.search(pattern, out):
                return True, out
    return not pattern, out


for i, step in enumerate(steps):
    if step.get("send"):
        os.write(fd, step["send"].encode())
    ok, out = read_until(step.get("until"), step.get("timeout", 10))
    print(f"@@step {i} {'ok' if ok else 'timeout'}\n{out}", flush=True)
