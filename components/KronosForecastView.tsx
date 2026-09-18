import React, { useState, useMemo, useRef } from 'react';
import { UseOptionsDataReturn } from '../hooks/useOptionsData';
import { ControlBar, Segmented, Labeled, Card, Badge, InfoHint } from './ui';
import { KRONOS_TIMEFRAMES, getActiveKronosForecast, type KronosTimeframe, type ActiveKronosForecast } from '../lib/kronos';
import type { KronosCoherence } from '../types';

// ===========================================================================
// Shared types
// ===========================================================================

interface KronosForecastViewProps {
  sharedState: UseOptionsDataReturn;
}

/**
 * Chart-ready forecast payload. Identical to ActiveKronosForecast plus a
 * `liveSpot` alias for lastPrice (kept for back-compat with the JSX below).
 */
type ChartData = ActiveKronosForecast & { liveSpot: number };

type DisplayMode = 'futures' | 'index' | 'etf';

// ===========================================================================
// Sub-component: Control bar (shared kit — market / horizon / unit / freshness)
// ===========================================================================

interface KronosControlBarProps {
  market: 'SP500' | 'NASDAQ100';
  setMarket: (m: 'SP500' | 'NASDAQ100') => void;
  kronosTimeframe: KronosTimeframe;
  setKronosTimeframe: (tf: KronosTimeframe) => void;
  displayMode: DisplayMode;
  setDisplayMode: (m: DisplayMode) => void;
  refreshing: boolean;
  handleRefresh: () => void;
  timeSinceUpdate: string;
}

function KronosControlBar({
  market, setMarket, kronosTimeframe, setKronosTimeframe,
  displayMode, setDisplayMode,
  refreshing, handleRefresh, timeSinceUpdate,
}: KronosControlBarProps) {
  return (
    <ControlBar
      left={
        <>
          <Segmented
            value={market}
            onChange={(m) => setMarket(m)}
            options={[
              { value: 'SP500', label: '🇺🇸 S&P 500' },
              { value: 'NASDAQ100', label: '💻 Nasdaq 100' },
            ]}
          />
          <Labeled label="Orizzonte">
            <Segmented
              value={kronosTimeframe}
              onChange={(tf) => setKronosTimeframe(tf)}
              options={KRONOS_TIMEFRAMES.map((tf) => ({ value: tf.key, label: tf.label }))}
            />
          </Labeled>
          <Labeled label="Unità">
            <Segmented
              value={displayMode}
              onChange={(m) => setDisplayMode(m)}
              options={[
                { value: 'futures', label: `Futures (${market === 'SP500' ? 'ES' : 'NQ'})` },
                { value: 'index', label: `Index (${market === 'SP500' ? 'SPX' : 'NDX'})`, title: 'Scala indice — coincide con i muri della dashboard Volumi' },
                { value: 'etf', label: `ETF (${market === 'SP500' ? 'SPY' : 'QQQ'})` },
              ]}
            />
          </Labeled>
        </>
      }
      right={
        <span className="text-[11px] text-gray-500 tnum">aggiornato {timeSinceUpdate}</span>
      }
    />
  );
}

// ===========================================================================
// Sub-component: Summary cards

interface KronosSummaryCardsProps {
  chartData: ChartData;
  kronosTimeframe: KronosTimeframe;
  /** Coerenza direzionale tra i due orizzonti (4h vs 1d). Opzionale: i forecast
   *  generati prima di questa feature non la contengono. */
  coherence?: KronosCoherence;
}

