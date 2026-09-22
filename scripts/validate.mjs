#!/usr/bin/env node
/**
 * Full anomaly and duplicate audit of the disclosed BitMEX export.
 *
 * This is the "clean the data before you trust it" pass. It answers, for every
 * row of every file:
 *
 *   - are identifiers unique, and where they are not, is the repeat benign?
 *   - do order quantities reconcile with their fills?
 *   - is the file time-ordered, and where it is not, by how much?
 *   - does the wallet ledger's running balance actually equal the running sum
 *     of the amounts?
 *   - can the position be reconstructed, and does it agree with the funding
 *     rows and the settlement rows that are supposed to zero it out?
 *   - which rows are structurally odd (blank, wrong field count, scientific
 *     notation, quoted multi-line text)?
 *
 * Everything it finds is written to results/validation.json and
 * results/anomalies.csv. Nothing is silently dropped: rows that look broken are
 * counted, described, and left in the dataset.
 *
 * Usage: node scripts/validate.mjs [--data DIR] [--out DIR]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const push = (arr, v, cap) => { if (arr.length < cap) arr.push(v); };

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Published reports keep the shape of every anomaly but not the raw
 * identifiers: execution, order and transaction ids are replaced by their first
 * 8 characters. The audit is still reproducible from the dataset, but the
 * output does not republish a machine-readable index of the account's
 * transactions.
 */
function redact(value) {
  if (typeof value === 'string') return value.replace(UUID_RE, (m) => `${m.slice(0, 8)}…`);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const outObj = {};
    for (const [k, v] of Object.entries(value)) outObj[k] = redact(v);
    return outObj;
  }
  return value;
}

// ---------------------------------------------------------------------------
// executions
// ---------------------------------------------------------------------------

