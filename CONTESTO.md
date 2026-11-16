# CONTESTO — stato del progetto (handoff per le sessioni)

> **Leggi questo file per ripartire con il contesto pieno.**
> Ultimo aggiornamento: 2026-11-16 (flip dalla curva di esposizione) · commit di riferimento: vedi `git log -5`

---

## 1. Cos'è QuantFlow (stato attuale)

Piattaforma operativa di **day trading su futures indici (ES/NQ)** che mostra
**solo i livelli derivati dalle opzioni**, ordinati in una scala prezzi, ognuno
col suo meccanismo atteso e con l'affidabilità misurata nel tempo.

**Cosa NON è più**: il motore predittivo Kronos + addestramento è stato
**rimosso completamente** (decisione del 06/10, commit "riscrittura da capo"):
dopo 6 settimane di track record non batteva il baseline ingenuo (4h
anti-predittivo, 1d positivo ma non significativo). Ripasserà in un progetto
separato futuro con modelli decisionali dedicati.

**Il prodotto è UNA pagina** (`App.tsx` → `DayView.tsx`):
1. **Regime gamma** (badge: long/short gamma + livello di flip)
2. **🔔 Stato dell'asta** (`AuctionState`… no: integrato in DayView) — lettura
   AMT: tipo di apertura vs value di ieri, posizione nella value, IB, VWAP
