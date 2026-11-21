"""HTTP API: GET /profile/{username} and GET /health.

Internal only: every request must carry ``x-worker-secret``. Requests are
serialised and spaced by MIN_INTERVAL_SECONDS so one IP stays well under
Instagram's anonymous limits.
"""

from __future__ import annotations

import asyncio
import os
import re
import secrets
import time
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Header, HTTPException

from .fetch import Blocked, NotFound, RateLimited

USERNAME_RE = re.compile(r"^[a-z0-9._]{1,30}$")

Fetcher = Callable[[str], dict[str, Any]]


def create_app(
    fetch: Fetcher | None = None,
    secret: str | None = None,
    min_interval: float | None = None,
) -> FastAPI:
    secret = secret if secret is not None else os.environ.get("WORKER_SHARED_SECRET", "")
    if not secret:
        raise RuntimeError("WORKER_SHARED_SECRET must be set")
    interval = (
        min_interval
        if min_interval is not None
        else float(os.environ.get("MIN_INTERVAL_SECONDS", "3"))
    )

    if fetch is None:
        from .fetch import fetch_profile, make_loader

        loader = make_loader()

        def fetch(username: str) -> dict[str, Any]:
            return fetch_profile(loader, username)

    app = FastAPI(title="ig-worker", docs_url=None, redoc_url=None)
    lock = asyncio.Lock()
    last_call = 0.0

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/profile/{username}")
    async def profile(username: str, x_worker_secret: str = Header(default="")) -> dict[str, Any]:
        nonlocal last_call
        if not secrets.compare_digest(x_worker_secret, secret):
            raise HTTPException(status_code=401, detail="bad secret")
        username = username.strip().lstrip("@").lower()
        if not USERNAME_RE.fullmatch(username):
            raise HTTPException(status_code=400, detail="invalid username")

        async with lock:
            wait = last_call + interval - time.monotonic()
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
