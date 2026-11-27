"""The local bridge for the dashboard's reverse-api-engineer window (rae_bridge.py)."""

import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FAKE = str(Path(__file__).resolve().parent / "fake_rae.py")
ORIGIN = "https://spir.example"
TOKEN = "t" * 32


def load(tmp_path, monkeypatch):
    monkeypatch.setenv("SPIR_RAE_HOME", str(tmp_path / "spir"))
    monkeypatch.setenv("RAE_HOME", str(tmp_path / "rae"))
    spec = importlib.util.spec_from_file_location("rae_bridge", ROOT / "rae_bridge.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def server(tmp_path, monkeypatch):
    mod = load(tmp_path, monkeypatch)
    bridge = mod.Bridge(mod.Rae(FAKE))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), mod.make_handler(bridge, TOKEN, [ORIGIN]))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield mod, base, tmp_path
    httpd.shutdown()


def call(base, method, path, body=None, token=TOKEN, origin=ORIGIN):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if origin:
        headers["Origin"] = origin
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)


def test_token_and_origin_are_required(server):
    _, base, _ = server
    assert call(base, "GET", "/health", token=None)[0] == 200
    assert call(base, "GET", "/status", token=None)[0] == 401
    assert call(base, "GET", "/status", token="wrong")[0] == 401
    # Another website open in the same browser cannot use the bridge, even with the token.
    assert call(base, "GET", "/status", origin="https://evil.example")[0] == 403
    status, body, headers = call(base, "GET", "/status")
    assert status == 200 and body["rae"].startswith("reverse-api-engineer 9.9.9")
    assert headers["Access-Control-Allow-Origin"] == ORIGIN