3. **🎯 La scala** (`Ladder.tsx`) — i livelli opzioni fusi in zone a 5 punti,
   spot inline, distanza in punti, badge meccanismo (🧲 magnete / ⛓ gabbia /
   🛡 barriera / ⚡ trigger), ★ confluenze e **barra GEX integrata per riga** (verde pin /
   rossa trigger, lunghezza = GEX netto della zona normalizzato sul muro
   massimo). La vecchia tabella gamma separata è stata riassorbita nella
   scala il 06/10 sera. **Flip 0DTE** (07/10): accanto al flip aggregato —
   solo le scadenze di oggi, regime intraday; header lo mostra ambra se
   divergente. **Lettura operativa** nell'header (07/10): spot vs i due
   livelli adiacenti + aspettativa per meccanismo + clausola di regime.
   **Fonte opzioni** (03/11): toggle nella nav — 📊 ETF (SPY/QQQ) /
   🏛 Indici (SPX/NDX) / 🔀 Entrambi, persistito in localStorage. Le catene
   SPX/NDX erano già scaricate dal fetch (--symbol ALL): day_plan ora le usa
   (stessa compute_option_levels/max_pain sullo spot indice, conversione col
   fattore indice→futures ES/SPX) e tagga ogni livello opzioni con
   `chain: 'etf'|'index'`; i livelli indice portano nome con suffisso -IDX
   (PIN-IDX, GEX-FLIP-IDX, MAXPAIN-*-IDX, MURO-GAMMA-IDX, GABBIA-GAMMA-IDX) → track record
   SEPARATO per fonte in level_stats.json (ES:PIN vs ES:PIN-IDX): è la misura
   che dice quale fonte produce livelli più affidabili. Dedup 3pt (ora in
   `dedupe_levels`): un livello indice non viene mai soppresso da un livello
   opzioni ETF (coincidenze = confluenza ★ in vista 'Entrambi'), solo da
   price/AMT o da un altro indice. Se la catena indice è degradata la fonte
   resta assente e la UI mostra avviso; aggregati indice nel piano:
   gamma_regime_index, top_gamma_index, max_pain_*_index, gex_flip_0dte_index.
   **FLIP PER BORSA** (15/11): il flip è il confine di regime e ora esiste per
   OGNI perimetro — `GEX-FLIP-WEEK[-IDX]` + `gex_flip_week[_index]`, oltre a
   0DTE e strutturale — e la UI (sito e NT8) usa quello della borsa scelta.
   Prima mostrava SEMPRE il flip strutturale: su ES il flip ≤7gg e quello su
   Tutte distano decine di pt (misurato: 7617 contro 7654). Aggiunti anche
   `gamma_regime_0dte/week[_index]`: con 0DTE il segno del GEX attorno allo
   spot può essere opposto a quello strutturale. Fallback allo strutturale
   quando la borsa non ha flip (weekend, catena corta) — la riga lo dichiara.
   **FLIP DALLA CURVA DI ESPOSIZIONE** (16/11, `GEX_METHOD = curve-bs-v1`): il flip
   NON è più lo zero-crossing della somma per strike (l'istogramma) — quella serie
   è un dente di sega: misurato sul libro del 16/11, **73 cambi di segno entro ±10%
   su NDX, 13 su SPX**. Prendere il più vicino significava pescare rumore, e il
   "confine di regime" poteva stare SOTTO il prezzo mentre il regime (calcolato da
   un'altra funzione, `regime_at_spot`) era short → il reclamo dell'utente: «il sito
   dice gamma negativa col prezzo sopra il flip» + «i flip di NT8 e del sito non
   corrispondono». Ora `gamma_exposure_curve`/`gamma_flip` (day_plan) fanno come le
   piattaforme pro: **G(P) = Σ ±OI·100·P²·Γ_BS(P, K, iv, T)** — la gamma di ogni
   contratto rivalutata a OGNI prezzo (IV reali per contratto, default per simbolo
   se assenti; r=4%, q=1,2%; banda ±12%; T delle scadenze di oggi convenzionale
   a mezza giornata perché il numero NON deve dipendere dall'ora del giro). La
   curva è monotona per costruzione → **un taglio solo** (verificato su 12/12 libri
   reali il 16/11), e regime = segno al prezzo + flip = zero della STESSA curva:
   "sopra = long, sotto = short" è vero per costruzione, non per assunzione.
   Pubblicato in `plan["gamma"][etf|index][all|week|0dte]` = {regime, flip,
   flip_below, flip_above, crossings, band_pct} + copia nei livelli GEX-FLIP*
   (`regime`, `zone_low`, `zone_high`). Con l'occasione: (a) `dedupe_levels` NON
   sopprime più i GEX-FLIP* (prima il dedup a 3 pt mangiava GEX-FLIP-WEEK[-IDX] e
   NT8, che legge solo i livelli, rientrava sul strutturale = 35 pt diverso dal
   sito — stamattina 7545 vs 7580); (b) i campi flat `gex_flip*`/`gamma_regime*`
   restati per compatibilità con i client vecchi, ora derivano tutti dalla curva; (c) il sito NON deriva più
   il regime dal confronto prezzo/flip (era quella la riga bugiada) e lo scenario
   usava `regimeNow` (stringa) come booleano → 'short' è truthy e stampava
   "long gamma" col regime corto da sempre; (d) NT8 segue la borsa scelta per il
   regime e ha il fallback sui campi numerici come il sito.
   **Test**: `tests/test_day_plan.py` (26 check: curva, invarianti, dedup) +
   `tests/test_plan_invariants.py` (legge il piano pubblicato e verifica regime vs
   flip, livelli vs curva, campi flat — fallisce sul piano vecchio, passa sul nuovo).
   **SCADENZE PASSATE** (15/11): `relevant_expiries` ora le scarta. Il feed le
   tiene per giorni con gamma/OI stantii e finivano in GEX flip, regime,
   top_gamma e muri (11,4% della gamma totale il 15/11): il flip strutturale
   dell'indice era sbagliato di ~50 pt. `regime_at_spot` inoltre non si ferma
   più al primo strike a zero (NDX: gli strike attorno allo spot possono avere
   gamma solo nelle scadenze scadute) ma cammina al primo con gamma ≠ 0.
   **GABBIE GAMMA** (15/11): livelli `kind: 'cage'` (nome `GABBIA-GAMMA` /
   `-IDX`) calcolati dalla UI, non dal piano. Uno strike con call e put
   ENTRAMBE grosse e in equilibrio è un pin a DOPPIA barriera — put =
   pavimento sotto, call = soffitto sopra — e il suo GEX NETTO è ≈ 0: per
   questo `top_gamma` (ordinato per |net_gex|) non lo vede MAI e prima la
   scala mostrava solo muri direzionali e max pain. Criteri relativi alla
   finestra ±3%: `min/max ≥ 0,55` (le due forze si compensano), entrambe le
   gambe ≥ 25% della gamba più grossa del giorno, dimensione ≥ 40% dello
   strike più grosso; score = size×balance, max 2 livelli (uno per lato).
   Sui profili in scala futures: indice raw, ETF solo `_binned` (il profilo
   ETF grezzo è in prezzi SPY/QQQ). In confluenza con un muro vince la
   gabbia come etichetta (il muro resta elencato in ⧉ ×N).
   **Soglia OI per simbolo** (03/11): MIN_CHAIN_OI_BY_SYMBOL={"NDX": 25k} —
   l'OI naturale di NDX su Yahoo è ~50-60k (mercato istituzionale, pochi
   contratti da ~2,8M$): la soglia assoluta 100k la scartava sempre →
   niente livelli indice per NQ (bug del 03/11, vista indici solo ES).
   **Catene SPX/NDX da CBOE** (03/11 pomeriggio): Yahoo sottostimava l'OI
   degli indici (SPX ~5×, NDX ~3,4× meno del reale). Le catene delayed
   quotes CBOE (cdn.cboe.com, ufficiali e gratuite) danno l'intero libro
   con gamma/IV/OI per serie, in un solo HTTP; il fetch ora le usa per
   SPX/NDX (parse simbolo OCC-like, strike filtrati ±10%, stesse colonne
   DataFrame del percorso Yahoo → tutto il downstream invariato), con
   fallback automatico a Yahoo se CBOE non risponde. Per simbolo nel JSON:
   chain_source: 'cboe'|'yahoo'. SPY/QQQ passati a CBOE anche loro (09/11:
   l'endpoint li serve come gli indici, contrariamente a quanto creduto —
   verifica empirica su SPY 0DTE: OI Yahoo=CBOE identico al 100%, volume
   Yahoo perde ~90% del consolidato 492k→39k, gamma assente su Yahoo;
   root con cifre tipo 'B1SPY' gestiti dalla regex OCC-like). Bug scope
   trovato in test e2e: len(expirations)
   nel percorso CBOE (fissato con expirations = sorted(fetched_chains)).
   Validazione esterna: l'OI per strike CBOE coincide CONTRATTO PER
   CONTRATTO con InsiderFinance sia sul perimetro front-week (9/9 strike)
   sia sul libro completo fino al 2029 (10/10).
   **Scala semplificata** (03/11 sera): troppi livelli, l'utente non
   distingueva gli importanti. Ora la scala mostra SOLO: i muri gamma per
   |GEX| col SELETTORE MATURITÀ (03/11 notte: Tutte/≤7gg/0DTE —
   top_gamma_by_bucket partiziona il libro per scadenza; gamma corta
   domina naturalmente il top aggregato, senza borse i muri delle
   scadenze lunghe non emergerebbero mai) con GARANZIA PER LATO (il
   migliore sopra + il migliore sotto sempre, poi riempimento fino a 3:
   prima capitava un lato vuoto), più il Max Pain della scadenza vicina
   e il flip gamma. Fuori scala: PIN/TRIGGER minori, MAXPAIN-ALL, flip
   0DTE (resta nell'header). Il track record lato backend continua a
   giudicare TUTTI i livelli: nessuna perdita di storicità.
   **Etichetta lato dominante** (03/11 notte): compute_option_levels ora
   accumula anche il |GEX| per lato (call_abs/put_abs per strike) e
   top_strikes portano side: 'call'|'put' — la scala etichetta 'Call
   wall' / 'Put wall' alla InsiderFinance, col meccanismo sempre dal
   segno della gamma netta. Anche la nota "nessun pin sotto lo spot":
   nell'indice le put sotto sono comprate → dealer short gamma → le
   discese accelerano (struttura, non filtro: verificato 0 pin sotto su
   ES e NQ nel libro reale).
   **Istogramma GEX** (05/11): nuova card "📊 Istogramma — GEX e Open
   Interest, tutti gli strike" sotto la scala (GexHistogram.tsx, SVG) —
   replica lo Strike Profile di InsiderFinance: barre verdi call sopra /
   rosse put sotto lo zero per OGNI strike, linea spot tratteggiata,
   toggle Tutte (±10%) / Vicine (±1,5%) e SELETTORE METRICA Γ GEX / OI.
   Segue borsa+fonte della scala (in Entrambi le due fonti si sommano
   per strike). Backend: gex_profile_by_bucket emette gex_profile
   [_0dte/_week][(_index)] con s/c/p (Mld) E co/po (OI call/put);
   strike senza né GEX né OI scartati. day_plan.json ~245KB.
   **BASE dati in dev** (05/11): dayPlanService usa /data locale in
   sviluppo (middleware vite) e GitHub raw in produzione — si testa il
   pipeline locale senza pushare.
   **Scenario GEX×MaxPain** (08/10): configura A compressione (long gamma
   + max pain entro 0,4%), B trend (short gamma + max pain lontano), C
   checkpoint (muro barriera frapposto), clausola OPEX, divergenza SPY/QQQ
   (i due piani di day_plan.json confrontati sul regime)
4. **📊 Profilo di oggi** (`SessionProfileChart.tsx`) con overlay dei livelli
5. **📐 Affidabilità storica** (`StatsPanel.tsx`, ripiegata)

Per i prezzi live: `/api-spot` (serverless Vercel, cache 15s), polling 15s.
Il piano dei livelli si ricarica da solo ogni 60s (pipeline ogni 5 min).

---

## 2. Architettura (mappa file)

```
App.tsx                      pagina unica (niente tab): toggle ES/NQ + DayView + StatsPanel
components/
  DayView.tsx                pagina operativa (solo livelli opzioni)
  Ladder.tsx                 la scala: clustering via lib/auction + conf + stats
  SessionProfileChart.tsx    profilo volumi della seduta + overlay livelli
  StatsPanel.tsx             affidabilità per livello
  ui.tsx                     KIT condiviso: ControlBar, Segmented, Badge, Card,
                             Collapsible, InfoHint, Freshness, Skeleton
services/dayPlanService.ts   UNICO servizio: day_plan.json + level_stats.json + live spot
lib/auction.ts               MOTORE puro: profileStats (VA 70%), classifyOpen,
                             buildLadder (clustering 5pt, rank, importanza) + test
scripts/
  fetch_options_data.py      catene opzioni (SPX/NDX da CBOE delayed quotes,
                             fallback Yahoo; SPY/QQQ da Yahoo) + walls
                             (calculate_walls) + GEX + profili futures
                             7 finestre + playbook legacy
                             (fetch_intraday_playbook — calcola ma la UI non lo usa più)
  day_plan.py                MOTORE puro: costruisce data/day_plan.json (livelli
                             prezzo+AMT+opzioni in scala ES/NQ da doppia catena
                             ETF+indici con tag chain, lettura AMT,
                             max pain, top gamma) + scoring piano precedente →
                             data/level_stats.json (chiave STRUMENTO:NOME,
                             n/held/rate; solo livelli della scala; barre della
                             giornata completata — marcatore last_scored)
  auto_updater.py            push locale semplificato sul data branch
tests/                       test_intraday_playbook.py (26 check) +
                             test_day_plan.py (6 check: filtro date, held/broke,
                             prefisso strumento)
.github/workflows/
  fetch-options-data.yml     UN job slim (~3 min, niente torch): fetch → day_plan
                             → publish 4 file sul data branch. Cron */5 6-21 UTC lun-ven
  ci.yml                     npm ci + tsc + vitest + build
  data-staleness-alert.yml   watchdog su options_data.json generated
```

**Nota**: `components/SessionProfileChart.tsx` e `Ladder.tsx` usano
`lib/auction.ts` — il motore è testato (`lib/auction.test.ts`, 12 check).

---

## 3. Le fonti dei livelli (cosa mostra la scala)

SOLO livelli da opzioni. I livelli di prezzo/AMT (PDH, VWAP, POC, IB, max/min…)
sono stati RIMOSSI OVUNQUE il 13/11: non li pubblica più day_plan.py (restano
solo le barre futures per lo spot), non compaiono più nelle stats (filtro
`isOptionsLevel` in dayPlanService) e gli helper AMT (profile_from_bars,
value_area, vwap_of, session_high_low) sono stati cancellati. La scala, il
track record e l'indicatore NT8 vivono di soli muri gamma / flip / max pain.

1. **GEX flip** — confine di regime: è lo zero della **curva di esposizione**
   G(P) (gamma di ogni contratto rivalutata a ogni prezzo, BS con IV/OI/T reali),
   non l'incrocio più vicino dell'istogramma per strike (16/11). Sopra → dealer
   long gamma (respingono, mean reversion); sotto → short (amplificano, trend).
   Il piano pubblica anche i DUE confini della zona in cui sta il prezzo
   (`flip_below`/`flip_above`): se la curva taglia più di una volta la UI lo dice
   invece di far finta che il confine sia uno solo.
2. **Muri gamma** — strike con più gamma netta assoluta: gamma lunga = PIN
   (respinge), gamma corta = TRIGGER (accelera la rottura) — top 3 per lato
3. **Max Pain** — strike a payout minimo per gli acquirenti: scadenza vicina
   (pin di oggi) + aggregato tutte le scadenze (magnete strutturale)
4. **Muri OI+Volume** — da `calculate_walls` (formula unificata Python↔TS),
   classificati pin/trigger dal segno di net_gex, top 3 per lato
5. **Top strike gamma** — i 3 più grandi per lato di |GEX| per strike entrano
   in scala come livelli propri ("Muro gamma XXX Mld") e si fondono coi muri
   OI+Volume vicini (= confluenza); il GEX netto è la barra sulla riga

6. **Confluenza ETF×indice (⧉)** — regola 13/11: un muro della catena ETF e
   uno della catena indice fanno confluenza SOLO se cadono entro **±5 pt**
   sullo stesso prezzo futures (la griglia operativa). I muri vengono dai
   `top_gamma` del piano, non dai profili per strike (rumore → muri finti).
   Con la tolleranza vecchia (25 pt) le "confluenze" erano falsi positivi:
   SPY 750 → ES 7545 e SPX 7500 → ES 7525 distano 20 pt e sono DUE livelli.
   In vista 'Entrambi' l'istogramma resta IDENTICO alle viste singole (barre
   verticali per strike = somma ETF+indice sulla griglia bin 25pt) e le
   confluenze sono BANDE VIOLA sovrapposte (tooltip con i due muri e i loro
   GEX); se non ce ne sono il riepilogo sopra il grafico lo dice e riporta il
   gap minimo fra i muri (è un dato, non un guasto). La scala
   (`lib/auction.ts`) fonde le zone adiacenti con la STESSA regola ±5 pt e
   solo fra muri opzioni di fonti diverse, così ⧉ significa la stessa cosa
   nei due posti.

Scala operativa = raggio **±5%** dal prezzo, zone arrotondate a **5 punti**,
max 10 per lato, ordinata: sopra lo spot dal più lontano in alto al più
vicino; sotto lo spot dal più vicino in giù. Badge importanza ★/★★/★★★ dal
punteggio — ricalibrato il 06/10 sera perché nella vista solo-opzioni ★★★ era
matematicamente irraggiungibile (soglia 8, max 6):

    score = fonti×3 + naked×2 + flip×1 + pin×1 + prossimità(<0.5%)×1
            + confluenza membri×1 (max 2) + dimensione GEX 0..3 (round(peso×3))
    ★★★ ≥ 7 · ★★ ≥ 5 · ★ sotto

Il peso GEX (|netto zona| / muro massimo del giorno) arriva da Ladder tramite
`LadderInput.gexWeight`: il muro più grosso vale 3 punti e ogni fonte extra
che conferma la zona vale 1. ★★★ ora significa "muro grande, confermato, pin".

---

## 4. Track record (come funziona)

`day_plan.py` ogni giro: genera il piano di oggi **e** giudica il piano di
ieri sulle barre 5m reali. Per ogni livello: **touch** (prezzo in banda ±3pt),
poi **held** (respinto: allontanamento ≥6pt senza violare il buffer di 4pt) o
**broke** (violato). Aggregate per chiave `STRUMENTO:NOME` in
`data/level_stats.json` (es. `"ES:PDH": rispettato 8/12`) → visibili in
`StatsPanel` (che mostra il badge strumento).

**Fissato il 06/10 pomeriggio** (il track record era muto dalla riscrittura,
`stats: 0 occorrenze` in CI): 1) `h, l` mai definite → `NameError`
inghiottito dal try/except; 2) nessun filtro temporale → il piano veniva
valutato su 7 giorni di barre, anche pre-pubblicazione (ora contano solo le
barre DAL giorno del piano in poi); 3) `load_stats()` dentro il loop simboli
→ le stats ES venivano perse al giro NQ; 4) chiavi nude → ES e NQ nello
stesso bucket. Validato end-to-end: 30 occorrenze in un giro.

