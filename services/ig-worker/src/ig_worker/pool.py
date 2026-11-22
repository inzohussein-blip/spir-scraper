"""Rotates requests over several exits (proxies) so one blocked IP does not stop the worker.

Each exit is a fetch function, usually an Instaloader instance bound to one
proxy. When Instagram rate-limits or blocks an exit, that exit rests for a
while and the same request moves on to the next one. Only when every exit is
resting does the worker report the failure, and the Node router then moves to
another provider (Graph API or Apify).
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from .fetch import Blocked, RateLimited

Fetcher = Callable[[str], dict[str, Any]]


def proxies_from_env(env: dict[str, str] | None = None) -> list[str | None]:
    """PROXY_URLS (comma or newline separated) or PROXY_URL; no proxy means one direct exit."""
    env = dict(os.environ) if env is None else env
    raw = env.get("PROXY_URLS") or env.get("PROXY_URL") or ""
    urls = [u.strip() for u in raw.replace("\n", ",").split(",") if u.strip()]
    # The worker's own address can join the rotation as one more exit.
    if urls and env.get("PROXY_INCLUDE_DIRECT", "").lower() in ("1", "true", "yes"):
        return [None, *urls]
    return list(urls) or [None]


def describe(proxy: str | None) -> str:
    """A label for logs and /health that never shows proxy credentials."""
    if not proxy:
        return "direct"
    parts = urlsplit(proxy)
    host = parts.hostname or "proxy"
    return f"{parts.scheme or 'http'}://{host}:{parts.port}" if parts.port else host


@dataclass
class Exit:
    label: str
    fetch: Fetcher
    resting_until: float = 0.0
    failures: int = 0
    last_error: str | None = field(default=None)


class ExitPool:
    def __init__(
        self,
        exits: Sequence[tuple[str, Fetcher]],
        cooldown: float = 900.0,
        max_cooldown: float = 6 * 3600.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not exits:
            raise ValueError("at least one exit is required")
        self.exits = [Exit(label, fn) for label, fn in exits]
        self.cooldown = cooldown
        self.max_cooldown = max_cooldown
        self.clock = clock
        self._next = 0
        self._lock = threading.Lock()

    def _order(self) -> list[Exit]:
        """Exits not resting, starting after the last one used (round robin)."""
        now = self.clock()
        with self._lock:
            n = len(self.exits)
            start = self._next
            self._next = (self._next + 1) % n
        ring = [self.exits[(start + i) % n] for i in range(n)]
        return [e for e in ring if e.resting_until <= now]

    def _rest(self, e: Exit, err: Exception) -> None:
        # Each failure in a row doubles the rest, up to max_cooldown.
        e.failures += 1
        wait = min(self.cooldown * 2 ** (e.failures - 1), self.max_cooldown)
        e.resting_until = self.clock() + wait
        e.last_error = f"{type(err).__name__}: {err}"

    def fetch(self, username: str) -> dict[str, Any]:
        last: Exception | None = None
        for e in self._order():
            try:
                result = e.fetch(username)
            except (Blocked, RateLimited) as err:
                self._rest(e, err)
                last = err
                continue
            e.failures = 0
            return result
        if last is not None:
            raise last
        # Every exit was already resting before this request.
        wait = max(0, int(min(e.resting_until for e in self.exits) - self.clock()))
        raise RateLimited(f"all {len(self.exits)} exits are resting, next in {wait}s")

    def status(self) -> list[dict[str, Any]]:
        now = self.clock()
        return [
            {
                "exit": e.label,
                "ok": e.resting_until <= now,
                "restingSeconds": max(0, int(e.resting_until - now)),
                "lastError": e.last_error,
            }
            for e in self.exits
        ]
