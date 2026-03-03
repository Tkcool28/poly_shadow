import axios from 'axios';

const BINANCE_API = 'https://api.binance.com';
const MAX_KLINES_PER_REQUEST = 1000;

// Binance symbol mapping
const ASSET_SYMBOLS: Record<string, string> = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
};

export interface Kline {
  openTime: number;   // ms
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime: number;  // ms
  volume: number;
}

/**
 * Fetch historical OHLCV klines from Binance public REST API.
 * Automatically paginates when the range exceeds 1000 candles.
 * No authentication required.
 */
export async function fetchKlines(
  asset: string,
  interval: string,
  startTime: number,
  endTime: number,
): Promise<Kline[]> {
  const symbol = ASSET_SYMBOLS[asset.toLowerCase()];
  if (!symbol) throw new Error(`Unsupported asset: ${asset}`);

  const allKlines: Kline[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const response = await axios.get(`${BINANCE_API}/api/v3/klines`, {
      params: {
        symbol,
        interval,
        startTime: cursor,
        endTime,
        limit: MAX_KLINES_PER_REQUEST,
      },
      timeout: 15000,
    });

    const raw: unknown[][] = response.data;
    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const k of raw) {
      allKlines.push({
        openTime: Number(k[0]),
        open: parseFloat(k[1] as string),
        high: parseFloat(k[2] as string),
        low: parseFloat(k[3] as string),
        close: parseFloat(k[4] as string),
        volume: parseFloat(k[5] as string),
        closeTime: Number(k[6]),
      });
    }

    // Move cursor past the last received kline
    const lastClose = Number(raw[raw.length - 1][6]);
    cursor = lastClose + 1;

    // Avoid hammering Binance on large ranges
    if (raw.length === MAX_KLINES_PER_REQUEST) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return allKlines;
}
