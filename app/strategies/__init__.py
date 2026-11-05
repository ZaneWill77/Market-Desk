"""Strategy plugin registry.

Every module in this package (except ones starting with "_") is imported automatically.
A module adds strategies by decorating a scoring function with @register(...):

    from . import register, clamp

    @register("my_key", "My Strategy", "One-line description shown in the UI.", order=50)
    def my_strategy(s: dict) -> tuple[float, list[str]]:
        # `s` is the indicator snapshot from app.indicators.snapshot()
        return clamp(score), ["reason 1", "reason 2"]

The strategy then appears in the dashboard dropdown, the scanner, the ticker scorecard
and Claude's tools - no other file needs to change. See _template.py for a full example.
"""
from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass
from typing import Callable

ScoreFn = Callable[[dict], "tuple[float, list[str]]"]


@dataclass(frozen=True)
class Strategy:
    key: str
    name: str
    description: str
    fn: ScoreFn
    order: int = 100


STRATEGIES: dict[str, Strategy] = {}


def register(key: str, name: str, description: str, order: int = 100):
    """Decorator that adds a scoring function to the registry."""

    def deco(fn: ScoreFn) -> ScoreFn:
        if key in STRATEGIES:
            raise ValueError(f"Duplicate strategy key '{key}'")
        STRATEGIES[key] = Strategy(key, name, description, fn, order)
        return fn

    return deco


def clamp(x: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, x))


def val(s: dict, k: str, default: float = 0.0) -> float:
    """Snapshot value with a default for missing/None."""
    v = s.get(k)
    return default if v is None else v


def rating(score: float) -> str:
    if score >= 75:
        return "Strong"
    if score >= 60:
        return "Favorable"
    if score >= 40:
        return "Neutral"
    if score >= 25:
        return "Weak"
    return "Avoid"


def evaluate(key: str, snap: dict) -> dict:
    score, why = STRATEGIES[key].fn(snap)
    score = clamp(float(score))
    return {"score": round(score, 1), "rating": rating(score), "reasons": list(why)}


def ordered() -> list[Strategy]:
    return sorted(STRATEGIES.values(), key=lambda s: (s.order, s.name))


def _discover() -> None:
    for mod in pkgutil.iter_modules(__path__):
        if not mod.name.startswith("_"):
            importlib.import_module(f"{__name__}.{mod.name}")


_discover()
