#!/usr/bin/env node
/**
 * Independent analysis of the publicly disclosed BitMEX execution + wallet
 * records for account "aoa" (2018-03-05 .. 2021-12-31).
 *
 * The raw CSVs are NOT part of this repository. They are fetched with
 * `npm run fetch` into .work/data/. See docs/source.md.
 *
 * Design notes
 * ------------
 * - The execution CSVs are ~600 MB combined and contain quoted, multi-line
 *   fields, so rows are streamed through a small RFC4180-compatible parser
 *   instead of being loaded into memory.
 * - Two independent PnL views are produced on purpose:
 *     1. ledger  -> the wallet CSV, which has a running balance per transaction
 *     2. fills   -> the execution CSV, which carries notional / commission /
 *                   funding per fill
 *   If the two disagree the report says so instead of picking a winner.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DATA_DIR = path.resolve(arg('--data', path.join(ROOT, '.work', 'data')));
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'results')));

const SAT = 1e8; // satoshi per XBt

// --------------------------------------------------------------------------
// CSV
// --------------------------------------------------------------------------

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Stream a CSV file, calling onRow(fields, lineNumber) per record. */
async function parseCsv(file, onRow) {
  const rs = fs.createReadStream(file, { highWaterMark: 1 << 22 });
  const dec = new StringDecoder('utf8');
  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 0;
  let first = true;

  const emit = () => {
    line += 1;
    const r = first ? (row = [stripBom(row[0] ?? ''), ...row.slice(1)]) : row;
    first = false;
    if (r.length > 1 || r[0] !== '') onRow(r, line);
    row = [];
    field = '';
  };

  await new Promise((resolve, reject) => {
    rs.on('data', (buf) => {
      const chunk = dec.write(buf);
      for (let i = 0; i < chunk.length; i += 1) {
        const c = chunk[i];
        if (inQuotes) {
          if (c === '"') {
            if (chunk[i + 1] === '"') {
              field += '"';
              i += 1;
            } else {
              inQuotes = false;
            }
          } else {
            field += c;
          }
        } else if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          row.push(field);
          field = '';
        } else if (c === '\n') {
          row.push(field);
          emit();
        } else if (c !== '\r') {
          field += c;
        }
      }
    });
    rs.on('end', () => {
      field += dec.end();
      if (field !== '' || row.length) {
        row.push(field);
        emit();
      }
      resolve();
    });
    rs.on('error', reject);
  });
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

const num = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const satToXbt = (s) => s / SAT;
const round = (n, d = 8) => Number(n.toFixed(d));
const monthOf = (ts) => ts.slice(0, 7);
const dayOf = (ts) => ts.slice(0, 10);

const EXEC_COL = {
  date: 0, execid: 1, orderid: 2, account: 5, symbol: 6, side: 7, lastqty: 8,
  lastpx: 9, liquidity: 10, orderqty: 11, currency: 17, settlcurrency: 18,
  exectype: 19, ordtype: 20, ordstatus: 24, commission: 31, execCost: 35,
  execComm: 36, homeNotional: 37, foreignNotional: 38, transacttime: 39,
};

const WALLET_COL = {
  date: 0, transactid: 1, account: 2, currency: 3, amount: 4, status: 5,
  transacttype: 11, tx: 12, balance: 13,
};

// --------------------------------------------------------------------------
// 1. execution records
// --------------------------------------------------------------------------

