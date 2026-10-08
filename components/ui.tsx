import React, { useState, useRef, useEffect } from 'react';

/**
 * Shared UI kit — one implementation of the visual primitives that every
 * view used to hand-roll with duplicated Tailwind class strings:
 *
 *   Segmented   pill selector (market, timeframe, filters…)
 *   Card        the standard panel container
 *   StatCard    label / value / sub
 *   Badge       tone-coloured pill (good / warn / bad / info / violet / neutral)
 *   Collapsible accordion section (guides, diagnostics)
 *   InfoHint    ⓘ popover for legends — replaces always-visible legend blocks
 *
 * @module components/ui
 */

// ---------------------------------------------------------------------------
// Segmented — pill selector
// ---------------------------------------------------------------------------

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  title?: string;
}

export function Segmented<T extends string | number>({
  options, value, onChange, size = 'sm', className = '',
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const pad = size === 'xs' ? 'px-2 py-1 text-[10px]' : 'px-3 py-1.5 text-xs';
  return (
    <div className={`inline-flex bg-[#0d1117] rounded-lg p-0.5 border border-slate-800 ${className}`}>
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            key={String(o.value)}
            onClick={() => onChange(o.value)}
            title={o.title}
            aria-pressed={selected}
            className={`${pad} rounded-md font-semibold transition-all duration-150 whitespace-nowrap`}
            style={{
              backgroundColor: selected ? '#1e293b' : 'transparent',
              color: selected ? '#e2e8f0' : '#64748b',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** "Etichetta: [controllo]" — the labelled control wrapper used in control bars. */
export function Labeled({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-center gap-1.5" title={title}>
      <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">{label}</span>
      {children}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Card / StatCard / Badge
// ---------------------------------------------------------------------------

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#161b22] border border-slate-800 rounded-2xl p-4 ${className}`}>
      {children}
    </div>
  );
}

export type BadgeTone = 'good' | 'warn' | 'bad' | 'info' | 'violet' | 'neutral';

const BADGE_TONES: Record<BadgeTone, string> = {
  good: 'bg-green-500/10 text-green-400 border-green-500/20',
  warn: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  bad: 'bg-red-500/10 text-red-400 border-red-500/20',
  info: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  violet: 'bg-violet-500/10 text-violet-300 border-violet-500/20',
  neutral: 'bg-slate-700/40 text-slate-400 border-slate-700',
};

export function Badge({ tone = 'neutral', children, title, className = '' }: {
  tone?: BadgeTone;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center px-2 py-0.5 text-[9px] font-bold rounded border ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatCard({ label, value, sub, valueTone = 'text-slate-100', title }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueTone?: string;
  title?: string;
}) {
  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-xl p-3 flex flex-col justify-between min-h-[76px]" title={title}>
      <span className="text-[9px] text-gray-500 uppercase tracking-wider font-semibold">{label}</span>
      <span className={`text-lg font-bold tnum ${valueTone} mt-1`}>{value}</span>
      {sub != null && <span className="text-[9px] text-gray-500 tnum">{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible — accordion section
// ---------------------------------------------------------------------------

export function Collapsible({ title, icon, children, defaultOpen = false, hint }: {
  title: string;
  icon?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  hint?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-[#161b22] border border-slate-800 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-800/20 transition-colors"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-gray-300">
          {icon && <span>{icon}</span>}
          {title}
          {hint && <span className="text-[10px] font-normal text-gray-500 hidden sm:inline">— {hint}</span>}
        </span>
        <span className={`text-[10px] text-gray-500 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-slate-800/60 animate-fadeIn flex flex-col gap-5">
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton — shimmering placeholder blocks (loading states)
// ---------------------------------------------------------------------------

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-800/70 ${className}`} />;
}

/** Card-shaped skeleton row: label bar + big value bar. */
export function SkeletonStat({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-[#161b22] border border-slate-800 rounded-xl p-3 flex flex-col gap-2 ${className}`}>
      <Skeleton className="h-2 w-1/3" />
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-2 w-1/2" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// InfoHint — ⓘ popover for legends (click outside / again to close)
// ---------------------------------------------------------------------------

export function InfoHint({ title, children, width = 420 }: {
  title: string;
  children: React.ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="w-5 h-5 rounded-full border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 text-[10px] font-bold flex items-center justify-center transition-colors"
        title={title}
        aria-label={title}
      >
        ⓘ
      </button>
      {open && (
        <div
          className="absolute right-0 top-7 z-50 bg-[#0d1117] border border-slate-700 rounded-xl p-3.5 shadow-2xl animate-fadeIn text-[11px] text-gray-300 leading-relaxed max-h-[70vh] overflow-y-auto custom-scrollbar"
          style={{ width: `${width}px` }}
        >
          <div className="font-bold text-slate-200 mb-2">{title}</div>
          {children}
        </div>
      )}
    </div>
  );
}
