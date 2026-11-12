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
//  GexOiProfile — profilo NETTO OI/GEX per strike + linee Spot/MaxPain/Flip
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
//  put-dominato/trigger), linee Spot (live dal grafico) / Max Pain / Flip
//  sempre visibili, badge di freschezza del piano.
//
//  RIFERIMENTI: NESSUNO extra — il parsing usa JavaScriptSerializer
//  (System.Web.Extensions, già referenziata di default da NT8). NOTA:
//  NON usare Newtonsoft + reference manuale nel csproj — NT8 rigenera il
//  csproj a ogni compilazione e scarta i riferimenti aggiunti a mano.
//  Tutte le richieste HTTP sono asincrone (mai blocco del thread UI);
//  il risultato torna al thread grafico via TriggerCustomEvent.
// ============================================================================

namespace NinjaTrader.NinjaScript.Indicators
{
	public enum GexOiFutures { Auto, ES, NQ }
	public enum GexOiSource  { Indice, ETF }
	public enum GexOiBucket  { Tutte, Settimana, ZeroDTE }
	public enum GexOiLato    { Sinistra, Destra }
	public enum GexOiMetric  { GEX, OI }

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
		private DateTime planTime = DateTime.MinValue;
		private double   planSpot;              // last_price del piano (fallback)
		private double   maxPain;               // scala fut
		private double   flip;                  // flip strutturale (scala fut)
		private double   flip0;                 // flip 0DTE (scala fut, opzionale)
		private bool     hasFlip, hasFlip0, hasMaxPain;
		private string   regimeTxt = "";
		private string   fetchError = "";
		private DateTime lastFetch = DateTime.MinValue;

		private int fetching;                   // 0 = idle, 1 = in volo (Interlocked)
		private System.Timers.Timer timer;      // thread-pool: non dipende dal dispatcher UI
		private bool loggedGeom;

		private sealed class ProfileBar { public double S; public double Net; }

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
				Description                    = "Profilo netto OI/GEX per strike (dal piano QuantFlow) + linee Spot/MaxPain/Flip.";
				Name                           = "GexOiProfile";
				Calculate                      = Calculate.OnPriceChange;
				IsOverlay                      = true;
				DisplayInDataBox               = false;
				DrawOnPricePanel               = true;
				PaintPriceMarkers              = false;
				IsSuspendedWhileInactive       = false;
				BarsRequiredToPlot             = 0;

				Lato                           = GexOiLato.Destra;
				PixelBinSize                   = 6;
				OptFutures                     = GexOiFutures.Auto;
				OptSource                      = GexOiSource.Indice;
				OptBucket                      = GexOiBucket.Tutte;
				OptMetric                      = GexOiMetric.GEX;
				WindowPct                      = 5;
				RefreshMinutes                 = 5;
				StaleMinutes                   = 15;
				ProfileWidthPct                = 10;
				OffsetDallaDestraPx            = 0;
				ShowFlip0Dte                   = false;

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

			hasFlip = hasFlip0 = false;
			flip = flip0 = 0;
			string flipName  = idx ? "GEX-FLIP-IDX"      : "GEX-FLIP";
			string flip0Name = idx ? "GEX-FLIP-0DTE-IDX" : "GEX-FLIP-0DTE";
			object[] levels = ToArray(plan.TryGetValue("levels", out var levelsObj) ? levelsObj : null);
			if (levels != null)
			{
				foreach (var lo in levels)
				{
					var lv = lo as Dictionary<string, object>;
					if (lv == null) continue;
					string nm = TryStr(lv, "name") ?? "";
					double pr = TryNum(lv, "price");
					if (nm == flipName)  { flip  = pr; hasFlip  = pr > 0; }
					if (nm == flip0Name) { flip0 = pr; hasFlip0 = pr > 0; }
				}
			}

			// profilo per strike: ENTRAMBE le fonti sono già in scala futures
			string profKey = idx
				? (OptBucket == GexOiBucket.ZeroDTE  ? "gex_profile_0dte_index"
				 : OptBucket == GexOiBucket.Settimana ? "gex_profile_week_index"
				 : "gex_profile_index")
				: (OptBucket == GexOiBucket.ZeroDTE  ? "gex_profile_0dte_binned"
				 : OptBucket == GexOiBucket.Settimana ? "gex_profile_week_binned"
				 : "gex_profile_binned");

