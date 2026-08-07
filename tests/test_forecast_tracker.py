"""Unit tests for forecast_tracker's realized-price matching logic.

Exercises the 4h intraday-1h bar matcher and the 1d daily-close matcher with
synthetic dataframes (no network), covering:
  1. A target_at inside a session picks the CONTAINING 1h bar's close.
  2. Two target_at values on the same day at different hours resolve to
     DIFFERENT realized prices (the core assertion against the old daily-close
     bug, which collapsed them to one value per day).
  3. A target_at outside the session (before open / after last bar) picks the
     FIRST bar at or after it (next session's open bar).
  4. The 1d matcher keys by YYYY-MM-DD and gives the same close for every
     target_at on that calendar day.
  5. score_matured_forecasts is idempotent: it never re-scores a record that
     already has realized_price set.

Run: .venv/bin/python tests/test_forecast_tracker.py
"""
import json
import os
import sys
import tempfile
import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import pandas as pd  # noqa: E402

import forecast_tracker as ft  # noqa: E402

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


def make_intraday_df() -> pd.DataFrame:
    """A synthetic 1h bar dataframe spanning 2026-08-05 (UTC), session-only.

    Bars: 13:30, 14:30, ..., 19:30 UTC (= 09:30–15:30 ET, the regular session).
    Closes are deliberately distinct per bar so we can tell which one matched.
    """
    bars = [
        ("2026-08-05 13:30:00", 770.0),  # session open (09:30 ET)
        ("2026-08-05 14:30:00", 771.0),
        ("2026-08-05 15:30:00", 772.0),
        ("2026-08-05 16:30:00", 773.0),
        ("2026-08-05 17:30:00", 774.0),
        ("2026-08-05 18:30:00", 775.0),
        ("2026-08-05 19:30:00", 769.74),  # last session bar (15:30 ET, close-ish)
    ]
    idx = pd.DatetimeIndex([t for t, _ in bars], tz="UTC")
    closes = [c for _, c in bars]
    df = pd.DataFrame({"Close": closes, "Open": closes, "High": closes, "Low": closes,
                       "Adj Close": closes, "Volume": [1000] * len(closes)}, index=idx)
    return df


def make_daily_df() -> pd.DataFrame:
    """A synthetic daily dataframe with distinct closes per day."""
    bars = [
        ("2026-08-04", 760.0),
        ("2026-08-05", 769.79),
        ("2026-08-06", 768.56),
    ]
    idx = pd.DatetimeIndex([t for t, _ in bars])  # naive, mimics yfinance daily
    closes = [c for _, c in bars]
    return pd.DataFrame({"Close": closes, "Open": closes, "High": closes, "Low": closes,
                         "Adj Close": closes, "Volume": [10000] * len(closes)}, index=idx)


# --- Test 1: containing bar --------------------------------------------------
print("\n=== Test 1: target inside session → containing bar's close ===")
df = make_intraday_df()
idx = df.index
target_dts = [pd.Timestamp("2026-08-05 15:45:00", tz="UTC").to_pydatetime()]  # inside 15:30 bar
res = ft._match_intraday_bars(idx, df, target_dts)
key = target_dts[0].isoformat()
check("target 15:45 UTC matched (key present)", key in res, f"keys={list(res.keys())}")
check("close is the 15:30 bar's close (772.0)", res.get(key) == 772.0, f"got {res.get(key)}")


# --- Test 2: different hours on same day → different realized ---------------
print("\n=== Test 2: two target_at same day, different hours → DIFFERENT realized ===")
df = make_intraday_df()
idx = df.index
t1 = pd.Timestamp("2026-08-05 14:45:00", tz="UTC").to_pydatetime()  # → 14:30 bar close 771.0
t2 = pd.Timestamp("2026-08-05 18:45:00", tz="UTC").to_pydatetime()  # → 18:30 bar close 775.0
res = ft._match_intraday_bars(idx, df, [t1, t2])
r1 = res.get(t1.isoformat())
r2 = res.get(t2.isoformat())
check("t1 (14:45) → 771.0", r1 == 771.0, f"got {r1}")
check("t2 (18:45) → 775.0", r2 == 775.0, f"got {r2}")
check("r1 != r2 (the bug collapsed them)", r1 != r2, f"r1={r1} r2={r2}")


# --- Test 3: target outside session → first bar at/after ---------------------
print("\n=== Test 3: target before open → first session bar's close ===")
df = make_intraday_df()
idx = df.index
# 08:00 UTC = 04:00 ET, before open. First bar at/after is 13:30 UTC (close 770.0).
t = pd.Timestamp("2026-08-05 08:00:00", tz="UTC").to_pydatetime()
res = ft._match_intraday_bars(idx, df, [t])
r = res.get(t.isoformat())
check("pre-open target → first session bar (770.0)", r == 770.0, f"got {r}")


