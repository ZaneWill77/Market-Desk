"""The market analysis bot: market overview, regime detection and strategy scans."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from statistics import mean
from zoneinfo import ZoneInfo

from . import market_data as md
from .indicators import pct_return, sma, snapshot
from .strategies import STRATEGIES, evaluate

UNIVERSES_FILE = Path(__file__).parent / "data" / "universes.json"


def load_universes() -> dict[str, dict]:
    """Stock lists for the scanner. Edit app/data/universes.json to add your own."""
    data = json.loads(UNIVERSES_FILE.read_text(encoding="utf-8"))
    data["custom"] = {"name": "Custom tickers…", "tickers": []}
    return data


UNIVERSES = load_universes()

INDICES = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "DIA": "Dow 30", "IWM": "Russell 2000", "^VIX": "VIX",
           "^TNX": "10Y Yield", "GLD": "Gold", "USO": "Oil", "BTC-USD": "Bitcoin"}
SECTORS = {"XLK": "Technology", "XLC": "Communication", "XLY": "Cons. Discretionary", "XLF": "Financials",
           "XLI": "Industrials", "XLV": "Health Care", "XLP": "Cons. Staples", "XLE": "Energy",
           "XLB": "Materials", "XLU": "Utilities", "XLRE": "Real Estate"}


def market_status() -> dict:
    now = datetime.now(ZoneInfo("America/New_York"))
    mins = now.hour * 60 + now.minute
    if now.weekday() >= 5:
        state = "closed (weekend)"
    elif 570 <= mins < 960:
        state = "open"
    elif 240 <= mins < 570:
        state = "pre-market"
    elif 960 <= mins < 1200:
        state = "after-hours"
    else:
        state = "closed"
    return {"state": state, "time_et": now.strftime("%a %b %d, %I:%M %p ET")}


def market_overview() -> dict:
    tickers = list(INDICES) + list(SECTORS)
    data = md.get_history(tickers, period="1y")

    indices = []
    for t, name in INDICES.items():
        df = data.get(md.normalize(t))
        if df is None:
            continue
        c = df["Close"]
        indices.append({
            "symbol": t, "name": name, "price": float(c.iloc[-1]),
            "change_pct": pct_return(c, 1), "ret_5d": pct_return(c, 5), "ret_1m": pct_return(c, 21),
            "spark": [round(float(x), 4) for x in c.tail(60)],
        })

    sectors = []
    for t, name in SECTORS.items():
        df = data.get(t)
        if df is None:
            continue
        c = df["Close"]
        ytd = c[c.index >= f"{c.index[-1].year}-01-01"]
        sectors.append({
            "symbol": t, "name": name,
            "1d": pct_return(c, 1), "1w": pct_return(c, 5), "1m": pct_return(c, 21), "3m": pct_return(c, 63),
            "ytd": (float(c.iloc[-1] / ytd.iloc[0] - 1) * 100) if len(ytd) > 1 else None,
            "above_50": bool(c.iloc[-1] > sma(c, 50).iloc[-1]),
        })

    return {"status": market_status(), "indices": indices, "sectors": sectors, "regime": _regime(data, sectors),
            "as_of": datetime.now().isoformat(timespec="seconds")}


def _regime(data: dict, sectors: list[dict]) -> dict:
    """Simple rules-based risk-on / risk-off read."""
    points, notes = 0, []
    spy = data.get("SPY")
    if spy is not None:
        s = snapshot(spy)
        if s["sma200"] and s["price"] > s["sma200"]:
            points += 2; notes.append("SPY above its 200-day SMA")
        else:
            points -= 2; notes.append("SPY below its 200-day SMA")
        if s["sma50"] and s["price"] > s["sma50"]:
            points += 1; notes.append("SPY above its 50-day SMA")
        else:
            points -= 1; notes.append("SPY below its 50-day SMA")
    vix = data.get("^VIX")
    if vix is not None:
        v = float(vix["Close"].iloc[-1])
        if v < 16:
            points += 1; notes.append(f"VIX calm at {v:.1f}")
        elif v > 25:
            points -= 2; notes.append(f"VIX elevated at {v:.1f}")
        else:
            notes.append(f"VIX moderate at {v:.1f}")
    if sectors:
        breadth = sum(s["above_50"] for s in sectors) / len(sectors) * 100
        points += 1 if breadth >= 60 else -1 if breadth <= 40 else 0
        notes.append(f"{breadth:.0f}% of sectors above their 50-day SMA")
        by = {s["symbol"]: s for s in sectors}
        if "XLY" in by and "XLP" in by and by["XLY"]["1m"] is not None and by["XLP"]["1m"] is not None:
            spread = by["XLY"]["1m"] - by["XLP"]["1m"]
            points += 1 if spread > 0 else -1
            notes.append(f"Discretionary vs Staples (1M): {spread:+.1f} pts")
    iwm, spyd = data.get("IWM"), data.get("SPY")
    if iwm is not None and spyd is not None:
        rel = pct_return(iwm["Close"], 21) - pct_return(spyd["Close"], 21)
        notes.append(f"Small caps vs S&P (1M): {rel:+.1f} pts")
        points += 1 if rel > 0 else 0

    label = "Risk-On" if points >= 3 else "Risk-Off" if points <= -2 else "Mixed / Neutral"
    return {"label": label, "score": points, "notes": notes}


def run_scan(strategy: str, universe: str, custom: list[str] | None = None, top_n: int = 15) -> dict:
    if strategy not in STRATEGIES:
        raise ValueError(f"Unknown strategy '{strategy}'. Options: {', '.join(STRATEGIES)}")
    tickers = custom if universe == "custom" else UNIVERSES.get(universe, {}).get("tickers")
    if not tickers:
        raise ValueError("No tickers to scan. Pick a universe or enter custom tickers.")

    data = md.get_history(tickers, period="2y")
    rows, snaps = [], {}
    for t, df in data.items():
        try:
            snap = snapshot(df)
        except Exception:
            continue
        snaps[t] = snap
        ev = evaluate(strategy, snap)
        rows.append({
            "symbol": t, **ev,
            "price": snap["price"], "change_pct": snap["change_pct"], "ret_1m": snap["ret_1m"],
            "ret_3m": snap["ret_3m"], "rsi14": snap["rsi14"], "vol_ratio": snap["vol_ratio"],
            "pct_from_high": snap["pct_from_high"],
        })
    rows.sort(key=lambda r: r["score"], reverse=True)
    missing = sorted({md.normalize(t) for t in tickers} - set(data))

    breadth = _breadth(snaps)
    strat = STRATEGIES[strategy]
    return {
        "strategy": {"key": strat.key, "name": strat.name, "description": strat.description},
        "universe": UNIVERSES.get(universe, {}).get("name", universe),
        "scanned": len(rows), "missing": missing, "breadth": breadth,
        "results": rows, "top": rows[:top_n], "bottom": rows[-5:][::-1] if len(rows) > top_n else [],
        "narrative": _narrative(strat.name, rows, breadth),
        "as_of": datetime.now().isoformat(timespec="seconds"),
    }


def _breadth(snaps: dict) -> dict:
    if not snaps:
        return {}
    vals = list(snaps.values())
    pct = lambda f: round(sum(1 for s in vals if f(s)) / len(vals) * 100, 1)  # noqa: E731
    rsis = [s["rsi14"] for s in vals if s["rsi14"] is not None]
    return {
        "above_sma50": pct(lambda s: s["sma50"] and s["price"] > s["sma50"]),
        "above_sma200": pct(lambda s: s["sma200"] and s["price"] > s["sma200"]),
        "advancers": pct(lambda s: s["change_pct"] > 0),
        "near_highs": pct(lambda s: s["pct_from_high"] > -5),
        "oversold": pct(lambda s: s["rsi14"] is not None and s["rsi14"] < 30),
        "overbought": pct(lambda s: s["rsi14"] is not None and s["rsi14"] > 70),
        "avg_rsi": round(mean(rsis), 1) if rsis else None,
        "avg_1m": round(mean(s["ret_1m"] for s in vals if s["ret_1m"] is not None), 2),
    }


def _narrative(strategy_name: str, rows: list[dict], b: dict) -> list[str]:
    if not rows:
        return ["No data returned for this universe."]
    out = []
    tone = "healthy" if b.get("above_sma200", 0) >= 60 else "weak" if b.get("above_sma200", 0) <= 40 else "mixed"
    out.append(f"Breadth is {tone}: {b['above_sma200']}% of names are above their 200-day SMA and "
               f"{b['above_sma50']}% above their 50-day. {b['advancers']}% are up today.")
    if b.get("avg_rsi") is not None:
        out.append(f"Average RSI is {b['avg_rsi']} with {b['overbought']}% overbought and {b['oversold']}% oversold.")
    strong = [r for r in rows if r["score"] >= 75]
    leaders = ", ".join(f"{r['symbol']} ({r['score']:.0f})" for r in rows[:5])
    out.append(f"{strategy_name}: {len(strong)} of {len(rows)} names rate Strong. Top setups: {leaders}.")
    if rows[0]["reasons"]:
        out.append(f"{rows[0]['symbol']} leads because: " + "; ".join(rows[0]["reasons"][:4]) + ".")
    return out


def analyze_ticker(symbol: str) -> dict:
    """Everything about a single ticker: indicators + every strategy's verdict."""
    df = md.get_one(symbol, "2y")
    if df is None:
        raise ValueError(f"No data for '{symbol}'")
    snap = snapshot(df)
    return {
        "symbol": md.normalize(symbol),
        "snapshot": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in snap.items()},
        "strategies": {k: {"name": s.name, **evaluate(k, snap)} for k, s in STRATEGIES.items()},
    }
