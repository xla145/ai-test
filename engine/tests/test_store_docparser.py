import pytest

from aitest.docparser import parse_requirement, split_sections
from aitest.models import AgentSession, Project, TestCase
from aitest.store import CaseValidationError, Store

MD = """# 特征中心
概述
## 标签管理
停用标签后推荐人群同步变化。
```
# 不是标题
```
### 权限
四个角色。
## 推荐配置
配置项。
"""


def test_split_sections():
    secs = split_sections(MD)
    assert [s.title for s in secs] == ["特征中心", "标签管理", "权限", "推荐配置"]
    assert secs[2].path == ["特征中心", "标签管理", "权限"]
    assert "# 不是标题" in secs[1].content


def test_parse_requirement_file(tmp_path):
    f = tmp_path / "req.md"
    f.write_text(MD, encoding="utf-8")
    reqs = parse_requirement(f, "p1")
    assert reqs[3].section == "特征中心 / 推荐配置"


def test_store_roundtrip_and_validation():
    s = Store()
    p = s.add_project(Project(name="demo", workspace_path="/tmp/ws", environments={"test": {"base_url": "x"}}))
    assert s.get_project(p.id).environments["test"]["base_url"] == "x"
    c = TestCase(title="模块-场景", project_id=p.id, steps=["a"], expected=["b"], priority="P1")
    s.upsert_case(c)
    s.link_requirement(c.id, "req_1")
    assert s.get_case(c.id).requirement_ids == ["req_1"]
    assert len(s.list_cases(p.id, priority="P1")) == 1
    with pytest.raises(CaseValidationError):
        s.upsert_case(TestCase(title="", project_id=p.id, steps=[], expected=[], priority="P9"))
    s.add_agent_session(AgentSession(codex_thread_id="t1", purpose="case_gen", project_id=p.id))
    sid = s.conn.execute("SELECT id FROM agent_session").fetchone()[0]
    s.add_token_usage(sid, 1200)
    assert s.project_token_usage(p.id) == 1200
