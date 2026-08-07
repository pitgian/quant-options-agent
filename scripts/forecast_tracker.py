"""Forecast verification tracker for Kronos predictions.

Records every forecast snapshot before it is overwritten, then — once each
forecast's horizon has matured — scores it against the realized price.

Mirrors the append-only / retention / cap pattern of `append_to_history` in
scripts/fetch_options_data.py:1617-1704 (the GEX covariate history). The two
functions here are called from scripts/run_kronos.py at the end of every run:

    score_matured_forecasts(OUTPUT_PATH)   # mark old forecasts against reality
    append_forecast_snapshot(OUTPUT_PATH)  # record the fresh one

Output: data/kronos_forecast_history.json — a flat array of ForecastSnapshot
records, one per (issued_at, symbol, horizon).

A snapshot is "pending" until its `target_at` has passed; then it becomes
"scored" once we can fetch the realized close at `target_at` from yfinance.
NEUTRAL-bias forecasts record direction_correct=null and are excluded from
directional accuracy (a NEUTRAL declares "no edge", so counting it as a miss
would be misleading).
"""

import os
import json
import datetime
from collections import defaultdict

import pandas as pd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
HISTORY_PATH = os.path.join(SCRIPTS_DIR, "../data/kronos_forecast_history.json")

# Drop snapshots older than this (keeps the history file bounded + relevant).
TRACKER_RETENTION_DAYS = 30
# Hard cap per (symbol, horizon) — a safety net on top of the age retention,
# mirrors HISTORY_SAFETY_CAP in fetch_options_data.py.
TRACKER_SAFETY_CAP = 2000
# Schema version: if the snapshot shape ever changes in a backward-incompatible
# way, bump this and old records are purged on load (self-healing, same idea as
# gex_v in fetch_options_data.py).
# v2: added band_p10 / band_p90 / band_hit — Monte Carlo percentile band
#     coverage validation (forecast_tracker validates how often the realized
#     price lands inside the 80% p10-p90 band).
TRACKER_SCHEMA_VERSION = 2

# (symbol_key_in_json, futures_ticker_for_yfinance) — Kronos forecasts run in
# ETF space (SPY/QQQ), and the realized close is fetched on the same ETF.
SYMBOLS = {
    "SP500": "SPY",
    "NASDAQ": "QQQ",
}
HORIZONS = ["4h", "1d"]

# Threshold (fraction of anchor_price) below which a predicted move is treated
# as FLAT — the same idea as the bias_threshold in run_kronos.py:380 but a flat
# fixed value here is fine because we only use it to label the snapshot's own
# direction, independent of how the live forecast classified the bias.
FLAT_MOVE_THRESHOLD_PCT = 0.10

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_utc() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _parse_dt(value) -> datetime.datetime | None:
    """Parse an ISO timestamp defensively; naive datetimes are assumed UTC."""
    if not value:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def _round_sig(x, ndigits=4):
    return round(float(x), ndigits) if x is not None else None


def _load_history(path: str = HISTORY_PATH) -> list[dict]:
    """Load the snapshot history, purging records from incompatible schemas."""
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r") as f:
            history = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"forecast_tracker: failed to load history ({e}); starting fresh.")
        return []

    if not isinstance(history, list):
        print("forecast_tracker: history root is not a list; starting fresh.")
        return []

    # Self-healing schema migration: drop records that don't match the current
    # schema version. Same pattern as the GEX_VERSION filter in run_kronos.py.
    kept = [r for r in history if isinstance(r, dict) and r.get("v") == TRACKER_SCHEMA_VERSION]
    purged = len(history) - len(kept)
    if purged:
        print(f"forecast_tracker: purged {purged} records with old/missing schema version.")
    return kept


