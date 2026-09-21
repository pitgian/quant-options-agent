"""Unit tests for the intraday playbook computation (fetch_options_data).

Synthetic 5m bars spanning 3 sessions (Mon-Wed) — no network. Verifies the
levels a volume desk expects: PDH/PDL, ONH/ONL, RTH open, session VWAP with
sigma bands, prev-day POC/VAH/VAL, naked POCs, PWH/PWL.

Run: .venv/bin/python tests/test_intraday_playbook.py
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from zoneinfo import ZoneInfo

from fetch_options_data import compute_intraday_playbook

ET = ZoneInfo("America/New_York")

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


def build_bars():
    """3 sedute RTH + overnight tra loro, con profili distinguibili.

    Lunedì:   RTH 100±3, volume alto   → PDH/PDL = 103/97 ; POC ~99-100
    Overnight: sale a 106              → ONH = 106, ONL = 103 (min post-RTH)
    Martedì:  RTH 105±2                → PDH di mercoledì = 107 (giorno+2)
    Overnight: scende a 102
    Mercoledì: RTH 104±1, apertura 105
    """
    bars = []
    t0 = datetime(2026, 9, 21, 9, 30, tzinfo=ET)  # lunedì

    def rth_bars(day_offset, center, amplitude, vol, n=12):
        base = t0 + timedelta(days=day_offset)
        for k in range(n):
            price = center + amplitude * ((k % 4) - 1.5) / 1.5
            t = base + timedelta(minutes=5 * k * 4)  # barre 5m every 20min fake spacing
            bars.append((t, price, price + 0.4, price - 0.4, vol))

    def on_bars(day_offset, start_center, prices):
        base = t0 + timedelta(days=day_offset) - timedelta(hours=15, minutes=30)
        # 18:00 ET del giorno -1
        for k, price in enumerate(prices):
            t = base + timedelta(minutes=30 * k)
            bars.append((t, price, price + 0.2, price - 0.2, 50))

    rth_bars(0, 100, 3, 1000)                 # lunedì RTH
    on_bars(1, 101, [103.5, 104.5, 105.5, 106])  # overnight lun→mar (max 106)
    rth_bars(1, 105, 2, 800)                  # martedì RTH (107 high approx)
    on_bars(2, 106, [105, 104, 103, 102])     # overnight mar→mer
    rth_bars(2, 104, 1, 600, n=8)             # mercoledì RTH (in corso)

    bars.sort(key=lambda b: b[0])
    idx_et = [b[0] for b in bars]
    o = [b[1] for b in bars]
    h = [b[2] for b in bars]
    l = [b[3] for b in bars]
    c = [b[1] for b in bars]
    v = [b[4] for b in bars]
    return idx_et, o, h, l, c, v


def main():
    idx_et, o, h, l, c, v = build_bars()
    out = compute_intraday_playbook(idx_et, o, h, l, c, v, futures_ticker="ES")

    print("\n[1] Sessioni e riferimenti principali")
    check("PDH presente", "pdh" in out, str(out.keys()))
    check("PDL presente", "pdl" in out)
    check("ONH presente", "onh" in out)
    check("ONL presente", "onl" in out)
    check("PDH = max martedì (107.4, ultimo giorno completato)", abs(out.get("pdh", 0) - 107.4) < 0.01, out.get("pdh"))
    check("PDL = min martedì (102.6)", abs(out.get("pdl", 0) - 102.6) < 0.01, out.get("pdl"))
    check("ONH = 105.2 (overnight mar 18:00 → mer 09:30)", abs(out.get("onh", 0) - 105.2) < 0.01, out.get("onh"))
    check("ONL = 102 (overnight mer)", abs(out.get("onl", 0) - 101.8) < 0.5, out.get("onl"))
    check("OPEN RTH mercoledì", "open_rth" in out, "")

    print("\n[2] VWAP con bande sigma")
    check("vwap presente", "vwap" in out and "vwap_sigma" in out, "")
    if "vwap" in out:
        vw = out["vwap"]; sig = out["vwap_sigma"]
        check("vwap nella range della seduta", 102 <= vw <= 106, vw)
        check("sigma > 0", sig > 0, sig)
        b = out.get("vwap_bands", {})
        check("bande coerenti", b.get("s1_up", 0) > b.get("s1_dn", 0) > 0 and b.get("s2_up", 0) > b.get("s1_up", 0), b)

    print("\n[3] Profilo giorno precedente (POC/VAH/VAL)")
    p = out.get("prev_day_profile", {})
    check("poc/vah/val presenti", all(k in p for k in ("poc", "vah", "val")), p)
    if p:
        check("VAL <= POC <= VAH", p["val"] <= p["poc"] <= p["vah"], p)

    print("\n[4] Naked POC")
    check("naked_pocs presente", "naked_pocs" in out, "")
    if out.get("naked_pocs"):
        prices = [n["price"] for n in out["naked_pocs"]]
        check("naked nel range dei nodi", all(95 < x < 110 for x in prices), prices)

    print("\n[5] Livelli flat per la UI")
    levels = out.get("levels", [])
    check(">= 8 livelli", len(levels) >= 8, len(levels))
    check("ogni livello ha side coerente", all(
        (x["side"] == "above") == (x["price"] > out["last_price"]) for x in levels if x["side"] != "at"), "")
    labels = {x["label"] for x in levels}
    check("PDH nel set", "PDH" in labels, labels)
    check("una referenza VWAP nel set", bool(labels & {"VWAP", "VWAP+1σ", "VWAP-1σ"}), labels)

    print(f"\n{'=' * 50}\nintraday playbook tests: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
