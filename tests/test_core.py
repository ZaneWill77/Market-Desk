"""Offline tests (no network): indicators, strategy plugins, tools registry and auth."""
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import auth
from app.indicators import snapshot
from app.strategies import STRATEGIES, evaluate, ordered
from app.tools import TOOLS


def make_df(trend: float = 0.001, n: int = 400, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 100 * np.cumprod(1 + trend + rng.normal(0, 0.01, n))
    idx = pd.bdate_range("2024-01-01", periods=n)
    return pd.DataFrame({"Open": close * 0.995, "High": close * 1.01, "Low": close * 0.99,
                         "Close": close, "Volume": rng.integers(1e6, 2e6, n).astype(float)}, index=idx)


def test_snapshot_fields():
    s = snapshot(make_df())
    for k in ("price", "sma50", "sma200", "rsi14", "macd", "adx14", "ret_12_1", "vol_60d"):
        assert s[k] is not None, k
    assert 0 <= s["rsi14"] <= 100


def test_all_strategies_registered_and_bounded():
    assert {"composite", "momentum", "trend", "mean_reversion", "breakout"} <= set(STRATEGIES)
    assert "example" not in STRATEGIES  # _template.py must not be auto-loaded
    for df in (make_df(0.002), make_df(-0.002), make_df(0.0, n=60)):
        snap = snapshot(df)
        for key in STRATEGIES:
            r = evaluate(key, snap)
            assert 0 <= r["score"] <= 100
            assert r["rating"] in {"Strong", "Favorable", "Neutral", "Weak", "Avoid"}
            assert isinstance(r["reasons"], list)


def test_uptrend_beats_downtrend_on_trend_strategies():
    up, down = snapshot(make_df(0.002)), snapshot(make_df(-0.002))
    for key in ("momentum", "trend"):
        assert evaluate(key, up)["score"] > evaluate(key, down)["score"]


def test_ordered_puts_composite_first():
    assert ordered()[0].key == "composite"


def test_tool_schemas_are_strict():
    assert TOOLS
    for t in TOOLS.values():
        assert t.input_schema["type"] == "object"
        assert t.input_schema["additionalProperties"] is False
        assert set(t.input_schema["required"]) <= set(t.input_schema["properties"])


@pytest.fixture
def client():
    from app.server import app
    return TestClient(app)


def test_signed_out_by_default(client):
    me = client.get("/api/auth/me").json()
    assert me["signed_in"] is False
    assert any(p["id"] == "anthropic" for p in me["providers"])


def test_chat_requires_sign_in(client):
    r = client.post("/api/chat", json={"message": "hi"})
    assert r.status_code == 401


def test_rejects_malformed_key(client):
    r = client.post("/api/auth/login", json={"provider": "anthropic", "api_key": "not-a-key"})
    assert r.status_code == 400


class FakeLocalProvider:
    ID, NAME, NEEDS_API_KEY, LOCAL_ONLY, MODELS = "fake_local", "Fake", False, True, [("", "Default")]

    @staticmethod
    async def check_login():
        return None


def test_published_app_ships_only_api_key_provider():
    import pathlib
    import app.providers as prov
    tracked = [p.stem for p in pathlib.Path(prov.__file__).parent.glob("*.py")
               if not p.stem.startswith(("local_", "_"))]
    assert sorted(tracked) == ["anthropic_api", "base"]
    assert all(m.LOCAL_ONLY or m.NEEDS_API_KEY for m in prov.PROVIDERS.values())


def test_local_only_provider_hidden_and_refused_remotely(client, monkeypatch):
    from app import providers
    monkeypatch.setitem(providers.PROVIDERS, FakeLocalProvider.ID, FakeLocalProvider)
    # TestClient's host is "testclient", i.e. not this machine
    assert all(p["id"] != "fake_local" for p in client.get("/api/auth/me").json()["providers"])
    assert client.post("/api/auth/login", json={"provider": "fake_local"}).status_code == 403


def test_local_only_provider_refused_behind_proxy(monkeypatch):
    from starlette.requests import Request
    scope = {"type": "http", "client": ("127.0.0.1", 1234),
             "headers": [(b"x-forwarded-for", b"203.0.113.5")]}
    assert auth.is_local(Request(scope)) is False
    assert auth.is_local(Request({**scope, "headers": []})) is True


def test_sign_in_and_out(client, monkeypatch):
    async def ok(key):
        return None
    from app.providers import anthropic_api
    monkeypatch.setattr(anthropic_api, "validate_key", ok)
    r = client.post("/api/auth/login", json={"provider": "anthropic", "api_key": "sk-ant-test-123456789"})
    assert r.status_code == 200
    me = client.get("/api/auth/me").json()
    assert me["signed_in"] and me["key_hint"] == "sk-ant-…6789"
    assert "sk-ant-test-123456789" not in str(me)  # full key never returned
    assert len(auth._sessions) >= 1
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").json()["signed_in"] is False
