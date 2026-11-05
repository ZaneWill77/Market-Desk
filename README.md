# Market Desk

A stock market analysis dashboard with a strategy-driven **market bot** and a built-in
**Claude analyst** you can chat with about live market data.

- **Market overview:** indices, VIX, yields, commodities and crypto, plus a Risk-On / Risk-Off regime read
- **Sector rotation:** all 11 sectors ranked over 1D / 1W / 1M / 3M / YTD
- **Market bot:** pick a strategy and a stock list from the dropdowns to get ranked scores, reasons and breadth stats
- **Ticker analysis:** candlesticks, moving averages, Bollinger Bands, RSI, MACD, a score from every strategy, fundamentals and news
- **Claude analyst:** streaming chat where Claude pulls live data, runs the bot and searches the web
- **Sign in / sign out:** each person connects their own Claude access

Market data comes from Yahoo Finance via [`yfinance`](https://github.com/ranaroussi/yfinance). It's free,
needs no key, and intraday prices are delayed about 15 minutes.

> This is an analysis tool, not financial advice.

## Quick start

Requires Python 3.11+.

```bash
git clone https://github.com/<you>/market-desk.git
cd market-desk
```

- **Windows:** double-click `run.bat`
- **macOS / Linux:** `./run.sh`

Then open http://127.0.0.1:8765. The dashboard works right away. To chat with Claude, click **Sign in**.

## Signing in to the Claude analyst

The market dashboard and strategy bot are free and need no account. The **Claude analyst chat**
needs an **Anthropic API key**:

1. Create a key at [console.anthropic.com](https://console.anthropic.com/settings/keys). Usage is billed to your Anthropic API account, which is separate from a Claude Pro/Max subscription.
2. Click **Sign in** and paste the key.
3. Click **Sign out** when you're done.

Why not "Sign in with Claude"? Anthropic's terms don't allow third-party apps to offer claude.ai
login or to use Claude Pro/Max plans on their users' behalf
([details](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).
API keys are the supported way for apps like this one.

How your key is handled:

- It's checked with Anthropic, then held **only in the server's memory**, tied to your browser session by an HttpOnly cookie.
- It's never written to disk, never sent back to the browser, and is erased when you sign out, when the session expires (12 hours of inactivity by default), or when the server restarts.
- In this app Claude has no file or shell access. It can only use the market tools and web search.

**Hosting it for others?** Serve it over HTTPS (set `SECURE_COOKIES=1`) and remember that users are
trusting your server with their API key. For most people, running it locally is the better choice.

## Configuration

Copy `.env.example` to `.env`. The launchers read it.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8765` | Port to serve on |
| `HOST` | `127.0.0.1` | Interface to bind (keep local unless you're deploying) |
| `SESSION_TTL_HOURS` | `12` | Idle time before sign-in expires |
| `SECURE_COOKIES` | `0` | Set to `1` behind HTTPS |

## Project layout

```
app/
  server.py           FastAPI routes: data API, sign-in/out, streaming chat
  auth.py             in-memory sessions (HttpOnly cookie → session)
  config.py           settings from environment variables
  bot.py              market overview, regime, scanner
  indicators.py       RSI, MACD, Bollinger, ADX, ATR, returns, volatility
  market_data.py      yfinance access + caching
  tools.py            tools Claude can call (shared by all providers)
  strategies/         one file per strategy, auto-discovered
  providers/          AI backends (anthropic_api.py: Claude API with the user's key)
  data/universes.json stock lists for the scanner
static/               dashboard UI (vanilla JS + Plotly)
tests/                offline test suite (pytest)
```

## Extending it

The project is built so most additions touch **one file**:

- **New strategy:** copy `app/strategies/_template.py` to a new file and write a scoring function. It shows up in the dropdown, the scanner, the scorecard and Claude's tools automatically.
- **New stock list:** add an entry to `app/data/universes.json`.
- **New Claude tool:** add a function with `@market_tool(...)` in `app/tools.py`. Both providers pick it up.
- **New AI provider:** add a module in `app/providers/` following the interface in `providers/base.py`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Development

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt   # Windows: .venv\Scripts\pip
.venv/bin/python -m pytest                      # offline tests, no network needed
.venv/bin/python -m app                         # run the server
```

## License

[MIT](LICENSE)
