#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Timers;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.DrawingTools;
using SharpDX;
using SharpDX.Direct2D1;
using SharpDX.DirectWrite;
#endregion

// ============================================================================
//  GexOiProfile — profilo NETTO OI/GEX per strike + linee MaxPain/Flip
//
//  Dati: NON li ricalcola. Legge il piano già generato dal pipeline
//  (branch 'data' del repo quant-options-agent — lo stesso JSON che alimenta
//  la web app): profili già in SCALA FUTURES, ratio congelato per seduta.
//
//    fonte Indice → gex_profile[_0dte/_week]_index  (raw 5-pt)
//    fonte ETF    → gex_profile[_0dte/_week]_binned (bin 25-pt)
//    netto GEX    = c + p        (Mld $, c>=0, p<=0)
//    netto OI     = co − po      (contratti)
//
//  Render: pannello ancorato al bordo destro, una barra per strike alla
//  SUA quota di prezzo (verde net>=0 = call-dominato/pin, rosso net<0 =
//  put-dominato/trigger), linee Max Pain / Flip (la linea Spot NON c'è: il
//  grafico ha già la sua; le linee partono dall'ultima candela, non dal bordo
//  sinistro, per non attraversare la price action). Fonte Entrambi = somma
//  ETF+indice per strike.
//  sempre visibili, badge di freschezza del piano.
//
//  RIFERIMENTI: NESSUNO extra — il parsing usa JavaScriptSerializer
//  (System.Web.Extensions, già referenziata di default da NT8). NOTA:
//  NON usare Newtonsoft + reference manuale nel csproj — NT8 rigenera il
//  csproj a ogni compilazione e scarta i riferimenti aggiunti a mano.
//  Tutte le richieste HTTP sono asincrone (mai blocco del thread UI);
//  il risultato torna al thread grafico via TriggerCustomEvent.
// ============================================================================

// BUG 13/11 (CS0246 nelle righe della regione generata): gli enum delle
// proprietà NON devono stare in NinjaTrader.NinjaScript.Indicators. La region
// "NinjaScript generated code" che NT appende al file li referenzia SENZA
// qualificarli anche dentro i blocchi namespace NinjaTrader.NinjaScript.
// MarketAnalyzerColumns / .Strategies, dove un enum dichiarato in ...Indicators
// non è risolvibile (→ 20× CS0246 e compilazione fallita). Convenzione già
// usata dal tree (OrderFlowPro): enum a livello GLOBALE, prima dei namespace:
// risolvono da qualunque namespace il codice generato possa usare.
public enum GexOiFutures { Auto, ES, NQ }
// Entrambi = somma ETF + INDICE sullo stesso strike (griglia 25pt in scala
// futures condivisa dalle due fonti _binned) per leggere le ZONE DI
// CONFLUENZA. Aggiunto in coda: gli indici dei valori esistenti (Indice=0,
// ETF=1) restano invariati, i workspace già salvati non si rompono.
public enum GexOiSource  { Indice, ETF, Entrambi }
public enum GexOiBucket  { Tutte, Settimana, ZeroDTE }
public enum GexOiLato    { Sinistra, Destra }
public enum GexOiMetric  { GEX, OI }

namespace NinjaTrader.NinjaScript.Indicators
{
	public class GexOiProfile : Indicator
	{
		// UseProxy=false: NT gira nella sessione utente — se c'è un proxy di
		// sistema questo può RICACHETTARE le risposte (12/11: dalla VM il piano
		// fresco arrivava a chi i test SSH, a NT arrivava quello di 5 ore fa).
		// Headers no-cache + cache-buster sull'URL come doppia cintura.
		private static readonly HttpClient Http = new HttpClient(new HttpClientHandler
		{
			UseProxy = false,
			UseDefaultCredentials = false
		})
		{
			Timeout = TimeSpan.FromSeconds(20)
		};

		private const string PlanUrl =
			"https://raw.githubusercontent.com/pitgian/quant-options-agent/data/data/day_plan.json";

		static GexOiProfile()
		{
			Http.DefaultRequestHeaders.TryAddWithoutValidation("Cache-Control", "no-cache, no-store, max-age=0");
			Http.DefaultRequestHeaders.TryAddWithoutValidation("Pragma", "no-cache");
		}

		// --- stato dati (SOLO thread UI: scritto dentro TriggerCustomEvent) ---
		private List<ProfileBar> bars;          // profilo netto per strike (scala fut)
		// Vista Entrambi: i DUE profili grezzi in scala futures, tenuti separati
		// per il disegno SPECULARE (indice a sinistra, ETF a destra, stesso asse
		// prezzi). Non si sommano: griglie di strike diverse (SPX ~5pt, SPY $1
		// ~10pt su ES) -> la somma su bin comuni sfocava entrambi i libri.
		private List<ProfileBar> twinEtf, twinIdx;
		private DateTime planTime = DateTime.MinValue;
		private double   planSpot;              // last_price del piano (fallback)
		private double   maxPain;               // scala fut
		private double   flip;                  // flip strutturale PRIMARIO (scala fut)
		private double   flip0;                 // flip 0DTE primario (scala fut, opzionale)
		private bool     hasFlip, hasFlip0, hasMaxPain;
		// max pain delle DUE fonti, separati: nella resa speculare ogni livello
		// vive nella meta' della propria catena (indice a sinistra, ETF a destra)
		private double   maxPainEtf, maxPainIdx;
		private bool     hasMaxPainEtf, hasMaxPainIdx;
		// flip delle DUE fonti, parse separato: in modalità Entrambi si mostrano
		// entrambi (i due flip raramente coincidono = informazione di confluenza).
		private double   flipEtf, flipIdx, flip0Etf, flip0Idx;
		private bool     hasFlipEtf, hasFlipIdx, hasFlip0Etf, hasFlip0Idx;
		private string   regimeTxt = "";
		private string   fetchError = "";
		private DateTime lastFetch = DateTime.MinValue;

		private int fetching;                   // 0 = idle, 1 = in volo (Interlocked)
		private System.Timers.Timer timer;      // thread-pool: non dipende dal dispatcher UI
		private bool loggedGeom;
		// Una sola istanza per pannello: nel workspace ne erano state salvate DUE
		// sullo stesso grafico (verificato 14/11 su pitgian.xml) e il profilo veniva
		// disegnato due volte, con etichette doppie = "confusione". La prima che
		// renderizza rivendica il pannello, le altre si astengono e avvisano.
		private static readonly System.Collections.Generic.Dictionary<string, Tuple<string, DateTime>> PanelOwner
			= new System.Collections.Generic.Dictionary<string, Tuple<string, DateTime>>();
		private readonly string instanceId = Guid.NewGuid().ToString("N").Substring(0, 6);
		private bool warnedDuplicate;
		private float twinMaxI, twinMaxE;   // massimi visibili delle due meta' (per la legenda)

		private sealed class ProfileBar { public double S; public double Net; }

		// ZONA DI CONFLUENZA (solo modalità Entrambi): muro dell'ETF e muro
		// dell'indice a distanza <= tolleranza = livello presidiato da ENTRAMBI
		// i libri. I muri delle due fonti quasi MAI coincidono sullo stesso
		// strike (misurato 14/11 su NQ: 0 muri in comune su 8, si alternano a
		// 25-50 pt), quindi sommare i valori produce un profilo sfocato; la
		// confluenza va cercata per ZONA, non per strike.
		private sealed class GexZone { public double Lo, Hi, Center, NetEtf, NetIdx, EtfS, IdxS; }
		private List<GexZone> zones;
		private double tolPts;   // tolleranza zona risolta (pt futures) per il render
		private double minGapPts; // distanza minima reale fra un muro ETF e uno indice (0=n/a)

		// JavaScriptSerializer deserializza gli ARRAY JSON come
		// System.Collections.ArrayList, NON come object[] (verificato 12/11:
		// is object[] = False su levels e profili → 0 strike e flip=0).
		private static object[] ToArray(object o)
		{
			if (o is object[] arr) return arr;
			var al = o as System.Collections.ArrayList;
			return al != null ? al.ToArray() : null;
		}

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description                    = "Profilo netto OI/GEX per strike (dal piano QuantFlow) + linee MaxPain/Flip.";
				Name                           = "GexOiProfile";
				Calculate                      = Calculate.OnPriceChange;
				IsOverlay                      = true;
				DisplayInDataBox               = false;
				DrawOnPricePanel               = true;
				PaintPriceMarkers              = false;
				IsSuspendedWhileInactive       = false;
				BarsRequiredToPlot             = 0;

