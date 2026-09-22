#!/usr/bin/env node
/**
 * Daily withdrawal and cash-flow detail.
 *
 * The headline finding in FINDINGS.md is that 79.6% of realised profit left the
 * venue. This script produces the day-level and event-level detail behind that
 * number:
 *
 *   - one row per calendar day in the ledger window, with flows and running
 *     totals (including days with no transactions, marked as such)
 *   - one row per completed withdrawal, with its size relative to the equity it
 *     was taken from and where it sat in the profit cycle
 *
 * Because the wallet export has no per-transaction timestamps (only dates, and
 * the file is not even date-sorted), intraday ordering inside a day is not
 * recoverable. Days are therefore the finest resolution this data supports, and
 * same-day rows are ordered by their position in the file.
 *
 * Usage: node scripts/withdrawals.mjs [--data DIR] [--out DIR]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, num, SAT, satToXbt, round, percentile, WALLET_COL } from './lib/csv.mjs';

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

async function loadWallet(files) {
  const rows = [];
  let seq = 0;
  for (const f of files) {
    await parseCsv(f, (r) => {
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
        rawBalance: r[WALLET_COL.balance] || '',
        transactid: r[WALLET_COL.transactid] || '',
      });
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  return rows;
}

async function main() {
  const all = await fsp.readdir(DATA_DIR);
  const walletFiles = all.filter((f) => /^aoa-wallet-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
  const rows = await loadWallet(walletFiles);
  const active = rows.filter((r) => r.status !== 'Canceled');

  // ---- event-level withdrawal detail -------------------------------------
  let cumWithdrawn = 0;
  let cumRealised = 0;
  let cumDeposited = 0;
  const events = [];
  let peakCumRealised = 0;
  let peakDate = active[0]?.date ?? null;
  let lastWithdrawalDate = null;
  let prevBalance = active[0] ? active[0].balance - active[0].amount : 0;

  for (const r of active) {
    if (r.type === 'RealisedPNL') {
      cumRealised += r.amount;
      if (cumRealised > peakCumRealised) {
        peakCumRealised = cumRealised;
        peakDate = r.date;
      }
    } else if (r.type === 'Deposit') {
      cumDeposited += r.amount;
    } else if (r.type === 'Withdrawal') {
      cumWithdrawn += -r.amount;
      const equityBefore = prevBalance;
      const pnlSincePeak = cumRealised - peakCumRealised;
      events.push({
        date: r.date,
        amountXBt: round(satToXbt(-r.amount), 8),
        balanceAfterXBt: round(satToXbt(r.balance), 8),
        equityBeforeXBt: round(satToXbt(equityBefore), 8),
        shareOfEquityBefore: equityBefore > 0 ? round(-r.amount / equityBefore, 4) : null,
        cumulativeWithdrawnXBt: round(satToXbt(cumWithdrawn), 8),
        cumulativeRealisedXBt: round(satToXbt(cumRealised), 8),
        withdrawnShareOfCumulativeRealised: cumRealised > 0 ? round(cumWithdrawn / cumRealised, 4) : null,
        daysSincePreviousWithdrawal: lastWithdrawalDate
          ? Math.round((Date.parse(`${r.date}T00:00:00Z`) - Date.parse(`${lastWithdrawalDate}T00:00:00Z`)) / 86400000)
          : null,
        daysSinceProfitPeak: peakDate
          ? Math.round((Date.parse(`${r.date}T00:00:00Z`) - Date.parse(`${peakDate}T00:00:00Z`)) / 86400000)
          : null,
        drawdownFromPeakAtWithdrawalXBt: round(satToXbt(pnlSincePeak), 8),
        transactidPrefix: r.transactid.slice(0, 8),
      });
      lastWithdrawalDate = r.date;
    }
    prevBalance = r.balance;
  }

  // ---- day-level table ---------------------------------------------------
  const byDay = new Map();
  for (const r of active) {
    if (!byDay.has(r.date)) {
      byDay.set(r.date, { date: r.date, deposits: 0, withdrawals: 0, realised: 0, txns: 0, close: 0 });
    }
    const d = byDay.get(r.date);
    d.txns += 1;
    if (r.type === 'Deposit') d.deposits += r.amount;
    else if (r.type === 'Withdrawal') d.withdrawals += r.amount;
    else if (r.type === 'RealisedPNL') d.realised += r.amount;
    d.close = r.balance;
  }

  const days = [];
  let day = active[0].date;
  const last = active[active.length - 1].date;
  let runningBalance = active[0].balance - active[0].amount;
  let runningWithdrawn = 0;
  let runningRealised = 0;
  let runningDeposited = 0;
  let hasData;
  while (day <= last) {
    hasData = byDay.get(day);
    if (hasData) {
      runningBalance = hasData.close;
      runningWithdrawn += -hasData.withdrawals;
      runningRealised += hasData.realised;
      runningDeposited += hasData.deposits;
    }
    days.push({
      date: day,
      ledgerDay: Boolean(hasData),
      transactions: hasData ? hasData.txns : 0,
      depositsXBt: round(satToXbt(hasData ? hasData.deposits : 0), 8),
      withdrawalsXBt: round(satToXbt(hasData ? -hasData.withdrawals : 0), 8),
      realisedXBt: round(satToXbt(hasData ? hasData.realised : 0), 8),
      // `balanceXBt` on a day with no rows is the last known balance carried
      // forward, not a fresh observation. `ledgerDay` marks the difference.
      balanceXBt: round(satToXbt(runningBalance), 8),
      cumulativeWithdrawnXBt: round(satToXbt(runningWithdrawn), 8),
      cumulativeRealisedXBt: round(satToXbt(runningRealised), 8),
      cumulativeDepositedXBt: round(satToXbt(runningDeposited), 8),
    });
    day = nextDay(day);
  }

  const amounts = events.map((e) => e.amountXBt).sort((a, b) => a - b);
  const shares = events.map((e) => e.shareOfEquityBefore).filter((x) => x !== null).sort((a, b) => a - b);
  const gaps = events.map((e) => e.daysSincePreviousWithdrawal).filter((x) => x !== null).sort((a, b) => a - b);
  const daysFromPeak = events.map((e) => e.daysSinceProfitPeak).filter((x) => x !== null);

  // Round-lot detection. BitMEX charges the withdrawal fee on top of the amount
  // the user asks for, so a request for a round 20 BTC arrives as 20.012. That
  // makes the intended lot size recoverable: subtract the observed fee suffix
  // and see whether what is left is a round number.
  const FEE_SUFFIXES = [0.05, 0.015, 0.012, 0.002, 0.0012];
  const lotOf = (amount) => {
    for (const fee of FEE_SUFFIXES) {
      const base = amount - fee;
      if (base > 0 && Math.abs(base - Math.round(base * 100) / 100) < 1e-6) {
        return { baseXBt: round(base, 8), feeXBt: fee, round: Math.abs(base - Math.round(base)) < 1e-6 };
      }
    }
    return { baseXBt: amount, feeXBt: null, round: false };
  };
  const lots = events.map((e) => ({ date: e.date, amountXBt: e.amountXBt, ...lotOf(e.amountXBt) }));
  const ladder = new Map();
  for (const l of lots) {
    const key = l.baseXBt;
    if (!ladder.has(key)) ladder.set(key, { baseXBt: key, count: 0, firstDate: l.date, lastDate: l.date });
    const rec = ladder.get(key);
    rec.count += 1;
    if (l.date < rec.firstDate) rec.firstDate = l.date;
    if (l.date > rec.lastDate) rec.lastDate = l.date;
  }
  const lotLadder = [...ladder.values()].sort((a, b) => a.baseXBt - b.baseXBt);

  const totalWithdrawn = events.reduce((a, e) => a + e.amountXBt, 0);
  const finalRealised = satToXbt(active.filter((r) => r.type === 'RealisedPNL').reduce((a, r) => a + r.amount, 0));

  const summary = {
    generatedAt: new Date().toISOString(),
    window: { firstDay: days[0]?.date, lastDay: days[days.length - 1]?.date, days: days.length },
    completedWithdrawals: events.length,
    totalWithdrawnXBt: round(totalWithdrawn, 8),
    cumulativeRealisedXBt: round(finalRealised, 8),
    withdrawnShareOfRealised: round(totalWithdrawn / finalRealised, 4),
    withdrawalSizeXBt: {
      min: round(amounts[0], 8),
      p25: round(percentile(amounts, 0.25), 8),
      median: round(percentile(amounts, 0.5), 8),
      p75: round(percentile(amounts, 0.75), 8),
      max: round(amounts[amounts.length - 1], 8),
    },
    shareOfEquityAtWithdrawal: {
      median: round(percentile(shares, 0.5), 4),
      p10: round(percentile(shares, 0.1), 4),
      p90: round(percentile(shares, 0.9), 4),
      max: round(shares[shares.length - 1], 4),
      note: 'withdrawal amount divided by the wallet balance immediately before it',
    },
    spacingDays: {
      median: Math.round(percentile(gaps, 0.5)),
      p10: Math.round(percentile(gaps, 0.1)),
      p90: Math.round(percentile(gaps, 0.9)),
    },
    timingVsProfitPeak: {
      within5Days: daysFromPeak.filter((d) => d >= 0 && d <= 5).length,
      within30Days: daysFromPeak.filter((d) => d >= 0 && d <= 30).length,
      medianDaysAfterPeak: Math.round(percentile(daysFromPeak.slice().sort((a, b) => a - b), 0.5)),
      note: 'days between a high-water mark in cumulative realised PnL and the withdrawal',
    },
    cancelledWithdrawals: rows.filter((r) => r.type === 'Withdrawal' && r.status === 'Canceled').length,
    depositsXBt: round(satToXbt(active.filter((r) => r.type === 'Deposit').reduce((a, r) => a + r.amount, 0)), 8),
    roundLotPattern: {
      note: 'Amounts are round BTC lots plus the exchange withdrawal fee, so the intended lot size is recoverable.',
      withdrawalsMatchingARoundLot: lots.filter((l) => l.round).length,
      ofWithdrawals: lots.length,
      distinctLotSizes: lotLadder.length,
      ladder: lotLadder,
    },
  };

  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(path.join(OUT_DIR, 'withdrawals.json'), JSON.stringify({ summary, events, lots, dailyCount: days.length }, null, 2) + '\n');

  const evHead = 'date,amount_xbt,balance_after_xbt,equity_before_xbt,share_of_equity_before,cumulative_withdrawn_xbt,cumulative_realised_xbt,withdrawn_share_of_cumulative_realised,days_since_previous_withdrawal,days_since_profit_peak,drawdown_from_peak_xbt\n';
  await fsp.writeFile(
    path.join(OUT_DIR, 'withdrawals-events.csv'),
    evHead + events.map((e) => [
      e.date, e.amountXBt, e.balanceAfterXBt, e.equityBeforeXBt, e.shareOfEquityBefore,
      e.cumulativeWithdrawnXBt, e.cumulativeRealisedXBt, e.withdrawnShareOfCumulativeRealised,
      e.daysSincePreviousWithdrawal ?? '', e.daysSinceProfitPeak ?? '', e.drawdownFromPeakAtWithdrawalXBt,
    ].join(',')).join('\n') + '\n',
  );

  const dHead = 'date,ledger_day,transactions,deposits_xbt,withdrawals_xbt,realised_xbt,balance_xbt,cumulative_withdrawn_xbt,cumulative_realised_xbt,cumulative_deposited_xbt\n';
  await fsp.writeFile(
    path.join(OUT_DIR, 'withdrawals-daily.csv'),
    dHead + days.map((d) => [
      d.date, d.ledgerDay ? 1 : 0, d.transactions, d.depositsXBt, d.withdrawalsXBt, d.realisedXBt,
      d.balanceXBt, d.cumulativeWithdrawnXBt, d.cumulativeRealisedXBt, d.cumulativeDepositedXBt,
    ].join(',')).join('\n') + '\n',
  );

  // cumulative-withdrawal-vs-profit chart
  const width = 900;
  const height = 340;
  const pad = { l: 74, r: 20, t: 24, b: 34 };
  const seriesPnl = days.map((d, i) => ({ x: i, y: d.cumulativeRealisedXBt, label: d.date }));
  const seriesWd = days.map((d, i) => ({ x: i, y: d.cumulativeWithdrawnXBt, label: d.date }));
  const maxY = Math.max(...seriesPnl.map((p) => p.y));
  const sx = (x) => pad.l + (x / (days.length - 1)) * (width - pad.l - pad.r);
  const sy = (y) => height - pad.b - (y / maxY) * (height - pad.t - pad.b);
  const pathOf = (s) => s.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const v = (maxY * i) / 4;
    const y = sy(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${width - pad.r}" y2="${y.toFixed(1)}" stroke="#e6e8ee"/>`
      + `<text x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5b6270">${v.toFixed(0)}</text>`;
  }).join('');
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const i = Math.round(f * (days.length - 1));
    return `<text x="${sx(i).toFixed(1)}" y="${height - 12}" text-anchor="middle" font-size="11" fill="#5b6270">${days[i].date}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Cumulative realised profit vs cumulative withdrawn">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${gridLines}
  <polyline points="${pathOf(seriesPnl)}" fill="none" stroke="#2f6fed" stroke-width="2"/>
  <polyline points="${pathOf(seriesWd)}" fill="none" stroke="#1f9d55" stroke-width="2"/>
  ${xLabels}
  <text x="${pad.l}" y="16" font-size="12" fill="#2b3040">cumulative realised profit (blue) vs cumulative withdrawn (green), XBt</text>
</svg>`;
  await fsp.writeFile(path.join(OUT_DIR, 'withdrawals-cumulative.svg'), svg);

  console.log(JSON.stringify(summary, null, 2));
  console.log('\nfirst 5 withdrawal events:');
  console.log(JSON.stringify(events.slice(0, 5), null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
