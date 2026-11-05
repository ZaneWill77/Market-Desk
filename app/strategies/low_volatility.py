from . import clamp, register, val


@register("low_vol", "Low Volatility / Defensive",
          "Lowest realized volatility and shallowest drawdowns - defensive positioning.", order=60)
def low_volatility(s: dict):
    score, why = 50.0, []
    v = s.get("vol_60d")
    if v is None:
        return 0.0, ["insufficient history"]
    score += (30 - v) * 1.5
    why.append(f"60d annualized vol {v:.0f}%")
    dd = val(s, "max_dd_1y")
    score += (dd + 20) * 0.6
    why.append(f"1y max drawdown {dd:.0f}%")
    if s.get("sma200") and s["price"] > s["sma200"]:
        score += 10
        why.append("above 200 SMA")
    return clamp(score), why
