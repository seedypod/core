#!/usr/bin/env python3
"""Runs a command on a real pseudo-terminal, which the login logo's tests need
and Node can't give them. Takes a JSON spec as argv[1], prints JSON.

Spec: argv, env, rows, cols, keys ([seconds, text] typed after a delay),
replies ([needle, text] answered when the program prints needle), signals
([seconds, signal number] sent to the program's process group).
Result: output (base64), status, ms from start to exit, first and last output.
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", spec.get("rows", 24), spec.get("cols", 80), 0, 0))
    os.execvpe(spec["argv"][0], spec["argv"], spec["env"])

start = time.monotonic()
keys = list(spec.get("keys", []))
replies = list(spec.get("replies", []))
signals = list(spec.get("signals", []))
output = b""
first = last = None
while time.monotonic() - start < spec.get("timeout", 10):
    if select.select([fd], [], [], 0.005)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        now = time.monotonic() - start
        first = now if first is None else first
        last = now
        output += chunk
    elapsed = time.monotonic() - start
    while keys and keys[0][0] <= elapsed:
        os.write(fd, keys.pop(0)[1].encode())
    while signals and signals[0][0] <= elapsed:
        os.killpg(pid, signals.pop(0)[1])
    for reply in list(replies):
        if reply[0].encode() in output:
            os.write(fd, reply[1].encode())
            replies.remove(reply)

elapsed = time.monotonic() - start
try:
    os.kill(pid, signal.SIGKILL) if elapsed >= spec.get("timeout", 10) else None
    status = os.waitpid(pid, 0)[1]
except OSError:
    status = -1
print(json.dumps({
    "output": base64.b64encode(output).decode(),
    "status": os.waitstatus_to_exitcode(status) if status >= 0 else status,
    "ms": round(elapsed * 1000),
    "first": first,
    "last": last,
}))
