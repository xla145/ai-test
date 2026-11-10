"""OpenAPI / Swagger 解析（第 8 节）：提取接口、参数类型与约束、状态码。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")


@dataclass
class Param:
    name: str
    location: str  # path / query / header / cookie
    required: bool
    schema: dict[str, Any]


@dataclass
class Operation:
    method: str
    path: str
    operation_id: str
    summary: str
    params: list[Param] = field(default_factory=list)
    body_schema: dict[str, Any] | None = None
    body_required: bool = False
    responses: dict[str, dict[str, Any] | None] = field(default_factory=dict)
    secured: bool = False
    tags: list[str] = field(default_factory=list)

    @property
    def success_status(self) -> int:
        codes = sorted(int(c) for c in self.responses if c.isdigit() and c.startswith("2"))
        return codes[0] if codes else 200

    @property
    def success_schema(self) -> dict[str, Any] | None:
        return self.responses.get(str(self.success_status))


@dataclass
class ApiDoc:
    title: str
    version: str
    servers: list[str]
    operations: list[Operation]


def load(path_or_text: str | Path) -> dict[str, Any]:
    p = Path(str(path_or_text))
    text = p.read_text(encoding="utf-8") if len(str(path_or_text)) < 4096 and p.exists() else str(path_or_text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return yaml.safe_load(text)


class _Resolver:
    def __init__(self, root: dict[str, Any]):
        self.root = root

    def resolve(self, node: Any, depth: int = 0) -> Any:
        if depth > 20:
            return {}
        if isinstance(node, dict):
            if "$ref" in node and isinstance(node["$ref"], str) and node["$ref"].startswith("#/"):
                target: Any = self.root
                for part in node["$ref"][2:].split("/"):
                    target = target.get(part.replace("~1", "/").replace("~0", "~"), {})
                return self.resolve(target, depth + 1)
            return {k: self.resolve(v, depth + 1) for k, v in node.items()}
        if isinstance(node, list):
            return [self.resolve(v, depth + 1) for v in node]
        return node


def _response_schema(resp: dict[str, Any], is_v2: bool) -> dict[str, Any] | None:
    if is_v2:
        return resp.get("schema")
    content = resp.get("content") or {}
    for mime, body in content.items():
        if "json" in mime:
            return (body or {}).get("schema")
    return None


def parse(spec: dict[str, Any]) -> ApiDoc:
    r = _Resolver(spec)
    is_v2 = str(spec.get("swagger", "")).startswith("2")
    info = spec.get("info", {})
    if is_v2:
        scheme = (spec.get("schemes") or ["http"])[0]
        servers = [f"{scheme}://{spec['host']}{spec.get('basePath', '')}"] if spec.get("host") else []
    else:
        servers = [s.get("url", "") for s in spec.get("servers", [])]
    global_security = bool(spec.get("security"))

    ops: list[Operation] = []
    for path, item in (spec.get("paths") or {}).items():
        item = r.resolve(item)
        shared_params = item.get("parameters", [])
        for method in HTTP_METHODS:
            if method not in item:
                continue
            raw = item[method]
            params: list[Param] = []
            body_schema = None
            body_required = False
            for p in [*shared_params, *raw.get("parameters", [])]:
                if p.get("in") == "body":  # swagger 2
                    body_schema = p.get("schema", {})
                    body_required = bool(p.get("required"))
                    continue
                if p.get("in") == "formData":
                    continue
                schema = p.get("schema") or {k: v for k, v in p.items() if k in (
                    "type", "format", "enum", "minimum", "maximum", "minLength", "maxLength", "pattern", "items")}
                params.append(Param(p["name"], p.get("in", "query"), bool(p.get("required")) or p.get("in") == "path", schema))
            if "requestBody" in raw:
                rb = raw["requestBody"]
                body_required = bool(rb.get("required"))
                for mime, c in (rb.get("content") or {}).items():
                    if "json" in mime:
                        body_schema = (c or {}).get("schema")
                        break
            responses = {str(code): _response_schema(resp or {}, is_v2) for code, resp in (raw.get("responses") or {}).items()}
            secured = bool(raw["security"]) if "security" in raw else global_security
            op_id = raw.get("operationId") or f"{method}_{path.strip('/').replace('/', '_').replace('{', '').replace('}', '')}"
            ops.append(Operation(method.upper(), path, op_id, raw.get("summary", ""), params, body_schema,
                                 body_required, responses, secured, raw.get("tags", [])))
    return ApiDoc(info.get("title", ""), str(info.get("version", "")), servers, ops)


def parse_openapi(path_or_text: str | Path) -> ApiDoc:
    return parse(load(path_or_text))
