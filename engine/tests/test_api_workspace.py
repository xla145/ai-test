import copy
import json
from pathlib import Path

import httpx
import pytest

from aitest import api_workspace as ws
from aitest.api_runtime import execute_case, render
from aitest.models import Project
from aitest.store import Store
from aitest.cli import main


@pytest.fixture
def catalog(tmp_path, openapi_path):
    store = Store(tmp_path / "catalog.sqlite")
    p = store.add_project(Project(name="接口工作台", workspace_path=str(tmp_path / "workspace"), environments={"test": {"base_url": "http://test"}}))
    ws.ensure_schema(store)
    preview = ws.preview(store, p.id, str(openapi_path))
    yield store, p, preview
    store.close()


def test_import_is_idempotent_and_contract_change_invalidates_approval(catalog):
    store, p, preview = catalog
    first = ws.import_document(store, p.id, preview)["definitions"]
    second = ws.import_document(store, p.id, preview)["definitions"]
    assert [(d["id"], d["revision"]) for d in first] == [(d["id"], d["revision"]) for d in second]
    d = first[0]
    saved = ws.save_case(store, p.id, {"title": "接口-正向请求", "kind": "single", "steps": [d["request"]]})
    c = store.get_case(saved["id"])
    c.status = "reviewed"
    store.upsert_case(c)
    changed = copy.deepcopy(preview)
    changed["document"]["paths"][d["path"]][d["method"].lower()]["summary"] = "接口的新描述"
    ws.import_document(store, p.id, changed)
    after = store.get_case(c.id)
    assert after.status == "draft" and after.api_needs_review
    assert after.api.definition_revision == 1
    assert next(v for v in ws.definitions(store, p.id) if v["id"] == d["id"])["revision"] == 2
    assert after.api.path == c.api.path


def test_cross_source_conflict_leaves_import_unchanged(catalog):
    store, p, preview = catalog
    before = ws.import_document(store, p.id, preview)["definitions"]
    other = {**preview, "source": "another-document.yaml"}
    with pytest.raises(ValueError, match="其他文档来源"):
        ws.import_document(store, p.id, other)
    assert ws.definitions(store, p.id) == before
    assert store.conn.execute("SELECT count(*) FROM api_source").fetchone()[0] == 1


def test_removed_definition_keeps_case_and_generation_never_overwrites(catalog):
    store, p, preview = catalog
    definitions = ws.import_document(store, p.id, preview)["definitions"]
    d = definitions[0]
    first = ws.generate_cases(store, p.id, [d["id"]])
    c = store.get_case(first["case_ids"][0])
    c.title = "人工编辑-保留请求"
    store.upsert_case(c)
    again = ws.generate_cases(store, p.id, [d["id"]])
    assert again["generated"] == 0 and again["skipped"] == first["generated"]
    assert store.get_case(c.id).title == "人工编辑-保留请求"
    changed = copy.deepcopy(preview)
    del changed["document"]["paths"][d["path"]][d["method"].lower()]
    ws.import_document(store, p.id, changed)
    assert next(v for v in ws.definitions(store, p.id) if v["id"] == d["id"])["removed"]
    assert store.get_case(c.id).api_needs_review


def test_variable_checks_prevent_broken_reordering_and_duplicates():
    create = {"method": "POST", "path": "/orders", "expected_status": [201], "extract": {"orderId": "data.id"}}
    query = {"method": "GET", "path": "/orders/${orderId}", "expected_status": [200]}
    ws.validate_requests([create, query])
    with pytest.raises(ValueError, match="尚未定义"):
        ws.validate_requests([query, create])
    with pytest.raises(ValueError, match="重名"):
        ws.validate_requests([create, create])
    with pytest.raises(ValueError, match="路径参数"):
        ws.validate_requests([{**query, "path": "/orders/{orderId}"}])
    assert render("${number}", {"number": 42}, True) == 42


def test_non_json_interfaces_can_be_cataloged_but_not_run_or_generated(catalog):
    store, p, preview = catalog
    changed = copy.deepcopy(preview)
    path, item = next(iter(changed["document"]["paths"].items()))
    method = next(key for key in item if key in ws.openapi.HTTP_METHODS)
    item[method]["requestBody"] = {"content": {"multipart/form-data": {"schema": {"type": "object"}}}}
    definitions = ws.import_document(store, p.id, changed)["definitions"]
    definition = next(d for d in definitions if d["path"] == path and d["method"] == method.upper())
    assert definition["unsupported_body"]
    with pytest.raises(ValueError, match="JSON 请求体"):
        ws.generate_cases(store, p.id, [definition["id"]])
    with pytest.raises(ValueError, match="JSON 请求体"):
        ws.debug(store, p.id, "test", {"steps": [definition["request"]]})


