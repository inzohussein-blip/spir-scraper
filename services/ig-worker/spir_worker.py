#!/usr/bin/env python3
"""Spir home worker: reads public Instagram profiles slowly for the Spir engine.

One file, standard Python only (3.9 or newer, nothing to install). It asks the
dashboard what to read, reads one public profile without logging in, reports
it, and waits as long as the dashboard says. Proxies are managed from the
dashboard page «العامل المنزلي»; the worker also checks its public addresses
and can change a proxy's IP through the provider's link when asked.

Run:
    python spir_worker.py --platform https://your-app.vercel.app --key sk_...

or with the environment variables PLATFORM_URL and SPIR_KEY (a platform key
with write access, made on the «العامل المنزلي» page). WORKER_SHARED_SECRET
also works instead of a key. PROXY_URLS (comma separated) is used only when
the dashboard has no proxies.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import platform as pyplatform
import random
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

VERSION = "1.0.0"
IG_APP_ID = "936619743392459"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
REST_SECONDS = 15 * 60
log = logging.getLogger("spir")


class NotFound(Exception):
    pass


class RateLimited(Exception):
    pass


class Blocked(Exception):
    pass


# ---------- reading one profile ----------


def _s(v: Any) -> Optional[str]:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _count(d: Any, *keys: str) -> Optional[int]:
    for k in keys:
        v = d.get(k) if isinstance(d, dict) else None
        if isinstance(v, dict) and isinstance(v.get("count"), int):
            return v["count"]
    return None


def map_profile(user: Dict[str, Any]) -> Dict[str, Any]:
    """Instagram's public profile JSON → the profile shape the platform stores."""
    posts = []
    edges = (user.get("edge_owner_to_timeline_media") or {}).get("edges") or []
    for e in edges[:12]:
        n = e.get("node") if isinstance(e, dict) else None
        if not isinstance(n, dict):
            continue
        cap = ((n.get("edge_media_to_caption") or {}).get("edges") or [{}])[0]
        text = _s((cap.get("node") or {}).get("text")) if isinstance(cap, dict) else None
        code = _s(n.get("shortcode"))
        posts.append(
            {
                "likes": _count(n, "edge_liked_by", "edge_media_preview_like"),
                "comments": _count(n, "edge_media_to_comment"),
                "caption": text[:500] if text else None,
                "url": f"https://www.instagram.com/p/{code}/" if code else None,
            }
        )
    city = None
    raw = user.get("business_address_json")
    if isinstance(raw, str) and raw.strip():
        try:
            city = _s(json.loads(raw).get("city_name"))
        except (ValueError, AttributeError):
            city = None
    return {
        "igUserId": str(user.get("id") or user.get("pk") or user.get("username")),
        "username": str(user.get("username", "")).lower(),
        "fullName": _s(user.get("full_name")),
        "bio": _s(user.get("biography")),
        "followers": _count(user, "edge_followed_by"),
        "following": _count(user, "edge_follow"),
        "posts": _count(user, "edge_owner_to_timeline_media"),
        "isBusiness": bool(user.get("is_business_account")),
        "isVerified": bool(user.get("is_verified")),
        "category": _s(user.get("business_category_name") or user.get("category_name")),
        "externalUrl": _s(user.get("external_url")),
        "businessEmail": _s(user.get("business_email") or user.get("public_email")),
        "businessPhone": _s(user.get("business_phone_number") or user.get("public_phone_number")),
        "businessPhoneCountryCode": _s(user.get("public_phone_country_code")),
        "businessWhatsapp": _s(user.get("whatsapp_number")),
        "city": city,
        "recentPosts": posts or None,
    }


Opener = Callable[[urllib.request.Request, float], Any]


def make_opener(proxy: Optional[str]) -> Opener:
    """A URL opener through one proxy, or straight out of this connection (proxy None)."""
    handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {})
    opener = urllib.request.build_opener(handler)
    return lambda req, timeout: opener.open(req, timeout=timeout)