			var outBars = new List<ProfileBar>();
			object[] profArr = ToArray(plan.TryGetValue(profKey, out var profObj) ? profObj : null);
			if (profArr != null)
			{
				foreach (var eo in profArr)
				{
					var e = eo as Dictionary<string, object>;
					if (e == null) continue;
					double s = TryNum(e, "s");
					if (s <= 0) continue;
					double net = OptMetric == GexOiMetric.GEX
						? TryNum(e, "c") + TryNum(e, "p")
						: TryNum(e, "co") - TryNum(e, "po");
					outBars.Add(new ProfileBar { S = s, Net = net });
				}
			}

			outBars = outBars.OrderBy(b => b.S).ToList();
			bars = outBars.Count > 0 ? outBars : null;
			fetchError = bars == null ? "profilo '" + profKey + "' assente o vuoto" : "";
			Log(string.Format("GexOiProfile[{0}]: piano {1} (raw: {2}) · {3} strike · mp={4} · flip={5}",
				key, planTime.ToString("HH:mm"), TryStr(plan, "generated_at"),
				bars == null ? 0 : bars.Count, maxPain, flip), LogLevel.Information);
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

				// ---- finestra ±WindowPct% attorno allo spot live
				var inWin = bars.Where(b => Math.Abs(b.S - spot) / spot * 100 <= WindowPct).ToList();

				// ---- SOLO gli strike nel range prezzi VISIBILE a schermo: zoom in
				//      = pochi strike grandi e leggibili, zoom out = profilo
				//      completo. Senza questo: centinaia di rettangoli impilati
				//      fuori scala (feedback 12/11 "miscuglio di rettangoli").
				var vis = new List<ProfileBar>();
				foreach (var b in inWin)
				{
					float y = (float)chartScale.GetYByValue(b.S);
					if (y >= 16 && y <= panelH - 16) vis.Add(b);
				}
				float maxAbs = 0.01f;
				foreach (var b in vis) maxAbs = Math.Max(maxAbs, (float)Math.Abs(b.Net));

				float ySpot = (float)chartScale.GetYByValue(spot);

				// fondale scuro dietro la colonna profilo (sotto la fascia header)
				using (var bBg = new SolidColorBrush(RenderTarget, new Color4(0.05f, 0.08f, 0.12f, 0.60f)))
					RenderTarget.FillRectangle(new SharpDX.RectangleF(xLeft, 22, xRight - xLeft, panelH - 26), bBg);

				using (var bBase = new SolidColorBrush(RenderTarget, new Color4(0.35f, 0.40f, 0.47f, 0.9f)))
					RenderTarget.DrawLine(new SharpDX.Vector2(xRight, 22), new SharpDX.Vector2(xRight, panelH - 4), bBase, 1f);

				// ---- BARRE A BIN PIXEL-FISSI: una barra ogni PixelBinSize px (default 8)
				//      qualunque zoom -> max ~70 barre, ordinate, MAI sovrapposte.
				//      Ogni bin somma il net degli strike che cadono nella sua fascia
				//      di prezzo: e la granularita che fa l'istogramma InsiderFinance.
				int    nBins = Math.Max(1, (int)((panelH - 44) / PixelBinSize));
				float  yTop  = 22f;
				var bins = new double[nBins];
				var binS = new double[nBins];   // prezzo rappresentativo del bin
				for (int i = 0; i < nBins; i++) { bins[i] = 0; binS[i] = double.NaN; }
				foreach (var b in vis)
				{
					float y = (float)chartScale.GetYByValue(b.S);
					int i = (int)((y - yTop) / PixelBinSize);
					if (i < 0 || i >= nBins) continue;
					bins[i] += b.Net;
					// prezzo del bin = lo strike piu vicino al centro del bin
					float yc = yTop + (i + 0.5f) * PixelBinSize;
					if (double.IsNaN(binS[i]) || Math.Abs(y - yc) < Math.Abs((float)chartScale.GetYByValue(binS[i]) - yc))
						binS[i] = b.S;
				}
				float maxBin = 0.01f;
				foreach (var v in bins) maxBin = Math.Max(maxBin, (float)Math.Abs(v));

