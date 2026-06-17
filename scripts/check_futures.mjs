async function test() {
  try {
    const symbols = ['ES=F', 'NQ=F'];
    for (const symbol of symbols) {
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`);
      const data = await response.json();
      console.log(`--- ${symbol} ---`);
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) {
        console.log(`regularMarketPrice:`, meta.regularMarketPrice);
        console.log(`chartPreviousClose:`, meta.chartPreviousClose);
        console.log(`price:`, meta.regularMarketPrice);
      } else {
        console.log(`Error parsing data:`, data);
      }
    }
  } catch (error) {
    console.error(error);
  }
}

test();
