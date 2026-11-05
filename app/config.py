"""Runtime settings, read from environment variables (see .env.example)."""
from __future__ import annotations

import os


def _flag(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))

# How long a signed-in session lasts without activity (hours).
SESSION_TTL_HOURS = float(os.environ.get("SESSION_TTL_HOURS", "12"))

# Set when serving over HTTPS so session cookies get the Secure flag.
SECURE_COOKIES = _flag("SECURE_COOKIES")
