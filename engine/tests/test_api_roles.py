"""接口多账号：流程用例（下单 → 支付 → 审核 → 退款），每步用不同角色的凭据。"""

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from aitest.cli import main

ACCOUNTS = {"buyer": "buyer-pw", "ops": "ops-pw"}
ROLE_OF_TOKEN = {"Bearer tok-buyer": "buyer", "Bearer static-ops": "ops"}


class Shop(BaseHTTPRequestHandler):
    """被测服务：买家下单、支付、申请退款；运营审核。登录返回 {"data": {"token": ...}}。"""

    orders: dict[int, dict] = {}
    logins: list[str] = []

    def log_message(self, *args):
        pass

    def _send(self, code, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _role(self):
        return ROLE_OF_TOKEN.get(self.headers.get("Authorization", ""))

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        if self.path == "/login":
            b = self._body()
            if ACCOUNTS.get(b.get("username")) != b.get("password"):
                return self._send(401, {"error": "bad credentials"})
            Shop.logins.append(b["username"])
            return self._send(200, {"data": {"token": f"tok-{b['username']}"}})
        role = self._role()
        if role is None:
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/orders":
            if role != "buyer":
                return self._send(403, {"error": "only buyers order"})
            oid = len(Shop.orders) + 1
            Shop.orders[oid] = {"id": oid, "status": "created", "amount": self._body().get("amount")}
            return self._send(201, Shop.orders[oid])
        m = re.fullmatch(r"/orders/(\d+)/(pay|approve|refund)", self.path)
        if not m or int(m.group(1)) not in Shop.orders:
            return self._send(404, {"error": "not found"})
        order, action = Shop.orders[int(m.group(1))], m.group(2)
        need = {"pay": ("buyer", "created", "paid"), "refund": ("buyer", "paid", "refunding"),
                "approve": ("ops", "refunding", "refunded")}[action]
        if role != need[0]:
            return self._send(403, {"error": f"{action} requires {need[0]}"})
        if order["status"] != need[1]:
            return self._send(409, {"error": f"order is {order['status']}"})
        order["status"] = need[2]
        return self._send(200, order)

    def do_GET(self):
        m = re.fullmatch(r"/orders/(\d+)", self.path)
        if self._role() is None:
            return self._send(401, {"error": "unauthorized"})
        if not m or int(m.group(1)) not in Shop.orders:
            return self._send(404, {"error": "not found"})
        return self._send(200, Shop.orders[int(m.group(1))])


@pytest.fixture
def shop():
    Shop.orders, Shop.logins = {}, []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Shop)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def cli(tmp_path, capsys):
    db = str(tmp_path / "db.sqlite")

    def call(*args, ok=True):
        code = main(["--db", db, *args])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert (code == 0) == ok, out
        return out["data"] if ok else out["error"]

    return call


def step(name, role, method, path, status, **extra):
    return {"name": name, "role": role, "method": method, "path": path, "expected_status": [status], **extra}


REFUND_FLOW = [
    step("买家下单", "buyer", "POST", "/orders", 201, body={"amount": 99}, extract={"order_id": "id"}),
    step("买家支付", "buyer", "POST", "/orders/${order_id}/pay", 200, expected_fields={"status": "paid"}),
    step("买家申请退款", "buyer", "POST", "/orders/${order_id}/refund", 200, expected_fields={"status": "refunding"}),
    step("运营审核退款", "ops", "POST", "/orders/${order_id}/approve", 200, expected_fields={"status": "refunded"}),
    step("买家查看订单", "buyer", "GET", "/orders/${order_id}", 200, expected_fields={"status": "refunded", "amount": 99}),
]


