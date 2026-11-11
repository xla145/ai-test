import json

import pytest

from aitest.cli import main


@pytest.fixture
def make_cli(tmp_path, capsys):
    def factory(db_name="db.sqlite"):
        db = str(tmp_path / db_name)

        def call(*args, ok=True):
            code = main(["--db", db, *args])
            out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
            assert (code == 0) == ok, out
            return out["data"] if ok else out["error"]

        return call

    return factory


@pytest.fixture
def cli(make_cli):
    return make_cli()


@pytest.fixture
def project(cli, tmp_path):
    envs = {"test": {"base_url": "http://sut", "login": {"url": "/login"}, "api_token": "leak", "auth_header": "X-Token"}}
    return cli("init-project", "--name", "p3", "--workspace", str(tmp_path / "ws"), "--environments", json.dumps(envs))["id"]


def _case(cli, pid, title="模块-场景", **extra):
    case = {"title": title, "type": "ui", "priority": "P1", "steps": ["a"], "expected": ["b"], **extra}
    return cli("create-case", "--project", pid, "--json", json.dumps(case, ensure_ascii=False))["id"]


def _run(cli, pid, tmp_path, results, framework="playwright"):
    f = tmp_path / "r.json"
    f.write_text(json.dumps(results), encoding="utf-8")
    return cli("save-run", "--project", pid, "--env", "test", "--results-file", str(f), "--framework", framework)


def test_usage_report_and_budget(cli, project):
    s1 = cli("agent-session", "--project", project, "--thread", "t1", "--purpose", "case_gen")["id"]
    s2 = cli("agent-session", "--project", project, "--thread", "t2", "--purpose", "heal")["id"]
    cli("add-tokens", "--session", s1, "--tokens", "800")
    cli("add-tokens", "--session", s2, "--tokens", "300")
    cli("add-tokens", "--session", s2, "--tokens", "100")
    assert cli("check-budget", "--project", project)["allowed"] is True  # 未设预算不限

    cli("set-setting", "--project", project, "--key", "price_per_mtok", "--value", "20")
    cli("set-setting", "--project", project, "--key", "currency", "--value", "CNY")
    usage = cli("usage-report", "--project", project)
    assert usage["total_tokens"] == 1200 and usage["agent_tasks"] == 2
    assert usage["by_purpose"] == {"case_gen": 800, "heal": 400}
    assert sum(usage["by_day"].values()) == 1200
    assert usage["estimated_cost"] == 0.024 and usage["currency"] == "CNY"

    cli("set-setting", "--project", project, "--key", "monthly_token_budget", "--value", "2000")
    cli("set-setting", "--project", project, "--key", "per_task_token_limit", "--value", "1500")
    b = cli("check-budget", "--project", project)
    assert b == {"month_used": 1200, "monthly_budget": 2000, "remaining": 800, "allowed": True, "per_task_limit": 800,
                 "shared": False}
    cli("add-tokens", "--session", s1, "--tokens", "900")
    assert cli("check-budget", "--project", project)["allowed"] is False
    assert "参数错误" in cli("set-setting", "--project", project, "--key", "x", "--value", "1", ok=False)
    assert "invalid" in cli("set-setting", "--project", project, "--key", "monthly_token_budget", "--value", "abc", ok=False)


def test_attribution_accuracy_and_interventions(cli, project, tmp_path):
    a, b = _case(cli, project, "模块-甲"), _case(cli, project, "模块-乙")
    run = _run(cli, project, tmp_path, [
        {"case_id": a, "status": "failed", "message": "locator timeout"},
        {"case_id": b, "status": "failed", "message": "expect failed"},
    ])
    rid = run["run_id"]
    cli("set-attribution", "--run", rid, "--case", a, "--type", "script_error", "--reason", "改版")
    cli("set-attribution", "--run", rid, "--case", b, "--type", "product_bug")
    assert {r["case_id"]: r["failure_type"] for r in cli("list-run-results", "--run", rid)} == {a: "script_error", b: "product_bug"}
    assert len(cli("list-attributions", "--project", project, "--pending")) == 2

    cli("confirm-attribution", "--run", rid, "--case", a, "--type", "script_error")
    cli("confirm-attribution", "--run", rid, "--case", b, "--type", "environment")
    m = cli("metrics", "--project", project)
    assert m["attribution_accuracy"] == 0.5 and m["attribution"] == {"correct": 1, "confirmed": 2}
    # 人工结论覆盖执行结果
    assert {r["case_id"]: r["failure_type"] for r in cli("list-run-results", "--run", rid)}[b] == "environment"
    assert cli("list-attributions", "--project", project, "--pending") == []

    cli("apply-fix", "--case", a, "--field", "expected", "--value", json.dumps(["显示已停用"]))
    cli("update-case", "--case", a, "--json", json.dumps({"status": "reviewed"}), "--actor", "human")
    cli("update-case", "--case", a, "--json", json.dumps({"priority": "P2"}))  # agent 修改不算人工介入
    m = cli("metrics", "--project", project)
    assert m["interventions"]["by_kind"] == {"attribution_confirmed": 2, "case_edited": 1, "fix_applied": 1}
    assert m["interventions_per_case"] == 2.0
    assert "invalid choice" in cli("set-attribution", "--run", rid, "--case", a, "--type", "bogus", ok=False)


