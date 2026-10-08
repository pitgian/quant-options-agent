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
    return idx, highs, lows

# --- 1. touch solo PRIMA della pubblicazione → non conta ---
idx, h, l = bars([
    (D0, 6005, 5995),   # barra che toccherebbe il livello, ma è del 4/10
    (D1, 6100, 6090),   # il 5/10 il prezzo è altrove
])
r = score_plan_against(PLAN, idx, h, l)
assert len(r) == 1 and not r[0]["touched"], "barra pre-piano contata come touch!"

# --- 2. touch da sotto + rifiuto (non chiude sopra 6004) → held ---
idx, h, l = bars([
    (D1, 5990, 5985),
    (D1 + timedelta(minutes=5), 6002, 5996),   # touch (banda ±3)
    (D1 + timedelta(minutes=10), 6001, 5995),  # rifiuto: non supera 6004
    (D1 + timedelta(minutes=15), 5990, 5992),  # si allontana
])
r = score_plan_against(PLAN, idx, h, l)
assert r[0]["touched"] and r[0]["held"], "touch+rifiuto dovrebbe dare held=True"

# --- 3. touch + chiusura oltre (supera 6004 senza mai ≤5994) → violato ---
idx, h, l = bars([
    (D1, 6002, 5996),   # touch da sotto
    (D1 + timedelta(minutes=5), 6010, 6005),   # rompe e chiude sopra
    (D1 + timedelta(minutes=10), 6015, 6008),
])
r = score_plan_against(PLAN, idx, h, l)
assert r[0]["touched"] and not r[0]["held"], "rottura sopra non segnalata"

# --- 4. update_stats: chiave con prefisso e accumulo su due giornate ---
stats = {}
idx, h, l = bars([
    (D1, 6002, 5996), (D1 + timedelta(minutes=5), 6001, 5995),
])
update_stats(PLAN, idx, h, l, stats, prefix="ES")
PLAN2 = {**PLAN, "generated_at": "2026-10-06T08:00:00+00:00"}
idx, h, l = bars([
    (D1 + timedelta(days=1), 6003, 5997), (D1 + timedelta(days=1, minutes=5), 6000, 5990),
])
update_stats(PLAN2, idx, h, l, stats, prefix="ES")
assert "ES:PDH" in stats, f"chiave con prefisso mancante: {list(stats)}"
assert stats["ES:PDH"]["n"] == 2 and stats["ES:PDH"]["held"] == 2
assert stats["ES:PDH"]["name"] == "ES:PDH"
# nessuna contaminazione tra strumenti
update_stats(PLAN, [D1], [6002], [5996], stats, prefix="NQ")
assert stats["NQ:PDH"]["n"] == 1 and stats["ES:PDH"]["n"] == 2

# --- 5. only_date: giudica SOLO le barre della giornata richiesta ---
idx, h, l = bars([
    (D1, 6002, 5996),                                          # touch il 05/10
    (D1 + timedelta(days=1), 6002, 5996),                      # touch il 06/10
])
r = score_plan_against(PLAN, idx, h, l, only_date=(D1 + timedelta(days=1)).date())
assert r[0]["touched"], "il touch del 06/10 deve essere visto da only_date"
r = score_plan_against(PLAN, idx, h, l, only_date=(D1 + timedelta(days=2)).date())
assert r == [], "giorno senza barre non deve dare verdetti"

print("test_day_plan: 8 check OK")
