#!/usr/bin/env python3
"""Audit the real workbook through AIProbe; never invoke remote business writes.

Outputs are evidence, not a successful business-test report. Source content is
retained verbatim alongside normalized cases. Live execution requires a separate
authenticated runner and human-reviewed contracts.
"""
import argparse
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
from openpyxl import load_workbook
from aitest import importer, linter, router


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, type=Path)
    ap.add_argument("--plan", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256(a.source.read_bytes()).hexdigest()
    workbook = load_workbook(a.source, read_only=True, data_only=True)
    sheet = workbook["Data"]
    rows = list(sheet.values)
    workbook.close()
    headers = rows[0]
    raw = [{"source_row": n, "cells": dict(zip(headers, row))}
           for n, row in enumerate(rows[1:], 2) if any(row)]
    info = {}
    cases = importer.import_excel(a.source, project_id="wq2-validation", sheet="Data", info=info)
    # These IDs are local to this immutable source snapshot, not a claim that
    # the product's import command already implements source reconciliation.
    for case in cases:
        case.id = f"wq2_{source_hash[:12]}_r{case.source_row:04d}"
    router.route_all(cases)
    lint = linter.lint_cases(cases)
    case_by_row = {c.source_row: c for c in cases}
    raw_by_row = {r["source_row"]: r["cells"] for r in raw}
    manifest = []
    for group, n, title, priority in re.findall(
            r"^\| ([ABCD]) \| (\d+) \| (.*?) \| (P\d) \|", a.plan.read_text(), re.M):
        n = int(n)
        case = case_by_row[n]
        assert case.title == title and case.priority == priority
        text = "\n".join(str(v or "") for v in raw_by_row[n].values())
        issues = []
        if "阻塞" in text:
            issues.append("源文标记阻塞，需现场复核")
        if "sk-xxx" in text:
            issues.append("占位凭据需要受控测试 Key")
        if n in (15, 30, 37, 38, 46, 104, 177, 200):
            issues.append("需要人工确认具体业务断言/拆分")
        manifest.append({"sample_group": group, "source_row": n, "case_id": case.id,
                         "title": title, "priority": priority, "suggested_mode": case.execution_mode,
                         "execution_status": "not_run", "review_status": "pending",
                         "source_findings": issues, "script": None, "evidence": [],
                         "requirements": [
                             {"id": f"E{i}", "text": text, "assertion": None, "status": "unmapped"}
                             for i, text in enumerate(case.expected, 1)]})
    assert len(manifest) == 40 and len({m["source_row"] for m in manifest}) == 40

    with tempfile.TemporaryDirectory(prefix="wq2-import-probe-") as probe:
        db = str(Path(probe) / "probe.sqlite")
        def cli(*args):
            proc = subprocess.run([sys.executable, "-m", "aitest", "--db", db, *args],
                                  cwd=ROOT / "engine", capture_output=True, text=True, timeout=60)
            data = json.loads(proc.stdout.strip().splitlines()[-1])
            if proc.returncode or not data.get("ok"):
                raise RuntimeError(data.get("error", proc.stderr))
            return data["data"]
        project = cli("init-project", "--name", "WQ2 import acceptance", "--workspace", str(Path(probe) / "ws"))
        first = cli("import-excel", "--project", project["id"], "--file", str(a.source.resolve()), "--sheet", "Data")
        first_count = len(cli("list-cases", "--project", project["id"]))
        second = cli("import-excel", "--project", project["id"], "--file", str(a.source.resolve()), "--sheet", "Data")
        second_count = len(cli("list-cases", "--project", project["id"]))
    count_mismatches = []
    for case in cases:
        for source_column, field in (("步骤描述", "steps"), ("预期结果", "expected")):
            expected_count = len(re.findall(r"(?:^|\n)\s*【\d+】", str(raw_by_row[case.source_row][source_column])))
            if len(getattr(case, field)) != expected_count:
                count_mismatches.append({"row": case.source_row, "field": field,
                                         "source": expected_count, "parsed": len(getattr(case, field))})
    raw_flags = []
    for record in raw:
        text = "\n".join(str(v or "") for v in record["cells"].values())
        raw_flags.append({"source_row": record["source_row"],
                          "source_blocker": "阻塞" in text,
                          "placeholder_credential": "sk-xxx" in text,
                          "known_defect": "#3856" in text})
    result = {"generated_at": datetime.now(timezone.utc).isoformat(), "scope": "offline_import_and_source_audit",
              "source_sha256": source_hash, "source_rows": len(raw), "parsed_cases": len(cases),
              "columns": info, "numbered_item_mismatches": count_mismatches,
              "lint": lint.to_dict(), "mode_counts": dict(Counter(c.execution_mode for c in cases)),
              "source_flags": raw_flags, "trial_samples": len(manifest),
              "repeat_import": {"first_count": first_count, "second_count": second_count,
                                "duplicate_count": second_count - first_count,
                                "passed": second_count == first_count,
                                "first_import": first, "second_import": second},
              "business_execution": {"executed": 0, "passed": None, "status": "not_run"}}
    save(a.out / "source-snapshot.json", {"sha256": source_hash, "sheet": "Data", "rows": raw})
    save(a.out / "normalized-cases.json", [asdict(c) for c in cases])
    save(a.out / "trial-contract-drafts.json", {"samples": manifest})
    save(a.out / "offline-acceptance.json", result)
    lines = ["# 40 条试点执行清单", "", "状态：全部尚未执行业务系统；断言映射待审核。", "",
             "| 分组 | Excel 行 | 来源快照 ID | 用例 | 待处理事项 |",
             "| --- | ---: | --- | --- | --- |"]
    for m in manifest:
        notes = "；".join(m["source_findings"]) or "核实环境、角色和对象并审核断言"
        lines.append(f'| {m["sample_group"]} | {m["source_row"]} | {m["case_id"]} | {m["title"]} | {notes} |')
    (a.out / "试点执行清单.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"source_rows": len(raw), "parsed": len(cases), "count_mismatches": count_mismatches,
                      "repeat_import": result["repeat_import"], "mode_counts": result["mode_counts"],
                      "business_executed": 0}, ensure_ascii=False))
    return 0 if not count_mismatches and second_count == first_count else 1


if __name__ == "__main__":
    raise SystemExit(main())
