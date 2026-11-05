"""Offline tests for alert conditions and the /api/watch endpoint."""
import pytest
from fastapi.testclient import TestClient

from app import alerts, market_data as md
from app.strategies import STRATEGIES
from tests.test_backtest import synth

SNAP = {"price": 105.0, "change_pct": -3.5, "rsi14": 28.0, "sma50": 100.0, "sma200": 110.0,
        "vol_ratio": 2.4, "pct_from_high": -1.5}


@pytest.mark.parametrize("type_, value, met", [
    ("price_above", 100, True), ("price_above", 110, False),
    ("price_below", 106, True), ("price_below", 100, False),
    ("down_pct", 3, True), ("down_pct", 5, False), ("up_pct", 1, False),
    ("rsi_below", 30, True), ("rsi_above", 70, False),
    ("above_sma50", None, True), ("below_sma200", None, True), ("above_sma200", None, False),
    ("volume_spike", 2, True), ("volume_spike", 3, False),
    ("near_high", 2, True), ("near_high", 1, False),
])
def test_conditions(type_, value, met):
    r = alerts.check_alert({"symbol": "X", "type": type_, "value": value}, SNAP)
    assert r["met"] is met and "error" not in r


def test_bad_alerts_never_raise():
    assert alerts.check_alert({"type": "nope"}, SNAP)["error"]
    assert alerts.check_alert({"type": "price_above", "value": None}, SNAP)["error"]
    assert alerts.check_alert({"type": "price_above", "value": 1}, None)["error"]
    assert alerts.check_alert({"type": "score_above", "value": 50, "strategy": "nope"}, SNAP)["met"] is False


def test_every_type_is_described_and_exposed():
    keys = {t["key"] for t in alerts.types_for_ui()}
    assert keys == set(alerts.ALERT_TYPES)
    for k, t in alerts.ALERT_TYPES.items():
        a = {"symbol": "AAPL", "type": k, "value": 5, "strategy": next(iter(STRATEGIES))}
        assert "AAPL" in alerts.describe(a)


def test_watch_endpoint(monkeypatch):
    data = {"AAA": synth(0.002, 1), "BBB": synth(-0.001, 2)}
    monkeypatch.setattr(md, "get_history", lambda tickers, period="2y", interval="1d", ttl=300:
                        {t: data[t] for t in tickers if t in data})
    from app.server import app
    r = TestClient(app).post("/api/watch", json={
        "symbols": ["aaa", "BBB", "ZZZ"],
        "alerts": [{"id": "a1", "symbol": "AAA", "type": "price_above", "value": 1},
                   {"id": "a2", "symbol": "BBB", "type": "price_above", "value": 1e9},
                   {"id": "a3", "symbol": "ZZZ", "type": "rsi_below", "value": 30}]}).json()
    assert set(r["rows"]) == {"AAA", "BBB"} and r["missing"] == ["ZZZ"]
    assert set(r["rows"]["AAA"]["scores"]) == set(STRATEGIES)
    assert r["alerts"]["a1"]["met"] is True
    assert r["alerts"]["a2"]["met"] is False
    assert r["alerts"]["a3"]["error"] == "No data"
