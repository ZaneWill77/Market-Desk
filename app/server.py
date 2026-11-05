"""FastAPI server: JSON API for the dashboard + streaming Claude chat."""
from __future__ import annotations

import json
from pathlib import Path

import anthropic
import pandas as pd
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from datetime import datetime

from . import alerts, auth, backtest, bot, calendar_data as cal, compare, market_data as md, portfolio
from .indicators import bollinger, macd, rsi, sma, snapshot
from .strategies import STRATEGIES, evaluate
from .providers import PROVIDERS
from .strategies import ordered

STATIC = Path(__file__).resolve().parent.parent / "static"
app = FastAPI(title="Stock Market Analysis Dashboard")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def _clean(obj):
    """Replace NaN/inf with None so the JSON is valid."""
    if isinstance(obj, float):
        return None if pd.isna(obj) or obj in (float("inf"), float("-inf")) else obj
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/meta")
def meta():
    return {
        "strategies": [{"key": s.key, "name": s.name, "description": s.description} for s in ordered()],
        "universes": [{"key": k, "name": u["name"], "count": len(u["tickers"])} for k, u in bot.UNIVERSES.items()],
        "alert_types": alerts.types_for_ui(),
        "status": bot.market_status(),
    }


@app.get("/api/overview")
def overview(refresh: bool = False):
    if refresh:
        md.clear_cache()
    return _clean(bot.market_overview())


class ScanRequest(BaseModel):
    strategy: str
    universe: str
    tickers: str = ""


@app.post("/api/scan")
def scan(req: ScanRequest):
    custom = [t for t in req.tickers.replace(" ", ",").split(",") if t.strip()]
    try:
        return _clean(bot.run_scan(req.strategy, req.universe, custom, top_n=15))
    except ValueError as e:
        raise HTTPException(400, str(e))


class WatchAlert(BaseModel):
    id: str = Field(max_length=64)
    symbol: str = Field(max_length=20)
    type: str = Field(max_length=40)
    value: float | None = None
    strategy: str | None = Field(default=None, max_length=40)


class WatchRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list, max_length=150)
    alerts: list[WatchAlert] = Field(default_factory=list, max_length=300)


WATCH_FIELDS = ("price", "change_pct", "ret_5d", "ret_1m", "ret_3m", "rsi14", "vol_ratio", "pct_from_high",
                "sma50", "sma200")


@app.post("/api/watch")
def watch(req: WatchRequest):
    """Latest data for a watchlist plus the current state of each alert (polled by the browser)."""
    syms = sorted({md.normalize(s) for s in req.symbols + [a.symbol for a in req.alerts] if s.strip()})
    data = md.get_history(syms, period="2y", ttl=60) if syms else {}
    snaps = {}
    for s, df in data.items():
        try:
            snaps[s] = snapshot(df)
        except Exception:
            continue
    # Earnings-date alerts need the next report date: fetched only for those symbols (cached for hours).
    earn_syms = sorted({md.normalize(a.symbol) for a in req.alerts if a.type == "earnings_soon"} & set(snaps))
    if earn_syms:
        upcoming = {e["symbol"]: e["days_until"] for e in cal.upcoming_for(earn_syms, within_days=400)}
        for s in earn_syms:
            snaps[s] = {**snaps[s], "days_to_earnings": upcoming.get(s)}
    rows = {}
    for s, snap in snaps.items():
        rows[s] = {k: snap.get(k) for k in WATCH_FIELDS}
        rows[s]["scores"] = {k: evaluate(k, snap)["score"] for k in STRATEGIES}
        rows[s]["spark"] = [round(float(x), 4) for x in data[s]["Close"].tail(30)]
    results = {a.id: alerts.check_alert(a.model_dump() | {"symbol": md.normalize(a.symbol)},
                                        snaps.get(md.normalize(a.symbol)))
               for a in req.alerts}
    return _clean({"rows": rows, "missing": [s for s in syms if s not in snaps], "alerts": results,
                   "status": bot.market_status(), "as_of": datetime.now().isoformat(timespec="seconds")})


