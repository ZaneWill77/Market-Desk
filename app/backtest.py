"""Strategy backtester.

On each rebalance date the strategy scores every ticker using only data available at that
day's close (indicators are computed causally - see indicators.snapshot_series). The top N
are bought in equal weight at that close and held until the next rebalance close.

Results are compared with a benchmark (SPY by default) and with an equal-weight portfolio
of the whole universe, so you can tell whether the strategy's *selection* added value.

Known limitations (also shown in the UI):
- Survivorship bias: universes are today's lists, so past losers that left an index are missing.
- Prices are Yahoo's split/dividend-adjusted closes; no slippage beyond the cost setting.
"""
from __future__ import annotations

from datetime import datetime

import numpy as np
import pandas as pd

from . import market_data as md
from .indicators import row_to_snapshot, snapshot_series
from .strategies import STRATEGIES, evaluate

# Test window -> history to download (extra year so 200-day / 12-month indicators are warm).
PERIODS = {"1y": ("2y", 1), "2y": ("5y", 2), "3y": ("5y", 3), "5y": ("10y", 5)}
REBALANCE = {"monthly": 12, "weekly": 52}


def _rebalance_dates(index: pd.DatetimeIndex, start: pd.Timestamp, freq: str) -> list[pd.Timestamp]:
    idx = index[index >= start]
    if freq == "weekly":
        dates = list(idx[::5])
    else:  # last trading day of each month
        s = pd.Series(idx, index=idx)
        dates = list(s.groupby([idx.year, idx.month]).max())
        if dates and dates[0] > idx[0]:
            dates.insert(0, idx[0])  # start investing on the first day of the window
    if dates and dates[-1] != index[-1]:
        dates.append(index[-1])  # mark-to-market through the latest close
    return dates


def _stats(equity: pd.Series, period_rets: list[float] | None = None) -> dict:
    daily = equity.pct_change().dropna()
    years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1e-9)
    total = equity.iloc[-1] / equity.iloc[0] - 1
    vol = daily.std() * np.sqrt(252)
    dd = (equity / equity.cummax() - 1).min()
    out = {
        "total_return": total * 100,
        "cagr": ((1 + total) ** (1 / years) - 1) * 100,
        "volatility": vol * 100,
        "sharpe": (daily.mean() / daily.std() * np.sqrt(252)) if daily.std() > 0 else None,
        "max_drawdown": dd * 100,
    }
    if period_rets:
        out["win_rate"] = sum(r > 0 for r in period_rets) / len(period_rets) * 100
    return out


def _basket_path(closes: pd.DataFrame, symbols: list[str], t0, t1) -> pd.Series:
    """Equal-weight buy-and-hold value path (starting at 1.0) from close t0 to close t1."""
    window = closes.loc[t0:t1, symbols]
    rel = window / window.iloc[0]
    return rel.mean(axis=1)


