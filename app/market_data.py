"""Market data access via yfinance, with a small in-memory TTL cache."""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any

import logging

import pandas as pd
import yfinance as yf

# yfinance logs every missing ticker / ETF-without-fundamentals as an error; we handle those ourselves.
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

_cache: dict[Any, tuple[float, Any]] = {}
_lock = threading.Lock()

HISTORY_TTL = 300  # seconds
INFO_TTL = 3600


def _cached(key, ttl, fn):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (now, val)
    return val


def clear_cache():
    with _lock:
        _cache.clear()


def normalize(symbol: str) -> str:
    return symbol.strip().upper().replace(".", "-") if not symbol.strip().startswith("^") else symbol.strip().upper()


def get_history(tickers: list[str], period: str = "2y", interval: str = "1d",
                ttl: int = HISTORY_TTL) -> dict[str, pd.DataFrame]:
    """Return {ticker: OHLCV DataFrame}. Tickers that fail are omitted.
    `ttl` is how many seconds a cached download stays fresh (watchlists use a shorter one)."""
    tickers = sorted({normalize(t) for t in tickers if t.strip()})
    if not tickers:
        return {}

    def fetch(batch: list[str], out: dict):
        raw = yf.download(
            batch,
            period=period,
            interval=interval,
            group_by="ticker",
            auto_adjust=True,
            threads=True,
            progress=False,
        )
        if raw is None or raw.empty:
            return
        for t in batch:
            try:
                df = raw[t] if isinstance(raw.columns, pd.MultiIndex) else raw
                df = df[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
                if len(df) >= (30 if interval in ("1d", "1wk") else 5):
                    out[t] = df
            except KeyError:
                continue

    def load():
        out: dict[str, pd.DataFrame] = {}
        fetch(tickers, out)
        missing = [t for t in tickers if t not in out]
        if missing:  # yfinance occasionally drops tickers on transient errors; retry once
            time.sleep(0.5)
            fetch(missing, out)
        return out

    return _cached(("hist", tuple(tickers), period, interval), ttl, load)


def get_one(symbol: str, period: str = "2y", interval: str = "1d") -> pd.DataFrame | None:
    sym = normalize(symbol)
    return get_history([sym], period, interval).get(sym)


def get_info(symbol: str) -> dict:
    """Fundamental snapshot. yfinance's .info can be slow or rate-limited, so failures return {}."""
    sym = normalize(symbol)

    def load():
        try:
            info = yf.Ticker(sym).info or {}
        except Exception:
            return {}
        keys = [
            "shortName", "longName", "quoteType", "category", "sector", "industry", "marketCap", "trailingPE", "forwardPE",
            "pegRatio", "priceToBook", "priceToSalesTrailing12Months", "profitMargins", "operatingMargins",
            "returnOnEquity", "revenueGrowth", "earningsGrowth", "debtToEquity", "dividendYield",
            "beta", "targetMeanPrice", "recommendationKey", "numberOfAnalystOpinions",
            "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "averageVolume", "shortPercentOfFloat",
            "longBusinessSummary",
        ]
        out = {k: info.get(k) for k in keys if info.get(k) is not None}
        if "longBusinessSummary" in out:
            out["longBusinessSummary"] = out["longBusinessSummary"][:600]
        return out

    return _cached(("info", sym), INFO_TTL, load)


def get_news(symbol: str, limit: int = 8) -> list[dict]:
    sym = normalize(symbol)

    def load():
        try:
            items = yf.Ticker(sym).news or []
        except Exception:
            return []
        out = []
        for it in items[:limit]:
            c = it.get("content", it)  # newer yfinance nests under "content"
            url = (c.get("canonicalUrl") or {}).get("url") if isinstance(c.get("canonicalUrl"), dict) else c.get("link")
            pub = c.get("pubDate") or c.get("providerPublishTime")
            if isinstance(pub, (int, float)):
                pub = datetime.fromtimestamp(pub, tz=timezone.utc).isoformat()
            provider = c.get("provider", {}).get("displayName") if isinstance(c.get("provider"), dict) else c.get("publisher")
            if c.get("title"):
                out.append({"title": c.get("title"), "url": url, "published": pub, "source": provider,
                            "summary": (c.get("summary") or "")[:300]})
        return out

    return _cached(("news", sym), 900, load)


def to_records(df: pd.DataFrame) -> dict:
    """Serialize OHLCV for charting."""
    return {
        "dates": [d.strftime("%Y-%m-%d %H:%M") if d.hour or d.minute else d.strftime("%Y-%m-%d") for d in df.index],
        "open": df["Open"].round(4).tolist(),
        "high": df["High"].round(4).tolist(),
        "low": df["Low"].round(4).tolist(),
        "close": df["Close"].round(4).tolist(),
        "volume": df["Volume"].fillna(0).astype("int64").tolist(),
    }
