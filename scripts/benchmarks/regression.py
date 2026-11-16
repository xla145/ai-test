#!/usr/bin/env python3
"""Run the fixed 40-scenario fixture baseline without a model; emit fail-closed JSON."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


def percentile(values, p):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)] if ordered else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--out", default="reports/benchmark-regression")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 20:
        parser.error("repeats must be 1–20; release gate requires at least 5")
    root = Path(__file__).resolve().parents[2]
    manifest_file = Path(__file__).with_name("regression-samples.json")
    manifest = json.loads(manifest_file.read_text())
    samples = manifest["samples"]
    out = (root / args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(root / ".release/engine-deps"), str(root / "engine"), os.environ.get("PYTHONPATH", "")])}
    rows = []
    for iteration in range(1, args.repeats + 1):
        for group in ("mcp-servers", "desktop", "engine"):
            selected = [s for s in samples if s["file"].startswith(group + "/")]
            if not selected:
                continue
            raw_file = out / f"{iteration}-{group}.{'xml' if group == 'engine' else 'json'}"
            files = sorted({s["file"].split("/", 1)[1] for s in selected})
            if group == "engine":
                command = [sys.executable, "-m", "pytest", *[s["file"].split("/", 1)[1] + "::" + s["name"] for s in selected], "-q", f"--junitxml={raw_file}"]
            else:
                pattern = "(?:" + "|".join(re.escape(s["name"]) for s in selected) + ")$"
                command = ["node", str(root / "node_modules/vitest/vitest.mjs"), "run", *files, "--testNamePattern", pattern, "--reporter=json", "--outputFile=" + str(raw_file), "--maxWorkers=1"]
            started = time.monotonic()
            try:
                completed = subprocess.run(command, cwd=root / group, env=env, capture_output=True, text=True, timeout=180)
                (out / f"{iteration}-{group}.log").write_text(completed.stdout + completed.stderr)
                if group == "engine":
                    cases = ET.parse(raw_file).findall(".//testcase")
                    observed = [{"name": c.attrib["name"], "status": "failed" if c.find("failure") is not None or c.find("error") is not None else "skipped" if c.find("skipped") is not None else "passed", "durationMs": float(c.attrib.get("time", 0)) * 1000} for c in cases]
                else:
                    raw = json.loads(raw_file.read_text())
                    observed = [{"name": t["title"], "status": t["status"], "durationMs": t.get("duration", 0) or 0} for f in raw["testResults"] for t in f["assertionResults"]]
                for sample in selected:
                    matching = [r for r in observed if r["name"] == sample["name"] or r["name"].startswith(sample["name"] + "[")]
                    rows.append({"id": sample["id"], "iteration": iteration, "status": "passed" if completed.returncode == 0 and matching and all(r["status"] == "passed" for r in matching) else "failed", "durationMs": sum(r["durationMs"] for r in matching), "variants": len(matching), "runnerExitCode": completed.returncode})
            except Exception as error:
                # Missing reports, crashes and timeouts are failures, never empty successful runs.
                rows.extend({"id": s["id"], "iteration": iteration, "status": "failed", "durationMs": (time.monotonic() - started) * 1000, "error": type(error).__name__} for s in selected)
            write_report(out, samples, rows, args.repeats, manifest_file, manifest["scope"])
            print(f"iteration {iteration}/{args.repeats}: {group} finished", flush=True)
    report = write_report(out, samples, rows, args.repeats, manifest_file, manifest["scope"])
    return 0 if report["gate"]["passed"] else 1


def write_report(out, samples, rows, repeats, manifest_file, scope):
    by_id = {s["id"]: [r for r in rows if r["id"] == s["id"]] for s in samples}
    passed = sum(r["status"] == "passed" for r in rows)
    flaky = [id for id, rs in by_id.items() if len({r["status"] for r in rs}) > 1]
    complete = len(rows) == len(samples) * repeats
    rate = passed / len(rows) if rows else 0
    report = {"schema_version": 1, "scope": scope, "sampleHash": hashlib.sha256(manifest_file.read_bytes()).hexdigest(), "samples": len(samples), "repeats": repeats, "complete": complete, "total": len(rows), "passed": passed, "passRate": rate, "flakySamples": flaky, "validationDurationMs": {"p50": percentile([r["durationMs"] for r in rows], .5), "p95": percentile([r["durationMs"] for r in rows], .95)}, "model": {"firstGenerationPassRate": None, "assertionIdentityErrorRate": None, "attributionErrorRate": None, "tokens": None, "cost": None, "reason": "No model is invoked by this deterministic fixture benchmark"}, "gate": {"passed": complete and repeats >= 5 and rate >= .98 and not flaky, "minimumRepeats": 5, "minimumPassRate": .98}, "rows": rows}
    (out / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return report


if __name__ == "__main__":
    raise SystemExit(main())
