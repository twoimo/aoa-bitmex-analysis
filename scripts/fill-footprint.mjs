#!/usr/bin/env node
/**
 * Where did this account actually trade?
 *
 * Aggregates every fill in the export into two shapes the chart can draw:
 *
 *   days     per day, per charted symbol: the price range the account bought in
 *            and the range it sold in, with counts and notional. Every fill in
 *            those symbols is inside one of these bands.
 *   profile  per charted symbol: notional bucketed by price, i.e. the price
 *            levels this account was most active at.
 *   symbols  every symbol in the export, charted or not, so the page can state
 *            exactly how much of the record the chart covers.
 *
 * The export contains no resting orders, only executions, so this shows where
 * fills happened, not where quotes were posted.
 *
 * Usage: node scripts/fill-footprint.mjs [--data DIR] [--out DIR]
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, num, EXEC_COL } from './lib/csv.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DATA_DIR = path.resolve(arg('--data', path.join(ROOT, '.work', 'data')));
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'results')));

const CHARTED = ['XBTUSD', 'ETHUSD'];
const BUCKETS = 140;

const isoDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

async function main() {
  const all = await fsp.readdir(DATA_DIR);
  const execFiles = all.filter((f) => /^aoa-execution-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));

  const days = new Map();   // `${symbol}|${day}` -> record
  const symbols = new Map(); // symbol -> totals
  const prices = new Map();  // symbol -> {lo, hi, points: []}

  for (const file of execFiles) {
    await parseCsv(file, (r) => {
      if (r.length < 25 || r[EXEC_COL.exectype] !== 'Trade') return;
      const symbol = r[EXEC_COL.symbol] || '?';
      const ts = r[EXEC_COL.transacttime] || r[EXEC_COL.date];
      const day = ts.slice(0, 10);
      const price = num(r[EXEC_COL.lastpx]);
      const notional = Math.abs(num(r[EXEC_COL.foreignNotional]));
      const buy = r[EXEC_COL.side] === 'Buy';
      if (!(price > 0)) return;

      const sym = symbols.get(symbol) ?? { symbol, fills: 0, notionalUsd: 0, firstDay: day, lastDay: day, low: price, high: price };
      sym.fills += 1;
      sym.notionalUsd += notional;
      if (day < sym.firstDay) sym.firstDay = day;
      if (day > sym.lastDay) sym.lastDay = day;
      if (price < sym.low) sym.low = price;
      if (price > sym.high) sym.high = price;
      symbols.set(symbol, sym);

      if (!CHARTED.includes(symbol)) return;

      const key = `${symbol}|${day}`;
      const d = days.get(key) ?? {
        symbol, day, fills: 0, buyFills: 0, sellFills: 0,
        buyLow: null, buyHigh: null, sellLow: null, sellHigh: null,
        buyNotional: 0, sellNotional: 0,
      };
      d.fills += 1;
      if (buy) {
        d.buyFills += 1;
        d.buyLow = d.buyLow === null ? price : Math.min(d.buyLow, price);
        d.buyHigh = d.buyHigh === null ? price : Math.max(d.buyHigh, price);
        d.buyNotional += notional;
      } else {
        d.sellFills += 1;
        d.sellLow = d.sellLow === null ? price : Math.min(d.sellLow, price);
        d.sellHigh = d.sellHigh === null ? price : Math.max(d.sellHigh, price);
        d.sellNotional += notional;
      }
      days.set(key, d);

      const p = prices.get(symbol) ?? { lo: price, hi: price, points: [] };
      if (price < p.lo) p.lo = price;
      if (price > p.hi) p.hi = price;
      p.points.push([price, notional]);
      prices.set(symbol, p);
    });
  }

  // Price profile: log-spaced buckets so 2011-2026 style ranges stay readable.
  const profile = {};
  for (const [symbol, p] of prices) {
    const lo = Math.max(p.lo, p.lo * 0.999);
    const hi = p.hi;
    const logLo = Math.log(lo);
    const logHi = Math.log(hi);
    const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
      p: Number(Math.exp(logLo + (logHi - logLo) * (i + 0.5) / BUCKETS).toFixed(2)),
      notional: 0, fills: 0,
    }));
    for (const [price, notional] of p.points) {
      const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor((Math.log(price) - logLo) / (logHi - logLo || 1) * BUCKETS)));
      buckets[idx].notional += notional;
      buckets[idx].fills += 1;
    }
    profile[symbol] = buckets.map((b) => ({ p: b.p, n: Number(b.notional.toFixed(0)), f: b.fills }));
    p.points = null;
  }

  const dayRows = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.symbol < b.symbol ? -1 : 1))
    .map((d) => ({
      symbol: d.symbol, day: d.day, fills: d.fills,
      buyFills: d.buyFills, sellFills: d.sellFills,
      buyLow: d.buyLow === null ? null : Number(d.buyLow.toFixed(4)),
      buyHigh: d.buyHigh === null ? null : Number(d.buyHigh.toFixed(4)),
      sellLow: d.sellLow === null ? null : Number(d.sellLow.toFixed(4)),
      sellHigh: d.sellHigh === null ? null : Number(d.sellHigh.toFixed(4)),
      buyNotional: Number(d.buyNotional.toFixed(2)),
      sellNotional: Number(d.sellNotional.toFixed(2)),
    }));

  const symbolRows = [...symbols.values()].sort((a, b) => b.fills - a.fills).map((s) => ({
    symbol: s.symbol, fills: s.fills, notionalUsd: Number(s.notionalUsd.toFixed(0)),
    firstDay: s.firstDay, lastDay: s.lastDay,
    low: Number(s.low.toFixed(6)), high: Number(s.high.toFixed(6)),
    charted: CHARTED.includes(s.symbol),
  }));

  const chartedFills = symbolRows.filter((s) => s.charted).reduce((a, s) => a + s.fills, 0);
  const totalFills = symbolRows.reduce((a, s) => a + s.fills, 0);

  const out = {
    generatedAt: new Date().toISOString(),
    note: 'Execution prices only: the export has no resting orders, so this is where fills happened, not where quotes were posted.',
    chartedSymbols: CHARTED,
    coverage: {
      totalFills,
      chartedFills,
      chartedShare: Number((chartedFills / totalFills).toFixed(4)),
      chartedDays: dayRows.length,
    },
    days: dayRows,
    profile,
    symbols: symbolRows,
  };

  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(path.join(OUT_DIR, 'fill-footprint.json'), JSON.stringify(out) + '\n');
  const size = (await fsp.stat(path.join(OUT_DIR, 'fill-footprint.json'))).size;
  process.stderr.write(`[footprint] ${dayRows.length} day rows, ${symbolRows.length} symbols, ${(size / 1024).toFixed(0)} kB\n`);
  console.log(JSON.stringify({ coverage: out.coverage, top: symbolRows.slice(0, 5).map((s) => ({ s: s.symbol, fills: s.fills, low: s.low, high: s.high })) }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
