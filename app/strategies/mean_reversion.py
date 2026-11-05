from . import clamp, register, val


@register("mean_reversion", "Mean Reversion / Oversold",
          "Finds oversold names (low RSI, below the lower Bollinger Band), preferring ones still in a long-term uptrend.",
          order=30)
def mean_reversion(s: dict):
    score, why = 30.0, []
    r = val(s, "rsi14", 50)
    if r < 30:
        score += (30 - r) * 2 + 20
        why.append(f"oversold RSI {r:.0f}")
    elif r < 40:
        score += (40 - r) * 1.5
        why.append(f"weak RSI {r:.0f}")
    else:
        score -= (r - 40) * 0.6
    if s.get("bb_lower") and s["price"] < s["bb_lower"]:
        score += 18
        why.append("closed below lower Bollinger Band")
    if s.get("sma200") and s["price"] > s["sma200"]:
        score += 12
        why.append("long-term uptrend intact (>200 SMA)")
    elif s.get("sma200"):
        score -= 8
        why.append("below 200 SMA (falling knife risk)")
    if s.get("rsi_prev") is not None and r > s["rsi_prev"] and r < 40:
        score += 6
        why.append("RSI turning up")
    r5 = val(s, "ret_5d")
    if r5 < -5:
        score += 6
        why.append(f"5-day drop {r5:.1f}%")
    return clamp(score), why