function KronosSummaryCards({ chartData, kronosTimeframe, coherence }: KronosSummaryCardsProps) {
  const isBullish = chartData.trendBias === 'BULLISH';
  const isBearish = chartData.trendBias === 'BEARISH';

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* 1. Bias + Coerenza (merged: the bias is only as solid as the agreement) */}
      <Card className="flex flex-col justify-between min-h-[96px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Bias Previsionale ({kronosTimeframe})</span>
        <div className="flex items-center justify-between mt-2 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge tone={isBullish ? 'good' : isBearish ? 'bad' : 'neutral'} className="!text-xs !px-2.5 !py-1">
              {isBullish ? '🟢 RIALZISTA' : isBearish ? '🔴 RIBASSISTA' : '🟡 NEUTRALE'}
            </Badge>
            <span className="text-[11px] text-gray-400 font-medium tnum">
              Forza: {chartData.strengthPct > 0 ? '+' : ''}{chartData.strengthPct.toFixed(2)}%
            </span>
          </div>
          {coherence && (
            <div className="flex items-center gap-1.5" title={`Coerenza tra orizzonti — score ${coherence.score}`}>
              <Badge tone={coherence.label === 'CONCORDI' ? 'good' : coherence.label === 'DISCORDI' ? 'bad' : 'warn'}>
                {coherence.label} {coherence.score}
              </Badge>
              <span className={`text-[10px] tnum ${coherence.strength_4h_pct >= 0 ? 'text-green-500/80' : 'text-red-500/80'}`}>
                4h {coherence.strength_4h_pct >= 0 ? '▲' : '▼'}{Math.abs(coherence.strength_4h_pct).toFixed(2)}%
              </span>
              <span className={`text-[10px] tnum ${coherence.strength_1d_pct >= 0 ? 'text-green-500/80' : 'text-red-500/80'}`}>
                1d {coherence.strength_1d_pct >= 0 ? '▲' : '▼'}{Math.abs(coherence.strength_1d_pct).toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      </Card>

      {/* 2. Range atteso */}
      <Card className="flex flex-col justify-between min-h-[96px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Range Atteso Previsto</span>
        <div className="mt-2">
          <span className="text-sm font-semibold text-slate-200 tnum">
            ${chartData.expectedLow.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} - ${chartData.expectedHigh.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          </span>
          <span className="text-[10px] text-gray-500 block">
            {chartData.hasConfidenceBand ? 'Banda esterna (p10–p90, Monte Carlo)' : 'Massima escursione attesa'}
          </span>
          {chartData.expectedHighP50 != null && chartData.expectedLowP50 != null && (
            <span className="text-[10px] text-blue-300/70 block mt-0.5 tnum">
              Più probabile: ${chartData.expectedLowP50.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} – ${chartData.expectedHighP50.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </span>
          )}
        </div>
      </Card>

      {/* 3. Volatilità */}
      <Card className="flex flex-col justify-between min-h-[96px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Volatilità Prevista</span>
        <div className="flex items-center justify-between mt-2">
          <span className="text-lg font-bold text-slate-200 tnum">
            {chartData.volatilityPct.toFixed(3)}%
          </span>
          <Badge tone={chartData.volatilityPct > 0.4 ? 'bad' : 'good'} className="!text-[9px] !px-2 !py-0.5">
            {chartData.volatilityPct > 0.4 ? 'ELEVATA' : 'BASSA'}
          </Badge>
        </div>
      </Card>
    </div>
  );
}

// ===========================================================================
// Sub-component: Interactive candlestick chart (SVG)
// ===========================================================================

interface KronosForecastChartProps {
  chartData: ChartData;
  kronosTimeframe: KronosTimeframe;
  hoveredIndex: number | null;
  setHoveredIndex: (idx: number | null) => void;
}

function KronosForecastChart({ chartData, kronosTimeframe, hoveredIndex, setHoveredIndex }: KronosForecastChartProps) {
  const chartRef = useRef<SVGSVGElement | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    if (!chartRef.current || chartData.candles.length === 0) return;

    const rect = chartRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const paddingLeft = 60;
    const paddingRight = 20;
    const chartWidth = rect.width;
    const drawableWidth = chartWidth - paddingLeft - paddingRight;

    const candleCount = chartData.candles.length;
    const slotWidth = drawableWidth / candleCount;

    const relativeX = x - paddingLeft;
    let idx = Math.floor(relativeX / slotWidth);
    if (idx < 0) idx = 0;
    if (idx >= candleCount) idx = candleCount - 1;

    setHoveredIndex(idx);
    setTooltipPos({ x: e.clientX - rect.left + 15, y: e.clientY - rect.top - 70 });
  };

  const handleMouseLeave = () => {
    setHoveredIndex(null);
    setTooltipPos(null);
  };

  // SVG Chart Geometry
  const svgDimensions = useMemo(() => {
    const padding = { left: 60, right: 20, top: 40, bottom: 40 };
    const width = 800;
    const height = 360;
    const drawableWidth = width - padding.left - padding.right;
    const drawableHeight = height - padding.top - padding.bottom;

    if (!chartData || chartData.candles.length === 0) {
      return { padding, width, height, drawableWidth, drawableHeight, priceGrid: [], scaleY: (v: number) => 0 };
    }

    const prices = [
      chartData.liveSpot,
      ...chartData.candles.flatMap(c => [c.high, c.low])
    ];

    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 1;

    const yMin = minP - range * 0.08;
    const yMax = maxP + range * 0.08;
    const yRange = yMax - yMin;

    const scaleY = (val: number) => {
      return height - padding.bottom - ((val - yMin) / yRange) * drawableHeight;
    };

    const gridCount = 5;
    const priceGrid = Array.from({ length: gridCount }).map((_, i) => {
      const price = yMin + (i / (gridCount - 1)) * yRange;
      const y = scaleY(price);
      return { price, y };
    });

    return { padding, width, height, drawableWidth, drawableHeight, priceGrid, scaleY };
  }, [chartData]);

  const volumeScaleY = useMemo(() => {
    if (!chartData || chartData.candles.length === 0) return (v: number) => 0;
    const maxVol = Math.max(...chartData.candles.map(c => c.rawVolume)) || 1;

    const volumeHeight = 50;
    const bottomBase = svgDimensions.height - svgDimensions.padding.bottom;

    return (vol: number) => {
      return bottomBase - (vol / maxVol) * volumeHeight;
    };
  }, [chartData, svgDimensions]);

  const isBullish = chartData.trendBias === 'BULLISH';
  const isBearish = chartData.trendBias === 'BEARISH';

  const intervalLabel =
    kronosTimeframe === '4h' ? '4h Interval' : 'Daily Interval';

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 lg:p-6 flex flex-col gap-3 relative">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h3 className="text-sm font-bold text-slate-300">
          📈 Traiettoria Previsionale & Candele Proiettate ({intervalLabel})
        </h3>
        <div className="flex items-center gap-3">
          {chartData.hasConfidenceBand && (
            <span className="flex items-center gap-1.5 text-[10px] text-blue-300/80 font-mono">
              <span className="inline-block w-3 h-2.5 rounded-sm" style={{ background: 'rgba(59,130,246,0.25)', border: '1px solid rgba(59,130,246,0.4)' }} />
              Banda 80% (p10–p90)
            </span>
          )}
          <span className="text-[10px] text-gray-500 font-mono">
            Spostati sul grafico per ispezionare le candele
          </span>
        </div>
      </div>

      <div className="relative w-full overflow-hidden bg-slate-950/40 rounded-xl border border-slate-900/60 p-2">
        <svg
          ref={chartRef}
          viewBox={`0 0 ${svgDimensions.width} ${svgDimensions.height}`}
          width="100%"
          height="100%"
          className="overflow-visible select-none cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/* Grid Lines */}
          {svgDimensions.priceGrid.map((grid, idx) => (
            <g key={idx}>
              <line
                x1={svgDimensions.padding.left}
                y1={grid.y}
                x2={svgDimensions.width - svgDimensions.padding.right}
                y2={grid.y}
                stroke="#1e293b"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
              <text
                x={svgDimensions.padding.left - 8}
                y={grid.y + 4}
                fill="#64748b"
                fontSize="10"
                fontWeight="semibold"
                textAnchor="end"
              >
                ${grid.price.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              </text>
            </g>
          ))}

          {/* Volume Grid Line */}
          <line
            x1={svgDimensions.padding.left}
            y1={svgDimensions.height - svgDimensions.padding.bottom}
            x2={svgDimensions.width - svgDimensions.padding.right}
            y2={svgDimensions.height - svgDimensions.padding.bottom}
            stroke="#334155"
            strokeWidth="1.5"
          />

          {/* Draw Volume Bars */}
          {chartData.candles.map((c, idx) => {
            const slotWidth = svgDimensions.drawableWidth / chartData.candles.length;
            const x = svgDimensions.padding.left + idx * slotWidth + slotWidth * 0.2;
            const w = slotWidth * 0.6;
            const y = volumeScaleY(c.rawVolume);
            const bottom = svgDimensions.height - svgDimensions.padding.bottom;
            const candleBullish = c.close >= c.open;
            const fill = candleBullish ? 'rgba(16,185,129,0.08)' : 'rgba(239,110,110,0.08)';
            const stroke = candleBullish ? 'rgba(16,185,129,0.18)' : 'rgba(239,110,110,0.18)';

            return (
              <rect
                key={idx}
                x={x}
                y={y}
                width={w}
                height={Math.max(1, bottom - y)}
                fill={fill}
                stroke={stroke}
                strokeWidth="1"
              />
            );
          })}

          {/* Draw Spot Baseline (Start price) */}
          <line
            x1={svgDimensions.padding.left}
            y1={svgDimensions.scaleY(chartData.liveSpot)}
            x2={svgDimensions.width - svgDimensions.padding.right}
            y2={svgDimensions.scaleY(chartData.liveSpot)}
            stroke="#ffffff"
            strokeWidth="1.5"
            strokeDasharray="2 3"
            opacity="0.3"
          />
          <text
            x={svgDimensions.width - svgDimensions.padding.right - 5}
            y={svgDimensions.scaleY(chartData.liveSpot) - 5}
            fill="#94a3b8"
            fontSize="9"
            textAnchor="end"
            opacity="0.8"
          >
            Spot: ${chartData.liveSpot.toFixed(2)}
          </text>

          {/* Monte Carlo 80% confidence band around the close trajectory
              (p10–p90 of the stochastic Kronos samples). Rendered behind the
              candlesticks so it reads as "uncertainty fog" under the path.
              Only drawn when the snapshot carries the percentile fields. */}
          {(() => {
            const slotWidth = svgDimensions.drawableWidth / chartData.candles.length;
            const hasBand = chartData.candles.every(
              c => c.close_p10 != null && c.close_p90 != null
            );
            if (!hasBand) return null;

            const xAt = (idx: number) =>
              svgDimensions.padding.left + idx * slotWidth + slotWidth / 2;
            const anchorX = svgDimensions.padding.left;
            const anchorY = svgDimensions.scaleY(chartData.liveSpot);

            // Upper edge (p90) left→right, then lower edge (p10) right→left.
            const upper = chartData.candles.map((c, idx) => ({
              x: xAt(idx),
              y: svgDimensions.scaleY(c.close_p90 as number),
            }));
            const lower = chartData.candles
              .map((c, idx) => ({
                x: xAt(idx),
                y: svgDimensions.scaleY(c.close_p10 as number),
              }))
              .reverse();

            const segs: string[] = [`M ${anchorX} ${anchorY}`];
            upper.forEach(p => segs.push(`L ${p.x} ${p.y}`));
            lower.forEach(p => segs.push(`L ${p.x} ${p.y}`));
            segs.push('Z');

            return (
              <path
                d={segs.join(' ')}
                fill="rgba(59,130,246,0.15)"
                stroke="rgba(59,130,246,0.35)"
                strokeWidth="0.75"
              />
            );
          })()}

          {/* Per-candle oscillation ticks: small marks at the p90 high and p10
              low of each candle, showing how wide the 80% excursion band is. */}
          {chartData.candles.map((c, idx) => {
            if (c.high_p90 == null && c.low_p10 == null) return null;
            const slotWidth = svgDimensions.drawableWidth / chartData.candles.length;
            const x = svgDimensions.padding.left + idx * slotWidth + slotWidth / 2;
            const tickW = slotWidth * 0.35;
            return (
              <g key={`mc-${idx}`} opacity={0.25}>
                {c.high_p90 != null && (
                  <line
                    x1={x - tickW / 2}
                    y1={svgDimensions.scaleY(c.high_p90)}
                    x2={x + tickW / 2}
                    y2={svgDimensions.scaleY(c.high_p90)}
                    stroke="#93c5fd"
                    strokeWidth="1"
                  />
                )}
                {c.low_p10 != null && (
                  <line
                    x1={x - tickW / 2}
                    y1={svgDimensions.scaleY(c.low_p10)}
                    x2={x + tickW / 2}
                    y2={svgDimensions.scaleY(c.low_p10)}
                    stroke="#93c5fd"
                    strokeWidth="1"
                  />
                )}
              </g>
            );
          })}

          {/* Draw Candlesticks */}
          {chartData.candles.map((c, idx) => {
            const slotWidth = svgDimensions.drawableWidth / chartData.candles.length;
            const x = svgDimensions.padding.left + idx * slotWidth + slotWidth / 2;
            const wickY1 = svgDimensions.scaleY(c.high);
            const wickY2 = svgDimensions.scaleY(c.low);
            const openY = svgDimensions.scaleY(c.open);
            const closeY = svgDimensions.scaleY(c.close);
            const bodyY = Math.min(openY, closeY);
            const bodyH = Math.max(1.5, Math.abs(openY - closeY));
            const candleBullish = c.close >= c.open;
            const color = candleBullish ? '#10b981' : '#ef4444';

            const candleW = slotWidth * 0.5;

            return (
              <g key={idx} opacity={hoveredIndex === null || hoveredIndex === idx ? 1.0 : 0.4} className="transition-opacity duration-100">
                <line
                  x1={x}
                  y1={wickY1}
                  x2={x}
                  y2={wickY2}
                  stroke={color}
                  strokeWidth="1.5"
                />
                <rect
                  x={x - candleW / 2}
                  y={bodyY}
                  width={candleW}
                  height={bodyH}
                  fill={candleBullish ? 'transparent' : color}
                  stroke={color}
                  strokeWidth="1.5"
                  rx="1"
                />
              </g>
            );
          })}

          {/* Draw Trend Line Connecting Closes */}
          {(() => {
            const slotWidth = svgDimensions.drawableWidth / chartData.candles.length;

            const points = [
              { x: svgDimensions.padding.left, y: svgDimensions.scaleY(chartData.liveSpot) },
              ...chartData.candles.map((c, idx) => ({
                x: svgDimensions.padding.left + idx * slotWidth + slotWidth / 2,
                y: svgDimensions.scaleY(c.close)
              }))
            ];

            const pathStr = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

            return (
              <path
                d={pathStr}
                fill="none"
                stroke={isBullish ? '#34d399' : isBearish ? '#f87171' : '#60a5fa'}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.85"
              />
            );
          })()}

          {/* X-axis labels */}
          {chartData.candles.map((c, idx) => {
            const skipCount = chartData.candles.length > 12 ? (chartData.candles.length > 20 ? 4 : 2) : 1;
            if (idx % skipCount !== 0) return null;

            const slotWidth = svgDimensions.drawableWidth / chartData.candles.length;
            const x = svgDimensions.padding.left + idx * slotWidth + slotWidth / 2;
            const y = svgDimensions.height - svgDimensions.padding.bottom + 16;

            return (
              <g key={idx}>
                <text
                  x={x}
                  y={y}
                  fill="#64748b"
                  fontSize="9"
                  fontWeight="semibold"
                  textAnchor="middle"
                >
                  {c.formattedTime}
                </text>
                <text
                  x={x}
                  y={y + 10}
                  fill="#475569"
                  fontSize="8"
                  textAnchor="middle"
                >
                  {c.label}
                </text>
              </g>
            );
          })}

          {/* Crosshair Cursor & Highlight */}
          {hoveredIndex !== null && (() => {
            const slotWidth = svgDimensions.drawableWidth / chartData.candles.length;
            const x = svgDimensions.padding.left + hoveredIndex * slotWidth + slotWidth / 2;
            const c = chartData.candles[hoveredIndex];
            const color = c.close >= c.open ? '#10b981' : '#ef4444';

            return (
              <g>
                <line
                  x1={x}
                  y1={svgDimensions.padding.top - 10}
                  x2={x}
                  y2={svgDimensions.height - svgDimensions.padding.bottom + 5}
                  stroke="#475569"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
                <circle
                  cx={x}
                  cy={svgDimensions.scaleY(c.close)}
                  r="4.5"
                  fill="#ffffff"
                  stroke={color}
                  strokeWidth="2"
                />
              </g>
            );
          })()}
        </svg>

        {/* Floating Tooltip HTML Overlay */}
        {hoveredIndex !== null && tooltipPos && (() => {
          const c = chartData.candles[hoveredIndex];
          const isBullishCandle = c.close >= c.open;
          const devFromSpot = c.changePct;

          return (
            <div
              className="absolute bg-slate-900/95 border border-slate-700/80 rounded-lg p-2.5 shadow-2xl text-[10px] text-gray-300 pointer-events-none flex flex-col gap-1 min-w-[150px] backdrop-blur-sm transition-all duration-75"
              style={{
                left: `${tooltipPos.x}px`,
                top: `${Math.max(10, Math.min(svgDimensions.height - 130, tooltipPos.y))}px`
              }}
            >
              <div className="flex justify-between border-b border-slate-800 pb-1 font-bold text-slate-100">
                <span>Candela #{hoveredIndex + 1}</span>
                <span className="text-gray-400">{c.label} ({c.formattedTime})</span>
              </div>
              <div className="flex justify-between">
                <span>Open:</span>
                <span className="font-mono">${c.open.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>High:</span>
                <span className="font-mono text-green-400/90">${c.high.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Low:</span>
                <span className="font-mono text-red-400/90">${c.low.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Close:</span>
                <span className="font-mono" style={{ color: isBullishCandle ? '#34d399' : '#f87171' }}>
                  ${c.close.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-800 pt-1">
                <span>Variazione:</span>
                <span className="font-mono font-bold" style={{ color: devFromSpot >= 0 ? '#34d399' : '#f87171' }}>
                  {devFromSpot >= 0 ? '+' : ''}{devFromSpot.toFixed(2)}%
                </span>
              </div>
              {c.close_p10 != null && c.close_p90 != null && (
                <div className="flex justify-between">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'rgba(59,130,246,0.5)' }} />
                    Banda 80% (close):
                  </span>
                  <span className="font-mono text-blue-300/90">
                    {c.close_p10.toFixed(2)} – {c.close_p90.toFixed(2)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Vol. Futures:</span>
                <span className="font-mono text-gray-400">{c.rawVolume.toLocaleString()}</span>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ===========================================================================
// Main component
// ===========================================================================

export const KronosForecastView: React.FC<KronosForecastViewProps> = ({ sharedState }) => {
  const {
    market,
    setMarket,
    kronosForecast,
    etfData,
    liveSpot,
    timeSinceUpdate,
    refreshing,
    handleRefresh
  } = sharedState;

  // Local UI State
  const [kronosTimeframe, setKronosTimeframe] = useState<KronosTimeframe>('1d');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('futures');
  // Shared hover state between chart and table (hover one, the other highlights)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Get active forecast bias item
  const biasItem = useMemo(() => {
    if (!kronosForecast) return null;
    return market === 'SP500' ? kronosForecast.SP500_bias : kronosForecast.NASDAQ_bias;
  }, [kronosForecast, market]);

  // Moltiplicatore di display: converte il forecast (in spazio ETF) nello
  // strumento selezionato. 'index' (SPX/NDX) coincide ESATTAMENTE con la scala
  // dei muri della dashboard Volumi; 'futures' (ES/NQ) con lo spot futures;
  // 'etf' lascia in spazio ETF. Derivato dagli spot LIVE, così la proiezione
  // è ancorata al prezzo corrente (vedi ri-ancoraggio in lib/kronos.ts).
  const displayMultiplier = useMemo(() => {
    if (!etfData?.spot) return 1.0;
    if (displayMode === 'etf') return 1.0;
    const sym = displayMode === 'futures'
      ? (market === 'SP500' ? 'ES' : 'NQ')
      : (market === 'SP500' ? 'SPX' : 'NDX');
    const ref = liveSpot[sym as keyof typeof liveSpot];
    // index ≈ futures ratio come fallback (NQ≈NDX, ES≈SPX in valore)
    const fallback = market === 'SP500' ? 10.05 : 41.2;
    return ref && ref > 0 ? ref / etfData.spot : fallback;
  }, [liveSpot, etfData, market, displayMode]);

  // ---- Active chart data (timeframe→resolution + candle scaling now in lib/kronos.ts) ----
  const chartData = useMemo(() => {
    if (!biasItem || !etfData || !etfData.spot) return null;
    const forecast = getActiveKronosForecast(biasItem, etfData.spot, kronosTimeframe, { multiplier: displayMultiplier });
    if (!forecast) return null;
    // Map canonical `lastPrice` → `liveSpot` to preserve the JSX interface below.
    return { ...forecast, liveSpot: forecast.lastPrice } as ChartData;
  }, [biasItem, etfData, displayMultiplier, kronosTimeframe]);

  return (
    <div className="flex-1 flex flex-col">
      {/* Sticky control bar — full width, sticks just below the App nav */}
      <div
        className="sticky z-40 bg-[#161b22]/95 backdrop-blur border-b border-slate-800"
        style={{ top: 'var(--app-nav-h, 0px)' }}
      >
        <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <KronosControlBar
            market={market}
            setMarket={setMarket}
            kronosTimeframe={kronosTimeframe}
            setKronosTimeframe={setKronosTimeframe}
            displayMode={displayMode}
            setDisplayMode={setDisplayMode}
            refreshing={refreshing}
            handleRefresh={handleRefresh}
            timeSinceUpdate={timeSinceUpdate}
          />
        </div>
      </div>

      <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-6 w-full">

      {!kronosForecast ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[400px] bg-[#161b22] border border-slate-800 rounded-2xl">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mb-4" />
          <span className="text-gray-400 text-sm">Caricamento proiezioni Kronos AI...</span>
        </div>
      ) : !chartData || chartData.candles.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[400px] bg-[#161b22] border border-slate-800 rounded-2xl p-6 text-center">
          <span className="text-gray-400 text-sm font-semibold mb-2">Nessun dato disponibile</span>
          <span className="text-gray-500 text-xs max-w-sm">Assicurati che lo script run_kronos.py abbia generato correttamente il file data/kronos_forecast.json e che i mercati siano supportati.</span>
        </div>
      ) : (
        <>
          <KronosSummaryCards
            chartData={chartData}
            kronosTimeframe={kronosTimeframe}
            coherence={biasItem?.coherence}
          />
          <KronosForecastChart
            chartData={chartData}
            kronosTimeframe={kronosTimeframe}
            hoveredIndex={hoveredIndex}
            setHoveredIndex={setHoveredIndex}
          />
        </>
      )}
      </div>
    </div>
  );
};
