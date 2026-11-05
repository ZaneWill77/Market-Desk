"""Technical indicators computed with pandas (no extra TA library needed)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(100.0).where(loss.notna())


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    line = ema(close, fast) - ema(close, slow)
    sig = line.ewm(span=signal, adjust=False).mean()
    return line, sig, line - sig


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0):
    mid = sma(close, n)
    sd = close.rolling(n, min_periods=n).std()
    return mid + k * sd, mid, mid - k * sd


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev = df["Close"].shift()
    tr = pd.concat(
        [df["High"] - df["Low"], (df["High"] - prev).abs(), (df["Low"] - prev).abs()], axis=1
    ).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    up = df["High"].diff()
    down = -df["Low"].diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)
    a = atr(df, n)
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(alpha=1 / n, adjust=False).mean() / a
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(alpha=1 / n, adjust=False).mean() / a
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def pct_return(close: pd.Series, days: int) -> float | None:
    if len(close) <= days:
        return None
    return float(close.iloc[-1] / close.iloc[-1 - days] - 1) * 100


def annualized_vol(close: pd.Series, days: int = 60) -> float | None:
    r = close.pct_change().dropna().tail(days)
    if len(r) < 20:
        return None
    return float(r.std() * np.sqrt(252) * 100)


def max_drawdown(close: pd.Series) -> float:
    peak = close.cummax()
    return float(((close / peak) - 1).min() * 100)


def _rolling_pctile_of_last(w: np.ndarray) -> float:
    return float((w <= w[-1]).mean() * 100)


def _rolling_max_dd(w: np.ndarray) -> float:
    return float((w / np.maximum.accumulate(w) - 1).min() * 100)


def snapshot_series(df: pd.DataFrame) -> pd.DataFrame:
    """Every snapshot field for every date, computed once and strictly causally:
    row i only uses data up to and including row i (no look-ahead). The backtester
    reads rows from this; snapshot() is the same calculation for the latest row."""
    c, v = df["Close"], df["Volume"]
    m_line, m_sig, m_hist = macd(c)
    bb_u, bb_m, bb_l = bollinger(c)
    r = rsi(c)
    s50, s200 = sma(c, 50), sma(c, 200)
    width = (bb_u - bb_l) / bb_m
    vol20 = v.rolling(20).mean()
    hi52 = c.rolling(252, min_periods=1).max()
    lo52 = c.rolling(252, min_periods=1).min()
    ret = lambda n: (c / c.shift(n) - 1) * 100  # noqa: E731
    out = pd.DataFrame({
        "price": c,
        "change_pct": ret(1),
        "sma20": sma(c, 20),
        "sma50": s50,
        "sma200": s200,
        "sma50_prev": s50.shift(5),
        "sma200_prev": s200.shift(5),
        "ema21": ema(c, 21),
        "rsi14": r,
        "rsi_prev": r.shift(1),
        "macd": m_line,
        "macd_signal": m_sig,
        "macd_hist": m_hist,
        "macd_hist_prev": m_hist.shift(1),
        "bb_upper": bb_u,
        "bb_lower": bb_l,
        "bb_width": width,
        "bb_width_pctile": width.rolling(126, min_periods=30).apply(_rolling_pctile_of_last, raw=True),
        "atr14": atr(df),
        "adx14": adx(df),
        "volume": v,
        "vol_ratio": v / vol20,
        "high_52w": hi52,
        "low_52w": lo52,
        "pct_from_high": (c / hi52 - 1) * 100,
        "pct_from_low": (c / lo52 - 1) * 100,
        "ret_1d": ret(1),
        "ret_5d": ret(5),
        "ret_1m": ret(21),
        "ret_3m": ret(63),
        "ret_6m": ret(126),
        "ret_12m": ret(252),
        "ret_12_1": (c.shift(21) / c.shift(252) - 1) * 100,
        "vol_60d": c.pct_change().rolling(60, min_periods=20).std() * np.sqrt(252) * 100,
        "max_dd_1y": c.rolling(252, min_periods=2).apply(_rolling_max_dd, raw=True),
    }, index=df.index)
    return out.replace([np.inf, -np.inf], np.nan)


def row_to_snapshot(row: pd.Series) -> dict:
    return {k: (None if pd.isna(x) else float(x)) for k, x in row.items()}


def snapshot(df: pd.DataFrame) -> dict:
    """Latest values of every indicator for one ticker; used by strategies and Claude tools."""
    return row_to_snapshot(snapshot_series(df).iloc[-1])


def _snapshot_legacy(df: pd.DataFrame) -> dict:
    """Original single-date implementation, kept for the equivalence test."""
    c = df["Close"]
    m_line, m_sig, m_hist = macd(c)
    bb_u, bb_m, bb_l = bollinger(c)
    r = rsi(c)
    vol20 = df["Volume"].rolling(20).mean()
    last = lambda s: (None if s is None or s.empty or pd.isna(s.iloc[-1]) else float(s.iloc[-1]))  # noqa: E731
    hi52 = float(c.tail(252).max())
    lo52 = float(c.tail(252).min())
    price = float(c.iloc[-1])
    prev = float(c.iloc[-2]) if len(c) > 1 else price
    s50, s200 = sma(c, 50), sma(c, 200)
    width = (bb_u - bb_l) / bb_m
    return {
        "price": price,
        "change_pct": (price / prev - 1) * 100,
        "sma20": last(sma(c, 20)),
        "sma50": last(s50),
        "sma200": last(s200),
        "sma50_prev": float(s50.iloc[-6]) if len(s50.dropna()) > 6 else None,
        "sma200_prev": float(s200.iloc[-6]) if len(s200.dropna()) > 6 else None,
        "ema21": last(ema(c, 21)),
        "rsi14": last(r),
        "rsi_prev": float(r.iloc[-2]) if len(r.dropna()) > 2 else None,
        "macd": last(m_line),
        "macd_signal": last(m_sig),
        "macd_hist": last(m_hist),
        "macd_hist_prev": float(m_hist.iloc[-2]) if len(m_hist.dropna()) > 2 else None,
        "bb_upper": last(bb_u),
        "bb_lower": last(bb_l),
        "bb_width": last(width),
        "bb_width_pctile": float((width.tail(126) <= width.iloc[-1]).mean() * 100) if width.notna().sum() > 30 else None,
        "atr14": last(atr(df)),
        "adx14": last(adx(df)),
        "volume": float(df["Volume"].iloc[-1]),
        "vol_ratio": (float(df["Volume"].iloc[-1] / vol20.iloc[-1]) if last(vol20) else None),
        "high_52w": hi52,
        "low_52w": lo52,
        "pct_from_high": (price / hi52 - 1) * 100,
        "pct_from_low": (price / lo52 - 1) * 100,
        "ret_1d": pct_return(c, 1),
        "ret_5d": pct_return(c, 5),
        "ret_1m": pct_return(c, 21),
        "ret_3m": pct_return(c, 63),
        "ret_6m": pct_return(c, 126),
        "ret_12m": pct_return(c, 252),
        "ret_12_1": (
            float(c.iloc[-22] / c.iloc[-253] - 1) * 100 if len(c) > 253 else None
        ),
        "vol_60d": annualized_vol(c, 60),
        "max_dd_1y": max_drawdown(c.tail(252)),
    }
