"""Compare tickers: indexed performance, relative strength vs a benchmark, risk stats, correlations.

Benchmark options:
  "SPY", "QQQ", any ticker   - every symbol is measured against that one benchmark
  "sector"                   - each stock against its own SPDR sector ETF (from Yahoo's sector
                               field); ETFs, indices and unknown sectors fall back to SPY
"""
from __future__ import annotations

from datetime import datetime

import numpy as np
import pandas as pd

from . import market_data as md
from .indicators import rsi

MAX_SYMBOLS = 8
PERIODS = {"1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y"}

SECTOR_ETFS = {
    "Technology": "XLK", "Communication Services": "XLC", "Consumer Cyclical": "XLY",
    "Financial Services": "XLF", "Industrials": "XLI", "Healthcare": "XLV",
    "Consumer Defensive": "XLP", "Energy": "XLE", "Basic Materials": "XLB",
    "Utilities": "XLU", "Real Estate": "XLRE",
}


def _bench_for(symbols: list[str], benchmark: str) -> dict[str, dict]:
    """{symbol: {"symbol": benchmark ticker, "label": why}}"""
    if benchmark.lower() != "sector":
        b = md.normalize(benchmark)
        return {s: {"symbol": b, "label": b} for s in symbols}
    out = {}
    for s in symbols:
        info = md.get_info(s) if not s.startswith("^") and "-USD" not in s else {}
        sector = info.get("sector")
        etf = SECTOR_ETFS.get(sector)
        out[s] = ({"symbol": etf, "label": f"{etf} ({sector})"} if etf and etf != s
                  else {"symbol": "SPY", "label": "SPY (no sector)"})
    return out


def _stats(px: pd.Series, bench: pd.Series) -> dict:
    r, br = px.pct_change().dropna(), bench.pct_change().dropna()
    j = pd.concat([r, br], axis=1, join="inner").dropna()
    total = (px.iloc[-1] / px.iloc[0] - 1) * 100
    b_total = (bench.iloc[-1] / bench.iloc[0] - 1) * 100
    var_b = j.iloc[:, 1].var()
    return {
        "total_return": total,
        "benchmark_return": b_total,
        "excess": total - b_total,
        "volatility": r.std() * np.sqrt(252) * 100 if len(r) > 2 else None,
        "max_drawdown": float((px / px.cummax() - 1).min() * 100),
        "beta": float(j.iloc[:, 0].cov(j.iloc[:, 1]) / var_b) if len(j) > 10 and var_b > 0 else None,
        "correlation": float(j.iloc[:, 0].corr(j.iloc[:, 1])) if len(j) > 10 else None,
        "best_day": float(r.max() * 100) if len(r) else None,
        "worst_day": float(r.min() * 100) if len(r) else None,
    }


def compare(symbols: list[str], period: str = "1y", benchmark: str = "SPY") -> dict:
    syms = list(dict.fromkeys(md.normalize(s) for s in symbols if s.strip()))
    if not syms:
        raise ValueError("Add at least one ticker to compare.")
    if len(syms) > MAX_SYMBOLS:
        raise ValueError(f"Compare up to {MAX_SYMBOLS} tickers at a time.")
    if period not in PERIODS:
        raise ValueError(f"period must be one of {', '.join(sorted(PERIODS))}")

    benches = _bench_for(syms, benchmark)
    bench_syms = sorted({b["symbol"] for b in benches.values()})
    # Fetch an extra year so RSI etc. are warm, then trim to the window.
    fetch = {"1mo": "1y", "3mo": "1y", "6mo": "2y", "ytd": "2y", "1y": "2y", "2y": "5y", "5y": "10y"}[period]
    data = md.get_history(syms + bench_syms, period=fetch)
    missing = [s for s in syms if s not in data]
    syms = [s for s in syms if s in data]
    if not syms:
        raise ValueError("No price data for those tickers.")
    if any(benches[s]["symbol"] not in data for s in syms):
        raise ValueError("Couldn't load benchmark prices.")

    raw = pd.DataFrame({s: data[s]["Close"] for s in set(syms) | set(bench_syms) if s in data}).sort_index()
    # Use the benchmarks' real trading days as the calendar. Otherwise crypto (which trades on
    # weekends) would add rows where stocks show fake 0% days, understating their volatility.
    calendar = raw[bench_syms].dropna().index
    closes = raw.ffill(limit=5).loc[calendar]
    end = closes.index[-1]
    start = {"1mo": end - pd.DateOffset(months=1), "3mo": end - pd.DateOffset(months=3),
             "6mo": end - pd.DateOffset(months=6), "ytd": pd.Timestamp(year=end.year, month=1, day=1, tz=end.tz),
             "1y": end - pd.DateOffset(years=1), "2y": end - pd.DateOffset(years=2),
             "5y": end - pd.DateOffset(years=5)}[period]
    window = closes.loc[closes.index >= start]
    # Common start: the first date where every compared symbol and its benchmark has a price.
    needed = list(set(syms) | {benches[s]["symbol"] for s in syms})
    valid = window[needed].dropna()
    if len(valid) < 5:
        raise ValueError("Not enough overlapping history for this period.")
    window = window.loc[valid.index[0]:, :].ffill()
    notes = []
    if valid.index[0] > window.index[0] + pd.Timedelta(days=7):
        notes.append(f"Some tickers have shorter history; comparison starts {valid.index[0]:%Y-%m-%d}.")

    dates = [d.strftime("%Y-%m-%d") for d in window.index]
    perf, rel, stats = {}, {}, {}
    for s in syms:
        px, b = window[s], window[benches[s]["symbol"]]
        perf[s] = ((px / px.iloc[0] - 1) * 100).round(3).tolist()
        ratio = (px / px.iloc[0]) / (b / b.iloc[0])
        rel[s] = ((ratio - 1) * 100).round(3).tolist()
        st = _stats(px, b)
        r14 = rsi(closes[s].dropna())
        st.update(price=float(px.iloc[-1]), rsi14=float(r14.iloc[-1]) if r14.notna().any() else None,
                  benchmark=benches[s]["label"], benchmark_symbol=benches[s]["symbol"])
        stats[s] = st

    bench_perf = {}
    for b in sorted({benches[s]["symbol"] for s in syms}):
        bench_perf[b] = ((window[b] / window[b].iloc[0] - 1) * 100).round(3).tolist()

    rets = window[syms].pct_change().dropna()
    corr = rets.corr().round(3) if len(syms) > 1 and len(rets) > 10 else None

    return {
        "symbols": syms, "missing": missing, "period": period, "benchmark": benchmark,
        "dates": dates, "performance": perf, "relative": rel, "benchmark_performance": bench_perf,
        "stats": stats,
        "correlation": None if corr is None else {"symbols": syms, "matrix": corr.values.tolist()},
        "notes": notes, "as_of": datetime.now().isoformat(timespec="seconds"),
    }
