"""Earnings and economic calendars (Yahoo Finance via yfinance), plus per-ticker earnings history.

- market_earnings():   companies reporting in a date range, filtered by market cap
- economic_events():   US economic releases in a date range, tagged High / Medium / Low impact
- upcoming_for():      next earnings date for a list of tickers (e.g. a watchlist)
- ticker_earnings():   next report + estimates + recent quarters with EPS surprise and the
                       stock's price reaction the session after each report

To change which economic releases count as high or medium impact, edit IMPACT_RULES.
"""
from __future__ import annotations

import logging
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

from . import market_data as md

log = logging.getLogger("market_desk.calendar")
ET = ZoneInfo("America/New_York")
CAL_TTL = 1800       # market-wide calendars: 30 min
TICKER_TTL = 6 * 3600

# First matching rule wins. Patterns are case-insensitive regexes on the event name.
IMPACT_RULES: list[tuple[str, str]] = [
    (r"cpi index|cleveland fed", "low"),  # index levels / nowcasts: the MM and YY prints matter
    (r"\bcpi\b|consumer price", "high"),
    (r"\bppi\b|producer price", "high"),
    (r"non-?farm payrolls|unemployment rate", "high"),
    (r"fomc|fed funds|interest rate decision|rate decision", "high"),
    (r"\bgdp\b", "high"),
    (r"\bpce\b|personal consumption|core pce", "high"),
    (r"retail sales", "high"),
    (r"\bism\b", "high"),
    (r"jobless cl|initial claims", "medium"),
    (r"average earnings|private payrolls|\badp\b|jolts|job openings", "medium"),
    (r"u mich|consumer confidence|consumer sentiment|conf\. board", "medium"),
    (r"durable goods|factory orders|industrial production", "medium"),
    (r"housing starts|building permits|new home sales|existing home sales|pending home", "medium"),
    (r"trade balance|import prices|export prices|productivity|unit labor", "medium"),
    (r"fed .*speak|powell|beige book|minutes", "medium"),
]


def impact_of(name: str) -> str:
    for pattern, level in IMPACT_RULES:
        if re.search(pattern, name, re.I):
            return level
    return "low"


def _f(v):
    try:
        v = float(v)
        return None if math.isnan(v) else v
    except (TypeError, ValueError):
        return None


def _s(v):
    return v if isinstance(v, str) and v.strip() else None


def _session(ts: pd.Timestamp, code: str | None = None) -> str:
    """'before_open' | 'after_close' | 'during' | 'unknown' from Yahoo's code or the time."""
    code = (code or "").upper()
    if code == "BMO":
        return "before_open"
    if code == "AMC":
        return "after_close"
    if code == "TNS" or ts is None or pd.isna(ts):
        return "unknown"
    t = ts.tz_convert(ET) if ts.tzinfo else ts
    mins = t.hour * 60 + t.minute
    if mins == 0:
        return "unknown"
    return "before_open" if mins < 570 else "after_close" if mins >= 960 else "during"


def _fetch_page(fetch, offset: int, attempts: int = 3) -> pd.DataFrame:
    """Yahoo's calendar endpoint is unofficial and occasionally flaky: retry with a short backoff."""
    for attempt in range(attempts):
        try:
            return fetch(offset=offset)
        except Exception as e:
            log.warning("Calendar page offset=%s failed (attempt %s/%s): %s", offset, attempt + 1, attempts, e)
            if attempt == attempts - 1:
                raise
            time.sleep(0.6 * (attempt + 1))


def _pages(fetch, max_pages: int = 30) -> pd.DataFrame:
    """Fetch 100-row pages until a short page. Any page that still fails after retries raises,
    so a partial or empty calendar is never cached; the next request simply tries again."""
    frames = []
    for i in range(max_pages):
        f = _fetch_page(fetch, i * 100)
        if f is None or f.empty:
            break
        frames.append(f)
        if len(f) < 100:
            break
    return pd.concat(frames) if frames else pd.DataFrame()


def _range(days: int) -> tuple[date, date]:
    start = datetime.now(ET).date()
    return start, start + timedelta(days=max(1, min(int(days), 45)))


def market_earnings(days: int = 7, min_cap: float = 10e9) -> list[dict]:
    start, end = _range(days)

    def load():
        cal = yf.Calendars()
        df = _pages(lambda offset: cal.get_earnings_calendar(
            market_cap=min_cap, filter_most_active=False, start=start, end=end, limit=100, offset=offset, force=True))
        out = []
        for sym, r in df.iterrows():
            ts = r.get("Event Start Date")
            cap = _f(r.get("Marketcap"))
            if cap is not None and cap < min_cap:
                continue
            et = ts.tz_convert(ET) if ts is not None and not pd.isna(ts) else None
            out.append({
                "symbol": md.normalize(str(sym)), "company": _s(r.get("Company")), "market_cap": cap,
                "date": et.strftime("%Y-%m-%d") if et is not None else None,
                "session": _session(ts, r.get("Timing")), "event": _s(r.get("Event Name")),
                "eps_estimate": _f(r.get("EPS Estimate")), "eps_reported": _f(r.get("Reported EPS")),
                "surprise_pct": _f(r.get("Surprise(%)")),
            })
        out = [e for e in out if e["date"]]
        order = {"before_open": 0, "during": 1, "after_close": 2, "unknown": 3}
        out.sort(key=lambda e: (e["date"], order[e["session"]], -(e["market_cap"] or 0)))
        return out

    return md._cached(("earn_cal", start, end, min_cap), CAL_TTL, load)


