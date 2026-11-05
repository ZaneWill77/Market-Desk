from . import clamp, register, val


@register("momentum", "Momentum (12-1)",
          "Ranks by 12-month return excluding the last month, plus 3/6-month strength and position vs. the 200-day SMA.",
          order=10)
def momentum(s: dict):
    score, why = 50.0, []
    r12 = s.get("ret_12_1")
    if r12 is not None:
        score += clamp(r12, -40, 60) * 0.5
        why.append(f"12-1M return {r12:+.1f}%")
    score += clamp(val(s, "ret_6m"), -30, 40) * 0.3 + clamp(val(s, "ret_3m"), -20, 30) * 0.3
    if s.get("sma200") and s["price"] > s["sma200"]:
        score += 8
        why.append("above 200-day SMA")
    else:
        score -= 12
        why.append("below 200-day SMA")
    if val(s, "pct_from_high", -100) > -5:
        score += 6
        why.append(f"{s['pct_from_high']:.1f}% from 52w high")
    if val(s, "rsi14") > 80:
        score -= 6
        why.append(f"overbought RSI {s['rsi14']:.0f}")
    return clamp(score), why
