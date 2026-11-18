"""Tests for engine/aitest/perf.py — scenario compilation, baseline, comparison, trend."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from aitest.models import ApiSpec, TestCase
from aitest.store import Store
from aitest import perf


@pytest.fixture()
def store():
    return Store(":memory:")


# ---- compile_case ----

def test_compile_single_api(store):
    tc = TestCase(title="创建订单", project_id="proj_test", type="api", execution_mode="api")
    tc.api = ApiSpec(method="POST", path="/orders", body={"goodsId": 1001},
                     extract={"orderId": "data.orderId"}, role="buyer")
    store.upsert_case(tc, validate=False)
    result = perf.compile_case(store, tc.id)
    assert len(result["steps"]) == 1
    step = result["steps"][0]
    assert step["method"] == "POST"
    assert step["path"] == "/orders"
    assert step["body"] == {"goodsId": 1001}
    assert step["extract"] == {"orderId": "data.orderId"}
    assert step["role"] == "buyer"


def test_compile_api_flow(store):
    tc = TestCase(title="订单流程", project_id="proj_test", type="api", execution_mode="api")
    tc.api_flow = [
        ApiSpec(method="POST", path="/orders", body={"goodsId": 1}, name="下单",
                extract={"orderId": "data.orderId"}),
        ApiSpec(method="GET", path="/orders/${orderId}", name="查询"),
        ApiSpec(method="DELETE", path="/orders/${orderId}", name="取消"),
    ]
    store.upsert_case(tc, validate=False)
    result = perf.compile_case(store, tc.id)
    assert len(result["steps"]) == 3
    assert result["steps"][0]["name"] == "1-下单"
    assert result["steps"][1]["method"] == "GET"
    assert result["steps"][2]["method"] == "DELETE"


def test_compile_no_api_raises(store):
    tc = TestCase(title="纯 UI 用例", project_id="proj_test", type="ui", execution_mode="ui")
    store.upsert_case(tc, validate=False)
    with pytest.raises(ValueError, match="没有可执行的接口配置"):
        perf.compile_case(store, tc.id)


def test_compile_nonexistent_case_raises(store):
    with pytest.raises(KeyError, match="用例不存在"):
        perf.compile_case(store, "tc_nonexistent")


# ---- compare_results ----

def _result(p95=200, rps=10, fail=0.005, **kw):
    return {"p95Ms": p95, "requestsPerSecond": rps, "failureRate": fail, **kw}


def test_compare_no_degradation():
    r = perf.compare_results(_result(p95=210, rps=9.5, fail=0.006), _result())
    assert r["degraded"] is False
    assert len(r["details"]) == 0


def test_compare_p95_degradation():
    r = perf.compare_results(_result(p95=260), _result(p95=200))
    assert r["degraded"] is True
    assert any("P95" in d for d in r["details"])


def test_compare_rps_degradation():
    r = perf.compare_results(_result(rps=7), _result(rps=10))
    assert r["degraded"] is True
    assert any("RPS" in d for d in r["details"])


def test_compare_failure_rate_spike():
    r = perf.compare_results(_result(fail=0.03), _result(fail=0.005))
    assert r["degraded"] is True
    assert any("失败率" in d for d in r["details"])


def test_compare_zero_baseline_failure():
    r = perf.compare_results(_result(fail=0.02), _result(fail=0))
    assert r["degraded"] is True


def test_compare_multiple_degradation():
    r = perf.compare_results(_result(p95=400, rps=5, fail=0.05), _result(p95=200, rps=10, fail=0.005))
    assert r["degraded"] is True
    assert len(r["details"]) >= 3


# ---- trend_data ----

def test_trend_data(tmp_path):
    d = tmp_path / "reports" / "performance"
    d.mkdir(parents=True)
    for i in range(3):
        (d / f"perf-run{i}.json").write_text(json.dumps({
            "id": f"perf-run{i}", "options": {"path": "/api", "method": "GET"},
            "startedAt": f"2026-11-{15+i:02d}T10:00:00Z",
            "p95Ms": 200 + i * 50, "requestsPerSecond": 10 - i, "failureRate": 0.01 * i,
            "status": "passed" if i < 2 else "failed",
        }))
    result = perf.trend_data(str(tmp_path))
    assert len(result) == 3
    # trend_data sorts ascending by startedAt (oldest first, for chart x-axis)
    assert result[0]["id"] == "perf-run0"
    assert result[2]["id"] == "perf-run2"


def test_trend_data_filter_by_path(tmp_path):
    d = tmp_path / "reports" / "performance"
    d.mkdir(parents=True)
    (d / "perf-a.json").write_text(json.dumps({
        "id": "perf-a", "options": {"path": "/api/a", "method": "GET"},
        "startedAt": "2026-11-16T10:00:00Z", "p95Ms": 200, "requestsPerSecond": 10,
        "failureRate": 0.0, "status": "passed",
    }))
    (d / "perf-b.json").write_text(json.dumps({
        "id": "perf-b", "options": {"path": "/api/b", "method": "POST"},
        "startedAt": "2026-11-16T11:00:00Z", "p95Ms": 300, "requestsPerSecond": 8,
        "failureRate": 0.01, "status": "passed",
    }))
    result = perf.trend_data(str(tmp_path), target_path="/api/a")
    assert len(result) == 1
    assert result[0]["id"] == "perf-a"


# ---- baseline roundtrip ----

def test_baseline_roundtrip(store):
    perf.save_baseline(store, "proj_1", "GET:/health", "perf-abc")
    b = perf.get_baseline(store, "proj_1", "GET:/health")
    assert b is not None
    assert b["result_id"] == "perf-abc"


def test_baseline_overwrite(store):
    perf.save_baseline(store, "proj_1", "GET:/health", "perf-old")
    perf.save_baseline(store, "proj_1", "GET:/health", "perf-new")
    b = perf.get_baseline(store, "proj_1", "GET:/health")
    assert b["result_id"] == "perf-new"


def test_baseline_not_found(store):
    b = perf.get_baseline(store, "proj_1", "GET:/nonexistent")
    assert b is None