**Secondo fix (08/10)**: il confronto "data generazione < oggi" era UTC vs ET
e con i run 24/7 non scattava MAI (il piano notturno ha già la data UTC del
nuovo giorno). Ora il giudizio è guidato dal marcatore **`last_scored`** in
level_stats.json: al primo run con una nuova giornata ET si giudica il piano
ripristinato sulle barre COMPLETE dell'ultimo giorno non ancora giudicato
(`score_plan_against(..., only_date=target)`). Il giudizio usa il piano
ripristinato = quello con cui si ha aperto la giornata. **Scope**: vengono
stillati SOLO i livelli che la scala mostra (fonti opzioni + max pain +
muri gamma top-3/lato, sintesi identiche a quelle della UI) — VWAP/VAH/
overnight non accumulano più fiducia.

**Perché serve**: è il magazzino di fiducia — senza conteggi, i livelli sono
numeri a caso. Con i conteggi, la scala si ordina su ciò che ha funzionato.

---

## 5. Conoscenza empirica accumulata (validazione set 2026)

Questi risultati hanno guidato le decisioni (non rimuoverli dal documento):

- **Muri OI puri come supporti: peggio del caso** (respinti 42% vs 63% di
  livelli casuali, out-of-sample 13 sedute). L'OI misura il posizionamento,
  non dove il prezzo si ferma → non usarli da soli come supporto.
