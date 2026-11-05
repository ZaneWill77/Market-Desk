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


@market_tool("run_backtest",
             "Backtest a strategy: on each rebalance date pick the top N scorers from a universe "
             "(equal weight, no look-ahead) and compare with SPY and an equal-weight universe. Returns "
             "total return, CAGR, volatility, Sharpe, max drawdown, win rate and recent holdings. "
             "period: 1y, 2y, 3y, 5y. rebalance: monthly or weekly. Note results carry survivorship bias.",
             {"strategy": {"type": "string"}, "universe": {"type": "string"},
              "tickers": {"type": "string", "description": "Comma-separated tickers, only for universe='custom'"},
              "period": {"type": "string", "enum": ["1y", "2y", "3y", "5y"]},
              "rebalance": {"type": "string", "enum": ["monthly", "weekly"]},
              "top_n": {"type": "string", "description": "How many stocks to hold, e.g. '10'"}},
             ["strategy", "universe"], label="Backtesting")
def _backtest(args):
    from .backtest import run_backtest
    custom = [t for t in (args.get("tickers") or "").replace(" ", ",").split(",") if t]
    top_n = int(args.get("top_n") or 10)
    res = run_backtest(args["strategy"], args["universe"], custom, args.get("period") or "2y",
                       args.get("rebalance") or "monthly", top_n)
    res.pop("curves", None)  # too long for the model; stats + periods tell the story
    res["periods"] = res["periods"][:6]
    return res


@market_tool("compare_tickers",
             "Compare up to 8 tickers over a period: total return, excess return vs a benchmark, volatility, "
             "max drawdown, beta, correlation with the benchmark, and a correlation matrix between them. "
             "benchmark: SPY, QQQ, any ticker, or 'sector' to measure each stock against its own sector ETF. "
             "period: 1mo, 3mo, 6mo, ytd, 1y, 2y, 5y.",
             {"symbols": {"type": "string", "description": "Comma-separated tickers, e.g. 'NVDA, AMD, AVGO'"},
              "period": {"type": "string", "enum": ["1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y"]},
              "benchmark": {"type": "string", "description": "SPY (default), QQQ, any ticker, or 'sector'"}},
             ["symbols"], label="Comparing")
def _compare(args):
    from .compare import compare
    syms = [s for s in args["symbols"].replace(" ", ",").split(",") if s]
    res = compare(syms, args.get("period") or "1y", args.get("benchmark") or "SPY")
    for k in ("dates", "performance", "relative", "benchmark_performance"):
        res.pop(k, None)  # the stats and correlation matrix are what the model needs
    return res


@market_tool("get_market_calendar",
             "Upcoming market-moving events: US economic releases (CPI, payrolls, Fed, GDP, etc., tagged "
             "high/medium/low impact, with previous/expected/actual values) and company earnings reports "
             "(date, before open / after close, EPS estimate) for the next N days.",
             {"days": {"type": "string", "description": "How many days ahead, 1-30 (default '7')"},
              "min_market_cap_billions": {"type": "string", "description": "Only earnings from companies at least this big, in $B (default '10')"},
              "impact": {"type": "string", "enum": ["high", "medium", "all"], "description": "Minimum economic-event impact (default 'medium')"}},
             [], label="Checking the calendar")
def _calendar(args):
    from . import calendar_data as cal
    days = int(args.get("days") or 7)
    cap = float(args.get("min_market_cap_billions") or 10)
    levels = {"high": {"high"}, "medium": {"high", "medium"}, "all": {"high", "medium", "low"}}[args.get("impact") or "medium"]
    econ = [e for e in cal.economic_events(days) if e["impact"] in levels]
    earnings = cal.market_earnings(days, cap * 1e9)[:80]
    return {"economic_events": econ, "earnings": earnings, "earnings_shown": len(earnings)}


@market_tool("get_earnings_history",
             "A company's next earnings date and estimates, plus its last 8 reports: EPS estimate vs "
             "actual, surprise %, and the stock's price move the session after each report "
             "(useful for gauging the typical earnings move).",
             SYMBOL, ["symbol"], label="Reading earnings history")
def _earnings_history(args):
    from . import calendar_data as cal
    return cal.ticker_earnings(args["symbol"])


@market_tool("analyze_portfolio",
             "Analyze a portfolio the user describes: value, weights, P&L vs cost, sector/asset allocation, "
             "concentration, beta, volatility, 1-day 95% VaR, max drawdown, risk contribution per position, "
             "correlations, hypothetical 1y performance vs SPY, and rule-based observations. "
             "holdings format: 'AAPL:50@150, NVDA:120@95, SPY:30' (ticker:shares@avg_cost, cost optional).",
             {"holdings": {"type": "string", "description": "e.g. 'AAPL:50@150, NVDA:120, SPY:30@410'"},
              "cash": {"type": "string", "description": "Cash balance in dollars (optional)"},
              "period": {"type": "string", "enum": ["6mo", "1y", "2y", "3y"]}},
             ["holdings"], label="Analyzing portfolio")
def _portfolio(args):
    from .portfolio import analyze
    items = []
    for part in args["holdings"].replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        sym, _, rest = part.partition(":")
        shares, _, cost = rest.partition("@")
        if not shares.strip():
            raise ValueError(f"Missing share count in '{part}' (use TICKER:SHARES@COST)")
        items.append({"symbol": sym.strip(), "shares": shares.strip().replace("$", ""),
                      "cost": cost.strip().replace("$", "") or None})
    res = analyze(items, float(str(args.get("cash") or 0).replace("$", "").replace(",", "")), args.get("period") or "1y")
    perf = res["performance"]
    for k in ("dates", "portfolio", "benchmark_curve"):
        perf.pop(k, None)
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
