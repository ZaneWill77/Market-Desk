"""Offline tests for the compare module."""
import numpy as np
import pandas as pd
import pytest

from app import compare as cmp, market_data as md
from tests.test_backtest import synth


@pytest.fixture
def fake(monkeypatch):
    data = {"AAA": synth(0.002, 1), "BBB": synth(-0.001, 2), "SPY": synth(0.0005, 3), "XLK": synth(0.001, 4)}
    # BBB moves exactly 2x SPY's daily returns -> beta 2, correlation 1
    spy = data["SPY"]["Close"]
    b = 50 * (1 + 2 * spy.pct_change().fillna(0)).cumprod()
    data["BBB"] = data["SPY"].assign(Close=b)
    # a weekend-trading asset (calendar days) to check alignment
    idx = pd.date_range(end=data["SPY"].index[-1], periods=1100, freq="D")
    data["COIN-USD"] = pd.DataFrame({"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": np.linspace(10, 20, 1100), "Volume": 1.0}, index=idx)
    monkeypatch.setattr(md, "get_history", lambda tickers, period="2y", interval="1d", ttl=300:
                        {t: data[t] for t in tickers if t in data})
    monkeypatch.setattr(md, "get_info", lambda s: {"sector": "Technology"} if s == "AAA" else {})
    return data


def test_indexed_and_relative_series(fake):
    r = cmp.compare(["AAA", "BBB"], "1y", "SPY")
    for s in ("AAA", "BBB"):
        assert r["performance"][s][0] == 0 and r["relative"][s][0] == 0
        assert len(r["performance"][s]) == len(r["dates"])
    st = r["stats"]["AAA"]
    assert st["excess"] == pytest.approx(st["total_return"] - st["benchmark_return"])
    assert r["performance"]["AAA"][-1] == pytest.approx(st["total_return"], abs=1e-2)


def test_beta_and_correlation(fake):
    st = cmp.compare(["BBB"], "1y", "SPY")["stats"]["BBB"]
    assert st["beta"] == pytest.approx(2.0, rel=1e-3)
    assert st["correlation"] == pytest.approx(1.0, abs=1e-6)


def test_sector_mode_and_fallback(fake):
    r = cmp.compare(["AAA", "BBB"], "6mo", "sector")
    assert r["stats"]["AAA"]["benchmark_symbol"] == "XLK"
    assert r["stats"]["BBB"]["benchmark_symbol"] == "SPY"


def test_correlation_matrix_shape(fake):
    c = cmp.compare(["AAA", "BBB", "SPY"], "1y", "SPY")["correlation"]
    m = np.array(c["matrix"])
    assert m.shape == (3, 3) and np.allclose(np.diag(m), 1) and np.allclose(m, m.T)


def test_weekend_asset_uses_benchmark_trading_days(fake):
    r = cmp.compare(["COIN-USD"], "1y", "SPY")
    assert all(pd.Timestamp(d).weekday() < 5 for d in r["dates"])


def test_validation(fake):
    with pytest.raises(ValueError):
        cmp.compare([], "1y")
    with pytest.raises(ValueError):
        cmp.compare([f"T{i}" for i in range(9)], "1y")
    with pytest.raises(ValueError):
        cmp.compare(["AAA"], "7y")
    r = cmp.compare(["AAA", "NOPE"], "1y")
    assert r["missing"] == ["NOPE"] and r["symbols"] == ["AAA"]
