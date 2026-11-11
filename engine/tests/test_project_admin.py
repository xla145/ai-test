"""项目管理：重命名、环境增删改、移除项目、按 ID 取用例标题。"""

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


def _setup(cli, tmp_path, name):
    pid = cli("init-project", "--name", name, "--workspace", str(tmp_path / name),
              "--environments", json.dumps({"test": {"base_url": "http://t"}}))["id"]
    ids = []
    for i in range(3):
        case = {"title": f"{name}模块-场景{i}", "type": "api", "priority": "P1", "steps": ["调用"], "expected": ["200"]}
        ids.append(cli("create-case", "--project", pid, "--json", json.dumps(case, ensure_ascii=False))["id"])
    return pid, ids


def test_rename_and_environment_crud(cli, tmp_path):
    pid, _ = _setup(cli, tmp_path, "a")
    assert cli("update-project", "--project", pid, "--name", "  订单服务  ")["name"] == "订单服务"
    assert "不能为空" in cli("update-project", "--project", pid, "--name", " ", ok=False)

    env = cli("set-environment", "--project", pid, "--env", "prod",
              "--json", json.dumps({"base_url": "https://prod", "production": True}))["environments"]
    assert env["prod"]["production"] is True and env["test"]["base_url"] == "http://t"
    assert "base_url" in cli("set-environment", "--project", pid, "--env", "x", "--json", json.dumps({"base_url": "prod"}), ok=False)

    left = cli("delete-environment", "--project", pid, "--env", "prod")["environments"]
    assert set(left) == {"test"}
    assert "未配置环境" in cli("delete-environment", "--project", pid, "--env", "prod", ok=False)


def test_delete_project_removes_only_its_records(cli, db, tmp_path):
    a, ca = _setup(cli, tmp_path, "a")
    b, cb = _setup(cli, tmp_path, "b")
    store = ops.ensure_schema(Store(db))
    for pid, cases in ((a, ca), (b, cb)):
        run = Run(project_id=pid, env="test", mode="regression", started_at="2026-01-01T00:00:00Z")
        store.save_run(run, [RunResult(run_id=run.id, case_id=c, status="failed", message="x") for c in cases])
        ops.set_attribution(store, run.id, cases[0], "script_error")
        store.save_proposal(HealProposal(case_id=cases[0], script_path="s", original="a", proposed="b", diff="d"))
        store.save_review(ReviewItem(case_id=cases[0], kind="visual", description="d"))
    store.close()
    cli("lint", "--project", a)

    out = cli("delete-project", "--project", a)
    assert out["deleted"]["testcase"] == 3 and out["deleted"]["run_result"] == 3
    assert (tmp_path / "a").is_dir()  # workspace 保留
    assert [p["id"] for p in cli("list-projects")] == [b]
    # 另一个项目的数据不受影响
    assert len(cli("list-cases", "--project", b)) == 3
    assert len(cli("list-proposals", "--project", b)) == 1 and len(cli("list-proposals")) == 1
    assert len(cli("list-reviews")) == 1
    assert cli("list-attributions", "--project", b, "--page-size", "5")["total"] == 1
    assert "项目不存在" in cli("get-project", "--project", a, ok=False)


def test_list_cases_by_ids(cli, tmp_path):
    pid, ids = _setup(cli, tmp_path, "a")
    got = cli("list-cases", "--project", pid, "--ids", f"{ids[2]},{ids[0]},tc_missing")
    assert sorted(c["id"] for c in got) == sorted([ids[0], ids[2]])


def test_clear_cases_keeps_runs_and_other_projects(cli, db, tmp_path):
    a, ca = _setup(cli, tmp_path, "a")
    b, cb = _setup(cli, tmp_path, "b")
    store = ops.ensure_schema(Store(db))
    run = Run(project_id=a, env="test", mode="regression", started_at="2026-01-01T00:00:00Z")
    store.save_run(run, [RunResult(run_id=run.id, case_id=c, status="passed") for c in ca])
    for pid, cases in ((a, ca), (b, cb)):
        store.save_proposal(HealProposal(case_id=cases[0], script_path="s", original="a", proposed="b", diff="d"))
        store.save_review(ReviewItem(case_id=cases[0], kind="visual", description="d"))
    store.close()
    cli("lint", "--project", a)

    out = cli("clear-cases", "--project", a)
    assert out["deleted"]["testcase"] == 3 and out["deleted"]["heal_proposal"] == 1
    assert cli("list-cases", "--project", a) == []
    assert len(cli("list-runs", "--project", a)) == 1  # 执行记录保留
    assert (tmp_path / "a").is_dir()
    # 其它项目不受影响
    assert len(cli("list-cases", "--project", b)) == 3
    assert len(cli("list-proposals", "--project", b)) == 1 and len(cli("list-reviews")) == 1


def test_clear_cases_rejects_group(cli):
    g = cli("init-project", "--name", "g", "--kind", "group", "--environments", "{}")["id"]
    assert "大项目" in cli("clear-cases", "--project", g, ok=False)
