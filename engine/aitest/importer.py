"""Excel 用例导入与导出（第 9 节：字段映射）。

列名映射可在项目配置里改（见 ``DEFAULT_COLUMN_MAP``）。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from openpyxl import Workbook, load_workbook

from .models import CATEGORIES, PRIORITIES, TestCase

# Excel 列名 -> TestCase 字段
DEFAULT_COLUMN_MAP: dict[str, str] = {
    "标题": "title",
    "所属分组": "module_path",
    "维护人": "owner",
    "前置条件": "preconditions",
    "步骤描述": "steps",
    "预期结果": "expected",
    "用例等级": "priority",
    "用例类型": "category",
}

# 「1. xxx 2. xxx」「1、xxx」「1）xxx」「(1) xxx」等编号
_NUM_RE = re.compile(r"(?:^|(?<=\s)|(?<=[；;。]))[（(]?(\d{1,2})\s*[.、．)）](?!\d)\s*")


def split_numbered(text: Any) -> list[str]:
    """按「1. 2.」编号拆成数组；没有编号时按换行拆分。"""
    if text is None:
        return []
    s = str(text).strip()
    if not s:
        return []
    matches = list(_NUM_RE.finditer(s))
    if not matches:
        return [line.strip() for line in s.splitlines() if line.strip()]
    items = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(s)
        item = s[m.end():end].strip().rstrip("；;")
        if item:
            items.append(item)
    return items


def numbering_of(text: Any) -> list[int]:
    """提取编号序列，用于检查编号是否连续。"""
    if text is None:
        return []
    return [int(m.group(1)) for m in _NUM_RE.finditer(str(text))]


def normalize_priority(v: Any) -> str:
    s = str(v or "").strip().upper()
    if s in PRIORITIES:
        return s
    m = re.search(r"P?\s*([0-3])", s)
    return f"P{m.group(1)}" if m else ""


def normalize_category(v: Any) -> str:
    s = str(v or "").strip()
    if s in CATEGORIES:
        return s
    if "安全" in s:
        return "安全相关"
    if "兼容" in s:
        return "兼容性"
    if "功能" in s:
        return "功能测试"
    return "其它" if s else ""


def row_to_case(row: dict[str, Any], project_id: str = "", source_row: int | None = None) -> TestCase:
    title = str(row.get("title") or "").strip()
    module_path = [p.strip() for p in str(row.get("module_path") or "").split("|") if p.strip()]
    # 标题按「-」拆出模块前缀，写入 module_path 末级
    if "-" in title:
        prefix = title.split("-", 1)[0].strip()
        if prefix and (not module_path or module_path[-1] != prefix):
            module_path.append(prefix)

    case = TestCase(
        title=title,
        project_id=project_id,
        module_path=module_path,
        owner=str(row.get("owner") or "").strip(),
        preconditions=split_numbered(row.get("preconditions")),
        steps=split_numbered(row.get("steps")),
        expected=split_numbered(row.get("expected")),
        priority=normalize_priority(row.get("priority")),
        category=normalize_category(row.get("category")),
        source_row=source_row,
    )
    # 保留原始编号用于连续性检查（不入库）
    case._raw = {k: row.get(k) for k in ("steps", "expected", "preconditions", "priority", "category", "module_path")}  # type: ignore[attr-defined]
    return case


def import_excel(
    path: str | Path,
    project_id: str = "",
    column_map: dict[str, str] | None = None,
    sheet: str | None = None,
) -> list[TestCase]:
    column_map = column_map or DEFAULT_COLUMN_MAP
    wb = load_workbook(str(path), read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = next(rows, None)
    if header is None:
        return []
    idx = {}
    for i, name in enumerate(header):
        key = column_map.get(str(name).strip()) if name is not None else None
        if key:
            idx[key] = i

    cases = []
    for n, values in enumerate(rows, start=2):
        if values is None or all(v is None or str(v).strip() == "" for v in values):
            continue
        row = {field: values[i] if i < len(values) else None for field, i in idx.items()}
        cases.append(row_to_case(row, project_id=project_id, source_row=n))
    wb.close()
    return cases


def _numbered(items: list[str]) -> str:
    return "\n".join(f"{i}. {s}" for i, s in enumerate(items, start=1))


def export_excel(cases: list[TestCase], path: str | Path, column_map: dict[str, str] | None = None) -> Path:
    """导出为原格式 Excel。"""
    column_map = column_map or DEFAULT_COLUMN_MAP
    wb = Workbook()
    ws = wb.active
    ws.title = "用例"
    headers = list(column_map.keys())
    ws.append(headers)
    for c in cases:
        group = list(c.module_path)
        # 导入时从标题拆出的模块前缀不回写到「所属分组」
        if "-" in c.title and group and group[-1] == c.title.split("-", 1)[0].strip():
            group = group[:-1]
        values = {
            "title": c.title,
            "module_path": "|".join(group),
            "owner": c.owner,
            "preconditions": _numbered(c.preconditions),
            "steps": _numbered(c.steps),
            "expected": _numbered(c.expected),
            "priority": c.priority,
            "category": c.category,
        }
        ws.append([values[column_map[h]] for h in headers])
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out))
    return out
