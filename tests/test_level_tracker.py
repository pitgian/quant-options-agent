"""Unit tests for level_tracker — snapshot dedup + bounce/break scoring.

Synthetic bars only, no network. Run:
    .venv/bin/python tests/test_level_tracker.py
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import level_tracker as lt

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name} — {detail}")


def make_snapshot(spot=100.0):
    """Minimal options snapshot: 2 expiries, puts below / calls above spot."""
    now = datetime.now(timezone.utc)
    opts = []
    for k, strike in enumerate([97, 98, 99]):
        opts.append({"strike": float(strike), "side": "PUT", "oi": 500 - k * 100, "vol": 200, "gamma": 0.001})
    for k, strike in enumerate([101, 102, 103]):
        opts.append({"strike": float(strike), "side": "CALL", "oi": 500 - k * 100, "vol": 200, "gamma": 0.001})
    return {
        "generated": now.isoformat(),
        "symbols": {
            "SPY": {
                "spot": spot,
                "expiries": [
                    {"date": (now + timedelta(days=1)).date().isoformat(), "options": opts},
                    {"date": (now + timedelta(days=10)).date().isoformat(), "options": opts},
                ],
            }
        },
    }


# ---------------------------------------------------------------------------
print("\n[1] compute_levels: own-side, spacing, top-N")
snap = make_snapshot()
levels = lt.compute_levels(snap, "SPY")
sup = [l["strike"] for l in levels if l["type"] == "support"]
res = [l["strike"] for l in levels if l["type"] == "resistance"]
check("solo livelli own-side", all(s < 100 for s in sup) and all(s > 100 for s in res), f"{sup} {res}")
check("max 5 per lato", len(sup) <= 5 and len(res) <= 5, f"{len(sup)}/{len(res)}")
gaps = [abs(sup[i] - sup[i + 1]) for i in range(len(sup) - 1)]
check("spaziatura 0.4%", all(g >= 100 * 0.004 - 1e-9 for g in gaps), f"{gaps}")

# ---------------------------------------------------------------------------
print("\n[2] annotate_gamma_sign: pin/trigger dal segno netGEX")
lt.annotate_gamma_sign(levels, snap, "SPY")
by = {l["strike"]: l for l in levels}
# PUT-dominated strikes below spot → netGEX negativo → trigger
check("put wall → trigger", all(by[s]["gamma_sign"] == "trigger" for s in sup), "")
# CALL-dominated strikes above spot → netGEX positivo → pin
check("call wall → pin", all(by[s]["gamma_sign"] == "pin" for s in res), "")
check("net_gex popolato", all(by[s]["net_gex"] is not None for s in sup + res), "")

# ---------------------------------------------------------------------------
print("\n[3] snapshot dedup: stesso giorno = un record")
with tempfile.TemporaryDirectory() as td:
    hpath = os.path.join(td, "hist.json")
    opath = os.path.join(td, "opt.json")
    json.dump(snap, open(opath, "w"))
    old_opts = lt.OPTIONS_PATH
    old_hist = lt.HISTORY_PATH
    lt.OPTIONS_PATH = opath
    lt.HISTORY_PATH = hpath
    try:
        t0 = datetime(2026, 9, 18, 15, 0, tzinfo=timezone.utc)
        n1 = lt.snapshot_levels(t0)
        n2 = lt.snapshot_levels(t0 + timedelta(minutes=15))
        hist = json.load(open(hpath))
        check("primo run inserisce", n1 > 0, f"{n1}")
        check("secondo run dedup", n2 == 0, f"{n2}")
        check("un record per livello/giorno", len(hist) == n1, f"{len(hist)} vs {n1}")

        # -------------------------------------------------------------------
        print("\n[4] scoring: bounce / break / untouched su barre sintetiche")
        recs = {r["strike"]: r for r in hist}
        # strike con OI max nei put = 97 (support). Costruisci barre:
        # - una seduta: prezzo tocca 97 (banda) e poi sale +0.3% → BOUNCE
        # - un'altra seduta: prezzo rompe 97-0.2% → BREAK (ma 1 touch/sessione
        #   e risoluzione al primo tocco: il primo giorno determina l'esito)
        def bars(session_hours_paths):
            """session_hours_paths: [(ore_da_t0, path)] — barre 5m ogni path."""
            utcs, highs, lows = [], [], []
            for h_off, path in session_hours_paths:
                base = t0 + timedelta(hours=h_off)
                for k, price in enumerate(path):
                    t = base + timedelta(minutes=5 * k)
                    utcs.append(t)
                    highs.append(price + 0.05)
                    lows.append(price - 0.05)
            return utcs, highs, lows

        rec = recs[97.0]
        spot = rec["spot_at_issue"]
        brk = 97 * 0.0015 + 0.015  # buffer rottura
        rej = 97 * 0.002 + 0.02    # soglia rimbalzo

        # ore+22 (dentro la finestra 24h): tocca 97 e rimbalza sopra soglia
        path_bounce = [spot, spot - 1, 97.2, 97.05, 97 + rej + 0.1, 97 + rej + 0.2]
        # ore+26 (FUORI finestra): rotture lì non devono contare
        path_break = [spot - 0.5, 97.3, 97 - brk - 0.1, 96.5]
        utcs, highs, lows = bars([(22, path_bounce), (26, path_break)])

        res = lt._score_one(rec, t0, t0 + timedelta(hours=24), utcs, highs, lows)
        check("scored", res == "scored", res)
        check("touched", rec["touched"] is True, "")
        # il primo touch (giorno+1) risolve bounce: prezzo sale sopra rej senza rompere
        check("esito bounce", rec["outcome"] == "bounce", rec["outcome"])
        check("1 touch per sessione", rec["n_touch_sessions"] == 1, rec["n_touch_sessions"])

        # -------------------------------------------------------------------
        print("\n[5] report: aggregazione e verdetto")
        # forziamo più record per costruire un verdetto
        hist2 = []
        for k in range(30):
            hist2.append(dict(rec, issued_at=(t0 - timedelta(days=k)).isoformat(),
                              outcome="bounce" if k % 5 else "break",   # 24 vs 6
                              touched=True, scored_at=t0.isoformat()))
        lt.HISTORY_PATH = os.path.join(td, "hist2.json")
        json.dump(hist2, open(lt.HISTORY_PATH, "w"))
        rep = lt.build_report(t0)
        key = list(rep["kinds"].keys())[0]
        g = rep["kinds"][key]
        check("n_touched aggregato", g["n_touched"] == 30, g["n_touched"])
        check("verdict assegnato", g["verdict"] == "BOUNCE_EDGE", g["verdict"])
        check("rate coerente", abs(g["bounce_rate"] - 0.8) < 0.01, g["bounce_rate"])
    finally:
        lt.OPTIONS_PATH = old_opts
        lt.HISTORY_PATH = old_hist

print(f"\n{'=' * 50}\nlevel_tracker tests: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
