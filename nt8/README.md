# GexOiProfile — indicatore NT8

Profilo **netto OI/GEX per strike** sul grafico NinjaTrader, con linee
**Spot / Max Pain / Flip** sempre visibili. Gli stessi numeri della web app
QuantFlow: l'indicatore NON ricalcola nulla, legge il piano già generato dal
pipeline (branch `data` → `data/day_plan.json`, profili già in scala futures
con ratio congelato per seduta).

## Installazione (VM Windows 192.168.68.111)

1. Copia `GexOiProfile.cs` in `Documents\NinjaTrader 8\bin\Custom\Indicators\`.
2. Apri NinjaTrader → New → NinjaScript Editor → apri `GexOiProfile`.
   - Se la compilazione dà errore su `Newtonsoft.Json`: tasto destro su
     **References → Add Reference** → seleziona `Newtonsoft.Json.dll` dalla
     cartella di installazione NT (`<NT>\bin\`) → OK → ricompila (F5).
3. Su un grafico ES/NQ (o MES/MNQ): tasto destro → Indicators → **GexOiProfile**.

Il fetch va su `raw.githubusercontent.com` (branch `data`): verificare che la
VM abbia accesso a internet. HTTP è asincrono: non blocca mai il thread grafico.

## Proprietà

| Proprietà | Default | Note |
|---|---|---|
| Futures | Auto | Auto-detect dal nome strumento (ES/MES → piano ES, NQ/MNQ → piano NQ) |
| Fonte opzioni | Indice | Indice = profilo raw 5-pt (SPX/NDX, parità InsiderFinance) · ETF = bin 25-pt (SPY/QQQ) |
| Borsa di scadenza | Tutte | 0DTE / ≤7gg / Tutte — identiche al selettore del sito |
| Metrica | GEX | GEX netto (Mld $, c+p) oppure OI netta (co−po) |
| Finestra ±% | 5 | Strike entro ±X% dallo spot live (come il sito) |
| Refresh (minuti) | 5 | Il pipeline pubblica ogni 5 min in seduta |
| Piano stantio dopo | 15 min | L'intestazione diventa ambra se il piano è più vecchio |
| Larghezza pannello % | 22 | Larghezza del profilo sul bordo destro |
| Mostra anche flip 0DTE | no | Aggiunge la linea flip 0DTE (quando esiste nel piano) |

## Cosa mostra

- **Barre per strike** alla propria quota di prezzo: verde = netto ≥ 0
  (call-dominato, pin 🛡), rosso = netto < 0 (put-dominato, trigger ⚡).
  I 3 muri maggiori per |net| sono etichettati con lo strike.
- **Linee sempre attive**: Spot (blu tratteggiata, prezzo LIVE del grafico),
  Max Pain (ambra), Flip strutturale (viola) — della fonte selezionata,
  in scala futures. Etichette con anti-collisione (flip ≈ max pain le separa).
- **Intestazione**: metrica/borsa/fonte + orario del piano; ambra = stantio.
- Flip assente nel piano (nessuno zero-crossing) → la linea non viene disegnata:
  non è un errore, è il dato (vedi discussione flip/max pain della scala).

## Note tecniche

- Parsing JSON con Newtonsoft.Json; fetch asincrono con marshal al thread UI
  via `TriggerCustomEvent`; guard anti-concorrenza con Interlocked.
- Disegno SharpDX in `OnRender`: nessun draw-object persistente (niente spazzatura
  nel workspace), risorse create e smaltite per frame.
- Il piano fuori seduta resta pubblicato: l'indicatore lo mostra con l'ora e il
  badge di stantietà, coerente col sito.
