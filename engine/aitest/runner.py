"""回归执行与报告（第 6、8 节）。

回归由编排层直接调度 pytest，不经过 Codex、不消耗模型；只有失败用例才交给 agent 归因。
这里先做确定性的初步归因（环境问题 / 疑似产品缺陷 / 待 agent 判定）。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import FailureType, Run, RunMode, RunResult

_ID_RE = re.compile(r"\[(.+)\]$")
_ENV_PATTERNS = re.compile(
    r"(ConnectError|ConnectTimeout|ReadTimeout|Name or service not known|Connection refused|net::ERR_|未设置 AITEST_BASE_URL"
    # 移动端：设备未连接、App 未安装（Maestro / adb）
    r"|[Nn]o devices? (found|connected)|[Dd]evice .{0,40}not (found|connected)|device offline|[Aa]pp .{0,60}not installed"
    r"|[Uu]nable to launch app)")
_SERVER_ERROR = re.compile(r"状态码 5\d\d")


@dataclass
class EnvConfig:
    base_url: str
    auth_header: str = "Authorization"
    auth_token: str = ""  # 由客户端从钥匙串取出后传入，不落库
    timeout: float = 30
    # 多账号：环境的接口登录配置（不含凭据），角色账号密码由客户端以 AITEST_ROLES 注入
    api_login: dict | None = None
    api_crypto: dict | None = None

    def to_env(self) -> dict[str, str]:
        return {
            "AITEST_BASE_URL": self.base_url,
            "AITEST_API_CRYPTO": json.dumps(self.api_crypto or {}),
            "AITEST_AUTH_HEADER": self.auth_header,
            "AITEST_AUTH_TOKEN": self.auth_token,
            "AITEST_TIMEOUT": str(self.timeout),
            **({"AITEST_API_LOGIN": json.dumps(self.api_login, ensure_ascii=False)} if self.api_login else {}),
        }


def classify_failure(message: str) -> str:
    if _ENV_PATTERNS.search(message):
        return FailureType.ENVIRONMENT.value
    if _SERVER_ERROR.search(message):
        return FailureType.PRODUCT_BUG.value
    return FailureType.UNKNOWN.value  # 交给 agent 判断是接口 bug 还是用例错误


def parse_junit(xml_path: str | Path, run_id: str) -> list[RunResult]:
    root = ET.parse(str(xml_path)).getroot()
    results: list[RunResult] = []
    for tc in root.iter("testcase"):
        name = tc.get("name", "")
        m = _ID_RE.search(name)
        case_id = m.group(1) if m else f"{tc.get('classname', '')}::{name}"
        status, message = "passed", ""
        for tag in ("failure", "error", "skipped"):
            el = tc.find(tag)
            if el is not None:
                status = {"failure": "failed", "error": "error", "skipped": "skipped"}[tag]
                message = (el.get("message") or "") + "\n" + (el.text or "")
                break
        results.append(RunResult(
            run_id=run_id, case_id=case_id, status=status, duration=float(tc.get("time") or 0),
            message=message.strip()[:4000],
            failure_type=classify_failure(message) if status in ("failed", "error") else None,
        ))
    return results


def run_pytest(suite_dir: str | Path, env: EnvConfig, project_id: str = "", env_name: str = "default",
               report_dir: str | Path | None = None, extra_args: list[str] | None = None,
               timeout: float | None = None, extra_env: dict[str, str] | None = None,
               case_ids: list[str] | None = None) -> tuple[Run, list[RunResult]]:
    if case_ids is not None and not case_ids:
        raise ValueError("请至少选择一条接口用例")
    suite_dir = Path(suite_dir)
    if not suite_dir.is_dir():
        raise ValueError("尚未生成接口脚本，请先生成已审核脚本")
    run = Run(project_id=project_id, env=env_name, mode=RunMode.REGRESSION.value,
              started_at=datetime.now(timezone.utc).isoformat())
    report_dir = Path(report_dir or suite_dir / "reports")
    report_dir.mkdir(parents=True, exist_ok=True)
    junit = report_dir / f"{run.id}.xml"
    cmd = [sys.executable, "-m", "pytest", str(suite_dir), f"--junitxml={junit}", "-q", "-p", "no:cacheprovider",
           "--rootdir", str(suite_dir), *(extra_args or [])]
    proc_env = {**os.environ, **env.to_env(), **(extra_env or {})}
    trace_dir = report_dir / f"{run.id}-steps"
    proc_env["AITEST_TRACE_DIR"] = str(trace_dir)
    if case_ids is not None or proc_env.get("AITEST_API_REVISIONS"):
        cmd.extend(["-p", "aitest.pytest_selection"])
        proc_env["AITEST_SELECTED_CASE_IDS"] = json.dumps(case_ids) if case_ids is not None else "null"
        # 桌面端捆绑的引擎也可被脚本子进程导入；无需改写已有脚本。
        proc_env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(Path(__file__).resolve().parent.parent),
                                                              proc_env.get("PYTHONPATH", "")]))
    proc = subprocess.run(cmd, cwd=str(suite_dir), env=proc_env, capture_output=True, text=True, timeout=timeout)
    if proc.returncode not in (0, 1):
        raise RuntimeError("接口脚本未能执行：" + (proc.stderr or proc.stdout)[-4000:])
    results = parse_junit(junit, run.id) if junit.exists() else []
    for result in results:
        trace = trace_dir / (re.sub(r"[^a-zA-Z0-9_-]", "_", result.case_id) + ".json")
        if trace.exists():
            result.evidence_paths.append(str(trace))
    run.result = summarize(results)
    run.result.update({"base_url": env.base_url, "exit_code": proc.returncode, "junit": str(junit),
                       "stdout_tail": proc.stdout[-2000:], "stderr_tail": proc.stderr[-2000:]})
    if case_ids is not None:
        run.result["selected_case_ids"] = list(dict.fromkeys(case_ids))
    return run, results


def summarize(results: list[RunResult]) -> dict[str, Any]:
    counts: dict[str, int] = {"passed": 0, "failed": 0, "error": 0, "skipped": 0}
    failure_types: dict[str, int] = {}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
        if r.failure_type:
            failure_types[r.failure_type] = failure_types.get(r.failure_type, 0) + 1
    total = len(results)
    return {
        "total": total,
        **counts,
        "pass_rate": round(counts["passed"] / total, 4) if total else 0.0,
        "failure_types": failure_types,
        # 只有这些需要调 agent 做归因
        "needs_agent": [r.case_id for r in results if r.failure_type == FailureType.UNKNOWN.value],
    }
