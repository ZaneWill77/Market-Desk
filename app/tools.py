"""Tools Claude can call, defined once and shared by every AI provider.

To add a tool: write a plain (sync) Python function that takes the input dict and returns
something JSON-serializable, then decorate it with @market_tool(...). Raise ValueError for
user-facing errors. The tool becomes available to Claude in every provider automatically.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from . import bot, market_data as md
from .strategies import STRATEGIES


@dataclass(frozen=True)
class MarketTool:
    name: str
    description: str
    input_schema: dict
    fn: Callable[[dict], Any]
    label: str  # shown in the chat while the tool runs


TOOLS: dict[str, MarketTool] = {}


def market_tool(name: str, description: str, properties: dict | None = None,
                required: list[str] | None = None, label: str = ""):
    schema = {"type": "object", "properties": properties or {}, "required": required or [],
              "additionalProperties": False}

    def deco(fn):
        TOOLS[name] = MarketTool(name, description, schema, fn, label or name)
        return fn

    return deco


def run_tool(name: str, args: dict) -> str:
    """Execute a tool and return its JSON text. Raises ValueError/KeyError on bad input."""
    tool = TOOLS[name]
    for key in tool.input_schema["required"]:
        if not isinstance(args.get(key), str) or not args[key].strip():
            raise ValueError(f"'{key}' is required")
    return json.dumps(tool.fn(args), default=str)[:60000]


def label_for(name: str, args: dict) -> str:
    tool = TOOLS.get(name)
    detail = args.get("symbol") or args.get("strategy") or args.get("query") or ""
    return f"{tool.label if tool else name} {detail}".strip()


SYMBOL = {"symbol": {"type": "string", "description": "Ticker symbol, e.g. AAPL, SPY, ^VIX, BTC-USD"}}


@market_tool("get_market_overview",
             "Live snapshot of major indices, VIX, 10Y yield, gold, oil, bitcoin, all 11 sector ETFs "
             "(1d/1w/1m/3m/YTD returns) and a rules-based risk-on/risk-off regime read.",
             label="Reading market overview")
def _overview(args):
    ov = bot.market_overview()
    for i in ov["indices"]:
        i.pop("spark", None)
    return ov


@market_tool("run_strategy_scan",
             "Run the market bot: scan a stock universe with a strategy and return ranked results, "
             "breadth stats and reasons. strategy is one of: " + ", ".join(STRATEGIES) +
             ". universe is one of: " + ", ".join(bot.UNIVERSES) +
             ". For universe='custom', pass tickers as a comma-separated string.",
             {"strategy": {"type": "string"}, "universe": {"type": "string"},
              "tickers": {"type": "string", "description": "Comma-separated tickers, only for universe='custom'"}},
             ["strategy", "universe"], label="Running strategy scan")
def _scan(args):
    custom = [t for t in (args.get("tickers") or "").replace(" ", ",").split(",") if t]
    res = bot.run_scan(args["strategy"], args["universe"], custom, 15)
    res.pop("results", None)  # top/bottom are enough
    return res


@market_tool("analyze_stock",
             "Full technical picture for one ticker: price, moving averages, RSI, MACD, Bollinger, ADX, ATR, "
             "volume, 52w range, returns, volatility, drawdown, and a score from every strategy.",
             SYMBOL, ["symbol"], label="Analyzing")
def _analyze(args):
    return bot.analyze_ticker(args["symbol"])


@market_tool("get_fundamentals",
             "Fundamental snapshot for a ticker: valuation ratios, margins, growth, dividend, beta, "
             "analyst target/recommendation, business summary.",
             SYMBOL, ["symbol"], label="Pulling fundamentals")
def _fundamentals(args):
    info = md.get_info(args["symbol"])
    if not info:
        raise ValueError("No fundamental data available (ETF/index, or Yahoo is rate-limiting).")
    return info


@market_tool("get_news", "Recent news headlines for a ticker (use SPY or QQQ for broad-market news).",
             SYMBOL, ["symbol"], label="Reading news")
def _news(args):
    return md.get_news(args["symbol"], 10)


@market_tool("get_price_history",
             "Daily closing prices for a ticker. period: 1mo, 3mo, 6mo, 1y, 2y, 5y. "
             "Long periods are down-sampled to weekly.",
             {**SYMBOL, "period": {"type": "string", "enum": ["1mo", "3mo", "6mo", "1y", "2y", "5y"]}},
             ["symbol"], label="Loading price history")
def _history(args):
    df = md.get_one(args["symbol"], args.get("period") or "6mo")
    if df is None:
        raise ValueError(f"No data for {args['symbol']}")
    c = df["Close"]
    if len(c) > 130:
        c = c.resample("W").last()
    return {d.strftime("%Y-%m-%d"): round(float(v), 2) for d, v in c.items()}
