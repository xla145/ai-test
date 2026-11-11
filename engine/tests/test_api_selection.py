import json

import pytest

from aitest.apigen import write_pytest_suite
from aitest.cli import main
from aitest.models import ApiSpec, TestCase
from aitest.runner import EnvConfig, run_pytest
from conftest import TOKEN


def cases():
    create = ApiSpec(method="POST", path="/users", body={"name": "测试用户", "age": 3},
                     expected_status=[201], extract={"uid": "id"})
    return [
        TestCase(title="用户-创建后删除", type="api", execution_mode="api", status="reviewed",
                 steps=["创建", "删除"], expected=["201", "204"], api_flow=[create,
                     ApiSpec(method="DELETE", path="/users/${uid}", expected_status=[204])]),
        TestCase(title="用户-不应执行的创建", type="api", execution_mode="api", status="reviewed",
                 steps=["创建"], expected=["201"], api=create),
    ]


def test_selection_executes_entire_flow_without_unselected_requests(tmp_path, demo_server):
    url, handler = demo_server
    flow, other = cases()
    write_pytest_suite([flow, other], tmp_path)
    run, results = run_pytest(tmp_path, EnvConfig(url, auth_token=TOKEN), case_ids=[flow.id])
    assert [(r.case_id, r.status) for r in results] == [(flow.id, "passed")]
    assert run.result["selected_case_ids"] == [flow.id]
    assert run.result["total"] == 1
    assert handler.next_id == 2  # 仅流程的创建发出请求；未选中的创建未执行。
    assert handler.users == {}  # 流程的后续删除也已执行。


@pytest.mark.parametrize("selection", [[], ["missing"]])
def test_invalid_selection_never_falls_back_to_all(tmp_path, demo_server, selection):
    url, handler = demo_server
    flow, other = cases()
    write_pytest_suite([flow, other], tmp_path)
    with pytest.raises((ValueError, RuntimeError), match="至少选择|缺少已生成的脚本"):
        run_pytest(tmp_path, EnvConfig(url, auth_token=TOKEN), case_ids=selection)
    assert handler.next_id == 1 and not handler.users


def test_partly_missing_selection_fails_before_any_request(tmp_path, demo_server):
    url, handler = demo_server
    flow, other = cases()
    write_pytest_suite([flow, other], tmp_path)
    with pytest.raises(RuntimeError, match="缺少已生成的脚本"):
        run_pytest(tmp_path, EnvConfig(url, auth_token=TOKEN), case_ids=[flow.id, "missing"])
    assert handler.next_id == 1


def test_cli_selected_run_and_persistent_test_sets(tmp_path, demo_server, capsys, monkeypatch):
    url, handler = demo_server
    db = str(tmp_path / "db.sqlite")

    def call(*args, ok=True):
        code = main(["--db", db, *args])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert (code == 0) == ok, out
        return out["data"] if ok else out["error"]

    p = call("init-project", "--name", "选择执行", "--workspace", str(tmp_path / "ws"),
             "--environments", json.dumps({"test": {"base_url": url}}))["id"]
    flow, other = [call("create-case", "--project", p, "--json", json.dumps(c.to_dict())) for c in cases()]
    ids = json.dumps([flow["id"], flow["id"]])
    assert "先生成已审核脚本" in call("run-api-suite", "--project", p, "--env", "test", "--case-ids", ids, ok=False)
    call("write-api-suite", "--project", p, "--reviewed-only")
    monkeypatch.setenv("AITEST_AUTH_TOKEN", TOKEN)
    result = call("run-api-suite", "--project", p, "--env", "test", "--case-ids", ids)
    assert result["total"] == result["passed"] == 1
    assert handler.next_id == 2 and not handler.users
    assert call("list-api-test-sets", "--project", p) == []
    saved = call("save-api-test-set", "--project", p, "--name", "订单冒烟", "--case-ids", ids)
    assert saved == {"name": "订单冒烟", "case_ids": [flow["id"]]}
    assert call("list-api-test-sets", "--project", p) == [saved]
    call("save-api-test-set", "--project", p, "--name", "订单冒烟", "--case-ids", json.dumps([other["id"]]))
    assert len(call("list-api-test-sets", "--project", p)) == 1
    # 保存的 ID 已废弃时拒绝执行，不悄悄执行其余用例。
    call("update-case", "--case", other["id"], "--json", '{"status":"deprecated"}')
    assert "重新选择" in call("run-api-suite", "--project", p, "--env", "test", "--case-ids",
                              json.dumps([other["id"]]), ok=False)
    assert "至少选择" in call("run-api-suite", "--project", p, "--env", "test", "--case-ids", "[]", ok=False)
    foreign = call("init-project", "--name", "其它项目", "--workspace", str(tmp_path / "other"))["id"]
    assert "不属于当前项目" in call("save-api-test-set", "--project", foreign, "--name", "错误引用", "--case-ids", ids, ok=False)
