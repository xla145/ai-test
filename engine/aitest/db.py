"""被测系统数据库校验：查询、断言、数据准备（第 10 节「调接口核对后台入库结果」）。

支持 MySQL（pymysql）、PostgreSQL（pg8000）与 SQLite，驱动均为纯 Python，可随安装包附带。
本模块不依赖 aitest 包的其他部分：生成接口脚本时会复制为 _aitest_db.py，与 UI 脚本共用同一套实现。

安全约束：
- 断言与查询只允许只读语句（SELECT / WITH / SHOW / EXPLAIN / DESCRIBE），且只能是单条语句；
  连接本身也设为只读事务（PostgreSQL / MySQL）或只读模式（SQLite），双重保证。
- 写操作（数据准备与清理）只能在连接配置 readonly=false 且环境不是生产环境时执行。
- 密码不进配置文件与数据库：运行时从环境变量 AITEST_DB_PASSWORDS（JSON：{连接名: 密码}）读取，
  或由客户端直接注入完整配置 AITEST_DATABASES（JSON：{连接名: 配置}）。

占位符统一写成 :name，按驱动自动转换。
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any

SUPPORTED = ("mysql", "postgresql", "sqlite")
DEFAULT_PORT = {"mysql": 3306, "postgresql": 5432}
_READ_ONLY_START = re.compile(r"^\s*(\(\s*)*(select|with|show|explain|describe|desc|values)\b", re.I)
# 读语句中也不应出现：可写 CTE（WITH x AS (DELETE ...)）、SELECT ... INTO（含 MySQL INTO OUTFILE）、FOR UPDATE 锁行等
_WRITE_WORDS = re.compile(r"\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|copy|lock|attach|detach|into)\b", re.I)
_PARAM = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")
_VAR = re.compile(r"\$\{(\w+)\}")


class DbError(Exception):
    pass


@dataclass
class DbConfig:
    name: str
    type: str
    host: str = "127.0.0.1"
    port: int | None = None
    database: str = ""
    user: str = ""
    password: str = ""
    path: str = ""  # SQLite 文件路径
    readonly: bool = True
    production: bool = False
    options: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, name: str, d: dict[str, Any], password: str = "", production: bool = False) -> "DbConfig":
        t = str(d.get("type", "")).lower()
        if t in ("postgres", "pg"):
            t = "postgresql"
        if t not in SUPPORTED:
            raise DbError(f"不支持的数据库类型：{d.get('type')}（支持 {', '.join(SUPPORTED)}）")
        return cls(
            name=name, type=t, host=d.get("host", "127.0.0.1"), port=d.get("port") or DEFAULT_PORT.get(t),
            database=d.get("database", ""), user=d.get("user", ""), password=password or d.get("password", ""),
            path=d.get("path", ""), readonly=bool(d.get("readonly", True)), production=production,
            options=d.get("options", {}),
        )

    def public(self) -> dict[str, Any]:
        """展示用：不含密码。"""
        return {"name": self.name, "type": self.type, "host": self.host, "port": self.port, "database": self.database,
                "user": self.user, "path": self.path, "readonly": self.readonly}


# --------------------------------------------------------------------------- 配置


def configs_for_env(env_cfg: dict[str, Any], passwords: dict[str, str] | None = None) -> dict[str, DbConfig]:
    """项目环境配置（environments.<env>.databases）+ 密码 → 连接配置。"""
    if passwords is None:
        passwords = json.loads(os.environ.get("AITEST_DB_PASSWORDS") or "{}")
    production = bool(env_cfg.get("production"))
    return {name: DbConfig.from_dict(name, d, passwords.get(name, ""), production)
            for name, d in (env_cfg.get("databases") or {}).items()}


def configs_from_runtime_env() -> dict[str, DbConfig]:
    """脚本运行时：客户端 / CI 注入的完整配置。"""
    raw = json.loads(os.environ.get("AITEST_DATABASES") or "{}")
    return {name: DbConfig.from_dict(name, d, d.get("password", ""), bool(d.get("production"))) for name, d in raw.items()}


def runtime_env(configs: dict[str, DbConfig]) -> dict[str, str]:
    """生成注入脚本进程的 AITEST_DATABASES。"""
    payload = {n: {**c.public(), "password": c.password, "production": c.production, "options": c.options}
               for n, c in configs.items()}
    return {"AITEST_DATABASES": json.dumps(payload, ensure_ascii=False)} if payload else {}


# --------------------------------------------------------------------------- SQL 安全检查


def _strip(sql: str) -> str:
    """去掉注释与字符串字面量，用于判断语句类型。"""
    sql = re.sub(r"--[^\n]*|/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`", "''", sql)


def is_single_statement(sql: str) -> bool:
    body = _strip(sql).strip().rstrip(";").strip()
    return bool(body) and ";" not in body


def is_read_only(sql: str) -> bool:
    body = _strip(sql)
    return is_single_statement(sql) and bool(_READ_ONLY_START.match(body)) and not _WRITE_WORDS.search(
        re.sub(r"^\s*(\(\s*)*(select|with|show|explain|describe|desc|values)\b", "", body, flags=re.I))


def render_params(params: dict[str, Any] | None, variables: dict[str, Any] | None) -> dict[str, Any]:
    """参数值中的 ${var} 用前序步骤提取的变量替换（例如接口返回的新建 ID）。"""
    variables = variables or {}

    def one(v: Any) -> Any:
        if isinstance(v, str):
            whole = _VAR.fullmatch(v)
            if whole and whole.group(1) in variables:
                return variables[whole.group(1)]
            return _VAR.sub(lambda m: str(variables.get(m.group(1), m.group(0))), v)
        return v

    return {k: one(v) for k, v in (params or {}).items()}


# --------------------------------------------------------------------------- 连接与执行


def _jsonable(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).hex()
    return v


class _Conn:
    def __init__(self, cfg: DbConfig, write: bool):
        self.cfg = cfg
        timeout = int(cfg.options.get("connect_timeout", 10))
        try:
            if cfg.type == "sqlite":
                if not cfg.path:
                    raise DbError(f"SQLite 连接 {cfg.name} 缺少 path")
                uri = f"{Path(cfg.path).absolute().as_uri()}?mode={'rw' if write else 'ro'}"
                self.raw = sqlite3.connect(uri, uri=True, timeout=timeout)
            elif cfg.type == "mysql":
                import pymysql
                self.raw = pymysql.connect(host=cfg.host, port=int(cfg.port or 3306), user=cfg.user, password=cfg.password,
                                           database=cfg.database or None, connect_timeout=timeout, charset="utf8mb4",
                                           autocommit=False)
                if not write:
                    with self.raw.cursor() as cur:
                        cur.execute("SET SESSION TRANSACTION READ ONLY")
            else:
                import pg8000.native
                self.raw = pg8000.native.Connection(cfg.user, host=cfg.host, port=int(cfg.port or 5432),
                                                    database=cfg.database or None, password=cfg.password or None,
                                                    timeout=timeout)
                if not write:
                    self.raw.run("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
        except DbError:
            raise
        except ImportError as e:
            raise DbError(f"缺少数据库驱动：{e.name}（pip install pymysql pg8000）") from e
        except Exception as e:  # noqa: BLE001 - 驱动异常种类繁多，统一转成可读错误
            raise DbError(f"无法连接 {cfg.name}（{cfg.type}）：{e}") from e

    def run(self, sql: str, params: dict[str, Any]) -> tuple[list[str], list[tuple], int]:
        try:
            if self.cfg.type == "sqlite":
                cur = self.raw.execute(sql, params)
                cols = [d[0] for d in cur.description or []]
                return cols, cur.fetchall() if cols else [], cur.rowcount
            if self.cfg.type == "mysql":
                converted = _PARAM.sub(lambda m: f"%({m.group(1)})s", sql.replace("%", "%%")) if params else sql
                with self.raw.cursor() as cur:
                    cur.execute(converted, params or None)
                    cols = [d[0] for d in cur.description or []]
                    return cols, list(cur.fetchall()) if cols else [], cur.rowcount
            rows = self.raw.run(sql, **params)
            cols = [c["name"] for c in self.raw.columns or []]
            return cols, [tuple(r) for r in rows or []], self.raw.row_count
        except DbError:
            raise
        except Exception as e:  # noqa: BLE001
            raise DbError(f"SQL 执行失败（{self.cfg.name}）：{e}") from e

    def commit(self) -> None:
        if self.cfg.type == "postgresql":
            return  # pg8000.native 默认自动提交
        self.raw.commit()

    def close(self) -> None:
        try:
            self.raw.close()
        except Exception:  # noqa: BLE001
            pass


def query(cfg: DbConfig, sql: str, params: dict[str, Any] | None = None, limit: int = 200) -> dict[str, Any]:
    """只读查询。"""
    if not is_read_only(sql):
        raise DbError("只允许单条只读语句（SELECT / WITH / SHOW / EXPLAIN / DESCRIBE）")
    started = time.perf_counter()
    conn = _Conn(cfg, write=False)
    try:
        cols, rows, _ = conn.run(sql, params or {})
    finally:
        conn.close()
    return {
        "columns": cols,
        "rows": [{c: _jsonable(v) for c, v in zip(cols, r)} for r in rows[:limit]],
        "row_count": len(rows),
        "truncated": len(rows) > limit,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
    }


def execute(cfg: DbConfig, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """写操作（数据准备与清理）：仅非生产环境、且连接配置允许写入。"""
    if cfg.production:
        raise DbError(f"禁止在生产环境执行写操作（{cfg.name}）")
    if cfg.readonly:
        raise DbError(f"连接 {cfg.name} 为只读，需在配置中关闭只读后才能执行数据准备")
    if not is_single_statement(sql):
        raise DbError("一次只能执行一条语句")
    conn = _Conn(cfg, write=True)
    try:
        _, _, affected = conn.run(sql, params or {})
        conn.commit()
    finally:
        conn.close()
    return {"affected": affected}


def test_connection(cfg: DbConfig) -> dict[str, Any]:
    started = time.perf_counter()
    probe = "SELECT 1 AS ok" if cfg.type != "sqlite" else "SELECT 1 AS ok"
    query(cfg, probe)
    return {"ok": True, "elapsed_ms": round((time.perf_counter() - started) * 1000, 1), "connection": cfg.public()}


# --------------------------------------------------------------------------- 断言


def _matches(expected: Any, actual: Any) -> bool:
    if isinstance(expected, (int, float)) and not isinstance(expected, bool) and isinstance(actual, str):
        try:
            return float(actual) == float(expected)
        except ValueError:
            return False
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)) and not isinstance(expected, bool):
        return float(actual) == float(expected)
    if isinstance(expected, str) and not isinstance(actual, str) and actual is not None:
        return str(actual) == expected
    return expected == actual


def evaluate(expect: dict[str, Any], result: dict[str, Any]) -> list[str]:
    """expect 支持：rows（行数等于）、min_rows（至少几行）、empty（没有数据）、
    value（第一行第一列的值）、row（第一行包含这些列值）、contains（任一行包含这些列值）。"""
    errors: list[str] = []
    rows, n = result["rows"], result["row_count"]
    if "rows" in expect and n != expect["rows"]:
        errors.append(f"行数应为 {expect['rows']}，实际 {n}")
    if "min_rows" in expect and n < expect["min_rows"]:
        errors.append(f"至少应有 {expect['min_rows']} 行，实际 {n}")
    if expect.get("empty") is True and n:
        errors.append(f"应没有数据，实际 {n} 行")
    if expect.get("empty") is False and not n:
        errors.append("应有数据，实际为空")
    if "value" in expect:
        actual = next(iter(rows[0].values()), None) if rows else None
        if not rows or not _matches(expect["value"], actual):
            errors.append(f"值应为 {expect['value']!r}，实际 {actual!r}")
    if "row" in expect:
        first = rows[0] if rows else {}
        diff = {k: first.get(k) for k, v in expect["row"].items() if not _matches(v, first.get(k))}
        if not rows or diff:
            errors.append(f"第一行应包含 {expect['row']}，实际 {diff or '没有数据'}")
    if "contains" in expect:
        if not any(all(_matches(v, r.get(k)) for k, v in expect["contains"].items()) for r in rows):
            errors.append(f"没有任何一行包含 {expect['contains']}")
    return errors


def check(configs: dict[str, DbConfig], spec: dict[str, Any], variables: dict[str, Any] | None = None) -> dict[str, Any]:
    """执行一条数据库断言；入库可能是异步的，在 timeout_ms 内重试直到通过。"""
    name = spec.get("db") or (next(iter(configs)) if len(configs) == 1 else None)
    if not name or name not in configs:
        raise DbError(f"未配置数据库连接：{spec.get('db') or '（未指定）'}，可用：{', '.join(configs) or '无'}")
    params = render_params(spec.get("params"), variables)
    expect = spec.get("expect") or {"min_rows": 1}
    deadline = time.monotonic() + spec.get("timeout_ms", 3000) / 1000
    while True:
        result = query(configs[name], spec["sql"], params)
        errors = evaluate(expect, result)
        if not errors or time.monotonic() >= deadline:
            break
        time.sleep(0.3)
    return {"ok": not errors, "errors": errors, "db": name, "rows": result["rows"][:20], "row_count": result["row_count"],
            "description": spec.get("description", "")}


def assert_check(configs: dict[str, DbConfig], spec: dict[str, Any], variables: dict[str, Any] | None = None) -> dict[str, Any]:
    r = check(configs, spec, variables)
    if not r["ok"]:
        label = spec.get("description") or spec["sql"].strip().splitlines()[0][:120]
        raise AssertionError(f"数据库校验失败（{r['db']}：{label}）：{'；'.join(r['errors'])}；查询结果：{r['rows'][:5]}")
    return r


def run_setup(configs: dict[str, DbConfig], steps: list[dict[str, Any]], variables: dict[str, Any] | None = None) -> None:
    for st in steps or []:
        name = st.get("db") or (next(iter(configs)) if len(configs) == 1 else None)
        if not name or name not in configs:
            raise DbError(f"未配置数据库连接：{st.get('db')}")
        execute(configs[name], st["sql"], render_params(st.get("params"), variables))
