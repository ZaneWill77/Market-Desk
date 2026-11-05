"""Shared pieces for AI providers.

A provider is a module exposing:
    ID: str                      - short id used by the UI and sessions
    NAME: str                    - display name
    NEEDS_API_KEY: bool          - True: sign-in asks for a key, checked by validate_key(key)
                                   False: sign-in calls check_login() -> error message or None
    LOCAL_ONLY: bool             - only offered to direct requests from the same machine
    MODELS: list[tuple[str,str]] - (model id, label); first is the default
    async def chat(session, message, conversation_id, model, effort) -> AsyncIterator[dict]

chat() yields UI events:
    {"type": "conversation", "conversation_id": str}   - id to send with the next message
    {"type": "text", "text": str}                     - streamed answer text
    {"type": "tool", "label": str}                    - a tool started running
    {"type": "turn"}                                  - a new model turn is starting
    {"type": "error", "message": str}
    {"type": "done"}
"""
from __future__ import annotations

from datetime import datetime

from .. import bot

# Kept byte-stable (no dates or other per-request values) so it can be prompt-cached.
SYSTEM_PROMPT = """You are the market analyst built into a stock-market dashboard.

You have live tools: market overview & regime, the strategy-scan bot, per-ticker technical analysis, fundamentals, news, price history, plus web search for macro events, earnings and breaking news.

How to work:
- Always pull fresh data with tools before making claims about current prices, levels or trends. Never guess numbers.
- Be concrete: quote the actual levels (price, SMA, RSI, % moves) you got from the tools.
- When asked for "the full picture", combine: regime + indices + sector rotation + breadth from a scan + relevant news/macro.
- Structure answers with short headers and bullets. Use tables when comparing several tickers.
- Give balanced views: the bull case, the bear case, key levels to watch, and what would change your mind.
- You are an analysis aid, not a financial advisor. You can say which setups look strong under a given strategy, but don't tell the user to buy or sell or how much. Keep any disclaimer to one short line.
"""


def context_line() -> str:
    """Per-message context (date, market state) - sent in the user turn, not the system prompt."""
    st = bot.market_status()
    return f"[Context: {datetime.now().strftime('%A, %B %d, %Y')}; US market is {st['state']} ({st['time_et']}).]"
