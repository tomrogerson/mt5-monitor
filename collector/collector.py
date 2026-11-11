"""Reads ONE running MT5 terminal and pushes its numbers to the dashboard.

Read-only: this script never sends orders. Run via run_all.py, which starts
one copy of this per terminal listed in config.json.

Usage (normally started by run_all.py):
    python collector.py --name "Gold 01" --path "C:\\MT5Monitor\\Terminals\\Gold01\\terminal64.exe"
"""
import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import MetaTrader5 as mt5

try:
    from zoneinfo import ZoneInfo
except ImportError:  # very old Python
    ZoneInfo = None


def log(name, msg):
    print(f"{datetime.now().strftime('%H:%M:%S')} [{name}] {msg}", flush=True)


def start_of_today_utc(tz_name):
    """Start of today in tz_name, as an aware UTC datetime."""
    if ZoneInfo is not None:
        try:
            tz = ZoneInfo(tz_name)
            now = datetime.now(tz)
            return now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
        except Exception:
            pass
    now = datetime.now().astimezone()
    return now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)


def detect_server_offset(symbols):
    """Seconds the broker's clock is ahead of UTC (MT5 reports server time as if it were UTC).
    Uses a fresh tick; returns None if the market is closed or nothing is available."""
    for sym in symbols:
        tick = mt5.symbol_info_tick(sym)
        if tick and tick.time and abs(time.time() - tick.time) < 3 * 3600 + 120:
            return int(round((tick.time - time.time()) / 1800.0)) * 1800
    return None


def period_starts_utc(tz_name):
    """(start of this week [Monday], start of this month) in tz_name, as aware UTC datetimes."""
    try:
        now = datetime.now(ZoneInfo(tz_name)) if ZoneInfo is not None else datetime.now().astimezone()
    except Exception:
        now = datetime.now().astimezone()
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week = day - timedelta(days=day.weekday())
    month = day.replace(day=1)
    return week.astimezone(timezone.utc), month.astimezone(timezone.utc)


def long_pnl(tz_name, offset):
    """Closed-trade P&L for last calendar month, the last 90 days and this year (from 1 Jan), same method as period_pnl."""
    try:
        now = datetime.now(ZoneInfo(tz_name)) if ZoneInfo is not None else datetime.now().astimezone()
    except Exception:
        now = datetime.now().astimezone()
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month = day.replace(day=1)
    last_month = (month - timedelta(days=1)).replace(day=1)
    year = day.replace(month=1, day=1)
    lm_s = int(last_month.timestamp()) + offset
    mo_s = int(month.timestamp()) + offset
    yr_s = int(year.timestamp()) + offset
    d90_s = int(time.time()) + offset - 90 * 86400
    frm = datetime.fromtimestamp(min(lm_s, yr_s, d90_s) - 86400, tz=timezone.utc)
    to = datetime.fromtimestamp(time.time() + offset + 86400, tz=timezone.utc)
    groups = {}
    for d in (mt5.history_deals_get(frm, to) or []):
        if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
            continue
        g = groups.setdefault(d.position_id, {"pnl": 0.0, "t": 0, "closed": False})
        g["pnl"] += d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
        if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY, mt5.DEAL_ENTRY_INOUT):
            g["closed"] = True
            g["t"] = max(g["t"], d.time)
    lm = d90 = ytd = 0.0
    for g in groups.values():
        if not g["closed"]:
            continue
        if lm_s <= g["t"] < mo_s:
            lm += g["pnl"]
        if g["t"] >= d90_s:
            d90 += g["pnl"]
        if g["t"] >= yr_s:
            ytd += g["pnl"]
    return lm, d90, ytd


HISTORY_FROM = "2025-04"   # config.json "history_from" overrides; the first month to report closed P&L for


