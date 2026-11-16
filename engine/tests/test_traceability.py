import hashlib
import json

import pytest

from aitest.models import Project, Requirement, Run, RunResult, Script, TestCase
from aitest.store import Store
from aitest.traceability import coverage
from aitest.artifacts import fingerprint


def fixture(tmp_path):
    store = Store()
    project = store.add_project(Project(name="p", workspace_path=str(tmp_path), environments={"test": {"base_url": "http://localhost"}}))
    case = store.upsert_case(TestCase(title="列表-查询", project_id=project.id, status="reviewed", steps=["查询"], expected=["显示记录"], lint_status="passed"))
    code = "await page.getByTestId('search').click();"
    path = tmp_path / "a.spec.ts"
    path.write_text(code)
    digest = hashlib.sha256(code.encode()).hexdigest()
    (tmp_path / "a.steps.json").write_text(json.dumps({"specHash": digest, "source": {"steps": case.steps, "expected": case.expected, "preconditions": []}, "steps": [{"id": "s1", "caseStep": 1, "action": "expectVisible", "expectedIndices": [1]}]}))
    store.upsert_script(Script(case_id=case.id, path="a.spec.ts", framework="playwright"))
    run = Run(project_id=project.id, env="test", started_at="2026-11-16T00:00:00Z")
    store.save_run(run, [RunResult(run_id=run.id, case_id=case.id, status="passed", execution_context={"artifact": {"script_hash": digest, "environment_fingerprint": fingerprint(project.environments['test'])}})])
    return store, project, case, path


def test_tracks_real_source_mapping_and_environment(tmp_path):
    store, project, case, path = fixture(tmp_path)
    report = coverage(store, project.id, "test")
    assert report['cases'][0]['lifecycle'] == 'validated'
    assert report['cases'][0]['blockers'] == []
    project.environments['test']['base_url'] = 'http://different'
    store.add_project(project)
    assert '执行环境已变化或缺少环境版本证据' in coverage(store, project.id, 'test')['cases'][0]['blockers']


def test_stale_spec_and_unmapped_expected_never_count_as_covered(tmp_path):
    store, project, case, path = fixture(tmp_path)
    case.expected.append('新预期')
    store.upsert_case(case)
    path.write_text('changed')
    report = coverage(store, project.id)['cases'][0]
    assert report['lifecycle'] == 'generated'
    assert not report['mappings'][-1]['mapped']
    assert '脚本与结构化步骤不同步' in report['blockers']
    assert '生成时的用例已过期' in report['blockers']


def test_scope_and_malformed_metadata_are_fail_closed(tmp_path):
    store, project, case, path = fixture(tmp_path)
    (tmp_path / 'a.steps.json').write_text('[]')
    assert coverage(store, project.id, 'other')['cases'][0]['latest_run'] is None
    (tmp_path / 'a.steps.json').write_text('{"source": 1, "steps": [{"expectedIndices": 1}]}')
    assert coverage(store, project.id)['cases'][0]['blockers']
    store.upsert_script(Script(case_id=case.id, path='/etc/hosts', framework='playwright'))
    assert '缺少可读取的脚本' in coverage(store, project.id)['cases'][0]['blockers']


def test_requirement_links_cannot_cross_projects(tmp_path):
    store, project, case, path = fixture(tmp_path)
    other = store.add_project(Project(name='other', workspace_path=str(tmp_path / 'other')))
    req = Requirement(project_id=other.id, source_file='req.md', section='A', content='原始要求')
    store.add_requirements([req])
    with pytest.raises(ValueError):
        store.link_requirement(case.id, req.id)


def test_api_mapping_requires_explicit_review_and_invalidates_on_request_change(tmp_path):
    from aitest.models import ApiSpec
    store = Store()
    project = store.add_project(Project(name='api', workspace_path=str(tmp_path)))
    case = store.upsert_case(TestCase(title='用户-查询', project_id=project.id, type='api', execution_mode='api', status='reviewed', steps=['查询用户'], expected=['状态为 200', '用户姓名正确'], api=ApiSpec(method='GET', path='/users')))
    report = coverage(store, project.id)['cases'][0]
    assert not any(m['mapped'] for m in report['mappings'])  # no positional inference
    target = next(t for t in report['mapping_targets'] if t['id'] == 'request-1:status')
    case.coverage_links = [{'kind': 'expected', 'index': 1, 'target': target['id'], 'target_revision': target['revision'], 'source_revision': report['mapping_source_revision']}]
    store.upsert_case(case)
    mappings = coverage(store, project.id)['cases'][0]['mappings']
    assert mappings[1]['mapped'] and not mappings[2]['mapped']
    case.api.path = '/different'
    store.upsert_case(case)
    assert not coverage(store, project.id)['cases'][0]['mappings'][1]['mapped']
