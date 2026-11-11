"""轻量 JSON Schema 校验（无额外依赖）。

覆盖用例 JSON 校验与接口响应断言常用的子集：type / required / properties /
additionalProperties / items / enum / const / min/maxLength / minimum / maximum /
pattern / min/maxItems / anyOf / oneOf / allOf / nullable。生成的 pytest 脚本也会
内联引用本模块，因此保持纯标准库实现。
"""

from __future__ import annotations

import json
import re
from importlib import resources
from typing import Any

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "null": type(None),
}


def _is_type(value: Any, t: str) -> bool:
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    py = _TYPES.get(t)
    return py is not None and isinstance(value, py)


def validate(value: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """返回错误列表，空列表表示通过。"""
    errors: list[str] = []
    if not isinstance(schema, dict) or not schema:
        return errors

    if value is None and schema.get("nullable"):
        return errors

    for key in ("allOf",):
        for sub in schema.get(key, []):
            errors += validate(value, sub, path)
    if "anyOf" in schema:
        if all(validate(value, s, path) for s in schema["anyOf"]):
            errors.append(f"{path}: 不满足 anyOf 中任一 schema")
    if "oneOf" in schema:
        ok = sum(1 for s in schema["oneOf"] if not validate(value, s, path))
        if ok != 1:
            errors.append(f"{path}: oneOf 匹配 {ok} 个 schema（应为 1）")

    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_is_type(value, x) for x in types):
            errors.append(f"{path}: 类型应为 {'/'.join(types)}，实际为 {type(value).__name__}")
            return errors

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: 值 {value!r} 不在枚举 {schema['enum']} 中")
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: 值应为 {schema['const']!r}")

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: 长度小于 {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: 长度大于 {schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: 不匹配 pattern {schema['pattern']}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: 小于最小值 {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: 大于最大值 {schema['maximum']}")

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: 元素数少于 {schema['minItems']}")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: 元素数多于 {schema['maxItems']}")
        if isinstance(schema.get("items"), dict):
            for i, item in enumerate(value):
                errors += validate(item, schema["items"], f"{path}[{i}]")

    if isinstance(value, dict):
        for req in schema.get("required", []):
            if req not in value:
                errors.append(f"{path}: 缺少必填字段 {req}")
        props = schema.get("properties", {})
        for k, v in value.items():
            if k in props:
                errors += validate(v, props[k], f"{path}.{k}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: 不允许的字段 {k}")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors += validate(v, schema["additionalProperties"], f"{path}.{k}")

    return errors


def load_schema(name: str) -> dict[str, Any]:
    text = resources.files("aitest").joinpath("schemas", name).read_text(encoding="utf-8")
    return json.loads(text)


def validate_case(case: dict[str, Any], *, partial: bool = False) -> list[str]:
    schema = load_schema("testcase.schema.json")
    if partial:
        schema.pop("required", None)
    errors = validate(case, schema)
    if isinstance(case.get("title"), str) and not case["title"].strip():
        errors = [e for e in errors if e != "$.title: 长度小于 1"]
        errors.append("$.title: 用例标题不能为空，请填写「模块-场景」")
    return errors