# --- Test 4: 1d matcher keys by YYYY-MM-DD, same close per day --------------
print("\n=== Test 4: 1d matcher → same close for any hour on the same day ===")
df = make_daily_df()
idx = df.index
# yfinance daily index is naive; _fetch_realized_closes localizes to ET→UTC.
# Replicate that here so _match_daily_closes gets a UTC index as in production.
idx_utc = idx.tz_localize("America/New_York", nonexistent="shift_forward",
                           ambiguous="NaT").tz_convert("UTC")
targets = [
    pd.Timestamp("2026-08-05 04:00:00", tz="UTC").to_pydatetime(),
    pd.Timestamp("2026-08-05 16:00:00", tz="UTC").to_pydatetime(),
    pd.Timestamp("2026-08-05 23:00:00", tz="UTC").to_pydatetime(),
]
res = ft._match_daily_closes(idx_utc, df, targets)
vals = [res.get(ft._realized_lookup_key(t.isoformat(), "1d")) for t in targets]
check("all three resolve to 2026-08-05 close (769.79)",
      all(v == 769.79 for v in vals), f"vals={vals}")
check("three lookups, all same value", len(set(vals)) == 1, f"vals={vals}")


# --- Test 5: score_matured_forecasts idempotency ----------------------------
print("\n=== Test 5: score_matured_forecasts never re-scores already-scored records ===")
# Two matured records: one already scored (realized_price set), one pending-score.
past = (ft._now_utc() - datetime.timedelta(days=2)).isoformat()
hist = [
    {"v": 2, "issued_at": past, "symbol": "SPY", "horizon": "4h",
     "target_at": (ft._now_utc() - datetime.timedelta(days=1)).isoformat(),
     "anchor_price": 100.0, "predicted_target": 101.0, "predicted_high": 102.0,
     "predicted_low": 99.0, "band_p10": 99.5, "band_p90": 101.5,
     "predicted_direction": "UP", "trend_bias": "BULLISH",
     # Already scored — must NOT be touched even with fetch_realized=True.
     "realized_price": 999.0, "direction_correct": True, "abs_pct_error": 1.0,
     "range_hit": True, "band_hit": True, "scored_at": past, "realized_method": "daily_close"},
    {"v": 2, "issued_at": past, "symbol": "SPY", "horizon": "4h",
     "target_at": (ft._now_utc() - datetime.timedelta(days=1)).isoformat(),
     "anchor_price": 100.0, "predicted_target": 101.0, "predicted_high": 102.0,
     "predicted_low": 99.0, "band_p10": 99.5, "band_p90": 101.5,
     "predicted_direction": "UP", "trend_bias": "BULLISH",
     "realized_price": None, "direction_correct": None, "abs_pct_error": None,
     "range_hit": None, "band_hit": None, "scored_at": None},
]
with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
    json.dump(hist, f)
    path = f.name
try:
    # fetch_realized=False → the unscored record stays None (no network), but
    # the KEY assertion is the already-scored one keeps its 999.0.
    ft.score_matured_forecasts(path, fetch_realized=False)
    with open(path) as f:
        out = json.load(f)
    scored_first = out[0]["realized_price"]
    check("already-scored record untouched (still 999.0)",
          scored_first == 999.0, f"got {scored_first}")
    check("already-scored record kept its method tag",
          out[0].get("realized_method") == "daily_close",
          f"got {out[0].get('realized_method')}")
finally:
    os.unlink(path)


# --- Test 6: realized_lookup_key shape --------------------------------------
print("\n=== Test 6: _realized_lookup_key returns the right key shape per horizon ===")
check("4h key = target_at ISO (tz-aware)",
      ft._realized_lookup_key("2026-08-05T16:00:00-04:00", "4h") == "2026-08-05T16:00:00-04:00",
      ft._realized_lookup_key("2026-08-05T16:00:00-04:00", "4h"))
check("1d key = YYYY-MM-DD",
      ft._realized_lookup_key("2026-08-05T16:00:00-04:00", "1d") == "2026-08-05",
      ft._realized_lookup_key("2026-08-05T16:00:00-04:00", "1d"))
check("1d key naive ts → day only",
      ft._realized_lookup_key("2026-08-05T00:00:00", "1d") == "2026-08-05")


# --- SUMMARY -----------------------------------------------------------------
print(f"\n{'='*60}")
print(f"RESULTS: {PASS} passed, {FAIL} failed")
print(f"{'='*60}")
sys.exit(1 if FAIL else 0)