def monthly_history(tz_name, offset, start_ym):
    """Closed-trade P&L for every completed calendar month from start_ym, and the deposits and withdrawals, from the terminal's deal history.
    Months before the account's first deal are left out. Returns ({"YYYY-MM": pnl}, deposits, withdrawals), the last two as [["YYYY-MM-DD", amount], ...]."""
    try:
        tz = ZoneInfo(tz_name) if ZoneInfo is not None else datetime.now().astimezone().tzinfo
    except Exception:
        tz = datetime.now().astimezone().tzinfo
    now = datetime.now(tz)
    y0, m0 = (int(x) for x in start_ym.split("-"))
    bounds, y, m = [], y0, m0
    while (y, m) < (now.year, now.month):
        bounds.append((f"{y:04d}-{m:02d}", int(datetime(y, m, 1, tzinfo=tz).timestamp()) + offset))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    if not bounds:
        return {}, [], []
    end_s = int(datetime(now.year, now.month, 1, tzinfo=tz).timestamp()) + offset
    frm = datetime.fromtimestamp(bounds[0][1] - 90 * 86400, tz=timezone.utc)
    to = datetime.fromtimestamp(time.time() + offset + 86400, tz=timezone.utc)
    groups, deposits, withdrawals, first = {}, [], [], None
    for d in (mt5.history_deals_get(frm, to) or []):
        if d.type == getattr(mt5, "DEAL_TYPE_BALANCE", -1):
            day = datetime.fromtimestamp(d.time - offset, tz=timezone.utc).strftime("%Y-%m-%d")
            if d.profit > 0:
                deposits.append([day, round(d.profit, 2)])
            elif d.profit < 0:
                withdrawals.append([day, round(-d.profit, 2)])
            continue
        if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
            continue
        if first is None or d.time < first:
            first = d.time
        g = groups.setdefault(d.position_id, {"pnl": 0.0, "t": 0, "closed": False})
        g["pnl"] += d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
        if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY, mt5.DEAL_ENTRY_INOUT):
            g["closed"] = True
            g["t"] = max(g["t"], d.time)
    out = {k: 0.0 for k, s in bounds if first is not None and s + 31 * 86400 > first}
    for g in groups.values():
        if not g["closed"] or g["t"] >= end_s:
            continue
        key = None
        for k, s in bounds:
            if g["t"] >= s:
                key = k
        if key in out:
            out[key] += g["pnl"]
    return {k: round(v, 2) for k, v in out.items()}, deposits[-100:], withdrawals[-100:]


def period_pnl(tz_name, offset):
    """Closed-trade P&L (profit + commission + swap + fee) for this week and this month."""
    week, month = period_starts_utc(tz_name)
    wk_s = int(week.timestamp()) + offset
    mo_s = int(month.timestamp()) + offset
    td_s = int(start_of_today_utc(tz_name).timestamp()) + offset
    yd_s = td_s - 86400   # start of yesterday (a day is 24h except across clock changes, which a closed-trade total can ignore)
    frm = datetime.fromtimestamp(min(wk_s, mo_s, yd_s) - 86400, tz=timezone.utc)
    to = datetime.fromtimestamp(time.time() + offset + 86400, tz=timezone.utc)
    deals = mt5.history_deals_get(frm, to) or []
    groups = {}
    for d in deals:
        if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
            continue
        g = groups.setdefault(d.position_id, {"pnl": 0.0, "t": 0, "closed": False})
        g["pnl"] += d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
        if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY, mt5.DEAL_ENTRY_INOUT):
            g["closed"] = True
            g["t"] = max(g["t"], d.time)
    w = m = y = 0.0
    for g in groups.values():
        if not g["closed"]:
            continue
        if g["t"] >= wk_s:
            w += g["pnl"]
        if g["t"] >= mo_s:
            m += g["pnl"]
        if yd_s <= g["t"] < td_s:
            y += g["pnl"]
    return w, m, y


def balance_flows(offset):
    """Deposits, withdrawals and bonus credits of the last year as [time_ms, amount] (not trading results)."""
    frm = datetime.fromtimestamp(time.time() + offset - 370 * 86400, tz=timezone.utc)
    to = datetime.fromtimestamp(time.time() + offset + 86400, tz=timezone.utc)
    kinds = [getattr(mt5, k) for k in ("DEAL_TYPE_BALANCE", "DEAL_TYPE_CREDIT") if hasattr(mt5, k)]
    out = []
    for d in (mt5.history_deals_get(frm, to) or []):
        if d.type in kinds and d.profit != 0:
            out.append([int((d.time - offset) * 1000), d.profit])
    return out[-300:]