def test_multi_account_flow(cli, shop, tmp_path, monkeypatch):
    project = cli("init-project", "--name", "shop", "--workspace", str(tmp_path / "ws"), "--environments", json.dumps({
        "test": {"base_url": shop, "api_login": {"path": "/login", "token_path": "data.token"}},
    }))
    pid = project["id"]

    def case(title, flow):
        data = {"title": title, "type": "api", "priority": "P0", "steps": [s["name"] for s in flow],
                "expected": ["各步状态码与字段符合预期"], "api_flow": flow}
        return cli("create-case", "--project", pid, "--json", json.dumps(data, ensure_ascii=False))

    ok = case("订单-退款流程", REFUND_FLOW)
    assert ok["execution_mode"] == "api" and [s["role"] for s in ok["api_flow"]] == ["buyer"] * 3 + ["ops", "buyer"]
    # 越权：买家不能审核退款
    forbidden = case("订单-买家越权审核", [
        step("买家下单", "buyer", "POST", "/orders", 201, body={"amount": 1}, extract={"order_id2": "id"}),
        step("买家支付", "buyer", "POST", "/orders/${order_id2}/pay", 200),
        step("买家申请退款", "buyer", "POST", "/orders/${order_id2}/refund", 200),
        step("买家尝试审核", "buyer", "POST", "/orders/${order_id2}/approve", 403),
    ])
    # 写错预期的流程：第 2 步由运营支付，应失败并指出是哪一步、哪个角色
    broken = case("订单-错误的流程", [
        step("买家下单", "buyer", "POST", "/orders", 201, body={"amount": 5}, extract={"order_id3": "id"}),
        step("运营代付", "ops", "POST", "/orders/${order_id3}/pay", 200),
    ])
    for c in (ok, forbidden, broken):
        cli("update-case", "--case", c["id"], "--json", json.dumps({"status": "reviewed"}))

    suite = cli("write-api-suite", "--project", pid)
    assert suite["cases"] == 3
    # 买家：账号密码 + 接口登录换 token；运营：钥匙串中的固定 token
    monkeypatch.setenv("AITEST_ROLES", json.dumps([{"role": "buyer", "username": "buyer", "password": "buyer-pw"}]))
    monkeypatch.setenv("AITEST_ROLE_TOKENS", json.dumps({"ops": "Bearer static-ops"}))
    run = cli("run-api-suite", "--project", pid, "--env", "test")
    results = {r["case_id"]: r for r in cli("list-run-results", "--run", run["run_id"])}
    assert results[ok["id"]]["status"] == "passed"
    assert results[forbidden["id"]]["status"] == "passed"
    assert results[broken["id"]]["status"] == "failed"
    msg = results[broken["id"]]["message"]
    assert "第 2 步「运营代付」（角色：ops）" in msg and "状态码 403" in msg
    assert Shop.logins == ["buyer"]  # 每个角色只登录一次
    assert Shop.orders[1]["status"] == "refunded"


def test_missing_role_credentials_fail_clearly(cli, shop, tmp_path, monkeypatch):
    project = cli("init-project", "--name", "shop", "--workspace", str(tmp_path / "ws"),
                  "--environments", json.dumps({"test": {"base_url": shop}}))
    data = {"title": "订单-运营审核", "type": "api", "priority": "P1", "steps": ["审核"], "expected": ["成功"],
            "api_flow": [step("运营审核", "ops", "POST", "/orders/1/approve", 200)]}
    c = cli("create-case", "--project", project["id"], "--json", json.dumps(data, ensure_ascii=False))
    cli("update-case", "--case", c["id"], "--json", json.dumps({"status": "reviewed"}))
    cli("write-api-suite", "--project", project["id"])
    # 只有账号密码、没有配置接口登录
    monkeypatch.setenv("AITEST_ROLES", json.dumps([{"role": "ops", "username": "ops", "password": "ops-pw"}]))
    monkeypatch.delenv("AITEST_ROLE_TOKENS", raising=False)
    run = cli("run-api-suite", "--project", project["id"], "--env", "test")
    msg = cli("list-run-results", "--run", run["run_id"])[0]["message"]
    assert "没有配置接口登录" in msg
    monkeypatch.setenv("AITEST_ROLES", "[]")
    run = cli("run-api-suite", "--project", project["id"], "--env", "test")
    assert "没有接口凭据" in cli("list-run-results", "--run", run["run_id"])[0]["message"]
