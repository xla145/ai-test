"""Excel 用例导入与导出（第 9 节：字段映射）。

列名映射可在项目配置里改（见 ``DEFAULT_COLUMN_MAP``）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from openpyxl import Workbook, load_workbook

from .models import CATEGORIES, PRIORITIES, ApiSpec, TestCase, new_id

# Excel 列名 -> TestCase 字段
DEFAULT_COLUMN_MAP: dict[str, str] = {
    "用例ID": "id",
    "标题": "title",
    "所属分组": "module_path",
    "维护人": "owner",
    "测试类型": "type",
    "执行方式": "execution_mode",
    "状态": "status",
    "前置条件": "preconditions",
    "测试数据": "data_refs",
    "步骤描述": "steps",
    "预期结果": "expected",
    "用例等级": "priority",
    "用例类型": "category",
    "接口配置(JSON)": "api",
    "接口流程(JSON)": "api_flow",
    "清理步骤(JSON)": "api_cleanup",
    "性能配置(JSON)": "performance",
}

TEMPLATE_COLUMN_MAP: dict[str, str] = {
    "标题": "title", "测试目标": "type", "所属分组": "module_path", "用例等级": "priority",
    "前置条件": "preconditions", "步骤描述": "steps", "预期结果": "expected",
    "数据引用": "data_refs", "维护人": "owner",
}
TARGET_VALUES = {"接口": "api", "界面": "ui", "性能": "performance", "移动端": "app"}

# 常见的列名写法（各测试平台导出格式不同）；列名先去掉「*」「(必填)」等标记再匹配
COLUMN_ALIASES: dict[str, str] = {
    "测试目标": "type",
    "id": "id", "用例编号": "id", "case id": "id",
    "用例标题": "title", "用例名称": "title", "名称": "title", "用例名": "title", "测试标题": "title", "case title": "title", "title": "title",
    "所属模块": "module_path", "模块": "module_path", "功能模块": "module_path", "模块路径": "module_path", "分组": "module_path", "目录": "module_path",
    "负责人": "owner", "创建人": "owner", "编写人": "owner",
    "测试方式": "execution_mode", "执行模式": "execution_mode",
    "测试分类": "type", "用例状态": "status",
    "数据引用": "data_refs", "测试数据引用": "data_refs",
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
# Platform exports use an explicit outer marker, e.g. 【1】1. Click.
# Prefer that boundary over numbers in the prose (prices, limits, examples).
_BRACKET_RE = re.compile(r"(?:^|\n)[ \t]*【(\d+)】[ \t]*")


def split_numbered(text: Any) -> list[str]:
    """按「1. 2.」编号拆成数组；没有编号时按换行拆分。"""
    if text is None:
        return []
    s = str(text).strip()
    if not s:
        return []
    bracketed = list(_BRACKET_RE.finditer(s))
    if bracketed and not s[:bracketed[0].start()].strip():
        items = []
        for i, m in enumerate(bracketed):
            end = bracketed[i + 1].start() if i + 1 < len(bracketed) else len(s)
            item = s[m.end():end].strip()
            # Remove only the redundant number matching the outer marker.
            item = re.sub(r"^" + re.escape(m.group(1)) + r"\s*[.、．)）](?!\d)\s*", "", item)
            # Keep an explicit empty numbered item so lint can report malformed
            # source rows instead of silently changing step/expected alignment.
            items.append(item.rstrip("；;"))
        return items
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
    s = str(text).strip()
    bracketed = list(_BRACKET_RE.finditer(s))
    if bracketed and not s[:bracketed[0].start()].strip():
        return [int(m.group(1)) for m in bracketed]
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

    def split_values(value: Any) -> list[str]:
        return [p.strip() for p in re.split(r"[|,，\n]", str(value or "")) if p.strip()]

    case = TestCase(
        id=str(row.get("id") or "").strip() or new_id("tc"),
        title=title,
        project_id=project_id,
        type=TARGET_VALUES.get(str(row.get("type") or "").strip(), str(row.get("type") or "ui").strip().lower()),
        execution_mode=str(row.get("execution_mode") or "").strip().lower(),
        status=str(row.get("status") or "draft").strip().lower(),
        module_path=module_path,
        owner=str(row.get("owner") or "").strip(),
        preconditions=split_numbered(row.get("preconditions")),
        data_refs=split_values(row.get("data_refs")),
        steps=split_numbered(row.get("steps")),
        expected=split_numbered(row.get("expected")),
        priority=normalize_priority(row.get("priority")),
        category=normalize_category(row.get("category")),
        source_row=source_row,
    )
    if not case.execution_mode:
        case.execution_mode = "ui"
    for field, expected_type in (("api", dict), ("api_flow", list), ("api_cleanup", list), ("performance", dict)):
        raw = row.get(field)
        if raw is None or str(raw).strip() == "":
            continue
        try:
            value = json.loads(raw) if isinstance(raw, str) else raw
        except (ValueError, TypeError) as exc:
            raise ValueError(f"第 {source_row} 行「{field}」不是有效 JSON") from exc
        if not isinstance(value, expected_type):
            raise ValueError(f"第 {source_row} 行「{field}」JSON 类型错误")
        if field == "api":
            items = [value]
        elif field in ("api_flow", "api_cleanup"):
            items = value
        else:
            case.performance = value
            continue
        if any(not isinstance(item, dict) or not isinstance(item.get("method"), str)
               or not isinstance(item.get("path"), str) or not item["path"].startswith("/")
               or not isinstance(item.get("expected_status"), list) or not item["expected_status"]
               for item in items):
            raise ValueError(f"第 {source_row} 行「{field}」每个请求都须包含 method、以 / 开头的 path 和 expected_status 数组")
        try:
            specs = [ApiSpec(**item) for item in items]
        except TypeError as exc:
            raise ValueError(f"第 {source_row} 行「{field}」包含不支持的接口字段：{exc}") from exc
        if field == "api":
            case.api = specs[0]
        else:
            setattr(case, field, specs)
    # 保留原始编号用于连续性检查（不入库）
    case._raw = dict(row)  # type: ignore[attr-defined]
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
            "id": c.id,
            "title": c.title,
            "type": c.type,
            "execution_mode": c.execution_mode,
            "status": c.status,
            "module_path": "|".join(group),
            "owner": c.owner,
            "preconditions": _numbered(c.preconditions),
            "data_refs": "|".join(c.data_refs),
            "steps": _numbered(c.steps),
            "expected": _numbered(c.expected),
            "priority": c.priority,
            "category": c.category,
            "api": json.dumps(vars(c.api), ensure_ascii=False) if c.api else "",
            "api_flow": json.dumps([vars(s) for s in c.api_flow], ensure_ascii=False) if c.api_flow else "",
            "api_cleanup": json.dumps([vars(s) for s in c.api_cleanup], ensure_ascii=False) if c.api_cleanup else "",
            "performance": json.dumps(c.performance, ensure_ascii=False) if c.performance else "",
        }
        ws.append([values[column_map[h]] for h in headers])
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out))
    return out


def export_template(path: str | Path) -> Path:
    """可填写的通用用例模板；第一张表是唯一导入数据源。"""
    out = export_excel([], path, column_map=TEMPLATE_COLUMN_MAP)
    wb = load_workbook(out)
    ws = wb.worksheets[0]
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    from openpyxl.styles import Font, PatternFill, Alignment
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="174A63")
        cell.alignment = Alignment(wrap_text=True)
        ws.column_dimensions[cell.column_letter].width = 24 if cell.value not in ("步骤描述", "预期结果", "前置条件") else 42
    help_sheet = wb.create_sheet("填写说明")
    for line in [
        ["字段", "填写规则"],
        ["标题", "必填，例如：订单-退款-已支付订单可申请退款。导入后自动生成 ID，状态为草稿。"],
        ["测试目标", "接口 / UI / 性能 / 移动端"],
        ["用例等级", "P0 阻断 / P1 核心 / P2 一般 / P3 低优"],
        ["所属分组", "用 | 分隔层级，例如 用户管理|创建用户"],
        ["前置条件", "每行一条，格式：[ENV] 描述、[AUTH] 描述、[DATA] 描述、[RUNTIME] 描述、[STATE] 描述；至少一条 ENV"],
        ["步骤描述 / 预期结果", "每行一条，一一对应；可用 1.、2. 编号"],
        ["数据引用", "选填；只填需要环境提供的数据标识，如 member_account，多个用 | 分隔。临时输入的格式、数据准备说明写在前置条件，引用留空。"],
        ["维护人", "选填"],
        ["执行配置", "本模板不填写接口 JSON、UI 脚本或性能参数；待接口文档、页面配置或压测目标明确后，在对应配置页面补齐"],
        ["参考", "通用字段见 docs/test-templates/00-common-meta.md；API/UI/性能配置分别见 01、02、03 模板"],
    ]:
        help_sheet.append(line)
    help_sheet.column_dimensions["A"].width = 26
    help_sheet.column_dimensions["B"].width = 110
    help_sheet.freeze_panes = "A2"
    wb.save(out)
    return out
