#!/usr/bin/env node
/**
 * Daily replay series: the state of the account on every day of the record.
 *
 * This is what lets the page be scrubbed through time instead of only read as a
 * finished result. For each day it records the closing equity, cumulative
 * realised PnL and withdrawals, that day's activity, and the net position the
 * account was carrying at the close, converted to BTC so one number covers both
 * instruments.
 *
 * It is a replay of the disclosed record, not a backtest of a strategy: the
 * export contains no entry or exit rules, only what was actually done.
 *
 * Usage: node scripts/replay.mjs [--data DIR] [--out DIR]
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, num, SAT, satToXbt, round, EXEC_COL, WALLET_COL } from './lib/csv.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DATA_DIR = path.resolve(arg('--data', path.join(ROOT, '.work', 'data')));
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'results')));

const nextDay = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

async function main() {
  const all = await fsp.readdir(DATA_DIR);
  const execFiles = all.filter((f) => /^aoa-execution-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
  const walletFile = path.join(DATA_DIR, all.find((f) => /^aoa-wallet-.*\.csv$/.test(f)));

  // --- wallet ledger ---------------------------------------------------------
  const events = [];
  let seq = 0;
  await parseCsv(walletFile, (r) => {
    if (r.length < 12) return;
    const type = r[WALLET_COL.transacttype];
    if (!type || type === 'transacttype') return;
    seq += 1;
    events.push({
      seq, date: r[WALLET_COL.date], type,
      status: r[WALLET_COL.status],
      amount: num(r[WALLET_COL.amount]),
      balance: num(r[WALLET_COL.balance]),
    });
  });
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));

  // --- positions and activity ------------------------------------------------
  const perSymbol = new Map();
  for (const file of execFiles) {
    await parseCsv(file, (r) => {
      if (r.length < 25) return;
      const type = r[EXEC_COL.exectype];
      if (!type || type === 'exectype' || type === 'Funding') return;
      const symbol = r[EXEC_COL.symbol] || '?';
      if (!perSymbol.has(symbol)) perSymbol.set(symbol, []);
      perSymbol.get(symbol).push({
        ts: r[EXEC_COL.transacttime] || r[EXEC_COL.date],
        dir: r[EXEC_COL.side] === 'Buy' ? 1 : -1,
        qty: num(r[EXEC_COL.lastqty]),
        price: num(r[EXEC_COL.lastpx]),
        notional: Math.abs(num(r[EXEC_COL.foreignNotional])),
      });
    });
  }

  // Position at the close of each day, in contracts, per symbol.
  const dayPosition = new Map(); // day -> Map(symbol -> contracts)
  const dayFills = new Map();
  const dayNotional = new Map();
  for (const [symbol, rows] of perSymbol) {
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let pos = 0;
    let currentDay = null;
    for (const row of rows) {
      const day = row.ts.slice(0, 10);
      if (currentDay !== null && day !== currentDay) {
        const m = dayPosition.get(currentDay) ?? new Map();
        m.set(symbol, pos);
        dayPosition.set(currentDay, m);
      }
      currentDay = day;
      pos += row.dir * row.qty;
      dayFills.set(day, (dayFills.get(day) ?? 0) + 1);
      dayNotional.set(day, (dayNotional.get(day) ?? 0) + row.notional);
    }
    if (currentDay !== null) {
      const m = dayPosition.get(currentDay) ?? new Map();
      m.set(symbol, pos);
      dayPosition.set(currentDay, m);
    }
  }

  // --- market closes, for converting inverse positions to BTC ---------------
  const history = JSON.parse(await fsp.readFile(path.join(ROOT, 'results', 'market-history.json'), 'utf8'));
  const closeByDay = new Map();
  for (const s of history.series) {
    const panel = s.panel === 'BTC' ? 'XBTUSD' : 'ETHUSD';
    for (const b of s.bars) closeByDay.set(`${panel}|${new Date(b.t * 1000).toISOString().slice(0, 10)}`, b.close);
  }

  // --- assemble the daily series --------------------------------------------
  const firstDay = events[0].date;
  const lastDay = events[events.length - 1].date;
  const days = [];
  let balance = events[0].balance - events[0].amount;
  let cumRealised = 0;
  let cumWithdrawn = 0;
  let cumDeposited = 0;
  let ei = 0;
  let lastPos = new Map();
  let day = firstDay;
  while (day <= lastDay) {
    while (ei < events.length && events[ei].date <= day) {
      const e = events[ei];
      if (e.status !== 'Canceled') {
        if (e.type === 'RealisedPNL') cumRealised += e.amount;
        else if (e.type === 'Withdrawal') cumWithdrawn += -e.amount;
        else if (e.type === 'Deposit') cumDeposited += e.amount;
        balance = e.balance;
      }
      ei += 1;
    }
    const pos = dayPosition.get(day);
    if (pos) lastPos = pos;
    let posBtc = 0;
    for (const [symbol, contracts] of lastPos) {
      const close = closeByDay.get(`${symbol}|${day}`) || closeByDay.get(`${symbol}|${lastDay}`);
      if (!close) continue;
      // Inverse USD contracts: notional in BTC is contracts / price. Linear and
      // quanto altcoin contracts are left out rather than mixed in as if they
      // were the same unit.
      if (symbol === 'XBTUSD' || symbol === 'ETHUSD') posBtc += contracts / close;
    }
    days.push({
      d: day,
      eq: round(satToXbt(balance), 6),
      pnl: round(satToXbt(cumRealised), 6),
      wd: round(satToXbt(cumWithdrawn), 6),
      dep: round(satToXbt(cumDeposited), 6),
      f: dayFills.get(day) ?? 0,
      n: round(dayNotional.get(day) ?? 0, 0),
      pos: round(posBtc, 4),
    });
    day = nextDay(day);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note: 'Replay of the disclosed record, not a backtest of a strategy. The export has no entry or exit rules, only executions. Position is the close-of-day net across XBTUSD and ETHUSD, converted to BTC at that day\'s market close.',
    firstDay,
    lastDay,
    days,
  };
  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(path.join(OUT_DIR, 'replay.json'), JSON.stringify(out) + '\n');
  const size = (await fsp.stat(path.join(OUT_DIR, 'replay.json'))).size;
  const peak = days.reduce((a, b) => (b.eq > a.eq ? b : a), days[0]);
  const low = days.reduce((a, b) => (b.eq < a.eq ? b : a), days[0]);
  process.stderr.write(`[replay] ${days.length} days, ${(size / 1024).toFixed(0)} kB, peak ${peak.eq} BTC on ${peak.d}, low ${low.eq} on ${low.d}\n`);
  console.log(JSON.stringify({ days: days.length, firstDay, lastDay, peak, low, sample: days[days.length - 1] }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
