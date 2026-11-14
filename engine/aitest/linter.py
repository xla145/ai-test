"""用例规范检查（第 9 节）。

结构类规则用确定性代码跑，不耗模型；语义类规则（如「标题与步骤内容不一致」）
由 Codex 批量检查，这里只输出候选（``SEMANTIC_RULES``）供 agent 处理。
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Iterable

from .importer import numbering_of
from .models import LintIssue, LintLevel, LintStatus, TestCase

# 规则 id -> (级别, 说明)
RULES: dict[str, tuple[str, str]] = {
    "required_fields": (LintLevel.BLOCK.value, "必填字段完整"),
    "steps_expected_mismatch": (LintLevel.BLOCK.value, "步骤与预期数量一致、编号连续"),
    "conditional_expected": (LintLevel.BLOCK_SCRIPT.value, "预期为条件式（若……则……），结果不唯一"),
    "expected_is_action": (LintLevel.WARN.value, "预期写的是操作而非可判定结果"),
    "undeclared_test_data": (LintLevel.WARN.value, "步骤引用的测试数据未在前置条件声明"),
    "title_format": (LintLevel.WARN.value, "标题格式不符合「模块-场景」"),
    "group_not_subdivided": (LintLevel.WARN.value, "分组没有细分（全部同一分组）"),
    "precondition_duplicates_step": (LintLevel.INFO.value, "前置条件含操作，且与第 1 步重复"),
    "p0_ratio": (LintLevel.INFO.value, "P0 占比超过阈值"),
    "category_other": (LintLevel.INFO.value, "类型为「其它」"),
}

# 交给 agent 的语义规则（代码只做粗筛或不处理）
SEMANTIC_RULES: dict[str, tuple[str, str]] = {
    "title_step_mismatch": (LintLevel.WARN.value, "标题与步骤内容不一致"),
    "expected_is_action": (LintLevel.WARN.value, "预期写的是操作而非可判定结果（语义复核）"),
    "conditional_expected": (LintLevel.BLOCK_SCRIPT.value, "条件式预期（语义复核）"),
}

_CONDITIONAL_RE = re.compile(r"(若|如果|假如|倘若|当.{0,20}时).{0,40}(则|须|需|应|就)|否则|或者|和/或")
_ACTION_EXPECTED_RE = re.compile(r"^(记录|可读取|读取|查看|点击|打开|输入|选择|进入|执行|截图|保存)")
_TEST_DATA_RE = re.compile(r"\b[A-Z]{1,6}-?\d{3,}\b")
_ACTION_VERBS = ("点击", "打开", "输入", "选择", "进入", "登录", "切换", "提交", "上传", "删除", "新建", "创建")
_TITLE_RE = re.compile(r"^[^-\s][^-]*-\S.*$")


@dataclass
class LintConfig:
    p0_threshold: float = 0.25
    required: tuple[str, ...] = ("title", "steps", "expected", "priority")
    disabled: set[str] = field(default_factory=set)


@dataclass
class LintReport:
    issues: list[LintIssue]
    total: int
    rule_hits: dict[str, int]
    blocked_case_ids: list[str]
    stats: dict[str, float]

    def to_dict(self) -> dict:
        return {
            "total": self.total,
            "rule_hits": self.rule_hits,
            "blocked_case_ids": self.blocked_case_ids,
            "stats": self.stats,
            "issues": [i.__dict__ for i in self.issues],
        }


def _issue(case: TestCase, rule: str, message: str, suggestion: str = "") -> LintIssue:
    return LintIssue(case_id=case.id, rule=rule, level=RULES[rule][0], message=message, suggestion=suggestion)


def _raw(case: TestCase, key: str):
    return getattr(case, "_raw", {}).get(key)


def check_required(case: TestCase, cfg: LintConfig) -> list[LintIssue]:
    missing = [f for f in cfg.required if not getattr(case, f)]
    if not missing:
        return []
    return [_issue(case, "required_fields", f"缺少必填字段：{', '.join(missing)}", "补全缺失字段后重新导入")]


def check_steps_expected(case: TestCase, cfg: LintConfig) -> list[LintIssue]:
    out = []
    if case.steps and case.expected and len(case.steps) != len(case.expected):
        out.append(_issue(case, "steps_expected_mismatch",
                          f"步骤 {len(case.steps)} 条，预期 {len(case.expected)} 条，无法按序号配对",
                          "按步骤逐条补齐预期，或合并步骤"))
    for key, label in (("steps", "步骤"), ("expected", "预期")):
        nums = numbering_of(_raw(case, key))
        if nums and nums != list(range(1, len(nums) + 1)):
            out.append(_issue(case, "steps_expected_mismatch", f"{label}编号不连续：{nums}", "从 1 开始连续编号"))
    return out


def check_conditional(case: TestCase, cfg: LintConfig) -> list[LintIssue]:
    hits = [e for e in case.expected if _CONDITIONAL_RE.search(e)]
    if not hits:
        return []
    return [_issue(case, "conditional_expected", f"条件式预期：「{hits[0]}」",
                   "在前置条件中固定数据状态，使预期只有一种结果")]


def check_action_expected(case: TestCase, cfg: LintConfig) -> list[LintIssue]:
    hits = [e for e in case.expected if _ACTION_EXPECTED_RE.search(e.strip())]
    if not hits:
        return []
    return [_issue(case, "expected_is_action", f"预期写成了操作：「{hits[0]}」",
                   "改写为可判定的结果，如「页面显示 xxx」「接口返回 xxx」")]


def check_test_data(case: TestCase, cfg: LintConfig) -> list[LintIssue]:
    used = set()
    for s in case.steps:
        used.update(_TEST_DATA_RE.findall(s))
    declared = set()
    for p in case.preconditions:
        declared.update(_TEST_DATA_RE.findall(p))
    undeclared = sorted(used - declared)
    # 显式绑定可能是模型名等非编号标识，规范检查不得将其清空。
    case.data_refs = sorted(set(case.data_refs) | used | declared)
    if not undeclared:
        return []
    return [_issue(case, "undeclared_test_data", f"步骤引用了未声明的测试数据：{', '.join(undeclared)}",
                   f"在前置条件中声明：存在测试数据 {', '.join(undeclared)}")]


def check_title_format(case: TestCase, cfg: LintConfig) -> list[LintIssue]:
    if not case.title or _TITLE_RE.match(case.title):
        return []
    return [_issue(case, "title_format", f"标题「{case.title}」不符合「模块-场景」格式", "改为「模块-场景」，如「标签管理-停用标签」")]


def check_precondition_dup(case: TestCase, cfg: LintConfig) -> list[LintIssue]:
    if not case.preconditions or not case.steps:
        return []
    first = case.steps[0]
    for p in case.preconditions:
        if any(v in p for v in _ACTION_VERBS) and (p in first or first in p or _similar(p, first)):
            return [_issue(case, "precondition_duplicates_step", f"前置条件「{p}」与第 1 步重复",
                           "前置条件只描述状态，操作放到步骤中")]
    return []


def check_category(case: TestCase, cfg: LintConfig) -> list[LintIssue]:
    if case.category == "其它":
        return [_issue(case, "category_other", "用例类型为「其它」", "归入 功能测试 / 安全相关 / 兼容性")]
    return []


def _similar(a: str, b: str) -> bool:
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return False
    return len(sa & sb) / len(sa | sb) >= 0.7


CASE_CHECKS: dict[str, Callable[[TestCase, LintConfig], list[LintIssue]]] = {
    "required_fields": check_required,
    "steps_expected_mismatch": check_steps_expected,
    "conditional_expected": check_conditional,
    "expected_is_action": check_action_expected,
    "undeclared_test_data": check_test_data,
    "title_format": check_title_format,
    "precondition_duplicates_step": check_precondition_dup,
    "category_other": check_category,
}


def lint_cases(cases: Iterable[TestCase], cfg: LintConfig | None = None) -> LintReport:
    cfg = cfg or LintConfig()
    cases = list(cases)
    issues: list[LintIssue] = []
    for case in cases:
        case_issues: list[LintIssue] = []
        for rule, fn in CASE_CHECKS.items():
            if rule not in cfg.disabled:
                case_issues += fn(case, cfg)
        levels = {i.level for i in case_issues}
        if levels & {LintLevel.BLOCK.value, LintLevel.BLOCK_SCRIPT.value}:
            case.lint_status = LintStatus.BLOCKED.value
        elif LintLevel.WARN.value in levels:
            case.lint_status = LintStatus.WARNED.value
        else:
            case.lint_status = LintStatus.PASSED.value
        issues += case_issues

    stats: dict[str, float] = {}
    # 集合级规则
    if cases:
        groups = Counter(
            str(_raw(c, "module_path")) if _raw(c, "module_path") is not None else "|".join(c.module_path)
            for c in cases
        )
        if "group_not_subdivided" not in cfg.disabled and len(cases) > 1 and len(groups) == 1:
            for c in cases:
                issues.append(_issue(c, "group_not_subdivided", f"全部 {len(cases)} 条用例在同一分组",
                                     "按功能模块细分「所属分组」，用「|」分层"))
                if c.lint_status == LintStatus.PASSED.value:
                    c.lint_status = LintStatus.WARNED.value
        p0 = sum(1 for c in cases if c.priority == "P0") / len(cases)
        stats["p0_ratio"] = round(p0, 4)
        if "p0_ratio" not in cfg.disabled and p0 > cfg.p0_threshold:
            for c in cases:
                if c.priority == "P0":
                    issues.append(_issue(c, "p0_ratio",
                                         f"P0 占比 {p0:.1%} 超过阈值 {cfg.p0_threshold:.0%}",
                                         "复核 P0 定级，仅保留核心链路用例"))

    rule_hits = {rule: len({i.case_id for i in issues if i.rule == rule}) for rule in {i.rule for i in issues}}
    blocked = [c.id for c in cases if c.lint_status == LintStatus.BLOCKED.value]
    return LintReport(issues=issues, total=len(cases), rule_hits=rule_hits, blocked_case_ids=blocked, stats=stats)


def can_generate_script(case: TestCase, issues: Iterable[LintIssue]) -> bool:
    """阻断级问题未修复的用例不进入脚本生成。"""
    return not any(
        i.case_id == case.id and not i.resolved and i.level in (LintLevel.BLOCK.value, LintLevel.BLOCK_SCRIPT.value)
        for i in issues
    )


def apply_fix(case: TestCase, field_name: str, value) -> TestCase:
    """把人工确认后的修改建议回写到用例。"""
    if field_name not in TestCase.__dataclass_fields__ or field_name in ("id", "project_id"):
        raise ValueError(f"不允许修改字段 {field_name}")
    setattr(case, field_name, value)
    return case
