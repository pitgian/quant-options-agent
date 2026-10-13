#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test di separazione del track record — il kill-test PRIMA di qualsiasi ML.

Legge data/level_stats.json (i verdetti con il loro snapshot di stato) e
risponde alla domanda: le feature (regime, scenario, divergenza, distanza)
separano gli esiti? Se NON separano con n sufficiente, non ha senso
addestrare alcun decision model (CLM/JEV/boosting): le regole scritte a
mano restano il meglio disponibile. Ripetere il test ogni 1-2 settimane.

Uso:
    python scripts/test_separation.py                     # analisi stampata
    python scripts/test_separation.py --stats altro.json  # file alternativo
    python scripts/test_separation.py --json out.json     # export record+tabelle

Zero dipendenze esterne: solo stdlib (il test è Fisher exact 2x2).
"""

import argparse
import json
import os
import sys
from math import comb

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_STATS = os.path.join(SCRIPTS_DIR, "..", "data", "level_stats.json")

MIN_N_SIGNIFICATIVO = 30   # sotto questo n: "dati insufficienti" a prescindere
MIN_ENTRIES_LIVELLO = 2    # per la tabella per-livello


# ---------------------------------------------------------------------------
# Statistica: Fisher exact two-sided per tabelle 2x2
# ---------------------------------------------------------------------------

def fisher_exact_2x2(a: int, b: int, c: int, d: int):
    """p-value two-sided per [[a, b], [c, d]] (successi/fallimenti per gruppo)."""
    row1, row2 = a + b, c + d
    col1, col2 = a + c, b + d
    n = row1 + row2
    if n == 0 or min(row1, row2, col1, col2) == 0:
        return None

    def prob(x):
        return comb(col1, x) * comb(col2, row1 - x) / comb(n, row1)

    p_obs = prob(a)
    lo = max(0, row1 - col2)
    hi = min(row1, col1)
    p_tot = 0.0
    for x in range(lo, hi + 1):
        p = prob(x)
        if p <= p_obs * (1 + 1e-9):
            p_tot += p
    return min(1.0, p_tot)


def giudizio(p, n_tot: int, min_n: int = MIN_N_SIGNIFICATIVO) -> str:
    if p is None:
        return "n/d"
    base = f"p={p:.3f}, n={n_tot}"
    if n_tot < min_n:
        return f"dati insufficienti ({base})"
    if p < 0.05:
        return f"SEPARA ✓ ({base})"
    if p < 0.10:
        return f"segnale debole ({base})"
    return f"nessuna differenza ({base})"


# ---------------------------------------------------------------------------
# Caricamento record
# ---------------------------------------------------------------------------

def load_records(path: str):
    """Appiattisce level_stats.json in record: uno per verdetto con snapshot."""
    with open(path) as f:
        data = json.load(f)

    records, senza_snapshot = [], 0
    for key, lv in (data.get("levels") or {}).items():
        fut = key.split(":", 1)[0]
        for e in lv.get("history", []):
            if "regime" not in e or "held" not in e:
                senza_snapshot += 1
                continue
            spot = e.get("spot")
            dist_pct = (abs(e.get("dist_pts", 0) or 0) / spot * 100) if spot else None
            records.append({
                "fut": fut,
                "name": key,
                "kind": e.get("kind", "pivot"),
                "held": bool(e["held"]),
                "date": e.get("date", ""),
                "regime": e.get("regime"),
                "scenario": e.get("scenario"),
                "divergence": e.get("divergence"),
                "near_mp": e.get("near_mp"),
                "dist_bucket": (None if dist_pct is None else
                                "≤0,3%" if dist_pct <= 0.3 else
                                "0,3–1%" if dist_pct <= 1.0 else ">1%"),
            })
    records.sort(key=lambda r: r["date"])
    return records, senza_snapshot


# ---------------------------------------------------------------------------
# Tabelle
# ---------------------------------------------------------------------------

def tabella(records, feature, values_order=None, label=None):
    """Tabella condizionale held per valore della feature + Fisher sui primi 2 gruppi."""
    groups: dict = {}
    for r in records:
        v = r.get(feature)
        if v is None:
            continue
        g = groups.setdefault(v, {"n": 0, "held": 0})
        g["n"] += 1
        g["held"] += 1 if r["held"] else 0

    order = values_order or sorted(groups)
    label = label or feature
    n_tot = sum(g["n"] for g in groups.values())
    print(f"\n  [{label}]  (n={n_tot})")
    for v in order:
        g = groups.get(v)
        if not g:
            continue
        rate = g["held"] / g["n"] * 100 if g["n"] else 0
        print(f"    {str(v):14s} {g['held']:>3}/{g['n']:<3} ({rate:5.1f}%)")

    vals = [v for v in order if v in groups][:2]
    p = None
    if len(vals) == 2:
        g1, g2 = groups[vals[0]], groups[vals[1]]
        p = fisher_exact_2x2(g1["held"], g1["n"] - g1["held"],
                             g2["held"], g2["n"] - g2["held"])
        print(f"    → {vals[0]} vs {vals[1]}: {giudizio(p, g1['n'] + g2['n'])}")
    return {"feature": label, "groups": groups, "p": p, "n_tot": n_tot}


def main() -> None:
    ap = argparse.ArgumentParser(description="Test di separazione del track record")
    ap.add_argument("--stats", default=DEFAULT_STATS)
    ap.add_argument("--min-livello", type=int, default=MIN_ENTRIES_LIVELLO,
                    help="n minimo per mostrare un livello nella tabella per-livello")
    ap.add_argument("--json", metavar="FILE", help="export dei record in JSON")
    args = ap.parse_args()

    if not os.path.exists(args.stats):
        print(f"level_stats non trovato: {args.stats}")
        sys.exit(1)

    records, senza_snapshot = load_records(args.stats)
    tables = []

    print("=" * 72)
    print("TEST DI SEPARAZIONE — track record QuantFlow (verdetto per mestiere)")
    print("=" * 72)
    if not records:
        print("Nessun verdetto con snapshot disponibile: attendi le prime "
              "giornate giudicate (il marcatore last_scored le genera al "
              "cambio di giornata ET).")
        sys.exit(0)

    periodo = f"{records[0]['date']} → {records[-1]['date']}"
    n_ok = sum(1 for r in records if r["held"])
    print(f"Verdetti: {len(records)} | periodo: {periodo} | "
          f"esito positivo: {n_ok} ({n_ok / len(records) * 100:.0f}%) | "
          f"ES+NQ aggregati")
    if senza_snapshot:
        print(f"(scartati {senza_snapshot} verdetti senza snapshot — "
              f"giudicati con la vecchia semantica)")

    # 1. per meccanismo
    kinds = ["barrier", "trigger", "magnet", "pivot"]
    tables.append(tabella(records, "kind", values_order=kinds, label="meccanismo"))

    # 2. barriera: long vs short gamma (la domanda classica)
    bar = [r for r in records if r["kind"] == "barrier"]
    if bar:
        tables.append(tabella(bar, "regime", values_order=["long", "short"],
                              label="barriera: long vs short gamma"))

    # 3. trigger: long vs short gamma
    trg = [r for r in records if r["kind"] == "trigger"]
    if trg:
        tables.append(tabella(trg, "regime", values_order=["long", "short"],
                              label="trigger: long vs short gamma"))

    # 4. scenario
    tables.append(tabella(records, "scenario",
                          values_order=["compressione", "trend", "ibrido"],
                          label="scenario"))

    # 5. divergenza SPY/QQQ
    tables.append(tabella(records, "divergence", label="divergenza SPY/QQQ"))

    # 6. vicinanza al max pain
    tables.append(tabella(records, "near_mp", label="vicino al max pain"))

    # 7. distanza dallo spot
    tables.append(tabella(records, "dist_bucket",
                          values_order=["≤0,3%", "0,3–1%", ">1%"],
                          label="distanza dallo spot"))

    # 8. per livello (solo i più toccati)
    by_level: dict = {}
    for r in records:
        by_level.setdefault(r["name"], []).append(r)
    top = {k: v for k, v in by_level.items() if len(v) >= args.min_livello}
    if top:
        print(f"\n  [per livello] (≥{args.min_livello} tocchi)")
        for k in sorted(top, key=lambda k: -len(top[k]))[:8]:
            v = top[k]
            rate = sum(1 for r in v if r["held"]) / len(v) * 100
            print(f"    {k:22s} {sum(1 for r in v if r['held']):>3}/{len(v):<3} ({rate:5.1f}%)")

    # --- verdetto finale ---
    sep = [t for t in tables if t["p"] is not None and t["p"] < 0.05
           and t["n_tot"] >= MIN_N_SIGNIFICATIVO]
    weak = [t for t in tables if t["p"] is not None and 0.05 <= t["p"] < 0.10
            and t["n_tot"] >= MIN_N_SIGNIFICATIVO]
    print("\n" + "=" * 72)
    if sep:
        print(f"VERDETTO: {len(sep)} feature separano significativamente "
              f"({', '.join(t['feature'] for t in sep)}).")
        print("C'è segnale nei dati: il dataset vale per un modello")
        print("(prima boosting/logistica interpretabile, CLM solo dopo).")
    elif weak:
        print(f"VERDETTO: solo segnali deboli ({', '.join(t['feature'] for t in weak)}).")
        print("Accumula ancora verdetti: ripeti il test tra 1-2 settimane.")
    else:
        print("VERDETTO: nessuna feature separa con i dati attuali.")
        print("NON addestrare decision model — le regole scritte a mano sono")
        print("il meglio disponibile. Ripeti il test ogni 1-2 settimane.")
    print("=" * 72)

    if args.json:
        with open(args.json, "w") as f:
            json.dump({"records": records, "tables": [
                {"feature": t["feature"], "groups": {k: v for k, v in t["groups"].items()},
                 "p": t["p"], "n_tot": t["n_tot"]} for t in tables]}, f, indent=1, default=str)
        print(f"export JSON → {args.json}")


if __name__ == "__main__":
    main()
