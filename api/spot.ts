/**
 * /api/spot — Vercel Serverless Function for Real-Time Spot Prices
 *
 * Fetches real-time US stock quotes from Finnhub API (free tier: 60 calls/min).
 * Returns spot prices for SPY/QQQ and derived index prices for SPX/NDX.
 *
 * Requires FINNHUB_API_KEY environment variable (configure in Vercel env vars).
 *
 * @module api/spot
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const ETF_INDEX_RATIOS: Record<string, { etf: string; ratio: number }> = {
  SPX: { etf: 'SPY', ratio: 10.0 },
  NDX: { etf: 'QQQ', ratio: 41.0 },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });
  }

  try {
    // Fetch SPY and QQQ quotes in parallel
    const [spyRes, qqqRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${apiKey}`),
      fetch(`https://finnhub.io/api/v1/quote?symbol=QQQ&token=${apiKey}`),
    ]);

    const spyData = (await spyRes.json()) as { c?: number };
    const qqqData = (await qqqRes.json()) as { c?: number };

    const spots: Record<string, number> = {};
    const derived: Record<string, number> = {};

    // Parse ETF prices
    const spyPrice = spyData.c ?? null;
    const qqqPrice = qqqData.c ?? null;

    if (spyPrice && spyPrice > 0) {
      spots.SPY = spyPrice;
      derived.SPX = Math.round(spyPrice * ETF_INDEX_RATIOS.SPX.ratio * 100) / 100;
    }
    if (qqqPrice && qqqPrice > 0) {
      spots.QQQ = qqqPrice;
      derived.NDX = Math.round(qqqPrice * ETF_INDEX_RATIOS.NDX.ratio * 100) / 100;
    }

    if (Object.keys(spots).length === 0) {
      return res.status(502).json({ error: 'No spot data available', spy: spyData, qqq: qqqData });
    }

    return res.status(200).json({
      spots,
      derived,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch spot prices', details: String(error) });
  }
}
