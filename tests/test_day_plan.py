#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test del track record di day_plan.py (score_plan_against + update_stats).

Casi verificati:
  1. le barre ANTERIORI alla data del piano non contano come touch
  2. touch + rifiuto  → held=True
  3. touch + chiusura oltre → held=False
  4. update_stats con prefisso strumento: chiavi "ES:PDH" e accumulo n
"""
import sys, os
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from day_plan import score_plan_against, update_stats

ET = timezone(timedelta(hours=-4))
D0 = datetime(2026, 10, 4, 12, 0, tzinfo=ET)   # prima del piano → da ignorare
D1 = datetime(2026, 10, 5, 10, 0, tzinfo=ET)   # giorno del piano
PLAN = {"generated_at": "2026-10-05T08:00:00+00:00",
        "levels": [{"name": "PDH", "nome_it": "Max di ieri", "price": 6000.0}]}

def bars(times_hl):
    idx = [t for t, _, _ in times_hl]
    highs = [h for _, h, _ in times_hl]
    lows = [l for _, _, l in times_hl]
    closes = [(h + l) / 2 for _, h, l in times_hl]
    return idx, highs, lows, closes

def take3(v):
    a, b, c = v
    return a, b, c

# --- 1. touch solo PRIMA della pubblicazione → non conta ---
idx, h, l, c = bars([
    (D0, 6005, 5995),   # barra che toccherebbe il livello, ma è del 4/10
    (D1, 6100, 6090),   # il 5/10 il prezzo è altrove
])
r = score_plan_against(PLAN, idx, h, l, c)
assert len(r) == 1 and not r[0]["touched"], "barra pre-piano contata come touch!"

# --- 2. touch da sotto + rifiuto (non chiude sopra 6004) → held ---
idx, h, l, c = bars([
    (D1, 5990, 5985),
    (D1 + timedelta(minutes=5), 6002, 5996),   # touch (banda ±3)
    (D1 + timedelta(minutes=10), 6001, 5995),  # rifiuto: non supera 6004
    (D1 + timedelta(minutes=15), 5990, 5992),  # si allontana
])
r = score_plan_against(PLAN, idx, h, l, c)
assert r[0]["touched"] and r[0]["held"], "touch+rifiuto dovrebbe dare held=True"

# --- 3. touch + chiusura oltre (supera 6004 senza mai ≤5994) → violato ---
idx, h, l, c = bars([
    (D1, 6002, 5996),   # touch da sotto
    (D1 + timedelta(minutes=5), 6010, 6005),   # rompe e chiude sopra
    (D1 + timedelta(minutes=10), 6015, 6008),
])
r = score_plan_against(PLAN, idx, h, l, c)
assert r[0]["touched"] and not r[0]["held"], "rottura sopra non segnalata"

# --- 4. update_stats: chiave con prefisso e accumulo su due giornate ---
stats = {}
idx, h, l, c = bars([
    (D1, 6002, 5996), (D1 + timedelta(minutes=5), 6001, 5995),
])
update_stats(PLAN, idx, h, l, c, stats, prefix="ES")
PLAN2 = {**PLAN, "generated_at": "2026-10-06T08:00:00+00:00"}
idx, h, l, c = bars([
    (D1 + timedelta(days=1), 6003, 5997), (D1 + timedelta(days=1, minutes=5), 6000, 5990),
])
update_stats(PLAN2, idx, h, l, c, stats, prefix="ES")
assert "ES:PDH" in stats, f"chiave con prefisso mancante: {list(stats)}"
assert stats["ES:PDH"]["n"] == 2 and stats["ES:PDH"]["held"] == 2
assert stats["ES:PDH"]["name"] == "ES:PDH"
# nessuna contaminazione tra strumenti
update_stats(PLAN, [D1], [6002], [5996], [5999], stats, prefix="NQ")
assert stats["NQ:PDH"]["n"] == 1 and stats["ES:PDH"]["n"] == 2

# --- 5. only_date: giudica SOLO le barre della giornata richiesta ---
idx, h, l, c = bars([
    (D1, 6002, 5996),                                          # touch il 05/10
    (D1 + timedelta(days=1), 6002, 5996),                      # touch il 06/10
])
r = score_plan_against(PLAN, idx, h, l, only_date=(D1 + timedelta(days=1)).date())
assert r[0]["touched"], "il touch del 06/10 deve essere visto da only_date"
r = score_plan_against(PLAN, idx, h, l, only_date=(D1 + timedelta(days=2)).date())
assert r == [], "giorno senza barre non deve dare verdetti"

# --- 6. trigger: successo = rottura CON follow-through; stallo = fallimento ---
PLAN_T = {"generated_at": "2026-10-05T08:00:00+00:00",
          "levels": [{"name": "TRIGGER", "nome_it": "Trigger call", "price": 6000.0, "kind": "trigger"}]}
idx, h, l, c = bars([
    (D1, 6002, 5996),                            # tocco da sotto
    (D1 + timedelta(minutes=5), 6002, 5997),     # stallo: mai oltre 6004
    (D1 + timedelta(minutes=10), 6001, 5995),
])
r = score_plan_against(PLAN_T, idx, h, l, c)
assert r[0]["touched"] and not r[0]["held"], "trigger in stallo non deve contare come successo"
idx, h, l, c = bars([
    (D1, 6002, 5996),                            # tocco da sotto
    (D1 + timedelta(minutes=5), 6012, 6005),     # rottura con follow-through ≥6006
])
r = score_plan_against(PLAN_T, idx, h, l, c)
assert r[0]["held"], "rottura con follow-through deve essere un successo"

# --- 7. magnet: successo = convergenza a fine finestra ---
PLAN_M = {"generated_at": "2026-10-05T08:00:00+00:00",
          "levels": [{"name": "MAXPAIN", "nome_it": "Max Pain", "price": 6000.0, "kind": "magnet"}]}
idx, h, l, c = bars([
    (D1, 6015, 6005),                                # tocco
    (D1 + timedelta(minutes=5), 6003, 5997),         # convergenza: chiude ~6000
])
r = score_plan_against(PLAN_M, idx, h, l, c)
assert r[0]["held"], "chiusura sul livello = convergenza riuscita"
idx, h, l, c = bars([
    (D1, 6015, 6005),                                # tocco
    (D1 + timedelta(minutes=5), 6020, 6010),         # fugge: chiude ~6015
])
r = score_plan_against(PLAN_M, idx, h, l, c)
assert not r[0]["held"], "prezzo fuggito = convergenza fallita"

# --- 8. dedupe_levels: i livelli INDICE non vengono soppressi dai muri ETF ---
from day_plan import dedupe_levels

def mk(name, price, **kw):
    return {"name": name, "nome_it": name, "price": price, "source": "options", **kw}

lvls = [
    mk("PDH", 6005.0, source="price"),        # livello prezzo
    mk("PIN", 6000.0, chain="etf"),           # muro ETF
    mk("PIN-IDX", 6001.0, chain="index"),     # 1 pt dal PIN ETF → DEVE restare
    mk("PIN-IDX", 6002.5, chain="index"),     # 1,5 pt da altro indice → assorbito
    mk("PIN-IDX", 6006.0, chain="index"),     # 1 pt dal PDH prezzo → assorbito
    mk("TRIGGER-IDX", 6010.0, chain="index"), # libero → DEVE restare
]
out = dedupe_levels(lvls)
got = sorted(l["price"] for l in out)
assert got == [6000.0, 6001.0, 6005.0, 6010.0], f"dedup multi-fonte errata: {got}"
idx_kept = [l for l in out if l.get("chain") == "index"]
assert {6001.0, 6010.0} <= {l["price"] for l in idx_kept}, "livello indice soppresso da muro ETF"

# --- 9. top_gamma_by_bucket: le borse 0dte/week/all partizionano per scadenza ---
from day_plan import top_gamma_by_bucket
from datetime import date, timedelta as _td

SPOT_B = 6000.0
today_b = date.today()
def exp_b(offset_days, strike, side, oi, gamma):
    d = (today_b + _td(days=offset_days)).isoformat()
    return {"date": d, "options": [{"strike": strike, "side": side, "oi": oi, "gamma": gamma}]}
# strike 6000: solo 0DTE · strike 6050: +3 giorni (week) · strike 6500: +30 giorni (solo all)
expiries_b = [
    exp_b(0, 6000.0, "CALL", 100, 0.01),
    exp_b(3, 6050.0, "CALL", 100, 0.005),
    exp_b(30, 6500.0, "CALL", 5000, 0.0002),
]
# la funzione restituisce (profili, flip per borsa, regime per borsa, bande)
buckets, flips, regimes, bands = top_gamma_by_bucket(expiries_b, SPOT_B, "TEST")
assert [t["strike"] for t in buckets["0dte"]] == [6000.0], f"0dte: {buckets['0dte']}"
assert sorted(t["strike"] for t in buckets["week"]) == [6000.0, 6050.0], f"week: {buckets['week']}"
assert sorted(t["strike"] for t in buckets["all"]) == [6000.0, 6050.0, 6500.0], f"all: {buckets['all']}"
# scadenza passata: ignorata ovunque
past = exp_b(-2, 6100.0, "CALL", 999, 0.01)
buckets2, flips2, regimes2, bands2 = top_gamma_by_bucket([past], SPOT_B, "TEST")
assert buckets2["all"] == [] and buckets2["week"] == [], "scadenza passata non scartata"
assert bands2 == {"0dte": None, "week": None, "all": None}, f"bande su libro vuoto: {bands2}"
# scadenza passata NON deve entrare nemmeno negli aggregati "strutturali"
from day_plan import relevant_expiries
assert relevant_expiries([past], SPOT_B) == [], "la scadenza passata passa relevant_expiries"
# lato dominante: call 100 vs put 60 → side call
mixed = exp_b(0, 6000.0, "PUT", 60, 0.01)
buckets3, flips3, regimes3, bands3 = top_gamma_by_bucket(
    [exp_b(0, 6000.0, "CALL", 100, 0.01), mixed], SPOT_B, "TEST")
assert buckets3["0dte"][0]["side"] == "call" and buckets3["0dte"][0]["sign"] == "long"

# --- 10. FLIP dalla CURVA di esposizione: regime e flip sono la STESSA funzione
# (16/11). Prima il flip era lo zero-crossing della somma per strike — un dente
# di sega (73 tagli su NDX entro ±10%) — e capitava il "prezzo sopra il flip"
# con regime short che l'utente ha visto sull'app. Ora la curva rivaluta la
# gamma di ogni contratto a OGNI prezzo: un taglio solo, e "sotto = short,
# sopra = long" è vero per costruzione.
from day_plan import gamma_flip, gamma_exposure_curve
import numpy as np

def book(pairs):
    """pairs = [(offset_days, strike, side, oi), ...] → expiries nel formato del feed."""
    by_day = {}
    for off, K, side, oi in pairs:
        d = (today_b + _td(days=off)).isoformat()
        by_day.setdefault(d, []).append(
            {"strike": K, "side": side, "oi": oi, "iv": 0.20})
    return [{"date": d, "options": o} for d, o in by_day.items()]

# libro PUT-heavy: i dealer sono corti di gamma finché il prezzo resta sotto
puts_heavy = book([(25, 5800.0, "PUT", 12000), (25, 5900.0, "PUT", 12000),
                   (25, 6100.0, "CALL", 6000), (25, 6200.0, "CALL", 6000)])
bd = gamma_flip(puts_heavy, SPOT_B, "TEST")
assert bd["regime"] == "short", f"libro put-heavy deve essere short: {bd}"
assert bd["crossings"] == 1, f"un taglio solo atteso: {bd}"
assert bd["flip"] and bd["flip"] > SPOT_B and bd["flip_above"] == bd["flip"], \
    f"flip di un libro short deve stare SOPRA il prezzo: {bd}"
# libro CALL-heavy: specularmente long, col confine SOTTO il prezzo
calls_heavy = book([(25, 5800.0, "PUT", 6000), (25, 5900.0, "PUT", 6000),
                    (25, 6100.0, "CALL", 12000), (25, 6200.0, "CALL", 12000)])
bd2 = gamma_flip(calls_heavy, SPOT_B, "TEST")
assert bd2["regime"] == "long" and bd2["flip"] < SPOT_B and bd2["flip_below"] == bd2["flip"], \
    f"libro call-heavy: {bd2}"
# INVARIANTE del badge: con UN taglio, regime long ⟺ prezzo sopra il flip.
# È la clausola che il sito e NT8 stanno leggendo a voce.
for b in (bd, bd2):
    assert (b["regime"] == "long") == (b["flip"] < SPOT_B), f"invariante rotta: {b}"
# e il regime è davvero il segno della curva allo spot, non un calcolo parallelo
for bk, b in ((puts_heavy, bd), (calls_heavy, bd2)):
    P, G = gamma_exposure_curve(bk, SPOT_B, "TEST")
    assert (("long" if float(np.interp(SPOT_B, P, G)) > 0 else "short") == b["regime"]
            and ("long" if float(np.interp(b["flip"] * 1.0002, P, G)) > 0 else "short")
            != ("long" if float(np.interp(b["flip"] * 0.9998, P, G)) > 0 else "short")), \
            "il flip non è lo zero della curva letta al prezzo"
# il T delle scadenze di OGGI è convenzionale: il numero NON dipende dall'ora in
# cui gira la pipeline (un flip che si muove perché sono le 10:30 è un bug)
same = book([(0, 5900.0, "PUT", 4000), (0, 6100.0, "CALL", 4000)])
assert gamma_flip(same, SPOT_B, "TEST") == gamma_flip(same, SPOT_B, "TEST")
# catena senza OI = niente da coprire → nessuna banda, la UI dichiara l'assenza
assert gamma_flip([{"date": (today_b + _td(days=1)).isoformat(),
                    "options": [{"strike": 6000.0, "side": "CALL", "oi": 0, "iv": 0.2}]}],
                  SPOT_B, "TEST") is None, "catena vuota non deve inventare flip"
print(f"test_day_plan: curva put-heavy {bd['regime']} flip {bd['flip']} (sopra) · "
      f"call-heavy {bd2['regime']} flip {bd2['flip']} (sotto)")

# --- 11. i tre FLIP restano tutti in scala: il dedup non deve mangiarsi
# GEX-FLIP-WEEK perché coincide col strutturale (era il motivo per cui NT8,
# che legge solo i livelli, mostrava un flip diverso dal sito — 16/11).
from day_plan import dedupe_levels
lv = [
    mk("GEX-FLIP", 7560.0, chain="etf"),
    mk("GEX-FLIP-WEEK", 7560.0, chain="etf"),      # stesso prezzo del strutturale
    mk("GEX-FLIP-0DTE", 7562.0, chain="etf"),      # 2 pt: zona diversa, perimetro diverso
    mk("PIN", 7561.0, chain="etf"),                # un muro SÌ, assorbito dal flip
]
kept = {l["name"] for l in dedupe_levels(lv)}
assert {"GEX-FLIP", "GEX-FLIP-WEEK", "GEX-FLIP-0DTE"} <= kept, f"flip soppressi: {kept}"
assert "PIN" not in kept, "il dedup dei livelli normali non deve cambiare"

print("test_day_plan: 26 check OK")
