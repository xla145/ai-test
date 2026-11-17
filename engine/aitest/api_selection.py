"""接口回归范围校验与 workspace 内可共享的测试集。"""

import json
import os
import tempfile
from pathlib import Path

from . import linter


def parse_ids(value):
    ids = json.loads(value)
    if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or not i.strip() for i in ids):
        raise ValueError("请至少选择一条接口用例（用例 ID 数组不能为空）")
    return list(dict.fromkeys(ids))


def validate_selection(store, project_id, ids):
    issues = store.list_lint_issues()
    for case_id in ids:
        case = store.get_case(case_id)
        if case is None or case.project_id != project_id:
            raise ValueError(f"用例不存在或不属于当前项目：{case_id}")
        if (case.api_needs_review or case.status != "reviewed" or case.lint_status == "blocked" or case.execution_mode != "api" or not case.is_api_executable
                or not linter.can_generate_script(case, issues)):
            raise ValueError(f"用例未审核、不可执行或存在阻断问题，请重新选择：{case_id}")


def validate_run_auth(cases, selected_role, env_config, tokens, accounts, has_env_token=False):
    """Check every required identity before any business request is sent."""
    login = env_config.get("api_login") or {}
    roles = set()
    for case in cases:
        steps = (case.api_flow or ([case.api] if case.api else [])) + case.api_cleanup
        for step in steps:
            override = selected_role if not step.role else None
            if not override and not step.auth:
                continue
            role = step.role or override or login.get("default_role")
            if role:
                roles.add(role)
    account_map = {a.get("role"): a for a in accounts}
    errors = []
    for role in sorted(roles):
        if not selected_role and has_env_token:
            continue
        if isinstance(tokens.get(role), str) and tokens[role].strip():
            continue
        account = account_map.get(role) or {}
        if not account.get("username") or not account.get("password"):
            errors.append(f"角色「{role}」缺少接口 token 或完整账号密码")
        elif not login.get("path"):
            errors.append(f"角色「{role}」仅有账号密码，但当前环境未配置接口登录")
    if errors:
        raise ValueError("执行前鉴权检查未通过：" + "；".join(errors) + "。请在角色账号或当前环境的接口登录中补齐配置。")


def list_sets(workspace):
    path = Path(workspace) / "api-test-sets.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def save_set(workspace, name, ids):
    name = name.strip()
    if not name or len(name) > 100:
        raise ValueError("测试集名称需为 1–100 个字符")
    entry = {"name": name, "case_ids": ids}
    sets = [s for s in list_sets(workspace) if s["name"] != name] + [entry]
    path = Path(workspace) / "api-test-sets.json"
    fd, temp = tempfile.mkstemp(dir=path.parent, suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(sets, f, ensure_ascii=False, indent=2)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)
    return entry
