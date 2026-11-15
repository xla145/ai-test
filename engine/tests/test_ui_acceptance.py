import json
import sqlite3
import pytest
from aitest.cli import main
from aitest.store import Store, SCHEMA

@pytest.fixture
def cli(tmp_path, capsys):
    def call(*args):
        code = main(['--db', str(tmp_path / 'db.sqlite'), *args])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert code == 0, out
        return out['data']
    return call

def test_migrates_old_results_without_upgrading_acceptance(tmp_path):
    path = tmp_path / 'old.sqlite'
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.execute("INSERT INTO run_result VALUES ('r','c','passed',1,'','[]',NULL)")
    conn.commit(); conn.close()
    store = Store(path)
    result = store.list_run_results('r')[0]
    assert result.status == 'passed' and result.acceptance_status == ''
    store.close()

def test_aggregates_case_results_and_reconciles_exact_run_reviews(cli, tmp_path):
    pid = cli('init-project','--name','acceptance','--workspace',str(tmp_path/'ws'),'--environments','{"test":{"base_url":"http://sut"}}')['id']
    cid = cli('create-case','--project',pid,'--json',json.dumps({'title':'check','type':'ui','priority':'P1','steps':['open'],'expected':['visible']}))['id']
    def save(items):
        path = tmp_path/'results.json'; path.write_text(json.dumps(items))
        return cli('save-run','--project',pid,'--env','test','--results-file',str(path),'--framework','playwright')
    failed = save([{'case_id':cid,'status':'failed','acceptance_status':'failed','duration':1,'execution_context':{'sessions':[{'role':'admin'}]}}, {'case_id':cid,'status':'passed','acceptance_status':'verified_pass','duration':2,'execution_context':{'sessions':[{'role':'viewer'}]}}])
    assert failed['total'] == 1 and failed['failed'] == 1 and failed['acceptance'] == {'failed':1}
    result = cli('list-run-results','--run',failed['run_id'])[0]
    assert result['duration'] == 3 and result['status'] == 'failed'
    assert result['execution_context']['sessions'] == [{'role':'admin'}, {'role':'viewer'}]
    review_run = save([{'case_id':cid,'status':'passed','acceptance_status':'pending_review','reviews':[{'description':'visible','kind':'visual'}]}])
    assert review_run['acceptance'] == {'pending_review':1}
    review = cli('list-reviews','--project',pid)[0]
    cli('resolve-review','--id',review['id'],'--passed')
    assert cli('list-run-results','--run',review_run['run_id'])[0]['acceptance_status'] == 'verified_pass'
    assert cli('list-run-results','--run',failed['run_id'])[0]['acceptance_status'] == 'failed'
    detail = cli('run-detail','--run',review_run['run_id'])
    assert detail['summary']['acceptance'] == {'verified_pass':1}
    incomplete = save([{'case_id':cid,'status':'passed','acceptance_status':'incomplete','reviews':[{'description':'uncovered','kind':'visual'}]}])
    last_review = cli('list-reviews','--project',pid)[-1]
    cli('resolve-review','--id',last_review['id'],'--passed')
    assert cli('list-run-results','--run',incomplete['run_id'])[0]['acceptance_status'] == 'incomplete'