async function auditExecutions(files) {
  const out = {
    files: [],
    rows: 0,
    byType: {},
    blankRows: 0,
    fieldCounts: {},
    execidTotal: 0,
    execidDuplicates: [],
    trdmatchidDuplicates: [],
    trdmatchid: { tradeRows: 0, uniqueTradeIds: 0 },
    orders: { total: 0, zeroIdRows: 0, qtyMismatch: [], qtyMatched: 0 },
    time: { inversions: 0, inversionExamples: [], firstTs: null, lastTs: null, perFileInversions: {} },
    textFlags: {},
    liquidation: { rows: 0, zeroOrderIdRows: 0 },
    funding: { rows: 0, qtyMatched: 0, qtyMismatched: [], fundingHours: {} },
    settlement: { rows: 0, zeroed: 0, notZeroed: [], positionsAfter: [] },
    symbols: new Set(),
    symbolsBySettlementCurrency: {},
  };

  const execIds = new Set();
  const trdIds = new Set();
  const orderAgg = new Map(); // orderid -> {sum, maxCum}
  const positions = new Map(); // symbol -> number
  const posRows = new Map(); // symbol -> [{ts, kind, dir, qty}]

  for (const file of files) {
    const base = path.basename(file);
    let prevTs = '';
    let fileInversions = 0;
    let fileRows = 0;

    await parseCsv(file, (r) => {
      fileRows += 1;
      const nf = String(r.length);
      out.fieldCounts[nf] = (out.fieldCounts[nf] ?? 0) + 1;

      if (r.length < 25) { out.blankRows += 1; return; }
      const type = r[EXEC_COL.exectype];
      if (!type || type === 'exectype') return;
      out.rows += 1;
      out.byType[type] = (out.byType[type] ?? 0) + 1;

      const ts = r[EXEC_COL.transacttime] || r[EXEC_COL.date];
      const symbol = r[EXEC_COL.symbol] || '?';
      out.symbols.add(symbol);
      const sc = r[EXEC_COL.settlcurrency] || '?';
      out.symbolsBySettlementCurrency[sc] = (out.symbolsBySettlementCurrency[sc] ?? 0) + 1;

      if (prevTs && ts < prevTs) {
        out.time.inversions += 1;
        fileInversions += 1;
        push(out.time.inversionExamples, { file: base, prevTs, ts, symbol, type }, 20);
      }
      prevTs = ts;
      if (!out.time.firstTs || ts < out.time.firstTs) out.time.firstTs = ts;
      if (!out.time.lastTs || ts > out.time.lastTs) out.time.lastTs = ts;

      const execid = r[EXEC_COL.execid];
      if (execid) {
        out.execidTotal += 1;
        if (execIds.has(execid)) push(out.execidDuplicates, { execid, file: base, ts }, 20);
        else execIds.add(execid);
      }

      const trd = r[EXEC_COL.trdmatchid];
      if (trd) {
        // Funding rows reuse trdmatchid per settlement batch, so uniqueness is
        // only meaningful for actual trades.
        if (type === 'Trade') {
          if (trdIds.has(trd)) push(out.trdmatchidDuplicates, { trdmatchid: trd, file: base, ts, symbol, side: r[EXEC_COL.side], lastqty: num(r[EXEC_COL.lastqty]), lastpx: num(r[EXEC_COL.lastpx]), liquidity: r[EXEC_COL.liquidity] }, 20);
          else trdIds.add(trd);
        }
      }

      const text = (r[EXEC_COL.text] || '').trim();
      out.textFlags[text || '(empty)'] = (out.textFlags[text || '(empty)'] ?? 0) + 1;
      if (text === 'Liquidation') {
        out.liquidation.rows += 1;
        if (r[EXEC_COL.orderid] === ZERO_ID) out.liquidation.zeroOrderIdRows += 1;
      }

      const qty = num(r[EXEC_COL.lastqty]);
      const dir = r[EXEC_COL.side] === 'Buy' ? 1 : -1;
      const orderid = r[EXEC_COL.orderid];

      if (type === 'Trade') {
        if (orderid === ZERO_ID) {
          out.orders.zeroIdRows += 1;
        } else if (orderid) {
          const a = orderAgg.get(orderid) ?? { sum: 0, maxCum: 0, fills: 0 };
          a.sum += qty;
          a.fills += 1;
          a.maxCum = Math.max(a.maxCum, num(r[EXEC_COL.cumqty]));
          orderAgg.set(orderid, a);
        }
        if (!posRows.has(symbol)) posRows.set(symbol, []);
        posRows.get(symbol).push({ ts, kind: 'T', dir, qty });
      } else if (type === 'Funding') {
        out.funding.rows += 1;
        const h = ts.slice(11, 13);
        out.funding.fundingHours[h] = (out.funding.fundingHours[h] ?? 0) + 1;
        if (!posRows.has(symbol)) posRows.set(symbol, []);
        posRows.get(symbol).push({ ts, kind: 'F', dir: 0, qty });
      } else if (type === 'Settlement') {
        out.settlement.rows += 1;
        if (!posRows.has(symbol)) posRows.set(symbol, []);
        posRows.get(symbol).push({ ts, kind: 'S', dir, qty });
      }
    });

    out.files.push({ name: base, rows: fileRows, timeInversions: fileInversions });
    out.time.perFileInversions[base] = fileInversions;
  }

  out.orders.total = orderAgg.size;
  out.trdmatchid.tradeRows = out.byType.Trade ?? 0;
  out.trdmatchid.uniqueTradeIds = trdIds.size;
  for (const [orderid, a] of orderAgg) {
    if (Math.abs(a.sum - a.maxCum) < 1e-6) out.orders.qtyMatched += 1;
    else push(out.orders.qtyMismatch, { orderid, sumLastQty: a.sum, maxCumQty: a.maxCum, fills: a.fills }, 20);
  }

  // position reconstruction, per symbol, time-ordered
  let fundingQtyMatched = 0;
  const fundingMismatch = [];
  const settlementNotZeroed = [];
  for (const [symbol, rows] of posRows) {
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let pos = 0;
    for (const row of rows) {
      if (row.kind === 'T') {
        pos += row.dir * row.qty;
      } else if (row.kind === 'F') {
        // A funding row carries the quantity that was funded, so its magnitude
        // must equal the position that existed at that instant.
        if (Math.abs(Math.abs(pos) - row.qty) < 1e-6) fundingQtyMatched += 1;
        else push(fundingMismatch, { symbol, ts: row.ts, position: pos, fundingQty: row.qty }, 20);
      } else if (row.kind === 'S') {
        pos += row.dir * row.qty;
        if (Math.abs(pos) < 1e-6) out.settlement.zeroed += 1;
        else push(settlementNotZeroed, { symbol, ts: row.ts, positionAfter: pos }, 20);
      }
    }
    positions.set(symbol, pos);
  }

  out.funding.qtyMatched = fundingQtyMatched;
  out.funding.qtyMismatched = fundingMismatch;
  out.settlement.notZeroed = settlementNotZeroed;
  out.settlement.positionsAfter = [...positions.entries()]
    .filter(([, p]) => Math.abs(p) > 1e-6)
    .map(([symbol, p]) => ({ symbol, openPosition: p }))
    .sort((a, b) => Math.abs(b.openPosition) - Math.abs(a.openPosition));
  out.symbols = out.symbols.size;

  return out;
}

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------

