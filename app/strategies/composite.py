from . import STRATEGIES, clamp, register

# Weights of other registered strategies. Edit to taste; missing keys are skipped.
WEIGHTS = {"momentum": 0.35, "trend": 0.35, "breakout": 0.15, "low_vol": 0.15}


@register("composite", "All-Around Composite",
          "Blends momentum, trend, breakout and low-volatility scores into one ranking.", order=0)
def composite(s: dict):
    parts = {k: STRATEGIES[k].fn(s)[0] for k in WEIGHTS if k in STRATEGIES}
    total_w = sum(WEIGHTS[k] for k in parts) or 1
    score = sum(v * WEIGHTS[k] for k, v in parts.items()) / total_w
    return clamp(score), [f"{k} {v:.0f}" for k, v in parts.items()]
