import React, { useState, useMemo, useRef } from 'react';
import { UseOptionsDataReturn } from '../hooks/useOptionsData';
import { IconRefresh } from './Icons';
import { KRONOS_TIMEFRAMES, getActiveKronosForecast, type KronosTimeframe, type ActiveKronosForecast } from '../lib/kronos';

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

type DisplayMode = 'futures' | 'etf';

// ===========================================================================
// Sub-component: Control bar
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
  displayMode, setDisplayMode, refreshing, handleRefresh, timeSinceUpdate,
}: KronosControlBarProps) {
  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Market selector (synchronized) */}
        <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800 shrink-0">
          <button
            onClick={() => setMarket('SP500')}
            className="px-3 py-1.5 rounded-md text-xs font-semibold transition-all duration-150"
            style={{
              backgroundColor: market === 'SP500' ? '#1e293b' : 'transparent',
              color: market === 'SP500' ? '#e2e8f0' : '#64748b',
            }}
          >
            🇺🇸 S&P 500
          </button>
          <button
            onClick={() => setMarket('NASDAQ100')}
            className="px-3 py-1.5 rounded-md text-xs font-semibold transition-all duration-150"
            style={{
              backgroundColor: market === 'NASDAQ100' ? '#1e293b' : 'transparent',
              color: market === 'NASDAQ100' ? '#e2e8f0' : '#64748b',
            }}
          >
            💻 Nasdaq 100
          </button>
        </div>

        {/* Timeframe selector */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Orizzonte:</span>
          <div className="flex items-center bg-[#0d1117] rounded-lg p-0.5 border border-slate-800">
            {KRONOS_TIMEFRAMES.map((tf) => (
              <button
                key={tf.key}
                onClick={() => setKronosTimeframe(tf.key)}
                className="px-2.5 py-1.5 rounded text-[10px] font-semibold transition-all duration-150"
                style={{
                  backgroundColor: kronosTimeframe === tf.key ? '#1e293b' : 'transparent',
                  color: kronosTimeframe === tf.key ? '#e2e8f0' : '#64748b',
                }}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>

        {/* Display Mode selector */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Unità:</span>
          <div className="flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800">
            <button
              onClick={() => setDisplayMode('futures')}
              className="px-2.5 py-1.5 rounded text-[10px] font-semibold transition-all duration-150"
              style={{
                backgroundColor: displayMode === 'futures' ? '#1e293b' : 'transparent',
                color: displayMode === 'futures' ? '#e2e8f0' : '#64748b',
              }}
            >
              Futures ({market === 'SP500' ? 'ES' : 'NQ'})
            </button>
            <button
              onClick={() => setDisplayMode('etf')}
              className="px-2.5 py-1.5 rounded text-[10px] font-semibold transition-all duration-150"
              style={{
                backgroundColor: displayMode === 'etf' ? '#1e293b' : 'transparent',
                color: displayMode === 'etf' ? '#e2e8f0' : '#64748b',
              }}
            >
              ETF ({market === 'SP500' ? 'SPY' : 'QQQ'})
            </button>
          </div>
        </div>
      </div>

      {/* Refresh button */}
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
        title={timeSinceUpdate ? `Aggiornato: ${timeSinceUpdate}` : 'Aggiorna'}
      >
        <IconRefresh className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        {timeSinceUpdate && (
          <span className="text-[11px] text-gray-500">Aggiornato: {timeSinceUpdate}</span>
        )}
      </button>
    </div>
  );
}

// ===========================================================================
// Sub-component: Summary cards
// ===========================================================================

interface KronosSummaryCardsProps {
  chartData: ChartData;
  kronosTimeframe: KronosTimeframe;
  market: 'SP500' | 'NASDAQ100';
  displayMode: DisplayMode;
}

function KronosSummaryCards({ chartData, kronosTimeframe, market, displayMode }: KronosSummaryCardsProps) {
  const isBullish = chartData.trendBias === 'BULLISH';
  const isBearish = chartData.trendBias === 'BEARISH';
  const biasBadgeColor = isBullish ? 'text-green-400 bg-green-500/10 border-green-500/20' : isBearish ? 'text-red-400 bg-red-500/10 border-red-500/20' : 'text-gray-400 bg-gray-500/10 border-gray-500/20';
  const biasLabel = isBullish ? '🟢 RIALZISTA' : isBearish ? '🔴 RIBASSISTA' : '🟡 NEUTRALE';

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-col justify-between min-h-[96px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Bias Previsionale ({kronosTimeframe})</span>
        <div className="flex items-center justify-between mt-2">
          <span className={`px-2.5 py-1 text-xs font-bold rounded-lg border ${biasBadgeColor}`}>
            {biasLabel}
          </span>
          <span className="text-[11px] text-gray-400 font-medium">
            Forza: {chartData.strengthPct > 0 ? '+' : ''}{chartData.strengthPct.toFixed(2)}%
          </span>
        </div>
      </div>

      <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-col justify-between min-h-[96px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Prezzo Spot Corrente</span>
        <div className="mt-2">
          <span className="text-xl font-bold text-slate-100">${chartData.liveSpot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          <span className="text-[10px] text-gray-500 block">Unit: {displayMode === 'futures' ? (market === 'SP500' ? 'ES' : 'NQ') : (market === 'SP500' ? 'SPY' : 'QQQ')}</span>
        </div>
      </div>

      <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-col justify-between min-h-[96px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Range Atteso Previsto</span>
        <div className="mt-2">
          <span className="text-sm font-semibold text-slate-200">
            ${chartData.expectedLow.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} - ${chartData.expectedHigh.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          </span>
          <span className="text-[10px] text-gray-500 block">Massima escursione attesa</span>
        </div>
      </div>

      <div className="bg-[#161b22] border border-slate-800 rounded-xl p-4 flex flex-col justify-between min-h-[96px]">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Volatilità Prevista</span>
        <div className="flex items-center justify-between mt-2">
          <span className="text-lg font-bold text-slate-200">
            {chartData.volatilityPct.toFixed(3)}%
          </span>
          <span className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded ${chartData.volatilityPct > 0.4 ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-green-500/10 text-green-400 border border-green-500/20'}`}>
            {chartData.volatilityPct > 0.4 ? 'Elevata' : 'Bassa'}
          </span>
        </div>
      </div>
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
    kronosTimeframe === '15m' || kronosTimeframe === '30m'
      ? '5m Interval'
      : kronosTimeframe === '1h' || kronosTimeframe === '2h'
        ? '15m Interval'
        : kronosTimeframe === '4h' || kronosTimeframe === 'EOD'
          ? '1h Interval'
          : kronosTimeframe === '2D' || kronosTimeframe === '3D'
            ? '4h Interval'
            : 'Daily Interval';

  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 lg:p-6 flex flex-col gap-3 relative">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-bold text-slate-300">
          📈 Traiettoria Previsionale & Candele Proiettate ({intervalLabel})
        </h3>
        <span className="text-[10px] text-gray-500 font-mono">
          Spostati sul grafico per ispezionare le candele
        </span>
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
// Sub-component: Detailed predictions table
// ===========================================================================

interface KronosDataTableProps {
  chartData: ChartData;
  hoveredIndex: number | null;
  setHoveredIndex: (idx: number | null) => void;
}

function KronosDataTable({ chartData, hoveredIndex, setHoveredIndex }: KronosDataTableProps) {
  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl p-4 flex flex-col gap-3">
      <h3 className="text-sm font-bold text-slate-300">📊 Tabella Dati Previsionali Kronos AI</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-850">
        <table className="min-w-full text-xs text-left text-gray-300">
          <thead className="bg-[#0d1117] text-gray-400 uppercase tracking-wider text-[9px] font-bold border-b border-slate-850">
            <tr>
              <th className="px-4 py-3"># Candela</th>
              <th className="px-4 py-3">Orizzonte</th>
              <th className="px-4 py-3">Orario Previsto</th>
              <th className="px-4 py-3">Apertura</th>
              <th className="px-4 py-3">Massimo</th>
              <th className="px-4 py-3">Minimo</th>
              <th className="px-4 py-3">Chiusura</th>
              <th className="px-4 py-3">Variazione Spot</th>
              <th className="px-4 py-3">Oscillazione Max</th>
              <th className="px-4 py-3 text-right">Volume Futures</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-850">
            {/* Row for starting spot */}
            <tr className="bg-slate-900/20 text-gray-400 font-semibold italic">
              <td className="px-4 py-2.5">-</td>
              <td className="px-4 py-2.5">Spot</td>
              <td className="px-4 py-2.5">Inizio</td>
              <td className="px-4 py-2.5">-</td>
              <td className="px-4 py-2.5">-</td>
              <td className="px-4 py-2.5">-</td>
              <td className="px-4 py-2.5">${chartData.liveSpot.toFixed(2)}</td>
              <td className="px-4 py-2.5">0.00%</td>
              <td className="px-4 py-2.5">-</td>
              <td className="px-4 py-2.5 text-right">-</td>
            </tr>
            {chartData.candles.map((c, idx) => {
              const isBullishCandle = c.close >= c.open;
              const swingPct = ((c.high - c.low) / c.open) * 100;

              return (
                <tr
                  key={idx}
                  className="hover:bg-slate-900/40 transition-colors"
                  style={{
                    backgroundColor: hoveredIndex === idx ? 'rgba(59, 130, 246, 0.05)' : 'transparent'
                  }}
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  <td className="px-4 py-2.5 font-bold text-gray-500">#{idx + 1}</td>
                  <td className="px-4 py-2.5 font-semibold text-slate-200">{c.label}</td>
                  <td className="px-4 py-2.5 text-gray-400">{c.formattedTime}</td>
                  <td className="px-4 py-2.5 font-mono">${c.open.toFixed(2)}</td>
                  <td className="px-4 py-2.5 font-mono text-green-400/80">${c.high.toFixed(2)}</td>
                  <td className="px-4 py-2.5 font-mono text-red-400/80">${c.low.toFixed(2)}</td>
                  <td className="px-4 py-2.5 font-mono font-bold" style={{ color: isBullishCandle ? '#10b981' : '#ef4444' }}>
                    ${c.close.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 font-mono font-bold" style={{ color: c.changePct >= 0 ? '#10b981' : '#ef4444' }}>
                    {c.changePct >= 0 ? '+' : ''}{c.changePct.toFixed(2)}%
                  </td>
                  <td className="px-4 py-2.5 font-mono text-gray-400">{swingPct.toFixed(2)}%</td>
                  <td className="px-4 py-2.5 font-mono text-right text-gray-450">{c.rawVolume.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
  const [kronosTimeframe, setKronosTimeframe] = useState<KronosTimeframe>('1h');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('futures');
  // Shared hover state between chart and table (hover one, the other highlights)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Get active forecast bias item
  const biasItem = useMemo(() => {
    if (!kronosForecast) return null;
    return market === 'SP500' ? kronosForecast.SP500_bias : kronosForecast.NASDAQ_bias;
  }, [kronosForecast, market]);

  // Dynamically calculate conversion ratios based on Futures
  const futuresRatio = useMemo(() => {
    const futuresSymbol = market === 'SP500' ? 'ES' : 'NQ';
    const fSpot = liveSpot[futuresSymbol as keyof typeof liveSpot];
    if (fSpot && etfData?.spot) {
      return fSpot / etfData.spot;
    }
    return market === 'SP500' ? 10.05 : 41.2;
  }, [liveSpot, etfData, market]);

  // ---- Active chart data (timeframe→resolution + candle scaling now in lib/kronos.ts) ----
  const chartData = useMemo(() => {
    if (!biasItem || !etfData || !etfData.spot) return null;
    const multiplier = displayMode === 'futures' ? futuresRatio : 1.0;
    const forecast = getActiveKronosForecast(biasItem, etfData.spot, kronosTimeframe, { multiplier });
    if (!forecast) return null;
    // Map canonical `lastPrice` → `liveSpot` to preserve the JSX interface below.
    return { ...forecast, liveSpot: forecast.lastPrice } as ChartData;
  }, [biasItem, etfData, futuresRatio, displayMode, kronosTimeframe]);

  return (
    <div className="max-w-[1850px] mx-auto px-4 sm:px-6 lg:px-8 py-6 flex-1 flex flex-col gap-6">
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
            market={market}
            displayMode={displayMode}
          />
          <KronosForecastChart
            chartData={chartData}
            kronosTimeframe={kronosTimeframe}
            hoveredIndex={hoveredIndex}
            setHoveredIndex={setHoveredIndex}
          />
          <KronosDataTable
            chartData={chartData}
            hoveredIndex={hoveredIndex}
            setHoveredIndex={setHoveredIndex}
          />
        </>
      )}
    </div>
  );
};