def collect(name, group, tz_name, offset_hours, state):
    info = mt5.account_info()
    term = mt5.terminal_info()
    if info is None:
        raise RuntimeError(f"account_info failed: {mt5.last_error()}")

    positions = mt5.positions_get() or []
    pos_out = []
    def at_price(p, price):
        # profit this position would show if closed at `price` (account currency), swap included; None if MT5 can't work it out
        if not price:
            return None
        act = mt5.ORDER_TYPE_BUY if p.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_SELL
        try:
            v = mt5.order_calc_profit(act, p.symbol, p.volume, p.price_open, price)
        except Exception:
            v = None
        return None if v is None else round(v + p.swap, 2)

    for p in positions:
        pos_out.append({
            "sl": p.sl or 0, "tp": p.tp or 0,
            "slPnl": at_price(p, p.sl), "tpPnl": at_price(p, p.tp),
            "ticket": str(p.ticket),
            "symbol": p.symbol,
            "dir": 1 if p.type == mt5.POSITION_TYPE_BUY else -1,
            "lots": p.volume,
            "open": p.price_open,
            "cur": p.price_current,
            "pnl": p.profit + p.swap,
        })

    # Server-time offset: config override wins, otherwise detect from a live tick.
    if offset_hours is not None:
        state["offset"] = int(offset_hours * 3600)
    else:
        det = detect_server_offset([p.symbol for p in positions] + ["XAUUSD", "EURUSD", "USDJPY", "GBPUSD"])
        if det is not None:
            state["offset"] = det
    offset = state.get("offset", 0)

    day_start = start_of_today_utc(tz_name)
    day_start_server = int(day_start.timestamp()) + offset
    # MT5 wants naive datetimes it treats as server time; pad generously, filter exactly below.
    frm = datetime.fromtimestamp(day_start_server - 86400, tz=timezone.utc)
    to = datetime.fromtimestamp(time.time() + offset + 86400, tz=timezone.utc)
    deals = mt5.history_deals_get(frm, to) or []

    groups = {}
    for d in deals:
        if d.time < day_start_server:
            continue
        if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
            continue  # balance, credit, charges etc.
        g = groups.setdefault(d.position_id, {"pnl": 0.0, "lots": 0.0, "t": 0, "dir": 1, "closed": False, "symbol": d.symbol})
        g["pnl"] += d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
        if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY, mt5.DEAL_ENTRY_INOUT):
            g["closed"] = True
            g["lots"] += d.volume
            g["t"] = max(g["t"], d.time)
            g["dir"] = 1 if d.type == mt5.DEAL_TYPE_SELL else -1  # a SELL closes a BUY position
            g["symbol"] = d.symbol
    closed = [{
        "t": int((g["t"] - offset) * 1000),
        "symbol": g["symbol"], "dir": g["dir"], "lots": g["lots"], "pnl": g["pnl"],
    } for g in groups.values() if g["closed"]]

    # Week / month totals need a long history query, so refresh them once a minute only.
    if time.time() - state.get("per_at", 0) > 60:
        try:
            state["per"] = period_pnl(tz_name, offset)
            state["per_at"] = time.time()
        except Exception as e:
            log(name, f"week/month totals failed: {e}")
            state["per_at"] = time.time() - 50  # retry in ~10 s
    per = state.get("per")

    # Last month / 90 days / this year need a long history query: refresh every 10 minutes only.
    if time.time() - state.get("lng_at", 0) > 600:
        try:
            state["lng"] = long_pnl(tz_name, offset)
            state["lng_at"] = time.time()
        except Exception as e:
            log(name, f"month/90-day/year totals failed: {e}")
            state["lng_at"] = time.time() - 570  # retry in ~30 s
    lng = state.get("lng")

    # Deposits / withdrawals change rarely: read them every 5 minutes and send them only then.
    flows = None
    if time.time() - state.get("fl_at", 0) > 300:
        try:
            flows = balance_flows(offset)
            state["fl_at"] = time.time()
        except Exception as e:
            log(name, f"deposit/withdrawal history failed: {e}")
            state["fl_at"] = time.time() - 270  # retry in ~30 s

    # Full monthly history (for the Commission tab) is heavy and rarely changes: read it every 6 hours and send it only then.
    hist = None
    if time.time() - state.get("hist_at", 0) > 6 * 3600:
        try:
            hist = monthly_history(tz_name, offset, HISTORY_FROM)
            state["hist_at"] = time.time()
        except Exception as e:
            log(name, f"monthly history failed: {e}")
            state["hist_at"] = time.time() - 6 * 3600 + 120  # retry in ~2 min

    ml = info.margin_level if info.margin and info.margin > 0 else None
    payload = {
        "id": f"{info.server}:{info.login}",
        "name": name,
        "server": info.server,
        "login": str(info.login),
        "currency": info.currency,
        "connected": bool(term.connected) if term else True,
        "demo": info.trade_mode in (mt5.ACCOUNT_TRADE_MODE_DEMO, mt5.ACCOUNT_TRADE_MODE_CONTEST),
        "balance": info.balance,
        "credit": info.credit,
        "equity": info.equity,
        "margin": info.margin,
        "marginLevel": ml,
        "positions": pos_out,
        "closed": closed,
    }
    if per:
        payload["pnlWeek"], payload["pnlMonth"] = per[0], per[1]
        if len(per) > 2:
            payload["pnlYesterday"] = per[2]
    if flows is not None:
        payload["flows"] = flows
    if lng:
        payload["pnlLastMonth"], payload["pnl90"], payload["pnlYear"] = lng
    if hist is not None:
        payload["monthly"], payload["deposits"], payload["withdrawals"] = hist
    if group:
        payload["group"] = group
    return payload