def test_failed_flow_blocks_dependents_runs_cleanup_and_redacts():
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(201 if request.url.path == "/create" else 200,
                              json={"data": {"id": 8, "token": "response-private-token"}})

    env = {"auth_token": "Bearer private-token", "auth_header": "X-Auth"}
    case = {"variable_scope": "case", "steps": [
        {"name": "创建", "method": "POST", "path": "/create", "expected_status": [201], "extract": {"id": "data.id"},
         "response_schema": {"type": "object", "description": "契约中的 ${example} 不参与变量替换"}},
        {"name": "校验", "method": "GET", "path": "/check/${id}", "expected_status": [409]},
        {"name": "不应执行", "method": "GET", "path": "/after", "expected_status": [200]},
    ], "cleanup": [{"method": "DELETE", "path": "/cleanup/${id}", "expected_status": [200]}]}
    shared = {"other": "untouched"}
    with httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler)) as client:
        result = execute_case(case, client, env, shared, lambda _: "")
    assert calls == ["/create", "/check/8", "/cleanup/8"]
    assert [s["status"] for s in result["steps"]] == ["passed", "failed", "blocked"]
    assert result["cleanup"][0]["status"] == "passed"
    assert result["status"] == "failed" and shared == {"other": "untouched"}
    assert "private-token" not in json.dumps(result)
    assert result["steps"][0]["request"]["headers"]["X-Auth"] == "[已隐藏]"


def test_trial_and_exported_regression_have_identical_assertions(tmp_path, demo_server, capsys):
    base, _ = demo_server
    db = tmp_path / "workbench.sqlite"

    def cli(*args, ok=True):
        code = main(["--db", str(db), *args])
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert (code == 0) is ok, result
        return result.get("data") if ok else result["error"]

    project = cli("init-project", "--name", "演示", "--workspace", str(tmp_path / "ws"), "--environments", json.dumps({"test": {"base_url": base}, "prod": {"base_url": base, "production": True}}))
    pid = project["id"]

    def call(action, payload):
        path = tmp_path / "payload.json"
        path.write_text(json.dumps(payload))
        return cli("api-workspace", "--project", pid, "--action", action, "--file", str(path))

    draft = {"title": "健康检查-可用", "kind": "single", "steps": [{"method": "GET", "path": "/health", "expected_status": [200],
             "assertions": [{"path": "status", "operator": "eq", "value": "ok"}]}]}
    result = call("debug", {"env": "test", "request": draft})
    assert result["status"] == "passed" and len(result["steps"][0]["assertions"]) == 2
    saved = call("save-case", draft)
    cli("update-case", "--case", saved["id"], "--json", '{"status":"reviewed"}')
    cli("write-api-suite", "--project", pid, "--reviewed-only")
    run = cli("run-api-suite", "--project", pid, "--env", "test", "--case-ids", json.dumps([saved["id"]]))
    assert run["passed"] == 1
    detail = cli("run-detail", "--run", run["run_id"])
    assert detail["results"][0]["api_trace"]["steps"][0]["assertions"] == result["steps"][0]["assertions"]
    assert detail["results"][0]["api_trace"]["snapshot"]["revision"] == 1
    # Re-reviewing an edited draft must not make the old compiled request executable.
    edited = call("save-case", {**draft, "id": saved["id"], "title": "健康检查-修改后"})
    cli("update-case", "--case", edited["id"], "--json", '{"status":"reviewed"}')
    error = cli("run-api-suite", "--project", pid, "--env", "test", "--case-ids", json.dumps([saved["id"]]), ok=False)
    assert "脚本版本已过期" in error
    with _store_context(db) as store:
        with pytest.raises(ValueError, match="生产环境"):
            ws.debug(store, pid, "prod", draft)


class _store_context:
    def __init__(self, path): self.store = Store(path)
    def __enter__(self): return self.store
    def __exit__(self, *_): self.store.close()


@pytest.mark.parametrize('as_json', [True, False])
def test_large_responses_preserve_complete_redacted_content(as_json):
    payload = '完整响应' * 20000 + 'END-OF-RESPONSE'
    def handle(request):
        if as_json:
            return httpx.Response(200, json={'data': payload, 'token': 'private-response-token'})
        return httpx.Response(200, text=payload + '\ntoken=private-response-token')

    with httpx.Client(base_url='https://test', transport=httpx.MockTransport(handle)) as client:
        result = execute_case({'steps': [{'method': 'GET', 'path': '/large'}]}, client, {}, {}, lambda _: '')
    response = result['steps'][0]['response']
    assert response['size_bytes'] > 65536
    assert response['truncated'] is False
    assert payload in (response['body']['data'] if as_json else response['body'])
    assert 'private-response-token' not in json.dumps(result)


