# GexOiProfile — indicatore NT8

Profilo **netto OI/GEX per strike** sul grafico NinjaTrader, con linee
**Spot / Max Pain / Flip** sempre visibili. Gli stessi numeri della web app
QuantFlow: l'indicatore NON ricalcola nulla, legge il piano già generato dal
pipeline (branch `data` → `data/day_plan.json`, profili già in scala futures
con ratio congelato per seduta).

## Installazione (VM Windows 192.168.68.111)

1. Copia `GexOiProfile.cs` in `Documents\NinjaTrader 8\bin\Custom\Indicators\`.
2. Apri NinjaTrader → New → NinjaScript Editor → **F5** (compila tutto).
3. Su un grafico ES/NQ (o MES/MNQ): tasto destro → Indicators → **GexOiProfile**.

⚠️ **Nessun riferimento extra da aggiungere** — il parsing JSON usa
`JavaScriptSerializer` (`System.Web.Extensions`, già tra i riferimenti di
default di NT8). NON aggiungere Newtonsoft.Json a mano nel csproj: NT8
rigenera il csproj a ogni compilazione e scarta i riferimenti manuali
(verificato 12/11: la reference aggiunta via SSH spariva a ogni F5).

Il fetch va su `raw.githubusercontent.com` (branch `data`): verificare che la
VM abbia accesso a internet. HTTP è asincrono: non blocca mai il thread grafico.

## Confluenza (modalità Entrambi)

I muri vengono dai `top_gamma` del piano (GEX aggregato per strike, picchi
veri), NON dai profili per strike: il rumore dei profili grezzi inventava
muri. Una zona di confluenza esiste solo se un muro ETF e uno indice cadono
entro **±5 pt** sullo stesso prezzo futures (la griglia operativa della
scala). Con la tolleranza vecchia di 25 pt uscivano 6 "confluenze" che erano
tutti falsi positivi: SPY 750 → ES 7545 e SPX 7500 → ES 7525 sono DUE livelli
distinti, non uno confermato due volte (gap minimo reale misurato: 20 pt).
Quando non c'è nessuna confluenza l'indicatore lo scrive ("⧉ 0 confluenze
±5pt · gap minimo Xpt") invece di disegnare bande vuote: è un dato, non un
guasto. Stessa regola e stessi numeri della web app.

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

- Parsing JSON con `JavaScriptSerializer` (System.Web.Extensions, riferimento
default NT8 — 584 KB di piano parsed in background, mai sul thread UI);
  marshal al thread grafico via `TriggerCustomEvent`; guard anti-concorrenza
  con Interlocked.
- Qualificazioni esplicite per evitare collisioni NT/SharpDX:
  `System.ComponentModel.DataAnnotations.Range(...)` (senza, collide con
  `SharpDX.Range`) e `System.Windows.Media.Brushes` (senza, `SolidColorBrush`
  è ambiguo tra Media e Direct2D1).
- Disegno SharpDX in `OnRender`: nessun draw-object persistente (niente spazzatura
  nel workspace), risorse create e smaltite per frame.
- Il piano fuori seduta resta pubblicato: l'indicatore lo mostra con l'ora e il
  badge di stantietà, coerente col sito.
