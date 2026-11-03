#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test della fonte CBOE delayed quotes (fetch_options_data).

Casi verificati:
  1. parse_cboe_option_symbol: root, scadenza, lato, strike (SPX e SPXW)
  2. codici malformati → None (mai crash sul loop)
  3. cboe_expiry_to_iso: YYMMDD → YYYY-MM-DD
  4. fetch_cboe_chains su fixture: gruppo per scadenza/lato, scarti
     (scadenze passate, strike fuori ±10%), colonne compatibili con
     parse_chain_side, spot da current_price
"""
import sys, os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from fetch_options_data import (
    parse_cboe_option_symbol,
    cboe_expiry_to_iso,
    fetch_cboe_chains,
    CBOE_SYMBOL_RE,
)

# --- 1. parser: root, scadenza, lato, strike ---
r = parse_cboe_option_symbol("SPX261120C07535000")
assert r == ("SPX", "261120", "C", 7535.0), f"parser SPX: {r}"
r = parse_cboe_option_symbol("SPXW261106P05000000")
assert r == ("SPXW", "261106", "P", 5000.0), f"parser SPXW: {r}"
r = parse_cboe_option_symbol("NDX270319C10000000")
assert r == ("NDX", "270319", "C", 10000.0), f"parser NDX: {r}"

# --- 2. codici malformati → None ---
for bad in ("", "garbage", "SPX261120X07535000", "SPX261120C075350", "spx261120c07535000"):
    assert parse_cboe_option_symbol(bad) is None, f"malformato accettato: {bad!r}"

# --- 3. scadenza YYMMDD → ISO ---
assert cboe_expiry_to_iso("261106") == "2026-11-06"
assert cboe_expiry_to_iso("270115") == "2027-01-15"

# --- 4. fetch_cboe_chains su fixture (monkeypatch di requests.get) ---
import pandas as pd
import fetch_options_data as fmod

today = datetime.now().isoformat()[:10]
yesterday = (datetime.now() - timedelta(days=1)).strftime("%y%m%d")
tomorrow_yy = (datetime.now() + timedelta(days=1)).strftime("%y%m%d")
next_week_yy = (datetime.now() + timedelta(days=7)).strftime("%y%m%d")

def opt(root, yymmdd, side, strike_dollars, oi=10, gamma=0.001, iv=0.2):
    return {
        "option": f"{root}{yymmdd}{side}{int(strike_dollars * 1000):08d}",
        "bid": 1.0, "ask": 2.0, "iv": iv, "gamma": gamma,
        "open_interest": oi, "volume": 5,
    }

SPOT = 6000.0
fixture = {"data": {
    "current_price": SPOT,
    "timestamp": "2026-11-03 17:02:27",
    "options": [
        opt("SPX", tomorrow_yy, "C", 6000.0, oi=1000),
        opt("SPX", tomorrow_yy, "P", 5950.0, oi=800),
        opt("SPXW", next_week_yy, "P", 5700.0, oi=300),
        # strike fuori ±10% (5400 < 5400) → scartato
        opt("SPX", tomorrow_yy, "P", 5200.0, oi=999),
        opt("SPX", tomorrow_yy, "C", 6800.0, oi=999),  # +13% → scartato
        # scadenza passata → scartata
        opt("SPX", yesterday, "C", 6000.0, oi=500),
        # codice irregolare → scartato senza crash
        {"option": "junk"},
    ],
}}

class FakeResp:
    def raise_for_status(self): pass
    def json(self): return fixture

calls = {"n": 0}
def fake_get(url, headers=None, timeout=None, allow_redirects=None):
    calls["n"] += 1
    assert "cdn.cboe.com" in url and "_SPX" in url
    assert headers and "User-Agent" in headers
    return FakeResp()

fmod.requests.get = fake_get
out = fetch_cboe_chains("SPX")
assert out is not None, "fetch_cboe_chains su fixture è tornato None"
assert calls["n"] == 1 and out["spot"] == SPOT and out["timestamp"] == "2026-11-03 17:02:27"

chains = out["chains"]
assert len(chains) == 2, f"scadenze: {list(chains)}"
assert tomorrow_yy and cboe_expiry_to_iso(tomorrow_yy) in chains

exp_t = chains[cboe_expiry_to_iso(tomorrow_yy)]
assert isinstance(exp_t["calls"], pd.DataFrame) and isinstance(exp_t["puts"], pd.DataFrame)
# strike fuori finestra scartati, giusti dentro
assert len(exp_t["calls"]) == 1 and len(exp_t["puts"]) == 1
c0 = exp_t["calls"].iloc[0]
assert float(c0["strike"]) == 6000.0 and int(c0["openInterest"]) == 1000
assert float(c0["gamma"]) == 0.001 and float(c0["impliedVolatility"]) == 0.2
# colonne che parse_chain_side legge
for col in ("strike", "openInterest", "volume", "impliedVolatility", "bid", "ask", "gamma"):
    assert col in exp_t["calls"].columns, f"colonna mancante: {col}"
# scadenza passata assente
assert cboe_expiry_to_iso(yesterday) not in chains
# spot fuori dal JSON → ripiega su spot_hint
fixture["data"]["current_price"] = 0
out2 = fetch_cboe_chains("SPX", spot_hint=5900.0)
assert out2 is not None and out2["spot"] == 5900.0
# catena vuota → None
fixture["data"]["options"] = []
assert fetch_cboe_chains("SPX") is None

print("test_cboe_fetch: 4 check OK")
