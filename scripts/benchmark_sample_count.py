"""
Benchmark del wall-clock cost di `sample_count` in Kronos inference.

Obiettivo: scegliere il valore di KRONOS_SAMPLE_COUNT che tenga le 4 chiamate
di run_kronos.py (2 simboli x 2 orizzonti) sotto il budget CI di ~10 min,
riducendo al contempo il rumore di campionamento (la causa #1 delle
contraddizioni 4h long / 1d short).

Misure per sample_count ∈ {1, 4, 8, 16} su un singolo forecast (SPY/4h e SPY/1d),
poi proietta il costo totale stimato (x4 chiamate).

Uso:
    python scripts/benchmark_sample_count.py
    python scripts/benchmark_sample_count.py --horizons 4h
    python scripts/benchmark_sample_count.py --sample-counts 1 4 8
"""

import os
import sys
import time
import argparse

import numpy as np
import pandas as pd
import yfinance as yf
import torch

# Set up paths to import local model code
scripts_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(scripts_dir)

from model.kronos import Kronos, KronosTokenizer, KronosPredictor
from run_kronos import generate_future_trading_timestamps


def build_context(symbol: str, interval: str, period: str, context_len: int, ratio: float):
    """Replica minimale di run_forecast_for_resolution (solo prezzo, niente covariate).

    Il costo dominante è auto_regressive_inference; le covariate aggiungono solo
    un merge + piccolo MLP forward, trascurabili ai fini del timing. Omettendole
    evitiamo la dipendenza da options_data.json/options_history.json.
    """
    futures_map = {"SPY": "ES=F", "QQQ": "NQ=F"}
    fetch_ticker = futures_map.get(symbol, symbol)

    if interval == "4h":
        df = yf.download(fetch_ticker, period=period, interval="1h")
    else:
        df = yf.download(fetch_ticker, period=period, interval=interval)

    if df.empty:
        raise ValueError(f"No data for {fetch_ticker} {interval}")

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=lambda x: x.lower())
    df = df[['open', 'high', 'low', 'close', 'volume']].dropna()

    if interval == "4h":
        df = df.resample('4h').agg({
            'open': 'first', 'high': 'max', 'low': 'min',
            'close': 'last', 'volume': 'sum'
        }).dropna()

    if ratio != 1.0:
        for col in ['open', 'high', 'low', 'close']:
            df[col] = df[col] / ratio

    # Covariate placeholder columns (required by predict() signature checks)
    df['volatility_skew_25d'] = 0.0
    df['put_call_oi_ratio'] = 1.0
    df['total_net_gex'] = 0.0

    context_df = df.tail(context_len).copy()
    for col in ['volume', 'volatility_skew_25d', 'put_call_oi_ratio', 'total_net_gex']:
        context_df[col] = context_df[col].astype(float)

    return context_df


def benchmark_one(predictor, context_df, interval, pred_len, sample_count, n_repeats=1):
    """Esegue predict() n_repeats volte, ritorna la media wall-clock (secondi)."""
    x_timestamp = pd.Series(context_df.index)
    y_timestamp = generate_future_trading_timestamps(
        context_df.index[-1], interval, pred_len
    )
    # Warmup con sample_count=1 (prima chiamata paga costi fissi di compilazione/cache)
    predictor.predict(
        df=context_df, x_timestamp=x_timestamp, y_timestamp=y_timestamp,
        pred_len=pred_len, T=0.7, top_k=5, top_p=0.9, sample_count=1, verbose=False,
    )

    times = []
    for _ in range(n_repeats):
        t0 = time.perf_counter()
        predictor.predict(
            df=context_df, x_timestamp=x_timestamp, y_timestamp=y_timestamp,
            pred_len=pred_len, T=0.7, top_k=5, top_p=0.9,
            sample_count=sample_count, verbose=False,
        )
        times.append(time.perf_counter() - t0)
    return float(np.mean(times)), float(np.std(times)) if len(times) > 1 else 0.0


