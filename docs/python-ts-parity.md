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
| **Unified wall score** `(oi·w_oi+vol·w_vol)·exp(-\|dist%\|/2)` | `fetch_options_data.py:compute_wall_score` | `services/wallService.ts:computeWallScore` | ✅ 168 cases |
| DTE weights `{0: .25/.75, ≤3: .5/.5, else: .7/.3}` | `wall_dte_weights` | `wallDteWeights` | ✅ (via wall_score) |

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
  value; the Python value is **unused downstream** (and stripped from the JSON
  by the `d3e20ea1` payload cleanup) — it's only computed as an intermediate
  diagnostic.

### ~~Wall scoring~~ (UNIFIED — was divergent until 2026-06-22)

Both implementations now use a single unified score:

    score = (own_oi·w_oi + own_vol·w_vol) · exp(-|dist%| / 2.0)

Previously the Python version applied an additional cross-side penalty
(`1 - α·cross_ratio`, `α = 0.35`) and a Gaussian decay
(`exp(-(dist/1.5)²)`), while the TS version applied **no** distance decay at
all. The divergence was unintended and produced non-comparable rankings.

Design choices in the unified formula:
  - **Laplacian decay (λ = 2%)** instead of Gaussian: keeps a sharp intraday
    focus (ATM = 1.0, ±2% ≈ 0.37) without zeroing far structural levels
    (±5% ≈ 0.08). The old Gaussian was ≈0 already at ±3%, silently discarding
    real support/resistance walls.
  - **Cross-side penalty removed**: a strike with high put AND call OI is a
    high-gamma NODE, not a weak wall. Bilaterality is rewarded separately by
    `calculate_confluence_levels`.

The confluence scorer still uses its own distinct formula (interest + balance
+ proximity) because it measures bilateral "node-ness", a different question
from single-side "wall importance".

## When to update this document

- If you unify one of the divergent algorithms → move it to the "shared" table
  and add a parity test.
- If you add a new shared formula → add a fixture generator + parity test.
- If you introduce a new intentional divergence → document it here so the next
  contributor knows it's deliberate.
