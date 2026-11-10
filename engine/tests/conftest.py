import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
TOKEN = "Bearer secret-token"


class DemoHandler(BaseHTTPRequestHandler):
    """按 fixtures/petstore.yaml 实现的被测服务。BUG_MAX_AGE=True 时故意漏掉 age 上限校验。"""

    users: dict[int, dict] = {}
    next_id = 1
    bug_max_age = False

    def log_message(self, *args):  # 静默
        pass

    def _send(self, code, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(code)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authed(self):
        return self.headers.get("Authorization") == TOKEN

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            return self._send(200, {"status": "ok"})
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        if u.path == "/users":
            q = parse_qs(u.query)
            try:
                limit = int(q["limit"][0])
            except (KeyError, ValueError):
                return self._send(400, {"error": "limit"})
            if not 1 <= limit <= 100:
                return self._send(400, {"error": "limit range"})
            return self._send(200, list(self.users.values())[:limit])
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"null")
        except json.JSONDecodeError:
            return self._send(400, {"error": "json"})
        if not isinstance(body, dict):
            return self._send(400, {"error": "body"})
        name, age = body.get("name"), body.get("age")
        if not isinstance(name, str) or not 2 <= len(name) <= 20:
            return self._send(400, {"error": "name"})
        max_age = 10**6 if DemoHandler.bug_max_age else 150
        if not isinstance(age, int) or isinstance(age, bool) or not 0 <= age <= max_age:
            return self._send(400, {"error": "age"})
        uid = DemoHandler.next_id
        DemoHandler.next_id += 1
        self.users[uid] = {"id": uid, "name": name, "age": age}
        self._send(201, self.users[uid])

    def do_DELETE(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        try:
            uid = int(self.path.rsplit("/", 1)[-1])
        except ValueError:
            return self._send(400, {"error": "id"})
        if self.users.pop(uid, None) is None:
            return self._send(404, {"error": "missing"})
        self._send(204)


@pytest.fixture
def demo_server():
    DemoHandler.users = {}
    DemoHandler.next_id = 1
    DemoHandler.bug_max_age = False
    server = ThreadingHTTPServer(("127.0.0.1", 0), DemoHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", DemoHandler
    server.shutdown()


@pytest.fixture
def openapi_path():
    return FIXTURES / "petstore.yaml"
