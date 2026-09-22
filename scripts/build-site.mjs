#!/usr/bin/env node
/**
 * Builds the static site's data payload from the analysis outputs.
 *
 * The site is deliberately data-only-plus-JS: no build step, no framework, no
 * external network calls at runtime. Only local aggregate JSON is requested.
 * This script copies the aggregates the page needs
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
import crypto from 'node:crypto';
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
  const candles = await readJson('results/candles.json');

  const w = summary.wallet;
  const h = insights.headline;
  // Use the audited order count (the all-zero placeholder is not an order),
  // and full-precision wallet aggregates. The insights export contains a
  // KST funding-only 2022-01 bucket with an artificial zero balance.
  const monthDetails = new Map(insights.monthly.map((m) => [m.month, m]));
  const monthly = summary.monthly.map((m) => ({ ...monthDetails.get(m.month), ...m }));
  const classifiedTrips = insights.holdingPeriod.histogram.reduce((total, row) => total + row.trips, 0);
  const unclassifiedTrips = insights.holdingPeriod.trips - classifiedTrips;
  if (unclassifiedTrips < 0) throw new Error('Holding-period histogram exceeds trip count');
  const integerLedger = Object.fromEntries(
    ['deposits', 'withdrawals', 'realised', 'finalBalance', 'diff']
      .map((key) => [key, String(validation.wallet.reconstruction[key])]),
  );

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
    repository: 'https://github.com/twoimo/aoa-bitmex-analysis',
    ledgerSatoshi: integerLedger,
    counts: {
      executionRows: validation.executions.rows,
      fundingRows: validation.executions.byType.Funding,
      settlementRows: validation.executions.byType.Settlement,
      walletTransactions: w.transactions,
      ledgerPnlEntries: w.realisedPnl.count,
      winningEntries: w.realisedPnl.wins,
      losingEntries: w.realisedPnl.losses,
      deposits: w.deposits.count,
      withdrawals: w.withdrawals.count,
      cancelledWithdrawals: w.byType.Withdrawal.cancelled,
    },
    // Only keep adjustments where the published value actually differs from the
    // source value; upstream fixes will quietly drop entries rather than leave
    // stale "discrepancy" notes on the page. The editorial verdict change is
    // always kept because it is a judgement, not a reconciliation.
    sourceAdjustments: [
      { field: 'orders', original: summary.executions.uniqueOrders, published: validation.summary.ordersChecked,
        reason: '영(0) 식별자를 주문에서 제외한 validation.summary.ordersChecked를 사용합니다.' },
      { field: 'netTradeFeeXBt', original: h.netTradeFeeXBt, published: w.feeComponents.netTradeFeeXBt,
        reason: 'insights.headline과 다른 값이 있어 summary.wallet.feeComponents의 순거래 수수료를 사용합니다. 펀딩과의 순수취도 이 값으로 다시 계산합니다. 원본 분석 산출물은 수정하지 않았습니다.' },
      { field: 'monthly', original: insights.monthly.length, published: monthly.length,
        reason: '지갑 집계가 존재하는 2018-03~2021-12만 사용합니다. KST 펀딩 때문에 생긴 2022-01의 잔고 0행을 제외하고 월별 금액은 summary.monthly의 정밀도를 유지합니다.' },
      { field: 'holdingPeriod.histogram', original: classifiedTrips, published: insights.holdingPeriod.trips,
        reason: `구간별 합계와 전체 FIFO 건수의 차이 ${unclassifiedTrips}건을 미분류로 별도 표시합니다. 원래 구간별 수치는 유지합니다. 생성 코드는 0 이상인 유효 기간만 구간에 넣지만, 차이가 생긴 개별 대응의 원인은 집계 JSON으로 확인할 수 없습니다.` },
      { field: 'principles.verdict', original: 'match / unverifiable', published: 'note / open',
        reason: '원칙과 비슷한 관측 패턴은 원칙 준수나 인과관계의 증명이 아닙니다. 공개 JSON에도 화면과 같은 주의·미확인 판정을 사용하며, 2019년 출금 차이는 날짜별 실측값으로 구분합니다.' },
    ].filter((a) => a.field === 'principles.verdict' || a.original !== a.published),
    disclaimer:
      'Unofficial, independent analysis of files published publicly by their owner. '
      + 'The final ledger reconciles internally, while intermediate balance discrepancies remain. '
      + 'Exchange issuance and account ownership have not been verified. Not affiliated with the account owner or with BitMEX.',
  };

  const headline = {
    fills: summary.executions.tradeFills,
    orders: validation.summary.ordersChecked,
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
    netTradeFeeXBt: w.feeComponents.netTradeFeeXBt,
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
    ['External market-tick comparison', '81,263 of 81,268 sampled fills found', 'pass',
      'Fills matched by trdMatchID in BitMEX\'s public daily trade archive across 64 sampled days. The 5 misses are all liquidations, a type the archive does not publish. Symbol, size and price matched on every hit, and the taker-side rule held on all 81,263, which independently confirms the maker/taker labels.'],
    ['Publisher and account ownership verified', 'not performed', 'open',
      'matching fills show the file describes real BitMEX trades; they say nothing about whose account it was'],
  ].map(([check, result, verdict, note]) => ({ check, result, verdict, note }));

  const statedPayload = {
    announcement: stated.disclosureAnnouncement,
    ledgerVsClaims: stated.ledgerVsClaims,
    riskProfile: stated.riskProfile,
    principles: [
      { stated: '“출금해라”, and stop re-depositing after a loss',
        measured: '79.6% of ledger realised profit withdrawn in 56 completed events; total deposits 14.49 BTC. Withdrawal motives and a no-redeposit rule are not established.',
        verdict: 'note' },
      { stated: '“보통 하루 정도 들고 있음” (holds about a day)',
        measured: 'FIFO quantity-match median hold 13.2 h; this is not an exchange-reported position lifetime.',
        verdict: 'note' },
      { stated: '“승률에 더 신경 써라” (prefer hit rate over payoff ratio)',
        measured: 'Positive ledger-entry share 66.99%, profit factor 1.70, payoff ratio 0.84; entry priorities cannot be inferred.',
        verdict: 'note' },
      { stated: '“시총이 큰 코인 위주로 매매” (trade the large caps)',
        measured: 'XBTUSD + ETHUSD produced 80.2% of ledger profit; this is profit concentration, not evidence of a selection rule or its causal effect.',
        verdict: 'note' },
      { stated: '“자본의 최대 30% 이상을 잃지 않도록” (never risk more than ~30% of capital)',
        measured: '97.5% of negative ledger entries were below 30% of the day-end book balance (20% threshold: 95.7%). This does not measure risk taken at entry.',
        verdict: 'note' },
      { stated: '“선물 4 : 현물 4 : 현금 2” (allocation)',
        measured: 'The BitMEX ledger balance was 30–40% of published total-asset estimates at three dates. Other venues and the stated allocation cannot be verified here.',
        verdict: 'open' },
      { stated: '“최대 1.5~2배 레버리지” (BitMEX interview)',
        measured: 'not recoverable: margin mode and leverage are not in a fill export',
        verdict: 'open' },
      { stated: '“별다른 보조지표를 보지 않고 캔들과 거래량만”',
        measured: 'not recoverable: entry reasoning is not in the file',
        verdict: 'open' },
    ],
    openDiscrepancy: {
      what: 'Two 2019 posts state cumulative withdrawals roughly 43 BTC below the ledger. The two differences are similar, not identical.',
      detail: stated.ledgerVsClaims.filter((row) => row.statedWithdrawn !== null).map((row) => `${row.date}: stated ${row.statedWithdrawn} BTC, ledger ${row.cumulativeWithdrawnXBt.toFixed(8)} BTC, ledger-minus-stated ${(-row.statedWithdrawnVsLedgerXBt).toFixed(8)} BTC.`).join(' '),
      reading: 'An internal transfer, a definition difference, or an error are possible explanations. These files do not establish which explanation is correct.',
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
      ladder: withdrawals.summary.roundLotPattern.ladder.map((l) => ({ ...l,
        round: withdrawals.lots.some((lot) => lot.baseXBt === l.baseXBt && lot.round),
      })),
      events: withdrawals.events.map((e, i) => ({
        date: e.date,
        amountXBt: e.amountXBt,
        shareOfEquityBefore: e.shareOfEquityBefore,
        daysSinceProfitPeak: e.daysSinceProfitPeak,
        cumulativeWithdrawnXBt: e.cumulativeWithdrawnXBt,
        baseXBt: withdrawals.lots[i].baseXBt,
        feeXBt: withdrawals.lots[i].feeXBt,
        round: withdrawals.lots[i].round,
      })),
    },
    'symbols.json': summary.symbols.slice(0, 20).map((s) => ({
      symbol: s.symbol, fills: s.fills, notionalUsd: s.notionalUsd,
      makerFills: s.makerFills, takerFills: s.takerFills,
    })),
    'attribution.json': insights.symbolAttribution,
    'monthly.json': monthly,
    'insights.json': {
      holdingPeriod: { ...insights.holdingPeriod, histogramCoverage: { classifiedTrips, unclassifiedTrips } },
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
    'candles.json': candles,
    'balance.json': {
      // monthly end balances only: the daily series stays in the repo
      monthly: monthly.map((m) => ({ month: m.month, endBalanceXBt: m.endBalanceXBt, realisedXBt: m.realisedXBt, withdrawalsXBt: m.withdrawalsXBt, depositsXBt: m.depositsXBt })),
    },
  };

  // Fail before writing if an export starts carrying protected identifiers.
  // Aggregate check names such as execIdDuplicates are counts, not identities.
  const protectedKey = /^(execid|orderid|clordid|clordlinkid|trdmatchid|transactid|transactidPrefix|address|tx)$/i;
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const inspect = (value, location) => {
    if (typeof value === 'string' && uuid.test(value)) throw new Error(`Protected identifier at ${location}`);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (protectedKey.test(key)) throw new Error(`Protected field at ${location}.${key}`);
      inspect(child, `${location}.${key}`);
    }
  };
  inspect(payloads, 'site/data');
  if (withdrawals.events.some((event, i) => event.date !== withdrawals.lots[i]?.date || event.amountXBt !== withdrawals.lots[i]?.amountXBt)) {
    throw new Error('Withdrawal event / lot alignment changed');
  }
  for (const [name, payload] of Object.entries(payloads)) {
    await fsp.writeFile(path.join(OUT, name), JSON.stringify(payload, null, 1) + '\n');
  }
  // The same public, allowlisted aggregates are embedded for file:// use.
  // Browsers disallow fetching local JSON; do not ask users to disable CORS.
  const indexPath = path.join(ROOT, 'site', 'index.html');
  const html = await fsp.readFile(indexPath, 'utf8');
  const marker = /(<script id="site-data" type="application\/json">)[\s\S]*?(<\/script>)/;
  if (!marker.test(html)) throw new Error('index.html is missing the offline data marker');
  const embedded = JSON.stringify(payloads).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await fsp.writeFile(indexPath, html.replace(marker, (_match, before, after) => before + embedded + after));
  // Cache-bust the two assets. GitHub Pages serves them with a 10-minute
  // max-age, so without this a content change can sit invisible behind a stale
  // copy for minutes after a deploy.
  const assetHash = (file) => crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'site', file)))
    .digest('hex').slice(0, 10);
  let assetHtml = await fsp.readFile(indexPath, 'utf8');
  assetHtml = assetHtml.replace(/(href="styles\.css)(\?v=[0-9a-f]+)?(")/, `$1?v=${assetHash('styles.css')}$3`);
  assetHtml = assetHtml.replace(/(src="app\.js)(\?v=[0-9a-f]+)?(")/, `$1?v=${assetHash('app.js')}$3`);
  await fsp.writeFile(indexPath, assetHtml);

  const sizes = Object.keys(payloads).map((n) => `${n} ${(fs.statSync(path.join(OUT, n)).size / 1024).toFixed(1)}kB`);
  console.log('wrote site/data:\n  ' + sizes.join('\n  '));
}

main().catch((e) => { console.error(e); process.exit(1); });
