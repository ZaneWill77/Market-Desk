"""Offline tests for portfolio analysis."""
import numpy as np
import pytest

from app import calendar_data as cal, market_data as md, portfolio as pfm
from tests.test_backtest import synth


@pytest.fixture
def fake(monkeypatch):
    data = {"AAA": synth(0.002, 1), "BBB": synth(0.0005, 2), "CCC": synth(-0.001, 3), "SPY": synth(0.0004, 9)}
    data["DUP"] = data["AAA"].copy()  # perfectly correlated with AAA
    monkeypatch.setattr(md, "get_history", lambda tickers, period="2y", interval="1d", ttl=300:
                        {t: data[t] for t in tickers if t in data})
    info = {"AAA": {"quoteType": "EQUITY", "sector": "Technology", "shortName": "Aaa Inc"},
            "BBB": {"quoteType": "EQUITY", "sector": "Technology"}, "DUP": {"quoteType": "EQUITY", "sector": "Energy"},
            "CCC": {"quoteType": "EQUITY", "sector": "Utilities"}, "SPY": {"quoteType": "ETF", "category": "Large Blend"}}
    monkeypatch.setattr(md, "get_info", lambda s: info.get(s, {}))
    monkeypatch.setattr(cal, "upcoming_for", lambda syms, within_days=45:
                        [{"symbol": "AAA", "date": "2030-01-01", "days_until": 3}])
    return data


def test_parse_merges_duplicates_and_drops_bad_rows():
    h = pfm.parse_holdings([{"symbol": "aapl", "shares": 10, "cost": 100}, {"symbol": "AAPL", "shares": 30, "cost": 200},
                            {"symbol": "MSFT", "shares": "5", "cost": "abc"}, {"symbol": "X", "shares": 0},
                            {"symbol": "Y", "shares": -3}, {"symbol": "Z", "shares": "nope"}])
    assert [x["symbol"] for x in h] == ["AAPL", "MSFT"]
    assert h[0]["shares"] == 40 and h[0]["cost"] == pytest.approx(175)
    assert h[1]["cost"] is None


def test_values_weights_pnl(fake):
    r = pfm.analyze([{"symbol": "AAA", "shares": 10, "cost": 50}, {"symbol": "BBB", "shares": 20},
                     {"symbol": "NOPE", "shares": 1}], cash=1000)
    pos = {p["symbol"]: p for p in r["positions"]}
    t = r["totals"]
    assert r["missing"] == ["NOPE"]
    assert t["value"] == pytest.approx(sum(p["value"] for p in r["positions"]) + 1000)
    assert sum(p["weight"] for p in r["positions"]) + t["cash_pct"] == pytest.approx(100)
    assert pos["AAA"]["pnl"] == pytest.approx(pos["AAA"]["value"] - 500)
    assert pos["BBB"]["pnl"] is None and t["pnl_positions"] == 1
    assert sum(p["risk_contribution"] for p in r["positions"]) == pytest.approx(100)
    assert {a["name"] for a in r["allocation"]["asset_type"]} == {"Stock", "Cash"}


def test_beta_of_benchmark_is_one(fake):
    r = pfm.analyze([{"symbol": "SPY", "shares": 100}])
    assert r["risk"]["beta"] == pytest.approx(1.0, abs=1e-6)
    assert r["performance"]["total_return"] == pytest.approx(r["performance"]["benchmark_return"], abs=1e-6)
    assert r["positions"][0]["asset_type"] == "ETF" and r["positions"][0]["sector"] == "Fund: Large Blend"


def test_cash_dampens_risk(fake):
    no_cash = pfm.analyze([{"symbol": "AAA", "shares": 10}])
    pos_value = no_cash["totals"]["value"]
    half_cash = pfm.analyze([{"symbol": "AAA", "shares": 10}], cash=pos_value)
    assert half_cash["risk"]["volatility"] == pytest.approx(no_cash["risk"]["volatility"] / 2, rel=1e-6)
    assert half_cash["risk"]["beta"] == pytest.approx(no_cash["risk"]["beta"] / 2, rel=1e-6)


def test_observations(fake):
    r = pfm.analyze([{"symbol": "AAA", "shares": 100, "cost": 1e6}, {"symbol": "DUP", "shares": 1}, {"symbol": "CCC", "shares": 1}])
    text = " ".join(o["text"] for o in r["observations"])
    assert "Concentration: AAA" in text
    assert "Earnings this week: AAA (3d)" in text
    assert "AAA/DUP 1.00" in text
    assert "Down 20%+ from cost: AAA" in text


def test_funds_not_flagged_as_concentration(fake):
    r = pfm.analyze([{"symbol": "SPY", "shares": 1000}, {"symbol": "CCC", "shares": 1}])
    assert not any(o["text"].startswith("Concentration") for o in r["observations"])


def test_validation(fake):
    with pytest.raises(ValueError):
        pfm.analyze([])
    with pytest.raises(ValueError):
        pfm.analyze([{"symbol": "AAA", "shares": 1}], period="9y")
    with pytest.raises(ValueError):
        pfm.analyze([{"symbol": f"T{i}", "shares": 1} for i in range(101)])
