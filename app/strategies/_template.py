"""Template for a new strategy. Copy this file to a name WITHOUT a leading underscore
(e.g. rsi_divergence.py) and it will be picked up automatically.

Available snapshot fields (see app/indicators.py -> snapshot()):
    price, change_pct, sma20, sma50, sma200, sma50_prev, sma200_prev, ema21,
    rsi14, rsi_prev, macd, macd_signal, macd_hist, macd_hist_prev,
    bb_upper, bb_lower, bb_width, bb_width_pctile, atr14, adx14,
    volume, vol_ratio, high_52w, low_52w, pct_from_high, pct_from_low,
    ret_1d, ret_5d, ret_1m, ret_3m, ret_6m, ret_12m, ret_12_1, vol_60d, max_dd_1y

Any field can be None when there isn't enough history - use val(s, "field", default).
Return a score from 0 (avoid) to 100 (strongest setup) and a few short reasons.
"""
from . import clamp, register, val


@register("example", "Example Strategy", "Describe what this strategy looks for.", order=999)
def example(s: dict):
    score, why = 50.0, []
    if val(s, "rsi14", 50) > 50:
        score += 10
        why.append(f"RSI {s['rsi14']:.0f} above 50")
    return clamp(score), why
