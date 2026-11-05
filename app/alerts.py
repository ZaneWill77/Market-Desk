"""Alert condition types.

Alerts themselves (which ticker, threshold, on/off, history) live in each user's browser.
The browser sends its alerts with every watchlist refresh; the server evaluates each
condition against the latest indicator snapshot and returns whether it's met right now.
The browser fires a notification when a condition goes from not-met to met.

To add an alert type, add an AlertType to ALERT_TYPES below. It appears in the UI automatically.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .strategies import STRATEGIES, evaluate


@dataclass(frozen=True)
class AlertType:
    key: str
    label: str          # shown in the "condition" dropdown
    template: str       # human sentence; {symbol}, {value}, {strategy} are filled in
    check: Callable[[dict, float | None, str | None], "tuple[bool, float | None]"]  # (met, current value)
    needs_value: bool = True
    needs_strategy: bool = False
    unit: str = ""      # for the value input: "$", "%", ""
    default: float | None = None


def _cmp(field: str, above: bool):
    def check(s, value, _strategy):
        cur = s.get(field)
        if cur is None:
            return False, None
        return (cur >= value if above else cur <= value), cur
    return check


def _down_pct(s, value, _):
    cur = s.get("change_pct")
    return (cur is not None and cur <= -abs(value)), cur


def _up_pct(s, value, _):
    cur = s.get("change_pct")
    return (cur is not None and cur >= abs(value)), cur


def _vs_sma(field: str, above: bool):
    def check(s, _value, _strategy):
        ma = s.get(field)
        if ma is None:
            return False, None
        return (s["price"] > ma if above else s["price"] < ma), s["price"]
    return check


def _score(above: bool):
    def check(s, value, strategy):
        if strategy not in STRATEGIES:
            return False, None
        score = evaluate(strategy, s)["score"]
        return (score >= value if above else score <= value), score
    return check


def _earnings_soon(s, value, _):
    days = s.get("days_to_earnings")  # added by the /api/watch endpoint only when needed
    return (days is not None and 0 <= days <= value), days


def _near_high(s, value, _):
    cur = s.get("pct_from_high")
    return (cur is not None and cur >= -abs(value)), cur


ALERT_TYPES: dict[str, AlertType] = {a.key: a for a in [
    AlertType("price_above", "Price rises above", "{symbol} price ≥ ${value}", _cmp("price", True), unit="$"),
    AlertType("price_below", "Price falls below", "{symbol} price ≤ ${value}", _cmp("price", False), unit="$"),
    AlertType("up_pct", "Up today by at least", "{symbol} up {value}%+ today", _up_pct, unit="%", default=3),
    AlertType("down_pct", "Down today by at least", "{symbol} down {value}%+ today", _down_pct, unit="%", default=3),
    AlertType("rsi_above", "RSI rises above", "{symbol} RSI ≥ {value}", _cmp("rsi14", True), default=70),
    AlertType("rsi_below", "RSI falls below", "{symbol} RSI ≤ {value}", _cmp("rsi14", False), default=30),
    AlertType("score_above", "Strategy score at least", "{symbol} {strategy} score ≥ {value}", _score(True),
              needs_strategy=True, default=75),
    AlertType("score_below", "Strategy score at most", "{symbol} {strategy} score ≤ {value}", _score(False),
              needs_strategy=True, default=25),
    AlertType("above_sma50", "Closes above 50-day SMA", "{symbol} above its 50-day SMA", _vs_sma("sma50", True), needs_value=False),
    AlertType("below_sma50", "Closes below 50-day SMA", "{symbol} below its 50-day SMA", _vs_sma("sma50", False), needs_value=False),
    AlertType("above_sma200", "Closes above 200-day SMA", "{symbol} above its 200-day SMA", _vs_sma("sma200", True), needs_value=False),
    AlertType("below_sma200", "Closes below 200-day SMA", "{symbol} below its 200-day SMA", _vs_sma("sma200", False), needs_value=False),
    AlertType("near_high", "Within % of 52-week high", "{symbol} within {value}% of its 52-week high", _near_high, unit="%", default=2),
    AlertType("earnings_soon", "Earnings within", "{symbol} reports earnings within {value} days",
              _earnings_soon, unit="d", default=7),
    AlertType("volume_spike", "Volume at least × average", "{symbol} volume ≥ {value}× its 20-day average",
              _cmp("vol_ratio", True), unit="×", default=2),
]}


def describe(alert: dict) -> str:
    t = ALERT_TYPES.get(alert.get("type"))
    if not t:
        return "Unknown alert"
    strat = STRATEGIES.get(alert.get("strategy") or "")
    value = alert.get("value")
    return t.template.format(symbol=alert.get("symbol", "?"),
                             value=(f"{value:g}" if isinstance(value, (int, float)) else value),
                             strategy=strat.name if strat else "")


def check_alert(alert: dict, snap: dict | None) -> dict:
    """Evaluate one alert against a snapshot. Never raises; bad alerts come back with an error."""
    t = ALERT_TYPES.get(alert.get("type"))
    if t is None:
        return {"met": False, "error": "Unknown alert type"}
    if snap is None:
        return {"met": False, "error": "No data"}
    value = alert.get("value")
    if t.needs_value:
        try:
            value = float(value)
        except (TypeError, ValueError):
            return {"met": False, "error": "Missing threshold"}
    met, current = t.check(snap, value, alert.get("strategy"))
    return {"met": bool(met), "current": current, "text": describe(alert)}


def types_for_ui() -> list[dict]:
    return [{"key": a.key, "label": a.label, "needs_value": a.needs_value, "needs_strategy": a.needs_strategy,
             "unit": a.unit, "default": a.default} for a in ALERT_TYPES.values()]
