from openpyxl import Workbook

from aitest.importer import export_excel, import_excel, split_numbered, numbering_of
from aitest.linter import can_generate_script, lint_cases
from aitest.router import route_all
from aitest.models import TestCase

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


def test_bracketed_export_keeps_numbers_and_multiline_prose_inside_each_step():
    text = "【1】1. 设置倍率 1。\n说明 2. 不作为独立步骤\n【2】2. 免费为 0，原价为 1。\n【3】3. 预览显示错误 0。确认前不修改表单。"
    assert split_numbered(text) == [
        "设置倍率 1。\n说明 2. 不作为独立步骤",
        "免费为 0，原价为 1。", "预览显示错误 0。确认前不修改表单。",
    ]
    assert numbering_of(text) == [1, 2, 3]
    assert numbering_of("【1】1. 打开\n【3】3. 保存") == [1, 3]
    assert split_numbered("【1】金额 1.5 元\n【2】2. 核对") == ["金额 1.5 元", "核对"]


def test_bracketed_export_preserves_explicit_empty_items_for_linting():
    assert split_numbered("【1】打开\n【2】\n【3】保存") == ["打开", "", "保存"]
    case = TestCase(title="模型-详情", steps=["打开", ""], expected=["可见", ""])
    assert "required_fields" in lint_cases([case]).rule_hits


def test_repeat_cli_import_preserves_manual_changes_and_does_not_merge_other_sources(tmp_path, capsys):
    import json
    from aitest.cli import main
    path = make_excel(tmp_path / "source.xlsx")
    db = str(tmp_path / "db.sqlite")
    def call(*args):
        assert main(["--db", db, *args]) == 0
        return json.loads(capsys.readouterr().out.strip().splitlines()[-1])["data"]
    pid = call("init-project", "--name", "imports", "--workspace", str(tmp_path / "ws"))["id"]
    first = call("import-excel", "--project", pid, "--file", str(path))
    assert first["created"] == 4
    rows = call("list-cases", "--project", pid)
    cid = rows[0]["id"]
    call("update-case", "--case", cid, "--json", json.dumps({"title": "人工-已审核改动", "status": "reviewed"}))
    again = call("import-excel", "--project", pid, "--file", str(path))
    assert again["created"] == 0 and again["reused"] == 4
    assert len(call("list-cases", "--project", pid)) == 4
    assert call("get-case", "--case", cid)["title"] == "人工-已审核改动"
    # A different source containing the same row/title must not overwrite it.
    wb = Workbook(); ws = wb.active; ws.append(HEADERS)
    ws.append(ROWS[0]); ws.append(["其它-新行", "组", "", "", "1. 打开", "1. 正常", "P1", "功能测试"])
    other = tmp_path / "other.xlsx"; wb.save(other)
    assert call("import-excel", "--project", pid, "--file", str(other))["created"] == 2
    assert len(call("list-cases", "--project", pid)) == 6
    assert call("get-case", "--case", cid)["status"] == "reviewed"


def test_strict_template_rejects_before_writing(tmp_path, capsys):
    import json
    from aitest.cli import main
    from openpyxl import Workbook
    headers = ["用例ID", "标题", "所属分组", "维护人", "测试类型", "执行方式", "状态", "前置条件",
               "测试数据", "步骤描述", "预期结果", "用例等级", "用例类型", "接口配置(JSON)",
               "接口流程(JSON)", "清理步骤(JSON)", "性能配置(JSON)"]
    path = tmp_path / "invalid.xlsx"
    wb = Workbook(); ws = wb.active; ws.append(headers)
    ws.append(["", "用户-创建", "用户", "", "ui", "ui", "draft", "未声明类型", "", "1. 打开", "1. 可见", "P1", "功能测试", "", "", "", ""])
    wb.save(path)
    db = str(tmp_path / "db.sqlite")
    assert main(["--db", db, "init-project", "--name", "p", "--workspace", str(tmp_path / "ws")]) == 0
    pid = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["data"]["id"]
    assert main(["--db", db, "import-excel", "--project", pid, "--file", str(path), "--strict-template"]) == 1
    capsys.readouterr()
    assert main(["--db", db, "list-cases", "--project", pid]) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["data"] == []


def test_exported_template_accepts_valid_case(tmp_path, capsys):
    import json
    from aitest.cli import main
    from aitest.importer import export_template
    from openpyxl import load_workbook
    path = export_template(tmp_path / "template.xlsx")
    wb = load_workbook(path)
    assert wb.worksheets[0].auto_filter.ref == "A1:Q1"
    assert wb.sheetnames == ["用例", "填写说明"]
    wb.worksheets[0].append(["", "用户-创建-正常", "用户|创建", "", "api", "api", "draft",
                              "1. [ENV] 测试环境可达\n2. [AUTH] token 已配置", "", "1. 发送请求", "1. HTTP 200",
                              "P1", "功能测试", json.dumps({"method": "GET", "path": "/users", "expected_status": [200]}), "", "", ""])
    wb.save(path)
    db = str(tmp_path / "db.sqlite")
    assert main(["--db", db, "init-project", "--name", "p", "--workspace", str(tmp_path / "ws")]) == 0
    pid = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["data"]["id"]
    assert main(["--db", db, "import-excel", "--project", pid, "--file", str(path), "--strict-template"]) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["data"]["created"] == 1


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


def test_lint_preserves_explicit_non_numeric_data_bindings():
    case = TestCase(title="模型-停用", preconditions=["存在模型 qwen-plus-chat"],
                    steps=["停用模型 qwen-plus-chat", "核对 TAG-1001"],
                    expected=["状态为停用", "标签存在"], data_refs=["qwen-plus-chat", "fixture-models"])
    lint_cases([case])
    assert case.data_refs == ["TAG-1001", "fixture-models", "qwen-plus-chat"]
    lint_cases([case])
    assert case.data_refs == ["TAG-1001", "fixture-models", "qwen-plus-chat"]


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


def test_route_uses_actions_not_incidental_api_keys_or_mobile_labels():
    from aitest.router import route
    assert route(TestCase(title='渠道-Key维护', steps=['打开新增渠道页面', '查看 API Key 输入框'], expected=['仅保留一条'])) == 'ui'
    assert route(TestCase(title='统计-多端消费', steps=['打开统计页面'], expected=['展示移动端、Android、iOS消费'])) == 'ui'
    assert route(TestCase(title='渠道-批量选择', steps=['点击列表中的全选按钮'], expected=['全部选中'])) == 'ui'
    assert route(TestCase(title='渠道-接口查询', steps=['发送 GET /channels 请求'], expected=['状态码200'])) == 'api'
    assert route(TestCase(title='登录-Android端登录', steps=['在手机输入账号'], expected=['成功'])) == 'app'
