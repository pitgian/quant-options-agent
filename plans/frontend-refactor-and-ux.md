# Refactoring & Ottimizzazione Visuale — Frontend

**Data:** 2026-06-22
**Scope:** i 3 componenti monolitici (`MarketStructureView` 1510, `DayTradingView` 950,
`KronosForecastView` 825 righe) + fondamente di styling
**Principio guida:** *nessun cambiamento visivo nelle fasi 0-3* (refactor puro),
poi ottimizzazioni UX misurabili nella fase 4, con validazione a schermo a ogni step.

---

## 1. Diagnosi (problemi concreti trovati nel codice reale)

### 🔴 Criticità strutturali

**A. Logica Kronos triplicata (~250 righe duplicate)**
La stessa funzione `getActiveKronosForecast` / `activeKronosForecast` / `chartData`
esiste in 3 posti con la **stessa identica logica**:
- `MarketStructureView.tsx:177-266` (useMemo inline)
- `DayTradingView.tsx:49-131` (funzione `getActiveKronosForecast`)
- `KronosForecastView.tsx:68-200+` (useMemo inline, + `multiplier` per futures/etf)

Tutte fanno: timeframe → resolution mapping, candleCount mapping, scaleRatio,
isStable, scaledCandles. Se cambi un parametro (es. aggiungi un timeframe),
devi toccare 3 file mantenendoli sincronizzati a mano.

**B. Costanti triplicate**
- `TIMEFRAMES` array identico definito in tutti e 3 i componenti
- `EXPIRY_OPTIONS` definito in 2 componenti
- `KRONOS_TIMEFRAMES` alias ridondante in DayTrading

**C. Tailwind via CDN in produzione** ⚠️
`index.html` carica `cdn.tailwindcss.com`: il compilatore JIT Tailwind gira
nel browser dell'utente (~400KB JS che processa classi a runtime).
Tailwind Labs lo sconsiglia esplicitamente per produzione. Conseguenze:
- LCP peggiore (JS bloccante prima del primo render coerente)
- FOUC possibile (classi non pronte al primo paint)
- Niente purge → tutto il catalogo classi è disponibile (payload inutile)
- Instabilità: la CDN può cambiare comportamento

**D. Zero design tokens — colori hardcoded ovunque**
Colori literal ripetuti:
- `#161b22` × 23, `#64748b` × 15, `#1e293b` × 15, `#e2e8f0` × 12,
  `#0d1117` × 10, `#f87171` × 10...
- Pattern `bg-[#xxxx]` × 34
- Per cambiare il tema (o aggiungere una variante light) servirebbero
  centinaia di modifiche manuali

**E. Pattern `sharedState` opzionale + fallback locale confuso**
Ogni componente fa:
```ts
const localState = useOptionsData();
const state = sharedState || localState;
```
Se `sharedState` manca, crea un'istanza separata → doppio fetch, stato out
of sync tra le tab. Va razionalizzato: o sempre shared da App, o mai.

### 🟠 Qualità del codice

**F. Sub-componenti inline giganteschi**
- `MarketStructureView`: 9 sezioni di calcolo + tutto il JSX inline, zero
  sub-componenti estratti
- `DayTradingView`: meglio, ha 5 sub-componenti estratti
  (`OIVolBars`, `LevelRow`, `RegimeBadge`, `TradingGuide`, `MarketLevelsColumn`)
- `KronosForecastView`: SVG charting inline a mano (10 elementi SVG),
  12 return → molte sub-render inline

**G. Performance: O(n²) nel profile merge**
`MarketStructureView:112-117` — `.map(strike => .find(...))` annidato:
per ogni strike cerca in tutto `gexStrikeData`. Su ~200 strikes → 40.000
iterazioni per ogni render. Basta un `Map` indicizzato per trasformarlo in O(n).

**H. `useOptionsData` hook monolitico (427 righe)**
Fa troppe cose: fetch 4 symbols + Kronos, auto-refresh, live spot polling 15s,
expiry filtering, regime recalculation. Separabile in hook focalizzati.

### 🟡 UX

**I. Header sovraffollato**
`MarketStructureView` header ha 5 controlli su una riga (market, range, zoom,
scadenza, futures tf). Su mobile/laptop 13" è illeggibile.

**L. Scala tipografica incoerente**
Abuso di `text-[9px]` / `text-[10px]` ovunque → leggibilità degradata,
nessuna gerarchia chiara.

**M. Niente stati parziali**
Se Kronos fallisce ma le opzioni OK, l'intero pannello Kronos sparisce
invece di mostrare uno stato "parziale".

---

## 2. Principi guida

### ✅ Fare
- **Refactor visivamente neutro prima**: ogni fase deve poter essere
  confrontata "prima/dopo" a schermo e risultare identica
- **Un'estrattazione alla volta, un commit alla volta**: se una fase rompe
  il rendering, si fa revert di un solo commit
- **Validazione a schermo a ogni fase**: l'utente guarda la dashboard
  prima/dopo ogni commit
- **Test di parità dove possibile**: le funzioni purificate
  (kronos, formatting) possono avere test che bloccano regressioni

### ❌ Non fare (trade-off onesti)
- **NON sostituire Tailwind con altro framework** (Material, Mantine):
  troppo sforzo, troppo rischio visivo. Tailwind va bene, va solo compilato
  a build time invece che via CDN.
- **NON riscrivere il chart SVG di Kronos con recharts/chart.js**:
  aggiungerebbe peso (~100KB) e cambierebbe il look. L'SVG inline è
  flessibile, leggero e già fatto. Semmai si estrae in un componente.
- **NON ridisegnare da zero il design system**: manteniamo l'estetica
  attuale (dark theme, palette GitHub-ish) e la consolidiamo.