				Lato                           = GexOiLato.Destra;
				PixelBinSize                   = 10;
				OptFutures                     = GexOiFutures.Auto;
				OptSource                      = GexOiSource.Indice;
				OptBucket                      = GexOiBucket.Tutte;
				OptMetric                      = GexOiMetric.GEX;
				WindowPct                      = 5;
				RefreshMinutes                 = 5;
				StaleMinutes                   = 15;
				ProfileWidthPct                = 10;
				OffsetDallaDestraPx            = 150;
				Lato                           = GexOiLato.Destra;
				ShowFlip0Dte                   = false;
				ScalaComune                    = false;
				ZoneTolPct                     = 0;      // 0 = auto (1.5x griglia nativa ETF)
				WallPct                        = 20;

				AddPlot(System.Windows.Media.Brushes.Transparent, "Void");   // plot fittizio: il disegno è tutto in OnRender
			}
			else if (State == State.DataLoaded)
			{
				FetchPlan();
				// System.Timers.Timer e NON DispatcherTimer: quest'ultimo nasce sul
				// dispatcher del thread che esegue DataLoaded — se NT lo chiama su
				// un thread non-UI il timer non scatta MAI (bug 12/11: zero refresh).
				// Elapsed arriva su thread-pool: FetchPlan è thread-safe
				// (Interlocked + TriggerCustomEvent per il ritorno al thread UI).
				timer = new System.Timers.Timer(30000) { AutoReset = true };
				timer.Elapsed += (s, e) =>
				{
					try
					{
						if ((DateTime.Now - lastFetch).TotalMinutes >= RefreshMinutes)
						{
							Log("GexOiProfile: timer -> fetch " + DateTime.Now.ToString("HH:mm:ss"), LogLevel.Information);
							FetchPlan();
						}
					}
					catch { }
				};
				timer.Start();
			}
			else if (State == State.Terminated)
			{
				if (timer != null) { timer.Stop(); timer.Dispose(); timer = null; }
			}
		}

		// ------------------------------------------------------------------ dati

		private string PlanKey()
		{
			if (OptFutures == GexOiFutures.ES) return "ES";
			if (OptFutures == GexOiFutures.NQ) return "NQ";
			string mi = Instrument != null && Instrument.MasterInstrument != null
				? Instrument.MasterInstrument.Name : "";
			if (mi.Contains("NQ")) return "NQ";      // NQ, MNQ
			if (mi.Contains("ES")) return "ES";      // ES, MES
			return null;
		}

		private void FetchPlan()
		{
			if (Interlocked.CompareExchange(ref fetching, 1, 0) != 0) return;
			Task.Run(() =>
			{
				string json = null, err = null;
				try
				{
					ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
					// cache-buster: raw.githubusercontent.com è dietro CDN e senza
					// query variabile serve copie vecchie di ORE (12/11: piano
					// delle 09:25 servito alle 14:27). Timestamp univoco = cache bypass.
					string url = PlanUrl + "?t=" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
					json = Http.GetStringAsync(url).GetAwaiter().GetResult();
				}
				catch (Exception ex)
				{
					err = ex.Message;
				}
				TriggerCustomEvent(o =>
				{
					lastFetch = DateTime.Now;
					if (err != null)
					{
						fetchError = "fetch: " + err;
						Log("GexOiProfile: FETCH ERROR: " + err, LogLevel.Error);
						fetching = 0; ForceRefresh(); return;
					}
					try { ParsePlan(json); fetchError = ""; }
					catch (Exception ex) { fetchError = "parse: " + ex.Message; Log("GexOiProfile: PARSE ERROR: " + ex.Message, LogLevel.Error); }
					fetching = 0;
					ForceRefresh();
				}, null);
			});
		}

		// --- navigazione JavaScriptSerializer: Dictionary<string,object> / object[]
		private static string TryStr(Dictionary<string, object> d, string k)
		{
			object v;
			return d != null && d.TryGetValue(k, out v) ? v as string : null;
		}

		private static double TryNum(Dictionary<string, object> d, string k)
		{
			object v;
			if (d == null || !d.TryGetValue(k, out v) || v == null) return 0;
			try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); }
			catch { return 0; }
		}

		private DateTime ParseDate(string s)
		{
			if (string.IsNullOrEmpty(s)) return DateTime.MinValue;
			DateTimeOffset dto;
			if (DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out dto))
				return dto.LocalDateTime;
			return DateTime.MinValue;
		}

		private void ParsePlan(string json)
		{
			string key = PlanKey();
			if (key == null) { fetchError = "strumento non ES/NQ: imposta 'Futures' nelle proprietà"; return; }

			var ser  = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
			var root = ser.Deserialize<Dictionary<string, object>>(json);
			if (root == null) { fetchError = "JSON non valido"; return; }

			var plans = root.TryGetValue("plans", out var plansObj) ? plansObj as Dictionary<string, object> : null;
			var plan  = plans != null && plans.TryGetValue(key, out var planObj) ? planObj as Dictionary<string, object> : null;
			if (plan == null) { fetchError = "piano " + key + " assente nel JSON"; return; }

			planTime  = ParseDate(TryStr(plan, "generated_at"));
			planSpot  = TryNum(plan, "last_price");
			string rg = TryStr(plan, "gamma_regime");
			regimeTxt = rg == "long" ? "long gamma" : rg == "short" ? "short gamma" : "";

			bool idx = OptSource == GexOiSource.Indice;

			// Max Pain e flip: entrambi già in SCALA FUTURES nel piano
			maxPain    = TryNum(plan, idx ? "max_pain_nearest_index" : "max_pain_nearest");
			hasMaxPain = maxPain > 0;
			maxPainEtf = TryNum(plan, "max_pain_nearest");
			maxPainIdx = TryNum(plan, "max_pain_nearest_index");
			hasMaxPainEtf = maxPainEtf > 0;
			hasMaxPainIdx = maxPainIdx > 0;

			hasFlip = hasFlip0 = false;
			flip = flip0 = 0;
			// I 4 livelli di flip sono TUTTI in scala futures: li parso sempre
			// tutti e quattro, poi scelgo il primario in base alla modalità.
			flipEtf = flipIdx = flip0Etf = flip0Idx = 0;
			hasFlipEtf = hasFlipIdx = hasFlip0Etf = hasFlip0Idx = false;
			object[] levels = ToArray(plan.TryGetValue("levels", out var levelsObj) ? levelsObj : null);
			if (levels != null)
			{
				foreach (var lo in levels)
				{
					var lv = lo as Dictionary<string, object>;
					if (lv == null) continue;
					string nm = TryStr(lv, "name") ?? "";
					double pr = TryNum(lv, "price");
					if (nm == "GEX-FLIP")          { flipEtf  = pr; hasFlipEtf  = pr > 0; }
					else if (nm == "GEX-FLIP-IDX") { flipIdx  = pr; hasFlipIdx  = pr > 0; }
					else if (nm == "GEX-FLIP-0DTE")     { flip0Etf = pr; hasFlip0Etf = pr > 0; }
					else if (nm == "GEX-FLIP-0DTE-IDX") { flip0Idx = pr; hasFlip0Idx = pr > 0; }
				}
			}
			// primario: in Entrambi si usa l'ETF (come il sito) + l'IDX come linea extra
			flip    = idx ? flipIdx    : flipEtf;    hasFlip    = idx ? hasFlipIdx    : hasFlipEtf;
			flip0   = idx ? flip0Idx   : flip0Etf;   hasFlip0   = idx ? hasFlip0Idx   : hasFlip0Etf;

			// ---- profilo per strike: TUTTE le fonti sono già in SCALA FUTURES.
			//      Indice  -> gex_profile*_index        (raw, passo 5pt)
			//      ETF     -> gex_profile*_binned       (passo 25pt)
			//      Entrambi-> gex_profile*_binned + gex_profile*_index_binned.
			//      ⚠️ Per la somma servono le versioni _binned di ENTRAMBE: la raw
			//      indice è a 5pt e non ha strike in comune con la griglia 25pt
			//      ETF → si affiancherebbero i due libri invece di sommarli.
			string suffix = OptBucket == GexOiBucket.ZeroDTE   ? "_0dte"
				: OptBucket == GexOiBucket.Settimana ? "_week" : "";
			string idxKeyRaw    = "gex_profile" + suffix + "_index";
			string idxKeyBinned = "gex_profile_index" + suffix + "_binned";
			string etfKeyBinned = "gex_profile" + suffix + "_binned";

			var profKeys = new List<string>();
			if (OptSource == GexOiSource.Indice)       profKeys.Add(idxKeyRaw);
			else if (OptSource == GexOiSource.ETF)     profKeys.Add(etfKeyBinned);
			else                                     { profKeys.Add(etfKeyBinned); profKeys.Add(idxKeyBinned); }

			// Somma a strike: SOMMA CORRETTA perché entrambe le serie _binned
			// stanno sulla STESSA griglia 25pt in scala futures (verificato sul
			// piano live: ETF 22725..34025 passo 25, IDX 22775..34025 passo 25,
			// 188 strike comuni + strike presenti in una sola fonte). Uno strike
			// assente da una fonte vale 0: il contributo mancante è zero, non
			// un dato ignoto — quindi la somma non gonfia né perde nulla.
			var merged = new Dictionary<double, double>();
			// profili per fonte tenuti SEPARATI: servono alla detection delle zone
			// di confluenza (Entrambi), che lavora sui MURI di ciascun libro.
			var perFonte = new List<Dictionary<double, double>>();
			int matchedFonte = 0;
			foreach (string pk in profKeys)
			{
				object[] a = ToArray(plan.TryGetValue(pk, out var po) ? po : null);
				if (a == null) continue;
				matchedFonte++;
				var src = new Dictionary<double, double>();
				foreach (var eo in a)
				{
					var e = eo as Dictionary<string, object>;
					if (e == null) continue;
					double s = TryNum(e, "s");
					if (s <= 0) continue;
					double net = OptMetric == GexOiMetric.GEX
						? TryNum(e, "c") + TryNum(e, "p")
						: TryNum(e, "co") - TryNum(e, "po");
					// arrotondo la chiave a 0.1: le due fonti scrivono 25pt esatti,
					// ma non voglio che un 1e-13 di virgola mobile crei doppioni
					double k = Math.Round(s, 1);
					merged[k] = (merged.TryGetValue(k, out var acc) ? acc : 0) + net;
					src[k] = (src.TryGetValue(k, out var accs) ? accs : 0) + net;
				}
				perFonte.Add(src);
			}

			// ---- MURI + ZONE DI CONFLUENZA (solo Entrambi, con 2 fonti reali)
			zones = null;
			if (perFonte.Count == 2)
			{
				// I MURI si cercano sui top_gamma (già aggregati, picchi chiari),
				// NON sui profili binnati che introducono aliasing.
				// top_gamma ha: strike_fut (scala fut), net_gex (dollari), sign, side
				List<KeyValuePair<double, double>> wallsEtf, wallsIdx;

				// Estrai muri da top_gamma ETF
				object[] tgEtfArr = ToArray(plan.TryGetValue("top_gamma" + suffix, out var tgEtfObj) ? tgEtfObj : null);
				wallsEtf = TopGammaToWalls(tgEtfArr);

				// Estrai muri da top_gamma IDX
				object[] tgIdxArr = ToArray(plan.TryGetValue("top_gamma_index" + suffix, out var tgIdxObj) ? tgIdxObj : null);
				wallsIdx = TopGammaToWalls(tgIdxArr);

				// Tolleranza: la STESSA della web app = la griglia operativa della
				// scala (5 pt). 25 pt (il valore vecchio) faceva passare per confluenza
				// muri a 20 pt uno dall'altro, che su ES sono DUE livelli distinti: i
				// "6 zone" della vecchia UI erano tutti falsi positivi (verificato
				// 13/11 sul piano live, gap minimo reale 20 pt).
				double tol = ZoneTolPct > 0
					? planSpot * ZoneTolPct / 100.0
					: 5.0;
				tolPts = tol;

				zones = BuildZones(wallsEtf, wallsIdx, planSpot, tol, 50.0, 50.0);

				// Distanza minima reale fra i due libri: il numero che il trader
				// deve vedere quando le confluenze sono zero.
				minGapPts = 0;
				{
					double best = double.MaxValue;
					foreach (var a in wallsEtf)
						foreach (var b in wallsIdx)
						{
							double d = Math.Abs(a.Key - b.Key);
							if (d < best) best = d;
						}
					if (best != double.MaxValue) minGapPts = best;
				}
				Log(string.Format("GexOiProfile: confluenza -> {0} zone (tol {1:0}pt) · gap minimo ETF↔indice {2:0}pt · soglia muro {3}%",
					zones.Count, tol, minGapPts, WallPct), LogLevel.Information);
			}

			// ---- profili GREZZI per il disegno speculare (solo Entrambi).
			//      ETF: nativo x etf_to_fut_ratio -> scala futures.
			//      IDX: gia' in scala futures nel piano.
			//      Il ratio ETF, se il piano non lo porta, si ricava da
			//      last_price / spot_etf (stesso fallback del sito).
			twinEtf = twinIdx = null;
			if (OptSource == GexOiSource.Entrambi)
			{
				double rEtf = TryNum(plan, "etf_to_fut_ratio");
				if (rEtf <= 0)
				{
					double se = TryNum(plan, "spot_etf");
					if (se > 0 && planSpot > 0) rEtf = planSpot / se;
				}
				if (rEtf > 0)
				{
					var te = new List<ProfileBar>();
					foreach (var kv in RawProfile(plan, "gex_profile" + suffix, rEtf))
						te.Add(new ProfileBar { S = kv.Key, Net = kv.Value });
					var ti = new List<ProfileBar>();
					foreach (var kv in RawProfile(plan, idxKeyRaw, 1.0))
						ti.Add(new ProfileBar { S = kv.Key, Net = kv.Value });
					twinEtf = te.OrderBy(b => b.S).ToList();
					twinIdx = ti.OrderBy(b => b.S).ToList();
					if (twinEtf.Count == 0) twinEtf = null;
					if (twinIdx.Count == 0) twinIdx = null;
				}
			}

			var outBars = new List<ProfileBar>();
			foreach (var kv in merged)
				outBars.Add(new ProfileBar { S = kv.Key, Net = kv.Value });

			outBars = outBars.OrderBy(b => b.S).ToList();
			bars = outBars.Count > 0 ? outBars : null;

			string keysTxt = string.Join("+", profKeys.ToArray());
			fetchError = bars == null ? "profilo '" + keysTxt + "' assente o vuoto" : "";
			if (profKeys.Count > 1 && matchedFonte < 2 && bars != null)
				fetchError = "solo " + matchedFonte + "/2 fonti nel piano (" + keysTxt + ")";
			Log(string.Format("GexOiProfile[{0}]: piano {1} (raw: {2}) · {3} strike · mp={4} · flip={5} · fonti={6}/{7}",
				key, planTime.ToString("HH:mm"), TryStr(plan, "generated_at"),
				bars == null ? 0 : bars.Count, maxPain, flip, matchedFonte, profKeys.Count), LogLevel.Information);
		}

		// ------------------------------------------------------- zone confluenza

		// Muro = |net| >= WallPct% del massimo della PROPRIA fonte (soglia relativa)
		// **E massimo locale** entro ±win. La finestra win è passata da BuildZones:
		// top_gamma: passo ~5-10pt → win=30pt (ETF) / 15pt (IDX) sufficiente.
		private List<KeyValuePair<double, double>> Walls(List<KeyValuePair<double, double>> raw, double win)
		{
			var res = new List<KeyValuePair<double, double>>();
			if (raw == null || raw.Count < 1) return res;
			var a = new List<KeyValuePair<double, double>>(raw);
			a.Sort((p, q) => p.Key.CompareTo(q.Key));
			double mx = 0;
			foreach (var kv in a) mx = Math.Max(mx, Math.Abs(kv.Value));
			if (mx <= 0) return res;
			double thr = mx * WallPct / 100.0;
			for (int i = 0; i < a.Count; i++)
			{
				if (Math.Abs(a[i].Value) < thr) continue;
				double s = a[i].Key;
				bool isMax = true;
				for (int j = i - 1; j >= 0 && a[j].Key >= s - win; j--)
					if (Math.Abs(a[j].Value) > Math.Abs(a[i].Value)) { isMax = false; break; }
				if (isMax)
					for (int j = i + 1; j < a.Count && a[j].Key <= s + win; j++)
						if (Math.Abs(a[j].Value) > Math.Abs(a[i].Value)) { isMax = false; break; }
				if (isMax) res.Add(a[i]);
			}
			return res;
		}

		// profilo RAW in scala futures: 
		private List<KeyValuePair<double, double>> RawProfile(Dictionary<string, object> plan, string key, double scale)
		{
			var res = new List<KeyValuePair<double, double>>();
			object[] a = ToArray(plan.TryGetValue(key, out var o) ? o : null);
			if (a == null) return res;
			foreach (var eo in a)
			{
				var e = eo as Dictionary<string, object>;
				if (e == null) continue;
				double s = TryNum(e, "s");
				if (s <= 0) continue;
				double net = OptMetric == GexOiMetric.GEX
					? TryNum(e, "c") + TryNum(e, "p")
					: TryNum(e, "co") - TryNum(e, "po");
				res.Add(new KeyValuePair<double, double>(Math.Round(s * scale, 1), net));
			}
			return res;
		}

		private static List<KeyValuePair<double, double>> DictToList(Dictionary<double, double> d)
		{
			var res = new List<KeyValuePair<double, double>>();
			if (d != null) foreach (var kv in d) res.Add(new KeyValuePair<double, double>(kv.Key, kv.Value));
			return res;
		}

		// Converte top_gamma JSON in lista di muri (strike_fut, net_gex).
		// top_gamma è già aggregato con picchi chiari — perfetto per wall detection.
		// net_gex è in DOLLARI, lo lasciamo così: Walls usa soglie relative (%).
		private List<KeyValuePair<double, double>> TopGammaToWalls(object[] tgArr)
		{
			var res = new List<KeyValuePair<double, double>>();
			if (tgArr == null || tgArr.Length == 0) return res;
			foreach (var eo in tgArr)
			{
				var e = eo as Dictionary<string, object>;
				if (e == null) continue;
				double sf = TryNum(e, "strike_fut");
				if (sf <= 0) continue;
				double ng = TryNum(e, "net_gex"); // dollari, non Mld
				string sign = TryStr(e, "sign") ?? "";
				// Solo i muri significativi: |net_gex| > 1% del max (soglia fissa)
				res.Add(new KeyValuePair<double, double>(sf, ng));
			}
			return res;
		}

		// Passo nativo medio di una serie di strike (mediana delle differenze):
		// e' la risoluzione VERA della fonte, quella che deve governare sia la
		// finestra di "massimo locale" sia il raggio di confluenza.
		private static double MedianStep(List<KeyValuePair<double, double>> raw)
		{
			if (raw == null || raw.Count < 3) return 0;
			var ss = new List<double>();
			foreach (var kv in raw) ss.Add(kv.Key);
			ss.Sort();
			var d = new List<double>();
			for (int i = 1; i < ss.Count; i++)
			{
				double g = ss[i] - ss[i - 1];
				if (g > 0.01) d.Add(g);
			}
			if (d.Count == 0) return 0;
			d.Sort();
			return d[d.Count / 2];
		}

		private List<GexZone> BuildZones(List<KeyValuePair<double, double>> etf, List<KeyValuePair<double, double>> idx, double spotRef, double tolResolved, double winEtf, double winIdx)
		{
			var res = new List<GexZone>();
			if (spotRef <= 0) return res;
			double tol = tolResolved;
			if (tol <= 0) return res;

			var we = Walls(etf, winEtf);
			var wi = Walls(idx, winIdx);
			if (we.Count == 0 || wi.Count == 0) return res;

			// coppie (muro ETF, muro indice) entro la tolleranza
			var iv = new List<GexZone>();
			foreach (var a in we)
				foreach (var b in wi)
				{
					if (Math.Abs(a.Key - b.Key) > tol) continue;
					iv.Add(new GexZone
					{
						Lo = Math.Min(a.Key, b.Key), Hi = Math.Max(a.Key, b.Key),
						NetEtf = a.Value, NetIdx = b.Value, EtfS = a.Key, IdxS = b.Key
					});
				}
			if (iv.Count == 0) return res;

			// unisco le zone che si sovrappongono o distano meno di una tolleranza
			iv.Sort((p, q) => p.Lo.CompareTo(q.Lo));
			var cur = new GexZone { Lo = iv[0].Lo, Hi = iv[0].Hi, NetEtf = iv[0].NetEtf, NetIdx = iv[0].NetIdx, EtfS = iv[0].EtfS, IdxS = iv[0].IdxS };
			for (int i = 1; i < iv.Count; i++)
			{
				var z = iv[i];
				if (z.Lo <= cur.Hi + tol)
				{
					cur.Hi = Math.Max(cur.Hi, z.Hi);
					if (Math.Abs(z.NetEtf) > Math.Abs(cur.NetEtf)) { cur.NetEtf = z.NetEtf; cur.EtfS = z.EtfS; }
					if (Math.Abs(z.NetIdx) > Math.Abs(cur.NetIdx)) { cur.NetIdx = z.NetIdx; cur.IdxS = z.IdxS; }
				}
				else { res.Add(cur); cur = z; }
			}
			res.Add(cur);

			foreach (var z in res) z.Center = (z.Lo + z.Hi) / 2.0;
			// prima le zone piu "pesanti" (somma dei due muri)
			res.Sort((p, q) => (Math.Abs(q.NetEtf) + Math.Abs(q.NetIdx)).CompareTo(Math.Abs(p.NetEtf) + Math.Abs(p.NetIdx)));
			return res;
		}

		// ---------------------------------------------------------------- render
		protected override void OnRender(ChartControl chartControl, ChartScale chartScale)
		{
			base.OnRender(chartControl, chartScale);
			if (ChartPanel == null || ChartBars == null) return;

			// SELF-REFRESH di sicurezza: il grafico renderizza continuamente in
			// seduta → qui il refresh avviene anche se il timer muore. FetchPlan
			// è protetto da Interlocked e mai bloccante per il thread UI.
			try
			{
				if ((DateTime.Now - lastFetch).TotalMinutes >= RefreshMinutes)
					FetchPlan();
			}
			catch { }

			float panelH = ChartPanel.H;
			// geometria PANNELLO-relativa (ChartPanel.X/W): CanvasLeft/Right del
			// ChartControl in workspace multi-finestra può indicare un'area più
			// larga del pannello → disegno fuori viewport (chart vuoto, 12/11).
			float px = ChartPanel.X > 0 ? ChartPanel.X : 0;
			float pw = ChartPanel.W > 100 ? ChartPanel.W : 1000f;
			float profW  = (float)(pw * ProfileWidthPct / 100.0);
			// Lato Sinistra (default): ancorato al bordo sinistro del pannello -
			// l'angolo destro e occupato dal profilo Price View della suite
			// OrderFlow (rettangoli grandi sovrapposti ai nostri, 12/11).
			// Lato Destra + OffsetDallaDestraPx se disattivi OrderFlow.
			float xLeft2, xRight2;
			if (Lato == GexOiLato.Sinistra)
			{
				xLeft2  = px + 14 + OffsetDallaDestraPx;
				xRight2 = xLeft2 + profW;
			}
			else
			{
				xRight2 = px + pw - 66 - OffsetDallaDestraPx;
				xLeft2  = xRight2 - profW;
			}
			float xLeft  = Math.Max(px + 10, xLeft2);
			float xRight = Math.Min(px + pw - 66, xRight2);
			if (!loggedGeom)
			{
				loggedGeom = true;
				Log(string.Format("GexOiProfile: OnRender px={0} pw={1} xRight={2} xLeft={3} panelH={4} bars={5}",
					px, pw, xRight, xLeft, panelH, bars == null ? -1 : bars.Count), LogLevel.Information);
			}

			double spot = CurrentBar >= 0 ? Close[0] : 0;
			if (spot <= 0) spot = planSpot;

			bool stale = planTime != DateTime.MinValue
				&& (DateTime.Now - planTime).TotalMinutes > StaleMinutes;

			string srcName = OptSource == GexOiSource.Indice ? (PlanKey() == "ES" ? "SPX" : "NDX")
				: OptSource == GexOiSource.Entrambi
					? (PlanKey() == "ES" ? "SPY+SPX" : "QQQ+NDX")
					: (PlanKey() == "ES" ? "SPY" : "QQQ");
			string title = (OptMetric == GexOiMetric.GEX ? "Net GEX" : "Net OI")
				+ " · " + (OptBucket == GexOiBucket.ZeroDTE ? "0DTE" : OptBucket == GexOiBucket.Settimana ? "≤7gg" : "Tutte")
				+ " · " + srcName;

			using (var tf    = new TextFormat(NinjaTrader.Core.Globals.DirectWriteFactory, "Segoe UI", 10f))
			using (var brush = new SolidColorBrush(RenderTarget, new Color4(0.75f, 0.78f, 0.83f, 1f)))
			{
				if (bars == null || bars.Count == 0)
				{
					string msg = string.IsNullOrEmpty(fetchError)
						? "GEX/OI: in attesa del primo piano…"
						: "GEX/OI: " + fetchError;
					using (var bErr = new SolidColorBrush(RenderTarget,
						string.IsNullOrEmpty(fetchError) ? new Color4(0.55f, 0.60f, 0.66f, 1f) : new Color4(0.95f, 0.55f, 0.35f, 1f)))
					{
						DrawTextRight(RenderTarget, tf, bErr, msg, xRight, 6);
						DrawTextRight(RenderTarget, tf, bErr, msg, xLeft, 26);   // copia visibile anche se l'asse/toolbar copre destra
					}
					return;
				}

				var cTitle = stale ? new Color4(0.95f, 0.65f, 0.25f, 1f) : new Color4(0.55f, 0.60f, 0.66f, 1f);
				using (var bT = new SolidColorBrush(RenderTarget, cTitle))
					DrawTextRight(RenderTarget, tf, bT,
						title + " · piano " + (planTime == DateTime.MinValue ? "?" : planTime.ToString("HH:mm"))
						+ (stale ? " ⚠" : ""), xRight, 4);

				// ---- finestra ±WindowPct% attorno allo spot live: STESSO criterio
				//      del sito (GexHistogram.tsx: s in [spot*(1-pct), spot*(1+pct)])
				var inWin = bars.Where(b => Math.Abs(b.S - spot) / spot * 100 <= WindowPct)
					.OrderBy(b => b.S).ToList();

				// ---- SCALA STABILE E IDENTICA AL SITO: yMax = max(maxPos, maxNeg)
				//      calcolato su TUTTE le barre della finestra (non sul solo
				//      visibile a schermo, non a percentili): zoom e pan NON cambiano
				//      la lunghezza relativa delle barre, che corrispondono 1:1
				//      all'istogramma della web app. Lineare come il sito: i muri
				//      dominano, gli strike piccoli restano piccoli (e' la gerarchia
				//      reale del libro, letta uguale su NT e sul sito).
				float maxPos = 0.01f, maxNeg = 0.01f;
				foreach (var b in inWin)
				{
					if (b.Net > 0) maxPos = Math.Max(maxPos, (float)b.Net);
					else           maxNeg = Math.Max(maxNeg, (float)-b.Net);
				}
				float yMax = Math.Max(maxPos, maxNeg);

				using (var bBase = new SolidColorBrush(RenderTarget, new Color4(0.35f, 0.40f, 0.47f, 0.9f)))
					RenderTarget.DrawLine(new SharpDX.Vector2(xRight, 22), new SharpDX.Vector2(xRight, panelH - 4), bBase, 1f);

				// ---- CONFLUENZA (Entrambi): bande viola sulla colonna. Una
				//      confluenza e' un INTERVALLO DI PREZZO, quindi nella colonna
				//      (asse y = prezzo) e' un segmento: rettangolo traslucido largo
				//      quanto la colonna, bordi tratteggiati ai due prezzi, etichetta
				//      ⧉ a destra. Stessa regola del sito: muro ETF e muro indice
				//      dai top_gamma entro ±tolPts (5 pt di default).
				// anti-duplicato: se un'altra istanza ha gia' rivendicato questo
				// pannello in questo frame, non disegno (evita il profilo doppio).
				try
				{
					string pkey = (ChartControl != null ? ChartControl.GetHashCode().ToString() : "0")
						+ "|" + ChartPanel.PanelIndex;
					lock (PanelOwner)
					{
						Tuple<string, DateTime> own;
						if (PanelOwner.TryGetValue(pkey, out own) && own.Item1 != instanceId
							&& (DateTime.Now - own.Item2).TotalSeconds < 3)
						{
							if (!warnedDuplicate)
							{
								warnedDuplicate = true;
								Log("GexOiProfile: due istanze sullo stesso pannello — disegno solo la prima. Rimuovi il duplicato (tasto destro > Indicators).", LogLevel.Warning);
							}
							return;
						}
						PanelOwner[pkey] = Tuple.Create(instanceId, DateTime.Now);
					}
				}
				catch { }

				float colW = xRight - xLeft;
				bool inBoth = OptSource == GexOiSource.Entrambi;
				bool twin = inBoth && twinEtf != null && twinIdx != null
					&& twinEtf.Count > 0 && twinIdx.Count > 0;
				// fascia centrale della resa speculare: le due meta' sono staccate
				// di GUT px, cosi' l'asse prezzi respira e le etichette non si
				// attaccano alle barre (richiesta 14/11).
				const float GUT = 20f;
				// in speculare servono due meta' leggibili: se la colonna e' troppo
				// stretta (default 10% del pannello) la allargo verso sinistra.
				if (twin && colW < 170f)
				{
					xLeft = Math.Max(px + 6, xRight - 170f);
					colW = xRight - xLeft;
				}
				float spineX = xLeft + colW / 2f;
				float anchorL = twin ? spineX - GUT / 2f : xLeft;
				float anchorR = twin ? spineX + GUT / 2f : xRight;

				// PIANO ETICHETTE (declutter da asse prezzi, non "spingi finche' trovi
				// posto"): rail destro = confluenze + MP/Flip, tutte insieme e in
				// ordine di prezzo; punte barra = strike, una lista per meta'.
				// Ogni etichetta spostata ha il suo leader line alla quota vera.
				var rail = new List<Tuple<float, string, Color4>>();
				var tipL = new List<Tuple<float, float, string, Color4>>();  // y, x, testo, colore
				var tipR = new List<Tuple<float, float, string, Color4>>();
				var cConf = new Color4(0.769f, 0.710f, 0.992f, 1f);

				if (inBoth && !twin && zones != null && zones.Count > 0)
				{
					var sel = zones
						.OrderByDescending(z => Math.Abs(z.NetEtf) + Math.Abs(z.NetIdx))
						.Take(6).ToList();
					foreach (var z in sel)
					{
						float yHi = (float)chartScale.GetYByValue(z.Hi + tolPts / 2);
						float yLo = (float)chartScale.GetYByValue(z.Lo - tolPts / 2);
						float top = Math.Max(0f, Math.Min(yHi, yLo));
						float bot = Math.Min(panelH, Math.Max(yHi, yLo));
						if (bot < 0 || top > panelH) continue;
						if (bot - top < 4f) { float c0 = (top + bot) / 2f; top = c0 - 2f; bot = c0 + 2f; }
						using (var bz = new SolidColorBrush(RenderTarget, new Color4(0.545f, 0.361f, 0.965f, 0.13f)))
							RenderTarget.FillRectangle(new SharpDX.RectangleF(xLeft, top, colW, bot - top), bz);
						using (var bb = new SolidColorBrush(RenderTarget, new Color4(0.545f, 0.361f, 0.965f, 0.75f)))
						{
							DrawDashPattern(RenderTarget, bb, xLeft, xRight, top, 3, 3);
							DrawDashPattern(RenderTarget, bb, xLeft, xRight, bot, 3, 3);
						}
						rail.Add(Tuple.Create((top + bot) / 2f, "⧉ " + ((z.Lo + z.Hi) / 2).ToString("0"), cConf));
					}
				}
				if (inBoth && (zones == null || zones.Count == 0))
				{
					// 0 confluenze: messaggio onesto, non bande vuote: e' il dato
					// (le due catene presidiano livelli distinti, gap = minGapPts).
					using (var bNone = new SolidColorBrush(RenderTarget, new Color4(0.55f, 0.60f, 0.66f, 1f)))
						DrawTextLeft(RenderTarget, tf, bNone,
							string.Format("gap minimo {0:0}pt", minGapPts),
							xLeft + 2, panelH - 46);
				}

				// ---- BARRE. Due rese:
				//      · fonte singola  -> una barra per strike, dal bordo destro
				//        della colonna verso sinistra (come il sito).
				//      · Entrambi       -> PROFILO SPECULARE: INDICI a sinistra della
				//        spina centrale, ETF a destra, STESSO asse prezzi (verticale,
				//        scala futures). I due libri non si sommano: hanno griglie di
				//        strike diverse e la somma li sfocava. Ognuna delle due meta'
				//        e' normalizzata al PROPRIO massimo (il libro indice pesa
				//        molto di piu'), oppure a scala comune se ScalaComune=true.

				if (twin)
				{
					float spine = spineX;
					float halfW = colW / 2f - GUT / 2f - 2f;
					var wI = twinIdx.Where(b => Math.Abs(b.S - spot) / spot * 100 <= WindowPct)
						.OrderBy(b => b.S).ToList();
					var wE = twinEtf.Where(b => Math.Abs(b.S - spot) / spot * 100 <= WindowPct)
						.OrderBy(b => b.S).ToList();
					// MASSIMI SUL VISIBILE: la finestra ±WindowPct% copre un range di
					// prezzo molto piu' ampio di quello inquadrato dal grafico; se la
					// scala si calcola su tutta la finestra, i muri fuori schermo
					// schiacciano quelli visibili e il profilo sembra vuoto.
					float mxI = 0.0001f, mxE = 0.0001f;
					foreach (var b in wI)
					{
						float y = (float)chartScale.GetYByValue(b.S);
						if (y < 24 || y > panelH - 24) continue;
						mxI = Math.Max(mxI, (float)Math.Abs(b.Net));
					}
					foreach (var b in wE)
					{
						float y = (float)chartScale.GetYByValue(b.S);
						if (y < 24 || y > panelH - 24) continue;
						mxE = Math.Max(mxE, (float)Math.Abs(b.Net));
					}
					float scI = ScalaComune ? Math.Max(mxI, mxE) : mxI;
					float scE = ScalaComune ? Math.Max(mxI, mxE) : mxE;

					// spina = asse prezzi comune
					using (var bSp = new SolidColorBrush(RenderTarget, new Color4(0.58f, 0.64f, 0.72f, 0.85f)))
						RenderTarget.DrawLine(new SharpDX.Vector2(spine, 22), new SharpDX.Vector2(spine, panelH - 22), bSp, 1.2f);

					// meta' INDICI (sinistra) e meta' ETF (destra): tinta di campo
					using (var bFi = new SolidColorBrush(RenderTarget, new Color4(0.133f, 0.827f, 0.933f, 0.05f)))
						RenderTarget.FillRectangle(new SharpDX.RectangleF(xLeft, 22, anchorL - xLeft, panelH - 44), bFi);
					using (var bFe = new SolidColorBrush(RenderTarget, new Color4(0.984f, 0.749f, 0.141f, 0.05f)))
						RenderTarget.FillRectangle(new SharpDX.RectangleF(anchorR, 22, xRight - anchorR, panelH - 44), bFe);
					// fascia centrale: fondo scuro + due hairline = le meta' sono staccate
					using (var bG = new SolidColorBrush(RenderTarget, new Color4(0.043f, 0.067f, 0.106f, 0.92f)))
						RenderTarget.FillRectangle(new SharpDX.RectangleF(anchorL, 22, GUT, panelH - 44), bG);
					using (var bGl = new SolidColorBrush(RenderTarget, new Color4(0.133f, 0.827f, 0.933f, 0.45f)))
						RenderTarget.DrawLine(new SharpDX.Vector2(anchorL, 22), new SharpDX.Vector2(anchorL, panelH - 22), bGl, 1f);
					using (var bGr = new SolidColorBrush(RenderTarget, new Color4(0.984f, 0.749f, 0.141f, 0.45f)))
						RenderTarget.DrawLine(new SharpDX.Vector2(anchorR, 22), new SharpDX.Vector2(anchorR, panelH - 22), bGr, 1f);

					// bande di confluenza: attraversano TUTTA la colonna
					if (zones != null)
						foreach (var z in zones.OrderByDescending(z => Math.Abs(z.NetEtf) + Math.Abs(z.NetIdx)).Take(6))
						{
							float yHi = (float)chartScale.GetYByValue(z.Hi + tolPts / 2);
							float yLo = (float)chartScale.GetYByValue(z.Lo - tolPts / 2);
							float t0 = Math.Max(22f, Math.Min(yHi, yLo)), b0 = Math.Min(panelH - 22f, Math.Max(yHi, yLo));
							if (b0 < 22 || t0 > panelH - 22) continue;
							if (b0 - t0 < 4f) { float c0 = (t0 + b0) / 2f; t0 = c0 - 2f; b0 = c0 + 2f; }
							using (var bz = new SolidColorBrush(RenderTarget, new Color4(0.655f, 0.545f, 0.980f, 0.16f)))
								RenderTarget.FillRectangle(new SharpDX.RectangleF(xLeft, t0, colW, b0 - t0), bz);
							using (var bb = new SolidColorBrush(RenderTarget, new Color4(0.655f, 0.545f, 0.980f, 0.7f)))
							{
								DrawDashPattern(RenderTarget, bb, xLeft, xRight, t0, 3, 3);
								DrawDashPattern(RenderTarget, bb, xLeft, xRight, b0, 3, 3);
							}
							rail.Add(Tuple.Create((t0 + b0) / 2f, "⧉ " + ((z.Lo + z.Hi) / 2).ToString("0"), cConf));
						}

					Action<List<ProfileBar>, float, bool> drawHalf = (list, scale, left) =>
					{
						var ys2 = new float[list.Count];
						for (int i = 0; i < list.Count; i++) ys2[i] = (float)chartScale.GetYByValue(list[i].S);
						for (int i = 0; i < list.Count; i++)
						{
							var b = list[i];
							if (b.Net == 0) continue;
							float y = ys2[i];
							if (y < 20 || y > panelH - 20) continue;
							float gap = i + 1 < list.Count ? Math.Abs(ys2[i + 1] - y)
								: i > 0 ? Math.Abs(y - ys2[i - 1]) : 8f;
							float bh = Math.Max(1.5f, Math.Min(PixelBinSize, gap * 0.74f));
							float len = Math.Max(1.5f, (float)Math.Abs(b.Net) / scale * halfW);
							var c4 = b.Net >= 0
								? new Color4(0.204f, 0.827f, 0.600f, 0.92f)
								: new Color4(0.984f, 0.443f, 0.522f, 0.92f);
							using (var bb = new SolidColorBrush(RenderTarget, c4))
								RenderTarget.FillRectangle(new SharpDX.RectangleF(
									left ? anchorL - len : anchorR, y - bh / 2f, len, bh), bb);
						}
					};
					drawHalf(wI, scI, true);    // INDICI a sinistra
					drawHalf(wE, scE, false);   // ETF a destra

					// NIENTE scritte in alto: la fascia alta del pannello e' occupata
					// dal legend degli indicatori di NT8 (le mie si sovrapponevano).
					// Identita' delle due meta' e massimi stanno nella legenda in basso.
					twinMaxI = mxI; twinMaxE = mxE;

					// etichette: i 2 muri piu' grossi PER FONTE, all'estremita' della
					// propria barra (sinistra per l'indice, destra per l'ETF)
					foreach (var pair in new[] { Tuple.Create(wI, scI, true), Tuple.Create(wE, scE, false) })
					{
						var list = pair.Item1; float scale = pair.Item2; bool left = pair.Item3;
						foreach (int i in Enumerable.Range(0, list.Count)
							.OrderByDescending(k => Math.Abs(list[k].Net)).Take(2))
						{
							float y = (float)chartScale.GetYByValue(list[i].S);
							if (y < 30 || y > panelH - 24) continue;
							float len = Math.Max(1.5f, (float)Math.Abs(list[i].Net) / scale * halfW);
							if (left) tipL.Add(Tuple.Create(y, Math.Max(xLeft + 1, anchorL - len + 2),
								list[i].S.ToString("0"), new Color4(0.75f, 0.78f, 0.83f, 1f)));
							else tipR.Add(Tuple.Create(y, Math.Min(xRight - 1, anchorR + len - 2),
								list[i].S.ToString("0"), new Color4(0.75f, 0.78f, 0.83f, 1f)));
						}
					}
				}
				else
				{
				int   nW   = inWin.Count;
				var   ys   = new float[nW];
				for (int i = 0; i < nW; i++) ys[i] = (float)chartScale.GetYByValue(inWin[i].S);
				for (int i = 0; i < nW; i++)
				{
					var b = inWin[i];
					if (b.Net == 0) continue;
					float y = ys[i];
					if (y < -20 || y > panelH + 20) continue;
					float gap = i + 1 < nW ? Math.Abs(ys[i + 1] - y)
						: i > 0 ? Math.Abs(y - ys[i - 1]) : 10f;
					float bh  = Math.Max(2f, Math.Min(PixelBinSize, gap * 0.72f));
					float len = Math.Max(2f, (float)Math.Abs(b.Net) / yMax * colW);
					var c4 = b.Net >= 0
						? new Color4(0.20f, 0.83f, 0.60f, 0.90f)
						: new Color4(0.97f, 0.44f, 0.44f, 0.90f);
					using (var bb = new SolidColorBrush(RenderTarget, c4))
						// RectangleF = (x, y, LARGHEZZA, ALTEZZA) — mai (left, top, right, bottom)
						RenderTarget.FillRectangle(new SharpDX.RectangleF(xRight - len, y - bh / 2f, len, bh), bb);
				}
				}

				// etichette: i 3 strike piu' grossi per |net| nella finestra,
				// attaccate all'estremo destro della propria barra (xRight),
				// stessa quota di prezzo, testo semplice senza riquadri.
				// (in twin le etichette sono gia' state messe per fonte)
				if (!twin)
				{
					var topIdx = Enumerable.Range(0, inWin.Count)
						.OrderByDescending(i => Math.Abs(inWin[i].Net)).Take(3);
					foreach (int i in topIdx)
					{
						float y = (float)chartScale.GetYByValue(inWin[i].S);
						tipR.Add(Tuple.Create(y, xRight - 4, inWin[i].S.ToString("0"),
							new Color4(0.75f, 0.78f, 0.83f, 1f)));
					}
				}

				// ---- linee: Max Pain (ambra) / Flip (viola) / Flip IDX (Entrambi).
				//      Tratteggiate SULLA colonna del profilo (il livello marcato
				//      dove vive il profilo) + etichetta a destra della colonna
				//      alla STESSA quota, testo semplice. NIENTE linea Spot: il grafico ha gia' la sua.
				// linee di riferimento. Nella resa SPECULARE ogni livello vive nella
				// meta' della PROPRIA catena (▲ indice a sinistra, ▼ ETF a destra) e
				// l'etichetta dichiara la fonte: prima si vedevano "MP" e "Flip"
				// senza sapere a quale libro appartenessero.
				var lines = new List<Tuple<float, Color4, string, float, float>>();
				string iNm = PlanKey() == "ES" ? "SPX" : "NDX";
				string eNm = PlanKey() == "ES" ? "SPY" : "QQQ";
				var cMP   = new Color4(0.98f, 0.75f, 0.25f, 0.95f);
				var cFlip = new Color4(0.72f, 0.55f, 0.95f, 0.95f);
				if (twin)
				{
					if (hasMaxPainIdx) lines.Add(Tuple.Create((float)chartScale.GetYByValue(maxPainIdx), cMP,
						"▲ MP " + iNm + " " + maxPainIdx.ToString("0"), xLeft, anchorL));
					if (hasMaxPainEtf) lines.Add(Tuple.Create((float)chartScale.GetYByValue(maxPainEtf), cMP,
						"▼ MP " + eNm + " " + maxPainEtf.ToString("0"), anchorR, xRight));
					if (hasFlipIdx) lines.Add(Tuple.Create((float)chartScale.GetYByValue(flipIdx), cFlip,
						"▲ Flip " + iNm + " " + flipIdx.ToString("0"), xLeft, anchorL));
					if (hasFlipEtf) lines.Add(Tuple.Create((float)chartScale.GetYByValue(flipEtf), cFlip,
						"▼ Flip " + eNm + " " + flipEtf.ToString("0"), anchorR, xRight));
					if (ShowFlip0Dte && hasFlip0Idx) lines.Add(Tuple.Create((float)chartScale.GetYByValue(flip0Idx),
						new Color4(0.72f, 0.55f, 0.95f, 0.6f), "▲ Flip0 " + iNm + " " + flip0Idx.ToString("0"), xLeft, anchorL));
					if (ShowFlip0Dte && hasFlip0Etf) lines.Add(Tuple.Create((float)chartScale.GetYByValue(flip0Etf),
						new Color4(0.72f, 0.55f, 0.95f, 0.6f), "▼ Flip0 " + eNm + " " + flip0Etf.ToString("0"), anchorR, xRight));
				}
				else
				{
					if (hasMaxPain) lines.Add(Tuple.Create((float)chartScale.GetYByValue(maxPain), cMP,
						"MP " + maxPain.ToString("0"), xLeft, xRight));
					if (hasFlip) lines.Add(Tuple.Create((float)chartScale.GetYByValue(flip), cFlip,
						"Flip " + flip.ToString("0"), xLeft, xRight));
					if (inBoth && hasFlipIdx && Math.Abs(flipIdx - flip) > 0.01)
						lines.Add(Tuple.Create((float)chartScale.GetYByValue(flipIdx),
							new Color4(0.62f, 0.42f, 0.92f, 0.85f), "Flip IDX " + flipIdx.ToString("0"), xLeft, xRight));
					if (ShowFlip0Dte && hasFlip0) lines.Add(Tuple.Create((float)chartScale.GetYByValue(flip0),
						new Color4(0.72f, 0.55f, 0.95f, 0.55f), "Flip0 " + flip0.ToString("0"), xLeft, xRight));
				}

				foreach (var ln in lines)
				{
					float yL = ln.Item1;
					if (yL < 4 || yL > panelH - 4) continue;
					using (var bL = new SolidColorBrush(RenderTarget, ln.Item2))
					{
						DrawDashPattern(RenderTarget, bL, ln.Item4, ln.Item5, yL, 6, 3);
						rail.Add(Tuple.Create(yL, ln.Item3, ln.Item2));
					}
				}

				// ---- ETICHETTE: declutter da asse prezzi + leader line alla quota vera
				if (rail.Count > 0)
				{
					var ysR = new float[rail.Count];
					for (int i = 0; i < rail.Count; i++) ysR[i] = rail[i].Item1;
					var adj = Declutter(ysR, 13f, 26f, panelH - 26f);
					for (int i = 0; i < rail.Count; i++)
					{
						float yTrue = rail[i].Item1, yL = adj[i];
						if (yTrue < 2 || yTrue > panelH - 2) continue;
						using (var b = new SolidColorBrush(RenderTarget, rail[i].Item3))
						{
							if (Math.Abs(yL - yTrue) > 2f)
							{
								RenderTarget.DrawLine(new SharpDX.Vector2(xRight, yTrue), new SharpDX.Vector2(xRight + 4, yTrue), b, 1f);
								RenderTarget.DrawLine(new SharpDX.Vector2(xRight + 4, yTrue), new SharpDX.Vector2(xRight + 4, yL), b, 1f);
							}
							DrawTextLeft(RenderTarget, tf, b, rail[i].Item2, xRight + 7, yL - 7);
						}
					}
				}
				foreach (var side in new[] { Tuple.Create(tipL, true), Tuple.Create(tipR, false) })
				{
					var list = side.Item1; bool left = side.Item2;
					if (list.Count == 0) continue;
					var ysT = new float[list.Count];
					for (int i = 0; i < list.Count; i++) ysT[i] = list[i].Item1;
					var adj = Declutter(ysT, 12f, 30f, panelH - 26f);
					for (int i = 0; i < list.Count; i++)
					{
						float yTrue = list[i].Item1, yL = adj[i], xT = list[i].Item2;
						using (var b = new SolidColorBrush(RenderTarget, list[i].Item4))
						{
							if (Math.Abs(yL - yTrue) > 2f)
								RenderTarget.DrawLine(new SharpDX.Vector2(xT, yTrue), new SharpDX.Vector2(xT, yL), b, 0.8f);
							if (left) DrawTextLeft(RenderTarget, tf, b, list[i].Item3, xT, yL - 7);
							else DrawTextRight(RenderTarget, tf, b, list[i].Item3, xT, yL - 7);
						}
					}
				}

				// legenda
				// legenda: righe CORTE ancorate alla colonna (prima una riga lunga
				// veniva tagliata dal bordo del pannello).
				if (twin)
				{
					string l1 = "◀ " + iNm + " " + E(twinMaxI) + " | " + E(twinMaxE) + " " + eNm + " ▶";
					string l2 = "⧉ ±" + tolPts.ToString("0") + "pt: "
						+ (zones == null || zones.Count == 0 ? "0" : zones.Count.ToString())
						+ (ScalaComune ? " · scala comune" : " · scale proprie");
					using (var bI = new SolidColorBrush(RenderTarget, new Color4(0.133f, 0.827f, 0.933f, 1f)))
						DrawTextLeft(RenderTarget, tf, bI, l1, xLeft + 2, panelH - 32);
					using (var bC = new SolidColorBrush(RenderTarget, new Color4(0.769f, 0.710f, 0.992f, 1f)))
						DrawTextLeft(RenderTarget, tf, bC, l2, xLeft + 2, panelH - 18);
				}
				else
				{
					string leg = inBoth
						? "⧉ ±" + tolPts.ToString("0") + "pt: " + (zones == null || zones.Count == 0 ? "0" : zones.Count.ToString())
						: "verde = pin · rosso = trigger";
					if (regimeTxt.Length > 0) leg += " · " + regimeTxt;
					DrawTextLeft(RenderTarget, tf, brush, leg, xLeft + 2, panelH - 18);
				}
			}
		}

		// Declutter da asse prezzi: prende le quote vere, le ordina e le sposta del
		// MINIMO indispensabile (passata avanti + passata indietro), mantenendo
		// l'ordine. Sostituisce il vecchio "spingi giu' di 12px finche' trovi posto",
		// che sparpagliava le etichette in basso e lontano dal loro livello.
		private static float[] Declutter(float[] ys, float minGap, float lo, float hi)
		{
			int n = ys.Length;
			var idx = new int[n];
			for (int i = 0; i < n; i++) idx[i] = i;
			Array.Sort(idx, (a, b) => ys[a].CompareTo(ys[b]));
			var outY = new float[n];
			float prev = lo - minGap;
			foreach (int i in idx)
			{
				float y = Math.Max(ys[i], prev + minGap);
				outY[i] = y; prev = y;
			}
			// se l'ultima sfonda il bordo basso, risali comprimendo verso l'alto
			float next = hi + minGap;
			for (int k = idx.Length - 1; k >= 0; k--)
			{
				int i = idx[k];
				float y = Math.Min(outY[i], next - minGap);
				outY[i] = Math.Max(lo, y); next = outY[i];
			}
			return outY;
		}

		// tratteggio orizzontale con pattern dash/gap generico
		private static void DrawDashPattern(RenderTarget rt, SolidColorBrush b, float x1, float x2, float y, float dash, float gap)
		{
			float x = x1;
			while (x < x2)
			{
				float xEnd = Math.Min(x + dash, x2);
				rt.DrawLine(new SharpDX.Vector2(x, y), new SharpDX.Vector2(xEnd, y), b, 1.2f);
				x = xEnd + gap;
			}
		}

		private static string E(double v)
		{
			double a = Math.Abs(v);
			return a >= 100 ? v.ToString("0") : a >= 10 ? v.ToString("0.0") : v.ToString("0.00");
		}

		private static void DrawDashed(RenderTarget rt, SolidColorBrush b, float x1, float x2, float y, float dash, float gap)
		{
			float x = x1;
			while (x < x2)
			{
				float xEnd = Math.Min(x + dash, x2);
				rt.DrawLine(new SharpDX.Vector2(x, y), new SharpDX.Vector2(xEnd, y), b, 1.2f);
				x = xEnd + gap;
			}
		}

		private static void DrawTextRight(RenderTarget rt, TextFormat tf, SolidColorBrush b, string txt, float xRight, float y)
		{
			rt.DrawText(txt, tf, new SharpDX.RectangleF(xRight - 280, y, 280, 16), b);
		}

		private static void DrawTextLeft(RenderTarget rt, TextFormat tf, SolidColorBrush b, string txt, float x, float y)
		{
			rt.DrawText(txt, tf, new SharpDX.RectangleF(x, y, 220, 15), b);
		}

		// -------------------------------------------------------------- proprietà

		[NinjaScriptProperty]
		[Display(Name = "Lato pannello", Order = 1, GroupName = "1. Dati")]
		public GexOiLato Lato { get; set; }

		[NinjaScriptProperty]
		[Range(4, 30)]
		[Display(Name = "Spessore max barra (px)", Order = 2, GroupName = "1. Dati")]
		public int PixelBinSize { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Futures (Auto = dal grafico)", Order = 2, GroupName = "1. Dati")]
		public GexOiFutures OptFutures { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Fonte opzioni (Entrambi = ETF+indice sommati)", Order = 2, GroupName = "1. Dati")]
		public GexOiSource OptSource { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Borsa di scadenza", Order = 3, GroupName = "1. Dati")]
		public GexOiBucket OptBucket { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Metrica", Order = 4, GroupName = "1. Dati")]
		public GexOiMetric OptMetric { get; set; }

		[NinjaScriptProperty]
		[System.ComponentModel.DataAnnotations.Range(0.5, 20.0)]
		[Display(Name = "Finestra ±% dallo spot", Order = 5, GroupName = "1. Dati")]
		public double WindowPct { get; set; }

		[NinjaScriptProperty]
		[System.ComponentModel.DataAnnotations.Range(1, 60)]
		[Display(Name = "Refresh (minuti)", Order = 6, GroupName = "2. Aggiornamento")]
		public int RefreshMinutes { get; set; }

		[NinjaScriptProperty]
		[System.ComponentModel.DataAnnotations.Range(3, 240)]
		[Display(Name = "Piano stantio dopo (minuti)", Order = 7, GroupName = "2. Aggiornamento")]
		public int StaleMinutes { get; set; }

		[NinjaScriptProperty]
		[System.ComponentModel.DataAnnotations.Range(10, 50)]
		[Display(Name = "Larghezza pannello %", Order = 8, GroupName = "2. Aggiornamento")]
		public double ProfileWidthPct { get; set; }

		[NinjaScriptProperty]
		[Range(0, 600)]
		[Display(Name = "Offset da destra (px)", Order = 9, GroupName = "2. Aggiornamento")]
		public int OffsetDallaDestraPx { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Mostra anche flip 0DTE", Order = 10, GroupName = "2. Aggiornamento")]
		public bool ShowFlip0Dte { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Entrambi: scala comune (invece di una per fonte)", Order = 13, GroupName = "3. Confluenza")]
		public bool ScalaComune { get; set; }

		[NinjaScriptProperty]
		[System.ComponentModel.DataAnnotations.Range(0.0, 2.0)]
		[Display(Name = "Tolleranza zona: 0 = auto (1.5x griglia ETF), altrimenti % spot", Order = 11, GroupName = "3. Confluenza")]
		public double ZoneTolPct { get; set; }

		[NinjaScriptProperty]
		[System.ComponentModel.DataAnnotations.Range(5.0, 80.0)]
		[Display(Name = "Soglia muro (% del max della fonte) — solo Entrambi", Order = 12, GroupName = "3. Confluenza")]
		public double WallPct { get; set; }
	}
}
