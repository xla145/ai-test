import json
import sqlite3

from aitest.cli import main
from aitest.models import Project
from aitest.ops import ensure_schema, export_workspace, import_workspace
from aitest.store import Store


def test_old_database_keeps_all_platforms(tmp_path):
    path = tmp_path / "old.sqlite"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, workspace_path TEXT, environments TEXT)")
        conn.execute("INSERT INTO project VALUES ('p', '旧项目', '/ws', '{}')")
    store = Store(path)
    assert store.get_project("p").project_type == "multi"
    store.close()
    reopened = Store(path)
    assert reopened.get_project("p").project_type == "multi"
    reopened.close()


def test_create_update_and_independent_child_types(tmp_path, capsys):
    db = str(tmp_path / "db.sqlite")

    def call(*args, ok=True):
        code = main(["--db", db, *args])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert (code == 0) == ok, out
        return out["data"] if ok else out["error"]

    group = call("init-project", "--name", "产品", "--kind", "group")["id"]
    for type_ in ("app", "web", "api", "multi"):
        p = call("init-project", "--name", type_, "--workspace", str(tmp_path / type_),
                 "--parent", group, "--project-type", type_)
        assert p["project_type"] == type_ and p["parent_id"] == group
        assert call("get-project", "--project", p["id"])["project_type"] == type_
    app = next(p for p in call("list-projects") if p["name"] == "app")
    call("create-case", "--project", app["id"], "--json", json.dumps({
        "title": "登录-成功", "type": "app", "steps": ["登录"], "expected": ["进入首页"],
    }))
    changed = call("update-project", "--project", app["id"], "--project-type", "web")
    assert changed["project_type"] == "web" and changed["parent_id"] == group
    assert len(call("list-cases", "--project", app["id"])) == 1
    assert "子项目" in call("update-project", "--project", group, "--project-type", "app", ok=False)


def test_project_type_survives_workspace_sharing(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    store = Store()
    ensure_schema(store)
    p = store.add_project(Project(name="App", workspace_path=str(ws), project_type="app"))
    export_workspace(store, p.id)
    other = Store()
    ensure_schema(other)
    import_workspace(other, ws)
    assert other.get_project(p.id).project_type == "app"
    local = other.get_project(p.id)
    local.project_type = "web"
    other.add_project(local)
    import_workspace(other, ws)
    assert other.get_project(p.id).project_type == "web"
    # 旧 workspace 未携带测试端时保留旧版本的全部能力。
    meta_path = ws / ".aitest" / "project.json"
    meta = json.loads(meta_path.read_text())
    del meta["project_type"]
    meta_path.write_text(json.dumps(meta))
    legacy = Store()
    ensure_schema(legacy)
    import_workspace(legacy, ws)
    assert legacy.get_project(p.id).project_type == "multi"