def test_private_network_preflight(server):
    _, base, _ = server
    req = urllib.request.Request(
        base + "/status",
        method="OPTIONS",
        headers={"Origin": ORIGIN, "Access-Control-Request-Private-Network": "true"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        assert r.status == 204
        assert r.headers["Access-Control-Allow-Private-Network"] == "true"


def test_settings_and_keys_stay_local(server):
    _, base, tmp = server
    status, body, _ = call(
        base,
        "PUT",
        "/config",
        {"sdk": "opencode", "opencode_model": "big-pickle", "output_language": "typescript"},
    )
    assert status == 200 and body["config"]["sdk"] == "opencode"
    config = json.loads((tmp / "rae" / "config.json").read_text())
    assert config["opencode_model"] == "big-pickle"
    assert call(base, "PUT", "/config", {"sdk": "something-else"})[0] == 400
    assert call(base, "PUT", "/config", {"opencode_model": "bad model; rm -rf"})[0] == 400

    status, body, _ = call(base, "PUT", "/keys", {"ANTHROPIC_API_KEY": "sk-ant-secret"})
    assert status == 200 and body["keys"]["ANTHROPIC_API_KEY"] is True
    assert "sk-ant-secret" not in json.dumps(body)
    assert call(base, "PUT", "/keys", {"PATH": "/tmp"})[0] == 400
    if os.name != "nt":
        assert oct((tmp / "spir" / "keys.json").stat().st_mode & 0o777) == "0o600"
    # The CLI receives the key as an environment variable.
    status, body, _ = call(
        base, "POST", "/dry-run", {"url": "https://example.com", "prompt": "items"}
    )
    assert status == 200 and body["result"]["would_run"]["key"] == "sk-"


def test_meta_and_tiktok_sites_are_refused(server):
    _, base, _ = server
    for url in ("https://www.instagram.com/x/", "https://m.facebook.com", "https://tiktok.com/@a"):
        status, body, _ = call(base, "POST", "/jobs", {"url": url, "prompt": "followers"})
        assert status == 403, url
    assert call(base, "POST", "/jobs", {"url": "file:///etc/passwd", "prompt": "x"})[0] == 400
    assert call(base, "POST", "/jobs", {"url": "https://example.com", "prompt": ""})[0] == 400


def test_capture_progress_history_and_files(server):
    _, base, _ = server
    status, body, _ = call(
        base,
        "POST",
        "/jobs",
        {"url": "https://example.com/jobs", "prompt": "open roles", "headless": True},
    )
    assert status == 202
    job = body["job_id"]
    # One capture at a time.
    assert call(base, "POST", "/jobs", {"url": "https://example.com", "prompt": "x"})[0] == 409
    for _ in range(50):
        state = call(base, "GET", f"/jobs/{job}")[1]
        if state["done"]:
            break
        time.sleep(0.1)
    assert state["exit_code"] == 0 and state["result"]["status"] == "ok"
    run_id = state["result"]["run_id"]
    assert [e["event"] for e in state["events"]][-1] == "result"
    assert call(base, "GET", f"/jobs/{job}?from=99")[1]["events"] == []

    runs = call(base, "GET", "/runs?search=open")[1]["runs"]
    assert [r["run_id"] for r in runs] == [run_id]
    files = call(base, "GET", f"/runs/{run_id}/files")[1]["files"]
    assert sorted(f["name"] for f in files) == [
        "README.md",
        "api_client.ts",
    ]  # dotfiles are not shown
    assert "fetch(" in next(f for f in files if f["name"] == "api_client.ts")["content"]
    assert call(base, "GET", "/runs/..%2F..%2Fetc/files")[0] == 400

    status, body, _ = call(
        base, "POST", f"/runs/{run_id}/engineer", {"prompt": "add pagination", "fresh": True}
    )
    assert status == 202


def test_local_mcp_server(tmp_path):
    env = {**os.environ, "SPIR_RAE_HOME": str(tmp_path / "spir"), "RAE_HOME": str(tmp_path / "rae")}
    p = subprocess.Popen(
        [sys.executable, str(ROOT / "rae_bridge.py"), "mcp", "--rae", FAKE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        env=env,
    )

    def rpc(i, method, params=None):
        p.stdin.write(
            json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n"
        )
        p.stdin.flush()
        return json.loads(p.stdout.readline())

    try:
        assert rpc(1, "initialize")["result"]["serverInfo"]["name"].startswith(
            "reverse-api-engineer"
        )
        names = [t["name"] for t in rpc(2, "tools/list")["result"]["tools"]]
        assert "rae_capture" in names and "rae_files" in names
        out = rpc(
            3,
            "tools/call",
            {"name": "rae_capture", "arguments": {"url": "https://example.com", "prompt": "items"}},
        )
        result = json.loads(out["result"]["content"][0]["text"])
        assert result["result"]["status"] == "ok"
        refused = rpc(
            4,
            "tools/call",
            {"name": "rae_capture", "arguments": {"url": "https://instagram.com/a", "prompt": "x"}},
        )
        assert refused["result"]["isError"] is True
    finally:
        p.stdin.close()
        p.wait(timeout=10)


def test_relay_seal_is_authenticated(tmp_path, monkeypatch):
    mod = load(tmp_path, monkeypatch)
    keys = mod.relay_keys("s" * 32)
    assert keys["topic"].startswith("spir-rae-") and "s" * 8 not in keys["topic"]
    sealed = mod.seal_relay(keys, {"id": "1", "text": "مرحبا"})
    assert mod.open_relay(keys, sealed) == {"id": "1", "text": "مرحبا"}
    assert mod.open_relay(mod.relay_keys("t" * 32), sealed) is None  # another secret
    raw = bytearray(mod._unb64(sealed))
    raw[-1] ^= 1
    assert mod.open_relay(keys, mod._b64(bytes(raw))) is None  # altered


def test_relay_runs_a_request_and_reports_twice(tmp_path, monkeypatch):
    from http.server import BaseHTTPRequestHandler

    mod = load(tmp_path, monkeypatch)
    secret = "r" * 32
    keys = mod.relay_keys(secret)
    reports = []

    class Platform(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert self.headers["Authorization"] == "Bearer " + keys["token"]
            reports.append(mod.open_relay(keys, body["sealed"]))
            self.send_response(200)
            self.end_headers()

    platform = ThreadingHTTPServer(("127.0.0.1", 0), Platform)
    threading.Thread(target=platform.serve_forever, daemon=True).start()
    try:
        bridge = mod.Bridge(mod.Rae(FAKE))
        relay = mod.Relay(bridge, secret, f"http://127.0.0.1:{platform.server_address[1]}")
        now = int(time.time() * 1000)
        message = {
            "v": 1,
            "id": "job-1",
            "at": now,
            "kind": "agent",
            "url": "https://example.com",
            "prompt": "items",
        }
        relay.handle(mod.seal_relay(keys, message))
        relay.handle(mod.seal_relay(keys, message))  # the same request again is ignored
        relay.handle(
            mod.seal_relay(keys, {**message, "id": "old", "at": now - 2 * 3600_000})
        )  # too old
        relay.handle("not-sealed")
        for _ in range(100):
            if any(r and r["status"] == "done" for r in reports):
                break
            time.sleep(0.1)
        assert [r["status"] for r in reports] == ["accepted", "done"]
        done = reports[-1]
        assert done["id"] == "job-1" and done["result"]["status"] == "ok"
        assert any(f["name"] == "api_client.ts" for f in done["files"])

        # A refused site is reported as failed, without running anything.
        reports.clear()
        relay.handle(
            mod.seal_relay(keys, {**message, "id": "job-2", "url": "https://instagram.com/x"})
        )
        for _ in range(50):
            if reports:
                break
            time.sleep(0.1)
        assert reports[0]["status"] == "failed" and "instagram.com" in reports[0]["error"]
    finally:
        platform.shutdown()


def test_relay_listens_on_the_ntfy_stream(tmp_path, monkeypatch):
    """The ntfy JSON stream: one line per event, as https://ntfy.sh/<topic>/json sends it."""
    from http.server import BaseHTTPRequestHandler

    mod = load(tmp_path, monkeypatch)
    secret = "n" * 32
    keys = mod.relay_keys(secret)
    reports, paths = [], []
    sealed = mod.seal_relay(
        keys,
        {
            "v": 1,
            "id": "s1",
            "at": int(time.time() * 1000),
            "kind": "agent",
            "url": "https://example.com",
            "prompt": "items",
        },
    )

    class Both(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):  # noqa: N802 - the ntfy subscription
            paths.append(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            for event in (
                {"id": "o1", "event": "open", "topic": keys["topic"]},
                {"id": "k1", "event": "keepalive"},
                {"id": "m1", "event": "message", "topic": keys["topic"], "message": sealed},
            ):
                self.wfile.write((json.dumps(event) + "\n").encode())
                self.wfile.flush()
            time.sleep(1)

        def do_POST(self):  # noqa: N802 - the platform's report route
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            reports.append(mod.open_relay(keys, body["sealed"]))
            self.send_response(200)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Both)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        relay = mod.Relay(mod.Bridge(mod.Rae(FAKE)), secret, base, ntfy=base)
        relay.start()
        for _ in range(100):
            if any(r and r["status"] == "done" for r in reports):
                break
            time.sleep(0.1)
        assert [r["status"] for r in reports][:2] == ["accepted", "done"]
        assert paths[0].startswith(f"/{keys['topic']}/json?since=")
        assert relay.state["last"]
    finally:
        server.shutdown()
