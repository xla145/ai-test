import json
import subprocess

import pytest

from aitest.cli import main


@pytest.fixture
def cli(tmp_path, capsys):
    db = str(tmp_path / "db.sqlite")

    def call(*args, ok=True):
        code = main(["--db", db, *args])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert (code == 0) == ok, out
        return out["data"] if ok else out["error"]

    return call


def _project(cli, tmp_path):
    return cli("init-project", "--name", "ui", "--workspace", str(tmp_path / "ws"),
               "--environments", json.dumps({"test": {"base_url": "http://localhost:3000"}}))


def _case(cli, pid, **extra):
    case = {"title": "标签管理-停用标签", "type": "ui", "priority": "P1", "steps": ["停用标签"],
            "expected": ["显示已停用"], **extra}
    return cli("create-case", "--project", pid, "--json", json.dumps(case, ensure_ascii=False))


def test_workspace_has_ui_skills(cli, tmp_path):
    _project(cli, tmp_path)
    skills = tmp_path / "ws" / ".agents" / "skills"
    assert (skills / "ui-explore.md").exists() and (skills / "ui-heal.md").exists()
    assert "browser" in (tmp_path / "ws" / "AGENTS.md").read_text(encoding="utf-8")


def test_roles_test_data_and_env(cli, tmp_path):
    pid = _project(cli, tmp_path)["id"]
    role = cli("add-role", "--project", pid, "--role", "admin")
    assert role["credential_ref"] == f"aitest:{pid}:role:admin"
    assert role["storage_state_path"] == "scripts/ui/.auth/admin.json"
    cli("add-role", "--project", pid, "--role", "admin")
    assert len(cli("list-roles", "--project", pid)) == 1
    cli("add-test-data", "--project", pid, "--key", "DEM-1002", "--seed-script", "python seed.py DEM-1002")
    assert cli("list-test-data", "--project", pid)[0]["key"] == "DEM-1002"
    env = cli("set-environment", "--project", pid, "--env", "staging", "--json", json.dumps({"base_url": "http://s"}))
    assert set(env["environments"]) == {"test", "staging"}


def test_register_script_and_heal_flow(cli, tmp_path):
    pid = _project(cli, tmp_path)["id"]
    case = _case(cli, pid)
    spec = tmp_path / "ws" / "scripts" / "ui" / f"{case['id']}.spec.ts"
    spec.write_text("await page.getByTestId('disable').click();\n", encoding="utf-8")
    s = cli("register-script", "--project", pid, "--case", case["id"], "--path", f"scripts/ui/{spec.name}")
    assert len(s["version"]) == 40

    new = tmp_path / "new.ts"
    new.write_text("await page.getByRole('button', { name: '停用' }).click();\n", encoding="utf-8")
    # 产品缺陷不允许改脚本
    assert "产品缺陷" in cli("propose-fix", "--project", pid, "--case", case["id"], "--script", f"scripts/ui/{spec.name}",
                          "--content-file", str(new), "--failure-type", "product_bug", ok=False)
    # workspace 外的路径被拒绝
    assert "workspace" in cli("propose-fix", "--project", pid, "--case", case["id"], "--script", "../evil.ts",
                              "--content-file", str(new), ok=False)
    prop = cli("propose-fix", "--project", pid, "--case", case["id"], "--script", f"scripts/ui/{spec.name}",
               "--content-file", str(new), "--reason", "按钮 testid 变更")
    assert "-await page.getByTestId('disable')" in prop["diff"] and "+await page.getByRole" in prop["diff"]
    assert spec.read_text(encoding="utf-8").startswith("await page.getByTestId")  # 未确认前不改脚本
    assert [p["id"] for p in cli("list-proposals", "--status", "pending")] == [prop["id"]]

    done = cli("resolve-proposal", "--project", pid, "--id", prop["id"], "--accept")
    assert done["status"] == "accepted" and len(done["commit"]) == 40
    assert "getByRole" in spec.read_text(encoding="utf-8")
    log = subprocess.run(["git", "log", "--oneline"], cwd=tmp_path / "ws", capture_output=True, text=True).stdout
    assert "自愈" in log
    assert cli("list-scripts", "--case", case["id"])[0]["version"] == done["commit"]
    assert "已处理" in cli("resolve-proposal", "--project", pid, "--id", prop["id"], "--accept", ok=False)


def test_heal_rejects_stale_proposal(cli, tmp_path):
    pid = _project(cli, tmp_path)["id"]
    case = _case(cli, pid)
    spec = tmp_path / "ws" / "scripts" / "ui" / "a.spec.ts"
    spec.write_text("v1\n", encoding="utf-8")
    new = tmp_path / "n.ts"
    new.write_text("v2\n", encoding="utf-8")
    prop = cli("propose-fix", "--project", pid, "--case", case["id"], "--script", "scripts/ui/a.spec.ts",
               "--content-file", str(new))
    spec.write_text("edited by human\n", encoding="utf-8")
    assert "已被修改" in cli("resolve-proposal", "--project", pid, "--id", prop["id"], "--accept", ok=False)
    assert cli("resolve-proposal", "--project", pid, "--id", prop["id"])["status"] == "rejected"


def test_blocked_case_cannot_register_script(cli, tmp_path):
    pid = _project(cli, tmp_path)["id"]
    case = _case(cli, pid, expected=["若数值相同则须记录说明"])
    cli("lint", "--project", pid)
    assert "阻断" in cli("register-script", "--project", pid, "--case", case["id"], "--path", "scripts/ui/x.spec.ts", ok=False)


def test_save_run_with_reviews(cli, tmp_path):
    pid = _project(cli, tmp_path)["id"]
    results = tmp_path / "results.json"
    results.write_text(json.dumps([
        {"case_id": "tc_a", "status": "passed", "duration": 1.2,
         "reviews": [{"kind": "visual", "description": "缺失值显示灰色", "evidence_paths": ["a.png"]}]},
        {"case_id": "tc_b", "status": "failed", "message": "locator.click: Timeout 5000ms exceeded"},
        {"case_id": "tc_c", "status": "failed", "message": "page.goto: net::ERR_CONNECTION_REFUSED", "failure_type": "environment"},
    ]), encoding="utf-8")
    run = cli("save-run", "--project", pid, "--env", "test", "--results-file", str(results))
    assert run["total"] == 3 and run["passed"] == 1 and run["reviews"] == 1
    assert run["needs_agent"] == ["tc_b"]
    reviews = cli("list-reviews", "--status", "pending")
    assert reviews[0]["description"] == "缺失值显示灰色" and reviews[0]["run_id"] == run["run_id"]
    assert cli("resolve-review", "--id", reviews[0]["id"], "--passed")["status"] == "confirmed_pass"
    assert {r["case_id"] for r in cli("list-run-results", "--run", run["run_id"])} == {"tc_a", "tc_b", "tc_c"}
