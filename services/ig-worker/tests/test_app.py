import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from instaloader import exceptions as ie

from ig_worker import fetch as fetch_mod
from ig_worker.app import create_app
from ig_worker.fetch import Blocked, NotFound, RateLimited, fetch_profile, profile_to_dict

SECRET = "s3cret"
PROFILE = {"igUserId": "1", "username": "acme", "isBusiness": True, "isVerified": False}


def client(fetch, interval=0.0, jitter=0.0):
    return TestClient(create_app(fetch=fetch, secret=SECRET, min_interval=interval, jitter=jitter))


def test_health():
    assert client(lambda u: PROFILE).get("/health").json() == {"status": "ok"}


def test_requires_secret():
    c = client(lambda u: PROFILE)
    assert c.get("/profile/acme").status_code == 401
    assert c.get("/profile/acme", headers={"x-worker-secret": "nope"}).status_code == 401


def test_refuses_to_start_without_secret(monkeypatch):
    monkeypatch.delenv("WORKER_SHARED_SECRET", raising=False)
    with pytest.raises(RuntimeError):
        create_app(fetch=lambda u: PROFILE)


def test_returns_profile_and_normalises_username():
    seen = []

    def fetch(u):
        seen.append(u)
        return PROFILE

    r = client(fetch).get("/profile/@Acme", headers={"x-worker-secret": SECRET})
    assert r.status_code == 200
    assert r.json() == PROFILE
    assert seen == ["acme"]


def test_rejects_invalid_usernames():
    r = client(lambda u: PROFILE).get("/profile/bad%20name!", headers={"x-worker-secret": SECRET})
    assert r.status_code == 400


@pytest.mark.parametrize(
    ("exc", "status"),
    [(NotFound("x"), 404), (RateLimited("x"), 429), (Blocked("x"), 403)],
)
def test_maps_errors(exc, status):
    def fetch(u):
        raise exc

    r = client(fetch).get("/profile/acme", headers={"x-worker-secret": SECRET})
    assert r.status_code == status


def test_spaces_requests():
    c = client(lambda u: PROFILE, interval=0.3)
    h = {"x-worker-secret": SECRET}
    start = time.monotonic()
    for _ in range(3):
        assert c.get("/profile/acme", headers=h).status_code == 200
    assert time.monotonic() - start >= 0.55


def fake_profile(**node):
    return SimpleNamespace(
        userid=42,
        username="Acme",
        full_name=" Acme FX ",
        biography="bio",
        followers=10,
        followees=2,
        mediacount=3,
        is_business_account=True,
        is_verified=False,
        business_category_name="",
        external_url=None,
        _node=node,
    )


def test_profile_to_dict_maps_fields_and_contact_button():
    d = profile_to_dict(
        fake_profile(
            business_email="a@acme.com",
            business_phone_number="501234567",
            public_phone_country_code="966",
        )
    )
    assert d == {
        "igUserId": "42",
        "username": "acme",
        "fullName": "Acme FX",
        "bio": "bio",
        "followers": 10,
        "following": 2,
        "posts": 3,
        "isBusiness": True,
        "isVerified": False,
        "category": None,
        "externalUrl": None,
        "businessEmail": "a@acme.com",
        "businessPhone": "501234567",
        "businessPhoneCountryCode": "966",
        "businessWhatsapp": None,
        "city": None,
        "recentPosts": None,
    }


@pytest.mark.parametrize(
    ("raised", "expected"),
    [
        (ie.ProfileNotExistsException("gone"), NotFound),
        (ie.QueryReturnedNotFoundException("404"), NotFound),
        (ie.TooManyRequestsException("429"), RateLimited),
        (ie.LoginRequiredException("login"), Blocked),
        (ie.QueryReturnedForbiddenException("403"), Blocked),
        (ie.ConnectionException("redirected to login"), Blocked),
        (ie.ConnectionException("HTTP error code 429"), RateLimited),
    ],
)
def test_fetch_profile_maps_instaloader_errors(monkeypatch, raised, expected):
    def boom(ctx, username):
        raise raised

    monkeypatch.setattr(fetch_mod.instaloader.Profile, "from_username", boom)
    with pytest.raises(expected):
        fetch_profile(SimpleNamespace(context=None), "acme")


def test_fetch_profile_success(monkeypatch):
    monkeypatch.setattr(
        fetch_mod.instaloader.Profile, "from_username", lambda ctx, u: fake_profile()
    )
    assert fetch_profile(SimpleNamespace(context=None), "acme")["igUserId"] == "42"


def test_loader_fails_fast_on_429():
    loader = fetch_mod.make_loader()
    with pytest.raises(RateLimited):
        loader.context._rate_controller.handle_429("graphql")


def test_profile_to_dict_reads_city_whatsapp_and_recent_posts():
    d = profile_to_dict(
        fake_profile(
            business_address_json='{"city_name": "Baghdad", "street_address": "x"}',
            whatsapp_number="+9647701234567",
            edge_owner_to_timeline_media={
                "edges": [
                    {
                        "node": {
                            "edge_liked_by": {"count": 10},
                            "edge_media_to_comment": {"count": 2},
                            "shortcode": "ABC",
                            "edge_media_to_caption": {
                                "edges": [{"node": {"text": "مع @gold.academy"}}]
                            },
                        }
                    },
                    {"node": {"edge_media_preview_like": {"count": 7}}},
                    "junk",
                ]
            },
        )
    )
    assert d["city"] == "Baghdad"
    assert d["businessWhatsapp"] == "+9647701234567"
    assert d["recentPosts"] == [
        {
            "likes": 10,
            "comments": 2,
            "caption": "مع @gold.academy",
            "url": "https://www.instagram.com/p/ABC/",
        },
        {"likes": 7, "comments": None, "caption": None, "url": None},
    ]


def test_city_tolerates_bad_json():
    assert profile_to_dict(fake_profile(business_address_json="{not json"))["city"] is None
    assert profile_to_dict(fake_profile(city_name="Dubai"))["city"] == "Dubai"


def test_loader_uses_proxy():
    loader = fetch_mod.make_loader("http://proxy.example:8080")
    assert loader.context._session.proxies == {
        "http": "http://proxy.example:8080",
        "https": "http://proxy.example:8080",
    }


def test_jitter_adds_random_wait(monkeypatch):
    import ig_worker.app as app_mod

    monkeypatch.setattr(app_mod.random, "uniform", lambda a, b: 0.25)
    c = client(lambda u: PROFILE, interval=0.0, jitter=1.0)
    h = {"x-worker-secret": SECRET}
    start = time.monotonic()
    c.get("/profile/acme", headers=h)
    c.get("/profile/acme", headers=h)
    assert time.monotonic() - start >= 0.25
