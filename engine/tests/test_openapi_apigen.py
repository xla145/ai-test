import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
import yaml

from aitest.apigen import generate_suite, sample_value, write_pytest_suite
from aitest.openapi import parse_openapi
from aitest.schema import validate, validate_case


@pytest.fixture
def spec_server(openapi_path):
    document = openapi_path.read_text(encoding="utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/spec.yaml")
                self.end_headers()
                return
            content = {
                "/spec.yaml": document,
                "/spec.json": json.dumps(yaml.safe_load(document)),
                "/swagger.json": json.dumps({"swagger": "2.0", "info": {"title": "Swagger"}, "paths": {}}),
                "/ui": "<html>Swagger UI</html>",
                "/invalid": "openapi: [invalid",
            }.get(self.path)
            self.send_response(200 if content is not None else 404)
            self.end_headers()
            self.wfile.write((content or "Not found").encode("utf-8"))

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("path", ["/spec.yaml", "/spec.json", "/redirect"])
def test_import_url_matches_file(spec_server, openapi_path, path):
    remote = parse_openapi(f"{spec_server}{path}")
    local = parse_openapi(openapi_path)
    assert remote == local
    assert [c.title for c in generate_suite(remote)] == [c.title for c in generate_suite(local)]


def test_import_swagger_url(spec_server):
    assert parse_openapi(f"{spec_server}/swagger.json").title == "Swagger"


@pytest.mark.parametrize("path, message", [
    ("/missing", "HTTP 404"),
    ("/ui", "而非 Swagger UI 页面"),
    ("/invalid", "内容无法解析"),
])
def test_import_url_errors(spec_server, path, message):
    with pytest.raises(ValueError, match=message):
        parse_openapi(f"{spec_server}{path}")


def test_import_url_timeout(monkeypatch):
    def timeout(*args, **kwargs):
        raise httpx.ReadTimeout("timed out")

    monkeypatch.setattr(httpx, "get", timeout)
    with pytest.raises(ValueError, match="无法读取 OpenAPI 地址"):
        parse_openapi("https://example.com/openapi.json")


def test_import_json_file(tmp_path, openapi_path):
    target = tmp_path / "openapi.json"
    target.write_text(json.dumps(yaml.safe_load(openapi_path.read_text(encoding="utf-8"))), encoding="utf-8")
    assert parse_openapi(str(target)) == parse_openapi(openapi_path)


def test_parse(openapi_path):
    doc = parse_openapi(openapi_path)
    ops = {o.operation_id: o for o in doc.operations}
    assert set(ops) == {"listUsers", "createUser", "deleteUser", "health"}
    assert ops["createUser"].success_status == 201
    assert ops["createUser"].body_schema["required"] == ["name", "age"]
    assert ops["deleteUser"].params[0].location == "path"
    assert ops["listUsers"].secured and not ops["health"].secured
    assert ops["listUsers"].success_schema["items"]["required"] == ["id", "name", "age"]


def test_sample_value_respects_constraints():
    v = sample_value({"type": "object", "required": ["name", "age"], "properties": {
        "name": {"type": "string", "minLength": 2, "maxLength": 4}, "age": {"type": "integer", "minimum": 18}}})
    assert v == {"name": "test", "age": 18}
    assert not validate(v, {"type": "object", "properties": {"name": {"maxLength": 4}}})


def test_generate_cases(openapi_path):
    cases = generate_suite(parse_openapi(openapi_path), "p1")
    titles = [c.title for c in cases]
    assert "用户-创建用户-正向" in titles
    assert "用户-创建用户-缺少必填字段name" in titles
    assert "用户-创建用户-age大于最大值" in titles
    assert "用户-用户列表-缺少必填参数limit" in titles
    assert "用户-用户列表-未鉴权" in titles
    assert "用户-删除用户-重复调用幂等" in titles
    assert not any("健康检查-未鉴权" in t for t in titles)
    for c in cases:
        assert validate_case(c.to_dict()) == [], c.title
    over = next(c for c in cases if c.title == "用户-创建用户-age大于最大值")
    assert over.api.body["age"] == 151 and over.api.expected_status == [400]


def test_write_suite(tmp_path, openapi_path):
    cases = generate_suite(parse_openapi(openapi_path))
    files = write_pytest_suite(cases, tmp_path / "api")
    data = json.loads(open(files["data"], encoding="utf-8").read())
    assert len(data) == len(cases) == files["cases"]
    test_src = open(files["test"], encoding="utf-8").read()
    assert cases[0].id in test_src  # 文件头注释包含用例 ID
    assert (tmp_path / "api" / "_aitest_schema.py").exists()