- **Picchi di gamma lunga (call) sopra il prezzo: respinto l'80% dei touch**
  (n=5, piccolo ma coerente col meccanismo dealer) → i Pin hanno priorità.
- **GEX flip**: cambio di regime — sopra long gamma (fade), sotto short gamma
  (trend). È il livello di regola, non un muro. **Dal 16/11 vale solo se il flip
  è lo zero della curva di esposizione**: con la definizione per-strike la frase
  era falsa (il confine più vicino poteva essere un taglio di rumore con il segno
  sbagliato). Riscontro empirico a supporto, 08/10: lo zero gamma 0DTE coincideva
  con InsiderFinance ±0,2% anche con la vecchia formula — la curva lo conferma
  (16/11: ES Tutte 7585 in scala futures, stesso ordine di grandezza).
- **VWAP**: dipende dall'ancoraggio — il piano espone ENTRAMBI: VWAP RTH
  (09:30 ET, convenzione equity) e VWAP Globex (18:00 ET, convenzione CME).
- **La settimana in corso include l'overnight Globex** (bug fix: il lunedì
  mattina calcolava silenziosamente il max di venerdì).
- **I livelli sono ZONE**: arrotondati a 5 punti in scala futures (gli strike
  ETF convertiti producevano decimale residuo finto, es. ...7811).
