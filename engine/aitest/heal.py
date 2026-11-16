"""脚本自愈建议（第 7 节）。

失败 → agent 读 trace 和截图 → 判断类型 → 页面改版则生成脚本 diff → 用户确认后合并。
产品缺陷不自动改脚本：这里拒绝 failure_type=product_bug 的修改建议。
所有合并以 git commit 形式落在 workspace，可回滚。
"""

from __future__ import annotations

import difflib
from pathlib import Path

from . import workspace
from .models import FailureType, HealProposal, ProposalStatus, Script
from .store import Store
from .heal_risk import assess


class HealError(ValueError):
    pass


def _resolve_in_workspace(workspace_path: str, script_path: str) -> Path:
    root = Path(workspace_path).resolve()
    p = (root / script_path).resolve()
    if root != p and root not in p.parents:
        raise HealError(f"脚本路径不在 workspace 内：{script_path}")
    return p


def propose(store: Store, workspace_path: str, case_id: str, script_path: str, proposed: str,
            reason: str = "", failure_type: str = FailureType.SCRIPT_ERROR.value, run_id: str = "") -> HealProposal:
    if failure_type == FailureType.PRODUCT_BUG.value:
        raise HealError("产品缺陷不修改脚本，请改为提交缺陷")
    if failure_type != FailureType.SCRIPT_ERROR.value:
        raise HealError("仅脚本错误可提出修复；环境、数据、认证、模型和未知失败应先处理原因")
    path = _resolve_in_workspace(workspace_path, script_path)
    original = path.read_text(encoding="utf-8") if path.exists() else ""
    if original == proposed:
        raise HealError("修改建议与当前脚本相同")
    rel = str(path.relative_to(Path(workspace_path).resolve()))
    diff = "".join(difflib.unified_diff(original.splitlines(keepends=True), proposed.splitlines(keepends=True),
                                        fromfile=f"a/{rel}", tofile=f"b/{rel}"))
    risk, reasons = assess(original, proposed)
    return store.save_proposal(HealProposal(case_id=case_id, script_path=rel, original=original, proposed=proposed,
                                            diff=diff, reason=reason, failure_type=failure_type, run_id=run_id,
                                            risk_level=risk, risk_reasons=reasons))


def resolve(store: Store, workspace_path: str, proposal_id: str, accept: bool) -> HealProposal:
    p = store.get_proposal(proposal_id)
    if p is None:
        raise HealError(f"修改建议不存在：{proposal_id}")
    if p.status != ProposalStatus.PENDING.value:
        raise HealError(f"修改建议已处理：{p.status}")
    if not accept:
        p.status = ProposalStatus.REJECTED.value
        return store.save_proposal(p)
    path = _resolve_in_workspace(workspace_path, p.script_path)
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    if current != p.original:
        raise HealError("脚本在生成建议后已被修改，请重新生成修改建议")
    if assess(p.original, p.proposed)[0] == "high":
        raise HealError("高风险修改禁止直接合并：请先澄清用例、审核步骤和预期，再重新生成脚本")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(p.proposed, encoding="utf-8")
    p.commit = workspace.commit(workspace_path, f"自愈：{p.case_id} {p.reason}".strip()) or ""
    p.status = ProposalStatus.ACCEPTED.value
    framework = "playwright" if p.script_path.endswith((".ts", ".js")) else "pytest"
    store.upsert_script(Script(case_id=p.case_id, path=p.script_path, framework=framework, version=p.commit))
    return store.save_proposal(p)