def fetch_profile(open_url: Opener, username: str) -> Dict[str, Any]:
    """Reads a public profile anonymously (no cookies, no login)."""
    url = "https://www.instagram.com/api/v1/users/web_profile_info/?username=" + urllib.parse.quote(
        username
    )
    req = urllib.request.Request(
        url,
        headers={
            "user-agent": USER_AGENT,
            "x-ig-app-id": IG_APP_ID,
            "accept": "*/*",
            "accept-language": "ar,en;q=0.8",
            "referer": f"https://www.instagram.com/{username}/",
        },
    )
    try:
        with open_url(req, 30) as res:
            final = res.geturl() if hasattr(res, "geturl") else url
            body = res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise NotFound(f"@{username} not found") from e
        if e.code == 429:
            raise RateLimited("Instagram: 429 too many requests") from e
        if e.code in (401, 403):
            raise Blocked(f"Instagram: {e.code} login required") from e
        raise
    if "/accounts/login" in final or "/challenge" in final:
        raise Blocked("Instagram sent the login page")
    try:
        data = json.loads(body)
    except ValueError as e:
        raise Blocked("Instagram answered with a page instead of data") from e
    user = (data.get("data") or {}).get("user") if isinstance(data, dict) else None
    if not user:
        raise NotFound(f"@{username} not found or private")
    return map_profile(user)


def public_ip(open_url: Opener) -> Optional[str]:
    """The address Instagram sees for this exit (a public echo service)."""
    try:
        req = urllib.request.Request(
            "https://api.ipify.org?format=json", headers={"user-agent": "spir"}
        )
        with open_url(req, 15) as res:
            return _s(json.loads(res.read().decode()).get("ip"))
    except Exception:  # noqa: BLE001 - an unknown address is shown as unknown
        return None


# ---------- exits: this connection and proxies ----------


class Exit:
    def __init__(
        self,
        id: str,
        label: str,
        proxy: Optional[str],
        rotate_url: Optional[str] = None,
        open_url: Optional[Opener] = None,
    ):
        self.id, self.label, self.rotate_url = id, label, rotate_url
        self.open = open_url or make_opener(proxy)
        self.resting_until = 0.0
        self.error: Optional[str] = None
        self.ip: Optional[str] = None

    def ok(self, now: float) -> bool:
        return self.resting_until <= now

    def describe(self, now: float) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "ok": self.ok(now),
            "restingUntil": (
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.resting_until))
                if not self.ok(now)
                else None
            ),
            "ip": self.ip,
            "error": self.error,
        }


def label_of(url: str) -> str:
    try:
        u = urllib.parse.urlsplit(url)
        return f"{u.hostname}:{u.port}" if u.port else (u.hostname or "proxy")
    except ValueError:
        return "proxy"


class Pool:
    """Tries exits in turn; one that Instagram refuses rests for a while."""

    def __init__(self, exits: List[Exit], clock: Callable[[], float] = time.time):
        self.exits, self.clock, self.turn = exits, clock, 0

    def fetch(self, username: str):
        now = self.clock()
        ready = [e for e in self.exits if e.ok(now)]
        if not ready:
            raise RateLimited("every exit is resting")
        last: Optional[Exception] = None
        for i in range(len(ready)):
            ex = ready[(self.turn + i) % len(ready)]
            try:
                profile = fetch_profile(ex.open, username)
                ex.error = None
                self.turn = (self.turn + i + 1) % max(1, len(ready))
                return profile, ex.id
            except NotFound:
                self.turn = (self.turn + i + 1) % max(1, len(ready))
                raise
            except (RateLimited, Blocked) as e:
                ex.resting_until = now + REST_SECONDS
                ex.error = str(e)[:200]
                e.exit_id = ex.id  # type: ignore[attr-defined]
                last = e
        assert last is not None
        raise last

    def describe(self) -> List[Dict[str, Any]]:
        now = self.clock()
        return [e.describe(now) for e in self.exits]


def build_exits(config: Optional[Dict[str, Any]], env_proxies: List[str]) -> List[Exit]:
    proxies = (config or {}).get("proxies") or []
    exits: List[Exit] = []
    if proxies:
        if (config or {}).get("useDirect", True):
            exits.append(Exit("direct", "اتصال البيت", None))
        for p in proxies:
            exits.append(Exit(p["id"], label_of(p["url"]), p["url"], p.get("rotateUrl")))
    elif env_proxies:
        exits = [Exit(f"env-{i}", label_of(u), u) for i, u in enumerate(env_proxies)]
    else:
        exits = [Exit("direct", "اتصال البيت", None)]
    return exits


# ---------- talking to the dashboard ----------


Poster = Callable[[str, Dict[str, Any]], Dict[str, Any]]