def run_backtest(strategy: str, universe: str, custom: list[str] | None = None, period: str = "2y",
                 rebalance: str = "monthly", top_n: int = 10, cost_bps: float = 10.0,
                 benchmark: str = "SPY") -> dict:
    from .bot import UNIVERSES  # local import avoids a cycle with bot -> strategies

    if strategy not in STRATEGIES:
        raise ValueError(f"Unknown strategy '{strategy}'. Options: {', '.join(STRATEGIES)}")
    if period not in PERIODS:
        raise ValueError(f"period must be one of {', '.join(PERIODS)}")
    if rebalance not in REBALANCE:
        raise ValueError(f"rebalance must be one of {', '.join(REBALANCE)}")
    tickers = custom if universe == "custom" else UNIVERSES.get(universe, {}).get("tickers")
    if not tickers:
        raise ValueError("No tickers to backtest. Pick a universe or enter custom tickers.")
    top_n = int(max(1, min(top_n, 50)))
    cost = max(0.0, float(cost_bps)) / 10000

    fetch, years = PERIODS[period]
    bench = md.normalize(benchmark)
    data = md.get_history(list(tickers) + [bench], period=fetch)
    if bench not in data:
        raise ValueError(f"No data for benchmark {bench}")
    names = [t for t in data if t in {md.normalize(x) for x in tickers}]
    if len(names) < 2:
        raise ValueError("Need price history for at least 2 tickers.")

    calendar = data[bench].index
    closes = pd.DataFrame({t: data[t]["Close"] for t in names}).reindex(calendar).ffill(limit=5)
    bench_close = data[bench]["Close"].reindex(calendar).ffill()
    start = calendar[-1] - pd.DateOffset(years=years)
    dates = _rebalance_dates(calendar, start, rebalance)
    if len(dates) < 3:
        raise ValueError("Not enough history for this period.")

    # Indicators for every ticker and date, computed once.
    series = {t: snapshot_series(data[t]).reindex(calendar) for t in names}

    equity_parts, periods, prev_hold = [], [], set()
    value = 1.0
    for t0, t1 in zip(dates[:-1], dates[1:]):
        scored = []
        for t in names:
            row = series[t].loc[t0]
            # Investable only if it has a price at t0 and t1 and enough history to score.
            if pd.isna(row["price"]) or pd.isna(closes.at[t1, t]) or pd.isna(row["sma50"]):
                continue
            ev = evaluate(strategy, row_to_snapshot(row))
            scored.append((ev["score"], t, ev["reasons"]))
        if not scored:
            continue
        scored.sort(key=lambda x: x[0], reverse=True)
        picks = scored[:top_n]
        hold = [t for _, t, _ in picks]

        turnover = 1.0 if not prev_hold else len(set(hold) - prev_hold) / len(hold)
        if prev_hold:  # sell the replaced names + buy the new ones (initial buy is free, like the benchmark)
            value *= 1 - cost * turnover * 2
        path = _basket_path(closes, hold, t0, t1) * value
        equity_parts.append(path if not equity_parts else path.iloc[1:])
        ret = path.iloc[-1] / value - 1
        b_ret = bench_close.at[t1] / bench_close.at[t0] - 1
        value = float(path.iloc[-1])
        prev_hold = set(hold)
        periods.append({
            "date": t0.strftime("%Y-%m-%d"), "end": t1.strftime("%Y-%m-%d"),
            "return": ret * 100, "benchmark": b_ret * 100, "excess": (ret - b_ret) * 100,
            "turnover": turnover * 100,
            "holdings": [{"symbol": t, "score": round(s, 1)} for s, t, _ in picks],
        })

    if not equity_parts:
        raise ValueError("No investable dates in this window.")
    equity = pd.concat(equity_parts)
    first = equity.index[0]
    bench_eq = bench_close.loc[first:] / bench_close.loc[first]
    # Equal-weight universe, rebalanced on the same dates (no strategy selection).
    uni_parts, uv = [], 1.0
    for t0, t1 in zip(dates[:-1], dates[1:]):
        avail = [t for t in names if not pd.isna(closes.at[t0, t]) and not pd.isna(closes.at[t1, t])]
        if t0 < first or not avail:
            continue
        p = _basket_path(closes, avail, t0, t1) * uv
        uni_parts.append(p if not uni_parts else p.iloc[1:])
        uv = float(p.iloc[-1])
    uni_eq = pd.concat(uni_parts)

    strat_rets = [p["return"] for p in periods]
    stats = {
        "strategy": _stats(equity, strat_rets),
        "benchmark": _stats(bench_eq, [p["benchmark"] for p in periods]),
        "universe": _stats(uni_eq),
    }
    stats["strategy"]["beat_benchmark"] = sum(p["excess"] > 0 for p in periods) / len(periods) * 100
    stats["strategy"]["avg_turnover"] = float(np.mean([p["turnover"] for p in periods[1:]] or [0]))

    def curve(s: pd.Series) -> dict:
        return {"dates": [d.strftime("%Y-%m-%d") for d in s.index], "values": [round(float(x), 5) for x in s]}

    strat_name = STRATEGIES[strategy].name
    return {
        "params": {"strategy": strategy, "strategy_name": strat_name,
                   "universe": UNIVERSES.get(universe, {}).get("name", universe),
                   "period": period, "rebalance": rebalance, "top_n": top_n, "cost_bps": cost_bps,
                   "benchmark": bench, "tickers_tested": len(names),
                   "start": first.strftime("%Y-%m-%d"), "end": equity.index[-1].strftime("%Y-%m-%d")},
        "stats": stats,
        "curves": {"strategy": curve(equity), "benchmark": curve(bench_eq), "universe": curve(uni_eq)},
        "periods": periods[::-1],  # newest first
        "notes": [
            "Universes are today's lists, so stocks that dropped out of an index in the past are "
            "missing (survivorship bias). Results are likely optimistic.",
            f"Equal-weight top {top_n}, bought at the close on each {rebalance[:-2]} rebalance; "
            f"{cost_bps:g} bps cost per trade. Past performance doesn't predict future results.",
        ],
        "as_of": datetime.now().isoformat(timespec="seconds"),
    }
