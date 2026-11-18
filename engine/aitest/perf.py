"""性能测试：场景编译、基线管理与结果对比（二期 + 三期）。

场景编译从 api / api_flow 用例中提取请求配置，输出结构化 JSON 供 TypeScript 层生成 k6 脚本。
不涉及模型调用，不执行请求——只做数据转换与存储。
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .store import Store


def _spec_to_step(spec: Any, fallback_name: str = "") -> dict[str, Any]:
    """把一个 ApiSpec（dataclass 或 dict）转换为性能场景步骤。"""
    d = asdict(spec) if hasattr(spec, "__dataclass_fields__") else dict(spec)
    step: dict[str, Any] = {
        "name": d.get("name") or fallback_name or f"{d.get('method', 'GET')} {d.get('path', '/')}",
        "method": (d.get("method") or "GET").upper(),
        "path": d.get("path") or "/",
    }
    if d.get("body") is not None:
        step["body"] = d["body"]
    if d.get("headers"):
        step["headers"] = d["headers"]
    if d.get("extract"):
        step["extract"] = d["extract"]
    if d.get("role"):
        step["role"] = d["role"]
    return step


def compile_case(store: Store, case_id: str) -> dict[str, Any]:
    """把一条接口用例编译为性能场景 JSON。

    返回 ``{"case_id", "title", "steps": [...]}``，每步包含
    name / method / path / body / headers / extract / role。
    """
    case = store.get_case(case_id)
    if case is None:
        raise KeyError(f"用例不存在：{case_id}")

    steps: list[dict[str, Any]] = []

    if case.api_flow:
        for i, spec in enumerate(case.api_flow, 1):
            step = _spec_to_step(spec, f"第 {i} 步")
            step["name"] = f"{i}-{step['name']}"
            steps.append(step)
    elif case.api is not None:
        steps.append(_spec_to_step(case.api, case.title))
    else:
        raise ValueError(f"用例 {case_id}（{case.title}）没有可执行的接口配置")

    return {"case_id": case_id, "title": case.title, "steps": steps}


# --------------------------------------------------------------------------- 基线


def _ensure_baseline_table(store: Store) -> None:
    store.conn.execute("""CREATE TABLE IF NOT EXISTS perf_baseline (
        project_id TEXT NOT NULL,
        target_key TEXT NOT NULL,
        result_id  TEXT NOT NULL,
        set_at     TEXT NOT NULL,
        PRIMARY KEY (project_id, target_key)
    )""")


def save_baseline(store: Store, project_id: str, target_key: str, result_id: str) -> dict[str, Any]:
    """保存或替换一个性能基线。target_key 通常为 ``method:path`` 或 ``scenario:case_id``。"""
    _ensure_baseline_table(store)
    now = datetime.now(timezone.utc).isoformat()
    store.conn.execute(
        "INSERT OR REPLACE INTO perf_baseline VALUES (?,?,?,?)",
        (project_id, target_key, result_id, now),
    )
    store.conn.commit()
    return {"project_id": project_id, "target_key": target_key, "result_id": result_id, "set_at": now}


def get_baseline(store: Store, project_id: str, target_key: str) -> dict[str, Any] | None:
    """获取某个目标的性能基线记录。"""
    _ensure_baseline_table(store)
    row = store.conn.execute(
        "SELECT * FROM perf_baseline WHERE project_id=? AND target_key=?",
        (project_id, target_key),
    ).fetchone()
    return dict(row) if row else None


# --------------------------------------------------------------------------- 对比


def compare_results(current: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    """对比两次性能结果，检测退化。

    默认门槛：
    - P95 退化 > 20%
    - RPS 下降 > 20%
    - 失败率 > 基线 2 倍（基线为 0 时阈值取 0.01）
    """
    details: list[str] = []

    cur_p95 = current.get("p95Ms")
    base_p95 = baseline.get("p95Ms")
    if cur_p95 is not None and base_p95 is not None and base_p95 > 0:
        pct = (cur_p95 - base_p95) / base_p95
        if pct > 0.2:
            details.append(f"P95 退化 {pct:.0%}（基线 {base_p95:.1f}ms → 当前 {cur_p95:.1f}ms）")

    cur_rps = current.get("requestsPerSecond")
    base_rps = baseline.get("requestsPerSecond")
    if cur_rps is not None and base_rps is not None and base_rps > 0:
        drop = (base_rps - cur_rps) / base_rps
        if drop > 0.2:
            details.append(f"RPS 下降 {drop:.0%}（基线 {base_rps:.1f} → 当前 {cur_rps:.1f}）")

    cur_fail = current.get("failureRate")
    base_fail = baseline.get("failureRate")
    if cur_fail is not None and base_fail is not None:
        threshold = max(base_fail * 2, 0.01)
        if cur_fail > threshold:
            details.append(
                f"失败率上升（基线 {base_fail:.2%} → 当前 {cur_fail:.2%}，"
                f"门槛 {threshold:.2%}）"
            )

    return {
        "degraded": bool(details),
        "details": details,
        "baseline": {
            "p95Ms": base_p95,
            "rps": base_rps,
            "failureRate": base_fail,
        },
        "current": {
            "p95Ms": cur_p95,
            "rps": cur_rps,
            "failureRate": cur_fail,
        },
    }


# --------------------------------------------------------------------------- 趋势

_PERF_FILE = re.compile(r"^perf-[\w-]+\.json$")


def trend_data(workspace: str, target_path: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """读取 workspace 下历史性能结果，按时间正序返回摘要列表。"""
    perf_dir = Path(workspace) / "reports" / "performance"
    if not perf_dir.is_dir():
        return []

    items: list[dict[str, Any]] = []
    for f in perf_dir.iterdir():
        if not _PERF_FILE.match(f.name):
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not data.get("id") or not data.get("options"):
            continue
        opts = data["options"]
        # 按目标路径筛选
        if target_path is not None and opts.get("path") != target_path:
            continue
        items.append({
            "id": data["id"],
            "startedAt": data.get("startedAt", ""),
            "status": data.get("status", ""),
            "p95Ms": data.get("p95Ms"),
            "requestsPerSecond": data.get("requestsPerSecond"),
            "failureRate": data.get("failureRate"),
            "method": opts.get("method", "GET"),
            "path": opts.get("path", "/"),
        })

    items.sort(key=lambda x: x["startedAt"])
    return items[-limit:]
