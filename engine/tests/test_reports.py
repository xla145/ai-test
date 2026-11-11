import base64
import json
import re

import pytest
from openpyxl import load_workbook

from aitest.cli import main

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


@pytest.fixture
def cli(tmp_path, capsys):
    db = str(tmp_path / "db.sqlite")

    def call(*args, ok=True):
        code = main(["--db", db, *args])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert (code == 0) == ok, out
        return out["data"] if ok else out["error"]

    return call


@pytest.fixture
def setup(cli, tmp_path):
    ws = tmp_path / "ws"
    pid = cli("init-project", "--name", "报告演示", "--workspace", str(ws),
              "--environments", json.dumps({"test": {"base_url": "http://sut.example"}}))["id"]
    mk = lambda t, p: cli("create-case", "--project", pid, "--json", json.dumps(
        {"title": t, "type": "ui", "priority": p, "steps": ["a"], "expected": ["b"], "module_path": ["特征中心", t.split("-")[0]]},
        ensure_ascii=False))["id"]
    ok, bug, flaky = mk("标签管理-停用", "P0"), mk("推荐配置-越权", "P1"), mk("总览-卡片", "P2")
    shot = ws / "reports" / "ui-1" / "fail.png"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(PNG)

    def run(results, framework="playwright", html_report=None):
        f = tmp_path / "r.json"
        f.write_text(json.dumps(results, ensure_ascii=False), encoding="utf-8")
        args = ["save-run", "--project", pid, "--env", "test", "--results-file", str(f), "--framework", framework]
        if html_report:
            args += ["--html-report", html_report]
        return cli(*args)["run_id"]

    api_run = run([{"case_id": ok, "status": "passed", "duration": 0.2}], framework="pytest")
    ui_run = run([
        {"case_id": ok, "status": "passed", "duration": 1.5},
        {"case_id": bug, "status": "failed", "duration": 2.0, "message": "期望 403，实际 200 <script>alert(1)</script>",
         "evidence_paths": ["reports/ui-1/fail.png", "reports/ui-1/trace.zip"]},
        {"case_id": flaky, "status": "skipped"},
        {"case_id": ok + "_v", "status": "passed", "reviews": [{"kind": "visual", "description": "缺失值显示灰色",
                                                                "evidence_paths": [str(shot)], "ai_verdict": "pass"}]},
    ], html_report=str(ws / "reports" / "ui-1" / "html"))
    cli("set-attribution", "--run", ui_run, "--case", bug, "--type", "script_error", "--reason", "agent 认为是改版")
    cli("confirm-attribution", "--run", ui_run, "--case", bug, "--type", "product_bug")
    return {"pid": pid, "api": api_run, "ui": ui_run, "bug": bug, "ok": ok, "ws": ws}


def test_list_runs(cli, setup):
    runs = cli("list-runs", "--project", setup["pid"])
    assert [r["id"] for r in runs] == [setup["ui"], setup["api"]]  # 最新的在前
    ui = runs[0]
    assert ui["framework"] == "playwright" and ui["total"] == 4 and ui["failed"] == 1 and ui["skipped"] == 1
    assert ui["html_report"].endswith("ui-1/html")
    assert [r["id"] for r in cli("list-runs", "--project", setup["pid"], "--framework", "pytest")] == [setup["api"]]
    assert len(cli("list-runs", "--project", setup["pid"], "--limit", "1")) == 1


def test_run_detail(cli, setup):
    d = cli("run-detail", "--run", setup["ui"])
    first = d["results"][0]
    assert first["case_id"] == setup["bug"]  # 失败排在最前
    assert first["title"] == "推荐配置-越权" and first["module"] == "特征中心 / 推荐配置"
    assert first["failure_type"] == "product_bug" and first["attribution_confirmed"]  # 人工结论优先
    assert d["summary"] == {"total": 4, "passed": 2, "failed": 1, "skipped": 1, "pass_rate": 0.6667, "duration": 3.5,
                            "failure_types": {"product_bug": 1}, "pending_reviews": 1}
    assert d["run"]["base_url"] == "http://sut.example"
    unknown = [r for r in d["results"] if r["case_id"].endswith("_v")][0]
    assert unknown["title"] == unknown["case_id"] and unknown["reviews"][0]["description"] == "缺失值显示灰色"
    assert "不存在" in cli("run-detail", "--run", "run_missing", ok=False)


def test_export_html_is_self_contained_and_escaped(cli, setup):
    out = cli("export-report", "--run", setup["api"], "--run", setup["ui"])
    assert out["path"].endswith(".html") and out["total"] == 5 and out["failed"] == 1
    html = open(out["path"], encoding="utf-8").read()
    assert "<script>alert(1)</script>" not in html and "&lt;script&gt;" in html
    assert html.count("data:image/png;base64,") == 2  # 失败截图 + AI 判定截图
    assert "reports/ui-1/trace.zip" in html  # 非图片证据列出路径
    assert not re.search(r"""(src|href)=['"](?!data:)""", html)  # 没有外部资源，单文件可分享
    assert "class='tag ft ft-product_bug'>产品缺陷" in html and "已人工确认" in html and "报告演示" in html and "通过率" in html


def test_export_xlsx(cli, setup, tmp_path):
    out = cli("export-report", "--run", setup["ui"], "--format", "xlsx", "--out", str(tmp_path / "x" / "r.xlsx"))
    wb = load_workbook(out["path"])
    assert wb.sheetnames == ["汇总", "明细"]
    detail = list(wb["明细"].iter_rows(values_only=True))
    assert detail[0][:7] == ("类型", "执行 ID", "用例 ID", "标题", "模块", "等级", "结果")
    assert len(detail) == 5
    bug_row = [r for r in detail if r[2] == setup["bug"]][0]
    assert bug_row[6] == "失败" and bug_row[8] == "产品缺陷" and bug_row[9] == "是"
    summary = dict(r[:2] for r in wb["汇总"].iter_rows(values_only=True))
    assert summary["用例总数"] == 4 and summary["失败"] == 1


def test_legacy_api_run_is_listed_as_pytest(cli, setup, tmp_path):
    # 一期的接口执行记录没有 framework 字段
    from aitest.store import Store
    store = Store(str(tmp_path / "db.sqlite"))
    store.conn.execute("UPDATE run SET result=? WHERE id=?", (json.dumps({"total": 1, "passed": 1}), setup["api"]))
    store.conn.commit()
    assert cli("list-runs", "--project", setup["pid"], "--framework", "pytest")[0]["id"] == setup["api"]