def main():
    parser = argparse.ArgumentParser(description="Benchmark Kronos sample_count wall-clock cost")
    parser.add_argument("--symbol", type=str, default="SPY",
                        help="Simbolo da usare per la misura (default SPY; QQQ ~ equivalente per costo).")
    parser.add_argument("--horizons", type=str, nargs="+", default=["4h", "1d"],
                        choices=["4h", "1d"],
                        help="Quali orizzonti testare (4h=period 90d pred_len 6, 1d=period 2y pred_len 5)")
    parser.add_argument("--sample-counts", type=int, nargs="+", default=[1, 4, 8, 16])
    parser.add_argument("--context-len", type=int, default=256)
    parser.add_argument("--repeats", type=int, default=1,
                        help="Quante volte misurare ogni (symbol,horizon,sample_count) per ridurre il rumore")
    args = parser.parse_args()

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    print(f"Loading tokenizer (NeoQuasar/Kronos-Tokenizer-2k)...")
    tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-2k")
    print(f"Loading model weights (NeoQuasar/Kronos-mini)...")
    model = Kronos.from_pretrained("NeoQuasar/Kronos-mini")
    predictor = KronosPredictor(model, tokenizer, device=device, max_context=2048)
    # Disattiva l'adapter: stiamo misurando il costo di Kronos inference pura,
    # che è ciò che scala con sample_count. L'adapter è un singolo MLP forward.
    predictor.adapter = None

    horizon_cfg = {
        "4h": ("4h", "90d", 6, 10.09),  # SPY ratio
        "1d": ("1d", "2y", 5, 10.09),
    }

    # Build contexts ONCE per horizon (download is the slow part).
    contexts = {}
    for horizon in args.horizons:
        interval, period, pred_len, ratio = horizon_cfg[horizon]
        print(f"\n--- Building context for {args.symbol} {horizon} (interval={interval}, period={period}) ---")
        contexts[horizon] = build_context(args.symbol, interval, period, args.context_len, ratio)
        print(f"    context rows: {len(contexts[horizon])}")

    print("\n" + "=" * 80)
    print(f"{'symbol':<8}{'horizon':<10}{'context':<10}{'sample_count':<16}{'mean_s':<12}{'std_s':<12}{'x_vs_1':<10}")
    print("=" * 80)

    # results[(horizon, sample_count)] = mean_s
    results = {}
    baseline_times = {}  # horizon -> time at sample_count=1

    for horizon in args.horizons:
        interval, period, pred_len, _ = horizon_cfg[horizon]
        ctx = contexts[horizon]
        for sc in args.sample_counts:
            mean_s, std_s = benchmark_one(
                predictor, ctx, interval, pred_len, sc, n_repeats=args.repeats
            )
            results[(horizon, sc)] = mean_s
            if sc == 1:
                baseline_times[horizon] = mean_s
            base = baseline_times.get(horizon, mean_s)
            x_vs_1 = mean_s / base if base > 0 else float('nan')
            print(f"{args.symbol:<8}{horizon:<10}{args.context_len:<10}{sc:<16}{mean_s:<12.2f}{std_s:<12.2f}{x_vs_1:<10.2f}x")

    # Proiezione del costo totale di un run completo di run_kronos.py
    # (2 simboli x 2 orizzonti = 4 chiamate). QQQ assumed ~equal to SPY
    # (stesso modello, stesso context_len, stessi pred_len).
    print("\n" + "=" * 80)
    print(f"PROIEZIONE COSTO TOTALE run_kronos.py (4 chiamate: {args.symbol}+QQQ x {args.horizons})")
    print(f"Assunzione: QQQ costa ~ come {args.symbol} (stesso modello/context/pred_len).")
    print("=" * 80)

    header_parts = ["sample_count"]
    for h in args.horizons:
        header_parts += [f"{h}_s({args.symbol})", f"{h}_s(QQQ)*"]
    header_parts += ["TOTALE_s", "TOTALE_min"]
    widths = [16] + [14] * (2 * len(args.horizons)) + [12, 12]
    fmt = "".join(f"{{:<{w}}}" for w in widths)
    print(fmt.format(*header_parts))
    print("-" * sum(widths))

    for sc in args.sample_counts:
        row = [str(sc)]
        total = 0.0
        ok = True
        for h in args.horizons:
            t = results.get((h, sc))
            if t is None:
                row += ["N/A", "N/A"]
                ok = False
            else:
                row += [f"{t:.2f}", f"{t:.2f}"]
                total += 2 * t  # SPY + QQQ
        if ok:
            row += [f"{total:.2f}", f"{total/60:.2f}"]
        else:
            row += ["N/A", "N/A"]
        print(fmt.format(*row))

    print("\n" + "=" * 80)
    print("Budget CI run_kronos.py: timeout-minutes=15, freshness guard 8min,")
    print("meno overhead (~3min: download + model load) => obiettivo < ~10min per le 4 chiamate.")
    print("Scegliere il sample_count massimo il cui TOTALE_min sta sotto questo budget.")
    print("=" * 80)


if __name__ == "__main__":
    main()
