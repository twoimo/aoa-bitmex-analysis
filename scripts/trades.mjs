#!/usr/bin/env node
/**
 * Builds the fill tape payload: for each day the account traded, the largest
 * individual fills plus that day's aggregate counts.
 *
 * The tape is what a trading terminal calls Market Trades. It carries execution
 * price, size, time and side only. Execution ids, order ids, transaction ids and
 * the raw CSVs stay out of the published payload on purpose.
 *
 * Usage: node scripts/trades.mjs [--per-day 12] [--symbols XBTUSD,ETHUSD]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, EXEC_COL, num, round, dayOf } from './lib/csv.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = path.resolve(arg('--data', path.join(ROOT, '.work', 'data')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'results', 'trades.json')));
const PER_DAY = Number(arg('--per-day', '12'));
const SYMBOLS = arg('--symbols', 'XBTUSD,ETHUSD').split(',').map((s) => s.trim()).filter(Boolean);

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const clock = (ts) => (ts.length > 10 ? ts.slice(11, 19) : '');

async function main() {
  const files = (await fs.readdir(DATA_DIR))
    .filter((f) => /^aoa-execution-.*\.csv$/.test(f))
    .sort()
    .map((f) => path.join(DATA_DIR, f));
  if (!files.length) throw new Error(`No execution CSVs in ${DATA_DIR}. Run: npm run fetch`);

  // `${symbol}|${day}` -> aggregate plus the largest fills kept so far
  const days = new Map();
  const totals = { trades: 0, notionalUsd: 0, firstDay: null, lastDay: null };

  for (const file of files) {
    await parseCsv(file, (r) => {
      if (r.length < 25 || r[EXEC_COL.exectype] !== 'Trade') return;
      const symbol = r[EXEC_COL.symbol] || '?';
      if (!SYMBOLS.includes(symbol)) return;
      const ts = r[EXEC_COL.transacttime] || r[EXEC_COL.date] || '';
      const day = dayOf(ts);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      const price = num(r[EXEC_COL.lastpx]);
      // lastqty is in USD contracts, so the coin size is homeNotional
      // (contracts / price) and the dollar size is foreignNotional.
      const qty = Math.abs(num(r[EXEC_COL.homeNotional])) || Math.abs(num(r[EXEC_COL.lastqty])) / price;
      const notional = Math.abs(num(r[EXEC_COL.foreignNotional])) || price * qty;
      if (!(price > 0) || !(qty > 0)) return;

      const buy = r[EXEC_COL.side] === 'Buy';
      const key = `${symbol}|${day}`;
      const rec = days.get(key) ?? {
        symbol, day, fills: 0, buyFills: 0, sellFills: 0, notionalUsd: 0,
        firstTime: clock(ts), lastTime: clock(ts), top: [],
      };
      rec.fills += 1;
      if (buy) rec.buyFills += 1; else rec.sellFills += 1;
      rec.notionalUsd += notional;
      const at = clock(ts);
      if (at < rec.firstTime) rec.firstTime = at;
      if (at > rec.lastTime) rec.lastTime = at;
      rec.top.push({ t: at, p: price, q: qty, n: notional, b: buy ? 1 : 0 });
      days.set(key, rec);

      totals.trades += 1;
      totals.notionalUsd += notional;
      if (!totals.firstDay || day < totals.firstDay) totals.firstDay = day;
      if (!totals.lastDay || day > totals.lastDay) totals.lastDay = day;
    });
  }

  const out = {};
  for (const rec of days.values()) {
    rec.top.sort((a, b) => b.n - a.n);
    const kept = rec.top.slice(0, PER_DAY);
    // The tape reads newest first, the way an exchange prints it.
    kept.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
    out[`${rec.symbol}|${rec.day}`] = {
      f: rec.fills,
      b: rec.buyFills,
      s: rec.sellFills,
      v: round(rec.notionalUsd / rec.fills, 2),
      usd: round(rec.notionalUsd, 0),
      t0: rec.firstTime,
      t1: rec.lastTime,
      x: kept.map((k) => ({ t: k.t, p: round(k.p, 2), q: round(k.q, 6), b: k.b })),
    };
  }

  const payload = {
    note: 'Largest individual fills per day, newest first. q is the coin size (homeNotional), usd the dollar size. Execution, order and transaction ids are excluded.',
    symbols: SYMBOLS,
    perDay: PER_DAY,
    coverage: {
      trades: totals.trades,
      days: Object.keys(out).length,
      firstDay: totals.firstDay,
      lastDay: totals.lastDay,
      notionalUsd: round(totals.notionalUsd, 0),
    },
    days: out,
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, `${JSON.stringify(payload)}\n`);
  const bytes = (await fs.stat(OUT)).size;
  console.log(`trades: ${Object.keys(out).length} symbol-days, ${totals.trades} fills scanned -> ${OUT} (${(bytes / 1024).toFixed(0)} kB)`);
}

await main();
