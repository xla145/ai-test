"""两层项目：大项目共享配置，子项目继承。"""

import json

import pytest

from aitest import ops
from aitest.cli import main
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


@pytest.fixture
def tree(cli, tmp_path):
    g = cli("init-project", "--name", "特征中心", "--kind", "group",
            "--environments", json.dumps({"test": {"base_url": "http://t"}, "prod": {"base_url": "https://p", "production": True}}))
    a = cli("init-project", "--name", "v4.4", "--workspace", str(tmp_path / "a"), "--parent", g["id"])
    b = cli("init-project", "--name", "v4.5", "--workspace", str(tmp_path / "b"), "--parent", g["id"],
            "--environments", json.dumps({"test": {"base_url": "http://t-v45"}}))
    return g, a, b


def test_group_has_no_workspace_and_rejects_case_commands(cli, tree, tmp_path):
    g, a, _ = tree
    assert g["kind"] == "group" and g["workspace_path"] == ""
    assert sorted(cli("get-project", "--project", g["id"])["children"]) == sorted([a["id"], tree[2]["id"]])
    case = json.dumps({"title": "模块-场景", "type": "api", "priority": "P1", "steps": ["x"], "expected": ["y"]}, ensure_ascii=False)
    assert "大项目" in cli("create-case", "--project", g["id"], "--json", case, ok=False)
    assert "大项目" in cli("run-api-suite", "--project", g["id"], "--env", "test", ok=False)
    assert "两层" in cli("init-project", "--name", "x", "--kind", "group", "--parent", g["id"], ok=False)
    assert "不是大项目" in cli("init-project", "--name", "x", "--workspace", str(tmp_path / "x"), "--parent", a["id"], ok=False)


def test_environments_are_inherited_and_overridable(cli, tree):
    g, a, b = tree
    va = cli("get-project", "--project", a["id"])
    assert va["environments"]["test"]["base_url"] == "http://t" and va["environments"]["prod"]["production"] is True
    assert va["own_environments"] == {} and va["inherited_environments"] == {"test": g["id"], "prod": g["id"]}
    assert va["parent_name"] == "特征中心"
    vb = cli("get-project", "--project", b["id"])
    assert vb["environments"]["test"]["base_url"] == "http://t-v45"  # 子项目覆盖
    assert vb["inherited_environments"] == {"prod": g["id"]}
    # 大项目改了环境，未覆盖的子项目立即生效
    cli("set-environment", "--project", g["id"], "--env", "test", "--json", json.dumps({"base_url": "http://t2"}))
    assert cli("get-project", "--project", a["id"])["environments"]["test"]["base_url"] == "http://t2"
    assert cli("get-project", "--project", b["id"])["environments"]["test"]["base_url"] == "http://t-v45"
    # 子项目自己的环境配置不会被写入继承来的值
    assert cli("list-projects")[[p["id"] for p in cli("list-projects")].index(a["id"])]["own_environments"] == {}


def test_roles_and_settings_are_inherited(cli, tree):
    g, a, _ = tree
    cli("add-role", "--project", g["id"], "--role", "管理员")
    cli("add-role", "--project", g["id"], "--role", "访客")
    cli("add-role", "--project", a["id"], "--role", "访客")
    roles = {r["role_name"]: r.get("inherited_from") for r in cli("list-roles", "--project", a["id"])}
    assert roles == {"管理员": g["id"], "访客": None}

    cli("set-setting", "--project", g["id"], "--key", "price_per_mtok", "--value", "20")
    cli("set-setting", "--project", g["id"], "--key", "currency", "--value", "CNY")
    cli("set-setting", "--project", a["id"], "--key", "currency", "--value", "USD")
    d = cli("get-settings", "--project", a["id"], "--detail")
    assert d["effective"] == {"price_per_mtok": 20.0, "currency": "USD"}
    assert d["inherited"] == {"price_per_mtok": 20.0} and d["own"] == {"currency": "USD"}
    # 清空本项目的值后恢复继承
    cli("set-setting", "--project", a["id"], "--key", "currency", "--value", "")
    assert cli("get-settings", "--project", a["id"])["currency"] == "CNY"