@app.get("/api/calendar")
def calendar(days: int = 7, min_cap: float = 10):
    """Market-wide earnings (min_cap in $ billions) and US economic events for the next `days`."""
    days = max(1, min(days, 45))
    out, errors = {"days": days, "min_cap": min_cap}, []
    for key, label, load in (("earnings", "Earnings", lambda: cal.market_earnings(days, min_cap * 1e9)),
                             ("economic", "Economic", lambda: cal.economic_events(days))):
        try:
            out[key] = load()
        except Exception as e:  # Yahoo's calendar endpoints are unofficial; degrade gracefully
            out[key] = []
            errors.append(f"{label} calendar unavailable: {e}")
    out["errors"] = errors
    out["as_of"] = datetime.now().isoformat(timespec="seconds")
    return _clean(out)


class SymbolsRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list, max_length=150)


@app.post("/api/calendar/symbols")
def calendar_symbols(req: SymbolsRequest):
    """Next earnings date for each ticker (e.g. a watchlist)."""
    return _clean({"upcoming": cal.upcoming_for(req.symbols, within_days=120)})


@app.get("/api/ticker/{symbol}/earnings")
def ticker_earnings(symbol: str):
    return _clean(cal.ticker_earnings(symbol))


class Holding(BaseModel):
    symbol: str = Field(max_length=20)
    shares: float
    cost: float | None = None


class PortfolioRequest(BaseModel):
    holdings: list[Holding] = Field(max_length=portfolio.MAX_POSITIONS * 2)
    cash: float = Field(default=0, ge=0)
    period: str = "1y"
    benchmark: str = Field(default="SPY", max_length=20)


@app.post("/api/portfolio/analyze")
def analyze_portfolio(req: PortfolioRequest):
    """Holdings are sent by the browser for this calculation only; nothing is stored server-side."""
    try:
        return _clean(portfolio.analyze([h.model_dump() for h in req.holdings], req.cash, req.period, req.benchmark))
    except ValueError as e:
        raise HTTPException(400, str(e))


class CompareRequest(BaseModel):
    symbols: list[str] = Field(max_length=compare.MAX_SYMBOLS)
    period: str = "1y"
    benchmark: str = Field(default="SPY", max_length=20)


@app.post("/api/compare")
def compare_endpoint(req: CompareRequest):
    try:
        return _clean(compare.compare(req.symbols, req.period, req.benchmark))
    except ValueError as e:
        raise HTTPException(400, str(e))


class BacktestRequest(BaseModel):
    strategy: str
    universe: str
    tickers: str = ""
    period: str = "2y"
    rebalance: str = "monthly"
    top_n: int = Field(default=10, ge=1, le=50)
    cost_bps: float = Field(default=10, ge=0, le=500)
    benchmark: str = "SPY"


@app.post("/api/backtest")
def run_backtest(req: BacktestRequest):
    custom = [t for t in req.tickers.replace(" ", ",").split(",") if t.strip()]
    try:
        return _clean(backtest.run_backtest(req.strategy, req.universe, custom, req.period, req.rebalance,
                                            req.top_n, req.cost_bps, req.benchmark))
    except ValueError as e:
        raise HTTPException(400, str(e))


PERIOD_INTERVAL = {"1d": "5m", "5d": "30m", "1mo": "1d", "3mo": "1d", "6mo": "1d", "1y": "1d", "2y": "1d", "5y": "1wk"}


