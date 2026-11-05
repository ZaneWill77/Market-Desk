"""Offline tests for calendar helpers and the earnings alert."""
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import alerts, calendar_data as cal, market_data as md
from tests.test_backtest import synth


@pytest.mark.parametrize("name, level", [
    ("CPI MM, SA", "high"), ("Core CPI YY, NSA", "high"), ("CPI Index, NSA", "low"), ("Cleveland Fed CPI", "low"),
    ("Non-Farm Payrolls", "high"), ("Unemployment Rate", "high"), ("Fed Funds Target Rate", "high"),
    ("GDP Final", "high"), ("Core PCE Price Index MM", "high"), ("ISM Manufacturing PMI", "high"),
    ("Initial Jobless Clm", "medium"), ("U Mich Sentiment Prelim", "medium"), ("Housing Starts Number", "medium"),
    ("WSD-Corn Output 26/27", "low"), ("Redbook YY", "low"),
])
def test_impact_rules(name, level):
    assert cal.impact_of(name) == level


def test_session_classification():
    ts = lambda s: pd.Timestamp(s, tz="America/New_York")  # noqa: E731
    assert cal._session(ts("2026-11-10 07:00"), None) == "before_open"
    assert cal._session(ts("2026-11-10 16:05"), None) == "after_close"
    assert cal._session(ts("2026-11-10 12:00"), None) == "during"
    assert cal._session(ts("2026-11-10 12:00"), "AMC") == "after_close"
    assert cal._session(ts("2026-11-10 00:00"), None) == "unknown"


def test_reaction_uses_correct_session():
    idx = pd.bdate_range("2026-11-02", periods=6, tz="America/New_York")  # Mon..Mon
    px = pd.DataFrame({"Close": [100, 102, 110, 99, 101, 100]}, index=idx)
    # After close on Tue (102) -> Wed reacts: 110/102 - 1
    assert cal._reaction(px, pd.Timestamp("2026-11-03 16:30", tz="America/New_York")) == pytest.approx((110 / 102 - 1) * 100)
    # Before open on Thu -> Thu reacts vs Wed close: 99/110 - 1
    assert cal._reaction(px, pd.Timestamp("2026-11-05 07:00", tz="America/New_York")) == pytest.approx((99 / 110 - 1) * 100)


def test_earnings_soon_alert_via_watch(monkeypatch):
    monkeypatch.setattr(md, "get_history", lambda tickers, period="2y", interval="1d", ttl=300:
                        {t: synth(0.001, 1) for t in tickers if t in ("AAA", "BBB")})
    monkeypatch.setattr(cal, "upcoming_for", lambda syms, within_days=90:
                        [{"symbol": "AAA", "date": "2026-11-10", "days_until": 5}])
    from app.server import app
    r = TestClient(app).post("/api/watch", json={"symbols": [], "alerts": [
        {"id": "e1", "symbol": "AAA", "type": "earnings_soon", "value": 7},
        {"id": "e2", "symbol": "AAA", "type": "earnings_soon", "value": 3},
        {"id": "e3", "symbol": "BBB", "type": "earnings_soon", "value": 30}]}).json()
    assert r["alerts"]["e1"] == {"met": True, "current": 5, "text": "AAA reports earnings within 7 days"}
    assert r["alerts"]["e2"]["met"] is False
    assert r["alerts"]["e3"]["met"] is False and r["alerts"]["e3"]["current"] is None


def test_calendar_endpoint_degrades_gracefully(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("yahoo down")
    monkeypatch.setattr(cal, "market_earnings", boom)
    monkeypatch.setattr(cal, "economic_events", lambda days: [{"event": "CPI MM, SA", "impact": "high"}])
    from app.server import app
    r = TestClient(app).get("/api/calendar?days=7").json()
    assert r["earnings"] == [] and r["economic"][0]["impact"] == "high"
    assert "Earnings calendar unavailable" in r["errors"][0]


def test_transient_failure_is_not_cached(monkeypatch):
    calls = {"n": 0}

    class FlakyCalendars:
        def get_earnings_calendar(self, **kw):
            calls["n"] += 1
            if calls["n"] <= 3:  # every retry of the first request fails
                raise ConnectionError("yahoo hiccup")
            return pd.DataFrame({"Company": ["Acme"], "Marketcap": [5e10], "Event Name": ["Q3"],
                                 "Event Start Date": [pd.Timestamp("2030-01-02 21:00", tz="UTC")], "Timing": ["AMC"],
                                 "EPS Estimate": [1.0], "Reported EPS": [float("nan")], "Surprise(%)": [float("nan")]},
                                index=pd.Index(["ACME"], name="Symbol"))
    monkeypatch.setattr(cal.yf, "Calendars", FlakyCalendars)
    monkeypatch.setattr(cal.time, "sleep", lambda s: None)
    md.clear_cache()
    with pytest.raises(ConnectionError):
        cal.market_earnings(3, 10e9)
    assert [e["symbol"] for e in cal.market_earnings(3, 10e9)] == ["ACME"]  # retried, not a cached []


def test_single_hiccup_is_retried(monkeypatch):
    calls = {"n": 0}

    class OnceFlaky:
        def get_economic_events_calendar(self, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise ConnectionError("blip")
            return pd.DataFrame({"Region": ["US"], "Event Time": [pd.Timestamp("2030-01-02 13:30", tz="UTC")],
                                 "For": ["Dec"], "Actual": [None], "Expected": [None], "Last": [3.1], "Revised": [None]},
                                index=pd.Index(["CPI YY, NSA *"], name="Event"))
    monkeypatch.setattr(cal.yf, "Calendars", OnceFlaky)
    monkeypatch.setattr(cal.time, "sleep", lambda s: None)
    md.clear_cache()
    ev = cal.economic_events(3)
    assert ev[0]["event"] == "CPI YY, NSA" and ev[0]["impact"] == "high" and ev[0]["time_et"] == "8:30 AM"
