#!/usr/bin/env node
/**
 * Fetch real daily market candles for the instruments this account traded.
 *
 * Why this exists: the site's candlestick panel originally drew OHLC
 * reconstructed from the account's own fills, which is honest but sparse (a few
 * hundred prices per year, gaps on days with no trades). This pulls a real
 * continuous daily series so the chart can be read the way a trader reads one.
 *
 * Source: Binance public REST API (`/api/v3/klines`), no key, no account.
 * That is not the venue this account traded on (BitMEX), so the series is
 * labelled as market context rather than as the account's own prices.
 *
 * Output is committed, so the site build itself needs no network access.
 *
 * Usage: node scripts/fetch-market-ohlcv.mjs
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'results', 'market-ohlcv.json');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const START = Date.UTC(2018, 0, 1);
const END = Date.UTC(2022, 0, 1);
const DAY = 86400000;
const BASE = 'https://api.binance.com/api/v3/klines';

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function fetchSymbol(symbol) {
  const bars = [];
  let cursor = START;
  while (cursor < END) {
    const url = `${BASE}?symbol=${symbol}&interval=1d&startTime=${cursor}&endTime=${END - 1}&limit=1000`;
    const res = await fetch(url, { headers: { 'user-agent': 'aoa-bitmex-analysis/1.0' } });
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      bars.push({
        day: isoDay(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      });
    }
    const last = rows[rows.length - 1][0];
    if (rows.length < 1000) break;
    cursor = last + DAY;
    await new Promise((r) => setTimeout(r, 250));
  }
  // de-duplicate on day boundary, keep the first occurrence
  const seen = new Set();
  return bars.filter((b) => (seen.has(b.day) ? false : (seen.add(b.day), true)));
}

const out = {
  fetchedAt: new Date().toISOString(),
  source: 'Binance public REST API /api/v3/klines (no key, no account)',
  sourceUrl: BASE,
  note: 'Continuous daily market candles for context. Binance is not the venue this account traded on (BitMEX), and its BTCUSDT/ETHUSDT prints differ slightly from BitMEX XBTUSD/ETHUSD.',
  interval: '1d',
  window: { from: isoDay(START), to: isoDay(END - DAY) },
  series: [],
};

for (const symbol of SYMBOLS) {
  const bars = await fetchSymbol(symbol);
  process.stderr.write(`[market] ${symbol}: ${bars.length} bars ${bars[0]?.day} → ${bars[bars.length - 1]?.day}\n`);
  out.series.push({ symbol, bars });
}

await fsp.writeFile(OUT, JSON.stringify(out) + '\n');
const size = (await fsp.stat(OUT)).size;
process.stderr.write(`[market] wrote ${path.relative(ROOT, OUT)} (${(size / 1024).toFixed(0)} kB)\n`);
console.log(JSON.stringify(out.series.map((s) => ({ symbol: s.symbol, bars: s.bars.length, first: s.bars[0]?.day, last: s.bars.at(-1)?.day })), null, 2));
