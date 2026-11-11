"""测试报告（架构文档第 14 节「JUnit XML + Playwright HTML report + 自研汇总页」中的汇总页）。

- 执行历史与单次执行明细（含用例标题、归因、证据、AI 判定复核项）
- 导出单文件 HTML 汇总报告：样式内联、截图以 base64 内嵌，可直接发给别人查看
- 导出 Excel 结果明细
一次报告可以包含多次执行（例如 CI 中的接口 + UI 两次执行）。
"""

from __future__ import annotations

import base64
import html
import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from .store import Store

STATUS_LABEL = {"passed": "通过", "failed": "失败", "error": "错误", "skipped": "跳过"}
FAILURE_LABEL = {"product_bug": "产品缺陷", "script_error": "脚本 / 页面改版", "environment": "环境问题", "unknown": "待归因"}
FRAMEWORK_LABEL = {"pytest": "接口", "playwright": "UI"}
MODE_LABEL = {"regression": "回归", "explore": "探索", "heal": "自愈"}
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
MAX_EMBED_BYTES = 3 * 1024 * 1024  # 单张截图超过 3 MB 不内嵌，只列路径


def _framework(result: dict[str, Any]) -> str:
    # 一期的接口执行记录没有写 framework，按 pytest 处理
    return result.get("framework") or "pytest"


def list_runs(store: Store, project_id: str, limit: int = 50, framework: str | None = None) -> list[dict[str, Any]]:
    rows = store.conn.execute(
        "SELECT * FROM run WHERE project_id=? ORDER BY started_at DESC", (project_id,)
    ).fetchall()
    out = []
    for r in rows:
        result = json.loads(r["result"] or "{}")
        fw = _framework(result)
        if framework and fw != framework:
            continue
        out.append({
            "id": r["id"], "env": r["env"], "mode": r["mode"], "started_at": r["started_at"], "framework": fw,
            "total": result.get("total", 0), "passed": result.get("passed", 0),
            "failed": result.get("failed", 0) + result.get("error", 0), "skipped": result.get("skipped", 0),
            "pass_rate": result.get("pass_rate", 0.0), "html_report": result.get("html_report"), "junit": result.get("junit"),
        })
        if len(out) >= limit:
            break
    return out


def run_detail(store: Store, run_id: str) -> dict[str, Any]:
    r = store.conn.execute("SELECT * FROM run WHERE id=?", (run_id,)).fetchone()
    if not r:
        raise KeyError(f"执行记录不存在：{run_id}")
    result = json.loads(r["result"] or "{}")
    project = store.get_project(r["project_id"])
    attributions = {
        row["case_id"]: dict(row)
        for row in store.conn.execute("SELECT * FROM attribution WHERE run_id=?", (run_id,)).fetchall()
    } if _has_table(store, "attribution") else {}
    reviews_by_case: dict[str, list[dict[str, Any]]] = {}
    for rev in store.list_reviews():
        if rev.run_id == run_id:
            reviews_by_case.setdefault(rev.case_id, []).append(rev.__dict__)
    results = []
    for rr in store.list_run_results(run_id):
        case = store.get_case(rr.case_id)
        attr = attributions.get(rr.case_id, {})
        results.append({
            "case_id": rr.case_id,
            "title": case.title if case else rr.case_id,
            "module": " / ".join(case.module_path) if case else "",
            "priority": case.priority if case else "",
            "status": rr.status,
            "duration": rr.duration,
            "message": rr.message,
            # 人工确认的归因优先
            "failure_type": attr.get("human_type") or rr.failure_type,
            "attribution_confirmed": bool(attr.get("human_type")),
            "attribution_reason": attr.get("reason") or "",
            "evidence_paths": rr.evidence_paths,
            "reviews": reviews_by_case.get(rr.case_id, []),
        })
    order = {"error": 0, "failed": 1, "passed": 2, "skipped": 3}
    results.sort(key=lambda x: (order.get(x["status"], 9), x["priority"] or "P9", x["title"]))
    return {
        "run": {
            "id": run_id, "env": r["env"], "mode": r["mode"], "started_at": r["started_at"],
            "framework": _framework(result), "html_report": result.get("html_report"), "junit": result.get("junit"),
            "base_url": (_effective_envs(store, project).get(r["env"], {}) or {}).get("base_url", "") if project else "",
        },
        "project": {"id": project.id, "name": project.name, "workspace_path": project.workspace_path} if project else None,
        "summary": _summary(results),
        "results": results,
    }