def test_first_pass_rate(cli, project, tmp_path):
    ws = tmp_path / "ws" / "scripts" / "ui"
    ws.mkdir(parents=True, exist_ok=True)
    ids = [_case(cli, project, f"模块-{i}") for i in range(3)]
    for cid in ids[:2]:
        (ws / f"{cid}.spec.ts").write_text("// x\n", encoding="utf-8")
        cli("register-script", "--project", project, "--case", cid, "--path", f"scripts/ui/{cid}.spec.ts")
    _run(cli, project, tmp_path, [{"case_id": ids[0], "status": "passed"}, {"case_id": ids[1], "status": "failed", "message": "x"},
                                   {"case_id": ids[2], "status": "passed"}])
    _run(cli, project, tmp_path, [{"case_id": ids[1], "status": "passed"}])
    m = cli("metrics", "--project", project)
    assert m["first_pass"] == {"passed": 1, "measured": 2} and m["first_pass_rate"] == 0.5


def test_api_suite_registers_scripts(cli, project, tmp_path):
    from pathlib import Path
    spec = Path(__file__).parent / "fixtures" / "petstore.yaml"
    gen = cli("generate-api-cases", "--project", project, "--openapi", str(spec))
    cli("write-api-suite", "--project", project)
    cli("write-api-suite", "--project", project)
    scripts = cli("list-scripts")
    assert len(scripts) == gen["generated"] and {s["framework"] for s in scripts} == {"pytest"}
    assert scripts[0]["path"] == "scripts/api/test_api.py"


def test_stability_and_ui_gate(cli, project, tmp_path):
    a, b = _case(cli, project, "模块-稳"), _case(cli, project, "模块-抖")
    gate = cli("metrics", "--project", project)["ui_gate"]
    assert gate["passed"] is False and "次数不足" in gate["reasons"][0]
    for status in ["passed", "failed", "passed"]:
        _run(cli, project, tmp_path, [{"case_id": a, "status": "passed"}, {"case_id": b, "status": status, "message": "t"}])
    st = cli("stability", "--project", project)
    assert st["flaky"] == [b]
    gate = cli("metrics", "--project", project)["ui_gate"]
    assert gate["passed"] is False and gate["flaky_cases"] == [b]

    # 新的稳定运行，且产品缺陷导致的失败不计入稳定性
    cli("set-setting", "--project", project, "--key", "stability_threshold", "--value", "0.9")
    c = _case(cli, project, "模块-缺陷")
    for _ in range(5):
        r = _run(cli, project, tmp_path, [{"case_id": a, "status": "passed"}, {"case_id": c, "status": "failed", "message": "bug"}])
        cli("confirm-attribution", "--run", r["run_id"], "--case", c, "--type", "product_bug")
    gate = cli("metrics", "--project", project)["ui_gate"]
    assert gate["avg_pass_rate"] == 1.0 and gate["runs"] == 5
    assert gate["passed"] is False  # b 在最近窗口内仍不稳定
    # 接口回归不计入 UI 门禁
    _run(cli, project, tmp_path, [{"case_id": a, "status": "failed", "message": "x"}], framework="pytest")
    assert cli("metrics", "--project", project)["ui_gate"]["runs"] == 5


def test_export_import_roundtrip(make_cli, tmp_path):
    cli = make_cli("a.sqlite")
    envs = {"test": {"base_url": "http://sut", "auth_token": "SECRET", "nested": {"api_key": "K"},
                     "login": {"url": "/l", "username": "#u", "password": "#pwd", "submit": "#s"}}}
    pid = cli("init-project", "--name", "共享", "--workspace", str(tmp_path / "ws"), "--environments", json.dumps(envs))["id"]
    cid = _case(cli, pid, "模块-共享", data_refs=["DEM-1"])
    (tmp_path / "ws" / "scripts" / "ui" / f"{cid}.spec.ts").write_text("// s\n", encoding="utf-8")
    cli("register-script", "--project", pid, "--case", cid, "--path", f"scripts/ui/{cid}.spec.ts")
    cli("add-role", "--project", pid, "--role", "admin")
    cli("add-test-data", "--project", pid, "--key", "DEM-1", "--seed-script", "./seed DEM-1")
    cli("set-setting", "--project", pid, "--key", "monthly_token_budget", "--value", "5000")
    out = cli("export-workspace", "--project", pid, "--commit")
    assert out["cases"] == 1 and out["scripts"] == 1 and len(out["version"]) == 40
    meta = (tmp_path / "ws" / ".aitest" / "project.json").read_text(encoding="utf-8")
    assert "SECRET" not in meta and '"K"' not in meta and "http://sut" in meta
    # 登录方式里的 password 是密码框选择器，必须保留，否则导入方无法登录
    assert json.loads(meta)["environments"]["test"]["login"]["password"] == "#pwd"

    # 另一位成员 / CI：全新数据库导入
    other = make_cli("b.sqlite")
    imp = other("import-workspace", "--workspace", str(tmp_path / "ws"))
    assert imp == {"project_id": pid, "name": "共享", "cases": 1, "scripts": 1, "roles": 1}
    assert other("get-case", "--case", cid)["data_refs"] == ["DEM-1"]
    assert other("list-roles", "--project", pid)[0]["role_name"] == "admin"
    assert other("list-test-data", "--project", pid)[0]["seed_script"] == "./seed DEM-1"
    assert other("get-settings", "--project", pid) == {"monthly_token_budget": 5000}
    assert other("import-workspace", "--workspace", str(tmp_path / "ws"))["cases"] == 1  # 幂等
    assert len(other("list-roles", "--project", pid)) == 1
    assert "缺少" in other("import-workspace", "--workspace", str(tmp_path), ok=False)
