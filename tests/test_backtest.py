"""Offline backtest tests using synthetic prices (no network)."""
import numpy as np
import pandas as pd
import pytest

from app import backtest, market_data as md
from app.indicators import snapshot_series


def synth(trend: float, seed: int, n: int = 760) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 100 * np.cumprod(1 + trend + rng.normal(0, 0.012, n))
    idx = pd.bdate_range(end="2026-10-30", periods=n)
    return pd.DataFrame({"Open": close, "High": close * 1.01, "Low": close * 0.99, "Close": close,
                         "Volume": rng.integers(1e6, 3e6, n).astype(float)}, index=idx)


@pytest.fixture
def fake_market(monkeypatch):
    data = {f"T{i}": synth(trend, i) for i, trend in enumerate(np.linspace(-0.001, 0.0015, 12))}
    data["SPY"] = synth(0.0004, 99)
    monkeypatch.setattr(md, "get_history", lambda tickers, period="2y", interval="1d":
                        {t: data[t] for t in map(md.normalize, tickers) if t in data})
    return data


def test_indicators_have_no_lookahead():
    df = synth(0.001, 1)
    full = snapshot_series(df)
    for i in (260, 400, 700):
        partial = snapshot_series(df.iloc[: i + 1]).iloc[-1]
        pd.testing.assert_series_equal(full.iloc[i], partial, check_names=False, rtol=1e-9)


def test_backtest_shapes_and_sanity(fake_market):
    tickers = [f"T{i}" for i in range(12)]
    r = backtest.run_backtest("momentum", "custom", tickers, period="2y", rebalance="monthly", top_n=3)
    s = r["stats"]
    assert {"strategy", "benchmark", "universe"} <= set(s)
    for k in ("total_return", "cagr", "volatility", "max_drawdown"):
        assert np.isfinite(s["strategy"][k])
    assert s["strategy"]["max_drawdown"] <= 0
    assert all(len(p["holdings"]) == 3 for p in r["periods"])
    assert 20 <= len(r["periods"]) <= 26
    curve = r["curves"]["strategy"]["values"]
    assert curve[0] == pytest.approx(1.0) and len(curve) == len(r["curves"]["strategy"]["dates"])
    # Momentum on trending synthetic data should favor the strongest uptrends.
    held = [h["symbol"] for h in r["periods"][0]["holdings"]]
    assert any(t in held for t in ("T9", "T10", "T11"))


def test_costs_reduce_returns(fake_market):
    tickers = [f"T{i}" for i in range(12)]
    free = backtest.run_backtest("mean_reversion", "custom", tickers, "1y", "weekly", 3, cost_bps=0)
    costly = backtest.run_backtest("mean_reversion", "custom", tickers, "1y", "weekly", 3, cost_bps=50)
    assert costly["stats"]["strategy"]["total_return"] < free["stats"]["strategy"]["total_return"]


def test_backtest_validates_input(fake_market):
    with pytest.raises(ValueError):
        backtest.run_backtest("nope", "custom", ["T1", "T2"])
    with pytest.raises(ValueError):
        backtest.run_backtest("momentum", "custom", ["T1", "T2"], period="9y")
