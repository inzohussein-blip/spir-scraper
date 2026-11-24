import urllib.error

from ig_worker.engine import read_one, run
from ig_worker.fetch import Blocked, NotFound, RateLimited

PROFILE = {"igUserId": "1", "username": "acme", "isBusiness": True, "isVerified": False}


def fake_platform(decisions):
    calls = []

    def post(path, body):
        calls.append((path, body))
        return decisions.pop(0)

    return post, calls


def test_reads_reports_and_waits_as_the_platform_says():
    post, calls = fake_platform(
        [
            {"action": "read", "item": {"id": "q1", "username": "acme"}},
            {"action": "wait", "seconds": 61, "reason": "pace"},
            {"action": "read", "item": {"id": "q2", "username": "ghost"}},
            {"action": "wait", "seconds": 99999, "reason": "resting"},
        ]
    )
    slept = []

    def fetch(username):
        if username == "ghost":
            raise NotFound("gone")
        return PROFILE

    run(post, fetch, sleep=slept.append, max_steps=4)
    assert [c[0] for c in calls] == [
        "/api/engine/next",
        "/api/engine/report",
        "/api/engine/next",
        "/api/engine/report",
    ]
    assert calls[1][1] == {"itemId": "q1", "status": "ok", "profile": PROFILE}
    assert calls[3][1]["status"] == "not_found"
    # Waits are capped at an hour so new settings apply soon.
    assert slept == [61.0, 3600.0]


def test_refusals_are_reported_not_retried():
    def fails(exc):
        def fetch(_):
            raise exc

        return fetch

    item = {"id": "q", "username": "x"}
    assert read_one(fails(RateLimited("429")), item)["status"] == "rate_limited"
    assert read_one(fails(Blocked("login")), item)["status"] == "blocked"
    assert read_one(fails(RuntimeError("boom")), item) == {
        "itemId": "q",
        "status": "error",
        "message": "RuntimeError: boom",
    }


def test_keeps_going_when_the_platform_is_unreachable():
    calls = []

    def post(path, body):
        calls.append(path)
        if len(calls) == 1:
            raise urllib.error.URLError("offline")
        return {"action": "wait", "seconds": 5}

    slept = []
    run(post, lambda u: PROFILE, sleep=slept.append, max_steps=2)
    assert slept == [60.0, 5.0]