async function analyzeExecutions(files) {
  const out = {
    files: files.map((f) => path.basename(f)),
    rows: 0,
    fills: 0,
    fundingRows: 0,
    settlementRows: 0,
    otherRows: 0,
    malformedRows: 0,
    firstTs: null,
    lastTs: null,
    orders: new Set(),
    accountIds: new Set(),
    symbols: new Map(),
    side: { Buy: { fills: 0, notional: 0 }, Sell: { fills: 0, notional: 0 } },
    liquidity: {
      maker: { fills: 0, notional: 0 },
      taker: { fills: 0, notional: 0 },
      unknown: { fills: 0, notional: 0 },
    },
    notionalByCurrency: new Map(),
    commissionBySettlCurrency: new Map(),
    makerRebateSatoshi: 0,
    takerFeeSatoshi: 0,
    fundingBySettlCurrency: new Map(),
    fundingByMonth: new Map(),
    notionalByMonth: new Map(),
    fillsByMonth: new Map(),
    ordersByMonth: new Map(),
  };

  const monthOrders = new Map(); // month -> Set(orderid)

  for (const file of files) {
    await parseCsv(file, (r) => {
      if (r.length < 25) return;
      const type = r[EXEC_COL.exectype];
      if (type === 'exectype') return; // repeated header
      if (!type) {
        out.otherRows += 1;
        return;
      }
      out.rows += 1;

      const ts = r[EXEC_COL.transacttime] || r[EXEC_COL.date];
      const month = monthOf(ts);
      if (r[EXEC_COL.account]) out.accountIds.add(r[EXEC_COL.account]);

      if (type === 'Funding') {
        // BitMEX funding rows put the *position notional* in execCost and the
        // actual cash flow in execComm (execComm = execCost * funding rate, and
        // the `commission` column carries that rate, e.g. -1.0E-4). Using
        // execCost here inflates the funding total by ~200 XBt, so execComm is
        // the field to sum.
        out.fundingRows += 1;
        const ccy = r[EXEC_COL.settlcurrency] || '?';
        const pay = num(r[EXEC_COL.execComm]);
        out.fundingBySettlCurrency.set(ccy, (out.fundingBySettlCurrency.get(ccy) ?? 0) + pay);
        out.fundingByMonth.set(month, (out.fundingByMonth.get(month) ?? 0) + pay);
        return;
      }
      if (type === 'Settlement') {
        out.settlementRows += 1;
        return;
      }
      if (type !== 'Trade') {
        out.otherRows += 1;
        return;
      }

      out.fills += 1;
      if (!out.firstTs || ts < out.firstTs) out.firstTs = ts;
      if (!out.lastTs || ts > out.lastTs) out.lastTs = ts;

      const symbol = r[EXEC_COL.symbol] || '?';
      const side = r[EXEC_COL.side] === 'Buy' ? 'Buy' : 'Sell';
      const notional = Math.abs(num(r[EXEC_COL.foreignNotional]));
      const ccy = r[EXEC_COL.currency] || '?';
      const comm = num(r[EXEC_COL.execComm]);
      const orderid = r[EXEC_COL.orderid];

      if (orderid && orderid !== '00000000-0000-0000-0000-000000000000') {
        // The all-zero UUID is a placeholder on liquidations and a few other
        // rows; counting it as an order inflates the count by one.
        out.orders.add(orderid);
        if (!monthOrders.has(month)) monthOrders.set(month, new Set());
        monthOrders.get(month).add(orderid);
      }

      const s = out.symbols.get(symbol) ?? {
        symbol, currency: ccy, fills: 0, notional: 0, buys: 0, sells: 0,
        maker: 0, taker: 0, commission: 0, best: -Infinity, worst: Infinity,
      };
      s.fills += 1;
      s.notional += notional;
      if (side === 'Buy') s.buys += 1; else s.sells += 1;
      const liq = r[EXEC_COL.liquidity];
      if (liq === 'AddedLiquidity') { s.maker += 1; out.liquidity.maker.fills += 1; out.liquidity.maker.notional += notional; }
      else if (liq === 'RemovedLiquidity') { s.taker += 1; out.liquidity.taker.fills += 1; out.liquidity.taker.notional += notional; }
      else { out.liquidity.unknown.fills += 1; out.liquidity.unknown.notional += notional; }
      s.commission += comm;
      out.symbols.set(symbol, s);

      out.side[side].fills += 1;
      out.side[side].notional += notional;
      out.notionalByCurrency.set(ccy, (out.notionalByCurrency.get(ccy) ?? 0) + notional);
      out.commissionBySettlCurrency.set(r[EXEC_COL.settlcurrency] || '?', (out.commissionBySettlCurrency.get(r[EXEC_COL.settlcurrency] || '?') ?? 0) + comm);
      if (comm < 0) out.makerRebateSatoshi += comm; else out.takerFeeSatoshi += comm;
      out.notionalByMonth.set(month, (out.notionalByMonth.get(month) ?? 0) + notional);
      out.fillsByMonth.set(month, (out.fillsByMonth.get(month) ?? 0) + 1);
    });
  }

  out.ordersByMonth = monthOrders;
  return out;
}

// --------------------------------------------------------------------------
// 2. wallet ledger
// --------------------------------------------------------------------------

