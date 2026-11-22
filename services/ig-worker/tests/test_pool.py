import pytest
from fastapi.testclient import TestClient

from ig_worker.app import create_app
from ig_worker.fetch import Blocked, NotFound, RateLimited
from ig_worker.pool import ExitPool, describe, proxies_from_env

PROFILE = {"igUserId": "1", "username": "acme"}


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def exit_that(*outcomes):
    """A fake exit returning or raising each outcome in turn, recording calls."""
    calls = []
    queue = list(outcomes)

    def fetch(username):
        calls.append(username)
        out = queue.pop(0) if queue else PROFILE
        if isinstance(out, Exception):
            raise out
        return out

    fetch.calls = calls
    return fetch


def test_blocked_exit_rests_and_the_request_moves_on():
    a, b = exit_that(Blocked("login wall")), exit_that()
    pool = ExitPool([("a", a), ("b", b)], cooldown=60, clock=Clock())
    assert pool.fetch("acme") == PROFILE
    assert a.calls == ["acme"] and b.calls == ["acme"]
    assert [e["ok"] for e in pool.status()] == [False, True]
    assert pool.status()[0]["lastError"].startswith("Blocked")


def test_resting_exit_is_skipped_until_its_cooldown_ends():
    clock = Clock()
    a, b = exit_that(RateLimited("429")), exit_that()
    pool = ExitPool([("a", a), ("b", b)], cooldown=60, clock=clock)
    pool.fetch("one")
    pool.fetch("two")
    pool.fetch("three")
    assert a.calls == ["one"]
    clock.t += 61
    pool.fetch("four")
    pool.fetch("five")
    assert "four" in a.calls or "five" in a.calls


def test_rest_doubles_on_repeated_failures_and_resets_after_success():
    clock = Clock()
    a = exit_that(Blocked("x"), Blocked("x"), PROFILE)
    pool = ExitPool([("a", a)], cooldown=60, max_cooldown=100, clock=clock)
    with pytest.raises(Blocked):
        pool.fetch("u")
    assert pool.status()[0]["restingSeconds"] == 60
    clock.t += 61
    with pytest.raises(Blocked):
        pool.fetch("u")
    assert pool.status()[0]["restingSeconds"] == 100  # 120 capped at max_cooldown
    clock.t += 101
    assert pool.fetch("u") == PROFILE
    assert pool.exits[0].failures == 0


def test_all_resting_reports_rate_limited_without_calling_any_exit():
    clock = Clock()
    a = exit_that(Blocked("x"))
    pool = ExitPool([("a", a)], cooldown=60, clock=clock)
    with pytest.raises(Blocked):
        pool.fetch("u")
    with pytest.raises(RateLimited, match="resting"):
        pool.fetch("v")
    assert a.calls == ["u"]


def test_not_found_is_not_a_block():
    a, b = exit_that(NotFound("gone")), exit_that()
    pool = ExitPool([("a", a), ("b", b)], clock=Clock())
    with pytest.raises(NotFound):
        pool.fetch("ghost")
    assert b.calls == []
    assert pool.status()[0]["ok"] is True


def test_round_robin_spreads_requests():
    a, b = exit_that(), exit_that()
    pool = ExitPool([("a", a), ("b", b)], clock=Clock())
    for u in ["1", "2", "3", "4"]:
        pool.fetch(u)
    assert len(a.calls) == 2 and len(b.calls) == 2


def test_proxies_from_env():
    assert proxies_from_env({}) == [None]
    assert proxies_from_env({"PROXY_URL": "http://p:1"}) == ["http://p:1"]
    assert proxies_from_env({"PROXY_URLS": "http://a:1, http://b:2\nhttp://c:3"}) == [
        "http://a:1",
        "http://b:2",
        "http://c:3",
    ]
    assert proxies_from_env({"PROXY_URLS": "http://a:1", "PROXY_INCLUDE_DIRECT": "true"}) == [
        None,
        "http://a:1",
    ]


def test_describe_hides_credentials():
    assert describe(None) == "direct"
    assert describe("http://user:pass@gate.example.com:7777") == "http://gate.example.com:7777"
    assert "pass" not in describe("socks5://user:pass@10.0.0.1")


def test_health_shows_counts_and_status_needs_the_secret():
    pool = ExitPool([("http://gate.example.com:1", exit_that(Blocked("x"))), ("b", exit_that())])
    c = TestClient(create_app(pool=pool, secret="s", min_interval=0, jitter=0))
    assert c.get("/profile/acme", headers={"x-worker-secret": "s"}).status_code == 200
    health = c.get("/health").json()
    assert health == {"status": "ok", "exits": 2, "ready": 1}
    assert "gate.example.com" not in c.get("/health").text
    assert c.get("/status").status_code == 401
    status = c.get("/status", headers={"x-worker-secret": "s"}).json()
    assert [e["ok"] for e in status["exits"]] == [False, True]
