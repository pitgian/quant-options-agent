#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Invarianti del piano pubblicato — la prova che l'utente chiede guardando lo
schermo, scritta come assert.

Nata il 16/11 dal reclamo: «perché i flip tra indicatore e sito non corrispondono
e perché il sito mi dice gamma negativa con il prezzo sopra il flip». Tre famiglie
di verifiche su data/day_plan.json (l'ultimo piano generato dal pipeline):

  1. REGIME vs FLIP  — se la curva di esposizione taglia una volta sola, il prezzo
     sta sopra il confine SE E SOLO SE il regime è long. Mai il contrario.
  2. SITO vs NT8     — ogni perimetro/catena ha il SUO livello GEX-FLIP* nello
     stesso prezzo del blocco `gamma` (l'indicatore legge solo i livelli: se il
     dedup se ne mangia uno, i due client divergono — successo stamattina: 7545
     del sito contro 7580 del grafico).
  3. CAMPI FLAT      — i campi numerici che il sito usa come fallback
     (gex_flip_week/_0dte, gamma_regime*) esistono e concordano con la curva.

Uso:
    python tests/test_plan_invariants.py [percorso/day_plan.json]
Esce 0 se tutto regge, 1 sulla prima violazione (con i numeri in chiaro).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLAN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "data", "day_plan.json")

BUCKETS = ("all", "week", "0dte")
SFX = {"all": "", "week": "-WEEK", "0dte": "-0DTE"}
errs = []


def chk(cond, msg):
    if not cond:
        errs.append(msg)


def main():
    if not os.path.exists(PLAN):
        print(f"test_plan_invariants: nessun piano a {PLAN} — nulla da verificare")
        return 0
    plans = json.load(open(PLAN))["plans"]
    checked = 0
    for fut, p in plans.items():
        spot = p.get("last_price") or 0
        gam = p.get("gamma") or {}
        chk(bool(gam), f"{fut}: piano senza blocco 'gamma' (definizione vecchia di flip)")
        for chain_key, sfx_chain in (("etf", ""), ("index", "-IDX")):
            chain = gam.get(chain_key)
            if not chain:
                continue          # catena degradata/assente: nessun livello atteso
            for b in BUCKETS:
                band = chain.get(b) or {}
                if not band:
                    continue
                checked += 1
                reg, flip = band.get("regime"), band.get("flip")
                cross = band.get("crossings")
                # ── 1. regime e confine: la contraddizione vista sull'app ──
                if cross == 1 and flip and spot:
                    chk((reg == "long") == (flip < spot),
                        f"{fut}/{chain_key}/{b}: regime {reg} con flip {flip} e spot "
                        f"{spot} → '{'sopra' if flip < spot else 'sotto'} il flip = "
                        f"{reg}' non torna (crossings={cross})")
                if flip:
                    chk(band.get("flip_above") == flip or band.get("flip_below") == flip,
                        f"{fut}/{chain_key}/{b}: flip {flip} non è né below né above")
                if reg is None:
                    chk(flip is None, f"{fut}/{chain_key}/{b}: regime assente ma flip {flip}")
                # ── 2. il livello che legge NT8 deve esserci e coincidere ──
                name = f"GEX-FLIP{SFX[b]}{sfx_chain}"
                lv = [l for l in p.get("levels", []) if l.get("name") == name]
                if flip:
                    chk(bool(lv), f"{fut}: livello {name} ASSENTE ma la curva dà flip "
                                  f"{flip} → l'indicatore NT8 mostrerebbe un altro numero")
                    if lv:
                        chk(abs(lv[0]["price"] - flip) < 5.0,
                            f"{fut}: {name} = {lv[0]['price']} ≠ flip curva {flip}")
                        chk(lv[0].get("regime") == reg,
                            f"{fut}: {name}.regime {lv[0].get('regime')} ≠ {reg}")
                        chk(lv[0].get("zone_high") == band.get("flip_above")
                            and lv[0].get("zone_low") == band.get("flip_below"),
                            f"{fut}: {name} porta una zona diversa dal blocco gamma")
        # ── 3. campi flat di ritorno, usati dal sito quando il livello manca ──
        flat = {"gex_flip_week": ("etf", "week"), "gex_flip_0dte": ("etf", "0dte"),
                "gex_flip_week_index": ("index", "week"),
                "gex_flip_0dte_index": ("index", "0dte")}
        for key, (ck, bk) in flat.items():
            band = (gam.get(ck) or {}).get(bk) or {}
            if band.get("flip"):
                chk(abs((p.get(key) or 0) - band["flip"]) < 5.0,
                    f"{fut}: {key}={p.get(key)} ≠ flip curva {band['flip']}")
        # regime strutturale dichiarato dove la curva c'è
        for key, (ck, bk) in (("gamma_regime", ("etf", "all")),
                              ("gamma_regime_week", ("etf", "week")),
                              ("gamma_regime_0dte", ("etf", "0dte")),
                              ("gamma_regime_index", ("index", "all"))):
            band = (gam.get(ck) or {}).get(bk) or {}
            if band.get("regime"):
                chk(p.get(key) == band["regime"],
                    f"{fut}: {key}={p.get(key)} ≠ regime curva {band['regime']}")
    if errs:
        print(f"test_plan_invariants: ✗ {len(errs)} violazioni su {checked} bande")
        for e in errs:
            print("  ·", e)
        return 1
    print(f"test_plan_invariants: ✓ {checked} bande (catena × perimetro) — regime, "
          f"flip, livelli NT8 e campi flat concordano")
    return 0


if __name__ == "__main__":
    sys.exit(main())
