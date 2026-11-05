from . import clamp, register, val


@register("breakout", "52-Week Breakout",
          "Stocks pressing 52-week highs on heavy volume, with a bonus for volatility squeezes.",
          order=40)
def breakout(s: dict):
    score, why = 30.0, []
    d = val(s, "pct_from_high", -100)
    if d >= -1:
        score += 35
        why.append("at/near 52-week high")
    elif d >= -5:
        score += 20
        why.append(f"{d:.1f}% below 52w high")
    else:
        score -= min(20, abs(d) * 0.5)
    vr = val(s, "vol_ratio", 1)
    if vr >= 1.5:
        score += min(25, (vr - 1) * 20)
        why.append(f"volume {vr:.1f}x 20-day avg")
    if val(s, "change_pct") > 1.5:
        score += 8
        why.append(f"up {s['change_pct']:.1f}% today")
    pct = s.get("bb_width_pctile")
    if pct is not None and pct < 25:
        score += 10
        why.append("volatility squeeze (tight Bollinger width)")
    if val(s, "adx14") > 20:
        score += 5
    return clamp(score), why
