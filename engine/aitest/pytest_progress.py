"""Structured, payload-free progress; emit once after all three runtest phases."""
import json
import sys

PREFIX = "AITEST_PROGRESS:"
_cases = {}
_phases = {}


def pytest_sessionstart(session):
    _cases.clear()
    _phases.clear()


def pytest_collection_finish(session):
    for item in session.items:
        case = getattr(getattr(item, "callspec", None), "params", {}).get("case")
        _cases[item.nodeid] = str(case.get("case_id")) if isinstance(case, dict) and case.get("case_id") else item.nodeid


def pytest_runtest_logreport(report):
    phases = _phases.setdefault(report.nodeid, [])
    phases.append((report.when, report.outcome, report.duration))
    if report.when != "teardown":
        return
    status = "passed"
    if any(outcome == "failed" and when != "call" for when, outcome, _ in phases):
        status = "error"
    elif any(outcome == "failed" for _, outcome, _ in phases):
        status = "failed"
    elif any(outcome == "skipped" for _, outcome, _ in phases):
        status = "skipped"
    event = {"kind": "case", "data": {"caseId": _cases.get(report.nodeid, report.nodeid),
             "status": status, "duration": sum(duration for _, _, duration in phases)}}
    sys.__stderr__.write(PREFIX + json.dumps(event, ensure_ascii=True) + "\n")
    sys.__stderr__.flush()
    _phases.pop(report.nodeid, None)
