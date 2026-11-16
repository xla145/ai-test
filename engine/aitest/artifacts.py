"""执行前冻结的测试来源；报告只读快照，不能用当前文件补写历史版本。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def api_snapshot(store, project, env: str, env_config: dict, case_ids: set[str]) -> dict[str, dict]:
    root = Path(project.workspace_path).resolve()
    scripts = {s.case_id: s for s in store.list_scripts() if s.framework == "pytest"}
    snapshot = {}
    for case in store.list_cases(project.id, execution_mode="api"):
        if case.id not in case_ids:
            continue
        script = scripts.get(case.id)
        script_hash = None
        if script:
            path = (root / script.path).resolve()
            if path.is_relative_to(root) and path.is_file():
                script_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        snapshot[case.id] = {
            "schema_version": 1, "project_id": project.id, "case_id": case.id, "env": env,
            "case_revision": fingerprint(case.to_dict()), "api_revision": case.api_revision,
            "source_revision": [{"definition_id": step.definition_id, "revision": step.definition_revision}
                                for step in ([case.api] if case.api else []) + case.api_flow + case.api_cleanup
                                if step.definition_id],
            "script_hash": script_hash, "script_path": script.path if script else None,
            "environment_fingerprint": fingerprint(env_config),
        }
    return snapshot
