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
    HealProposal,
    ReviewItem,
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
CREATE TABLE IF NOT EXISTS heal_proposal (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, script_path TEXT NOT NULL, original TEXT, proposed TEXT,
  diff TEXT, reason TEXT, failure_type TEXT, run_id TEXT, status TEXT NOT NULL, commit_hash TEXT
);
CREATE TABLE IF NOT EXISTS review_item (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, kind TEXT, description TEXT, evidence_paths TEXT,
  ai_verdict TEXT, run_id TEXT, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session (
  id TEXT PRIMARY KEY, project_id TEXT, codex_thread_id TEXT, purpose TEXT, token_usage INTEGER DEFAULT 0
);
"""


class CaseValidationError(ValueError):
    pass


def _limit(limit: int | None, offset: int) -> tuple[str, list[Any]]:
    """分页子句；limit 为 None 时不分页。"""
    return (" LIMIT ? OFFSET ?", [limit, max(offset, 0)]) if limit else ("", [])


def _match(col: str, value: Any) -> tuple[str, list[Any]]:
    """等值过滤；逗号分隔的多个值按 IN 处理（如 execution_mode=ui,capture）。"""
    vals = [v for v in str(value).split(",") if v]
    if len(vals) == 1:
        return f" AND {col}=?", vals
    return f" AND {col} IN ({','.join('?' * len(vals))})", vals


def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# 按项目过滤只挂在用例上的实体（建议、复核、规范问题）
_OF_PROJECT = " AND case_id IN (SELECT id FROM testcase WHERE project_id=?)"


class Store:
    def __init__(self, path: str | Path = ":memory:"):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """旧库补列：两层项目（parent_id / kind）。"""
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(project)")}
        if "parent_id" not in cols:
            self.conn.execute("ALTER TABLE project ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''")
        if "kind" not in cols:
            self.conn.execute("ALTER TABLE project ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'")
        if "project_type" not in cols:
            self.conn.execute("ALTER TABLE project ADD COLUMN project_type TEXT NOT NULL DEFAULT 'multi'")
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ---- project ----
    def add_project(self, p: Project) -> Project:
        self.conn.execute(
            "INSERT OR REPLACE INTO project (id, name, workspace_path, environments, parent_id, kind, project_type) VALUES (?,?,?,?,?,?,?)",
            (p.id, p.name, p.workspace_path, json.dumps(p.environments, ensure_ascii=False), p.parent_id or "", p.kind, p.project_type),
        )
        self.conn.commit()
        return p

    def delete_project(self, project_id: str) -> dict[str, int]:
        """删除项目在数据库中的全部记录（用例、脚本登记、执行记录、建议、复核等）；workspace 目录不动。"""
        cases = "SELECT id FROM testcase WHERE project_id=?"
        runs = "SELECT id FROM run WHERE project_id=?"
        statements = [
            ("lint_issue", f"DELETE FROM lint_issue WHERE case_id IN ({cases})"),
            ("case_requirement", f"DELETE FROM case_requirement WHERE case_id IN ({cases})"),
            ("script", f"DELETE FROM script WHERE case_id IN ({cases})"),
            ("heal_proposal", f"DELETE FROM heal_proposal WHERE case_id IN ({cases})"),
            ("review_item", f"DELETE FROM review_item WHERE case_id IN ({cases})"),
            ("run_result", f"DELETE FROM run_result WHERE run_id IN ({runs})"),
            ("run", "DELETE FROM run WHERE project_id=?"),
            ("testcase", "DELETE FROM testcase WHERE project_id=?"),
            ("requirement", "DELETE FROM requirement WHERE project_id=?"),
            ("test_data", "DELETE FROM test_data WHERE project_id=?"),
            ("role_account", "DELETE FROM role_account WHERE project_id=?"),
            ("agent_session", "DELETE FROM agent_session WHERE project_id=?"),
        ]
        # 三期的表由 ops.ensure_schema 创建，可能不存在
        existing = {r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        statements += [(t, f"DELETE FROM {t} WHERE project_id=?") for t in ("event_log", "attribution", "project_setting")
                       if t in existing]
        counts: dict[str, int] = {}
        with self.conn:
            for table, sql in statements:
                counts[table] = self.conn.execute(sql, (project_id,)).rowcount
            self.conn.execute("DELETE FROM project WHERE id=?", (project_id,))
        return counts

    def get_project(self, project_id: str) -> Project | None:
        r = self.conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone()
        if not r:
            return None
        return Project(id=r["id"], name=r["name"], workspace_path=r["workspace_path"],
                       environments=json.loads(r["environments"]), parent_id=r["parent_id"] or "",
                       kind=r["kind"] or "project", project_type=r["project_type"])

    def list_projects(self) -> list[Project]:
        rows = self.conn.execute("SELECT id FROM project ORDER BY name").fetchall()
        return [p for p in (self.get_project(r["id"]) for r in rows) if p]

    def child_ids(self, group_id: str) -> list[str]:
        return [r["id"] for r in self.conn.execute("SELECT id FROM project WHERE parent_id=? ORDER BY name", (group_id,))]

    def parent_of(self, project_id: str) -> Project | None:
        p = self.get_project(project_id)
        return self.get_project(p.parent_id) if p and p.parent_id else None

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

    @staticmethod
    def _case_where(project_id: str, query: str | None, filters: dict[str, Any]) -> tuple[str, list[Any]]:
        sql, args = " WHERE project_id=?", [project_id]
        for col in ("type", "priority", "execution_mode", "status", "lint_status"):
            if filters.get(col):
                s, a = _match(col, filters[col])
                sql, args = sql + s, args + a
        if filters.get("ids"):
            s, a = _match("id", filters["ids"])
            sql, args = sql + s, args + a
        if query:
            sql += (" AND (title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'"
                    " OR json_extract(data, '$.module_path') LIKE ? ESCAPE '\\')")
            args += [_like(query)] * 3
        return sql, args

    def list_cases(self, project_id: str, *, query: str | None = None, limit: int | None = None, offset: int = 0,
                   **filters: Any) -> list[TestCase]:
        """filters：type / priority / execution_mode / status / lint_status，值可用逗号分隔多个；
        query 匹配标题、用例 ID 与模块路径。"""
        where, args = self._case_where(project_id, query, filters)
        page, page_args = _limit(limit, offset)
        rows = self.conn.execute("SELECT data FROM testcase" + where + " ORDER BY rowid" + page, args + page_args).fetchall()
        return [TestCase.from_dict(json.loads(r["data"])) for r in rows]

    def count_cases(self, project_id: str, *, query: str | None = None, **filters: Any) -> int:
        where, args = self._case_where(project_id, query, filters)
        return self.conn.execute("SELECT COUNT(*) FROM testcase" + where, args).fetchone()[0]

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

    @staticmethod
    def _issue_where(case_id: str | None, project_id: str | None, level: str | None) -> tuple[str, list[Any]]:
        sql, args = " WHERE 1=1", []
        if case_id:
            sql, args = sql + " AND case_id=?", args + [case_id]
        if project_id:
            sql, args = sql + _OF_PROJECT, args + [project_id]
        if level:
            s, a = _match("level", level)
            sql, args = sql + s, args + a
        return sql, args

    def list_lint_issues(self, case_id: str | None = None, *, project_id: str | None = None, level: str | None = None,
                         limit: int | None = None, offset: int = 0) -> list[LintIssue]:
        where, args = self._issue_where(case_id, project_id, level)
        page, page_args = _limit(limit, offset)
        rows = self.conn.execute("SELECT * FROM lint_issue" + where + " ORDER BY rowid" + page, args + page_args).fetchall()
        return [LintIssue(**{**dict(r), "resolved": bool(r["resolved"])}) for r in rows]

    def count_lint_issues(self, case_id: str | None = None, *, project_id: str | None = None,
                          level: str | None = None) -> int:
        where, args = self._issue_where(case_id, project_id, level)
        return self.conn.execute("SELECT COUNT(*) FROM lint_issue" + where, args).fetchone()[0]

    def lint_level_counts(self, case_id: str | None = None, *, project_id: str | None = None) -> dict[str, int]:
        where, args = self._issue_where(case_id, project_id, None)
        rows = self.conn.execute("SELECT level, COUNT(*) AS n FROM lint_issue" + where + " GROUP BY level", args)
        return {r["level"]: r["n"] for r in rows}

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

    def list_scripts(self, case_id: str | None = None) -> list[Script]:
        if case_id:
            rows = self.conn.execute("SELECT * FROM script WHERE case_id=?", (case_id,)).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM script").fetchall()
        return [Script(**dict(r)) for r in rows]

    def upsert_script(self, s: Script) -> Script:
        """同一用例同一框架只保留一条脚本记录，版本随 git commit 更新。"""
        r = self.conn.execute("SELECT id FROM script WHERE case_id=? AND framework=?", (s.case_id, s.framework)).fetchone()
        if r:
            s.id = r["id"]
        self.add_script(s)
        return s

    def list_test_data(self, project_id: str) -> list[TestData]:
        rows = self.conn.execute("SELECT * FROM test_data WHERE project_id=?", (project_id,)).fetchall()
        return [TestData(**dict(r)) for r in rows]

    def list_role_accounts(self, project_id: str) -> list[RoleAccount]:
        rows = self.conn.execute("SELECT * FROM role_account WHERE project_id=? ORDER BY role_name", (project_id,)).fetchall()
        return [RoleAccount(**dict(r)) for r in rows]

    # ---- 自愈建议 ----
    def save_proposal(self, p: HealProposal) -> HealProposal:
        self.conn.execute(
            "INSERT OR REPLACE INTO heal_proposal VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (p.id, p.case_id, p.script_path, p.original, p.proposed, p.diff, p.reason, p.failure_type,
             p.run_id, p.status, p.commit),
        )
        self.conn.commit()
        return p

    @staticmethod
    def _proposal(r: sqlite3.Row) -> HealProposal:
        d = dict(r)
        d["commit"] = d.pop("commit_hash") or ""
        return HealProposal(**d)

    def get_proposal(self, proposal_id: str) -> HealProposal | None:
        r = self.conn.execute("SELECT * FROM heal_proposal WHERE id=?", (proposal_id,)).fetchone()
        return self._proposal(r) if r else None

    @staticmethod
    def _status_where(status: str | None, project_id: str | None) -> tuple[str, list[Any]]:
        sql, args = " WHERE 1=1", []
        if status:
            sql, args = sql + " AND status=?", args + [status]
        if project_id:
            sql, args = sql + _OF_PROJECT, args + [project_id]
        return sql, args

    def list_proposals(self, status: str | None = None, *, project_id: str | None = None,
                       limit: int | None = None, offset: int = 0) -> list[HealProposal]:
        where, args = self._status_where(status, project_id)
        page, page_args = _limit(limit, offset)
        rows = self.conn.execute("SELECT * FROM heal_proposal" + where + " ORDER BY rowid" + page, args + page_args)
        return [self._proposal(r) for r in rows]

    def count_proposals(self, status: str | None = None, *, project_id: str | None = None) -> int:
        where, args = self._status_where(status, project_id)
        return self.conn.execute("SELECT COUNT(*) FROM heal_proposal" + where, args).fetchone()[0]

    # ---- 人工复核队列 ----
    def save_review(self, item: ReviewItem) -> ReviewItem:
        self.conn.execute(
            "INSERT OR REPLACE INTO review_item VALUES (?,?,?,?,?,?,?,?)",
            (item.id, item.case_id, item.kind, item.description, json.dumps(item.evidence_paths, ensure_ascii=False),
             item.ai_verdict, item.run_id, item.status),
        )
        self.conn.commit()
        return item

    def list_reviews(self, status: str | None = None, *, project_id: str | None = None,
                     limit: int | None = None, offset: int = 0) -> list[ReviewItem]:
        where, args = self._status_where(status, project_id)
        page, page_args = _limit(limit, offset)
        rows = self.conn.execute("SELECT * FROM review_item" + where + " ORDER BY rowid" + page, args + page_args).fetchall()
        return [ReviewItem(**{**dict(r), "evidence_paths": json.loads(r["evidence_paths"] or "[]")}) for r in rows]

    def count_reviews(self, status: str | None = None, *, project_id: str | None = None) -> int:
        where, args = self._status_where(status, project_id)
        return self.conn.execute("SELECT COUNT(*) FROM review_item" + where, args).fetchone()[0]

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

    def list_run_results(self, run_id: str, *, limit: int | None = None, offset: int = 0) -> list[RunResult]:
        page, page_args = _limit(limit, offset)
        rows = self.conn.execute("SELECT * FROM run_result WHERE run_id=? ORDER BY rowid" + page,
                                 [run_id, *page_args]).fetchall()
        return [RunResult(**{**dict(r), "evidence_paths": json.loads(r["evidence_paths"] or "[]")}) for r in rows]

    def count_run_results(self, run_id: str) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM run_result WHERE run_id=?", (run_id,)).fetchone()[0]

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
