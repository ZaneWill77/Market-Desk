from . import clamp, register


@register("golden_cross", "Golden Cross", "Fresh or imminent SMA50 / SMA200 crossovers.", order=50)
def golden_cross(s: dict):
    score, why = 30.0, []
    s50, s200 = s.get("sma50"), s.get("sma200")
    p50, p200 = s.get("sma50_prev"), s.get("sma200_prev")
    if not (s50 and s200 and p50 and p200):
        return 0.0, ["insufficient history"]
    gap = (s50 / s200 - 1) * 100
    if p50 <= p200 and s50 > s200:
        score += 50
        why.append("fresh golden cross (last 5 sessions)")
    elif p50 >= p200 and s50 < s200:
        score -= 25
        why.append("fresh death cross (last 5 sessions)")
    elif s50 > s200:
        score += max(0, 20 - gap * 2)
        why.append(f"SMA50 {gap:+.1f}% vs SMA200")
    else:
        closing = (s50 - p50) > (s200 - p200)
        if closing and gap > -3:
            score += 15 + (3 + gap) * 6
            why.append(f"SMA50 converging on SMA200 ({gap:+.1f}%)")
        else:
            score -= 10
            why.append(f"SMA50 {gap:+.1f}% below SMA200")
    if s["price"] > s50:
        score += 8
        why.append("price above SMA50")
    return clamp(score), why
