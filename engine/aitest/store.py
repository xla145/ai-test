"""本地 SQLite 存储（第 12 节）。

元数据存 SQLite；脚本、截图、trace 存项目 workspace 目录。
密钥与账号密码存系统钥匙串，这里只存引用（credential_ref）。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from .models import (
    AgentSession,
    LintIssue,
    Project,
    Requirement,
    RoleAccount,
    Run,
    RunResult,
    Script,
    TestCase,
    TestData,
)
from .schema import validate_case

SCHEMA = """
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_path TEXT NOT NULL,
  environments TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS requirement (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_file TEXT, section TEXT, content TEXT
);
CREATE TABLE IF NOT EXISTS testcase (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT, priority TEXT,
  execution_mode TEXT, status TEXT, lint_status TEXT, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testcase_project ON testcase(project_id);
CREATE TABLE IF NOT EXISTS case_requirement (
  case_id TEXT NOT NULL, requirement_id TEXT NOT NULL, PRIMARY KEY (case_id, requirement_id)
);
CREATE TABLE IF NOT EXISTS lint_issue (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, rule TEXT NOT NULL, level TEXT NOT NULL,
  message TEXT, suggestion TEXT, resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS test_data (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL, check_script TEXT, seed_script TEXT
);
CREATE TABLE IF NOT EXISTS role_account (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role_name TEXT NOT NULL,
  credential_ref TEXT NOT NULL, storage_state_path TEXT
);
CREATE TABLE IF NOT EXISTS script (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, path TEXT NOT NULL, framework TEXT, version TEXT
);
CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT, started_at TEXT, mode TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS run_result (
  run_id TEXT NOT NULL, case_id TEXT NOT NULL, status TEXT, duration REAL, message TEXT,
  evidence_paths TEXT, failure_type TEXT, PRIMARY KEY (run_id, case_id)
);
CREATE TABLE IF NOT EXISTS agent_session (
  id TEXT PRIMARY KEY, project_id TEXT, codex_thread_id TEXT, purpose TEXT, token_usage INTEGER DEFAULT 0
);
"""


class CaseValidationError(ValueError):
    pass


class Store:
    def __init__(self, path: str | Path = ":memory:"):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    # ---- project ----
    def add_project(self, p: Project) -> Project:
        self.conn.execute(
            "INSERT OR REPLACE INTO project VALUES (?,?,?,?)",
            (p.id, p.name, p.workspace_path, json.dumps(p.environments, ensure_ascii=False)),
        )
        self.conn.commit()
        return p

    def get_project(self, project_id: str) -> Project | None:
        r = self.conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone()
        if not r:
            return None
        return Project(id=r["id"], name=r["name"], workspace_path=r["workspace_path"],
                       environments=json.loads(r["environments"]))

    def list_projects(self) -> list[Project]:
        rows = self.conn.execute("SELECT id FROM project ORDER BY name").fetchall()
        return [p for p in (self.get_project(r["id"]) for r in rows) if p]

    # ---- requirement ----
    def add_requirements(self, reqs: Iterable[Requirement]) -> None:
        self.conn.executemany(
            "INSERT OR REPLACE INTO requirement VALUES (?,?,?,?,?)",
            [(r.id, r.project_id, r.source_file, r.section, r.content) for r in reqs],
        )
        self.conn.commit()

    def list_requirements(self, project_id: str) -> list[Requirement]:
        rows = self.conn.execute("SELECT * FROM requirement WHERE project_id=?", (project_id,)).fetchall()
        return [Requirement(**dict(r)) for r in rows]

    # ---- testcase ----
    def upsert_case(self, case: TestCase, validate: bool = True) -> TestCase:
        data = case.to_dict()
        if validate:
            errors = validate_case(data)
            if errors:
                raise CaseValidationError("; ".join(errors))
        self.conn.execute(
            "INSERT OR REPLACE INTO testcase VALUES (?,?,?,?,?,?,?,?,?)",
            (case.id, case.project_id, case.title, case.type, case.priority, case.execution_mode,
             case.status, case.lint_status, json.dumps(data, ensure_ascii=False)),
        )
        self.conn.execute("DELETE FROM case_requirement WHERE case_id=?", (case.id,))
        self.conn.executemany(
            "INSERT INTO case_requirement VALUES (?,?)", [(case.id, r) for r in case.requirement_ids]
        )
        self.conn.commit()
        return case

    def get_case(self, case_id: str) -> TestCase | None:
        r = self.conn.execute("SELECT data FROM testcase WHERE id=?", (case_id,)).fetchone()
        return TestCase.from_dict(json.loads(r["data"])) if r else None

    def list_cases(self, project_id: str, **filters: Any) -> list[TestCase]:
        sql = "SELECT data FROM testcase WHERE project_id=?"
        args: list[Any] = [project_id]
        for col in ("type", "priority", "execution_mode", "status", "lint_status"):
            if filters.get(col):
                sql += f" AND {col}=?"
                args.append(filters[col])
        rows = self.conn.execute(sql + " ORDER BY rowid", args).fetchall()
        return [TestCase.from_dict(json.loads(r["data"])) for r in rows]

    def link_requirement(self, case_id: str, requirement_id: str) -> TestCase:
        case = self.get_case(case_id)
        if case is None:
            raise KeyError(case_id)
        if requirement_id not in case.requirement_ids:
            case.requirement_ids.append(requirement_id)
        return self.upsert_case(case)

    # ---- lint ----
    def replace_lint_issues(self, case_ids: Iterable[str], issues: Iterable[LintIssue]) -> None:
        ids = list(case_ids)
        self.conn.executemany("DELETE FROM lint_issue WHERE case_id=?", [(i,) for i in ids])
        self.conn.executemany(
            "INSERT INTO lint_issue VALUES (?,?,?,?,?,?,?)",
            [(i.id, i.case_id, i.rule, i.level, i.message, i.suggestion, int(i.resolved)) for i in issues],
        )
        self.conn.commit()

    def list_lint_issues(self, case_id: str | None = None) -> list[LintIssue]:
        if case_id:
            rows = self.conn.execute("SELECT * FROM lint_issue WHERE case_id=?", (case_id,)).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM lint_issue").fetchall()
        return [LintIssue(**{**dict(r), "resolved": bool(r["resolved"])}) for r in rows]

    # ---- 其它实体 ----
    def add_test_data(self, d: TestData) -> None:
        self.conn.execute("INSERT OR REPLACE INTO test_data VALUES (?,?,?,?,?)",
                          (d.id, d.project_id, d.key, d.check_script, d.seed_script))
        self.conn.commit()

    def get_test_data(self, project_id: str, key: str) -> TestData | None:
        r = self.conn.execute("SELECT * FROM test_data WHERE project_id=? AND key=?", (project_id, key)).fetchone()
        return TestData(**dict(r)) if r else None

    def add_role_account(self, a: RoleAccount) -> None:
        self.conn.execute("INSERT OR REPLACE INTO role_account VALUES (?,?,?,?,?)",
                          (a.id, a.project_id, a.role_name, a.credential_ref, a.storage_state_path))
        self.conn.commit()

    def add_script(self, s: Script) -> None:
        self.conn.execute("INSERT OR REPLACE INTO script VALUES (?,?,?,?,?)",
                          (s.id, s.case_id, s.path, s.framework, s.version))
        self.conn.commit()

    def save_run(self, run: Run, results: Iterable[RunResult]) -> None:
        self.conn.execute("INSERT OR REPLACE INTO run VALUES (?,?,?,?,?,?)",
                          (run.id, run.project_id, run.env, run.started_at, run.mode,
                           json.dumps(run.result, ensure_ascii=False)))
        self.conn.executemany(
            "INSERT OR REPLACE INTO run_result VALUES (?,?,?,?,?,?,?)",
            [(r.run_id, r.case_id, r.status, r.duration, r.message,
              json.dumps(r.evidence_paths), r.failure_type) for r in results],
        )
        self.conn.commit()

    def list_run_results(self, run_id: str) -> list[RunResult]:
        rows = self.conn.execute("SELECT * FROM run_result WHERE run_id=?", (run_id,)).fetchall()
        return [RunResult(**{**dict(r), "evidence_paths": json.loads(r["evidence_paths"] or "[]")}) for r in rows]

    def add_agent_session(self, s: AgentSession) -> None:
        self.conn.execute("INSERT OR REPLACE INTO agent_session VALUES (?,?,?,?,?)",
                          (s.id, s.project_id, s.codex_thread_id, s.purpose, s.token_usage))
        self.conn.commit()

    def add_token_usage(self, session_id: str, tokens: int) -> None:
        self.conn.execute("UPDATE agent_session SET token_usage = token_usage + ? WHERE id=?", (tokens, session_id))
        self.conn.commit()

    def project_token_usage(self, project_id: str) -> int:
        r = self.conn.execute("SELECT COALESCE(SUM(token_usage),0) AS t FROM agent_session WHERE project_id=?",
                              (project_id,)).fetchone()
        return int(r["t"])
