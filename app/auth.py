"""Sign-in sessions.

Each browser gets a random session id in an HttpOnly cookie. The API key a user enters is
kept only in this process's memory, attached to that session - never written to disk,
never sent back to the browser, and dropped on sign-out, expiry or server restart.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field

from fastapi import Request, Response

from . import config

COOKIE = "md_session"


@dataclass
class Session:
    provider: str  # provider ID, e.g. "anthropic"
    api_key: str | None = None
    created: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    conversations: dict[str, list] = field(default_factory=dict)  # used by the API provider

    @property
    def key_hint(self) -> str | None:
        return f"{self.api_key[:7]}…{self.api_key[-4:]}" if self.api_key else None


_sessions: dict[str, Session] = {}
_lock = threading.Lock()


def _expired(s: Session) -> bool:
    return time.time() - s.last_seen > config.SESSION_TTL_HOURS * 3600


def get(request: Request) -> Session | None:
    sid = request.cookies.get(COOKIE)
    if not sid:
        return None
    with _lock:
        s = _sessions.get(sid)
        if s and _expired(s):
            _sessions.pop(sid, None)
            return None
        if s:
            s.last_seen = time.time()
        return s


def create(response: Response, session: Session) -> None:
    sid = secrets.token_urlsafe(32)
    with _lock:
        for k in [k for k, v in _sessions.items() if _expired(v)]:
            _sessions.pop(k, None)
        _sessions[sid] = session
    response.set_cookie(COOKIE, sid, httponly=True, samesite="strict", secure=config.SECURE_COOKIES,
                        max_age=int(config.SESSION_TTL_HOURS * 3600), path="/")


def destroy(request: Request, response: Response, clear_cookie: bool = True) -> None:
    sid = request.cookies.get(COOKIE)
    if sid:
        with _lock:
            s = _sessions.pop(sid, None)
        if s:
            s.api_key = None
            s.conversations.clear()
    if clear_cookie:
        response.delete_cookie(COOKIE, path="/")


def is_local(request: Request) -> bool:
    """True only for direct requests from this machine (not via a reverse proxy)."""
    host = request.client.host if request.client else ""
    proxied = any(h in request.headers for h in ("x-forwarded-for", "x-real-ip", "forwarded"))
    return host in ("127.0.0.1", "::1", "localhost") and not proxied