- **Finestra di rilevanza ±10%** (08/10, dal confronto con InsiderFinance):
  put wall e max pain "tutte le scadenze" selezionati per OI assoluta cadevano
  su strike LEAPS profondi (put wall a 625 con spot 775; max pain −61%).
  Muri, flip e max pain si cercano solo entro ±10% dallo spot
  (`relevant_expiries`). Il Call Wall, invece, matchava ESATTAMENTE (785),
  così come l'OI totale (17,9M vs 18,9M) e lo zero gamma 0DTE (±0,2%).
- **OI è stale**: l'OCC lo aggiorna 1 volta al giorno — dichiarato in UI.

---

## 6. Comandi

```bash
npm run dev                         # frontend (vite, porta 5173/5174)
npm test                            # vitest (24 check)
npx tsc --noEmit                    # typecheck
npm run build                       # build produzione
source .venv/bin/activate
python scripts/fetch_options_data.py --symbol ALL --output data/options_data.json
python scripts/day_plan.py --show   # rigenera piano + stampa la scala
python tests/test_day_plan.py       # pipeline: borse, curva di flip, dedup (26 check)
python tests/test_plan_invariants.py # il piano pubblicato: regime vs flip,
                                     # livelli NT8 vs curva, campi flat (nuovo 16/11)
# publish manuale sul data branch: clone --depth1 --branch data, copia i file
# (options_data/options_oi_lastgood/options_history/day_plan/level_stats),
# commit, push
```