def economic_events(days: int = 7, region: str = "US") -> list[dict]:
    start, end = _range(days)

    def load():
        cal = yf.Calendars()
        df = _pages(lambda offset: cal.get_economic_events_calendar(
            start=start, end=end, limit=100, offset=offset, force=True))
        if df.empty:
            return []
        df = df[df["Region"] == region]
        out = []
        for name, r in df.iterrows():
            ts = r.get("Event Time")
            et = ts.tz_convert(ET) if ts is not None and not pd.isna(ts) else None
            clean = re.sub(r"\s*\*\s*$", "", str(name)).strip()
            out.append({
                "event": clean, "impact": impact_of(clean),
                "date": et.strftime("%Y-%m-%d") if et is not None else None,
                "time_et": et.strftime("%I:%M %p").lstrip("0") if et is not None and (et.hour or et.minute) else None,
                "ts": et.isoformat() if et is not None else None,
                "period": _s(r.get("For")),
                "actual": _f(r.get("Actual")), "expected": _f(r.get("Expected")),
                "previous": _f(r.get("Last")), "revised": _f(r.get("Revised")),
            })
        out = [e for e in out if e["date"]]
        out.sort(key=lambda e: e["ts"])
        return out

    return md._cached(("econ_cal", start, end, region), CAL_TTL, load)


def _next_earnings(symbol: str) -> dict | None:
    sym = md.normalize(symbol)
    if sym.startswith("^") or sym.endswith("-USD"):
        return None

    def load():
        try:
            cal = yf.Ticker(sym).calendar or {}
        except Exception:
            return None
        dates = [d for d in (cal.get("Earnings Date") or []) if d]
        today = datetime.now(ET).date()
        upcoming = sorted(d for d in dates if d >= today)
        if not upcoming:
            return None
        return {"symbol": sym, "date": upcoming[0].isoformat(),
                "eps_estimate": _f(cal.get("Earnings Average")), "revenue_estimate": _f(cal.get("Revenue Average"))}

    return md._cached(("next_earn", sym), TICKER_TTL, load)


def upcoming_for(symbols: list[str], within_days: int = 90) -> list[dict]:
    syms = list(dict.fromkeys(md.normalize(s) for s in symbols if s.strip()))[:150]
    with ThreadPoolExecutor(max_workers=8) as pool:
        found = [r for r in pool.map(_next_earnings, syms) if r]
    today = datetime.now(ET).date()
    found = [dict(r) for r in found]  # don't mutate cached objects
    for r in found:
        r["days_until"] = (date.fromisoformat(r["date"]) - today).days
    return sorted((r for r in found if r["days_until"] <= within_days), key=lambda r: r["days_until"])


def ticker_earnings(symbol: str, quarters: int = 8) -> dict:
    sym = md.normalize(symbol)

    def load():
        t = yf.Ticker(sym)
        try:
            hist = t.get_earnings_dates(limit=quarters + 6)
        except Exception:
            hist = None
        nxt = _next_earnings(sym)
        if nxt:
            nxt = {**nxt, "days_until": (date.fromisoformat(nxt["date"]) - datetime.now(ET).date()).days}
        past = []
        if hist is not None and not hist.empty:
            px = md.get_one(sym, "5y")
            for ts, r in hist.sort_index(ascending=False).iterrows():
                reported = _f(r.get("Reported EPS"))
                if reported is None:
                    continue
                past.append({"date": ts.tz_convert(ET).strftime("%Y-%m-%d") if ts.tzinfo else ts.strftime("%Y-%m-%d"),
                             "session": _session(ts), "eps_estimate": _f(r.get("EPS Estimate")),
                             "eps_reported": reported, "surprise_pct": _f(r.get("Surprise(%)")),
                             "reaction_pct": _reaction(px, ts) if px is not None else None})
                if len(past) >= quarters:
                    break
        surprises = [p["surprise_pct"] for p in past if p["surprise_pct"] is not None]
        reactions = [p["reaction_pct"] for p in past if p["reaction_pct"] is not None]
        return {
            "symbol": sym, "next": nxt, "history": past,
            "beat_rate": (sum(s > 0 for s in surprises) / len(surprises) * 100) if surprises else None,
            "avg_surprise": (sum(surprises) / len(surprises)) if surprises else None,
            "avg_abs_move": (sum(abs(x) for x in reactions) / len(reactions)) if reactions else None,
        }

    return md._cached(("tick_earn", sym, quarters), TICKER_TTL, load)


def _reaction(px: pd.DataFrame, ts: pd.Timestamp) -> float | None:
    """% move of the first full session that could react to the report."""
    c = px["Close"]
    idx = c.index
    day = (ts.tz_convert(ET) if ts.tzinfo else ts).date()
    days = pd.Index([d.date() for d in idx])
    if _session(ts) == "before_open" or _session(ts) == "during":
        pos = days.searchsorted(day)           # report day reacts vs prior close
    else:
        pos = days.searchsorted(day, side="right")  # next session reacts vs report-day close
    if pos <= 0 or pos >= len(c):
        return None
    return float((c.iloc[pos] / c.iloc[pos - 1] - 1) * 100)
