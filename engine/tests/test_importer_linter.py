from openpyxl import Workbook

from aitest.importer import export_excel, import_excel, split_numbered
from aitest.linter import can_generate_script, lint_cases
from aitest.router import route_all

HEADERS = ["标题", "所属分组", "维护人", "前置条件", "步骤描述", "预期结果", "用例等级", "用例类型"]
ROWS = [
    # 规范用例
    ["标签管理-停用标签", "特征中心|标签", "张三", "1. 存在启用中的标签 TAG-1001",
     "1. 进入标签管理页\n2. 停用标签 TAG-1001", "1. 页面展示标签列表\n2. 标签状态显示为已停用", "P1", "功能测试"],
    # 条件式预期 + 步骤预期数量不一致 + 未声明测试数据
    ["用户特征-数值核对", "特征中心|用户", "李四", "",
     "1. 打开用户 U1003 详情\n2. 对比特征值", "1. 若数值相同须记录说明", "P0", "功能测试"],
    # 标题格式、预期写成操作、类型其它、前置条件与第 1 步重复
    ["埋点上报检查", "特征中心|埋点", "王五", "1. 打开综合总览页面",
     "1. 打开综合总览页面\n2. 查看 pageview 上报", "1. 页面打开\n2. 记录上报内容", "P0", "其它"],
    # 缺少必填字段
    ["推荐配置-接口越权", "特征中心|推荐", "", "", "1. 用普通角色调用推荐配置接口", "", "P2", "安全相关"],
]


def make_excel(path):
    wb = Workbook()
    ws = wb.active
    ws.append(HEADERS)
    for r in ROWS:
        ws.append(r)
    wb.save(path)
    return path


def test_split_numbered():
    assert split_numbered("1. 打开页面\n2. 点击按钮") == ["打开页面", "点击按钮"]
    assert split_numbered("1、打开页面；2、点击按钮") == ["打开页面", "点击按钮"]
    assert split_numbered("（1）甲 （2）乙") == ["甲", "乙"]
    assert split_numbered("等待 1.5 秒") == ["等待 1.5 秒"]
    assert split_numbered(None) == []


def test_import_mapping(tmp_path):
    cases = import_excel(make_excel(tmp_path / "cases.xlsx"), project_id="p1")
    assert len(cases) == 4
    c = cases[0]
    assert c.title == "标签管理-停用标签"
    assert c.module_path == ["特征中心", "标签", "标签管理"]
    assert c.steps == ["进入标签管理页", "停用标签 TAG-1001"]
    assert c.expected == ["页面展示标签列表", "标签状态显示为已停用"]
    assert c.priority == "P1" and c.owner == "张三" and c.source_row == 2


def test_lint_rules(tmp_path):
    cases = import_excel(make_excel(tmp_path / "cases.xlsx"))
    report = lint_cases(cases)
    by_case = {}
    for i in report.issues:
        by_case.setdefault(i.case_id, set()).add(i.rule)
    good, cond, track, missing = cases
    assert good.lint_status == "passed"
    assert {"conditional_expected", "steps_expected_mismatch", "undeclared_test_data"} <= by_case[cond.id]
    assert cond.data_refs == ["U1003"]
    assert {"title_format", "expected_is_action", "category_other", "precondition_duplicates_step"} <= by_case[track.id]
    assert "required_fields" in by_case[missing.id]
    # P0 占比 50% 超过 25%
    assert report.stats["p0_ratio"] == 0.5
    assert report.rule_hits["p0_ratio"] == 2
    assert set(report.blocked_case_ids) == {cond.id, missing.id}
    assert can_generate_script(good, report.issues)
    assert not can_generate_script(cond, report.issues)


def test_group_not_subdivided(tmp_path):
    cases = import_excel(make_excel(tmp_path / "c.xlsx"))
    for c in cases:
        c._raw["module_path"] = "特征中心"
    report = lint_cases(cases)
    assert report.rule_hits["group_not_subdivided"] == 4


def test_route_execution_mode(tmp_path):
    cases = import_excel(make_excel(tmp_path / "c.xlsx"))
    route_all(cases)
    assert [c.execution_mode for c in cases] == ["ui", "ui", "capture", "api"]


def test_export_roundtrip(tmp_path):
    cases = import_excel(make_excel(tmp_path / "c.xlsx"))
    out = export_excel(cases, tmp_path / "out.xlsx")
    again = import_excel(out)
    assert [c.title for c in again] == [c.title for c in cases]
    assert [c.module_path for c in again] == [c.module_path for c in cases]
    assert [c.steps for c in again] == [c.steps for c in cases]


def test_import_recognizes_common_header_variants(tmp_path):
    """各平台导出的列名：带必填星号、「用例名称」「优先级」「操作步骤」等也能识别，缺少的必需列会提示。"""
    wb = Workbook()
    ws = wb.active
    ws.append(["*用例名称", "所属模块", "前置条件", "操作步骤", "期望结果", "优先级（必填）", "备注"])
    ws.append(["特征中心-新建特征", "web|web--后台管理", "", "1. 打开页面 2. 点新建", "1. 创建成功", "P1", "x"])
    path = tmp_path / "variants.xlsx"
    wb.save(path)

    info: dict = {}
    cases = import_excel(path, info=info)
    c = cases[0]
    assert c.title == "特征中心-新建特征"
    assert c.module_path == ["web", "web--后台管理", "特征中心"]
    assert c.steps == ["打开页面", "点新建"] and c.expected == ["创建成功"] and c.priority == "P1"
    assert info["missing_columns"] == [] and info["unknown_columns"] == ["备注"]
    assert info["columns"]["title"] == "*用例名称"

    wb = Workbook()
    wb.active.append(["所属分组", "步骤描述", "预期结果", "用例等级"])
    wb.active.append(["a|b", "1. x", "1. y", "P1"])
    wb.save(path)
    info = {}
    import_excel(path, info=info)
    assert info["missing_columns"] == ["标题"]
