#!/usr/bin/env node
/**
 * Builds the static site's data payload from the analysis outputs.
 *
 * The site is deliberately data-only-plus-JS: no build step, no framework, no
 * network calls at runtime. This script copies the aggregates the page needs
 * into site/data/ so the whole site can be served from any static host.
 *
 * What is deliberately NOT copied into the site:
 *   - the raw CSVs
 *   - the 1,398-row day-by-day cash-flow table (results/withdrawals-daily.csv)
 *     and the full daily ledger series; the site shows the withdrawal events and
 *     the trading calendar, not a day-by-day withdrawal ledger
 *   - any transaction, order or execution identifier
 *
 * Usage: node scripts/build-site.mjs
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'site', 'data');

const readJson = async (p) => JSON.parse(await fsp.readFile(path.join(ROOT, p), 'utf8'));
const readCsv = async (p) => {
  const text = await fsp.readFile(path.join(ROOT, p), 'utf8');
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const row = {};
    cols.forEach((c, i) => { row[c] = cells[i]; });
    return row;
  });
};

const num = (v) => (v === '' || v === undefined ? null : Number(v));

async function main() {
  await fsp.mkdir(OUT, { recursive: true });

  const summary = await readJson('results/summary.json');
  const insights = await readJson('results/insights.json');
  const validation = await readJson('results/validation.json');
  const stated = await readJson('results/stated-vs-measured.json');
  const withdrawals = await readJson('results/withdrawals.json');
  const manifest = await readJson('manifest.json');
  const dailyActivity = await readCsv('results/daily-activity.csv');

  const w = summary.wallet;
  const h = insights.headline;

  const meta = {
    title: 'aoa-bitmex-analysis',
    generatedAt: summary.generatedAt,
    source: summary.source,
    window: {
      firstFill: summary.coverage.firstFill,
      lastFill: summary.coverage.lastFill,
      firstLedgerEvent: summary.coverage.firstWalletEvent,
      lastLedgerEvent: summary.coverage.lastWalletEvent,
    },
    files: manifest.files,
    account: summary.coverage.accountIds,
    disclaimer:
      'Unofficial, independent analysis of files published publicly by their owner. '
      + 'The files are internally consistent; that is not the same as the exchange having issued '
      + 'them or the account owner being verified. Not affiliated with the account owner or with BitMEX.',
  };

  const headline = {
    fills: summary.executions.tradeFills,
    orders: summary.executions.uniqueOrders,
    symbols: summary.symbols.length,
    tradingDays: insights.activity.tradingDays,
    depositsXBt: w.deposits.totalXBt,
    withdrawalsXBt: w.withdrawals.totalXBt,
    realisedXBt: w.realisedPnl.totalXBt,
    finalBalanceXBt: w.finalBalanceXBt,
    reconciliationDifferenceXBt: summary.reconciliation.differenceXBt,
    winRate: w.realisedPnl.winRate,
    profitFactor: w.realisedPnl.profitFactor,
    payoffRatio: Number((w.realisedPnl.avgWinXBt / Math.abs(w.realisedPnl.avgLossXBt)).toFixed(4)),
    makerShare: h.makerShare,
    netTradeFeeXBt: h.netTradeFeeXBt,
    fundingReceivedXBt: h.fundingReceivedXBt,
    withdrawnShareOfProfit: h.withdrawnShareOfProfit,
    medianHold: insights.holdingPeriod.median,
    medianFillsPerActiveDay: insights.activity.medianFillsPerActiveDay,
    maxDrawdownXBt: h.maxDrawdownByAbsoluteXBt?.dropXBt ?? null,
    maxDrawdownPct: h.maxDrawdownByAbsoluteXBt?.pct ?? null,
    maxDrawdownPeakDay: h.maxDrawdownByAbsoluteXBt?.peakDay ?? null,
    maxDrawdownTroughDay: h.maxDrawdownByAbsoluteXBt?.troughDay ?? null,
  };

  // Validation checks, shaped for a table.
  const checks = [
    ['Ledger reconciles to the final balance', `${summary.reconciliation.differenceXBt} XBt difference`, 'pass',
      'deposits + withdrawals + realised PnL = final balance, to the satoshi'],
    ['Duplicate execution ids', `${validation.summary.execIdDuplicates} of 1,444,583`, 'pass',
      'every execid is unique'],
    ['Duplicate trade match ids', `${validation.summary.trdmatchidDuplicatePairs} repeats of 1,439,207`, 'note',
      'single repeated rows, not maker/taker pairs; needs market-side comparison to interpret'],
    ['Order quantity vs fills', `${validation.summary.orderQtyMismatches} mismatches of ${validation.summary.ordersChecked} orders`, 'pass',
      'sum(lastqty) equals max(cumqty) for every order with a real id'],
    ['Funding rows match the reconstructed position', validation.summary.fundingQtyMatched, 'pass',
      'the funded quantity equals the position that existed at that instant'],
    ['Settlements zero the position', validation.summary.settlementsZeroed, 'pass',
      'every expiry settlement drives the reconstructed position to exactly zero'],
    ['Open position at end of data', 'XBTUSD −29,080,100 contracts', 'note',
      'the period does not end flat, so no closing trade can be assumed'],
    ['Execution timestamps out of order', `${validation.summary.timeInversions} of 1,444,583`, 'note',
      '~0.3%; fills are buffered per day and sorted before any position work'],
    ['Wallet rows out of date order', `${validation.summary.walletDateInversionsInFileOrder}`, 'note',
      'the wallet file is not date-sorted'],
    ['Wallet balance is a running balance', `${validation.summary.walletRowLevelBalanceMismatches} rows disagree`, 'fail',
      'it is a rounded day-level snapshot repeated on every row of that day'],
    ['Days whose end-of-day balance disagrees', `${validation.summary.walletDayEndBalanceMismatches} of 1,380`, 'note',
      '152 are rounding (≤0.0045 XBt); 2018-04-27 and 2018-04-28 are off by 0.546 and 1.001 XBt'],
    ['Liquidation rows', `${validation.summary.liquidationRows}`, 'note',
      '28 of them use the zero order id; neither "none" nor "59" summarises this correctly'],
    ['External market-tick comparison', 'not performed', 'open',
      'no fill has been matched against public tick data'],
    ['Publisher and exchange issuance verified', 'not performed', 'open',
      'internal consistency is not authenticity'],
  ].map(([check, result, verdict, note]) => ({ check, result, verdict, note }));

  const statedPayload = {
    announcement: stated.disclosureAnnouncement,
    ledgerVsClaims: stated.ledgerVsClaims,
    riskProfile: stated.riskProfile,
    principles: [
      { stated: '“출금해라”, and stop re-depositing after a loss',
        measured: '79.6% of realised profit withdrawn, in round BTC lots that step up with the account; total deposits 14.49 XBt over four years',
        verdict: 'match' },
      { stated: '“보통 하루 정도 들고 있음” (holds about a day)',
        measured: 'FIFO round-trip median hold 13.2 h',
        verdict: 'match' },
      { stated: '“승률에 더 신경 써라” (prefer hit rate over payoff ratio)',
        measured: 'win rate 66.99%, profit factor 1.70, payoff ratio 0.84',
        verdict: 'match' },
      { stated: '“시총이 큰 코인 위주로 매매” (trade the large caps)',
        measured: 'XBTUSD + ETHUSD produced 80.2% of ledger profit; the largest altcoin futures were net losers',
        verdict: 'match' },
      { stated: '“자본의 최대 30% 이상을 잃지 않도록” (never risk more than ~30% of capital)',
        measured: '97.5% of losing closes cost under 30% of that day’s equity (20% threshold: 95.7%)',
        verdict: 'match' },
      { stated: '“선물 4 : 현물 4 : 현금 2” (allocation)',
        measured: 'the BitMEX ledger held 30–40% of the totals he published, bracketing the 40% futures share',
        verdict: 'match' },
      { stated: '“최대 1.5~2배 레버리지” (BitMEX interview)',
        measured: 'not recoverable: margin mode and leverage are not in a fill export',
        verdict: 'unverifiable' },
      { stated: '“별다른 보조지표를 보지 않고 캔들과 거래량만”',
        measured: 'not recoverable: entry reasoning is not in the file',
        verdict: 'unverifiable' },
    ],
    openDiscrepancy: {
      what: 'His two 2019 progress posts state cumulative withdrawals 43.1 BTC below the ledger at both dates, six months apart.',
      detail: '2019-05-06: stated 158 vs ledger 201.04. 2019-11-26: stated 298 vs ledger 341.13. The implied balance (stated total − stated withdrawals) matches the ledger at 2019-11-26 within 1 XBt.',
      reading: 'Something the ledger records as a withdrawal was not counted as one. The file cannot distinguish an internal transfer from an error.',
    },
  };

  const activity = {
    days: dailyActivity.map((r) => ({
      d: r.date,
      f: num(r.fills),
      o: num(r.orders),
      n: num(r.notional_xbt),
    })),
    hourDow: insights.timing.hourDow,
    dowLabels: insights.timing.dowLabels,
    summary: insights.activity,
  };

  const payloads = {
    'meta.json': meta,
    'headline.json': headline,
    'validation.json': { checks, summary: validation.summary },
    'stated.json': statedPayload,
    'withdrawals.json': {
      summary: withdrawals.summary,
      ladder: withdrawals.summary.roundLotPattern.ladder,
      events: withdrawals.events.map((e) => ({
        date: e.date,
        amountXBt: e.amountXBt,
        shareOfEquityBefore: e.shareOfEquityBefore,
        daysSinceProfitPeak: e.daysSinceProfitPeak,
        cumulativeWithdrawnXBt: e.cumulativeWithdrawnXBt,
      })),
    },
    'symbols.json': summary.symbols.slice(0, 20).map((s) => ({
      symbol: s.symbol, fills: s.fills, notionalUsd: s.notionalUsd,
      makerFills: s.makerFills, takerFills: s.takerFills,
    })),
    'attribution.json': insights.symbolAttribution,
    'monthly.json': insights.monthly,
    'insights.json': {
      holdingPeriod: insights.holdingPeriod,
      exposure: insights.exposure,
      concentration: insights.concentration,
      behaviour: insights.behaviour,
      drawdowns: insights.drawdowns,
      feeComponents: {
        makerRebateXBt: summary.wallet.feeComponents.makerRebateXBt,
        takerFeeXBt: summary.wallet.feeComponents.takerFeeXBt,
        netTradeFeeXBt: summary.wallet.feeComponents.netTradeFeeXBt,
        fundingReceivedXBt: summary.wallet.feeComponents.fundingReceivedXBt,
      },
      notes: insights.definitions,
    },
    'activity.json': activity,
    'balance.json': {
      // monthly end balances only: the daily series stays in the repo
      monthly: insights.monthly.map((m) => ({ month: m.month, endBalanceXBt: m.endBalanceXBt, realisedXBt: m.realisedXBt, withdrawalsXBt: m.withdrawalsXBt, depositsXBt: m.depositsXBt })),
    },
  };

  for (const [name, payload] of Object.entries(payloads)) {
    await fsp.writeFile(path.join(OUT, name), JSON.stringify(payload, null, 1) + '\n');
  }
  const sizes = Object.keys(payloads).map((n) => `${n} ${(fs.statSync(path.join(OUT, n)).size / 1024).toFixed(1)}kB`);
  console.log('wrote site/data:\n  ' + sizes.join('\n  '));
}

main().catch((e) => { console.error(e); process.exit(1); });
