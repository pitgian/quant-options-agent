async function test() {
  const symbols = ['SPY', 'QQQ', 'ES=F', 'NQ=F', '^SPX', '^NDX'];
  const quotes = {};
  
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const response = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const result = data?.chart?.result?.[0];
        const meta = result?.meta;
        const closes = result?.indicators?.quote?.[0]?.close || [];
        
        let lastCandlePrice = null;
        for (let i = closes.length - 1; i >= 0; i--) {
          if (closes[i] !== null && closes[i] !== undefined) {
            lastCandlePrice = closes[i];
            break;
          }
        }
        
        quotes[symbol] = {
          live: meta?.regularMarketPrice || lastCandlePrice,
          prevClose: meta?.chartPreviousClose || meta?.previousClose || lastCandlePrice
        };
      } catch (err) {
        console.error(`Error fetching ${symbol}:`, err.message);
      }
    })
  );

  console.log('Fetched quotes:', quotes);

  // Extract variables with defaults
  const spyPrev = quotes['SPY']?.prevClose || null;
  const qqqPrev = quotes['QQQ']?.prevClose || null;
  
  const esLive = quotes['ES=F']?.live || null;
  const esPrev = quotes['ES=F']?.prevClose || null;
  
  const nqLive = quotes['NQ=F']?.live || null;
  const nqPrev = quotes['NQ=F']?.prevClose || null;
  
  const spxPrev = quotes['^SPX']?.prevClose || null;
  const ndxPrev = quotes['^NDX']?.prevClose || null;

  console.log('\nCalculating prices ALWAYS derived from futures (24/5)...');
  
  const esRatio = (esLive && esPrev) ? (esLive / esPrev) : 1.0;
  const nqRatio = (nqLive && nqPrev) ? (nqLive / nqPrev) : 1.0;
  
  const derivedSPX = spxPrev ? Number((spxPrev * esRatio).toFixed(2)) : null;
  const derivedNDX = ndxPrev ? Number((ndxPrev * nqRatio).toFixed(2)) : null;
  const derivedSPY = spyPrev ? Number((spyPrev * esRatio).toFixed(2)) : null;
  const derivedQQQ = qqqPrev ? Number((qqqPrev * nqRatio).toFixed(2)) : null;

  const result = {
    SPX: derivedSPX,
    NDX: derivedNDX,
    SPY: derivedSPY,
    QQQ: derivedQQQ,
    ES: esLive,
    NQ: nqLive,
    timestamp: new Date().toISOString()
  };

  console.log('\nDerived results:', result);
  console.log('Calculated Basis (ES - SPX):', esLive && derivedSPX ? (esLive - derivedSPX).toFixed(2) : null);
  console.log('Calculated Basis (NQ - NDX):', nqLive && derivedNDX ? (nqLive - derivedNDX).toFixed(2) : null);
}

test();
