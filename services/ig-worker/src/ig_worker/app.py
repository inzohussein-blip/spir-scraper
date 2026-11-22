"""HTTP API: GET /profile/{username}, GET /status and GET /health.

Internal only: every request must carry ``x-worker-secret``. Requests are
serialised and spaced by MIN_INTERVAL_SECONDS so one IP stays well under
Instagram's anonymous limits.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
import secrets
import time
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Header, HTTPException

from .fetch import Blocked, NotFound, RateLimited
from .pool import ExitPool, describe, proxies_from_env

USERNAME_RE = re.compile(r"^[a-z0-9._]{1,30}$")

Fetcher = Callable[[str], dict[str, Any]]


def create_app(
    fetch: Fetcher | None = None,
    pool: ExitPool | None = None,
    secret: str | None = None,
    min_interval: float | None = None,
    jitter: float | None = None,
) -> FastAPI:
    secret = secret if secret is not None else os.environ.get("WORKER_SHARED_SECRET", "")
    if not secret:
        raise RuntimeError("WORKER_SHARED_SECRET must be set")
    interval = (
        min_interval
        if min_interval is not None
        else float(os.environ.get("MIN_INTERVAL_SECONDS", "3"))
    )
    # Random extra wait so the request rhythm is not perfectly regular (idea from instagrapi).
    spread = jitter if jitter is not None else float(os.environ.get("JITTER_SECONDS", "2"))

    if fetch is None and pool is not None:
        fetch = pool.fetch
    if fetch is None:
        from .fetch import fetch_profile, make_loader

        def bind(proxy: str | None) -> Fetcher:
            loader = make_loader(proxy)
            return lambda username: fetch_profile(loader, username)

        pool = ExitPool(
            [(describe(p), bind(p)) for p in proxies_from_env()],
            cooldown=float(os.environ.get("EXIT_COOLDOWN_SECONDS", "900")),
        )
        fetch = pool.fetch

    app = FastAPI(title="ig-worker", docs_url=None, redoc_url=None)
    lock = asyncio.Lock()
    last_call = 0.0

    def check(given: str) -> None:
        if not secrets.compare_digest(given, secret):
            raise HTTPException(status_code=401, detail="bad secret")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        # Public (the container healthcheck uses it): counts only, no proxy addresses.
        if pool is None:
            return {"status": "ok"}
        exits = pool.status()
        ready = sum(1 for e in exits if e["ok"])
        return {"status": "ok" if ready else "resting", "exits": len(exits), "ready": ready}

    @app.get("/status")
    async def status(x_worker_secret: str = Header(default="")) -> dict[str, Any]:
        check(x_worker_secret)
        return {"exits": pool.status() if pool else []}

    @app.get("/profile/{username}")
    async def profile(username: str, x_worker_secret: str = Header(default="")) -> dict[str, Any]:
        nonlocal last_call
        check(x_worker_secret)
        username = username.strip().lstrip("@").lower()
        if not USERNAME_RE.fullmatch(username):
            raise HTTPException(status_code=400, detail="invalid username")

        async with lock:
            wait = last_call + interval + random.uniform(0, spread) - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                return await asyncio.to_thread(fetch, username)
            except NotFound as e:
                raise HTTPException(status_code=404, detail=str(e)) from e
            except RateLimited as e:
                raise HTTPException(status_code=429, detail=str(e)) from e
            except Blocked as e:
                raise HTTPException(status_code=403, detail=str(e)) from e
            finally:
                last_call = time.monotonic()

    return app