async function auditWallet(files) {
  const out = {
    files: [],
    rows: 0,
    blankRows: 0,
    transactions: 0,
    byType: {},
    byStatus: {},
    transactidDuplicates: [],
    dateInversions: 0,
    dateInversionExamples: [],
    scientificNotationRows: 0,
    adjacentEqualBalances: 0,
    balanceSemantics: {
      hypothesis: 'walletbalance is a day-level snapshot (repeated on every row of that day), not a per-row running balance.',
      days: 0,
      daysWithSingleBalanceValue: 0,
      daysWithMultipleBalanceValues: 0,
      multiBalanceExamples: [],
      rowsWithBalanceDivisibleBy1e6: 0,
      rowsWithBalanceDivisibleBy1e4: 0,
    },
    balanceContinuity: {
      mismatchCount: 0,
      maxAbsDiffSatoshi: 0,
      examples: [],
      byDate: [],
      dayEndMismatchCount: 0,
      dayEndMaxAbsDiffSatoshi: 0,
      dayEndExamples: [],
    },
    reconstruction: {
      deposits: 0, depositsCount: 0,
      withdrawals: 0, withdrawalsCount: 0,
      cancelledWithdrawals: 0, cancelledWithdrawalsCount: 0,
      realised: 0, realisedCount: 0,
      finalBalance: 0, expectedFinal: 0, diff: 0,
    },
  };

  const ids = new Set();
  const rows = [];
  let seq = 0;
  let fileOrderPrevDate = '';

  for (const file of files) {
    const base = path.basename(file);
    let fileRows = 0;
    await parseCsv(file, (r) => {
      fileRows += 1;
      if (r.length < 12) { out.blankRows += 1; return; }
      const type = r[WALLET_COL.transacttype];
      if (!type || type === 'transacttype') return;
      out.transactions += 1;
      seq += 1;
      const rawBalance = r[WALLET_COL.balance] || '';
      if (/E[+-]?\d+$/i.test(rawBalance)) out.scientificNotationRows += 1;
      const id = r[WALLET_COL.transactid];
      if (id) {
        if (ids.has(id)) push(out.transactidDuplicates, { transactid: id, file: base }, 20);
        else ids.add(id);
      }
      // Date inversions must be detected in *file* order, before any sorting.
      const date = r[WALLET_COL.date];
      if (fileOrderPrevDate && date < fileOrderPrevDate) {
        out.dateInversions += 1;
        push(out.dateInversionExamples, { file: base, prevDate: fileOrderPrevDate, date, type }, 10);
      }
      fileOrderPrevDate = date;
      rows.push({
        seq,
        date,
        type,
        status: r[WALLET_COL.status],
        amount: num(r[WALLET_COL.amount]),
        balance: num(rawBalance),
        rawBalance,
      });
    });
    out.files.push({ name: base, rows: fileRows });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));

  let prevBalance = null;
  let running = 0;
  let firstRow = true;
  const perDate = new Map();
  const dayAgg = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    out.byType[row.type] = (out.byType[row.type] ?? 0) + 1;
    out.byStatus[row.status || '(empty)'] = (out.byStatus[row.status || '(empty)'] ?? 0) + 1;

    if (prevBalance !== null && row.balance === prevBalance) out.adjacentEqualBalances += 1;
    prevBalance = row.balance;

    if (row.status === 'Canceled') continue;

    if (firstRow) { running = row.balance - row.amount; firstRow = false; }
    running += row.amount;

    if (Math.abs(row.balance) > 0 && Math.abs(row.balance) % 1e6 === 0) out.balanceSemantics.rowsWithBalanceDivisibleBy1e6 += 1;
    if (Math.abs(row.balance) > 0 && Math.abs(row.balance) % 1e4 === 0) out.balanceSemantics.rowsWithBalanceDivisibleBy1e4 += 1;

    const diff = running - row.balance;
    if (Math.abs(diff) > 0.5) {
      out.balanceContinuity.mismatchCount += 1;
      if (Math.abs(diff) > out.balanceContinuity.maxAbsDiffSatoshi) {
        out.balanceContinuity.maxAbsDiffSatoshi = Math.abs(diff);
      }
      push(out.balanceContinuity.examples, {
        date: row.date, type: row.type, amount: row.amount, running, balance: row.balance,
        diffSatoshi: diff, diffXbt: round(satToXbt(diff), 8),
      }, 20);
      const d = perDate.get(row.date) ?? { date: row.date, rows: 0, maxAbsDiffSatoshi: 0 };
      d.rows += 1;
      d.maxAbsDiffSatoshi = Math.max(d.maxAbsDiffSatoshi, Math.abs(diff));
      perDate.set(row.date, d);
    }

    const isLastOfDay = i === rows.length - 1 || rows[i + 1].date !== row.date;
    if (!dayAgg.has(row.date)) dayAgg.set(row.date, { date: row.date, balances: new Set(), rows: 0, endRunning: 0, endBalance: 0 });
    const day = dayAgg.get(row.date);
    day.balances.add(row.balance);
    day.rows += 1;
    if (isLastOfDay) { day.endRunning = running; day.endBalance = row.balance; }

    if (row.type === 'Deposit') { out.reconstruction.deposits += row.amount; out.reconstruction.depositsCount += 1; }
    else if (row.type === 'Withdrawal') { out.reconstruction.withdrawals += row.amount; out.reconstruction.withdrawalsCount += 1; }
    else if (row.type === 'RealisedPNL') { out.reconstruction.realised += row.amount; out.reconstruction.realisedCount += 1; }
  }

  out.balanceSemantics.days = dayAgg.size;
  for (const day of dayAgg.values()) {
    if (day.balances.size === 1) out.balanceSemantics.daysWithSingleBalanceValue += 1;
    else {
      out.balanceSemantics.daysWithMultipleBalanceValues += 1;
      push(out.balanceSemantics.multiBalanceExamples, { date: day.date, rows: day.rows, distinctBalances: day.balances.size }, 10);
    }
    const dDiff = day.endRunning - day.endBalance;
    if (Math.abs(dDiff) > 0.5) {
      out.balanceContinuity.dayEndMismatchCount += 1;
      out.balanceContinuity.dayEndMaxAbsDiffSatoshi = Math.max(out.balanceContinuity.dayEndMaxAbsDiffSatoshi, Math.abs(dDiff));
      push(out.balanceContinuity.dayEndExamples, {
        date: day.date, endRunning: day.endRunning, endBalance: day.endBalance,
        diffSatoshi: dDiff, diffXbt: round(satToXbt(dDiff), 8),
      }, 20);
    }
  }
  out.balanceContinuity.dayEndExamples.sort((a, b) => Math.abs(b.diffSatoshi) - Math.abs(a.diffSatoshi));

  const cancelled = rows.filter((r) => r.status === 'Canceled' && r.type === 'Withdrawal');
  out.reconstruction.cancelledWithdrawals = cancelled.reduce((a, r) => a + r.amount, 0);
  out.reconstruction.cancelledWithdrawalsCount = cancelled.length;

  const last = rows[rows.length - 1];
  out.reconstruction.finalBalance = last ? last.balance : 0;
  out.reconstruction.expectedFinal = running;
  out.reconstruction.diff = running - (last ? last.balance : 0);

  out.balanceContinuity.byDate = [...perDate.values()]
    .sort((a, b) => b.maxAbsDiffSatoshi - a.maxAbsDiffSatoshi)
    .slice(0, 20)
    .map((d) => ({ date: d.date, mismatchedRows: d.rows, maxAbsDiffXbt: round(satToXbt(d.maxAbsDiffSatoshi), 8) }));

  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const all = await fsp.readdir(DATA_DIR);
  const execFiles = all.filter((f) => /^aoa-execution-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
  const walletFiles = all.filter((f) => /^aoa-wallet-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
  const allFiles = [...execFiles, ...walletFiles, ...all.filter((f) => f.endsWith('.txt')).map((f) => path.join(DATA_DIR, f))];

  const t0 = Date.now();
  const manifest = [];
  for (const f of allFiles) {
    const st = await fsp.stat(f);
    manifest.push({
      name: path.basename(f),
      bytes: st.size,
      sha256: await sha256(f),
    });
    process.stderr.write(`[validate] hashed ${path.basename(f)}\n`);
  }

  const exec = await auditExecutions(execFiles);
  process.stderr.write(`[validate] executions done (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  const wallet = await auditWallet(walletFiles);
  process.stderr.write(`[validate] wallet done (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

  const report = {
    generatedAt: new Date().toISOString(),
    note: 'Internal consistency audit only. Passing these checks does not prove exchange issuance, account ownership, or authenticity.',
    manifest,
    executions: exec,
    wallet,
    summary: {
      execIdDuplicates: exec.execidDuplicates.length,
      trdmatchidDuplicatePairs: exec.trdmatchidDuplicates.length,
      orderQtyMismatches: exec.orders.qtyMismatch.length,
      ordersChecked: exec.orders.total,
      timeInversions: exec.time.inversions,
      fundingQtyMatched: `${exec.funding.qtyMatched}/${exec.funding.rows}`,
      settlementsZeroed: `${exec.settlement.zeroed}/${exec.settlement.rows}`,
      liquidationRows: exec.liquidation.rows,
      liquidationRowsWithZeroOrderId: exec.liquidation.zeroOrderIdRows,
      walletTransactidDuplicates: wallet.transactidDuplicates.length,
      walletDateInversionsInFileOrder: wallet.dateInversions,
      walletRowLevelBalanceMismatches: wallet.balanceContinuity.mismatchCount,
      walletDayEndBalanceMismatches: wallet.balanceContinuity.dayEndMismatchCount,
      walletDaysWithSingleBalanceValue: `${wallet.balanceSemantics.daysWithSingleBalanceValue}/${wallet.balanceSemantics.days}`,
      walletLedgerDiffXbt: round(satToXbt(wallet.reconstruction.diff), 8),
    },
  };

  await fsp.mkdir(OUT_DIR, { recursive: true });
  const published = redact(report);
  await fsp.writeFile(path.join(OUT_DIR, 'validation.json'), JSON.stringify(published, null, 2) + '\n');
  await fsp.writeFile(path.join(ROOT, 'manifest.json'), JSON.stringify({ generatedAt: report.generatedAt, files: manifest }, null, 2) + '\n');

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const pe = published.executions;
  const pw = published.wallet;
  const lines = ['category,severity,key,detail'];
  for (const e of pe.execidDuplicates) lines.push(['execution', 'high', 'execid', esc(JSON.stringify(e))].join(','));
  for (const e of pe.trdmatchidDuplicates) lines.push(['execution', 'low', 'trdmatchid', esc(JSON.stringify(e))].join(','));
  for (const e of pe.orders.qtyMismatch) lines.push(['execution', 'high', 'order_qty', esc(JSON.stringify(e))].join(','));
  for (const e of pe.funding.qtyMismatched) lines.push(['execution', 'medium', 'funding_qty', esc(JSON.stringify(e))].join(','));
  for (const e of pe.settlement.notZeroed) lines.push(['execution', 'high', 'settlement', esc(JSON.stringify(e))].join(','));
  for (const e of pe.time.inversionExamples) lines.push(['execution', 'low', 'time_inversion', esc(JSON.stringify(e))].join(','));
  for (const e of pw.transactidDuplicates) lines.push(['wallet', 'high', 'transactid', esc(JSON.stringify(e))].join(','));
  for (const e of pw.balanceContinuity.examples) lines.push(['wallet', 'medium', 'balance_continuity_row', esc(JSON.stringify(e))].join(','));
  for (const e of pw.balanceContinuity.dayEndExamples) lines.push(['wallet', 'medium', 'balance_continuity_day_end', esc(JSON.stringify(e))].join(','));
  for (const e of pw.dateInversionExamples) lines.push(['wallet', 'low', 'date_inversion', esc(JSON.stringify(e))].join(','));
  for (const e of pw.balanceSemantics.multiBalanceExamples) lines.push(['wallet', 'info', 'multi_balance_day', esc(JSON.stringify(e))].join(','));
  for (const [k, v] of Object.entries(pe.textFlags)) if (v > 0) lines.push(['execution', 'info', 'text_flag', esc(`${k} = ${v}`)].join(','));
  await fsp.writeFile(path.join(OUT_DIR, 'anomalies.csv'), lines.join('\n') + '\n');

  console.log(JSON.stringify(report.summary, null, 2));
  console.log('\nopen positions at end of data:');
  console.log(JSON.stringify(exec.settlement.positionsAfter.slice(0, 5), null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