def _save_history(history: list[dict], path: str = HISTORY_PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(history, f, indent=2)


def _apply_retention_and_cap(history: list[dict]) -> list[dict]:
    """Age-based retention (drop > TRACKER_RETENTION_DAYS old) + per-group cap."""
    cutoff = _now_utc() - datetime.timedelta(days=TRACKER_RETENTION_DAYS)

    kept_by_age = []
    dropped_age = 0
    for r in history:
        issued = _parse_dt(r.get("issued_at"))
        if issued is None or issued >= cutoff:
            kept_by_age.append(r)
        else:
            dropped_age += 1
    if dropped_age:
        print(f"forecast_tracker: dropped {dropped_age} records older than {TRACKER_RETENTION_DAYS}d.")

    # Per (symbol, horizon) safety cap — keep the newest TRACKER_SAFETY_CAP.
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in kept_by_age:
        groups[(r.get("symbol"), r.get("horizon"))].append(r)

    capped: list[dict] = []
    for key, recs in groups.items():
        recs.sort(key=lambda r: r.get("issued_at", ""), reverse=True)
        capped.extend(recs[:TRACKER_SAFETY_CAP])
    return capped


def _predicted_direction(anchor_price: float, predicted_target: float) -> str:
    """Label a forecast's own direction from the signed predicted move.

    FLAT if the move is below FLAT_MOVE_THRESHOLD_PCT of the anchor — this lets
    us later exclude near-zero predictions from directional accuracy exactly the
    way the live forecast's NEUTRAL bias does.
    """
    if anchor_price <= 0:
        return "FLAT"
    move_pct = ((predicted_target - anchor_price) / anchor_price) * 100.0
    if move_pct > FLAT_MOVE_THRESHOLD_PCT:
        return "UP"
    if move_pct < -FLAT_MOVE_THRESHOLD_PCT:
        return "DOWN"
    return "FLAT"


def _extract_snapshots(forecast: dict) -> list[dict]:
    """Build one snapshot per (symbol, horizon) from a kronos_forecast.json dict."""
    issued_at = forecast.get("updated_at") or _now_utc().isoformat()
    # Normalize to UTC ISO so issued_at is always comparable + timezone-aware.
    issued_dt = _parse_dt(issued_at)
    issued_iso = (issued_dt or _now_utc()).isoformat()

    snapshots = []
    for market_key, symbol in SYMBOLS.items():
        item = forecast.get(f"{market_key}_bias")
        if not isinstance(item, dict):
            continue
        trend_bias = item.get("trend_bias", "NEUTRAL")

        for horizon in HORIZONS:
            res = item.get(f"forecast_{horizon}")
            if not isinstance(res, dict):
                continue
            candles = res.get("candles") or []
            if not candles:
                continue

            anchor_price = float(res.get("last_price") or item.get(f"last_price_{horizon}") or 0.0)
            final_candle = candles[-1]
            predicted_target = float(final_candle.get("close", anchor_price))
            predicted_high = float(res.get("expected_high") or max(c.get("high", 0) for c in candles))
            predicted_low = float(res.get("expected_low") or min(c.get("low", 0) for c in candles))
            target_ts = final_candle.get("timestamp")

            # 80% Monte Carlo band on the FINAL candle's close (the value the
            # realized price is checked against at target_at). Falls back to the
            # p50 close when the percentile fields are absent (legacy JSON), so
            # band_hit evaluates to None for those — never crashes.
            final_close_p10 = final_candle.get("close_p10")
            final_close_p90 = final_candle.get("close_p90")
            if final_close_p10 is not None and final_close_p90 is not None:
                band_p10 = _round_sig(float(min(final_close_p10, final_close_p90)), 2)
                band_p90 = _round_sig(float(max(final_close_p10, final_close_p90)), 2)
            else:
                band_p10 = None
                band_p90 = None

            snapshots.append({
                "v": TRACKER_SCHEMA_VERSION,
                "issued_at": issued_iso,
                "symbol": symbol,
                "horizon": horizon,
                "target_at": target_ts,
                "anchor_price": _round_sig(anchor_price, 2),
                "predicted_target": _round_sig(predicted_target, 2),
                "predicted_high": _round_sig(predicted_high, 2),
                "predicted_low": _round_sig(predicted_low, 2),
                "band_p10": band_p10,
                "band_p90": band_p90,
                "predicted_direction": _predicted_direction(anchor_price, predicted_target),
                "trend_bias": trend_bias,
                # Scored later, when target_at has matured:
                "realized_price": None,
                "direction_correct": None,
                "abs_pct_error": None,
                "range_hit": None,
                "band_hit": None,
                "scored_at": None,
            })
    return snapshots


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def append_forecast_snapshot(forecast_json_path: str, history_path: str = HISTORY_PATH):
    """Record the just-written forecast as new pending snapshots.

    Idempotent: if a snapshot with the same (issued_at, symbol, horizon) already
    exists, it is skipped — so re-running the pipeline on the same forecast file
    never produces duplicates.
    """
    if not os.path.exists(forecast_json_path):
        print(f"forecast_tracker: forecast file not found at {forecast_json_path}; nothing to append.")
        return

    with open(forecast_json_path, "r") as f:
        forecast = json.load(f)

    new_snapshots = _extract_snapshots(forecast)
    if not new_snapshots:
        print("forecast_tracker: no usable (symbol, horizon) snapshots in forecast; nothing to append.")
        return

    history = _load_history(history_path)

    # Index existing keys for O(1) idempotency check.
    existing_keys = {
        (r.get("issued_at"), r.get("symbol"), r.get("horizon"))
        for r in history
    }

    added = 0
    for snap in new_snapshots:
        key = (snap["issued_at"], snap["symbol"], snap["horizon"])
        if key in existing_keys:
            continue
        history.append(snap)
        existing_keys.add(key)
        added += 1

    history = _apply_retention_and_cap(history)
    _save_history(history, history_path)
    print(f"forecast_tracker: appended {added} new snapshot(s); history now holds {len(history)} records.")


def score_matured_forecasts(history_path: str = HISTORY_PATH, fetch_realized: bool = True):
    """Score every pending snapshot whose horizon has matured.

    For each matured-but-unscored snapshot, fetch the realized close at
    `target_at` from yfinance and record direction_correct / abs_pct_error /
    range_hit. Snapshots whose target_at hasn't arrived yet are left pending; if
    yfinance doesn't yet have the bar (right at expiry) we leave them pending
    too and retry on the next run.

    Realized price by horizon:
      - 4h → intraday 1h bar (the one covering target_at, or the first bar at/after
        target_at if it falls outside regular session). 4h target_at values land
        on 04:00/08:00/12:00/16:00/20:00 ET buckets from the run_kronos resample,
        several of which are OUTSIDE the 09:30–16:00 ET regular session, so using
        the daily close there was a measurement bug (shift up to ~12h).
      - 1d → daily close of target_at's day (genuinely the price ~5 business days
        out, so the daily bar is the right reference there).

    NEUTRAL/FLAT forecasts get direction_correct=null and are excluded from
    directional accuracy downstream (they declare "no directional view").
    """
    history = _load_history(history_path)
    if not history:
        return

    now = _now_utc()

    # Collect the matured-but-unscored snapshots, grouped by (symbol, horizon)
    # so each group gets its own yfinance download with the right interval.
    # Mixing horizons in one fetch is wrong now: 4h needs 1h bars, 1d needs daily.
    matured_by_key: dict[tuple[str, str], list[tuple[int, dict]]] = defaultdict(list)
    for idx, rec in enumerate(history):
        if rec.get("realized_price") is not None:
            continue  # already scored
        target_at = _parse_dt(rec.get("target_at"))
        if target_at is None or target_at > now:
            continue  # not matured yet
        symbol = rec.get("symbol")
        horizon = rec.get("horizon")
        matured_by_key[(symbol, horizon)].append((idx, rec))

    if not matured_by_key:
        return

    scored_count = 0
    for (symbol, horizon), entries in matured_by_key.items():
        if fetch_realized:
            realized_by_ts = _fetch_realized_closes(symbol, horizon, entries)
        else:
            realized_by_ts = {}

        for idx, rec in entries:
            target_ts = rec.get("target_at")
            realized = realized_by_ts.get(_realized_lookup_key(target_ts, horizon))
            if realized is None:
                continue  # yfinance doesn't have this bar yet; retry next run

            anchor = rec.get("anchor_price")
            predicted = rec.get("predicted_target")
            p_high = rec.get("predicted_high")
            p_low = rec.get("predicted_low")

            rec["realized_price"] = _round_sig(realized, 2)
            rec["realized_method"] = "intraday_1h" if horizon == "4h" else "daily_close"
            # Direction is only meaningful for forecasts that actually took a
            # directional stance (UP/DOWN). FLAT/NEUTRAL → null (excluded).
            direction = rec.get("predicted_direction")
            if direction in ("UP", "DOWN") and anchor and anchor > 0:
                predicted_up = predicted >= anchor
                realized_up = realized >= anchor
                rec["direction_correct"] = bool(predicted_up == realized_up)
            else:
                rec["direction_correct"] = None

            if realized and realized > 0:
                rec["abs_pct_error"] = _round_sig(abs(predicted - realized) / realized * 100.0, 3)
            else:
                rec["abs_pct_error"] = None

            if p_high is not None and p_low is not None:
                rec["range_hit"] = bool(p_low <= realized <= p_high)
            else:
                rec["range_hit"] = None

            # Did the realized close land inside the 80% Monte Carlo band
            # (p10-p90 of the final candle's close)? Nominally this should hit
            # ~80% of the time; systematic under-coverage means the band is too
            # tight (overconfident model). Null for legacy snapshots without
            # band fields — they're excluded from bandCoverage in the frontend.
            b_low = rec.get("band_p10")
            b_high = rec.get("band_p90")
            if b_low is not None and b_high is not None:
                rec["band_hit"] = bool(b_low <= realized <= b_high)
            else:
                rec["band_hit"] = None

            rec["scored_at"] = now.isoformat()
            scored_count += 1

    _save_history(history, history_path)
    print(f"forecast_tracker: scored {scored_count} matured snapshot(s).")


# ---------------------------------------------------------------------------
# yfinance realized-price fetch
# ---------------------------------------------------------------------------


def _norm_ts_key(ts) -> str:
    """Normalize a timestamp to a day string for matching yfinance daily bars.

    Used only for the 1d horizon now (4h uses intraday 1h bars keyed by full
    timestamp — see _realized_lookup_key). Kept as a helper so the two code
    paths share the same day-bucketing logic.
    """
    dt = _parse_dt(ts)
    if dt is None:
        return ""
    return dt.strftime("%Y-%m-%d")


def _realized_lookup_key(ts, horizon: str) -> str:
    """Build the key used to look up a realized price for a target_at.

    For 4h the key is the target_at's own ISO (UTC): _match_intraday_bars keys
    its result by target_at ISO so the chosen-bar close resolves directly.
    For 1d the key is the calendar day (YYYY-MM-DD) of the daily close.
    """
    if horizon == "4h":
        dt = _parse_dt(ts)
        return dt.isoformat() if dt else ""
    return _norm_ts_key(ts)


def _fetch_realized_closes(
    symbol: str, horizon: str, entries: list[tuple[int, dict]]
) -> dict[str, float]:
    """Fetch realized prices at each entry's target_at.

    Returns a map keyed by `_realized_lookup_key(target_at, horizon)`:

      - horizon == "4h": keys are the chosen 1h bar's start timestamp in UTC ISO.
        We download 1h bars and, for each target_at, pick the bar that CONTAINS
        it (bar_start <= target_at < bar_start + 1h); if target_at falls outside
        regular session (no containing bar), we pick the FIRST bar at or after
        target_at — i.e. the open of the next session. This fixes the measurement
        bug where 4h target_at values at 04:00/20:00 ET (outside 09:30–16:00 ET)
        were being scored against the daily close of that calendar day.
      - horizon == "1d": keys are "YYYY-MM-DD". We download daily bars and map
        each calendar day to its close. target_at for 1d is ~5 business days out,
        so the daily close of target_at's day is genuinely the realized price at
        the forecast's horizon — the daily bar is the correct reference there.
    """
    import yfinance as yf  # imported lazily so the module loads without yfinance

    target_dts = [_parse_dt(rec.get("target_at")) for _, rec in entries if rec.get("target_at")]
    target_dts = [dt for dt in target_dts if dt is not None]
    if not target_dts:
        return {}

    earliest = min(target_dts)
    latest = max(target_dts)
    # Buffer both ends: 1 day back (so the first target's bar is present even if
    # the run fires slightly early) and 2 days forward (covers the most recent
    # target plus weekends/holidays where the next-session bar lands later).
    start = (earliest - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
    end = (latest + datetime.timedelta(days=2)).strftime("%Y-%m-%d")

    interval = "1h" if horizon == "4h" else "1d"
    try:
        df = yf.download(symbol, start=start, end=end, interval=interval, progress=False, auto_adjust=False)
    except Exception as e:
        print(f"forecast_tracker: yfinance {interval} fetch failed for {symbol}: {e}")
        return {}

    if df is None or df.empty:
        return {}

    # Flatten a possible MultiIndex on columns (yfinance returns one with
    # multiple tickers).
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    # Normalize the index to UTC-aware timestamps. yfinance returns intraday
    # bars in the exchange timezone (America/New_York) and daily bars naive
    # (00:00 of the calendar day, exchange-local). Converting to UTC lets us
    # compare directly against target_at (which _parse_dt already forces to UTC).
    idx = df.index
    if not isinstance(idx, pd.DatetimeIndex):
        return {}
    if idx.tz is None:
        # Intraday 1h from yfinance is already tz-aware; daily is naive and
        # represents exchange-local midnight. Localize to the exchange tz first,
        # then convert to UTC so daily and intraday keys are comparable.
        try:
            idx = idx.tz_localize("America/New_York", nonexistent="shift_forward", ambiguous="NaT").tz_convert("UTC")
        except Exception:
            # Fallback: treat naive as UTC (preserves the legacy daily behavior).
            idx = idx.tz_localize("UTC")
    else:
        idx = idx.tz_convert("UTC")

    if horizon == "4h":
        return _match_intraday_bars(idx, df, target_dts)
    return _match_daily_closes(idx, df, target_dts)


def _match_intraday_bars(
    idx: pd.DatetimeIndex, df: pd.DataFrame, target_dts: list[datetime.datetime]
) -> dict[str, float]:
    """For each target_at (UTC-aware), pick the 1h bar that contains it, or the
    first bar at/after it if none contains it (target outside session).

    Keyed by the target_at's own ISO timestamp (so the caller's lookup via
    `_realized_lookup_key(target_ts, "4h")` resolves directly). A target_at at
    04:00 ET and one at 20:00 ET on the same day therefore map to DIFFERENT bars
    (and typically different closes) — which is exactly what the daily-close bug
    was collapsing into a single value per day.
    """
    import numpy as np

    # Drop NaT rows that tz localization may have produced (ambiguous DST bars).
    bar_starts = pd.DatetimeIndex(idx)
    valid = bar_starts.notna()
    starts_arr = bar_starts[valid]
    closes_arr = pd.Series(df["Close"].values)[valid].astype(float).to_numpy()

    # Convert bar starts to integer epoch-NANOSECONDS for a timezone-safe
    # searchsorted. Three traps handled here:
    #  1. Mixing tz-aware datetimes with numpy datetime64 raises
    #     "Cannot compare tz-naive and tz-aware" — so we compare plain ints.
    #  2. yfinance returns intraday indices at non-ns resolution (datetime64[s]
    #     on some builds), whose int view is epoch-SECONDS — not nanoseconds.
    #     pd.Timestamp.value is always epoch-ns, so we MUST force ns resolution
    #     via .as_unit("ns") before reading .asi8, or searchsorted silently
    #     returns len(array) and every lookup misses.
    #  3. .asi8 guarantees the int64 ns view of a DatetimeIndex.
    starts_ns = np.asarray(pd.DatetimeIndex(starts_arr).as_unit("ns").asi8)

    one_hour_ns = 3600 * 1_000_000_000
    result: dict[str, float] = {}
    for tgt in target_dts:
        tgt_ns = pd.Timestamp(tgt).value  # epoch nanoseconds, tz-aware-safe
        # Containing bar: bar_start <= tgt < bar_start + 1h.
        # searchsorted(side='right') → index of first bar_start strictly > tgt;
        # so the candidate containing bar sits at that index - 1.
        pos = int(np.searchsorted(starts_ns, tgt_ns, side="right"))
        chosen_idx = None
        if pos > 0:
            cand_start_ns = int(starts_ns[pos - 1])
            if cand_start_ns <= tgt_ns < cand_start_ns + one_hour_ns:
                chosen_idx = pos - 1
        if chosen_idx is None:
            # Target outside regular session (before open / after last bar):
            # take the first bar at or after target_at (next session's open bar).
            pos_left = int(np.searchsorted(starts_ns, tgt_ns, side="left"))
            if pos_left >= len(starts_ns):
                continue  # no future bar available yet; retry next run
            chosen_idx = pos_left
        try:
            close = float(closes_arr[chosen_idx])
        except (ValueError, TypeError, IndexError):
            continue
        if close and close > 0:
            result[tgt.isoformat()] = close
    return result


def _match_daily_closes(
    idx: pd.DatetimeIndex, df: pd.DataFrame, target_dts: list[datetime.datetime]
) -> dict[str, float]:
    """Map each target_at's calendar day to the daily close (UTC-aware index).

    Keyed by 'YYYY-MM-DD'. The daily close of target_at's day is the realized
    price at the 1d forecast's true horizon (~5 business days).
    """
    closes = df["Close"]
    result: dict[str, float] = {}
    for ts, close in zip(idx, closes):
        try:
            c = float(close)
        except (ValueError, TypeError):
            continue
        if not (c and c > 0):
            continue
        day_key = pd.Timestamp(ts).strftime("%Y-%m-%d")
        result[day_key] = c
    return result


# ---------------------------------------------------------------------------
# Manual entry point (for local testing)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Kronos forecast verification tracker.")
    parser.add_argument("--forecast", default=os.path.join(SCRIPTS_DIR, "../data/kronos_forecast.json"),
                        help="Path to kronos_forecast.json")
    parser.add_argument("--history", default=HISTORY_PATH,
                        help="Path to kronos_forecast_history.json")
    parser.add_argument("--no-fetch", action="store_true",
                        help="Skip yfinance realized-price download (record only).")
    args = parser.parse_args()

    print("forecast_tracker: scoring matured forecasts...")
    score_matured_forecasts(args.history, fetch_realized=not args.no_fetch)
    print("forecast_tracker: appending current forecast snapshot...")
    append_forecast_snapshot(args.forecast, args.history)
    print("forecast_tracker: done.")