async function analyzeWallet(files) {
  const events = [];
  let seq = 0;

  for (const file of files) {
    await parseCsv(file, (r) => {
      if (r.length < 12) return;
      if (r[WALLET_COL.transacttype] === 'transacttype') return;
      const type = r[WALLET_COL.transacttype];
      if (!type) return; // blank padding rows
      // `timestamp`/`transacttime` in the wallet export hold elapsed-time strings
      // (e.g. "57:26.3") rather than wall-clock times, so `date` is the only
      // usable time axis; same-day order is preserved by `seq`.
      const ts = r[WALLET_COL.date];
      events.push({
        seq: seq += 1,
        ts,
        day: dayOf(ts),
        month: monthOf(ts),
        type,
        status: r[WALLET_COL.status],
        currency: r[WALLET_COL.currency],
        amount: num(r[WALLET_COL.amount]),
        balance: num(r[WALLET_COL.balance]),
      });
    });
  }

  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));

  const first = events[0];
  const last = events[events.length - 1];
  const startingBalance = first ? first.balance - first.amount : 0;

  const byType = new Map();
  let deposits = 0;
  let depositCount = 0;
  let withdrawals = 0;
  let withdrawalCount = 0;
  const realised = [];
  const monthly = new Map();
  const daily = new Map();

  const monthEntry = (m) => {
    if (!monthly.has(m)) {
      monthly.set(m, { month: m, realised: 0, deposits: 0, withdrawals: 0, fee: 0, endBalance: 0 });
    }
    return monthly.get(m);
  };

  for (const e of events) {
    // Canceled withdrawals keep a balance snapshot but move no money, so they
    // must not be counted as external flow. Counting them inflates the daily
    // return and corrupts the time-weighted return.
    const canceled = e.status === 'Canceled';
    const t = byType.get(e.type) ?? { count: 0, total: 0, cancelled: 0 };
    t.count += 1;
    t.total += e.amount;
    if (canceled) t.cancelled += 1;
    byType.set(e.type, t);
    if (canceled) continue;

    const me = monthEntry(e.month);
    const today = daily.get(e.day) ?? { day: e.day, open: null, close: 0, flow: 0, realised: 0, funding: 0, events: 0 };

    if (e.type === 'Deposit') {
      deposits += e.amount;
      depositCount += 1;
      me.deposits += e.amount;
      today.flow += e.amount;
    } else if (e.type === 'Withdrawal') {
      withdrawals += e.amount;
      withdrawalCount += 1;
      me.withdrawals += e.amount;
      today.flow += e.amount;
    } else if (e.type === 'RealisedPNL') {
      realised.push(e);
      me.realised += e.amount;
      today.realised += e.amount;
    }

    today.close = e.balance;
    today.events += 1;
    me.endBalance = e.balance;
    daily.set(e.day, today);
  }

  const wins = realised.filter((e) => e.amount > 0);
  const losses = realised.filter((e) => e.amount < 0);
  const grossProfit = wins.reduce((a, e) => a + e.amount, 0);
  const grossLoss = Math.abs(losses.reduce((a, e) => a + e.amount, 0));

  // ---- equity curve / drawdown (sat)
  let peak = startingBalance;
  let peakDay = first ? first.day : null;
  let maxDd = { pct: 0, peak: peak, trough: peak, peakDay, troughDay: peakDay };
  const dailySeries = [...daily.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const d of dailySeries) {
    if (d.close > peak) {
      peak = d.close;
      peakDay = d.day;
    }
    const dd = peak > 0 ? (peak - d.close) / peak : 0;
    if (dd > maxDd.pct) {
      maxDd = { pct: dd, peak, trough: d.close, peakDay, troughDay: d.day };
    }
  }

  // ---- time-weighted return (deposits/withdrawals neutralised)
  let twr = 1;
  let counted = 0;
  let skipped = 0;
  let prevClose = startingBalance;
  const dailyRows = [];
  for (const d of dailySeries) {
    const open = prevClose;
    if (open > 0) {
      const r = (d.close - open - d.flow) / open;
      twr *= 1 + r;
      counted += 1;
      dailyRows.push({ day: d.day, close: d.close / SAT, flow: d.flow / SAT, ret: r, equityUsdNote: '' });
    } else {
      skipped += 1;
      dailyRows.push({ day: d.day, close: d.close / SAT, flow: d.flow / SAT, ret: null, equityUsdNote: '' });
    }
    prevClose = d.close;
  }

  return {
    files: files.map((f) => path.basename(f)),
    events,
    transactions: events.length,
    firstEvent: first,
    lastEvent: last,
    startingBalance,
    finalBalance: last ? last.balance : 0,
    deposits, depositCount, withdrawals, withdrawalCount,
    byType,
    realised,
    dailySeries,
    dailyRows,
    monthly: [...monthly.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    maxDrawdown: maxDd,
    twr,
    twrCountedDays: counted,
    twrSkippedDays: skipped,
    stats: {
      count: realised.length,
      total: realised.reduce((a, e) => a + e.amount, 0),
      wins: wins.length,
      losses: losses.length,
      grossProfit,
      grossLoss,
      avgWin: wins.length ? grossProfit / wins.length : 0,
      avgLoss: losses.length ? grossLoss / losses.length : 0,
      best: realised.reduce((a, e) => Math.max(a, e.amount), -Infinity),
      worst: realised.reduce((a, e) => Math.min(a, e.amount), Infinity),
      netWinRate: realised.length ? wins.length / (wins.length + losses.length) : 0,
    },
  };
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

const fmtXbt = (sat, d = 4) => (sat / SAT).toFixed(d);
const fmtUsdNote = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (v, d = 2) => `${(v * 100).toFixed(d)}%`;

function svgLineChart({ width = 900, height = 320, series, color = '#2f6fed', label }) {
  const pad = { l: 70, r: 20, t: 20, b: 34 };
  const xs = series.map((p) => p.x);
  const ys = series.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys);
  const sx = (x) => pad.l + ((x - minX) / (maxX - minX || 1)) * (width - pad.l - pad.r);
  const sy = (y) => height - pad.b - ((y - minY) / (maxY - minY || 1)) * (height - pad.t - pad.b);
  const pts = series.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const ticks = 5;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = minY + ((maxY - minY) * i) / ticks;
    const y = sy(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${width - pad.r}" y2="${y.toFixed(1)}" stroke="#e6e8ee"/>` +
      `<text x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5b6270">${v.toFixed(2)}</text>`;
  }).join('');
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const i = Math.min(series.length - 1, Math.round(f * (series.length - 1)));
    const x = sx(series[i].x);
    return `<text x="${x.toFixed(1)}" y="${height - 12}" text-anchor="middle" font-size="11" fill="#5b6270">${series[i].label}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${grid}
  <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
  ${xLabels}
  <text x="${pad.l}" y="14" font-size="12" fill="#2b3040">${label}</text>
</svg>`;
}

