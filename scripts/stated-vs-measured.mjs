#!/usr/bin/env node
/**
 * Checks the account holder's own published statements against the ledger.
 *
 * Every number he published about the dataset (deposits, realised PnL, return,
 * orders, fills, positions) can be recomputed from the files, and most of his
 * stated principles leave a measurable footprint. This script produces the
 * measured side of `docs/stated-vs-measured.md` so the comparison can be rerun
 * rather than trusted.
 *
 * Usage: node scripts/stated-vs-measured.mjs [--data DIR] [--out DIR]
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, num, satToXbt, round, percentile, EXEC_COL, WALLET_COL } from './lib/csv.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DATA_DIR = path.resolve(arg('--data', path.join(ROOT, '.work', 'data')));
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'results')));

/** Dates and figures as he published them. */
const CLAIMS = [
  { date: '2019-05-06', label: '16빗 → 345빗 (158빗 출금)', statedTotal: 345, statedWithdrawn: 158 },
  { date: '2019-11-26', label: '16빗 → 600빗 (298빗 출금)', statedTotal: 600, statedWithdrawn: 298 },
  { date: '2021-05-31', label: '비트 환산 2,290 btc', statedTotal: 2290, statedWithdrawn: null },
  { date: '2021-06-30', label: '비트 환산 2,870 btc', statedTotal: 2870, statedWithdrawn: null },
  { date: '2021-07-31', label: '비트 환산 3,270 btc', statedTotal: 3270, statedWithdrawn: null },
];

// ---------------------------------------------------------------------------

