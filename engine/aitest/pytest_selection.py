"""在收集结束、fixture 和请求执行之前按用例 ID 限定回归范围。"""

import json
import os

import pytest


def pytest_collection_modifyitems(config, items):
    requested = set(json.loads(os.environ["AITEST_SELECTED_CASE_IDS"]))
    kept, deselected, found = [], [], set()
    for item in items:
        case = getattr(getattr(item, "callspec", None), "params", {}).get("case")
        case_id = case.get("case_id") if isinstance(case, dict) else None
        if case_id in requested:
            kept.append(item)
            found.add(case_id)
        else:
            deselected.append(item)
    missing = requested - found
    if missing:
        raise pytest.UsageError("以下用例缺少已生成的脚本，请先生成已审核脚本：" + ", ".join(sorted(missing)))
    items[:] = kept
    config.hook.pytest_deselected(items=deselected)