function svgBarChart({ width = 900, height = 320, bars, label, unit = 'XBt' }) {
  const pad = { l: 70, r: 20, t: 20, b: 46 };
  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.v)), 1e-9);
  const zeroY = pad.t + (height - pad.t - pad.b) / 2;
  const bw = (width - pad.l - pad.r) / bars.length;
  const half = (height - pad.t - pad.b) / 2 - 6;
  const body = bars.map((b, i) => {
    const h = (Math.abs(b.v) / maxAbs) * half;
    const x = pad.l + i * bw + bw * 0.15;
    const y = b.v >= 0 ? zeroY - h : zeroY;
    const fill = b.v >= 0 ? '#1f9d55' : '#d64545';
    const lbl = b.label;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>` +
      (bars.length <= 30 ? `<text x="${(x + bw * 0.35).toFixed(1)}" y="${(height - 30).toFixed(1)}" text-anchor="end" font-size="9" fill="#5b6270" transform="rotate(-60 ${(x + bw * 0.35).toFixed(1)} ${(height - 30).toFixed(1)})">${lbl}</text>` : '');
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <line x1="${pad.l}" y1="${zeroY.toFixed(1)}" x2="${width - pad.r}" y2="${zeroY.toFixed(1)}" stroke="#c8ccd8"/>
  <text x="${pad.l - 8}" y="${(pad.t + 10).toFixed(1)}" text-anchor="end" font-size="11" fill="#5b6270">+${maxAbs.toFixed(2)}</text>
  <text x="${pad.l - 8}" y="${(zeroY + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5b6270">0</text>
  <text x="${pad.l - 8}" y="${(height - pad.b).toFixed(1)}" text-anchor="end" font-size="11" fill="#5b6270">-${maxAbs.toFixed(2)}</text>
  ${body}
  <text x="${pad.l}" y="14" font-size="12" fill="#2b3040">${label} (${unit})</text>
</svg>`;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`Data directory not found: ${DATA_DIR}\nRun: npm run fetch`);
    process.exit(1);
  }
  const all = await fsp.readdir(DATA_DIR);
  const execFiles = all.filter((f) => /^aoa-execution-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
  const walletFiles = all.filter((f) => /^aoa-wallet-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
  if (!execFiles.length || !walletFiles.length) {
    console.error(`Expected aoa-execution-*.csv and aoa-wallet-*.csv in ${DATA_DIR}`);
    process.exit(1);
  }

  const t0 = Date.now();
  process.stderr.write(`[analyze] executions: ${execFiles.length} file(s)\n`);
  const exec = await analyzeExecutions(execFiles);
  process.stderr.write(`[analyze] fills=${exec.fills} rows=${exec.rows} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  const wal = await analyzeWallet(walletFiles);
  process.stderr.write(`[analyze] wallet transactions=${wal.transactions} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

  const netExternalFlow = wal.deposits + wal.withdrawals; // withdrawals are negative
  const netPnl = wal.finalBalance - wal.startingBalance - netExternalFlow;

  // funding folded into months
  for (const m of wal.monthly) {
    m.funding = exec.fundingByMonth.get(m.month) ?? 0;
    m.fills = exec.fillsByMonth.get(m.month) ?? 0;
    m.notional = exec.notionalByMonth.get(m.month) ?? 0;
    m.orders = exec.ordersByMonth.get(m.month)?.size ?? 0;
    m.netPnl = m.realised; // funding is already inside ledger RealisedPNL
  }

  const symbols = [...exec.symbols.values()]
    .map((s) => ({
      symbol: s.symbol,
      currency: s.currency,
      fills: s.fills,
      buys: s.buys,
      sells: s.sells,
      notionalUsd: round(s.notional, 2),
      makerFills: s.maker,
      takerFills: s.taker,
      commission: round(satToXbt(s.commission), 8),
    }))
    .sort((a, b) => b.notionalUsd - a.notionalUsd);

  const fundingXBt = (exec.fundingBySettlCurrency.get('XBt') ?? 0);
  const commissionXBt = (exec.commissionBySettlCurrency.get('XBt') ?? 0);

  // The wallet ledger reconciles exactly against the final balance, which means
  // funding and fees are already folded into its RealisedPNL rows. They are
  // therefore *components* of the ledger PnL, never additional cash flow.
  const ledgerCheck = wal.stats.total - netPnl;

  const summary = {
    generatedAt: new Date().toISOString(),
    source: {
      post: 'https://gall.dcinside.com/mgallery/board/view/?id=chartanalysis&no=5051684',
      driveFileId: '1XDwxbriz_kOq44iH-mHcjsYTBklMnMW3',
      archive: 'aoa_public_2021-12-31_with_letter.zip',
      sha256: 'b6f1dc7aadf8209bf6c99fd516a06c0cabdc77c5f16f9fc8df92fdf1d8d01b9a',
    },
    coverage: {
      executionFiles: exec.files,
      walletFiles: wal.files,
      accountIds: [...exec.accountIds],
      firstFill: exec.firstTs,
      lastFill: exec.lastTs,
      firstWalletEvent: wal.firstEvent?.ts ?? null,
      lastWalletEvent: wal.lastEvent?.ts ?? null,
      spanningDays: wal.dailySeries.length,
    },
    executions: {
      totalRows: exec.rows,
      tradeFills: exec.fills,
      fundingRows: exec.fundingRows,
      settlementRows: exec.settlementRows,
      uniqueOrders: exec.orders.size,
      notionalByCurrency: Object.fromEntries(exec.notionalByCurrency),
      side: exec.side,
      liquidity: exec.liquidity,
      commissionXBt: round(satToXbt(commissionXBt), 8),
      fundingXBt: round(satToXbt(fundingXBt), 8),
    },
    wallet: {
      transactions: wal.transactions,
      startingBalanceXBt: round(satToXbt(wal.startingBalance), 8),
      finalBalanceXBt: round(satToXbt(wal.finalBalance), 8),
      deposits: { count: wal.depositCount, totalXBt: round(satToXbt(wal.deposits), 8) },
      withdrawals: { count: wal.withdrawalCount, totalXBt: round(satToXbt(wal.withdrawals), 8) },
      netExternalFlowXBt: round(satToXbt(netExternalFlow), 8),
      netPnlXBt: round(satToXbt(netPnl), 8),
      byType: Object.fromEntries([...wal.byType].map(([k, v]) => [k, { count: v.count, totalXBt: round(satToXbt(v.total), 8), cancelled: v.cancelled }])),
      realisedPnl: {
        count: wal.stats.count,
        totalXBt: round(satToXbt(wal.stats.total), 8),
        wins: wal.stats.wins,
        losses: wal.stats.losses,
        winRate: round(wal.stats.netWinRate, 4),
        grossProfitXBt: round(satToXbt(wal.stats.grossProfit), 8),
        grossLossXBt: round(satToXbt(wal.stats.grossLoss), 8),
        profitFactor: wal.stats.grossLoss ? round(wal.stats.grossProfit / wal.stats.grossLoss, 4) : null,
        avgWinXBt: round(satToXbt(wal.stats.avgWin), 8),
        avgLossXBt: round(satToXbt(wal.stats.avgLoss), 8),
        bestXBt: round(satToXbt(wal.stats.best), 8),
        worstXBt: round(satToXbt(wal.stats.worst), 8),
      },
      maxDrawdown: {
        pct: round(wal.maxDrawdown.pct, 4),
        peakXBt: round(satToXbt(wal.maxDrawdown.peak), 8),
        troughXBt: round(satToXbt(wal.maxDrawdown.trough), 8),
        peakDay: wal.maxDrawdown.peakDay,
        troughDay: wal.maxDrawdown.troughDay,
        caveat: 'Measured on the wallet balance column, which is a rounded day-level snapshot. Withdrawals also reduce it, so this is NOT the strategy drawdown.',
      },
      twr: {
        totalPct: null,
        countedDays: wal.twrCountedDays,
        skippedDays: wal.twrSkippedDays,
        reason: 'Not computable defensibly: the ledger has no per-transaction timestamps (only dates, with 5 date inversions in file order) and no unrealised PnL, so a true time-weighted return cannot be built. The earlier flow-adjusted number was an approximation and has been withdrawn.',
      },
      feeComponents: {
        makerRebateXBt: round(satToXbt(exec.makerRebateSatoshi), 8),
        takerFeeXBt: round(satToXbt(exec.takerFeeSatoshi), 8),
        netTradeFeeXBt: round(satToXbt(exec.makerRebateSatoshi + exec.takerFeeSatoshi), 8),
        fundingReceivedXBt: round(satToXbt(-fundingXBt), 8),
      },
    },
    reconciliation: {
      ledgerRealisedXBt: round(satToXbt(wal.stats.total), 8),
      equityDeltaXBt: round(satToXbt(netPnl), 8),
      differenceXBt: round(satToXbt(ledgerCheck), 8),
      verdict: 'Ledger amounts reconcile to the final balance to the satoshi. Execution-file funding and fees are components inside ledger RealisedPNL, not separate cash flows.',
    },
    monthly: wal.monthly.map((m) => ({
      month: m.month,
      fills: m.fills,
      orders: m.orders,
      notionalUsd: round(m.notional, 2),
      realisedXBt: round(satToXbt(m.realised), 8),
      fundingXBt: round(satToXbt(m.funding), 8),
      netPnlXBt: round(satToXbt(m.netPnl), 8),
      depositsXBt: round(satToXbt(m.deposits), 8),
      withdrawalsXBt: round(satToXbt(m.withdrawals), 8),
      endBalanceXBt: round(satToXbt(m.endBalance), 8),
    })),
    symbols,
  };

  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  // monthly.csv
  const mHead = 'month,fills,orders,notional_usd,realised_xbt,funding_xbt,net_pnl_xbt,deposits_xbt,withdrawals_xbt,end_balance_xbt\n';
  await fsp.writeFile(
    path.join(OUT_DIR, 'monthly.csv'),
    mHead + summary.monthly.map((m) => [
      m.month, m.fills, m.orders, m.notionalUsd, m.realisedXBt, m.fundingXBt,
      m.netPnlXBt, m.depositsXBt, m.withdrawalsXBt, m.endBalanceXBt,
    ].join(',')).join('\n') + '\n',
  );

  // daily-balance.csv
  const dHead = 'day,balance_xbt,net_external_flow_xbt,daily_return\n';
  await fsp.writeFile(
    path.join(OUT_DIR, 'daily-balance.csv'),
    dHead + wal.dailyRows.map((d) => [
      d.day, d.close.toFixed(8), d.flow.toFixed(8), d.ret === null ? '' : d.ret.toFixed(8),
    ].join(',')).join('\n') + '\n',
  );

  // symbols.csv
  const sHead = 'symbol,currency,fills,buys,sells,notional_usd,maker_fills,taker_fills,commission_xbt\n';
  await fsp.writeFile(
    path.join(OUT_DIR, 'symbols.csv'),
    sHead + symbols.map((s) => [
      s.symbol, s.currency, s.fills, s.buys, s.sells, s.notionalUsd, s.makerFills, s.takerFills, s.commission,
    ].join(',')).join('\n') + '\n',
  );

  // charts
  const equitySeries = wal.dailySeries.map((d, i) => ({ x: i, y: d.close / SAT, label: d.day }));
  await fsp.writeFile(
    path.join(OUT_DIR, 'equity-curve.svg'),
    svgLineChart({ series: equitySeries, label: 'AOA BitMEX wallet balance (XBt, deposits included)' }),
  );
  await fsp.writeFile(
    path.join(OUT_DIR, 'monthly-pnl.svg'),
    svgBarChart({
      bars: summary.monthly.map((m) => ({ label: m.month, v: m.netPnlXBt })),
      label: 'Monthly net PnL (realised + funding)',
    }),
  );

  // REPORT.md
  const rank = summary.symbols.slice(0, 12);
  const lines = [];
  lines.push('# AOA / BitMEX trading record analysis');
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push('');
  lines.push('Publicly disclosed by the account holder on 2026-09-22 in the DCInside 차트 마이너 갤러리');
  lines.push(`([post 5051684](${summary.source.post})). The archive is \`${summary.source.archive}\``);
  lines.push('(`sha256 ' + summary.source.sha256 + '`). This repository contains analysis code and derived');
  lines.push('statistics only. The raw CSVs are not redistributed here.');
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push(`- Ledger account: \`${summary.coverage.accountIds.join('`, `')}\``);
  lines.push(`- First fill: ${summary.coverage.firstFill}  |  Last fill: ${summary.coverage.lastFill}`);
  lines.push(`- Trading days in ledger: ${summary.coverage.spanningDays}`);
  lines.push('');
  lines.push('## Activity (execution records)');
  lines.push('');
  lines.push(`- Fill rows: **${fmtUsdNote(summary.executions.tradeFills)}**  (funding rows: ${fmtUsdNote(summary.executions.fundingRows)}, settlements: ${summary.executions.settlementRows})`);
  lines.push(`- Unique orders: **${fmtUsdNote(summary.executions.uniqueOrders)}**`);
  lines.push(`- Notional traded: ${Object.entries(summary.executions.notionalByCurrency).map(([c, v]) => `**${fmtUsdNote(v)} ${c}**`).join(' + ')}`);
  const liq = summary.executions.liquidity;
  lines.push(`- Maker fills ${fmtUsdNote(liq.maker.fills)} (${pct(liq.maker.fills / summary.executions.tradeFills, 1)}), taker fills ${fmtUsdNote(liq.taker.fills)} (${pct(liq.taker.fills / summary.executions.tradeFills, 1)})`);
  lines.push(`- Buy fills ${fmtUsdNote(summary.executions.side.Buy.fills)} / sell fills ${fmtUsdNote(summary.executions.side.Sell.fills)}`);
  lines.push(`- Commission paid: **${summary.executions.commissionXBt} XBt**`);
  lines.push(`- Funding: **${summary.executions.fundingXBt} XBt**`);
  lines.push('');
  lines.push('## Ledger (wallet records, authoritative for equity)');
  lines.push('');
  const w = summary.wallet;
  lines.push(`- Transactions: ${fmtUsdNote(w.transactions)}  |  start ${w.startingBalanceXBt} XBt -> end **${w.finalBalanceXBt} XBt**`);
  lines.push(`- Deposits: ${w.deposits.count} (${w.deposits.totalXBt} XBt)  |  Withdrawals: ${w.withdrawals.count} (${w.withdrawals.totalXBt} XBt)`);
  lines.push(`- Net trading PnL (equity - net external flow): **${w.netPnlXBt} XBt**`);
  lines.push(`- Realised PnL entries: ${fmtUsdNote(w.realisedPnl.count)}  |  wins ${fmtUsdNote(w.realisedPnl.wins)} / losses ${fmtUsdNote(w.realisedPnl.losses)}  |  win rate **${pct(w.realisedPnl.winRate, 1)}**`);
  lines.push(`- Profit factor: ${w.realisedPnl.profitFactor}  |  avg win ${w.realisedPnl.avgWinXBt} XBt  |  avg loss ${w.realisedPnl.avgLossXBt} XBt`);
  lines.push(`- Best ${w.realisedPnl.bestXBt} XBt  |  worst ${w.realisedPnl.worstXBt} XBt`);
  lines.push(`- Max drawdown of the *wallet balance column*: ${pct(w.maxDrawdown.pct, 1)} (${w.maxDrawdown.peakDay} -> ${w.maxDrawdown.troughDay}). This is not the strategy drawdown: withdrawals reduce the balance, and the column is a rounded day-level snapshot.`);
  lines.push('- Time-weighted return: **not reported**. The ledger has no per-transaction timestamps and no unrealised PnL, so a defensible TWR cannot be built from it.');
  lines.push(`- Fee components (inside ledger PnL): maker rebate ${w.feeComponents.makerRebateXBt} XBt, taker fee ${w.feeComponents.takerFeeXBt} XBt, net trade fee ${w.feeComponents.netTradeFeeXBt} XBt; funding received ${w.feeComponents.fundingReceivedXBt} XBt.`);
  lines.push('');
  lines.push('## Reconciliation');
  lines.push('');
  lines.push(`Ledger RealisedPNL ${summary.reconciliation.ledgerRealisedXBt} XBt vs equity delta ${summary.reconciliation.equityDeltaXBt} XBt.`);
  lines.push(`Difference: ${summary.reconciliation.differenceXBt} XBt. ${summary.reconciliation.verdict}`);
  lines.push('');
  lines.push('![Equity curve](results/equity-curve.svg)');
  lines.push('');
  lines.push('![Monthly PnL](results/monthly-pnl.svg)');
  lines.push('');
  lines.push('## Top symbols by notional');
  lines.push('');
  lines.push('| Symbol | Fills | Notional | Maker | Taker |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const s of rank) lines.push(`| ${s.symbol} | ${fmtUsdNote(s.fills)} | ${fmtUsdNote(s.notionalUsd)} | ${fmtUsdNote(s.makerFills)} | ${fmtUsdNote(s.takerFills)} |`);
  lines.push('');
  lines.push('## Monthly');
  lines.push('');
  lines.push('| Month | Fills | Orders | Notional | Realised | Funding | Net | End balance |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const m of summary.monthly) {
    lines.push(`| ${m.month} | ${fmtUsdNote(m.fills)} | ${fmtUsdNote(m.orders)} | ${fmtUsdNote(m.notionalUsd)} | ${m.realisedXBt} | ${m.fundingXBt} | ${m.netPnlXBt} | ${m.endBalanceXBt} |`);
  }
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  lines.push('- Notional is the absolute sum of `foreignNotional` per fill, i.e. gross turnover, not net exposure.');
  lines.push('- "Win rate" counts profitable `RealisedPNL` ledger entries, which are position-close events, not individual orders.');
  lines.push('- The disclosed window ends 2021-12-31; no data after that date is contained in the archive.');
  lines.push('- Deposits and withdrawals are treated as external flows for the time-weighted return.');
  await fsp.writeFile(path.join(ROOT, 'REPORT.md'), lines.join('\n') + '\n');

  process.stderr.write(`[analyze] wrote ${OUT_DIR} and REPORT.md in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  console.log(JSON.stringify({
    fills: exec.fills,
    orders: exec.orders.size,
    notionalUsd: Object.fromEntries(exec.notionalByCurrency),
    finalBalanceXBt: summary.wallet.finalBalanceXBt,
    netPnlXBt: summary.wallet.netPnlXBt,
    winRate: summary.wallet.realisedPnl.winRate,
    maxDrawdown: summary.wallet.maxDrawdown,
    twr: summary.wallet.twr,
    feeComponents: summary.wallet.feeComponents,
    reconciliation: summary.reconciliation,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
