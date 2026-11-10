"""项目 workspace 初始化（第 4、12 节）。

每个项目一个独立 workspace（用例 JSON、脚本、报告），Codex 只在该目录内读写；
脚本目录用 git 管理，自愈修改以 commit 形式可回滚。
"""

from __future__ import annotations

import shutil
import subprocess
from importlib import resources
from pathlib import Path

LAYOUT = ("cases", "requirements", "scripts/api", "scripts/ui", "reports", "evidence", ".agents/skills")


def init_workspace(path: str | Path, project_name: str) -> Path:
    root = Path(path)
    for d in LAYOUT:
        (root / d).mkdir(parents=True, exist_ok=True)
    tpl = resources.files("aitest").joinpath("templates")
    agents = root / "AGENTS.md"
    if not agents.exists():
        agents.write_text(tpl.joinpath("AGENTS.md.tpl").read_text(encoding="utf-8").replace("{{PROJECT}}", project_name),
                          encoding="utf-8")
    for skill in ("test-design.md", "api-script.md", "failure-triage.md", "ui-explore.md", "ui-heal.md"):
        dst = root / ".agents" / "skills" / skill
        if not dst.exists():
            dst.write_text(tpl.joinpath(f"skills/{skill}").read_text(encoding="utf-8"), encoding="utf-8")
    gitignore = root / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("reports/\nevidence/\n.auth/\n__pycache__/\ntest-results/\nnode_modules/\n", encoding="utf-8")
    if shutil.which("git") and not (root / ".git").exists():
        subprocess.run(["git", "init", "-q"], cwd=root, check=False)
    return root


def commit(root: str | Path, message: str) -> str | None:
    """提交 workspace 变更，返回 commit hash（Script.version）。"""
    if not shutil.which("git"):
        return None
    root = Path(root)
    subprocess.run(["git", "add", "-A"], cwd=root, check=False)
    r = subprocess.run(
        ["git", "-c", "user.name=aitest", "-c", "user.email=aitest@localhost", "commit", "-q", "-m", message],
        cwd=root, capture_output=True, text=True,
    )
    if r.returncode != 0:
        return None
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
