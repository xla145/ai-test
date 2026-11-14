"""在收集结束、fixture 和请求执行之前按用例 ID 限定回归范围。"""

import json
import os

import pytest


def pytest_collection_modifyitems(config, items):
    selected = json.loads(os.environ.get("AITEST_SELECTED_CASE_IDS") or "null")
    requested = set(selected) if selected is not None else None
    revisions = json.loads(os.environ.get("AITEST_API_REVISIONS") or "{}")
    kept, deselected, found = [], [], set()
    for item in items:
        case = getattr(getattr(item, "callspec", None), "params", {}).get("case")
        case_id = case.get("case_id") if isinstance(case, dict) else None
        if requested is None or case_id in requested:
            if case_id in revisions and case.get("revision") != revisions[case_id]:
                raise pytest.UsageError(f"用例 {case_id} 的脚本版本已过期，请重新生成已审核脚本")
            kept.append(item)
            found.add(case_id)
        else:
            deselected.append(item)
    missing = (requested or set()) - found
    if missing:
        raise pytest.UsageError("以下用例缺少已生成的脚本，请先生成已审核脚本：" + ", ".join(sorted(missing)))
    items[:] = kept
    config.hook.pytest_deselected(items=deselected)
