"""Spir engine loop: reads public profiles slowly from the owner's home connection.

The platform decides what to read and when (speed, quiet hours, daily cap,
rests after Instagram refuses); this loop only asks, reads one account
anonymously, and reports back. It never logs in and never retries a refusal
on its own: it tells the platform, which then rests.

Run with ``ig-engine`` and these variables:

- ``PLATFORM_URL``: the dashboard address, e.g. https://spir-scraper.vercel.app
- ``WORKER_SHARED_SECRET``: the same secret as in Vercel
- optional ``PROXY_URLS`` (as for the worker)
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from .fetch import Blocked, NotFound, RateLimited

log = logging.getLogger("ig_engine")

Fetcher = Callable[[str], dict[str, Any]]
Poster = Callable[[str, dict[str, Any]], dict[str, Any]]


def http_poster(platform_url: str, secret: str, timeout: float = 60) -> Poster:
    base = platform_url.rstrip("/")

    def post(path: str, body: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(
            f"{base}{path}",
            data=json.dumps(body).encode(),
            headers={
                "content-type": "application/json",
                "x-worker-secret": secret,
                "user-agent": "spir-engine/1.0",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode() or "{}")

    return post


def read_one(fetch: Fetcher, item: dict[str, Any]) -> dict[str, Any]:
    """Reads one account and turns the outcome into a report for the platform."""
    report: dict[str, Any] = {"itemId": item["id"]}
    try:
        report |= {"status": "ok", "profile": fetch(item["username"])}
    except NotFound as e:
        report |= {"status": "not_found", "message": str(e)[:300]}
    except RateLimited as e:
        report |= {"status": "rate_limited", "message": str(e)[:300]}
    except Blocked as e:
        report |= {"status": "blocked", "message": str(e)[:300]}
    except Exception as e:  # noqa: BLE001 - any other failure is reported, not fatal
        report |= {"status": "error", "message": f"{type(e).__name__}: {e}"[:300]}
    return report


def run(
    post: Poster,
    fetch: Fetcher,
    *,
    sleep: Callable[[float], None] = time.sleep,
    max_steps: int | None = None,
) -> None:
    """Asks, reads, reports, waits; for ever (or ``max_steps`` decisions, for tests)."""
    decision: dict[str, Any] | None = None
    steps = 0
    while max_steps is None or steps < max_steps:
        steps += 1
        try:
            if decision is None:
                decision = post("/api/engine/next", {})
            if decision.get("action") == "read":
                item = decision["item"]
                report = read_one(fetch, item)
                log.info("read @%s: %s", item.get("username"), report["status"])
                decision = post("/api/engine/report", report)
                continue
            seconds = float(decision.get("seconds", 60))
            log.info("wait %ss (%s)", int(seconds), decision.get("reason", ""))
            sleep(max(1.0, min(seconds, 3600.0)))
            decision = None
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as e:
            # The platform is unreachable or answered oddly: try again a little later.
            log.warning("platform: %s", e)
            sleep(60.0)
            decision = None


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(message)s")
    platform = os.environ.get("PLATFORM_URL", "")
    secret = os.environ.get("WORKER_SHARED_SECRET", "")
    if not platform.startswith("https://") and not platform.startswith("http://localhost"):
        raise SystemExit("PLATFORM_URL must be the dashboard's https address")
    if not secret:
        raise SystemExit("WORKER_SHARED_SECRET must be set (the same as in Vercel)")

    from .fetch import fetch_profile, make_loader
    from .pool import ExitPool, describe, proxies_from_env

    def bind(proxy: str | None) -> Fetcher:
        loader = make_loader(proxy)
        return lambda username: fetch_profile(loader, username)

    pool = ExitPool(
        [(describe(p), bind(p)) for p in proxies_from_env()],
        cooldown=float(os.environ.get("EXIT_COOLDOWN_SECONDS", "900")),
    )
    log.info("Spir engine started; the dashboard controls the pace")
    run(http_poster(platform, secret), pool.fetch)


if __name__ == "__main__":
    main()