def _effective_envs(store: Store, project: Any) -> dict[str, Any]:
    parent = store.get_project(project.parent_id) if getattr(project, "parent_id", None) else None
    return {**(parent.environments if parent else {}), **project.environments}


def _has_table(store: Store, name: str) -> bool:
    return bool(store.conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


def _summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    c = Counter(r["status"] for r in results)
    total = len(results)
    executed = total - c["skipped"]
    return {
        "total": total, "passed": c["passed"], "failed": c["failed"] + c["error"], "skipped": c["skipped"],
        "pass_rate": round(c["passed"] / executed, 4) if executed else 0.0,
        "duration": round(sum(r["duration"] or 0 for r in results), 2),
        "failure_types": dict(Counter(r["failure_type"] or "unknown" for r in results if r["status"] in ("failed", "error"))),
        "pending_reviews": sum(1 for r in results for v in r["reviews"] if v.get("status") == "pending"),
    }


# --------------------------------------------------------------------------- HTML


def _abs(path: str, workspace: str | None) -> Path:
    p = Path(path)
    return p if p.is_absolute() or not workspace else Path(workspace) / p


def _embed(path: str, workspace: str | None) -> str | None:
    p = _abs(path, workspace)
    mime = IMAGE_TYPES.get(p.suffix.lower())
    if not mime or not p.is_file() or p.stat().st_size > MAX_EMBED_BYTES:
        return None
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"


def _fmt_time(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return iso


_CSS = """
:root{--fg:#1f2329;--muted:#6b7280;--line:#e5e7eb;--bg:#f6f7f9;--card:#fff;--ok:#16a34a;--bad:#dc2626;--warn:#d97706;--brand:#3b6ef5}
@media(prefers-color-scheme:dark){:root{--fg:#e5e7eb;--muted:#9ca3af;--line:#2d3139;--bg:#111317;--card:#1a1d23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:32px 20px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 12px}
.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.card b{display:block;font-size:24px;margin-top:2px}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;background:var(--ok)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;background:rgba(127,127,127,.06)}
.tag{display:inline-block;padding:0 8px;border-radius:4px;font-size:12px;white-space:nowrap}
.passed{background:rgba(22,163,74,.12);color:var(--ok)}.failed,.error{background:rgba(220,38,38,.12);color:var(--bad)}.skipped{background:var(--line);color:var(--muted)}
.ft{background:rgba(127,127,127,.12);color:var(--muted)}.ft-product_bug{background:rgba(220,38,38,.12);color:var(--bad)}
.ft-script_error{background:rgba(217,119,6,.12);color:var(--warn)}.ft-unknown{background:rgba(124,58,237,.12);color:#7c3aed}pre{white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;
background:rgba(127,127,127,.08);border-radius:6px;padding:8px 10px;margin:6px 0 0;max-height:220px;overflow:auto}
.shots{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.shots img{max-width:260px;border:1px solid var(--line);border-radius:6px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}details summary{cursor:pointer;color:var(--brand)}
footer{margin-top:32px;color:var(--muted);font-size:12px}
"""


def render_html(details: list[dict[str, Any]]) -> str:
    """把一次或多次执行渲染为单文件 HTML（所有资源内联）。"""
    if not details:
        raise ValueError("没有可生成报告的执行记录")
    e = html.escape
    project = details[0]["project"] or {"name": "", "workspace_path": ""}
    workspace = project.get("workspace_path")
    all_results = [r for d in details for r in d["results"]]
    s = _summary(all_results)
    rate = s["pass_rate"]
    parts = [
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
        f"<title>{e(project['name'])} 测试报告</title><style>{_CSS}</style></head><body><div class='wrap'>",
        f"<h1>{e(project['name'])} · 测试报告</h1>",
        "<div class='muted'>" + "；".join(
            f"{FRAMEWORK_LABEL.get(d['run']['framework'], d['run']['framework'])}{MODE_LABEL.get(d['run']['mode'], d['run']['mode'])} "
            f"<span class='mono'>{e(d['run']['id'])}</span>，环境 {e(d['run']['env'])}"
            f"{'（' + e(d['run']['base_url']) + '）' if d['run']['base_url'] else ''}，{e(_fmt_time(d['run']['started_at']))}"
            for d in details) + "</div>",
        "<div class='cards'>",
        f"<div class='card'>通过率<b>{rate:.1%}</b><div class='bar'><i style='width:{rate * 100:.1f}%'></i></div></div>",
        f"<div class='card'>用例总数<b>{s['total']}</b></div>",
        f"<div class='card'>通过<b style='color:var(--ok)'>{s['passed']}</b></div>",
        f"<div class='card'>失败<b style='color:{'var(--bad)' if s['failed'] else 'inherit'}'>{s['failed']}</b></div>",
        f"<div class='card'>跳过<b>{s['skipped']}</b></div>",
        f"<div class='card'>耗时<b>{s['duration']:.1f}s</b></div>",
        "</div>",
    ]
    if s["failure_types"]:
        parts.append("<h2>失败归因</h2><div class='cards'>" + "".join(
            f"<div class='card'>{e(FAILURE_LABEL.get(k, k))}<b>{v}</b></div>" for k, v in sorted(s["failure_types"].items())) + "</div>")

    failed = [r for r in all_results if r["status"] in ("failed", "error")]
    if failed:
        parts.append("<h2>失败用例</h2><table><tr><th style='width:34%'>用例</th><th style='width:150px'>归因</th><th>原因与证据</th></tr>")
        for r in failed:
            shots = [src for src in (_embed(p, workspace) for p in r["evidence_paths"]) if src]
            other = [p for p in r["evidence_paths"] if not _embed(p, workspace)]
            ft = r["failure_type"] or "unknown"
            parts.append(
                f"<tr><td>{e(r['title'])}<div class='muted mono'>{e(r['case_id'])} · {e(r['priority'])}</div></td>"
                f"<td><span class='tag ft ft-{e(ft)}'>{e(FAILURE_LABEL.get(ft, ft))}</span>"
                f"{'<div class=muted>已人工确认</div>' if r['attribution_confirmed'] else ''}</td><td>"
                + (f"<div>{e(r['attribution_reason'])}</div>" if r["attribution_reason"] else "")
                + (f"<pre>{e(r['message'][:3000])}</pre>" if r["message"] else "")
                + ("<div class='shots'>" + "".join(f"<img src='{src}' alt='失败截图'>" for src in shots) + "</div>" if shots else "")
                + ("<div class='muted mono'>" + "<br>".join(e(p) for p in other) + "</div>" if other else "")
                + "</td></tr>")
        parts.append("</table>")

    reviews = [(r, v) for r in all_results for v in r["reviews"]]
    if reviews:
        parts.append("<h2>AI 判定（需人工复核，不计入通过）</h2><table><tr><th>用例</th><th>判定内容</th><th>AI 结论</th><th>人工复核</th></tr>")
        review_label = {"pending": "待复核", "confirmed_pass": "通过", "confirmed_fail": "不通过"}
        for r, v in reviews:
            shots = "".join(f"<img src='{src}' alt='截图'>" for src in (_embed(p, workspace) for p in v.get("evidence_paths", [])) if src)
            parts.append(
                f"<tr><td>{e(r['title'])}</td><td>{e(v.get('description', ''))}{'<div class=shots>' + shots + '</div>' if shots else ''}</td>"
                f"<td>{e({'pass': '通过', 'fail': '不通过'}.get(v.get('ai_verdict', ''), '未判定'))}</td>"
                f"<td>{e(review_label.get(v.get('status', ''), v.get('status', '')))}</td></tr>")
        parts.append("</table>")

    parts.append("<h2>全部用例</h2><table><tr><th>用例</th><th>模块</th><th>等级</th><th>结果</th><th style='text-align:right'>耗时</th></tr>")
    for r in all_results:
        parts.append(
            f"<tr><td>{e(r['title'])}<div class='muted mono'>{e(r['case_id'])}</div></td><td>{e(r['module'])}</td>"
            f"<td>{e(r['priority'])}</td><td><span class='tag {e(r['status'])}'>{e(STATUS_LABEL.get(r['status'], r['status']))}</span></td>"
            f"<td style='text-align:right'>{(r['duration'] or 0):.2f}s</td></tr>")
    parts.append("</table>")
    parts.append(f"<footer>由 AI 测试客户端生成 · {e(datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S'))} · "
                 "回归执行不调用模型；失败归因中「待归因」的用例需在客户端中处理</footer></div></body></html>")
    return "".join(parts)


# --------------------------------------------------------------------------- Excel


def render_xlsx(details: list[dict[str, Any]], out: Path) -> Path:
    wb = Workbook()
    head_font = Font(bold=True)
    head_fill = PatternFill("solid", fgColor="EEF2FF")
    fills = {"passed": "DCFCE7", "failed": "FEE2E2", "error": "FEE2E2", "skipped": "F3F4F6"}

    ws = wb.active
    ws.title = "汇总"
    all_results = [r for d in details for r in d["results"]]
    s = _summary(all_results)
    rows = [
        ("项目", (details[0]["project"] or {}).get("name", "")),
        ("执行", "；".join(f"{FRAMEWORK_LABEL.get(d['run']['framework'], '')} {d['run']['id']}（{d['run']['env']}，{_fmt_time(d['run']['started_at'])}）" for d in details)),
        ("用例总数", s["total"]), ("通过", s["passed"]), ("失败", s["failed"]), ("跳过", s["skipped"]),
        ("通过率", s["pass_rate"]), ("耗时（秒）", s["duration"]),
        *[(f"失败归因：{FAILURE_LABEL.get(k, k)}", v) for k, v in sorted(s["failure_types"].items())],
    ]
    for k, v in rows:
        ws.append([k, v])
        ws.cell(ws.max_row, 1).font = head_font
    ws.cell(7, 2).number_format = "0.0%"
    ws.column_dimensions["A"].width = 22
    ws.column_dimensions["B"].width = 80

    ws2 = wb.create_sheet("明细")
    headers = ["类型", "执行 ID", "用例 ID", "标题", "模块", "等级", "结果", "耗时（秒）", "归因", "归因已确认", "原因", "错误信息", "证据"]
    ws2.append(headers)
    for c in ws2[1]:
        c.font, c.fill = head_font, head_fill
    for d in details:
        for r in d["results"]:
            ft = r["failure_type"] if r["status"] in ("failed", "error") else ""
            ws2.append([
                FRAMEWORK_LABEL.get(d["run"]["framework"], d["run"]["framework"]), d["run"]["id"], r["case_id"], r["title"],
                r["module"], r["priority"], STATUS_LABEL.get(r["status"], r["status"]), round(r["duration"] or 0, 3),
                FAILURE_LABEL.get(ft or "", ft or ""), "是" if r["attribution_confirmed"] else "", r["attribution_reason"],
                (r["message"] or "")[:2000], "\n".join(r["evidence_paths"]),
            ])
            ws2.cell(ws2.max_row, 7).fill = PatternFill("solid", fgColor=fills.get(r["status"], "FFFFFF"))
    for col, width in zip("ABCDEFGHIJKLM", (8, 16, 18, 36, 20, 6, 8, 10, 14, 10, 30, 60, 40)):
        ws2.column_dimensions[col].width = width
    for row in ws2.iter_rows(min_row=2):
        for c in row:
            c.alignment = Alignment(vertical="top", wrap_text=c.column in (4, 11, 12, 13))
    ws2.freeze_panes = "A2"
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out))
    return out


def export_report(store: Store, run_ids: list[str], fmt: str = "html", out: str | Path | None = None) -> dict[str, Any]:
    details = [run_detail(store, rid) for rid in run_ids]
    if fmt not in ("html", "xlsx"):
        raise ValueError("格式只支持 html / xlsx")
    if out is None:
        ws = (details[0]["project"] or {}).get("workspace_path") or "."
        name = run_ids[0] if len(run_ids) == 1 else f"{run_ids[0]}-{len(run_ids)}runs"
        out = Path(ws) / "reports" / f"report-{name}.{fmt}"
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "html":
        out.write_text(render_html(details), encoding="utf-8")
    else:
        render_xlsx(details, out)
    s = _summary([r for d in details for r in d["results"]])
    return {"path": str(out), "format": fmt, "runs": run_ids, **s}