def test_group_budget_counts_all_children(cli, db, tree):
    g, a, b = tree
    store = ops.ensure_schema(Store(db))
    for pid, tokens in ((a["id"], 700), (b["id"], 500)):
        ops.log_event(store, "tokens", pid, data={"tokens": tokens, "purpose": "case_gen"})
    store.close()
    cli("set-setting", "--project", g["id"], "--key", "monthly_token_budget", "--value", "1000")
    # 子项目继承大项目预算：按整个大项目累计，已超出
    budget_a = cli("check-budget", "--project", a["id"])
    assert budget_a["month_used"] == 1200 and budget_a["allowed"] is False and budget_a["shared"] is True
    # 子项目设置自己的预算后只算自己
    cli("set-setting", "--project", b["id"], "--key", "monthly_token_budget", "--value", "1000")
    assert cli("check-budget", "--project", b["id"])["month_used"] == 500
    usage = cli("usage-report", "--project", g["id"])
    assert usage["total_tokens"] == 1200 and usage["by_project"] == {a["id"]: 700, b["id"]: 500}
    overview = cli("project-overview", "--project", g["id"])
    assert {c["name"]: c["month_tokens"] for c in overview["children"]} == {"v4.4": 700, "v4.5": 500}


def test_move_and_delete(cli, tree, tmp_path):
    g, a, _ = tree
    solo = cli("init-project", "--name", "订单服务", "--workspace", str(tmp_path / "solo"))
    moved = cli("update-project", "--project", solo["id"], "--parent", g["id"])
    assert moved["parent_id"] == g["id"] and moved["environments"]["test"]["base_url"] == "http://t"
    assert cli("update-project", "--project", solo["id"], "--parent", "")["parent_id"] == ""
    assert "两层" in cli("update-project", "--project", g["id"], "--parent", g["id"], ok=False)
    assert "子项目" in cli("delete-project", "--project", g["id"], ok=False)
    cli("delete-project", "--project", a["id"])
    cli("delete-project", "--project", tree[2]["id"])
    cli("delete-project", "--project", g["id"])
    assert [p["name"] for p in cli("list-projects")] == ["订单服务"]


def test_old_database_is_migrated(tmp_path, capsys):
    import sqlite3
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_path TEXT NOT NULL, environments TEXT NOT NULL DEFAULT '{}')")
    conn.execute("INSERT INTO project VALUES ('proj_old', '旧项目', '/ws', '{}')")
    conn.commit()
    conn.close()
    assert main(["--db", str(db), "list-projects"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["data"][0]["kind"] == "project" and out["data"][0]["parent_id"] == ""


def test_app_cases_route_to_app_mode(cli, tree):
    _, a, _ = tree
    from aitest import router
    from aitest.models import TestCase
    mk = lambda title, type_="ui": TestCase(project_id="p", title=title, type=type_, priority="P1", steps=["s"], expected=["e"])
    assert router.route(mk("标签管理-Android 端停用标签")) == "app"
    assert router.route(mk("登录-iPhone 指纹登录")) == "app"
    assert router.route(mk("任意标题", "app")) == "app"
    assert router.route(mk("兼容性-Firefox 下展示")) == "manual"
    case = json.dumps({"title": "订单-App端下单", "type": "app", "priority": "P1", "steps": ["下单"], "expected": ["成功"]}, ensure_ascii=False)
    assert cli("create-case", "--project", a["id"], "--json", case)["execution_mode"] == "app"


def test_mobile_failures_are_classified_as_environment():
    from aitest.runner import classify_failure
    assert classify_failure("Device emulator-5554 not found") == "environment"
    assert classify_failure("App com.example.shop is not installed on the device") == "environment"
    assert classify_failure("Element not found: Text matching regex: 已停用") == "unknown"
