"""Portfolio analysis.

Holdings come from the user's browser on each request and are never stored on the server.

Returns positions (value, weight, P&L, sector, rating, next earnings), allocation and
concentration, risk (beta, volatility, 1-day VaR, drawdown, correlations), a hypothetical
"today's weights held over the period" performance curve vs a benchmark, and rule-based
observations. To add an observation, extend _observations().
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import numpy as np
import pandas as pd

from . import calendar_data as cal
from . import market_data as md
from .indicators import snapshot
from .strategies import evaluate, rating

MAX_POSITIONS = 100
PERIODS = {"6mo": 0.5, "1y": 1, "2y": 2, "3y": 3}


def parse_holdings(items: list[dict]) -> list[dict]:
    """Validate and merge duplicate tickers (weighted-average cost)."""
    merged: dict[str, dict] = {}
    for it in items:
        sym = md.normalize(str(it.get("symbol", "")))
        try:
            shares = float(it.get("shares"))
        except (TypeError, ValueError):
            continue
        if not sym or not np.isfinite(shares) or shares <= 0:
            continue
        try:
            cost = float(it.get("cost"))
            cost = cost if np.isfinite(cost) and cost >= 0 else None
        except (TypeError, ValueError):
            cost = None
        if sym in merged:
            m = merged[sym]
            if m["cost"] is not None and cost is not None:
                m["cost"] = (m["cost"] * m["shares"] + cost * shares) / (m["shares"] + shares)
            else:
                m["cost"] = None
            m["shares"] += shares
        else:
            merged[sym] = {"symbol": sym, "shares": shares, "cost": cost}
    if len(merged) > MAX_POSITIONS:
        raise ValueError(f"Up to {MAX_POSITIONS} positions are supported.")
    return list(merged.values())


def _classify(sym: str, info: dict) -> tuple[str, str]:
    """(asset type, sector bucket)"""
    qt = (info.get("quoteType") or "").upper()
    if sym.endswith("-USD") or qt == "CRYPTOCURRENCY":
        return "Crypto", "Crypto"
    if qt in ("ETF", "MUTUALFUND"):
        return ("ETF" if qt == "ETF" else "Fund"), f"Fund: {info.get('category') or 'Other'}"
    if info.get("sector"):
        return "Stock", info["sector"]
    return ("Stock" if qt == "EQUITY" else "Other"), "Unknown"


def analyze(items: list[dict], cash: float = 0.0, period: str = "1y", benchmark: str = "SPY") -> dict:
    holdings = parse_holdings(items)
    if not holdings:
        raise ValueError("Add at least one position (ticker and number of shares).")
    if period not in PERIODS:
        raise ValueError(f"period must be one of {', '.join(PERIODS)}")
    cash = max(0.0, float(cash or 0))
    bench = md.normalize(benchmark)
    syms = [h["symbol"] for h in holdings]

    fetch = {"6mo": "2y", "1y": "2y", "2y": "5y", "3y": "5y"}[period]
    data = md.get_history(syms + [bench], period=fetch)
    if bench not in data:
        raise ValueError(f"No data for benchmark {bench}")
    missing = [s for s in syms if s not in data]
    held = [h for h in holdings if h["symbol"] in data]
    if not held:
        raise ValueError("No price data for any of these tickers.")

    with ThreadPoolExecutor(max_workers=8) as pool:
        infos = dict(zip([h["symbol"] for h in held], pool.map(md.get_info, [h["symbol"] for h in held])))
    try:
        earnings = {e["symbol"]: e for e in cal.upcoming_for([h["symbol"] for h in held], within_days=45)}
    except Exception:
        earnings = {}

    # ---------------- positions
    positions = []
    for h in held:
        s = h["symbol"]
        df = data[s]
        snap = snapshot(df)
        price = snap["price"]
        value = price * h["shares"]
        prev = price / (1 + snap["change_pct"] / 100) if snap.get("change_pct") is not None else price
        c = df["Close"]
        ytd = c[c.index >= f"{c.index[-1].year}-01-01"]
        asset_type, sector = _classify(s, infos.get(s) or {})
        ev = evaluate("composite", snap)
        cost_value = h["cost"] * h["shares"] if h["cost"] is not None else None
        positions.append({
            "symbol": s, "name": (infos.get(s) or {}).get("shortName"), "shares": h["shares"], "cost": h["cost"],
            "price": price, "value": value, "day_change": (price - prev) * h["shares"], "day_pct": snap.get("change_pct"),
            "cost_value": cost_value,
            "pnl": value - cost_value if cost_value is not None else None,
            "pnl_pct": (value / cost_value - 1) * 100 if cost_value else None,
            "ret_1m": snap.get("ret_1m"), "ret_3m": snap.get("ret_3m"),
            "ret_ytd": float((ytd.iloc[-1] / ytd.iloc[0] - 1) * 100) if len(ytd) > 1 else None,
            "rsi14": snap.get("rsi14"), "pct_from_high": snap.get("pct_from_high"),
            "asset_type": asset_type, "sector": sector,
            "score": ev["score"], "rating": ev["rating"],
            "next_earnings": earnings.get(s),
        })

    invested = sum(p["value"] for p in positions)
    total = invested + cash
    for p in positions:
        p["weight"] = p["value"] / total * 100
    positions.sort(key=lambda p: p["value"], reverse=True)

    # ---------------- allocation & concentration
    def bucket(key):
        out: dict[str, float] = {}
        for p in positions:
            out[p[key]] = out.get(p[key], 0) + p["weight"]
        if cash and key == "asset_type":
            out["Cash"] = cash / total * 100
        return sorted(({"name": k, "weight": v} for k, v in out.items()), key=lambda x: -x["weight"])

    inv_w = np.array([p["value"] / invested for p in positions]) if invested else np.array([])
    hhi = float((inv_w ** 2).sum()) if len(inv_w) else 0
    concentration = {
        "largest": positions[0]["weight"], "largest_symbol": positions[0]["symbol"],
        "top5": sum(p["weight"] for p in positions[:5]),
        "hhi": hhi, "effective_positions": (1 / hhi) if hhi else 0,
    }

    # ---------------- risk & hypothetical performance (today's weights, rebalanced daily)
    calendar = data[bench].index
    closes = pd.DataFrame({p["symbol"]: data[p["symbol"]]["Close"] for p in positions}).reindex(calendar).ffill(limit=5)
    bench_close = data[bench]["Close"].reindex(calendar).ffill()
    start = calendar[-1] - pd.DateOffset(months=int(PERIODS[period] * 12))
    window = closes.loc[closes.index >= start]
    rets = window.pct_change().iloc[1:]
    short_history = [s for s in rets.columns if rets[s].isna().mean() > 0.05]
    rets = rets.fillna(0.0)
    w = pd.Series({p["symbol"]: p["value"] / total for p in positions})  # cash weight earns 0
    port = (rets * w).sum(axis=1)
    b_ret = bench_close.loc[window.index].pct_change().iloc[1:]
    j = pd.concat([port, b_ret], axis=1).dropna()
    beta = float(j.iloc[:, 0].cov(j.iloc[:, 1]) / j.iloc[:, 1].var()) if len(j) > 20 else None
    vol = float(port.std() * np.sqrt(252) * 100) if len(port) > 20 else None
    var95 = float(-np.percentile(port, 5) * total) if len(port) > 20 else None
    equity = (1 + port).cumprod()
    bench_eq = (1 + b_ret.fillna(0)).cumprod()
    dd = float((equity / equity.cummax() - 1).min() * 100)
    years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1e-9)
    total_ret = float((equity.iloc[-1] - 1) * 100)
    b_total = float((bench_eq.iloc[-1] - 1) * 100)
    sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
    pos_vols = rets.std() * np.sqrt(252)
    weighted_vol = float((w * pos_vols).sum() * 100)
    for p in positions:
        r = rets[p["symbol"]]
        jj = pd.concat([r, b_ret], axis=1).dropna()
        p["beta"] = float(jj.iloc[:, 0].cov(jj.iloc[:, 1]) / jj.iloc[:, 1].var()) if len(jj) > 20 else None
        p["volatility"] = float(pos_vols[p["symbol"]] * 100)
    # Risk contribution: each position's share of total portfolio variance.
    cov = rets.cov() * 252
    port_var = float(w @ cov @ w)
    if port_var > 0:
        contrib = (w * (cov @ w)) / port_var * 100
        for p in positions:
            p["risk_contribution"] = float(contrib[p["symbol"]])

    top = [p["symbol"] for p in positions[:10]]
    corr = rets[top].corr().round(3) if len(top) > 1 else None

    risk = {
        "beta": beta, "volatility": vol, "var95_1d": var95, "var95_1d_pct": var95 / total * 100 if var95 else None,
        "max_drawdown": dd, "sharpe": sharpe,
        "diversification_ratio": (weighted_vol / vol) if vol else None,
    }
    perf = {
        "period": period, "total_return": total_ret, "cagr": ((1 + total_ret / 100) ** (1 / years) - 1) * 100,
        "benchmark": bench, "benchmark_return": b_total,
        "dates": [d.strftime("%Y-%m-%d") for d in equity.index],
        "portfolio": [round(float((v - 1) * 100), 3) for v in equity],
        "benchmark_curve": [round(float((v - 1) * 100), 3) for v in bench_eq],
    }

    cost_known = [p for p in positions if p["cost_value"] is not None]
    totals = {
        "value": total, "invested": invested, "cash": cash, "cash_pct": cash / total * 100,
        "day_change": sum(p["day_change"] for p in positions),
        "day_pct": sum(p["day_change"] for p in positions) / (total - sum(p["day_change"] for p in positions)) * 100,
        "cost": sum(p["cost_value"] for p in cost_known) if cost_known else None,
        "pnl": sum(p["pnl"] for p in cost_known) if cost_known else None,
        "pnl_positions": len(cost_known),
    }
    if totals["cost"]:
        totals["pnl_pct"] = totals["pnl"] / totals["cost"] * 100

    sectors = bucket("sector")
    result = {
        "positions": positions, "missing": missing, "totals": totals,
        "allocation": {"sector": sectors, "asset_type": bucket("asset_type")},
        "concentration": concentration, "risk": risk, "performance": perf,
        "correlation": None if corr is None else {"symbols": top, "matrix": corr.values.tolist()},
        "notes": ([f"Shorter price history for {', '.join(short_history)}: missing days treated as flat."] if short_history else []) +
                 ["Performance is hypothetical: today's positions and weights held over the whole period (no trade history)."],
        "as_of": datetime.now().isoformat(timespec="seconds"),
    }
    result["observations"] = _observations(result)
    return result


def _observations(r: dict) -> list[dict]:
    """Plain-language flags. level: 'warn' (worth a look) or 'info'."""
    out = []
    pos, conc, risk = r["positions"], r["concentration"], r["risk"]
    big = [p for p in pos if p["weight"] >= 20 and p["asset_type"] not in ("ETF", "Fund")]  # index funds are diversified
    if big:
        parts = ", ".join("{} is {:.0f}%".format(p["symbol"], p["weight"]) for p in big)
        out.append({"level": "warn", "text": f"Concentration: {parts} of the portfolio."})
    if conc["top5"] >= 70 and len(pos) > 5:
        out.append({"level": "info", "text": f"Top 5 positions are {conc['top5']:.0f}% of the portfolio."})
    if len(pos) >= 3 and conc["effective_positions"] < 5:
        out.append({"level": "info", "text": f"Effectively {conc['effective_positions']:.1f} equal-sized positions: diversification is limited."})
    for s in r["allocation"]["sector"]:
        if s["weight"] >= 40 and not s["name"].startswith("Fund"):
            out.append({"level": "warn", "text": f"Sector tilt: {s['name']} is {s['weight']:.0f}% of the portfolio."})
    if risk["beta"] is not None and risk["beta"] >= 1.3:
        out.append({"level": "warn", "text": f"High market sensitivity: beta {risk['beta']:.2f} vs {r['performance']['benchmark']} (a 10% market drop has historically meant ~{risk['beta'] * 10:.0f}% for this mix)."})
    elif risk["beta"] is not None and risk["beta"] <= 0.7:
        out.append({"level": "info", "text": f"Defensive mix: beta {risk['beta']:.2f} vs {r['performance']['benchmark']}."})
    weak = [p["symbol"] for p in pos if p["rating"] in ("Weak", "Avoid")]
    if weak:
        out.append({"level": "info", "text": f"Weak technical setups (composite score): {', '.join(weak)}."})
    soon = ["{} ({}d)".format(p["symbol"], p["next_earnings"]["days_until"])
            for p in pos if p.get("next_earnings") and p["next_earnings"]["days_until"] <= 7]
    if soon:
        out.append({"level": "warn", "text": f"Earnings this week: {', '.join(soon)}."})
    if r["correlation"]:
        c, syms = r["correlation"]["matrix"], r["correlation"]["symbols"]
        pairs = [(syms[i], syms[j], c[i][j]) for i in range(len(syms)) for j in range(i + 1, len(syms)) if c[i][j] >= 0.85]
        if pairs:
            out.append({"level": "info", "text": "Highly correlated pairs (move almost together): " +
                        ", ".join(f"{a}/{b} {v:.2f}" for a, b, v in pairs[:5]) + "."})
    losers = [p for p in pos if p["pnl_pct"] is not None and p["pnl_pct"] <= -20]
    if losers:
        out.append({"level": "info", "text": "Down 20%+ from cost: " + ", ".join(f"{p['symbol']} ({p['pnl_pct']:.0f}%)" for p in losers) + "."})
    if r["totals"]["cash_pct"] >= 20:
        out.append({"level": "info", "text": f"Cash is {r['totals']['cash_pct']:.0f}% of the portfolio."})
    return out
