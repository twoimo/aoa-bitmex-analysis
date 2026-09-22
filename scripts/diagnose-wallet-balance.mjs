#!/usr/bin/env node
/**
 * One-off diagnostic: is the wallet `walletbalance` column consistent with the
 * running sum of `amount` on every row, on the last row of each day, or only at
 * the very end?
 *
 * This decides whether the balance column can be used as an intraday equity
 * series (it is used for that in insights.mjs) or only as a coarse anchor.
 */
import path from 'node:path';
import { parseCsv, num, WALLET_COL } from './lib/csv.mjs';

const FILE = process.argv[2];
const rows = [];
let seq = 0;
await parseCsv(FILE, (r) => {
  if (r.length < 12) return;
  const type = r[WALLET_COL.transacttype];
  if (!type || type === 'transacttype') return;
  seq += 1;
  rows.push({
    seq,
    date: r[WALLET_COL.date],
    type,
    status: r[WALLET_COL.status],
    amount: num(r[WALLET_COL.amount]),
    balance: num(r[WALLET_COL.balance]),
  });
});
rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));

let running = 0;
let first = true;
let rowMismatch = 0;
let lastOfDayMismatch = 0;
let days = 0;
const dayStats = new Map();
for (let i = 0; i < rows.length; i += 1) {
  const row = rows[i];
  if (row.status === 'Canceled') continue;
  if (first) { running = row.balance - row.amount; first = false; }
  running += row.amount;
  const isLastOfDay = i === rows.length - 1 || rows[i + 1].date !== row.date;
  const diff = running - row.balance;
  if (Math.abs(diff) > 0.5) {
    rowMismatch += 1;
    if (isLastOfDay) {
      lastOfDayMismatch += 1;
      days += 1;
      dayStats.set(row.date, diff);
    }
  }
}

console.log('rows', rows.length);

const dumpDate = process.argv[3];
if (dumpDate) {
  let r2 = 0;
  let started = false;
  console.log(`\n--- rows for ${dumpDate} (amount / balance / running) ---`);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.status === 'Canceled') continue;
    if (!started) { r2 = row.balance - row.amount; started = true; }
    r2 += row.amount;
    if (row.date === dumpDate) {
      console.log(' ', row.seq, row.type.padEnd(12), String(row.amount).padStart(16), String(row.balance).padStart(16), String(r2).padStart(16), ((r2 - row.balance) / 1e8).toFixed(8));
    }
  }
}
console.log('row-level mismatches', rowMismatch);
console.log('last-row-of-day mismatches', lastOfDayMismatch, 'of', dayStats.size, 'days');
console.log('first 10 days with end-of-day mismatch:');
let n = 0;
for (const [d, diff] of dayStats) {
  console.log(' ', d, (diff / 1e8).toFixed(8));
  if (++n >= 10) break;
}
