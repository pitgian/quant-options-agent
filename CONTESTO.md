# CONTESTO — stato del progetto (handoff per le sessioni)

> **Leggi questo file per ripartire con il contesto pieno.**
> Ultimo aggiornamento: 2026-10-06 · commit di riferimento: vedi `git log -5`

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
   spot inline, distanza in punti, badge meccanismo (🧲 magnete / 🛡 barriera /
   ⚡ trigger), ★ confluenze e **barra GEX integrata per riga** (verde pin /
   rossa trigger, lunghezza = GEX netto della zona normalizzato sul muro
   massimo). La vecchia tabella gamma separata è stata riassorbita nella
   scala il 06/10 sera. **Flip 0DTE** (07/10): accanto al flip aggregato —
   solo le scadenze di oggi, regime intraday; header lo mostra ambra se
   divergente. **Lettura operativa** nell'header (07/10): spot vs i due
   livelli adiacenti + aspettativa per meccanismo + clausola di regime.
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
  GexByStrike.tsx            profilo gamma per strike — RIASSORBITO nella scala il
                             06/10 (barra GEX per riga in Ladder + muri top-3 come
                             livelli in DayView); file tenuto per riattivazione
services/dayPlanService.ts   UNICO servizio: day_plan.json + level_stats.json + live spot
lib/auction.ts               MOTORE puro: profileStats (VA 70%), classifyOpen,
                             buildLadder (clustering 5pt, rank, importanza) + test
scripts/
  fetch_options_data.py      catene opzioni + walls (calculate_walls) + GEX +
                             profili futures 7 finestre + playbook legacy
                             (fetch_intraday_playbook — calcola ma la UI non lo usa più)
  day_plan.py                MOTORE puro: costruisce data/day_plan.json (livelli
                             prezzo+AMT+opzioni in scala ES/NQ, lettura AMT,
                             max pain, top gamma) + scoring piano precedente →
                             data/level_stats.json (chiave STRUMENTO:NOME,
                             n/held/rate; barre solo dalla data del piano)
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

SOLO livelli da opzioni (i livelli di prezzo — VWAP/max/min/value — sono stati
rimossi dalla scala su richiesta esplicita; restano calcolati nel backend):

1. **GEX flip** — zero-crossing della gamma netta: sopra → dealer long gamma
   (respingono, mean reversion); sotto → short gamma (amplificano, trend)
2. **Muri gamma** — strike con più gamma netta assoluta: gamma lunga = PIN
   (respinge), gamma corta = TRIGGER (accelera la rottura) — top 3 per lato
3. **Max Pain** — strike a payout minimo per gli acquirenti: scadenza vicina
   (pin di oggi) + aggregato tutte le scadenze (magnete strutturale)
4. **Muri OI+Volume** — da `calculate_walls` (formula unificata Python↔TS),
   classificati pin/trigger dal segno di net_gex, top 3 per lato
5. **Top strike gamma** — i 3 più grandi per lato di |GEX| per strike entrano
   in scala come livelli propri ("Muro gamma XXX Mld") e si fondono coi muri
   OI+Volume vicini (= confluenza); il GEX netto è la barra sulla riga

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
ripristinato = quello con cui si ha aperto la giornata.

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
  (trend). È il livello di regola, non un muro.
- **VWAP**: dipende dall'ancoraggio — il piano espone ENTRAMBI: VWAP RTH
  (09:30 ET, convenzione equity) e VWAP Globex (18:00 ET, convenzione CME).
- **La settimana in corso include l'overnight Globex** (bug fix: il lunedì
  mattina calcolava silenziosamente il max di venerdì).
- **I livelli sono ZONE**: arrotondati a 5 punti in scala futures (gli strike
  ETF convertiti producevano decimale residuo finto, es. ...7811).
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
python tests/test_intraday_playbook.py
python tests/test_day_plan.py       # track record (6 check)
# publish manuale sul data branch: clone --depth1 --branch data, copia i file
# (options_data/options_oi_lastgood/options_history/day_plan/level_stats),
# commit, push
```

Deploy: **automatico da push su master** (Vercel Git integration, riconnessa
e verificata il 06/10 — prima era staccata da 42 giorni).

### Incidente 07/10 mattina: catena opzioni senza OI (flip a +17%)

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
- `scripts/fetch_options_data.py` contiene `fetch_intraday_playbook` (legacy,
  calcola ma nessuno lo consuma) — rimovibile quando si vuole.
- gh CLI: `gh run list` funziona, il **dispatch può dare 401** (serve scope
  workflow) — in tal caso lanciare il workflow da GitHub → Actions → Run
  workflow, o aspettare il cron.
