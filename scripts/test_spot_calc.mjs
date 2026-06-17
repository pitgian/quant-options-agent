async function test() {
  try {
    // 1. Fetch futures quotes
    const futSymbols = ['ES=F', 'NQ=F'];
    const futQuotes = {};
    for (const sym of futSymbols) {
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`);
      const data = await response.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) {
        futQuotes[sym] = {
          live: meta.regularMarketPrice,
          close: meta.chartPreviousClose
        };
      }
    }
    console.log('Futures quotes:', futQuotes);

    // 2. Fetch index/ETF previous closes
    const symbols = ['SPY', 'QQQ', '^SPX', '^NDX'];
    const closes = {};
    for (const sym of symbols) {
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`);
      const data = await response.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) {
        closes[sym] = meta.chartPreviousClose;
      }
    }
    console.log('Index/ETF closes:', closes);

    // 3. Compute real-time spot prices
    const esRatio = futQuotes['ES=F'].live / futQuotes['ES=F'].close;
    const nqRatio = futQuotes['NQ=F'].live / futQuotes['NQ=F'].close;

    const realTimeSpot = {
      SPY: Number((closes['SPY'] * esRatio).toFixed(2)),
      QQQ: Number((closes['QQQ'] * nqRatio).toFixed(2)),
      SPX: Number((closes['^SPX'] * esRatio).toFixed(2)),
      NDX: Number((closes['^NDX'] * nqRatio).toFixed(2)),
      timestamp: new Date().toISOString()
    };

    console.log('Calculated real-time spot prices:', realTimeSpot);
  } catch (error) {
    console.error(error);
  }
}

test();
