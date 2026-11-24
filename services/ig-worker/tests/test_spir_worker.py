"""The standalone home worker (spir_worker.py, standard library only)."""

import importlib.util
import io
import json
import urllib.error
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "spir_worker", Path(__file__).resolve().parent.parent / "spir_worker.py"
)
sw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sw)

USER = {
    "id": "42",
    "username": "Coach",
    "full_name": "Coach",
    "biography": "مدرب تداول @gold.academy",
    "edge_followed_by": {"count": 5000},
    "edge_follow": {"count": 10},
    "is_business_account": True,
    "business_email": "c@example.com",
    "edge_owner_to_timeline_media": {
        "count": 3,
        "edges": [
            {
                "node": {
                    "shortcode": "AB",
                    "edge_liked_by": {"count": 9},
                    "edge_media_to_comment": {"count": 1},
                    "edge_media_to_caption": {"edges": [{"node": {"text": "مع @guest"}}]},
                }
            }
        ],
    },
}


class Res(io.BytesIO):
    def __init__(self, body, url="https://www.instagram.com/api/v1/users/web_profile_info/"):
        super().__init__(json.dumps(body).encode() if not isinstance(body, bytes) else body)
        self._url = url

    def geturl(self):
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener(answer):
    calls = []

    def open_url(req, timeout):
        calls.append(req.full_url)
        if isinstance(answer, Exception):
            raise answer
        return answer(req) if callable(answer) else answer

    open_url.calls = calls
    return open_url


def http_error(code):
    return urllib.error.HTTPError("u", code, "x", {}, None)


def test_maps_the_public_profile():
    p = sw.fetch_profile(opener(Res({"data": {"user": USER}})), "coach")
    assert p["username"] == "coach"
    assert p["followers"] == 5000
    assert p["businessEmail"] == "c@example.com"
    assert p["recentPosts"][0] == {
        "likes": 9,
        "comments": 1,
        "caption": "مع @guest",
        "url": "https://www.instagram.com/p/AB/",
    }


@pytest.mark.parametrize(
    "answer, error",
    [
        (http_error(404), sw.NotFound),
        (http_error(429), sw.RateLimited),
        (http_error(401), sw.Blocked),
        (Res(b"<html>login</html>"), sw.Blocked),
        (Res({"data": {"user": None}}), sw.NotFound),
        (Res({}, url="https://www.instagram.com/accounts/login/"), sw.Blocked),
    ],
)
def test_refusals_and_missing_accounts(answer, error):
    with pytest.raises(error):
        sw.fetch_profile(opener(answer), "x")


def test_pool_moves_to_the_next_exit_and_rests_the_refused_one():
    t = [1000.0]
    a = sw.Exit("a", "a", None, open_url=opener(http_error(429)))
    b = sw.Exit("b", "b", None, open_url=opener(Res({"data": {"user": USER}})))
    pool = sw.Pool([a, b], clock=lambda: t[0])
    profile, exit_id = pool.fetch("coach")
    assert exit_id == "b" and profile["username"] == "coach"
    assert not a.ok(t[0]) and a.error
    # With every exit refusing, the refusal is reported with the exit it came from.
    b.open = opener(http_error(403))
    with pytest.raises(sw.Blocked) as e:
        pool.fetch("coach")
    assert e.value.exit_id == "b"
    with pytest.raises(sw.RateLimited):
        pool.fetch("coach")  # all resting now


def test_exits_from_dashboard_proxies():
    cfg = {
        "version": "v1",
        "useDirect": False,
        "proxies": [{"id": "p1", "url": "http://u:pw@proxy.example:8000", "rotateUrl": None}],
    }
    exits = sw.build_exits(cfg, ["http://env:1"])
    assert [(e.id, e.label) for e in exits] == [("p1", "proxy.example:8000")]
    assert [e.id for e in sw.build_exits({**cfg, "useDirect": True}, [])] == ["direct", "p1"]
    assert [e.id for e in sw.build_exits(None, ["http://env:1"])] == ["env-0"]
    assert [e.id for e in sw.build_exits(None, [])] == ["direct"]


def test_loop_reads_reports_applies_settings_and_rotates():
    sent = []
    rotated = []
    decisions = [
        {
            "action": "read",
            "item": {"id": "q1", "username": "coach"},
            "config": {
                "version": "v2",
                "useDirect": False,
                "proxies": [
                    {
                        "id": "p1",
                        "url": "http://proxy.example:8000",
                        "rotateUrl": "https://rot.example/x",
                    }
                ],
            },
            "commands": [{"id": "c1", "type": "rotate", "proxyId": "p1"}],
        },
        {"action": "wait", "seconds": 99999, "reason": "pace"},
    ]

    def post(path, body):
        sent.append((path, body))
        return decisions.pop(0)

    slept = []
    w = sw.Worker(post, "pc-1", "home", sleep=slept.append, rotate=rotated.append)
    # Stub network: profiles and the IP echo go through the stub opener.
    real_build = sw.build_exits

    def build(cfg, env):
        exits = real_build(cfg, env)
        for e in exits:
            e.open = opener(
                lambda req: (
                    Res({"ip": "5.6.7.8"})
                    if "ipify" in req.full_url
                    else Res({"data": {"user": USER}})
                )
            )
        return exits

    sw.build_exits = build
    try:
        w.run(max_steps=2)
    finally:
        sw.build_exits = real_build
    assert [p for p, _ in sent] == ["/api/engine/next", "/api/engine/report"]
    assert sent[0][1]["worker"]["kind"] == "program"
    report = sent[1][1]
    assert report["status"] == "ok" and report["exitId"] == "p1"
    assert report["worker"]["configVersion"] == "v2"
    assert report["worker"]["exits"][0]["ip"] == "5.6.7.8"
    assert rotated == ["https://rot.example/x"]
    assert slept == [3600.0]


def test_survives_an_unreachable_dashboard():
    calls = []

    def post(path, body):
        calls.append(path)
        if len(calls) == 1:
            raise urllib.error.URLError("offline")
        return {"action": "wait", "seconds": 5}

    slept = []
    sw.Worker(post, "pc", "n", sleep=slept.append).run(max_steps=2)
    assert slept == [60.0, 5.0]


def test_stable_worker_id(tmp_path):
    f = tmp_path / "id.json"
    first = sw.worker_id(f)
    assert first.startswith("pc-") and sw.worker_id(f) == first


def test_reads_a_batch_at_the_pace_and_hands_back_the_rest_after_a_refusal():
    sent = []
    decisions = [
        {
            "action": "batch",
            "intervalSec": 60,
            "jitterSec": 0,
            "items": [
                {"id": "q1", "username": "a"},
                {"id": "q2", "username": "b"},
                {"id": "q3", "username": "c"},
                {"id": "q4", "username": "d"},
            ],
        },
        {"action": "wait", "seconds": 1800, "reason": "resting"},
    ]

    def post(path, body):
        sent.append((path, body))
        return decisions.pop(0)

    slept = []
    w = sw.Worker(post, "pc", "n", sleep=slept.append)

    def answer(req):
        if "username=c" in req.full_url:
            raise http_error(429)
        return Res({"data": {"user": {**USER, "username": "x"}}})

    for e in w.pool.exits:
        e.open = opener(answer)
    w.run(max_steps=2)
    assert sent[0][1]["worker"]["batch"] is True
    path, body = sent[1]
    assert path == "/api/engine/report"
    assert [r["status"] for r in body["reports"]] == ["ok", "ok", "rate_limited", "released"]
    # One wait between accounts (two of them), then the dashboard's wait.
    assert slept == [60.0, 60.0, 1800.0]
