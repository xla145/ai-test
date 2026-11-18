"""需求、用例、声明的断言映射与历史执行之间的可审查关联。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .artifacts import fingerprint
from .hierarchy import effective_environments


def _read(root: Path, relative: str):
    try:
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file() or path.stat().st_size > 5_000_000:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None


def coverage(store, project_id: str, env: str = "") -> dict:
    project = store.get_project(project_id)
    if not project:
        raise ValueError("项目不存在")
    root = Path(project.workspace_path).resolve()
    cases = store.list_cases(project_id)
    environments = effective_environments(store, project)
    scripts = {s.case_id: s for s in store.list_scripts()}
    latest = {}
    query = "SELECT rr.*, r.started_at, r.env FROM run_result rr JOIN run r ON r.id=rr.run_id WHERE r.project_id=?"
    args = [project_id]
    if env:
        query += " AND r.env=?"
        args.append(env)
    for row in store.conn.execute(query + " ORDER BY r.started_at DESC, r.rowid DESC", args):
        latest.setdefault(row["case_id"], dict(row))
    proposals = {p.case_id for p in store.list_proposals("pending", project_id=project_id)}
    rows = []
    for case in cases:
        script = scripts.get(case.id)
        code = _read(root, script.path) if script else None
        meta = {}
        if script and script.path.endswith(".spec.ts"):
            try:
                meta = json.loads(_read(root, script.path[:-8] + ".steps.json") or "{}")
            except ValueError:
                pass
        if not isinstance(meta, dict):
            meta = {}
        steps = meta.get("steps", [])
        if not isinstance(steps, list):
            steps = []
        steps = [s for s in steps if isinstance(s, dict)]
        targets = []
        if case.is_api_executable:
            for index, request in enumerate(([case.api] if case.api else []) + list(case.api_flow), 1):
                from dataclasses import asdict
                revision = fingerprint(asdict(request))
                prefix = f"request-{index}"
                targets.append({"id": prefix, "action": "request", "label": f"请求 {index} · {request.method} {request.path}", "revision": revision, "role": request.role})
                declarations = ([('status', request.expected_status)] if request.expected_status else [])
                declarations += [(f"field:{key}", value) for key, value in request.expected_fields.items()]
                declarations += [(f"assertion:{i}", value) for i, value in enumerate(request.assertions, 1)]
                declarations += [(f"db:{i}", value) for i, value in enumerate(request.db_checks, 1)]
                if request.response_schema:
                    declarations.append(("schema", request.response_schema))
                for key, declaration in declarations:
                    targets.append({"id": f"{prefix}:{key}", "action": "expectApi", "label": f"请求 {index} · {key}", "definition": declaration, "revision": revision, "role": request.role})
        source_revision = fingerprint({key: getattr(case, key) for key in ("steps", "expected", "preconditions")})
        blockers = []
        if case.status != "reviewed":
            blockers.append("用例尚未审核" if case.status != "deprecated" else "用例已废弃")
        if case.lint_status == "blocked":
            blockers.append("规范检查阻断")
        if code is None:
            blockers.append("缺少可读取的脚本")
        script_hash = hashlib.sha256(code.encode()).hexdigest() if code is not None else None
        if meta and meta.get("specHash") != script_hash:
            blockers.append("脚本与结构化步骤不同步")
        source = meta.get("source", {}) if isinstance(meta, dict) else {}
        if not isinstance(source, dict):
            source = {}
        if source and any(source.get(k, []) != getattr(case, k) for k in ("steps", "expected", "preconditions")):
            blockers.append("生成时的用例已过期")
        mappings = []
        for field, label, key in [("steps", "步骤", "caseStep"), ("expected", "预期", "expectedIndices"), ("preconditions", "前置条件", "preconditionIndices")]:
            for index, text in enumerate(getattr(case, field), 1):
                matches = [s for s in steps if (s.get(key) == index if key == "caseStep" else
                    isinstance(s.get(key), list) and index in s[key] and (str(s.get("action", "")).startswith("expect") or s.get("action") == "visualCheck"))]
                if targets:
                    links = [link for link in case.coverage_links if isinstance(link, dict) and link.get("kind") == field and link.get("index") == index and link.get("source_revision") == source_revision]
                    matches = [target for target in targets if (target["action"] == "request" if field == "steps" else target["action"] == "expectApi") and any(link.get("target") == target["id"] and link.get("target_revision") == target["revision"] for link in links)]
                mappings.append({"kind": field, "label": label, "index": index, "text": text,
                                 "assertions": [{"id": s.get("id"), "action": s.get("action"), "role": s.get("role"), "definition": s.get("assertions", [])} for s in matches],
                                 "mapped": bool(matches)})
        if any(not m["mapped"] for m in mappings):
            blockers.append("原始步骤、预期或前置条件存在未关联项")
        if case.id in proposals:
            blockers.append("有待审核的自愈修改")
        result = latest.get(case.id)
        try:
            context = json.loads(result["execution_context"] or "{}") if result else {}
            artifact = context.get("artifact", {}) if isinstance(context, dict) else {}
            if not isinstance(artifact, dict):
                artifact = {}
        except (ValueError, TypeError):
            artifact = {}
        if not result:
            blockers.append("尚未执行")
        elif result["status"] != "passed":
            blockers.append("最近执行未通过")
        elif not artifact or artifact.get("script_hash") != script_hash:
            blockers.append("最近执行缺少当前脚本的版本证据")
        if artifact.get("api_revision") and artifact["api_revision"] != case.api_revision:
            blockers.append("接口执行版本已过期")
        if result and artifact:
            config = environments.get(result["env"])
            expected_fingerprints = {fingerprint(config), hashlib.sha256(json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()}
            if config is None or artifact.get("environment_fingerprint") not in expected_fingerprints:
                blockers.append("执行环境已变化或缺少环境版本证据")
        status = "deprecated" if case.status == "deprecated" else "draft" if case.status != "reviewed" else "ready"
        if case.lint_status == "blocked" and status != "deprecated":
            status = "needs_clarification"
        if code is not None and status == "ready":
            status = "generated"
        if result and result["status"] == "passed" and not blockers:
            status = "validated"
        rows.append({"case_id": case.id, "title": case.title, "mode": case.execution_mode,
                     "requirement_ids": case.requirement_ids, "owner": case.owner, "lifecycle": status,
                     "coverage_links": case.coverage_links, "mapping_source_revision": source_revision, "mapping_targets": targets,
                     "script": {"path": script.path, "hash": script_hash} if script else None,
                     "mappings": mappings, "blockers": blockers, "latest_run":
                     {k: result[k] for k in ("run_id", "env", "status", "started_at")} if result else None})
    requirements = [{"id": r.id, "section": r.section, "content": r.content, "source_file": r.source_file,
                     "revision": fingerprint(r.content), "case_ids": [c.id for c in cases if r.id in c.requirement_ids]}
                    for r in store.list_requirements(project_id)]
    return {"schema_version": 1, "project_id": project_id, "env": env, "requirements": requirements,
            "cases": rows, "summary": {"requirements": len(requirements),
              "uncovered_requirements": sum(not r["case_ids"] for r in requirements),
              "cases": len(rows), "blocked_cases": sum(bool(r["blockers"]) for r in rows if r["lifecycle"] != "deprecated"),
              "mapped": sum(m["mapped"] for r in rows for m in r["mappings"]),
              "total": sum(len(r["mappings"]) for r in rows)}}
