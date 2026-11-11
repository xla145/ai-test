# 由 AIProbe 生成：数据驱动接口测试，用例数据见 data/{{SUITE}}.json
# 用例 ID：
{{CASE_IDS}}
import json
from pathlib import Path

import pytest

from _aitest_api import execute

CASES = json.loads((Path(__file__).parent / "data" / "{{SUITE}}.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["case_id"] for c in CASES])
def test_api(case, api_client, aitest_env, shared_vars, role_auth):
    if case.get("steps"):
        # 流程用例：按顺序执行，每步可用不同角色（如 买家下单 → 买家支付 → 运营审核 → 买家退款）
        for i, step in enumerate(case["steps"], 1):
            label = f"第 {i} 步「{step.get('name') or step['method'] + ' ' + step['path']}」"
            if step.get("role"):
                label += f"（角色：{step['role']}）"
            execute(step, api_client, aitest_env, shared_vars, role_auth, label)
    else:
        execute(case, api_client, aitest_env, shared_vars, role_auth,
                f"角色：{case['role']}" if case.get("role") else "")
