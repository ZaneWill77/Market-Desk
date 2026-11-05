from . import clamp, register, val


@register("unusual_volume", "Unusual Volume",
          "Today's volume versus the 20-day average - surfaces stocks with something happening.", order=70)
def unusual_volume(s: dict):
    score, why = 20.0, []
    vr = val(s, "vol_ratio", 1)
    score += min(60, (vr - 1) * 30)
    why.append(f"volume {vr:.1f}x 20-day avg")
    ch = val(s, "change_pct")
    if abs(ch) > 2:
        score += min(15, abs(ch) * 2)
        why.append(f"{'up' if ch > 0 else 'down'} {abs(ch):.1f}% today")
    return clamp(score), why
