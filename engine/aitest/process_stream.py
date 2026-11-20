"""Bounded stdout/stderr tails plus structured progress forwarding for pytest."""
from __future__ import annotations
import codecs
import json
import subprocess
import sys
import threading

PREFIX = "AITEST_PROGRESS:"


def run_streaming(cmd, *, cwd, env, timeout=None):
    process = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    tails = {"stdout": "", "stderr": ""}

    def drain(pipe, name):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        pending = ""
        dropping = False
        def feed(text):
            nonlocal pending, dropping
            tails[name] = (tails[name] + text)[-8000:]
            if name != "stderr":
                return
            for part in text.splitlines(keepends=True):
                if not dropping:
                    pending += part
                if len(pending) > 65536:
                    pending, dropping = "", True
                if part.endswith("\n"):
                    if not dropping and pending.startswith(PREFIX):
                        try:
                            event = json.loads(pending[len(PREFIX):])
                            data = event["data"]
                            if event.get("kind") == "case" and data.get("status") in ("passed", "failed", "error", "skipped"):
                                safe = {"kind": "case", "data": {"caseId": str(data["caseId"])[:500], "status": data["status"], "duration": float(data["duration"])}}
                                sys.stderr.write(PREFIX + json.dumps(safe) + "\n")
                                sys.stderr.flush()
                        except (ValueError, KeyError, TypeError):
                            pass
                    pending, dropping = "", False
        try:
            while chunk := pipe.read1(4096):
                feed(decoder.decode(chunk))
            feed(decoder.decode(b"", final=True))
        finally:
            pipe.close()

    threads = [threading.Thread(target=drain, args=(getattr(process, name), name), daemon=True) for name in tails]
    for thread in threads:
        thread.start()
    try:
        code = process.wait(timeout=timeout)
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        raise
    finally:
        for thread in threads:
            thread.join(timeout=3)
    return subprocess.CompletedProcess(cmd, code, tails["stdout"], tails["stderr"])
