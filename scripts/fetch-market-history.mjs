#!/usr/bin/env node
/**
 * Fetch the longest daily history each free, keyless public API will give us for
 * the two instruments this account traded.
 *
 *   BTC — Bitstamp BTC/USD, from 2011-08-18 (the earliest daily series found)
 *   ETH — Bitfinex ETH/USD, from 2016-03-09 (earliest available; ETH mainnet
 *         launched 2015-07-30 but the free sources reachable here start later)
 *
 * Neither venue is BitMEX, where the account actually traded, so the series is
 * market context rather than the account's own prices. The site labels the venue
 * and the first day on each chart.
 *
 * Output is committed, so the site build needs no network access.
 *
 * Usage: node scripts/fetch-market-history.mjs
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'results', 'market-history.json');

const DAY = 86400;
const UA = 'aoa-bitmex-analysis/1.0 (market history fetch)';

const isoDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Bitstamp: paged forward, 1000 bars per request -------------------------
async function bitstamp(pair, fromSec) {
  const bars = [];
  let cursor = fromSec;
  const now = Math.floor(Date.now() / 1000);
  for (let page = 0; page < 40 && cursor < now; page += 1) {
    const url = `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${DAY}&limit=1000&start=${cursor}`;
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`bitstamp ${pair}: HTTP ${res.status}`);
    const rows = (await res.json()).data?.ohlc ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      bars.push({
        t: Number(r.timestamp),
        open: Number(r.open), high: Number(r.high), low: Number(r.low),
        close: Number(r.close), volume: Number(r.volume),
      });
    }
    const last = Number(rows[rows.length - 1].timestamp);
    if (rows.length < 1000) break;
    cursor = last + DAY;
    await sleep(200);
  }
  return bars;
}

// --- Bitfinex: paged forward, 10000 bars per request ------------------------
async function bitfinex(symbol, fromSec) {
  const bars = [];
  let cursor = fromSec * 1000;
  const nowMs = Date.now();
  for (let page = 0; page < 20 && cursor < nowMs; page += 1) {
    const url = `https://api-pub.bitfinex.com/v2/candles/trade:1D:t${symbol}/hist?limit=10000&start=${cursor}&sort=1`;
    let rows = null;
    // Bitfinex answers with {"error":"ERR_RATE_LIMIT"} under load rather than a
    // 429, so back off and retry instead of treating it as "no data".
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`bitfinex ${symbol}: HTTP ${res.status}`);
      const body = await res.json();
      if (Array.isArray(body)) { rows = body; break; }
      process.stderr.write(`[history] bitfinex ${symbol} returned ${JSON.stringify(body).slice(0, 120)}; retrying\n`);
      await sleep(2000 * (attempt + 1));
    }
    if (rows === null) throw new Error(`bitfinex ${symbol}: no array response after retries`);
    if (rows.length === 0) break;
    for (const r of rows) {
      // Bitfinex candle order is [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME] — close
      // comes before high/low, unlike most exchanges. Reading it as
      // open/high/low/close silently produces bars where close < low.
      bars.push({
        t: Math.floor(r[0] / 1000),
        open: r[1], close: r[2], high: r[3], low: r[4], volume: r[5],
      });
    }
    const last = rows[rows.length - 1][0];
    if (rows.length < 10000) break;
    cursor = last + DAY * 1000;
    await sleep(200);
  }
  return bars;
}

/** Drop duplicate days and any bar outside the requested window. */
function clean(bars) {
  const seen = new Set();
  const out = [];
  for (const b of bars.sort((a, b) => a.t - b.t)) {
    const day = isoDay(b.t);
    if (seen.has(day)) continue;
    if (!(b.low > 0) || !(b.high >= Math.max(b.open, b.close)) || !(b.low <= Math.min(b.open, b.close))) continue;
    seen.add(day);
    out.push(b);
  }
  return out;
}

const SOURCES = [
  {
    panel: 'BTC', label: 'BTC/USD', venue: 'Bitstamp', venueUrl: 'https://www.bitstamp.net/',
    from: Date.UTC(2011, 7, 18) / 1000,
    fetch: () => bitstamp('btcusd', Date.UTC(2011, 7, 18) / 1000),
  },
  {
    panel: 'ETH', label: 'ETH/USD', venue: 'Bitfinex', venueUrl: 'https://www.bitfinex.com/',
    from: Date.UTC(2016, 2, 1) / 1000,
    fetch: () => bitfinex('ETHUSD', Date.UTC(2016, 2, 1) / 1000),
  },
];

const series = [];
for (const s of SOURCES) {
  const raw = await s.fetch();
  process.stderr.write(`[history] ${s.label} raw bars: ${raw.length}\n`);
  const bars = clean(raw);
  if (bars.length === 0) throw new Error(`${s.label}: no usable bars after cleaning (raw ${raw.length})`);
  process.stderr.write(`[history] ${s.label} via ${s.venue}: ${bars.length} bars ${isoDay(bars[0].t)} → ${isoDay(bars.at(-1).t)}\n`);
  series.push({
    panel: s.panel,
    label: s.label,
    venue: s.venue,
    venueUrl: s.venueUrl,
    first: isoDay(bars[0].t),
    last: isoDay(bars.at(-1).t),
    bars,
  });
}

const out = {
  fetchedAt: new Date().toISOString(),
  interval: '1d',
  note: 'Continuous daily market history from free public APIs, for context. Neither venue is BitMEX, where this account traded, so prices differ slightly from its fills.',
  series,
};

await fsp.writeFile(OUT, JSON.stringify(out) + '\n');
const size = (await fsp.stat(OUT)).size;
process.stderr.write(`[history] wrote ${path.relative(ROOT, OUT)} (${(size / 1024).toFixed(0)} kB)\n`);
console.log(JSON.stringify(series.map((s) => ({ panel: s.panel, venue: s.venue, bars: s.bars.length, first: s.first, last: s.last })), null, 2));
