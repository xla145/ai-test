import json
import subprocess
import sys
from types import SimpleNamespace

import pytest
from aitest import pytest_progress
from aitest.runner import EnvConfig, run_pytest


@pytest.mark.parametrize("phases,status", [
    ([("setup", "passed"), ("call", "passed"), ("teardown", "passed")], "passed"),
    ([("setup", "failed"), ("teardown", "passed")], "error"),
    ([("setup", "passed"), ("call", "failed"), ("teardown", "passed")], "failed"),
    ([("setup", "passed"), ("call", "passed"), ("teardown", "failed")], "error"),
    ([("setup", "skipped"), ("teardown", "passed")], "skipped"),
])
def test_phases_emit_exactly_once_after_teardown(monkeypatch, phases, status):
    import io
    stream = io.StringIO()
    monkeypatch.setattr(sys, "__stderr__", stream)
    pytest_progress.pytest_sessionstart(None)
    for when, outcome in phases:
        pytest_progress.pytest_runtest_logreport(SimpleNamespace(nodeid="case", when=when, outcome=outcome, duration=.1))
        if when != "teardown":
            assert stream.getvalue() == ""
    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    event = json.loads(lines[0].removeprefix("AITEST_PROGRESS:"))
    assert event["data"]["status"] == status
    assert event["data"]["duration"] == pytest.approx(.1 * len(phases))
    assert set(event["data"]) == {"caseId", "status", "duration"}


def test_real_pytest_stream_retains_final_junit_and_selection(tmp_path, monkeypatch, capsys):
    suite = tmp_path / "suite"
    suite.mkdir()
    (suite / "test_sample.py").write_text('''import pytest
@pytest.mark.parametrize("case", [{"case_id": "one"}, {"case_id": "two"}], ids=["one", "two"])
def test_cases(case):
    assert case["case_id"] == "one"
''')
    monkeypatch.setenv("AITEST_PROGRESS", "1")
    run, results = run_pytest(suite, EnvConfig("http://127.0.0.1"), case_ids=["one"])
    events = [json.loads(line.removeprefix("AITEST_PROGRESS:")) for line in capsys.readouterr().err.splitlines() if line.startswith("AITEST_PROGRESS:")]
    assert len(events) == 1
    assert events[0]["data"]["caseId"] == "one"
    assert events[0]["data"]["status"] == "passed"
    assert run.result["total"] == 1
    assert results[0].case_id == "one"
    assert run.result["exit_code"] == 0


def test_stream_timeout_reaps_child(tmp_path):
    from aitest.process_stream import run_streaming
    with pytest.raises(subprocess.TimeoutExpired):
        run_streaming([sys.executable, "-c", "import time; time.sleep(10)"], cwd=tmp_path, env={}, timeout=.05)