@app.get("/api/ticker/{symbol}")
def ticker(symbol: str, period: str = "1y"):
    interval = PERIOD_INTERVAL.get(period, "1d")
    df = md.get_one(symbol, period, interval) if interval != "1d" else None
    if interval == "1d":
        # Load 2y+ so the 200-day SMA is available, then trim for display.
        full = md.get_one(symbol, "5y" if period == "2y" else "2y", "1d")
        if full is None:
            raise HTTPException(404, f"No data for {symbol}")
        days = {"1mo": 21, "3mo": 63, "6mo": 126, "1y": 252, "2y": 504}[period]
        df_full, df = full, full.tail(days)
    else:
        if df is None:
            raise HTTPException(404, f"No data for {symbol}")
        df_full = df
    c = df_full["Close"]
    m, ms, mh = macd(c)
    bu, _, bl = bollinger(c)
    ind = pd.DataFrame({
        "sma20": sma(c, 20), "sma50": sma(c, 50), "sma200": sma(c, 200), "rsi": rsi(c),
        "macd": m, "macd_signal": ms, "macd_hist": mh, "bb_upper": bu, "bb_lower": bl,
    }).loc[df.index]
    try:
        analysis = bot.analyze_ticker(symbol)
    except ValueError:
        analysis = None
    return _clean({
        "symbol": md.normalize(symbol), "period": period, "interval": interval,
        "ohlcv": md.to_records(df),
        "indicators": {k: [None if pd.isna(v) else round(float(v), 4) for v in ind[k]] for k in ind.columns},
        "analysis": analysis,
    })


@app.get("/api/ticker/{symbol}/info")
def ticker_info(symbol: str):
    return _clean({"fundamentals": md.get_info(symbol), "news": md.get_news(symbol)})


# ---------------------------------------------------------------- sign-in

def _allowed(provider, request: Request) -> bool:
    """Local-only providers are offered solely to direct requests from this machine."""
    return not provider.LOCAL_ONLY or auth.is_local(request)


def _account(request: Request) -> dict:
    s = auth.get(request)
    available = [{"id": p.ID, "name": p.NAME, "needs_api_key": p.NEEDS_API_KEY}
                 for p in PROVIDERS.values() if _allowed(p, request)]
    out = {"signed_in": s is not None, "providers": available}
    if s:
        p = PROVIDERS[s.provider]
        out.update(provider=s.provider, provider_name=p.NAME, key_hint=s.key_hint,
                   models=[{"id": m, "name": n} for m, n in p.MODELS])
    return out


@app.get("/api/auth/me")
def me(request: Request):
    return _account(request)


class LoginRequest(BaseModel):
    provider: str
    api_key: str | None = Field(default=None, max_length=300)


@app.post("/api/auth/login")
async def login(req: LoginRequest, request: Request, response: Response):
    p = PROVIDERS.get(req.provider)
    if p is None:
        raise HTTPException(400, "Unknown provider")
    if not _allowed(p, request):
        raise HTTPException(403, "That sign-in option is only available on the computer running the app.")
    if p.NEEDS_API_KEY:
        key = (req.api_key or "").strip()
        if not key.startswith("sk-ant-"):
            raise HTTPException(400, "That doesn't look like an Anthropic API key (it should start with sk-ant-).")
        try:
            await p.validate_key(key)
        except anthropic.AuthenticationError:
            raise HTTPException(401, "Anthropic rejected that API key.")
        except anthropic.APIError as e:
            raise HTTPException(502, f"Couldn't verify the key: {e}")
        session = auth.Session(provider=p.ID, api_key=key)
    else:
        err = await p.check_login()
        if err:
            raise HTTPException(401, err)
        session = auth.Session(provider=p.ID)
    auth.destroy(request, response, clear_cookie=False)  # drop any previous session
    auth.create(response, session)
    return {"ok": True}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    auth.destroy(request, response)
    return {"ok": True}


# ---------------------------------------------------------------- chat

class ChatRequest(BaseModel):
    message: str = Field(max_length=20000)
    conversation_id: str | None = None
    model: str | None = None
    effort: str | None = None


@app.post("/api/chat")
async def chat(req: ChatRequest, request: Request):
    session = auth.get(request)
    if session is None:
        raise HTTPException(401, "Sign in to use the Claude analyst.")
    provider = PROVIDERS.get(session.provider)
    if provider is None or not _allowed(provider, request):
        raise HTTPException(403, "That sign-in option isn't available from here.")

    async def stream():
        async for ev in provider.chat(session, req.message, req.conversation_id, req.model, req.effort):
            yield f"data: {json.dumps(ev)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
