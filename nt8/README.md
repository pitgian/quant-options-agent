# GexOiProfile — indicatore NT8

Profilo **OI/GEX per strike** sul grafico NinjaTrader, con linee
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

In Entrambi le barre sono la SOMMA ETF+indice per strike (griglia 25pt in
scala futures), identiche al sito, e le confluenze sono BANDE VIOLA sulla
colonna del profilo: una confluenza è un intervallo di PREZZO, quindi nella
colonna (asse y = prezzo) è un segmento traslucido con bordi tratteggiati ai
due prezzi e etichetta ⧉ a destra (max 6, le più pesanti).

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
| Metrica | GEX | GEX (Mld $, c+p) oppure OI (contratti, co−po) |
| Vista | Net | **Net** = valore col segno (il lato) · **Somma** = call+put senza segno (**la size del livello**), come `Σ Call+Put` del sito · **Lati** = le due gambe separate (**call a sinistra, put a destra** della spina centrale), come `Call/Put` del sito |
| Finestra ±% | 5 | Strike entro ±X% dallo spot live (come il sito) |
| Refresh (minuti) | 5 | Il pipeline pubblica ogni 5 min in seduta |
| Piano stantio dopo | 15 min | L'intestazione diventa ambra se il piano è più vecchio |
| Larghezza pannello % | 22 | Larghezza del profilo sul bordo destro |
| Spessore max barra (px) | 10 | Spessore delle barre: lo spessore effettivo sta fra il 55% e il 100% di questo valore, uguale per tutte le barre. Prima dipendeva dal passo fra strike, e su NDX indice (passi da 5 px sullo schermo) le barre restavano sottili e il cursore muoveva solo l'ETF |
| Mostra anche flip 0DTE | no | Aggiunge la linea flip 0DTE (quando esiste nel piano) |

## Cosa mostra

- **Net** (default) — barre per strike alla propria quota di prezzo: verde =
  ≥ 0 (call-dominato, pin 🛡), rosso = < 0 (put-dominato, trigger ⚡).
  I 3 muri maggiori per |valore| sono etichettati con lo strike.
- **Somma** (`Vista = Somma`) — stesse barre, **senza segno**: OI = `co+po`
  (contratti totali), GEX = `|c|+|p|` (gamma lorda). Colore **indaco**, scala
  sul massimo della somma. Barra alta = strike importante, cioè la domanda
  "quali sono i livelli più grossi", a cui il netto non risponde.
- **Lati** (`Vista = Lati`) — due gambe separate dalla **spina centrale**:
  **call a sinistra** (verde), **put a destra** (rosso), una sola scala per
  entrambe (così la gamba più lunga è quella che pesa di più). È la vista che
  dice *com'è composto* il libro senza sommare né sottrarre.

  Con **Entrambi** la vista diventa **AFFIANCATA**: due colonne, *indici a
  sinistra* e *ETF a destra*, ognuna con il **proprio asse call/put**
  (call verso l'esterno, put verso il divisore). Quattro serie ma in due
  gruppi distinti: si confrontano i due libri a colpo d'occhio — dove
  l'indice ha una gabbia e l'ETF no, e viceversa. Ogni colonna è normalizzata
  al proprio massimo (`Scala comune` per il confronto assoluto) e in basso
  dichiara il libro e il suo massimo (▲ SPX 1741 · ▼ SPY 229).
- **Linee sempre attive**: Max Pain (ambra) e Flip strutturale (viola) della
  fonte selezionata, in scala futures; in Entrambi anche il Flip dell'altra
  fonte (la distanza fra i due = regime confermato o in divergenza). La linea
  Spot NON c'è: il grafico ha già la sua. Partono dall'ultima candela, non dal
  bordo sinistro, per non attraversare la price action.
  Etichette con anti-collisione (flip ≈ max pain le separa).
- **Intestazione**: vista/metrica/borsa/fonte + orario del piano; ambra = stantio.
- Flip assente nel piano (nessuno zero-crossing) → la linea non viene disegnata:
  non è un errore, è il dato (vedi discussione flip/max pain della scala).

## Perché serve la vista Somma

`Net` risponde a "da che lato pende lo strike", NON a "quanto è grande".
Su un libro bilanciato il netto azzera proprio lo strike più grosso:

| strike | call | put | Σ | netto | netto % |
|---|---|---|---|---|---|
| SPX 7000 | 1.323.669 | 1.487.105 | **2.810.774** | −163.436 | −5,9% |
| SPX 8000 | 1.244.693 | 1.118.719 | **2.363.412** | +125.974 | +5,3% |

Fonte di quei due: LEAPS su numeri tondi (la sola scadenza Dic 2026 vale 1,67M
dei 2,8M contratti). In `Net` sono invisibili; in `Somma` sono le due barre
più lunghe del pannello, 6,5x e 5,5x la terza. Nota d'uso: la loro GEX lorda
è enorme su "Tutte", ma **zero in 0DTE** (stanno 500 pt fuori): sono magneti
dormienti — contano come struttura, non come pin di giornata. Regola:
`Somma` + borsa 0DTE/≤7gg per i livelli operativi, `Somma` + Tutte per la
mappa del libro.

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
