"""端到端：OpenAPI → 生成用例 → 生成脚本 → 回归执行 → 结果入库与初步归因。"""
import json
import os

from aitest.apigen import generate_suite, write_pytest_suite
from aitest.cli import main
from aitest.models import ApiSpec, TestCase
from aitest.openapi import parse_openapi
from aitest.runner import EnvConfig, run_pytest
from conftest import TOKEN


def _suite(tmp_path, openapi_path, extra=()):
    cases = generate_suite(parse_openapi(openapi_path))
    cases += list(extra)
    write_pytest_suite(cases, tmp_path / "api")
    return cases


def test_regression_all_pass(tmp_path, openapi_path, demo_server):
    url, _ = demo_server
    chain = [
        TestCase(title="用户-创建后删除-创建", type="api", execution_mode="api", steps=["创建"], expected=["201"],
                 api=ApiSpec(method="POST", path="/users", body={"name": "链路", "age": 3}, expected_status=[201],
                             expected_fields={"name": "链路"}, extract={"new_id": "id"})),
        TestCase(title="用户-创建后删除-删除", type="api", execution_mode="api", steps=["删除"], expected=["204"],
                 api=ApiSpec(method="DELETE", path="/users/{id}", path_params={"id": "${new_id}"},
                             expected_status=[204])),
    ]
    cases = _suite(tmp_path, openapi_path, chain)
    run, results = run_pytest(tmp_path / "api", EnvConfig(base_url=url, auth_token=TOKEN))
    failed = [(r.case_id, r.message) for r in results if r.status != "passed"]
    assert failed == []
    assert run.result["total"] == len(cases) and run.result["pass_rate"] == 1.0


def test_regression_detects_bug(tmp_path, openapi_path, demo_server):
    url, handler = demo_server
    handler.bug_max_age = True
    cases = _suite(tmp_path, openapi_path)
    run, results = run_pytest(tmp_path / "api", EnvConfig(base_url=url, auth_token=TOKEN))
    over = next(c for c in cases if c.title == "用户-创建用户-age大于最大值")
    failed = {r.case_id: r for r in results if r.status == "failed"}
    assert set(failed) == {over.id}
    assert failed[over.id].failure_type == "unknown"
    assert run.result["needs_agent"] == [over.id]


def test_environment_failure(tmp_path, openapi_path):
    _suite(tmp_path, openapi_path)
    run, results = run_pytest(tmp_path / "api", EnvConfig(base_url="http://127.0.0.1:9", auth_token=TOKEN, timeout=2))
    assert results and all(r.failure_type == "environment" for r in results if r.status != "passed")


def test_cli_flow(tmp_path, openapi_path, demo_server, capsys, monkeypatch):
    url, _ = demo_server
    db = str(tmp_path / "db.sqlite")

    def call(*args):
        assert main(["--db", db, *args]) == 0, capsys.readouterr().out
        return json.loads(capsys.readouterr().out.strip().splitlines()[-1])["data"]

    proj = call("init-project", "--name", "demo", "--workspace", str(tmp_path / "ws"),
                "--environments", json.dumps({"test": {"base_url": url}}))
    assert (tmp_path / "ws" / "AGENTS.md").exists()
    gen = call("generate-api-cases", "--project", proj["id"], "--openapi", str(openapi_path))
    assert gen["generated"] > 10
    files = call("write-api-suite", "--project", proj["id"])
    assert files["cases"] == gen["generated"]
    monkeypatch.setenv("AITEST_AUTH_TOKEN", TOKEN)
    run = call("run-api-suite", "--project", proj["id"], "--env", "test")
    assert run["failed"] == 0 and run["passed"] == gen["generated"]
    assert call("summarize-failures", "--run", run["run_id"]) == []
    # 未知环境返回错误 JSON
    assert main(["--db", db, "run-api-suite", "--project", proj["id"], "--env", "prod"]) == 1
    assert json.loads(capsys.readouterr().out)["ok"] is False
