from . import clamp, register, val


@register("trend", "Trend Following",
          "Looks for stacked moving averages (price > SMA50 > SMA200), rising SMA50, bullish MACD and a strong ADX.",
          order=20)
def trend_following(s: dict):
    score, why = 40.0, []
    p, s50, s200 = s["price"], s.get("sma50"), s.get("sma200")
    if s50 and s200:
        if p > s50 > s200:
            score += 25
            why.append("price > SMA50 > SMA200 (stacked uptrend)")
        elif p < s50 < s200:
            score -= 25
            why.append("price < SMA50 < SMA200 (downtrend)")
        else:
            why.append(f"price {'above' if p > s50 else 'below'} SMA50, SMA50 {'above' if s50 > s200 else 'below'} SMA200")
    if s.get("sma50_prev") and s50 and s50 > s["sma50_prev"]:
        score += 6
        why.append("SMA50 rising")
    if s.get("macd") is not None and s.get("macd_signal") is not None:
        if s["macd"] > s["macd_signal"]:
            score += 10
            why.append("MACD above signal")
        else:
            score -= 8
    a = val(s, "adx14")
    if a > 25:
        score += 10 if s50 and p > s50 else -5
        why.append(f"strong trend ADX {a:.0f}")
    elif a < 18:
        score -= 6
        why.append(f"weak trend ADX {a:.0f}")
    return clamp(score), why
