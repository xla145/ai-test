# 由 AIProbe 生成：数据驱动接口测试，用例数据见 data/{{SUITE}}.json
# 用例 ID：
{{CASE_IDS}}
import json
import os
import re
from pathlib import Path

import pytest

from _aitest_api import execute_case

CASES = json.loads((Path(__file__).parent / "data" / "{{SUITE}}.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["case_id"] for c in CASES])
def test_api(case, api_client, aitest_env, shared_vars, role_auth):
    result = execute_case(case, api_client, aitest_env, shared_vars, role_auth)
    result["snapshot"] = case
    from _aitest_api import redact
    if os.environ.get("AITEST_TRACE_DIR"):
        path = Path(os.environ["AITEST_TRACE_DIR"])
        path.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^a-zA-Z0-9_-]", "_", case["case_id"])
        (path / f"{name}.json").write_text(json.dumps(redact(result), ensure_ascii=False), encoding="utf-8")
    failures = [s for s in [*result["steps"], *result["cleanup"]] if s["status"] in ("failed", "error")]
    if failures:
        message = "；".join(f"第 {s['index']} 步「{s['name']}」：{s.get('error', '执行失败')}" for s in failures)
        if result["status"] == "error":
            raise RuntimeError(message)
        pytest.fail(message, pytrace=False)
