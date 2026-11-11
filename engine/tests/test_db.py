"""被测系统数据库校验。

SQLite 测试总会运行；PostgreSQL / MySQL 需要真实数据库，设置以下环境变量后运行（CI 中由服务容器提供）：
  AITEST_TEST_PG="host:port:user:password:database"
  AITEST_TEST_MYSQL="host:port:user:password:database"
"""
import json
import os
import sqlite3
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from aitest import db
from aitest.cli import main


# --------------------------------------------------------------------------- 单元：SQLite


@pytest.fixture
def sqlite_db(tmp_path):
    path = tmp_path / "被测 库.sqlite"  # 路径含中文与空格
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, status TEXT, score REAL, created_at TEXT);
        INSERT INTO users VALUES (1, '张三', 'active', 9.5, '2026-11-01'), (2, '李四', 'disabled', 7, '2026-11-02');
    """)
    conn.commit()
    conn.close()
    return path


def cfg(path, **kw):
    return db.DbConfig.from_dict("main", {"type": "sqlite", "path": str(path), **kw})


def test_query_and_expectations(sqlite_db):
    c = cfg(sqlite_db)
    r = db.query(c, "SELECT id, name FROM users WHERE status = :s ORDER BY id", {"s": "active"})
    assert r["columns"] == ["id", "name"] and r["rows"] == [{"id": 1, "name": "张三"}] and r["row_count"] == 1
    configs = {"main": c}
    ok = db.check(configs, {"sql": "SELECT name, score FROM users WHERE id = :id", "params": {"id": "${uid}"},
                            "expect": {"row": {"name": "张三", "score": 9.5}}}, {"uid": 1})
    assert ok["ok"], ok
    assert db.check(configs, {"sql": "SELECT count(*) FROM users", "expect": {"value": 2}})["ok"]
    assert db.check(configs, {"sql": "SELECT * FROM users WHERE id = 99", "expect": {"empty": True}})["ok"]
    assert db.check(configs, {"sql": "SELECT * FROM users", "expect": {"contains": {"name": "李四", "status": "disabled"}}})["ok"]
    bad = db.check(configs, {"sql": "SELECT status FROM users WHERE id = 2", "expect": {"value": "active"}, "timeout_ms": 0})
    assert not bad["ok"] and "实际 'disabled'" in bad["errors"][0]
    with pytest.raises(AssertionError, match="数据库校验失败"):
        db.assert_check(configs, {"sql": "SELECT 1 FROM users WHERE id = 3", "timeout_ms": 0, "description": "新用户已入库"})


def test_read_only_is_enforced_twice(sqlite_db):
    c = cfg(sqlite_db)
    for sql in ["DELETE FROM users", "SELECT 1; DROP TABLE users", "UPDATE users SET name = 'x'"]:
        with pytest.raises(db.DbError, match="只读"):
            db.query(c, sql)
    # 即使绕过语句检查，只读连接本身也拒绝写入
    conn = db._Conn(c, write=False)
    with pytest.raises(db.DbError, match="readonly|read-only|只读"):
        conn.run("DELETE FROM users", {})
    conn.close()
    assert db.query(c, "SELECT count(*) AS n FROM users")["rows"] == [{"n": 2}]


def test_writes_need_writable_non_production_connection(sqlite_db):
    with pytest.raises(db.DbError, match="只读"):
        db.execute(cfg(sqlite_db), "DELETE FROM users WHERE id = 2")
    with pytest.raises(db.DbError, match="生产环境"):
        db.execute(db.DbConfig.from_dict("main", {"type": "sqlite", "path": str(sqlite_db), "readonly": False}, production=True),
                   "DELETE FROM users WHERE id = 2")
    w = cfg(sqlite_db, readonly=False)
    assert db.execute(w, "UPDATE users SET status = :s WHERE id = :id", {"s": "active", "id": 2}) == {"affected": 1}
    db.run_setup({"main": w}, [{"sql": "INSERT INTO users (id, name) VALUES (:id, :n)", "params": {"id": "${new}", "n": "王五"}}], {"new": 3})
    assert db.query(w, "SELECT count(*) AS n FROM users WHERE status = 'active'")["rows"] == [{"n": 2}]
    assert db.query(w, "SELECT name FROM users WHERE id = 3")["rows"] == [{"name": "王五"}]


def test_configs_and_errors(sqlite_db):
    env = {"production": True, "databases": {"main": {"type": "postgres", "host": "db", "database": "app", "user": "u"}}}
    c = db.configs_for_env(env, {"main": "s3cret"})["main"]
    assert (c.type, c.port, c.password, c.production) == ("postgresql", 5432, "s3cret", True)
    assert "password" not in c.public()
    runtime = db.runtime_env({"main": c})
    os.environ["AITEST_DATABASES"] = runtime["AITEST_DATABASES"]
    try:
        assert db.configs_from_runtime_env()["main"].password == "s3cret"
    finally:
        del os.environ["AITEST_DATABASES"]
    with pytest.raises(db.DbError, match="不支持"):
        db.DbConfig.from_dict("x", {"type": "oracle"})
    with pytest.raises(db.DbError, match="未配置数据库连接"):
        db.check({"a": cfg(sqlite_db), "b": cfg(sqlite_db)}, {"sql": "SELECT 1"})
    with pytest.raises(db.DbError, match="无法连接"):
        db.query(cfg(sqlite_db.parent / "missing.sqlite"), "SELECT 1")


# --------------------------------------------------------------------------- 端到端：接口脚本中的入库校验


class Handler(BaseHTTPRequestHandler):
    db_path = ""
    persist = True

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        conn = sqlite3.connect(self.db_path)
        uid = conn.execute("SELECT coalesce(max(id), 0) + 1 FROM users").fetchone()[0]
        if Handler.persist:
            conn.execute("INSERT INTO users (id, name, status) VALUES (?, ?, 'active')", (uid, body["name"]))
            conn.commit()
        conn.close()
        data = json.dumps({"id": uid, "name": body["name"]}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def service(sqlite_db):
    Handler.db_path, Handler.persist = str(sqlite_db), True
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_api_suite_verifies_persisted_data(tmp_path, capsys, sqlite_db, service):
    dbfile = str(tmp_path / "engine.sqlite")

    def call(*args, ok=True):
        code = main(["--db", dbfile, *args])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert (code == 0) == ok, out
        return out["data"] if ok else out["error"]

    envs = {"test": {"base_url": service, "databases": {"main": {"type": "sqlite", "path": str(sqlite_db)}}}}
    pid = call("init-project", "--name", "入库", "--workspace", str(tmp_path / "ws"), "--environments", json.dumps(envs))["id"]
    case = {"title": "用户-创建后入库", "type": "api", "priority": "P0", "steps": ["创建用户"], "expected": ["数据库中存在该用户"],
            "api": {"method": "POST", "path": "/users", "auth": False, "body": {"name": "赵六"}, "expected_status": [201],
                    "extract": {"uid": "id"},
                    "db_checks": [{"description": "新用户已入库且为启用状态", "sql": "SELECT name, status FROM users WHERE id = :id",
                                   "params": {"id": "${uid}"}, "expect": {"row": {"name": "赵六", "status": "active"}}, "timeout_ms": 500}]}}
    call("create-case", "--project", pid, "--json", json.dumps(case, ensure_ascii=False))
    assert [c["name"] for c in call("db-list", "--project", pid, "--env", "test")] == ["main"]
    assert call("db-test", "--project", pid, "--env", "test")["ok"]
    assert call("db-query", "--project", pid, "--env", "test", "--sql", "SELECT name FROM users ORDER BY id")["row_count"] == 2
    assert "只读" in call("db-query", "--project", pid, "--env", "test", "--sql", "DELETE FROM users", ok=False)

    call("write-api-suite", "--project", pid)
    run = call("run-api-suite", "--project", pid, "--env", "test")
    assert run["passed"] == 1 and run["failed"] == 0, run

    Handler.persist = False  # 接口返回成功但没有入库：只有数据库校验能发现
    run = call("run-api-suite", "--project", pid, "--env", "test")
    assert run["failed"] == 1
    msg = call("list-run-results", "--run", run["run_id"])[0]["message"]
    assert "数据库校验失败" in msg and "新用户已入库且为启用状态" in msg


# --------------------------------------------------------------------------- 真实 PostgreSQL / MySQL


def _server_cfg(var, type_):
    raw = os.environ.get(var)
    if not raw:
        pytest.skip(f"未设置 {var}")
    host, port, user, password, database = raw.split(":")
    return db.DbConfig.from_dict("main", {"type": type_, "host": host, "port": int(port), "user": user, "database": database},
                                 password)


@pytest.mark.parametrize("var,type_", [("AITEST_TEST_PG", "postgresql"), ("AITEST_TEST_MYSQL", "mysql")])
def test_real_server(var, type_):
    ro = _server_cfg(var, type_)
    rw = db.DbConfig(**{**ro.__dict__, "readonly": False})
    table = f"aitest_{uuid.uuid4().hex[:8]}"
    db.execute(rw, f"CREATE TABLE {table} (id INT PRIMARY KEY, name VARCHAR(50), amount DECIMAL(10,2), note VARCHAR(50))")
    try:
        db.run_setup({"main": rw}, [
            {"sql": f"INSERT INTO {table} VALUES (:id, :name, :amount, :note)", "params": {"id": 1, "name": "张三", "amount": "12.50", "note": "100%"}},
        ])
        r = db.query(ro, f"SELECT id, name, amount, note FROM {table} WHERE name = :name", {"name": "张三"})
        assert r["rows"] == [{"id": 1, "name": "张三", "amount": 12.5, "note": "100%"}]
        assert db.check({"main": ro}, {"sql": f"SELECT count(*) AS n FROM {table}", "expect": {"value": 1}})["ok"]
        # 连接级只读：即使绕过语句检查也无法写入
        conn = db._Conn(ro, write=False)
        with pytest.raises(db.DbError):
            conn.run(f"DELETE FROM {table}", {})
        conn.close()
        assert db.query(ro, f"SELECT count(*) AS n FROM {table}")["rows"][0]["n"] == 1
    finally:
        db.execute(rw, f"DROP TABLE {table}")
