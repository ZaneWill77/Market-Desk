# Contributing to Market Desk

Thanks for helping out! Most improvements fit one of the extension points below, and each
one usually needs only a single new or edited file.

## Setup

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt     # Windows: .venv\Scripts\pip
.venv/bin/python -m pytest                        # must pass before you open a PR
.venv/bin/python -m app                          # run locally
```

## Add a strategy

1. Copy `app/strategies/_template.py` to `app/strategies/<your_strategy>.py`. The file name must not start with `_`.
2. Write a function that takes the indicator **snapshot** dict and returns `(score 0-100, [reasons])`.
3. Decorate it with `@register("key", "Display Name", "One-line description", order=N)`.

That's it. It now appears in the dashboard dropdown, the scanner, the per-ticker scorecard
and Claude's `run_strategy_scan` tool. The test suite automatically checks that every
registered strategy returns a bounded score for uptrend, downtrend and short-history data.

Guidelines:
- Use `val(s, "field", default)`, because snapshot fields are `None` when there isn't enough history.
- Keep reasons short and concrete, like `"RSI 28 (oversold)"` rather than `"looks good"`.
- If your strategy needs a new indicator, add it to `snapshot()` in `app/indicators.py`
  and list it in the template's docstring.

## Add a stock list

Add an entry to `app/data/universes.json`:

```json
"dividend_kings": { "name": "Dividend Kings", "tickers": ["KO", "PG", "JNJ"] }
```

Use Yahoo Finance symbols (`BRK-B`, not `BRK.B`; `^VIX` for indices; `BTC-USD` for crypto).

## Add a tool for Claude

In `app/tools.py`:

```python
@market_tool("get_earnings_dates", "Upcoming earnings dates for a ticker.",
             SYMBOL, ["symbol"], label="Checking earnings")
def _earnings(args):
    ...  # return anything JSON-serializable; raise ValueError for user-facing errors
```

Every AI provider exposes it automatically. Tools must be read-only and must not touch the
filesystem or run commands.

## Add an AI provider

Create `app/providers/<name>.py` following the interface in `app/providers/base.py`
(`ID`, `NAME`, `NEEDS_API_KEY`, `LOCAL_ONLY`, `MODELS`, `validate_key()` or `check_login()`,
and an async `chat()` generator), then add it to `PROVIDERS` in `app/providers/__init__.py`.
Sign-in, sign-out and the UI pick it up automatically.

Published providers must authenticate each user with **their own** credentials for a service
that permits it, such as an Anthropic API key or a cloud provider key.

## Ground rules

- **Never log, persist or return users' API keys.** Keys live only in `auth.Session` in memory.
- **Don't add sign-in with claude.ai accounts or Claude Pro/Max plans.** Anthropic doesn't
  permit third-party apps to offer claude.ai login or route requests through subscription
  plans ([terms](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).
  The Claude API with each user's own API key is the supported path.
- Keep the offline tests offline. Mock network calls instead of hitting Yahoo or Anthropic.
- Prefer small, focused PRs with a short description of what changed and why.
