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


def collect(name, group, tz_name, offset_hours, state):
    info = mt5.account_info()
    term = mt5.terminal_info()
    if info is None:
        raise RuntimeError(f"account_info failed: {mt5.last_error()}")

    positions = mt5.positions_get() or []
    pos_out = []
    for p in positions:
        pos_out.append({
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
        "equity": info.equity,
        "margin": info.margin,
        "marginLevel": ml,
        "positions": pos_out,
        "closed": closed,
    }
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