				float colW = xRight - xLeft;
				for (int i = 0; i < nBins; i++)
				{
					if (bins[i] == 0 || double.IsNaN(binS[i])) continue;
					float y  = yTop + i * PixelBinSize;
					float bh = 3f;                                    // SOFFITTO DURO: barra sottile sempre
					float len = Math.Max(2f, (float)(Math.Abs(bins[i]) / maxBin) * colW * 0.50f);  // max META' colonna
					var c4 = bins[i] >= 0 ? new Color4(0.20f, 0.83f, 0.60f, 0.90f) : new Color4(0.97f, 0.44f, 0.44f, 0.90f);
					using (var bb = new SolidColorBrush(RenderTarget, c4))
						RenderTarget.FillRectangle(new SharpDX.RectangleF(xRight - len, y, xRight, y + bh), bb);
				}
				// etichette: i 3 bin piu grossi per |net|
				var topIdx = Enumerable.Range(0, nBins)
					.Where(i => bins[i] != 0)
					.OrderByDescending(i => Math.Abs(bins[i])).Take(3);
				foreach (int i in topIdx)
				{
					float y = yTop + i * PixelBinSize;
					float len = Math.Max(2f, (float)(Math.Abs(bins[i]) / maxBin) * colW * 0.50f);
					DrawTextRight(RenderTarget, tf, brush, binS[i].ToString("0"), Math.Max(xLeft, xRight - len - 38), y - 1);
				}

				// ---- linee: Spot (tratteggiata blu) / Max Pain (ambra) / Flip (viola)
				var lines = new List<Tuple<float, Color4, string>>();
				lines.Add(Tuple.Create(ySpot, new Color4(0.42f, 0.66f, 0.95f, 0.9f), "Spot " + spot.ToString("0")));
				if (hasMaxPain)
					lines.Add(Tuple.Create((float)chartScale.GetYByValue(maxPain),
						new Color4(0.98f, 0.75f, 0.25f, 0.95f), "MP " + maxPain.ToString("0")));
				if (hasFlip)
					lines.Add(Tuple.Create((float)chartScale.GetYByValue(flip),
						new Color4(0.72f, 0.55f, 0.95f, 0.95f), "Flip " + flip.ToString("0")));
				if (ShowFlip0Dte && hasFlip0)
					lines.Add(Tuple.Create((float)chartScale.GetYByValue(flip0),
						new Color4(0.72f, 0.55f, 0.95f, 0.55f), "Flip0 " + flip0.ToString("0")));

				// etichette: se due linee sono troppo vicine (flip≈max pain!), allontana le scritte
				for (int i = 1; i < lines.Count; i++)
				{
					float d = lines[i].Item1 - lines[i - 1].Item1;
					if (Math.Abs(d) < 14)
						lines[i] = Tuple.Create(lines[i].Item1 + (d >= 0 ? 14f : -14f), lines[i].Item2, lines[i].Item3);
				}

				foreach (var ln in lines)
				{
					float yL = ln.Item1;
					if (yL < 16 || yL > panelH - 16) continue;
					using (var bL = new SolidColorBrush(RenderTarget, ln.Item2))
					{
						DrawDashed(RenderTarget, bL, px + 10, xLeft - 6, yL, 9, 5);
						RenderTarget.DrawLine(new SharpDX.Vector2(xLeft - 6, yL), new SharpDX.Vector2(xRight, yL), bL, 1f);
						DrawTextLeft(RenderTarget, tf, bL, ln.Item3, px + 12, yL - 14);
					}
				}

				// legenda
				DrawTextRight(RenderTarget, tf, brush,
					"verde = net ≥ 0 (pin) · rosso = net < 0 (trg)" + (regimeTxt.Length > 0 ? " · regime " + regimeTxt : ""),
					xRight, panelH - 18);
			}
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
		[Display(Name = "Dimensione bin (px) — altezza di ogni barra", Order = 2, GroupName = "1. Dati")]
		public int PixelBinSize { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Futures (Auto = dal grafico)", Order = 2, GroupName = "1. Dati")]
		public GexOiFutures OptFutures { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Fonte opzioni", Order = 2, GroupName = "1. Dati")]
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
	}
}