- **NON toccare la logica quantitativa**: i servizi (`gexService`,
  `wallService`, `keyLevelService`) sono fuori scope — già coperti da 337 test.

---

## 3. Piano a fasi

### Fase 0 — Fondamenta (visivamente neutra) 🧱
**Obiettivo:** build production-grade, design tokens utilizzabili.

| Task | File | Rischio |
|---|---|---|
| 0.1 Sostituire Tailwind CDN con Tailwind build-time | `package.json`, `tailwind.config.js`, `postcss.config.js`, `index.html` | Medio — bisogna verificare ogni classe si compila uguale |
| 0.2 Centralizzare i 6-8 colori ricorrenti in `tailwind.config.theme.extend.colors` | `tailwind.config.js` | Basso |
| 0.3 Migrare i `bg-[#xxxx]` → `bg-surface`/`bg-panel` (alias semantici) | tutti i componenti | Basso (find-replace) |

**Validation:** screenshot prima/dopo, nessuna differenza visiva. Build size
ridotta (niente runtime Tailwind JS).

### Fase 1 — De-duplicazione logica (visivamente neutra) ♻️
**Obiettivo:** eliminare la tripletta Kronos + costanti duplicate.

| Task | File | Righe rimosse |
|---|---|---|
| 1.1 Creare `lib/kronos.ts` con `getActiveKronosForecast(biasItem, spot, timeframe, opts?)` | nuovo `lib/kronos.ts` | — |
| 1.2 Sostituire le 3 copie con chiamata al modulo | 3 componenti | ~200 |
| 1.3 Centralizzare `TIMEFRAMES` e `EXPIRY_OPTIONS` in `lib/kronos.ts` / `lib/expiry.ts` | 3 componenti | ~40 |
| 1.4 Aggiungere test Vitest per `getActiveKronosForecast` | nuovo `lib/kronos.test.ts` | — |

**Validation:** 337 + N test verdi. Behavior identico a schermo.

### Fase 2 — Estrazione sub-componenti (visivamente neutra) 🧩
**Obiettivo:** componenti sotto le 400 righe, riutilizzabili.

Priorità `MarketStructureView` (il peggiore):

| Sub-component da estrarre | Righe stimate |
|---|---|
| `ControlHeader` (market + filtri) | ~170 |
| `SpotMetricsPanel` (griglia 4 metriche) | ~80 |
| `UnifiedProfileChart` (3-profile chart) | ~280 |
| `StructuralAnalysisCard` | ~80 |
| `FvaListPanel` | ~80 |

Per `KronosForecastView`:
| `KronosForecastChart` (SVG inline) | ~250 |
| `BiasBadge`, `TimeframeSelector` | ~60 |

**Validation:** ogni estrazione è un commit separato. Confronto a schermo.

### Fase 3 — Razionalizzazione stato & performance ⚡
**Obiettivo:** un solo `useOptionsData`, niente O(n²).

| Task | File |
|---|---|
| 3.1 Rimuovere il pattern `sharedState?` opzionale, passare sempre lo stato da App | `App.tsx` + 3 componenti |
| 3.2 Trasformare il profile merge O(n²) in O(n) con `Map` indicizzata | `MarketStructureView` |
| 3.3 (Opzionale) Spezzare `useOptionsData` in `useOptionsFetch` + `useLiveSpot` + `useKronos` | `hooks/` |

**Validation:** typecheck OK, behavior identico, confronto reattività tab.

### Fase 4 — Ottimizzazioni UX visive (con validation) 🎨
**Obiettivo:** migliore fruibilità, mantenendo l'estetica.

Solo DOPO le fasi 0-3. Ogni item è un commit separato con tua approvazione:

- 4.1 **Header ripulito**: raggruppa controlli secondari in un drawer
  "Filtri", lascia solo market + refresh in primo piano
- 4.2 **Scala tipografica**: ridurre `text-[9px]`/`text-[10px]`,
  usare `text-xs`/`text-sm` con gerarchia (titolo > valore > etichetta)
- 4.3 **Stati parziali**: se Kronos fallisce, mostra il pannello opzioni
  con un badge "Kronos non disponibile"
- 4.4 **Responsive mobile**: header collassabile, card stack verticale
- 4.5 **Loading skeletons** invece di spinner globale
- 4.6 **Tooltips informativi** sui valori chiave (GEX, flip point, walls)

---

## 4. Ordine di esecuzione consigliato

```
Fase 0  (fondamenta)      ← alta priorità, setup Tailwind
  └─ Fase 1  (dedup Kronos) ← alta priorità, rimuove 250 righe
      └─ Fase 2  (sub-componenti) ← media, scomposizione
          └─ Fase 3  (stato/perf) ← media
              └─ Fase 4  (UX)     ← solo se vuoi, iterativa
```

Ogni fase è **indipendente e committabile**. Possiamo fermarci a qualsiasi
punto e il codice sta in piedi.

### Stima di sforzo (indicativa, tua decisione sul ritmo)
- Fase 0: ~1 sessione (setup + migration classi)
- Fase 1: ~1 sessione (de-dup + test)
- Fase 2: ~2-3 sessioni (un componente alla volta con validation)
- Fase 3: ~1 sessione
- Fase 4: iterativa, 1 item per sessione

---

## 5. Criteri di successo

- [ ] `index.html` non carica più `cdn.tailwindcss.com`
- [ ] `lib/kronos.ts` esiste ed è coperto da test
- [ ] Nessun componente supera le ~400 righe
- [ ] Un solo `useOptionsData` attivo (niente fallback locali)
- [ ] Build size production ridotta
- [ ] LCP migliorato (niente JS Tailwind bloccante)
- [ ] 337 test + nuovi test Kronos verdi
- [ ] Look a schermo **identico** dopo fasi 0-3