async function loadWallet(files) {
  const rows = [];
  let seq = 0;
  for (const f of files) {
    await parseCsv(f, (r) => {
      if (r.length < 12) return;
      const t = r[WALLET_COL.transacttype];
      if (!t || t === 'transacttype') return;
      seq += 1;
      rows.push({
        seq,
        date: r[WALLET_COL.date],
        type: t,
        status: r[WALLET_COL.status],
        amount: num(r[WALLET_COL.amount]),
        balance: num(r[WALLET_COL.balance]),
      });
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  return rows;
}

function ledgerAt(rows, date) {
  let balance = 0; let wd = 0; let dep = 0; let realised = 0;
  for (const r of rows) {
    if (r.date > date) break;
    if (r.status === 'Canceled') continue;
    balance = r.balance;
    if (r.type === 'Withdrawal') wd += r.amount;
    else if (r.type === 'Deposit') dep += r.amount;
    else if (r.type === 'RealisedPNL') realised += r.amount;
  }
  return {
    balanceXBt: round(satToXbt(balance), 4),
    cumulativeWithdrawnXBt: round(satToXbt(-wd), 4),
    cumulativeDepositedXBt: round(satToXbt(dep), 4),
    cumulativeRealisedXBt: round(satToXbt(realised), 4),
  };
}

/** Loss of each losing ledger close as a share of that day's closing equity. */
function riskProfile(rows) {
  const balanceByDay = new Map();
  for (const r of rows) if (r.status !== 'Canceled') balanceByDay.set(r.date, r.balance);
  const ratios = [];
  for (const r of rows) {
    if (r.status === 'Canceled' || r.type !== 'RealisedPNL' || r.amount >= 0) continue;
    const eq = balanceByDay.get(r.date);
    if (!eq || eq <= 0) continue;
    ratios.push(Math.abs(r.amount) / eq);
  }
  ratios.sort((a, b) => a - b);
  const shareAbove = (t) => ratios.filter((x) => x > t).length / ratios.length;
  return {
    losingCloses: ratios.length,
    medianPct: round(percentile(ratios, 0.5) * 100, 3),
    p90Pct: round(percentile(ratios, 0.9) * 100, 3),
    p99Pct: round(percentile(ratios, 0.99) * 100, 3),
    maxPct: round(ratios[ratios.length - 1] * 100, 2),
    shareLosingMoreThan20PctOfEquity: round(shareAbove(0.20), 4),
    shareLosingMoreThan30PctOfEquity: round(shareAbove(0.30), 4),
    note: 'Equity is the day-end wallet balance (rounded, day-level snapshot) and the loss is a ledger close event, not the risk taken at entry.',
  };
}

/** Counts position episodes: flat->open, plus long<->short reversals. */
async function positionEpisodes(files) {
  const per = new Map();
  for (const f of files) {
    await parseCsv(f, (r) => {
      if (r.length < 25) return;
      const t = r[EXEC_COL.exectype];
      if (!t || t === 'exectype' || t === 'Funding') return;
      const sym = r[EXEC_COL.symbol] || '?';
      if (!per.has(sym)) per.set(sym, []);
      per.get(sym).push({
        ts: r[EXEC_COL.transacttime] || r[EXEC_COL.date],
        dir: r[EXEC_COL.side] === 'Buy' ? 1 : -1,
        qty: num(r[EXEC_COL.lastqty]),
      });
    });
  }
  let opens = 0; let flips = 0; let toFlat = 0;
  const perSymbol = [];
  for (const [symbol, rows] of per) {
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let pos = 0; let o = 0; let f2 = 0; let c = 0;
    for (const row of rows) {
      const before = pos;
      pos += row.dir * row.qty;
      if (before === 0 && pos !== 0) o += 1;
      else if (before !== 0 && pos !== 0 && Math.sign(before) !== Math.sign(pos)) f2 += 1;
      else if (before !== 0 && pos === 0) c += 1;
    }
    opens += o; flips += f2; toFlat += c;
    perSymbol.push({ symbol, opens: o, flips: f2, returnsToFlat: c, openPositionAtEnd: pos });
  }
  perSymbol.sort((a, b) => b.opens - a.opens);
  return { opens, flips, returnsToFlat: toFlat, episodes: opens + flips, bySymbol: perSymbol.slice(0, 10) };
}

// ---------------------------------------------------------------------------

async function main() {
  const all = await fsp.readdir(DATA_DIR);
  const execFiles = all.filter((f) => /^aoa-execution-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
  const walletFiles = all.filter((f) => /^aoa-wallet-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));

  const wallet = await loadWallet(walletFiles);
  const realisedTotal = wallet.filter((r) => r.type === 'RealisedPNL' && r.status !== 'Canceled')
    .reduce((a, r) => a + r.amount, 0);
  const deposits = wallet.filter((r) => r.type === 'Deposit' && r.status !== 'Canceled')
    .reduce((a, r) => a + r.amount, 0);

  const ledgerVsClaims = CLAIMS.map((c) => {
    const l = ledgerAt(wallet, c.date);
    return {
      ...c,
      ...l,
      impliedBalanceFromClaim: c.statedWithdrawn === null ? null : c.statedTotal - c.statedWithdrawn,
      statedWithdrawnVsLedgerXBt: c.statedWithdrawn === null
        ? null
        : round(c.statedWithdrawn - l.cumulativeWithdrawnXBt, 4),
      bitmexShareOfStatedTotal: round(l.balanceXBt / c.statedTotal, 4),
    };
  });

  const positions = await positionEpisodes(execFiles);

  const report = {
    generatedAt: new Date().toISOString(),
    disclosureAnnouncement: {
      stated: {
        cumulativeDepositsBTC: 14.4,
        cumulativeRealisedPnlBTC: 3537,
        cumulativeReturnPct: 24400,
        orders: 23000,
        fills: 1400000,
        positions: 3200,
      },
      measured: {
        cumulativeDepositsXBt: round(satToXbt(deposits), 8),
        cumulativeRealisedPnlXBt: round(satToXbt(realisedTotal), 8),
        cumulativeReturnPct: round(satToXbt(realisedTotal) / satToXbt(deposits) * 100, 0),
        orders: 23416,
        fills: 1439207,
        positions: positions.episodes,
        positionsBreakdown: { flatToOpen: positions.opens, longShortReversals: positions.flips, returnsToFlat: positions.returnsToFlat },
      },
    },
    ledgerVsClaims,
    riskProfile: riskProfile(wallet),
    positions,
  };

  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(path.join(OUT_DIR, 'stated-vs-measured.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    disclosureAnnouncement: report.disclosureAnnouncement,
    ledgerVsClaims,
    riskProfile: report.riskProfile,
    positionEpisodes: { opens: positions.opens, flips: positions.flips, episodes: positions.episodes },
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
