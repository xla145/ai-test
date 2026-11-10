import json

from aitest.apigen import generate_suite, sample_value, write_pytest_suite
from aitest.openapi import parse_openapi
from aitest.schema import validate, validate_case


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