def test_selective_import_and_module_groups(catalog):
    store, p, preview = catalog
    operations = ws.openapi.parse(preview["document"]).operations
    assert len(operations) > 1
    for change, op in zip(preview["changes"], operations):
        assert change["module"] == (op.tags[0] if op.tags else "未分组")
    key = lambda d: f"{d['method']}:{d['path']}"
    chosen = preview["changes"][0]
    result = ws.import_document(store, p.id, {**preview, "selected_keys": [key(chosen)]})
    assert len(result["definitions"]) == 1
    assert key(result["definitions"][0]) == key(chosen)
    assert len(result["changes"]) == 1
    # Importing another subset must preserve the previously imported endpoint.
    other = preview["changes"][1]
    result = ws.import_document(store, p.id, {**preview, "selected_keys": [key(other)]})
    assert {key(d) for d in result["definitions"]} == {key(chosen), key(other)}
    changed = copy.deepcopy(preview)
    del changed["document"]["paths"][chosen["path"]][chosen["method"].lower()]
    changed["document"]["paths"][other["path"]][other["method"].lower()]["summary"] = "更新描述"
    # An unselected removal is not applied.
    ws.import_document(store, p.id, {**changed, "selected_keys": [key(other)]})
    before = next(d for d in ws.definitions(store, p.id) if key(d) == key(chosen))
    assert not before["removed"] and before["revision"] == 1
    removed = ws.plan(store, p.id, changed)
    assert next(c for c in removed["changes"] if key(c) == key(chosen))["module"] == before["module"]
    ws.import_document(store, p.id, {**changed, "selected_keys": [key(chosen)]})
    assert next(d for d in ws.definitions(store, p.id) if key(d) == key(chosen))["removed"]


@pytest.mark.parametrize("selection", [[], None, ["GET:/missing"], [42], "GET:/path"])
def test_invalid_import_selection_does_not_write(catalog, selection):
    store, p, preview = catalog
    with pytest.raises(ValueError):
        ws.import_document(store, p.id, {**preview, "selected_keys": selection})
    assert ws.definitions(store, p.id) == []
    assert store.conn.execute("SELECT count(*) FROM api_source").fetchone()[0] == 0


def test_default_login_precedes_requests_and_caches_token():
    from aitest.api_runtime import auth_resolver
    calls = []
    def handle(request):
        calls.append(request.url.path)
        if request.url.path == '/login':
            assert json.loads(request.content) == {'username': 'tester', 'password': 'private-password'}
            return httpx.Response(200, json={'data': {'token': 'Bearer private-token'}})
        assert request.headers['Authorization'] == 'Bearer private-token'
        return httpx.Response(200, json={})
    env = {'default_login_role': 'tester', 'auth_token': 'old-token'}
    login = {'path': '/login', 'prefix': 'Bearer ', 'token_path': 'data.token'}
    accounts = [{'role': 'tester', 'username': 'tester', 'password': 'private-password'}]
    with httpx.Client(base_url='http://test', transport=httpx.MockTransport(handle)) as client:
        resolver = auth_resolver(client, env, login, accounts)
        result = execute_case({'steps': [
            {'method': 'GET', 'path': '/first', 'expected_status': [200]},
            {'method': 'GET', 'path': '/second', 'expected_status': [200]},
        ]}, client, env, {}, resolver)
    assert result['status'] == 'passed'
    assert calls == ['/login', '/first', '/second']
    assert 'private-token' not in json.dumps(result)


@pytest.mark.parametrize('token', [None, '', 'null', 'undefined', {}, 123])
def test_invalid_login_token_stops_business_request(token):
    from aitest.api_runtime import auth_resolver
    calls = []
    def handle(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={'data': {'token': token}})
    env = {'default_login_role': 'tester'}
    with httpx.Client(base_url='http://test', transport=httpx.MockTransport(handle)) as client:
        resolver = auth_resolver(client, env, {'path': '/login'}, [{'role': 'tester', 'username': 'user', 'password': 'pw'}])
        result = execute_case({'steps': [{'method': 'GET', 'path': '/business', 'expected_status': [200]}]}, client, env, {}, resolver)
    assert calls == ['/login']
    assert result['status'] != 'passed'


