# Python ↔ TypeScript Quant Parity

The quantitative logic (gamma estimation, GEX, wall scoring) is currently
implemented in **both** `scripts/fetch_options_data.py` (Python, used for the
GitHub Actions data pipeline) and `services/` + `utils/` (TypeScript, used by
the frontend).

This document records **what is intentionally shared** and **what is
intentionally divergent**, so future changes don't silently produce
inconsistent dashboards.

## ✅ Shared & verified by parity tests

`utils/parity.test.ts` consumes `scripts/test/parity_fixtures.json` (generated
by `scripts/test/generate_parity_fixtures.py`) and asserts that both
implementations agree to 4+ decimal places.

| Concept | Python location | TS location | Verified |
|---|---|---|---|
| Black-Scholes `estimate_gamma` | `fetch_options_data.py:estimate_gamma` | `utils/gammaEstimate.ts:estimateGamma` | ✅ 135 cases |
| GEX per strike `oi·γ·100·S²·sign·tw` | `fetch_symbol_data` inline | `services/gexService.ts:computeGEXPerStrike` | ✅ |
| Time decay `1/(1+dte/7)` | inline | inline | ✅ |
| DTE weights `{0: .25/.75, ≤3: .5/.5, else: .7/.3}` | `_score_and_rank` | `services/wallService.ts:computeTopWalls` | ✅ |

**Regenerate the fixtures** after touching the Python math:

```bash
.venv/bin/python scripts/test/generate_parity_fixtures.py
```

Then commit the updated `scripts/test/parity_fixtures.json` and run
`npm test` — if the TS side drifted, tests break.

## ⚠️ Intentionally divergent (different algorithms, not bugs)

These are NOT verified for parity because the two sides do different things by
design. If you ever unify them, delete the divergence note here.

### GEX flip point

- **Python** (`fetch_symbol_data`): walks all strikes in strike order, returns
  the **first** zero-crossing via linear interpolation.
- **TypeScript** (`gexService.computeGexFlipPoint`): bounds the search to ±5% of
  spot, applies a 5-strike moving average for noise smoothing, returns the
  crossing **closest to spot**.

The TS version is more robust on dense 0DTE chains (where Python's "first"
crossing can land on a noise spike far from spot). The frontend uses the TS
value; the Python value is currently unused downstream.

### Wall scoring

- **Python** (`_score_and_rank`): `own_activity · max(0, 1 - α·cross_ratio) ·
  gaussian_proximity_decay`, with `α = 0.35` and `σ = 1.5%`.
- **TypeScript** (`wallService.computeTopWalls`): `own_activity` only, **no**
  cross-side penalty and **no** proximity decay (commented inline).

The Python scoring feeds the cross-symbol confluence matching; the TS scoring
feeds the dashboard walls. They are not directly comparable. Aligning them is a
product decision (the TS version was deliberately simplified).

## When to update this document

- If you unify one of the divergent algorithms → move it to the "shared" table
  and add a parity test.
- If you add a new shared formula → add a fixture generator + parity test.
- If you introduce a new intentional divergence → document it here so the next
  contributor knows it's deliberate.