Deploy: **automatico da push su master** (Vercel Git integration, riconnessa
e verificata il 06/10 — prima era staccata da 42 giorni).

### Incidente 16/11: flip e regime si contraddicevano (e NT8 ≠ sito)

L'utente: «perché i flip tra indicatore e sito non corrispondono e perché il sito
mi dice gamma negativo con il prezzo sopra il flip». Quattro cause distinte, tutte
corrette (dettaglio in §1 "FLIP DALLA CURVA DI ESPOSIZIONE"):

1. **definizione sbagliata di flip** — zero-crossing più vicino della somma per
   strike, che è un dente di sega (73 tagli entro ±10% su NDX). Il confine che ne
   esce può stare sotto il prezzo col regime short: misurato sul piano live delle
   15:34, NQ/Indice pubblicava flip 27175 con spot 27401 e regime short. → curva di
   esposizione rivalutata a ogni prezzo (`gamma_flip`), UN taglio, regime e flip
   dalla stessa funzione.
2. **dedup che mangiava i flip perimetrali** — GEX-FLIP-WEEK[-IDX] sparava se
   cadeva a <3 pt da un altro flip; il sito ha il fallback sui campi numerici,
   l'indicatore NO → due numeri diversi per la stessa borsa (7545 sito contro
   7580 NT8, stamattina). → i GEX-FLIP* sono esclusi dal dedup e NT8 ha il
   fallback numerico.
