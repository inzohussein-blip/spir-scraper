"""Fetches one public profile with Instaloader, anonymously.

The worker never logs in. Anything that needs a login (a challenge, a login
wall, a ban) is reported as ``Blocked`` so the router moves to another
provider instead of retrying.
"""

from __future__ import annotations

import json
from typing import Any

import instaloader
from instaloader import exceptions as ie


class NotFound(Exception):
    pass


class RateLimited(Exception):
    pass


class Blocked(Exception):
    pass


class FailFastRateController(instaloader.RateController):
    """Instaloader sleeps on 429 by default; a service should fail fast instead."""

    def handle_429(self, query_type: str) -> None:
        raise RateLimited(f"Instagram rate limit ({query_type})")


def make_loader(proxy: str | None = None) -> instaloader.Instaloader:
    """Anonymous loader. ``proxy`` (e.g. a residential proxy URL) applies to every request."""
    loader = instaloader.Instaloader(
        quiet=True,
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        max_connection_attempts=1,
        rate_controller=FailFastRateController,
    )
    if proxy:
        session = getattr(loader.context, "_session", None)
        if session is not None:
            session.proxies = {"http": proxy, "https": proxy}
    return loader


def _str(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _count(d: Any, *keys: str) -> int | None:
    for k in keys:
        v = d.get(k) if isinstance(d, dict) else None
        if isinstance(v, dict) and isinstance(v.get("count"), int):
            return v["count"]
    return None


def _recent_posts(node: dict[str, Any]) -> list[dict[str, int | None]] | None:
    """Likes and comments of the up to 12 posts that come with the profile page."""
    edges = (node.get("edge_owner_to_timeline_media") or {}).get("edges")
    if not isinstance(edges, list):
        return None
    posts = []
    for e in edges[:12]:
        n = e.get("node") if isinstance(e, dict) else None
        if not isinstance(n, dict):
            continue
        posts.append(
            {
                "likes": _count(n, "edge_liked_by", "edge_media_preview_like"),
                "comments": _count(n, "edge_media_to_comment"),
            }
        )
    return posts


def _city(node: dict[str, Any]) -> str | None:
    raw = node.get("business_address_json")
    if isinstance(raw, str) and raw.strip():
        try:
            return _str(json.loads(raw).get("city_name"))
        except ValueError, AttributeError:
            return None
    return _str(node.get("city_name"))


def profile_to_dict(p: instaloader.Profile) -> dict[str, Any]:
    """Maps an Instaloader profile to the RawProfile shape used by @scrapers/core."""
    node: dict[str, Any] = getattr(p, "_node", {}) or {}
    return {
        "igUserId": str(p.userid),
        "username": p.username.lower(),
        "fullName": _str(p.full_name),
        "bio": _str(p.biography),
        "followers": p.followers,
        "following": p.followees,
        "posts": p.mediacount,
        "isBusiness": bool(p.is_business_account),
        "isVerified": bool(p.is_verified),
        "category": _str(p.business_category_name),
        "externalUrl": _str(p.external_url),
        # Public contact-button fields, present for some business accounts.
        "businessEmail": _str(node.get("business_email") or node.get("public_email")),
        "businessPhone": _str(node.get("business_phone_number") or node.get("public_phone_number")),
        "businessPhoneCountryCode": _str(node.get("public_phone_country_code")),
        "businessWhatsapp": _str(
            node.get("whatsapp_number") or node.get("business_whatsapp_number")
        ),
        "city": _city(node),
        "recentPosts": _recent_posts(node),
    }


def fetch_profile(loader: instaloader.Instaloader, username: str) -> dict[str, Any]:
    try:
        profile = instaloader.Profile.from_username(loader.context, username)
    except ie.ProfileNotExistsException as e:
        raise NotFound(str(e)) from e
    except ie.QueryReturnedNotFoundException as e:
        raise NotFound(str(e)) from e
    except ie.TooManyRequestsException as e:
        raise RateLimited(str(e)) from e
    except (
        ie.LoginRequiredException,
        ie.LoginException,
        ie.QueryReturnedForbiddenException,
        ie.ConnectionException,
    ) as e:
        # ConnectionException covers redirects to the login page and 401s.
        if "429" in str(e) or "Too Many Requests" in str(e):
            raise RateLimited(str(e)) from e
        raise Blocked(str(e)) from e
    return profile_to_dict(profile)