def test_public_requests_skip_login_and_explicit_role_wins():
    from aitest.api_runtime import auth_resolver
    headers = []
    def handle(request):
        headers.append(request.headers.get('Authorization'))
        return httpx.Response(200, json={})
    env = {'default_login_role': 'tester', 'auth_token': 'environment-token'}
    with httpx.Client(base_url='http://test', transport=httpx.MockTransport(handle)) as client:
        resolver = auth_resolver(client, env, tokens={'tester': 'default-role-token', 'other': 'other-role-token'})
        result = execute_case({'steps': [
            {'method': 'GET', 'path': '/public', 'auth': False, 'expected_status': [200]},
            {'method': 'GET', 'path': '/other', 'role': 'other', 'expected_status': [200]},
        ]}, client, env, {}, resolver)
    assert result['status'] == 'passed'
    assert headers == [None, 'other-role-token']


def test_login_client_id_follows_role_token_without_duplicate_headers():
    from aitest.api_runtime import auth_resolver
    calls = []
    def handle(request):
        calls.append(request.url.path)
        if request.url.path == '/login':
            body = json.loads(request.content)
            return httpx.Response(200, json={'data': {'token': body['username'] + '-token'}})
        assert request.headers.get_list('clientid') == ['web-client']
        assert request.headers['Authorization'] == 'Bearer user-token'
        return httpx.Response(200, json={'code': 200})
    env = {'default_login_role': 'tester', 'api_crypto': {'headers': {'ClientId': 'stale-client'}}}
    with httpx.Client(base_url='http://test', transport=httpx.MockTransport(handle)) as client:
        resolver = auth_resolver(client, env, {'path': '/login', 'body': {'username': '${username}', 'password': '${password}', 'clientId': 'web-client'}},
                                 [{'role': 'tester', 'username': 'user', 'password': 'pw'}])
        case = {'steps': [{'method': 'GET', 'path': '/business', 'headers': {'CLIENTID': 'wrong'}, 'expected_status': [200]}]}
        assert execute_case(case, client, env, {}, resolver)['status'] == 'passed'
        assert execute_case(case, client, env, {}, resolver)['status'] == 'passed'
    assert calls == ['/login', '/business', '/business']
    assert env['api_crypto']['headers'] == {'ClientId': 'stale-client'}


def test_batch_generation_limits_scope_and_deduplicates(catalog):
    store, p, preview = catalog
    definitions = ws.import_document(store, p.id, preview)["definitions"]
    chosen = definitions[:2]
    assert len(chosen) == 2 and len(definitions) > 2
    ids = [d["id"] for d in chosen]
    result = ws.generate_cases(store, p.id, ids + ids)
    generated = [store.get_case(i) for i in result["case_ids"]]
    assert result["generated"] == len(generated) > 0
    assert {c.api.definition_id for c in generated} == set(ids)
    assert all(c.status == "draft" for c in generated)
    again = ws.generate_cases(store, p.id, ids)
    assert again["generated"] == 0 and again["skipped"] == len(generated)
    before = len(store.list_cases(p.id))
    with pytest.raises(ValueError, match="有效的接口"):
        ws.generate_cases(store, p.id, ids + ["missing"])
    assert len(store.list_cases(p.id)) == before


def test_batch_selected_identity_authenticates_unbound_requests_and_keeps_explicit_roles():
    from aitest.api_runtime import auth_resolver
    headers = []
    def handle(request):
        headers.append(request.headers.get('Authorization'))
        return httpx.Response(200, json={})
    env = {'selected_role': 'operator', 'default_login_role': 'tester', 'auth_token': 'environment-token'}
    steps = [
        {'method': 'GET', 'path': '/generated', 'auth': False, 'expected_status': [200]},
        {'method': 'GET', 'path': '/default', 'expected_status': [200]},
        {'method': 'GET', 'path': '/explicit', 'role': 'other', 'expected_status': [200]},
    ]
    with httpx.Client(base_url='http://test', transport=httpx.MockTransport(handle)) as client:
        resolver = auth_resolver(client, env, tokens={'operator': 'selected-token', 'other': 'other-token'})
        result = execute_case({'steps': steps}, client, env, {}, resolver)
    assert result['status'] == 'passed'
    assert headers == ['selected-token', 'selected-token', 'other-token']
    assert [step['role'] for step in result['steps']] == ['operator', 'operator', 'other']
    assert steps[0]['auth'] is False and 'role' not in steps[0]
    assert 'selected-token' not in json.dumps(result)
