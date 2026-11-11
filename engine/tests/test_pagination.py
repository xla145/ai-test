"""列表命令的分页、搜索与按项目过滤。"""

import json

import pytest

from aitest import ops
from aitest.cli import main
from aitest.models import HealProposal, ReviewItem, Run, RunResult
from aitest.store import Store


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "db.sqlite")


@pytest.fixture
def cli(db, capsys):
    def call(*args, ok=True):
        code = main(["--db", db, *args])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert (code == 0) == ok, out
        return out["data"] if ok else out["error"]

    return call


def _project(cli, tmp_path, name):
    return cli("init-project", "--name", name, "--workspace", str(tmp_path / name))["id"]


def _cases(cli, pid, n, **extra):
    ids = []
    for i in range(n):
        case = {"title": f"标签管理-场景{i:02d}", "type": "ui", "priority": "P1", "steps": ["打开页面"],
                "expected": ["显示列表"], "module_path": ["标签", f"分组{i % 3}"], **extra}
        ids.append(cli("create-case", "--project", pid, "--json", json.dumps(case, ensure_ascii=False))["id"])
    return ids


def test_list_cases_pages_in_insertion_order(cli, tmp_path):
    pid = _project(cli, tmp_path, "p")
    ids = _cases(cli, pid, 7)

    first = cli("list-cases", "--project", pid, "--page-size", "3")
    assert first["total"] == 7 and first["page"] == 1 and first["page_size"] == 3
    assert [c["id"] for c in first["items"]] == ids[:3]
    last = cli("list-cases", "--project", pid, "--page", "3", "--page-size", "3")
    assert [c["id"] for c in last["items"]] == ids[6:]
    beyond = cli("list-cases", "--project", pid, "--page", "9", "--page-size", "3")
    assert beyond["items"] == [] and beyond["total"] == 7

    # 不传 --page-size 时仍返回完整列表（MCP Server、编排层依赖这一格式）
    assert [c["id"] for c in cli("list-cases", "--project", pid)] == ids


def test_list_cases_query_and_multi_value_filters(cli, tmp_path):
    pid = _project(cli, tmp_path, "p")
    ids = _cases(cli, pid, 6)
    cli("update-case", "--case", ids[0], "--json", json.dumps({"status": "deprecated"}))
    cli("update-case", "--case", ids[1], "--json", json.dumps({"execution_mode": "api"}))

    # 标题、模块路径、用例 ID 都能搜到；搜索词里的 % 和 _ 按字面匹配
    assert cli("list-cases", "--project", pid, "--query", "场景03", "--page-size", "10")["total"] == 1
    assert cli("list-cases", "--project", pid, "--query", "分组1", "--page-size", "10")["total"] == 2
    assert cli("list-cases", "--project", pid, "--query", ids[4], "--page-size", "10")["total"] == 1
    assert cli("list-cases", "--project", pid, "--query", "%", "--page-size", "10")["total"] == 0
    # 未转义时「场景_」会匹配「场景00」等标题
    assert cli("list-cases", "--project", pid, "--query", "场景_", "--page-size", "10")["total"] == 0

    page = cli("list-cases", "--project", pid, "--execution-mode", "ui,capture", "--status", "draft,reviewed",
               "--page-size", "10")
    assert page["total"] == 4 and ids[0] not in {c["id"] for c in page["items"]} and ids[1] not in {c["id"] for c in page["items"]}


def test_invalid_page_arguments_are_rejected(cli, tmp_path):
    pid = _project(cli, tmp_path, "p")
    assert "正整数" in cli("list-cases", "--project", pid, "--page-size", "0", ok=False)
    assert "正整数" in cli("list-cases", "--project", pid, "--page", "-1", "--page-size", "5", ok=False)


def test_issues_page_by_project_and_level(cli, tmp_path):
    a = _project(cli, tmp_path, "a")
    b = _project(cli, tmp_path, "b")
    # 步骤与预期数量不一致 → 阻断问题
    for pid in (a, b):
        for i in range(3):
            case = {"title": f"标签管理-异常{i}", "type": "ui", "priority": "P2", "steps": ["一", "二"], "expected": ["一"]}
            cli("create-case", "--project", pid, "--json", json.dumps(case, ensure_ascii=False))
        cli("lint", "--project", pid)

    everything = cli("list-issues", "--project", a, "--page-size", "100")
    assert everything["total"] > 0 and everything["levels"]
    assert sum(everything["levels"].values()) == everything["total"]
    level, n = next(iter(everything["levels"].items()))
    only = cli("list-issues", "--project", a, "--level", level, "--page-size", "2")
    assert only["total"] == n and len(only["items"]) == min(2, n) and {i["level"] for i in only["items"]} == {level}
    # 另一个项目的问题不计入
    assert everything["total"] == len([i for i in cli("list-issues") if i["case_id"] in
                                       {c["id"] for c in cli("list-cases", "--project", a)}])


def test_proposals_and_reviews_are_scoped_to_project(cli, db, tmp_path):
    a = _project(cli, tmp_path, "a")
    b = _project(cli, tmp_path, "b")
    ca = _cases(cli, a, 3)
    cb = _cases(cli, b, 2)
    store = Store(db)
    for c in ca + cb:
        store.save_proposal(HealProposal(case_id=c, script_path="s.spec.ts", original="a", proposed="b", diff="-a\n+b"))
        store.save_review(ReviewItem(case_id=c, kind="visual", description="截图对比"))
    store.close()

    page = cli("list-proposals", "--project", a, "--status", "pending", "--page-size", "2")
    assert page["total"] == 3 and len(page["items"]) == 2 and {p["case_id"] for p in page["items"]} <= set(ca)
    assert "original" not in page["items"][0] and page["items"][0]["diff"]
    assert cli("list-reviews", "--project", b, "--page-size", "10")["total"] == 2
    # 不传 --project 时保持原来的全局列表
    assert len(cli("list-proposals")) == 5 and len(cli("list-reviews", "--status", "pending")) == 5


def test_attributions_and_run_results_page(cli, db, tmp_path):
    pid = _project(cli, tmp_path, "p")
    ids = _cases(cli, pid, 5)
    store = Store(db)
    ops.ensure_schema(store)
    run = Run(project_id=pid, env="test", mode="regression", started_at="2026-01-01T00:00:00Z")
    store.save_run(run, [RunResult(run_id=run.id, case_id=c, status="failed", message="boom") for c in ids])
    for c in ids:
        ops.set_attribution(store, run.id, c, "script_error", source="rule")
    store.close()

    results = cli("list-run-results", "--run", run.id, "--page", "2", "--page-size", "2")
    assert results["total"] == 5 and [r["case_id"] for r in results["items"]] == ids[2:4]

    pending = cli("list-attributions", "--project", pid, "--pending", "--page-size", "2")
    assert pending["total"] == 5 and len(pending["items"]) == 2
    cli("confirm-attribution", "--run", run.id, "--case", ids[0], "--type", "product_bug")
    assert cli("list-attributions", "--project", pid, "--pending", "--page-size", "2")["total"] == 4
    assert cli("list-attributions", "--project", pid, "--page-size", "2")["total"] == 5
