#!/usr/bin/env python3
"""Local bridge between the dashboard's «reverse-api-engineer» window and the
reverse-api-engineer CLI (https://github.com/kalil0321/reverse-api-engineer).

Everything runs on this computer: the browser capture, the AI model and the
generated clients. The dashboard page talks to this bridge directly from your
browser (http://127.0.0.1), so nothing goes through the platform's servers.

Run it:
    python rae_bridge.py --origin https://your-app.vercel.app

Then paste the pairing token it prints into the window. Standard library only;
Python 3.9+ for the bridge, 3.11+ for reverse-api-engineer itself.

Safety:
- listens on 127.0.0.1 only, and answers only your platform's origin;
- every request needs the pairing token (kept in ~/.spir-rae/token);
- provider keys are kept in ~/.spir-rae/keys.json (readable by you only) and
  passed to the CLI as environment variables; they are never sent back;
- Instagram, TikTok and Meta sites are refused (their internal APIs are not
  for use without their permission);
- generated code is shown and downloadable, never run by the bridge.

Also a local MCP server for Claude Desktop / Claude Code:
    python rae_bridge.py mcp

And, to use it from claude.ai in any browser, through a free ntfy topic:
    python rae_bridge.py --origin https://your-app.vercel.app --relay <RAE_RELAY_SECRET>
The bridge then waits on ntfy (never on the platform) for sealed requests the
platform's MCP tools send, runs them here, and reports back twice per run.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

VERSION = "1.0.0"
DEFAULT_PORT = 7466
HOME = Path(os.environ.get("SPIR_RAE_HOME", str(Path.home() / ".spir-rae")))
RAE_HOME = Path(os.environ.get("RAE_HOME", str(Path.home() / ".reverse-api")))

# Sites whose internal APIs must not be used without their permission.
BLOCKED_HOSTS = (
    "instagram.com",
    "cdninstagram.com",
    "tiktok.com",
    "facebook.com",
    "fb.com",
    "messenger.com",
    "threads.net",
    "threads.com",
    "whatsapp.com",
)

# reverse-api-engineer settings the window may change (~/.reverse-api/config.json).
CONFIG_ENUMS = {
    "sdk": ("claude", "opencode", "codex", "cursor", "copilot"),
    "agent_provider": ("auto", "chrome-mcp", "agent-browser"),
    "output_language": (
        "python",
        "javascript",
        "typescript",
        "go",
        "java",
        "csharp",
        "php",
        "ruby",
        "c",
        "powershell",
    ),
}
CONFIG_TEXT = (
    "claude_code_model",
    "opencode_provider",
    "opencode_model",
    "codex_model",
    "cursor_model",
    "copilot_model",
)

# Provider keys the window may save, by the name each SDK reads.
KEY_NAMES = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "CURSOR_API_KEY",
    "GITHUB_COPILOT_TOKEN",
)

MAX_FILE_BYTES = 512 * 1024
TEXT_SUFFIXES = (
    ".py",
    ".js",
    ".mjs",
    ".ts",
    ".go",
    ".java",
    ".cs",
    ".php",
    ".rb",
    ".c",
    ".h",
    ".ps1",
    ".psm1",
    ".md",
    ".txt",
    ".json",
    ".toml",
    ".yaml",
    ".yml",
    ".mod",
    ".csproj",
    ".xml",
    ".gradle",
)


class BridgeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


# ---- small helpers ----


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    with contextlib.suppress(OSError):  # Windows keeps its own permissions
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_token(fixed: str | None = None) -> str:
    if fixed:
        return fixed
    path = HOME / "token"
    try:
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= 24:
            return token
    except OSError:
        pass
    token = secrets.token_urlsafe(24)
    _write_private(path, token)
    return token


def check_url(url: str) -> str:
    """An http(s) address that is not one of the refused sites."""
    url = (url or "").strip()
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise BridgeError(400, "ضع رابطاً يبدأ بـ https://")
    host = u.hostname.lower().rstrip(".")
    for blocked in BLOCKED_HOSTS:
        if host == blocked or host.endswith("." + blocked):
            raise BridgeError(
                403,
                f"{blocked} غير مسموح: واجهاته الداخلية ليست للاستعمال دون إذنه. "
                "المنصة تقرأ إنستقرام وتيك توك بطرقها العامة.",
            )
    return url


def check_text(value, name: str, limit: int = 2000) -> str:
    text = str(value or "").strip()
    if not text:
        raise BridgeError(400, f"{name} مطلوب")
    if len(text) > limit or "\x00" in text:
        raise BridgeError(400, f"{name} طويل جداً")
    return text


RUN_ID = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


def check_run_id(run_id: str) -> str:
    if not RUN_ID.match(run_id or ""):
        raise BridgeError(400, "معرّف التشغيل غير صالح")
    return run_id


# ---- the CLI ----


class Rae:
    """Runs the reverse-api-engineer CLI (never through a shell)."""

    def __init__(self, command: str = "reverse-api-engineer"):
        self.command = command

    def argv(self, args: list[str]) -> list[str]:
        exe = shutil.which(self.command) or self.command
        if exe.endswith(".py"):
            return [sys.executable, exe, *args]
        return [exe, *args]

    def env(self) -> dict:
        env = dict(os.environ)
        for name, value in _read_json(HOME / "keys.json", {}).items():
            if name in KEY_NAMES and isinstance(value, str) and value:
                env[name] = value
        env.setdefault("NO_COLOR", "1")
        return env

    def call(self, args: list[str], timeout: float = 120) -> tuple[int, str, str]:
        try:
            p = subprocess.run(
                self.argv(args),
                capture_output=True,
                text=True,
                timeout=timeout,
                env=self.env(),
                stdin=subprocess.DEVNULL,
            )
        except FileNotFoundError as err:
            raise BridgeError(
                424,
                "reverse-api-engineer غير مثبّت. ثبّته: uv tool install reverse-api-engineer",
            ) from err
        except subprocess.TimeoutExpired as err:
            raise BridgeError(504, "انتهت مهلة الأمر") from err
        return p.returncode, p.stdout, p.stderr

    def json(self, args: list[str], timeout: float = 120):
        code, out, err = self.call(args, timeout)
        text = out.strip()
        try:
            return json.loads(text) if text else None
        except ValueError:
            # Some commands print several JSON lines; keep the last object.
            for line in reversed(text.splitlines()):
                try:
                    return json.loads(line)
                except ValueError:
                    continue
            raise BridgeError(502, (err or out or f"exit {code}").strip()[-800:]) from None

    def version(self) -> str | None:
        try:
            code, out, err = self.call(["--version"], timeout=30)
        except BridgeError:
            return None
        text = (out or err).strip()
        return text.splitlines()[-1] if code == 0 and text else None


# ---- background runs (one at a time, as the CLI recommends) ----


class Jobs:
    def __init__(self, rae: Rae):
        self.rae = rae
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.dir = HOME / "jobs"

    def running(self) -> str | None:
        with self.lock:
            for job_id, job in self.jobs.items():
                if job["proc"].poll() is None:
                    return job_id
        return None

    def start(self, args: list[str], label: str) -> str:
        if self.running():
            raise BridgeError(409, "يوجد تشغيل جارٍ الآن: انتظر انتهاءه أو أوقفه")
        self.dir.mkdir(parents=True, exist_ok=True)
        job_id = uuid.uuid4().hex[:12]
        out_path = self.dir / f"{job_id}.ndjson"
        log_path = self.dir / f"{job_id}.log"
        # Kept open while the run writes to them; closed once it ends (see get()).
        out = open(out_path, "w", encoding="utf-8")  # noqa: SIM115
        log = open(log_path, "w", encoding="utf-8")  # noqa: SIM115
        try:
            proc = subprocess.Popen(
                self.rae.argv(args),
                stdout=out,
                stderr=log,
                stdin=subprocess.DEVNULL,
                env=self.rae.env(),
                text=True,
            )
        except FileNotFoundError as err:
            out.close()
            log.close()
            raise BridgeError(
                424,
                "reverse-api-engineer غير مثبّت. ثبّته: uv tool install reverse-api-engineer",
            ) from err
        with self.lock:
            self.jobs[job_id] = {
                "proc": proc,
                "out": out_path,
                "log": log_path,
                "files": (out, log),
                "label": label,
                "started": time.time(),
            }
        return job_id

    def get(self, job_id: str, start: int = 0) -> dict:
        with self.lock:
            job = self.jobs.get(job_id)
        if not job:
            raise BridgeError(404, "تشغيل غير معروف")
        code = job["proc"].poll()
        if code is not None:
            for f in job["files"]:
                if not f.closed:
                    f.close()
        events = []
        try:
            lines = job["out"].read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
        for line in lines[start:]:
            try:
                events.append(json.loads(line))
            except ValueError:
                events.append({"event": "text", "text": line[:2000]})
        try:
            log_tail = job["log"].read_text(encoding="utf-8").splitlines()[-40:]
        except OSError:
            log_tail = []
        result = next((e for e in reversed(events) if e.get("event") == "result"), None)
        return {
            "job_id": job_id,
            "label": job["label"],
            "events": events,
            "next": start + len(events),
            "done": code is not None,
            "exit_code": code,
            "result": result,
            "log": log_tail,
            "seconds": int(time.time() - job["started"]),
        }

    def cancel(self, job_id: str) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
        if not job:
            raise BridgeError(404, "تشغيل غير معروف")
        if job["proc"].poll() is None:
            job["proc"].send_signal(signal.SIGINT if os.name != "nt" else signal.SIGTERM)
            try:
                job["proc"].wait(timeout=10)
            except subprocess.TimeoutExpired:
                job["proc"].kill()


# ---- what the window and the MCP server can do ----


class Bridge:
    def __init__(self, rae: Rae):
        self.rae = rae
        self.jobs = Jobs(rae)
        self.relay: Relay | None = None

    def config_path(self) -> Path:
        return RAE_HOME / "config.json"

    def status(self) -> dict:
        config = _read_json(self.config_path(), {})
        keys = _read_json(HOME / "keys.json", {})
        return {
            "bridge": VERSION,
            "rae": self.rae.version(),
            "config": {k: config.get(k) for k in (*CONFIG_ENUMS, *CONFIG_TEXT, "output_dir")},
            "keys": {
                name: bool(keys.get(name)) or bool(os.environ.get(name)) for name in KEY_NAMES
            },
            "running": self.jobs.running(),
            "relay": dict(self.relay.state) if self.relay else {"enabled": False},
            "blocked_hosts": list(BLOCKED_HOSTS),
        }

    def set_config(self, body: dict) -> dict:
        config = _read_json(self.config_path(), {})
        for key, allowed in CONFIG_ENUMS.items():
            if key in body:
                if body[key] not in allowed:
                    raise BridgeError(400, f"قيمة غير صالحة لـ {key}")
                config[key] = body[key]
        for key in CONFIG_TEXT:
            if key in body:
                value = body[key]
                if value in (None, ""):
                    config[key] = None
                elif isinstance(value, str) and re.match(r"^[\w./:@+-]{1,120}$", value):
                    config[key] = value
                else:
                    raise BridgeError(400, f"قيمة غير صالحة لـ {key}")
        _write_private(self.config_path(), json.dumps(config, indent=2, ensure_ascii=False))
        return self.status()

    def set_keys(self, body: dict) -> dict:
        keys = _read_json(HOME / "keys.json", {})
        for name, value in body.items():
            if name not in KEY_NAMES:
                raise BridgeError(400, f"مفتاح غير معروف: {name}")
            if value in (None, ""):
                keys.pop(name, None)
            elif isinstance(value, str) and len(value) < 500 and "\n" not in value:
                keys[name] = value.strip()
            else:
                raise BridgeError(400, f"قيمة غير صالحة لـ {name}")
        _write_private(HOME / "keys.json", json.dumps(keys))
        return self.status()

    def agent_args(self, body: dict, extra: list[str]) -> list[str]:
        args = [
            "agent",
            "-p",
            check_text(body.get("prompt"), "الهدف"),
            "-u",
            check_url(body.get("url")),
            *extra,
        ]
        if body.get("headless"):
            args.append("--headless")
        model = body.get("model")
        if model:
            if not isinstance(model, str) or not re.match(r"^[\w./:@+-]{1,120}$", model):
                raise BridgeError(400, "اسم النموذج غير صالح")
            args += ["-m", model]
        return args

    def dry_run(self, body: dict):
        return self.rae.json(self.agent_args(body, ["--dry-run", "--json"]), timeout=180)

    def start_agent(self, body: dict) -> dict:
        args = self.agent_args(body, ["--json-stream"])
        return {"job_id": self.jobs.start(args, f"agent: {body.get('url')}")}

    def start_engineer(self, run_id: str, body: dict) -> dict:
        args = ["engineer", check_run_id(run_id), "--json-stream"]
        if body.get("prompt"):
            args += ["-p", check_text(body.get("prompt"), "التعليمات")]
        if body.get("fresh"):
            args.append("--fresh")
        return {"job_id": self.jobs.start(args, f"engineer: {run_id}")}

    def list_runs(self, search: str | None = None):
        args = ["list", "--json"]
        if search:
            args += ["--search", check_text(search, "البحث", 200)]
        return self.rae.json(args)

    def show(self, run_id: str):
        return self.rae.json(["show", check_run_id(run_id), "--json"])

    def script_dir(self, run_id: str, show: dict | None) -> Path | None:
        roots = [RAE_HOME / "runs"]
        out_dir = _read_json(self.config_path(), {}).get("output_dir")
        if isinstance(out_dir, str) and out_dir:
            roots.append(Path(out_dir).expanduser())
        candidates: list[Path] = []
        if isinstance(show, dict):
            for key in ("script_path", "scripts_dir", "script_dir"):
                value = show.get(key) or (show.get("run") or {}).get(key)
                if isinstance(value, str) and value:
                    p = Path(value).expanduser()
                    candidates.append(p if p.is_dir() else p.parent)
        candidates += [root / "scripts" / run_id for root in roots]
        for c in candidates:
            try:
                real = c.resolve()
            except OSError:
                continue
            inside = any(
                real == r.resolve() or r.resolve() in real.parents for r in roots if r.exists()
            )
            if inside and real.is_dir():
                return real
        return None

    def files(self, run_id: str) -> dict:
        check_run_id(run_id)
        try:
            show = self.show(run_id)
        except BridgeError:
            show = None
        folder = self.script_dir(run_id, show)
        if not folder:
            return {"run_id": run_id, "folder": None, "files": []}
        out = []
        for path in sorted(folder.rglob("*")):
            if len(out) >= 40:
                break
            if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            if any(
                part.startswith(".") or part == "node_modules"
                for part in path.relative_to(folder).parts
            ):
                continue
            size = path.stat().st_size
            if size > MAX_FILE_BYTES:
                out.append({"name": str(path.relative_to(folder)), "size": size, "content": None})
                continue
            out.append(
                {
                    "name": str(path.relative_to(folder)),
                    "size": size,
                    "content": path.read_text(encoding="utf-8", errors="replace"),
                }
            )
        return {"run_id": run_id, "folder": str(folder), "files": out}


# ---- relay through ntfy (claude.ai → platform MCP → ntfy → this bridge) ----

DEFAULT_NTFY = "https://ntfy.sh"
RELAY_MAX_AGE = 3600  # requests older than an hour are ignored


def _h(label: str, secret: str) -> bytes:
    return hashlib.sha256(f"{label}:{secret}".encode()).digest()


def relay_keys(secret: str) -> dict:
    """The same keys, topic and token as relayKeys() in the platform."""
    if len(secret) < 24:
        raise BridgeError(400, "RAE_RELAY_SECRET قصير: 24 حرفاً على الأقل")
    return {
        "enc": _h("rae-relay-enc", secret),
        "mac": _h("rae-relay-mac", secret),
        "topic": "spir-rae-" + _h("rae-relay-topic", secret).hex()[:32],
        "token": _h("rae-relay-token", secret).hex(),
    }


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    block = 0
    while len(out) < length:
        out += hmac.new(key, nonce + block.to_bytes(4, "big"), hashlib.sha256).digest()
        block += 1
    return bytes(out[:length])


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    text = text.strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def seal_relay(keys: dict, value) -> str:
    """HMAC-SHA256 counter-mode encryption with an encrypt-then-MAC tag."""
    plain = json.dumps(value, ensure_ascii=False).encode()
    nonce = secrets.token_bytes(16)
    ct = bytes(a ^ b for a, b in zip(plain, _keystream(keys["enc"], nonce, len(plain))))
    tag = hmac.new(keys["mac"], nonce + ct, hashlib.sha256).digest()
    return _b64(nonce + tag + ct)


def open_relay(keys: dict, sealed: str):
    try:
        raw = _unb64(sealed)
    except (ValueError, TypeError):
        return None
    if len(raw) < 48:
        return None
    nonce, tag, ct = raw[:16], raw[16:48], raw[48:]
    want = hmac.new(keys["mac"], nonce + ct, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, want):
        return None
    plain = bytes(a ^ b for a, b in zip(ct, _keystream(keys["enc"], nonce, len(ct))))
    try:
        return json.loads(plain.decode())
    except ValueError:
        return None


class Relay:
    """Waits on the ntfy topic for sealed requests and runs them on this computer."""

    def __init__(self, bridge: Bridge, secret: str, platform: str, ntfy: str = DEFAULT_NTFY):
        self.bridge = bridge
        self.keys = relay_keys(secret)
        self.platform = platform.rstrip("/")
        self.ntfy = ntfy.rstrip("/")
        self.seen_path = HOME / "relay-seen.json"
        self.seen: list[str] = _read_json(self.seen_path, [])
        self.state = {"enabled": True, "connected": False, "last": None, "error": None}

    def report(self, message: dict) -> bool:
        body = json.dumps({"sealed": seal_relay(self.keys, message)}).encode()
        for attempt in range(3):
            try:
                req = Request(
                    self.platform + "/api/rae/relay",
                    data=body,
                    method="POST",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + self.keys["token"],
                    },
                )
                with urlopen(req, timeout=30) as r:
                    return 200 <= r.status < 300
            except Exception:  # noqa: BLE001 - retried, then given up
                time.sleep(2 * (attempt + 1))
        return False

    def _remember(self, request_id: str) -> bool:
        if request_id in self.seen:
            return False
        self.seen = (self.seen + [request_id])[-500:]
        _write_private(self.seen_path, json.dumps(self.seen))
        return True

    def handle(self, text: str) -> None:
        msg = open_relay(self.keys, text)
        if not isinstance(msg, dict) or msg.get("v") != 1 or not msg.get("id"):
            return  # not ours, or altered
        if abs(time.time() - float(msg.get("at", 0)) / 1000) > RELAY_MAX_AGE:
            return
        if not self._remember(str(msg["id"])):
            return
        self.state["last"] = time.strftime("%Y-%m-%d %H:%M:%S")
        threading.Thread(target=self._run, args=(msg,), daemon=True).start()

    def _run(self, msg: dict) -> None:
        rid = msg["id"]
        try:
            if msg.get("kind") == "engineer":
                job = self.bridge.start_engineer(str(msg.get("run_id", "")), msg)["job_id"]
            else:
                job = self.bridge.start_agent(msg)["job_id"]
        except BridgeError as err:
            self.report({"id": rid, "status": "failed", "error": str(err)})
            return
        self.report({"id": rid, "status": "accepted"})
        done = _wait(self.bridge, job)
        result = done.get("result") or {}
        files = []
        run_id = result.get("run_id") if isinstance(result, dict) else None
        if run_id:
            with contextlib.suppress(BridgeError):
                files = [
                    {"name": f["name"], "content": f["content"]}
                    for f in self.bridge.files(str(run_id))["files"]
                ]
        ok = (
            done.get("exit_code") == 0 and isinstance(result, dict) and result.get("status") == "ok"
        )
        self.report(
            {
                "id": rid,
                "status": "done" if ok else "failed",
                "result": result if isinstance(result, dict) else None,
                "files": files,
                "error": None
                if ok
                else (done.get("error") or "\n".join(done.get("log") or [])[-800:]),
            }
        )

    def listen(self) -> None:
        delay = 5
        since = str(int(time.time()) - RELAY_MAX_AGE)
        while True:
            try:
                url = f"{self.ntfy}/{self.keys['topic']}/json?since={since}"
                with urlopen(
                    Request(url, headers={"User-Agent": "spir-rae-bridge"}), timeout=90
                ) as r:
                    self.state.update(connected=True, error=None)
                    delay = 5
                    for line in r:
                        event = json.loads(line or b"{}")
                        if event.get("id"):
                            since = event["id"]
                        if event.get("event") == "message" and event.get("message"):
                            self.handle(event["message"])
            except Exception as err:  # noqa: BLE001 - reconnect with a growing pause
                self.state.update(connected=False, error=f"{type(err).__name__}: {err}"[:200])
                time.sleep(delay)
                delay = min(delay * 2, 60)

    def start(self) -> None:
        threading.Thread(target=self.listen, daemon=True).start()


# ---- HTTP server for the dashboard window ----


def make_handler(bridge: Bridge, token: str, origins: list[str]):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"spir-rae-bridge/{VERSION}"

        def log_message(self, fmt, *args):  # noqa: A003 - quieter logs
            sys.stderr.write("[bridge] " + (fmt % args) + "\n")

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
                self.send_header("Access-Control-Max-Age", "600")
                if self.headers.get("Access-Control-Request-Private-Network"):
                    self.send_header("Access-Control-Allow-Private-Network", "true")

        def _send(self, status: int, body) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _origin_ok(self) -> bool:
            origin = self.headers.get("Origin")
            # Another website's requests are refused; tools without an Origin need the token.
            return origin is None or origin in origins

        def _authorized(self) -> bool:
            auth = self.headers.get("Authorization", "")
            given = auth[7:] if auth.startswith("Bearer ") else ""
            return hmac.compare_digest(given.encode(), token.encode())

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 64 * 1024:
                raise BridgeError(413, "الطلب كبير جداً")
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except ValueError as err:
                raise BridgeError(400, "JSON غير صالح") from err
            if not isinstance(body, dict):
                raise BridgeError(400, "JSON غير صالح")
            return body

        def do_OPTIONS(self):  # noqa: N802
            if not self._origin_ok():
                self.send_response(403)
                self.end_headers()
                return
            self.send_response(204)
            self._cors()
            self.end_headers()

        def _handle(self, method: str) -> None:
            if not self._origin_ok():
                return self._send(403, {"error": "هذا الموقع غير مسموح له باستعمال الجسر"})
            url = urlparse(self.path)
            parts = [p for p in url.path.split("/") if p]
            if method == "GET" and parts == ["health"]:
                return self._send(200, {"ok": True, "bridge": VERSION})
            if not self._authorized():
                return self._send(401, {"error": "رمز الربط غير صحيح"})
            try:
                query = parse_qs(url.query)
                if method == "GET" and parts == ["status"]:
                    return self._send(200, bridge.status())
                if method == "PUT" and parts == ["config"]:
                    return self._send(200, bridge.set_config(self._body()))
                if method == "PUT" and parts == ["keys"]:
                    return self._send(200, bridge.set_keys(self._body()))
                if method == "POST" and parts == ["dry-run"]:
                    return self._send(200, {"result": bridge.dry_run(self._body())})
                if method == "POST" and parts == ["jobs"]:
                    return self._send(202, bridge.start_agent(self._body()))
                if method == "GET" and len(parts) == 2 and parts[0] == "jobs":
                    start = int((query.get("from") or ["0"])[0] or 0)
                    return self._send(200, bridge.jobs.get(parts[1], max(0, start)))
                if (
                    method == "POST"
                    and len(parts) == 3
                    and parts[0] == "jobs"
                    and parts[2] == "cancel"
                ):
                    bridge.jobs.cancel(parts[1])
                    return self._send(200, {"ok": True})
                if method == "GET" and parts == ["runs"]:
                    search = (query.get("search") or [None])[0]
                    return self._send(200, {"runs": bridge.list_runs(search)})
                if method == "GET" and len(parts) == 2 and parts[0] == "runs":
                    return self._send(200, {"run": bridge.show(parts[1])})
                if (
                    method == "GET"
                    and len(parts) == 3
                    and parts[0] == "runs"
                    and parts[2] == "files"
                ):
                    return self._send(200, bridge.files(parts[1]))
                if (
                    method == "POST"
                    and len(parts) == 3
                    and parts[0] == "runs"
                    and parts[2] == "engineer"
                ):
                    return self._send(202, bridge.start_engineer(parts[1], self._body()))
                return self._send(404, {"error": "غير موجود"})
            except BridgeError as err:
                return self._send(err.status, {"error": str(err)})
            except Exception as err:  # noqa: BLE001 - report, never crash the bridge
                return self._send(500, {"error": f"{type(err).__name__}: {err}"[:500]})

        def do_GET(self):  # noqa: N802
            self._handle("GET")

        def do_POST(self):  # noqa: N802
            self._handle("POST")

        def do_PUT(self):  # noqa: N802
            self._handle("PUT")

    return Handler


def _frozen() -> bool:
    """True inside the packaged .exe (PyInstaller); the .py script never asks anything."""
    return bool(getattr(sys, "frozen", False))


def _ask_once(name: str, question: str, valid=None) -> str:
    """
    Double-clicked .exe: ask once and remember the answer in ~/.spir-rae. An
    empty answer to an optional question (valid given) is remembered too, so
    it is not asked again; delete the file to be asked again.
    """
    path = HOME / name
    if path.exists():
        with contextlib.suppress(OSError):
            return path.read_text(encoding="utf-8").strip()
    while True:
        try:
            answer = input(question).strip().rstrip("/")
        except EOFError:
            answer = ""
        if valid is None or not answer or valid(answer):
            break
        print("القيمة غير صالحة، أعد المحاولة أو اضغط Enter للتخطي.")
    if answer or valid is not None:
        _write_private(path, answer)
    return answer


def serve(args) -> None:
    origins = [o.rstrip("/") for o in (args.origin or []) if o]
    if not origins:
        env_origin = os.environ.get("SPIR_PLATFORM", "").rstrip("/")
        if env_origin:
            origins = [env_origin]
    if not origins and _frozen():
        origins = [_ask_once("origin", "عنوان منصتك (مثل https://your-app.vercel.app): ")]
        if not args.relay:
            args.relay = _ask_once(
                "relay-secret",
                "RAE_RELAY_SECRET للربط مع claude.ai (اختياري، Enter للتخطي): ",
                valid=lambda v: len(v) >= 24,
            )
    if not origins:
        sys.exit("أضف عنوان منصتك: --origin https://your-app.vercel.app")
    token = load_token(args.token)
    bridge = Bridge(Rae(args.rae))
    if args.relay:
        try:
            bridge.relay = Relay(bridge, args.relay, args.platform or origins[0], args.ntfy)
            bridge.relay.start()
        except BridgeError as err:
            # A wrong secret disables the claude.ai relay only; the window keeps working.
            print(f"claude.ai relay off: {err}")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(bridge, token, origins))
    version = bridge.rae.version()
    print(f"spir reverse-api-engineer bridge {VERSION} on http://127.0.0.1:{args.port}")
    print(f"reverse-api-engineer: {version or 'غير مثبّت (uv tool install reverse-api-engineer)'}")
    print(f"allowed: {', '.join(origins)}")
    print(f"pairing token (paste it in the window): {token}")
    if bridge.relay:
        print(f"claude.ai relay: waiting on {args.ntfy} (sealed; the platform is never polled)")
    sys.stdout.flush()
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


# ---- local MCP server (stdio) for Claude Desktop / Claude Code ----

MCP_TOOLS = [
    {
        "name": "rae_status",
        "description": (
            "reverse-api-engineer on this computer: installed version, settings, "
            "saved provider keys (names only)."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "rae_dry_run",
        "description": (
            "Check a capture before running it (config, model access, browser), "
            "without opening a browser."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "prompt": {"type": "string", "description": "The data wanted, not the clicks."},
                "headless": {"type": "boolean"},
            },
            "required": ["url", "prompt"],
        },
    },
    {
        "name": "rae_capture",
        "description": (
            "Capture a public website's traffic in a browser and generate a typed API client "
            "(several minutes; uses the configured AI model, which may cost money). Instagram, "
            "TikTok and Meta sites are refused. Review the generated code before running it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "prompt": {"type": "string"},
                "headless": {"type": "boolean"},
                "model": {"type": "string"},
            },
            "required": ["url", "prompt"],
        },
    },
    {
        "name": "rae_engineer",
        "description": "Improve or regenerate a past run's client from its saved capture (HAR).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string"},
                "prompt": {"type": "string"},
                "fresh": {"type": "boolean"},
            },
            "required": ["run_id"],
        },
    },
    {
        "name": "rae_list",
        "description": "Past runs (including failed ones), optionally filtered by site or task.",
        "inputSchema": {"type": "object", "properties": {"search": {"type": "string"}}},
    },
    {
        "name": "rae_show",
        "description": "One run's details: files, HAR entries, mode, cost.",
        "inputSchema": {
            "type": "object",
            "properties": {"run_id": {"type": "string"}},
            "required": ["run_id"],
        },
    },
    {
        "name": "rae_files",
        "description": "The generated client's files (code and README) of a run.",
        "inputSchema": {
            "type": "object",
            "properties": {"run_id": {"type": "string"}},
            "required": ["run_id"],
        },
    },
]


def _wait(bridge: Bridge, job_id: str, limit: float = 1800) -> dict:
    started = time.time()
    while time.time() - started < limit:
        state = bridge.jobs.get(job_id)
        if state["done"]:
            return {
                "result": state["result"],
                "exit_code": state["exit_code"],
                "log": state["log"][-10:],
            }
        time.sleep(2)
    bridge.jobs.cancel(job_id)
    return {"error": "انتهت المهلة (30 دقيقة)"}


def mcp_call(bridge: Bridge, name: str, args: dict):
    if name == "rae_status":
        return bridge.status()
    if name == "rae_dry_run":
        return bridge.dry_run(args)
    if name == "rae_capture":
        return _wait(bridge, bridge.start_agent(args)["job_id"])
    if name == "rae_engineer":
        return _wait(bridge, bridge.start_engineer(str(args.get("run_id", "")), args)["job_id"])
    if name == "rae_list":
        return bridge.list_runs(args.get("search"))
    if name == "rae_show":
        return bridge.show(str(args.get("run_id", "")))
    if name == "rae_files":
        return bridge.files(str(args.get("run_id", "")))
    raise BridgeError(404, f"أداة غير معروفة: {name}")


def mcp(args) -> None:
    bridge = Bridge(Rae(args.rae))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        mid = msg.get("id")
        method = msg.get("method")
        if mid is None:
            continue  # notifications (initialized, cancelled)
        if method == "initialize":
            result = {
                "protocolVersion": (msg.get("params") or {}).get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "reverse-api-engineer (local)", "version": VERSION},
            }
        elif method == "tools/list":
            result = {"tools": MCP_TOOLS}
        elif method == "tools/call":
            params = msg.get("params") or {}
            try:
                data = mcp_call(bridge, params.get("name", ""), params.get("arguments") or {})
                result = {
                    "content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]
                }
            except BridgeError as err:
                result = {"content": [{"type": "text", "text": str(err)}], "isError": True}
        elif method == "ping":
            result = {}
        else:
            out = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "not found"}}
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()
            continue
        sys.stdout.write(
            json.dumps({"jsonrpc": "2.0", "id": mid, "result": result}, ensure_ascii=False) + "\n"
        )
        sys.stdout.flush()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Local bridge for the reverse-api-engineer window."
    )
    parser.add_argument("mode", nargs="?", choices=("serve", "mcp"), default="serve")
    parser.add_argument("--origin", action="append", help="your platform's address (repeatable)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--rae", default=os.environ.get("RAE_COMMAND", "reverse-api-engineer"))
    parser.add_argument("--token", default=os.environ.get("SPIR_RAE_TOKEN"))
    parser.add_argument(
        "--relay",
        default=os.environ.get("RAE_RELAY_SECRET"),
        help="the platform's RAE_RELAY_SECRET: also take requests from claude.ai through ntfy",
    )
    parser.add_argument(
        "--platform", help="the platform's address for relay reports (default: --origin)"
    )
    parser.add_argument("--ntfy", default=os.environ.get("RAE_NTFY_URL", DEFAULT_NTFY))
    args = parser.parse_args(argv)
    if args.mode == "mcp":
        mcp(args)
    else:
        serve(args)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        # Keep a double-clicked .exe window open long enough to read why it stopped.
        if _frozen() and exc.code not in (0, None):
            print(exc.code)
            with contextlib.suppress(EOFError):
                input("اضغط Enter للإغلاق")
        raise