3. **NT8 leggeva sempre e solo `gamma_regime`** (strutturale), ignorando la
   proprietà "Borsa di scadenza" che il sito rispetta → "short gamma" sul
   grafico contro "Long gamma" sull'app a parità di impostazioni.
4. **`regimeNow` (stringa 'long'|'short') usato come booleano** nello scenario del
   sito: `'short'` è truthy → lo scenario stampava "long gamma ma max pain
   lontano" anche col regime corto, da sempre.

Verifica: `tests/test_plan_invariants.py` fallisce sul piano vecchio e passa su
quello nuovo (12/12 bande catena×perimetro concordi); sul libro reale del 16/11
la curva taglia una volta sola in 12/12 casi.



yfinance/Yahoo ha smesso di fornire `openInterest` (OI QQQ 24k contro ~10M
normali). Il piano ha pubblicato flip NQ a 36.870 con spot 31.352, max pain
"tutte le scadenze" a 12.214 (min() su pareggio totale di OI zero), muri
fantasiosi. Tre difese aggiunte:

1. `fetch_options_data.py`: flag `data_quality: degraded` se >80% dei
   contratti resta senza OI anche dopo il fallback + **archivio compatto
   `options_oi_lastgood.json`** (scritto SOLO a catena sana, ~300KB):
   prima il fallback attingeva da options_data.json sul data branch, che
   dopo un guasto prolungato è già stato sovrascritto con catene rotte
2. workflow: restore di options_data.json + archivio lastgood (il fallback
   era disabilitato in CI: "No previous file found")
3. `day_plan.py`: guard `MIN_CHAIN_OI=100k` → catena degradata = nessun
   livello opzioni pubblicato + avviso nel read del piano

Recupero verificato: 6542/7636 OI riparate per SPY dall'archivio, flip tornato
a −1,2% dallo spot. Le 0DTE nuove (scadenze non presenti nell'archivio)
restano senza OI: minoranza tollerata.

---

## 7. Prossimi passi (aperti)

1. **Lasciare accumulare il track record** (1-2 settimane): riparte DAVVERO
   solo ora (bug dello scoring fissato il 06/10 pomeriggio — vedi §4); i
   verdetti per livello compaiono da ≥5 occorrenze.
2. **Verificare il cron CI**: schedule `*/5 6-21 UTC lun-ven` attivo su
   master; se un giro salta, il data branch resta com'è (nessun danno).
3. **Possibili estensioni discusse**:
   - profilo di ieri sovrapposto a oggi nel SessionProfileChart
   - single prints / zone di iniziativa dal profilo
   - esportazione della scala
4. **Non reintrodurre**: livelli di prezzo puri nella scala, tab multiple,
   previsioni Kronos (progetto separato futuro).

## 8. Igiene

- Test: 25 JS (vitest) + 26 Python (playbook) + 6 (test_day_plan) + 12 (lib/auction) verdi.
- Il data branch porta ancora file Kronos stantii (kronos_forecast.json ecc.)
  — innocui, l'alert di staleness legge options_data.json.
- 08/10 pulizia profonda: rimossi playbook intraday legacy (+26 check),
  auto_updater.py, GexByStrike.tsx, ControlBar/Freshness, parity tooling,
  plans/, options_history.json (mai letta da nessuno) e i file Kronos dal
  data branch. Kept: docs/cron-job-setup.md (infra dispatcher esterno).
- gh CLI: `gh run list` funziona, il **dispatch può dare 401** (serve scope
  workflow) — in tal caso lanciare il workflow da GitHub → Actions → Run
  workflow, o aspettare il cron.
