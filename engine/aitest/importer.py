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

# 常见的列名写法（各测试平台导出格式不同）；列名先去掉「*」「(必填)」等标记再匹配
COLUMN_ALIASES: dict[str, str] = {
    "用例标题": "title", "用例名称": "title", "名称": "title", "用例名": "title", "测试标题": "title", "case title": "title", "title": "title",
    "所属模块": "module_path", "模块": "module_path", "功能模块": "module_path", "模块路径": "module_path", "分组": "module_path", "目录": "module_path",
    "负责人": "owner", "创建人": "owner", "编写人": "owner",
    "前置": "preconditions", "前提条件": "preconditions", "预置条件": "preconditions",
    "步骤": "steps", "操作步骤": "steps", "测试步骤": "steps", "用例步骤": "steps", "执行步骤": "steps",
    "期望结果": "expected", "预期": "expected", "预期输出": "expected",
    "优先级": "priority", "等级": "priority", "级别": "priority", "重要程度": "priority",
    "类型": "category", "用例分类": "category", "测试类型": "category",
}

# 导入必需的列：缺少时导入结果中提示（否则会整批被规范检查阻断）
REQUIRED_FIELDS = {"title": "标题", "steps": "步骤描述", "expected": "预期结果", "priority": "用例等级"}

_MARK_RE = re.compile(r"[*＊]|[（(]\s*(必填|选填|可选)\s*[)）]|\s+")


def normalize_header(name: Any) -> str:
    return _MARK_RE.sub("", str(name)).strip().lower() if name is not None else ""


def match_columns(header: tuple[Any, ...] | list[Any], column_map: dict[str, str] | None = None) -> tuple[dict[str, int], list[str]]:
    """列名 → 字段的列号；返回 (字段列号, 没有识别的列名)。显式配置的映射优先，其次是常见别名。"""
    explicit = {normalize_header(k): v for k, v in (column_map or DEFAULT_COLUMN_MAP).items()}
    aliases = {normalize_header(k): v for k, v in COLUMN_ALIASES.items()}
    idx: dict[str, int] = {}
    unknown: list[str] = []
    # 第一遍只用显式映射，避免别名抢占（如同时有「标题」和「用例名称」时取「标题」）
    for i, name in enumerate(header):
        key = explicit.get(normalize_header(name))
        if key and key not in idx:
            idx[key] = i
    for i, name in enumerate(header):
        n = normalize_header(name)
        if not n or n in explicit:
            continue
        key = aliases.get(n)
        if key and key not in idx and i not in idx.values():
            idx[key] = i
        elif i not in idx.values():
            unknown.append(str(name).strip())
    return idx, unknown


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
    info: dict[str, Any] | None = None,
) -> list[TestCase]:
    """导入 Excel 用例；传入 info 时写入列识别结果（识别到的列、缺少的必需列、未识别的列）。"""
    wb = load_workbook(str(path), read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = next(rows, None)
    if header is None:
        return []
    idx, unknown = match_columns(header, column_map)
    if info is not None:
        info["columns"] = {field: str(header[i]).strip() for field, i in idx.items()}
        info["missing_columns"] = [label for field, label in REQUIRED_FIELDS.items() if field not in idx]
        info["unknown_columns"] = unknown

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