def http_poster(platform_url: str, key: Optional[str], secret: Optional[str]) -> Poster:
    base = platform_url.rstrip("/")
    direct = make_opener(None)

    def post(path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        headers = {"content-type": "application/json", "user-agent": f"spir-worker/{VERSION}"}
        if key:
            headers["authorization"] = f"Bearer {key}"
        elif secret:
            headers["x-worker-secret"] = secret
        req = urllib.request.Request(
            base + path, data=json.dumps(body).encode(), headers=headers, method="POST"
        )
        with direct(req, 60) as res:
            return json.loads(res.read().decode() or "{}")

    return post


class Worker:
    def __init__(
        self,
        post: Poster,
        worker_id: str,
        name: str,
        env_proxies: Optional[List[str]] = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.time,
        rotate: Optional[Callable[[str], None]] = None,
    ):
        self.post, self.id, self.name, self.sleep, self.clock = post, worker_id, name, sleep, clock
        self.env_proxies = env_proxies or []
        self.config_version: Optional[str] = None
        self.pool = Pool(build_exits(None, self.env_proxies), clock)
        self.rotate = rotate or self._rotate
        self.ip: Optional[str] = None

    def info(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "kind": "program",
            "name": self.name,
            "version": VERSION,
            "ip": self.ip,
            "exits": self.pool.describe(),
            "configVersion": self.config_version,
            # Takes several accounts per visit: the dashboard is contacted once per batch.
            "batch": True,
        }

    def check_ips(self) -> None:
        for ex in self.pool.exits:
            ex.ip = public_ip(ex.open)
        direct = next((e for e in self.pool.exits if e.id == "direct"), None)
        self.ip = (direct or self.pool.exits[0]).ip if self.pool.exits else None
        log.info("addresses: %s", ", ".join(f"{e.label}={e.ip or '?'}" for e in self.pool.exits))

    def _rotate(self, url: str) -> None:
        req = urllib.request.Request(url, headers={"user-agent": f"spir-worker/{VERSION}"})
        with make_opener(None)(req, 30) as res:
            res.read()

    def apply(self, decision: Dict[str, Any]) -> None:
        """New proxy settings and the owner's commands, when the answer carries them."""
        config = decision.get("config")
        if config:
            self.pool = Pool(build_exits(config, self.env_proxies), self.clock)
            self.config_version = config.get("version")
            log.info("proxies: %s", ", ".join(e.label for e in self.pool.exits))
            self.check_ips()
        for cmd in decision.get("commands") or []:
            if cmd.get("type") == "check_ip":
                self.check_ips()
            elif cmd.get("type") == "rotate":
                ex = next((e for e in self.pool.exits if e.id == cmd.get("proxyId")), None)
                if ex and ex.rotate_url:
                    try:
                        self.rotate(ex.rotate_url)
                        ex.resting_until, ex.error = 0.0, None
                        ex.ip = public_ip(ex.open)
                        log.info("changed IP of %s: %s", ex.label, ex.ip)
                    except Exception as e:  # noqa: BLE001
                        ex.error = f"change IP failed: {e}"[:200]
                elif ex:
                    ex.resting_until, ex.error = 0.0, "no change-IP link for this proxy"

    def read(self, item: Dict[str, Any]) -> Dict[str, Any]:
        report: Dict[str, Any] = {"itemId": item["id"]}
        try:
            profile, exit_id = self.pool.fetch(item["username"])
            report.update(status="ok", profile=profile, exitId=exit_id)
        except NotFound as e:
            report.update(status="not_found", message=str(e)[:300])
        except RateLimited as e:
            report.update(
                status="rate_limited", message=str(e)[:300], exitId=getattr(e, "exit_id", None)
            )
        except Blocked as e:
            report.update(
                status="blocked", message=str(e)[:300], exitId=getattr(e, "exit_id", None)
            )
        except Exception as e:  # noqa: BLE001 - reported, never fatal
            report.update(status="error", message=f"{type(e).__name__}: {e}"[:300])
        return report

    def read_batch(self, decision: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Reads a batch at the dashboard's pace; stops at a refusal and hands the rest back."""
        items = decision.get("items") or []
        interval = float(decision.get("intervalSec", 60))
        jitter = float(decision.get("jitterSec", 0))
        reports: List[Dict[str, Any]] = []
        for i, item in enumerate(items):
            if i > 0:
                self.sleep(interval + random.uniform(0, max(0.0, jitter)))
            report = self.read(item)
            log.info("@%s: %s", item.get("username"), report["status"])
            reports.append(report)
            if report["status"] in ("rate_limited", "blocked"):
                reports += [{"itemId": it["id"], "status": "released"} for it in items[i + 1 :]]
                break
        return reports

    def run(self, max_steps: Optional[int] = None) -> None:
        decision: Optional[Dict[str, Any]] = None
        steps = 0
        while max_steps is None or steps < max_steps:
            steps += 1
            try:
                if decision is None:
                    decision = self.post("/api/engine/next", {"worker": self.info()})
                self.apply(decision)
                if decision.get("action") == "batch":
                    reports = self.read_batch(decision)
                    decision = self.post(
                        "/api/engine/report", {"reports": reports, "worker": self.info()}
                    )
                    continue
                if decision.get("action") == "read":
                    item = decision["item"]
                    report = self.read(item)
                    log.info("@%s: %s", item.get("username"), report["status"])
                    report["worker"] = self.info()
                    decision = self.post("/api/engine/report", report)
                    continue
                seconds = float(decision.get("seconds", 60))
                log.info("wait %ss (%s)", int(seconds), decision.get("reason", ""))
                self.sleep(max(1.0, min(seconds, 3600.0)))
                decision = None
            except urllib.error.HTTPError as e:
                if e.code in (401, 404):
                    log.error("the dashboard refused this worker: check the key and PLATFORM_URL")
                    self.sleep(300.0)
                else:
                    log.warning("dashboard: HTTP %s", e.code)
                    self.sleep(60.0)
                decision = None
            except (urllib.error.URLError, TimeoutError, ValueError, KeyError, OSError) as e:
                log.warning("dashboard unreachable: %s", e)
                self.sleep(60.0)
                decision = None


def worker_id(path: Path) -> str:
    """A stable id for this machine, kept next to the user's home folder."""
    try:
        return json.loads(path.read_text())["id"]
    except (OSError, ValueError, KeyError):
        wid = f"pc-{uuid.uuid4().hex[:12]}"
        with contextlib.suppress(OSError):
            path.write_text(json.dumps({"id": wid}))
        return wid


def _frozen() -> bool:
    """True inside the packaged .exe (PyInstaller); the .py script never asks anything."""
    return bool(getattr(sys, "frozen", False))


def _ask_once(args) -> None:
    """Double-clicked .exe: ask for the address and key once, and remember them."""
    saved_path = Path.home() / ".spir-worker-exe.json"
    try:
        saved = json.loads(saved_path.read_text())
    except (OSError, ValueError):
        saved = {}
    if not args.platform:
        args.platform = (
            saved.get("platform")
            or input("عنوان المنصة (مثل https://your-app.vercel.app): ").strip()
        )
    if not args.key and not os.environ.get("WORKER_SHARED_SECRET"):
        args.key = saved.get("key") or input("مفتاح العامل (من صفحة «العامل المنزلي»): ").strip()
    with contextlib.suppress(OSError):
        saved_path.write_text(json.dumps({"platform": args.platform, "key": args.key}))
        os.chmod(saved_path, 0o600)


def main(argv: Optional[List[str]] = None) -> None:
    ap = argparse.ArgumentParser(description="Spir home worker")
    ap.add_argument("--platform", default=os.environ.get("PLATFORM_URL", ""))
    ap.add_argument("--key", default=os.environ.get("SPIR_KEY", ""))
    ap.add_argument("--name", default=os.environ.get("WORKER_NAME", socket.gethostname()))
    args = ap.parse_args(argv)
    if _frozen():
        _ask_once(args)
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(message)s",
        stream=sys.stdout,
    )
    secret = os.environ.get("WORKER_SHARED_SECRET", "")
    if not args.platform.startswith("https://") and not args.platform.startswith(
        "http://localhost"
    ):
        raise SystemExit("--platform must be the dashboard's https address")
    if not args.key and not secret:
        raise SystemExit("--key is required (make one on the «العامل المنزلي» page)")
    env_proxies = [
        u.strip()
        for u in (os.environ.get("PROXY_URLS") or "").replace("\n", ",").split(",")
        if u.strip()
    ]
    w = Worker(
        http_poster(args.platform, args.key or None, secret or None),
        worker_id(Path.home() / ".spir-worker.json"),
        f"{args.name} ({pyplatform.system()})"[:60],
        env_proxies,
    )
    log.info("Spir worker %s started; the dashboard sets the pace", VERSION)
    w.check_ips()
    w.run()


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