def post(url, token, payload):
    req = urllib.request.Request(
        url.rstrip("/") + "/api/ingest",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--name", required=True)
    ap.add_argument("--path", required=True)
    ap.add_argument("--group", default="")
    ap.add_argument("--dry-run", action="store_true", help="print the data instead of sending it")
    a = ap.parse_args()

    with open(a.config, encoding="utf-8") as f:
        cfg = json.load(f)
    url, token = cfg["server_url"], cfg["token"]
    interval = max(1.0, float(cfg.get("interval_seconds", 2)))
    tz_name = cfg.get("timezone", "Europe/London")
    global HISTORY_FROM
    HISTORY_FROM = str(cfg.get("history_from", HISTORY_FROM))
    offset_hours = None
    for t in cfg.get("terminals", []):
        if t.get("name") == a.name and t.get("server_utc_offset_hours") is not None:
            offset_hours = float(t["server_utc_offset_hours"])

    state = {}
    connected = False
    fails = 0
    while True:
        try:
            if not connected:
                if not mt5.initialize(path=a.path):
                    raise RuntimeError(f"cannot attach to terminal: {mt5.last_error()}")
                connected = True
                log(a.name, "attached to terminal")
            payload = collect(a.name, a.group, tz_name, offset_hours, state)
            if a.dry_run:
                print(json.dumps(payload, indent=2))
                mt5.shutdown()
                return
            post(url, token, payload)
            if fails:
                log(a.name, "recovered")
            fails = 0
            time.sleep(interval)
        except Exception as e:  # keep running, back off a little
            fails += 1
            if fails == 1 or fails % 30 == 0:
                log(a.name, f"problem: {e}")
            if "terminal" in str(e) or "account_info" in str(e):
                try:
                    mt5.shutdown()
                except Exception:
                    pass
                connected = False
            if a.dry_run:
                sys.exit(1)
            time.sleep(min(30, 2 + fails))


if __name__ == "__main__":
    main()
