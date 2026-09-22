#!/usr/bin/env node
/**
 * Insight layer: what does this record actually say about how to trade well?
 *
 * scripts/analyze.mjs describes the record (volume, PnL, monthly table).
 * This script asks the questions a trader would ask:
 *
 *   1. Where did the money come from, and where did it go? (per-symbol attribution)
 *   2. How much risk was on at any time, and how did that change? (exposure / equity)
 *   3. How long were positions held, and in which direction? (FIFO round trips)
 *   4. Was profit taken out of the account, and when? (withdrawal discipline)
 *   5. What did fees and funding cost? (drag)
 *   6. Was the result consistent, or a few lucky months? (concentration, drawdowns)
 *   7. Did behaviour change after losses? (next-day exposure after win/loss days)
 *
 * Everything here is derived from the two public CSVs. Definitions that are
 * approximate are labelled as such in the output so a reader can disagree with
 * a specific number without having to distrust the whole report.
 *
 * Usage: node scripts/insights.mjs [--data DIR] [--out DIR]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCsv, num, SAT, satToXbt, round, dayOf, percentile,
  EXEC_COL, WALLET_COL,
} from './lib/csv.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DATA_DIR = path.resolve(arg('--data', path.join(ROOT, '.work', 'data')));
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'results')));

const KST_OFFSET_H = 9;
const kstDayCache = new Map();

/** BitMEX exports are UTC; the trader is Korean, so bucket by KST. */
function kstDay(ts) {
  const key = ts.slice(0, 13); // YYYY-MM-DDTHH
  let v = kstDayCache.get(key);
  if (v !== undefined) return v;
  const h = Number(ts.slice(11, 13));
  let d = ts.slice(0, 10);
  if (h + KST_OFFSET_H >= 24) {
    const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) + 86400000;
    d = new Date(t).toISOString().slice(0, 10);
  }
  kstDayCache.set(key, d);
  return d;
}

const kstHour = (ts) => (Number(ts.slice(11, 13)) + KST_OFFSET_H) % 24;

const dow = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0=Sun

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------

async function loadWallet(files) {
  const events = [];
  let seq = 0;
  for (const f of files) {
    await parseCsv(f, (r) => {
      if (r.length < 12) return;
      const type = r[WALLET_COL.transacttype];
      if (!type || type === 'transacttype') return;
      // The wallet export's `timestamp`/`transacttime` columns carry elapsed-time
      // strings (e.g. "57:26.3"), not wall-clock times. Only `date` is usable, so
      // same-day ordering falls back to file order via `seq`.
      const day = dayOf(r[WALLET_COL.date]);
      events.push({
        seq: seq += 1,
        day,
        type,
        status: r[WALLET_COL.status],
        symbol: r[WALLET_COL.address] || '',
        amount: num(r[WALLET_COL.amount]),
        balance: num(r[WALLET_COL.balance]),
      });
    });
  }
  events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.seq - b.seq));
  return events;
}

// ---------------------------------------------------------------------------
// executions
// ---------------------------------------------------------------------------

async function scanExecutions(files) {
  const symbols = new Map();
  const hourFills = new Array(24).fill(0);
  const hourNotional = new Array(24).fill(0);
  const dowFills = new Array(7).fill(0);
  const dowNotional = new Array(7).fill(0);
  const dayNotional = new Map();      // USD / USDT quote notional
  const dayXbtNotional = new Map();   // XBt-equivalent notional (inverse contracts)
  const fundingByDay = new Map();
  const feesByDay = new Map();
  const openLots = new Map(); // symbol -> [{t, remaining, dir}]
  const trips = []; // {symbol, dir, ms, notional, openT, closeT}
  let outOfOrder = 0;
  let makerRebateSatoshi = 0;
  let takerFeeSatoshi = 0;
  const dayFills = new Map();
  const dayOrders = new Map();
  const hourDow = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const hourDowNotional = Array.from({ length: 7 }, () => new Array(24).fill(0));

  const symbolRec = (s, ccy) => {
    if (!symbols.has(s)) {
      symbols.set(s, {
        symbol: s, currency: ccy, fills: 0, notional: 0, maker: 0, taker: 0,
        buy: 0, sell: 0, feesSatoshi: 0, firstTs: null, lastTs: null,
      });
    }
    return symbols.get(s);
  };

  // Fills are *nearly* time-ordered but not perfectly (~0.3% out of order), which
  // would otherwise produce negative holding periods. Buffer by UTC day, sort
  // inside the day, and flush whole days so memory stays bounded to a day or two.
  const pending = new Map();
  let maxDaySeen = '';

  const processFill = (f) => {
    const {
      ts, day, symbol, ccy, notional, dir, fee, liquidity, settlCurrency, xbtNotional, orderid,
    } = f;
    const rec = symbolRec(symbol, ccy);
    rec.fills += 1;
    rec.notional += notional;
    rec.feesSatoshi += fee;
    if (dir > 0) rec.buy += 1; else rec.sell += 1;
    if (liquidity === 'AddedLiquidity') rec.maker += 1;
    else if (liquidity === 'RemovedLiquidity') rec.taker += 1;
    if (!rec.firstTs || ts < rec.firstTs) rec.firstTs = ts;
    if (!rec.lastTs || ts > rec.lastTs) rec.lastTs = ts;

    const h = kstHour(ts);
    hourFills[h] += 1;
    hourNotional[h] += notional;
    const w = dow(day);
    dowFills[w] += 1;
    dowNotional[w] += notional;
    hourDow[w][h] += 1;
    hourDowNotional[w][h] += notional;
    dayFills.set(day, (dayFills.get(day) ?? 0) + 1);
    if (!dayOrders.has(day)) dayOrders.set(day, new Set());
    if (f.orderid) dayOrders.get(day).add(f.orderid);
    dayNotional.set(day, (dayNotional.get(day) ?? 0) + notional);
    feesByDay.set(day, (feesByDay.get(day) ?? 0) + fee);
    if (fee !== 0) {
      if (liquidity === 'AddedLiquidity') makerRebateSatoshi -= fee;
      else if (liquidity === 'RemovedLiquidity') takerFeeSatoshi += fee;
    }
    // XBt-equivalent notional is only well defined for inverse contracts quoted
    // in USD (XBTUSD, ETHUSD, XRPUSD, LTCUSD, BCHUSD), where homeNotional is
    // denominated in XBt. For quanto altcoin futures homeNotional is denominated
    // in the base coin (TRX, ADA, ...), so those rows are excluded rather than
    // summed as if they were XBt. This keeps ~94% of fills.
    if (ccy === 'USD' && settlCurrency === 'XBt' && xbtNotional > 0) {
      dayXbtNotional.set(day, (dayXbtNotional.get(day) ?? 0) + xbtNotional);
    }

    // FIFO round-trip reconstruction.
    // Caveat: queue matching on fills, not an exchange-reported position
    // lifetime. Durations describe "time between opening and closing exposure".
    let q = notional;
    let lots = openLots.get(symbol);
    if (!lots) { lots = []; openLots.set(symbol, lots); }
    while (q > 1e-9 && lots.length && lots[0].dir !== dir) {
      const lot = lots[0];
      const take = Math.min(q, lot.remaining);
      trips.push({ symbol, dir: lot.dir, openT: lot.t, closeT: ts, notional: take });
      lot.remaining -= take;
      q -= take;
      if (lot.remaining <= 1e-9) lots.shift();
    }
    if (q > 1e-9) lots.push({ t: ts, remaining: q, dir });
  };

  const flushUpTo = (day) => {
    for (const key of [...pending.keys()].sort()) {
      if (key >= day) break;
      const arr = pending.get(key);
      arr.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      for (const f of arr) processFill(f);
      pending.delete(key);
    }
  };

  for (const file of files) {
    await parseCsv(file, (r) => {
      if (r.length < 25) return;
      const type = r[EXEC_COL.exectype];
      if (!type || type === 'exectype') return;
      const ts = r[EXEC_COL.transacttime] || r[EXEC_COL.date];
      const day = kstDay(ts);

      if (type === 'Funding') {
        const pay = num(r[EXEC_COL.execComm]);
        fundingByDay.set(day, (fundingByDay.get(day) ?? 0) + pay);
        return;
      }
      if (type !== 'Trade') return;

      const utcDay = ts.slice(0, 10);
      const rec = {
        ts,
        day,
        symbol: r[EXEC_COL.symbol] || '?',
        ccy: r[EXEC_COL.currency] || '?',
        settlCurrency: r[EXEC_COL.settlcurrency] || '',
        notional: Math.abs(num(r[EXEC_COL.foreignNotional])),
        xbtNotional: Math.abs(num(r[EXEC_COL.homeNotional])),
        orderid: r[EXEC_COL.orderid] || '',
        dir: r[EXEC_COL.side] === 'Buy' ? 1 : -1,
        fee: Math.abs(num(r[EXEC_COL.execComm])),
        liquidity: r[EXEC_COL.liquidity],
      };
      if (!pending.has(utcDay)) pending.set(utcDay, []);
      pending.get(utcDay).push(rec);
      if (utcDay > maxDaySeen) {
        maxDaySeen = utcDay;
        flushUpTo(utcDay);
      }
    });
  }
  flushUpTo('9999-99-99');

  return {
    symbols, hourFills, hourNotional, dowFills, dowNotional, dayNotional,
    dayXbtNotional, fundingByDay, feesByDay, trips, openLots, outOfOrder,
    makerRebateSatoshi, takerFeeSatoshi, dayFills, dayOrders, hourDow, hourDowNotional,
  };
}

// ---------------------------------------------------------------------------
// derived insight blocks
// ---------------------------------------------------------------------------

function equitySeries(walletEvents) {
  const byDay = new Map();
  for (const e of walletEvents) {
    const d = byDay.get(e.day) ?? { day: e.day, close: 0, flow: 0, realised: 0 };
    if (e.status !== 'Canceled') {
      if (e.type === 'Deposit' || e.type === 'Withdrawal') d.flow += e.amount;
      if (e.type === 'RealisedPNL') d.realised += e.amount;
      d.close = e.balance;
    }
    byDay.set(e.day, d);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

function drawdowns(series, top = 5) {
  const out = [];
  let peak = series[0]?.close ?? 0;
  let peakDay = series[0]?.day ?? null;
  let cur = null;
  for (const d of series) {
    if (d.close > peak) {
      if (cur) { cur.recoveredDay = d.day; cur = null; }
      peak = d.close;
      peakDay = d.day;
    } else if (peak > 0) {
      const dd = (peak - d.close) / peak;
      if (!cur) cur = { peak, peakDay, trough: d.close, troughDay: d.day, dd };
      else if (dd > cur.dd) { cur.trough = d.close; cur.troughDay = d.day; cur.dd = dd; }
    }
  }
  if (cur) out.push(cur);
  // also collect non-contiguous drawdowns by re-scanning episodes
  const episodes = [];
  let p = series[0]?.close ?? 0;
  let pDay = series[0]?.day ?? null;
  let curEp = null;
  for (const d of series) {
    if (d.close >= p) {
      if (curEp) { episodes.push(curEp); curEp = null; }
      p = d.close; pDay = d.day;
    } else {
      const dd = (p - d.close) / p;
      if (!curEp) curEp = { peak: p, peakDay: pDay, trough: d.close, troughDay: d.day, dd, recoveredDay: null };
      else if (dd > curEp.dd) { curEp.trough = d.close; curEp.troughDay = d.day; curEp.dd = dd; }
    }
  }
  if (curEp) episodes.push(curEp);
  episodes.sort((a, b) => b.dd - a.dd);
  return episodes.slice(0, top);
}

function monthlyTable(walletEvents, dayNotional, dayFees, fundingByDay) {
  const m = new Map();
  const get = (k) => {
    if (!m.has(k)) m.set(k, { month: k, realised: 0, deposits: 0, withdrawals: 0, funding: 0, fees: 0, notional: 0, closes: 0, wins: 0, losses: 0, endBalance: 0 });
    return m.get(k);
  };
  for (const e of walletEvents) {
    const k = e.day.slice(0, 7);
    const r = get(k);
    if (e.status === 'Canceled') continue;
    if (e.type === 'RealisedPNL') {
      r.realised += e.amount; r.closes += 1;
      if (e.amount > 0) r.wins += 1; else if (e.amount < 0) r.losses += 1;
    } else if (e.type === 'Deposit') r.deposits += e.amount;
    else if (e.type === 'Withdrawal') r.withdrawals += e.amount;
    r.endBalance = e.balance;
  }
  for (const [day, v] of dayNotional) get(day.slice(0, 7)).notional += v;
  for (const [day, v] of dayFees) get(day.slice(0, 7)).fees += v;
  for (const [day, v] of fundingByDay) get(day.slice(0, 7)).funding += v;
  return [...m.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const all = await fsp.readdir(DATA_DIR);
  const execFiles = all.filter((f) => /^aoa-execution-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
  const walletFiles = all.filter((f) => /^aoa-wallet-.*\.csv$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));

  const t0 = Date.now();
  const wallet = await loadWallet(walletFiles);
  process.stderr.write(`[insights] wallet events: ${wallet.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  const exec = await scanExecutions(execFiles);
  process.stderr.write(`[insights] round trips: ${exec.trips.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

  const series = equitySeries(wallet);
  const equityByDay = new Map(series.map((d) => [d.day, d.close]));

  // --- 1. symbol attribution (ledger, authoritative) -----------------------
  const symAttr = new Map();
  for (const e of wallet) {
    if (e.type !== 'RealisedPNL' || e.status === 'Canceled') continue;
    const s = e.symbol || '(unlabelled)';
    if (!symAttr.has(s)) symAttr.set(s, { symbol: s, closes: 0, pnl: 0, wins: 0, losses: 0, best: -Infinity, worst: Infinity });
    const r = symAttr.get(s);
    r.closes += 1; r.pnl += e.amount;
    if (e.amount > 0) r.wins += 1; else if (e.amount < 0) r.losses += 1;
    r.best = Math.max(r.best, e.amount);
    r.worst = Math.min(r.worst, e.amount);
  }
  const totalPnl = [...symAttr.values()].reduce((a, r) => a + r.pnl, 0);
  const symbolAttribution = [...symAttr.values()]
    .map((r) => ({
      symbol: r.symbol,
      closes: r.closes,
      pnlXBt: round(satToXbt(r.pnl), 4),
      shareOfPnl: round(r.pnl / totalPnl, 4),
      winRate: r.wins + r.losses ? round(r.wins / (r.wins + r.losses), 4) : null,
      bestXBt: round(satToXbt(r.best), 4),
      worstXBt: round(satToXbt(r.worst), 4),
    }))
    .sort((a, b) => b.pnlXBt - a.pnlXBt);

  // --- 2. exposure vs equity ----------------------------------------------
  const exposure = [];
  let exposureExcludedLowEquityDays = 0;
  for (const d of series) {
    // XBt-equivalent notional, not USD: the equity series is denominated in XBt,
    // so mixing a USD numerator with an XBt denominator produces a meaningless
    // ratio (an earlier revision did exactly that).
    // Days where equity is a fraction of a coin are excluded: dividing by them
    // produces ratios in the millions that describe nothing.
    const notional = exec.dayXbtNotional.get(d.day) ?? 0;
    const eq = d.close / SAT;
    if (notional <= 0) continue;
    if (eq < 1) { exposureExcludedLowEquityDays += 1; continue; }
    exposure.push({ day: d.day, notional, equity: eq, ratio: notional / eq });
  }
  const ratios = exposure.map((e) => e.ratio).sort((a, b) => a - b);

  // --- 3. round trips ------------------------------------------------------
  const tripsWithMs = exec.trips.map((t) => ({
    ...t,
    ms: Date.parse(`${t.closeT.replace(' ', 'T')}Z`) - Date.parse(`${t.openT.replace(' ', 'T')}Z`),
  }));
  const durationsMs = tripsWithMs.map((t) => t.ms).sort((a, b) => a - b);
  const msToStr = (ms) => {
    if (ms == null) return null;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  };
  const dirStats = { long: { trips: 0, notional: 0, ms: [] }, short: { trips: 0, notional: 0, ms: [] } };
  for (const t of tripsWithMs) {
    const k = t.dir > 0 ? 'long' : 'short';
    dirStats[k].trips += 1;
    dirStats[k].notional += t.notional;
    dirStats[k].ms.push(t.ms);
  }
  const bySymbolTrips = new Map();
  for (const t of tripsWithMs) {
    if (!bySymbolTrips.has(t.symbol)) bySymbolTrips.set(t.symbol, []);
    bySymbolTrips.get(t.symbol).push(t.ms);
  }
  const holdBySymbol = [...bySymbolTrips.entries()]
    .map(([symbol, ms]) => {
      ms.sort((a, b) => a - b);
      return {
        symbol,
        trips: ms.length,
        medianHold: msToStr(percentile(ms, 0.5)),
        p10: msToStr(percentile(ms, 0.1)),
        p90: msToStr(percentile(ms, 0.9)),
      };
    })
    .sort((a, b) => b.trips - a.trips);

  // --- 4. withdrawal discipline -------------------------------------------
  const withdrawals = wallet.filter((e) => e.type === 'Withdrawal' && e.status !== 'Canceled');
  const deposits = wallet.filter((e) => e.type === 'Deposit' && e.status !== 'Canceled');
  const totalWithdrawn = withdrawals.reduce((a, e) => a + e.amount, 0);
  const totalDeposited = deposits.reduce((a, e) => a + e.amount, 0);
  const realisedTotal = wallet.filter((e) => e.type === 'RealisedPNL' && e.status !== 'Canceled').reduce((a, e) => a + e.amount, 0);

  // cumulative curve: how much of running profit had been moved off-exchange
  const wd = [...wallet].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.seq - b.seq));
  let cumPnl = 0; let cumOut = 0; let cumIn = 0;
  const curve = [];
  for (const e of wd) {
    if (e.status === 'Canceled') continue;
    if (e.type === 'RealisedPNL') cumPnl += e.amount;
    if (e.type === 'Withdrawal') cumOut += e.amount;
    if (e.type === 'Deposit') cumIn += e.amount;
    if (e.type === 'Withdrawal' || e.day.endsWith('-01')) {
      curve.push({ day: e.day, cumPnl: cumPnl / SAT, cumOut: -cumOut / SAT, cumIn: cumIn / SAT, balance: e.balance / SAT });
    }
  }
  // withdrawal timing vs local equity peaks
  const peakDays = new Set(drawdowns(series, 1000).map((d) => d.peakDay));
  const withdrawalsNearPeak = withdrawals.filter((e) => {
    for (let i = -5; i <= 5; i += 1) {
      const d = new Date(`${e.day}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      if (peakDays.has(d.toISOString().slice(0, 10))) return true;
    }
    return false;
  }).length;

  // --- 5. fee / funding drag ----------------------------------------------
  const feesSatoshi = [...exec.feesByDay.values()].reduce((a, b) => a + b, 0);
  const fundingSatoshi = [...exec.fundingByDay.values()].reduce((a, b) => a + b, 0);
  const makerRebateSatoshi = exec.makerRebateSatoshi;
  const takerFeeSatoshi = exec.takerFeeSatoshi;

  // --- 6. concentration ----------------------------------------------------
  const closes = wallet.filter((e) => e.type === 'RealisedPNL' && e.status !== 'Canceled')
    .map((e) => e.amount).sort((a, b) => b - a);
  const grossProfit = closes.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const top1pct = closes.slice(0, Math.max(1, Math.round(closes.length * 0.01))).reduce((a, b) => a + b, 0);
  const top5pct = closes.slice(0, Math.max(1, Math.round(closes.length * 0.05))).reduce((a, b) => a + b, 0);
  const top10 = closes.slice(0, 10).reduce((a, b) => a + b, 0);

  // --- 7. behaviour after win/loss days ------------------------------------
  const dailyPnl = new Map();
  for (const e of wallet) {
    if (e.type !== 'RealisedPNL' || e.status === 'Canceled') continue;
    dailyPnl.set(e.day, (dailyPnl.get(e.day) ?? 0) + e.amount);
  }
  const after = { win: [], loss: [] };
  const daysSorted = [...dailyPnl.keys()].sort();
  for (const d of daysSorted) {
    const next = new Date(`${d}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const nd = next.toISOString().slice(0, 10);
    const nNotional = exec.dayXbtNotional.get(nd);
    const nEq = equityByDay.get(d);
    if (!nNotional || !nEq) continue;
    const v = dailyPnl.get(d);
    if (v > 0) after.win.push(nNotional / (nEq / SAT));
    else if (v < 0) after.loss.push(nNotional / (nEq / SAT));
  }

  const monthly = monthlyTable(wallet, exec.dayNotional, exec.feesByDay, exec.fundingByDay);

  // Hold-time histogram with log-ish buckets: the distribution is extremely
  // right-skewed, so linear buckets would put almost everything in the first bin.
  const HOLD_BUCKETS = [
    ['<1m', 0, 60e3], ['1-5m', 60e3, 300e3], ['5-30m', 300e3, 1800e3],
    ['30m-2h', 1800e3, 7200e3], ['2-6h', 7200e3, 21600e3], ['6-24h', 21600e3, 86400e3],
    ['1-3d', 86400e3, 259200e3], ['3-7d', 259200e3, 604800e3], ['7-30d', 604800e3, 2592000e3],
    ['>30d', 2592000e3, Infinity],
  ];
  const holdHistogram = HOLD_BUCKETS.map(([label, lo, hi]) => ({
    label,
    trips: durationsMs.filter((m) => m >= lo && m < hi).length,
  }));

  // Daily activity: answers "when did he trade" directly, and drives the
  // calendar heatmap on the site.
  const activityDays = [...exec.dayFills.keys()].sort();
  const dailyActivity = activityDays.map((day) => ({
    day,
    fills: exec.dayFills.get(day) ?? 0,
    orders: exec.dayOrders.get(day)?.size ?? 0,
    notionalXbt: round(exec.dayXbtNotional.get(day) ?? 0, 4),
    notionalUsd: round(exec.dayNotional.get(day) ?? 0, 2),
    realisedXBt: round(satToXbt(dailyPnl.get(day) ?? 0), 8),
    fundingXBt: round(satToXbt(exec.fundingByDay.get(day) ?? 0), 8),
  }));
  const fillsPerDay = activityDays.map((d) => exec.dayFills.get(d)).sort((a, b) => a - b);

  // Two different drawdown questions, kept apart on purpose:
  //  - balance-based: what the wallet column shows (contaminated by withdrawals
  //    and by the column being a rounded day-level snapshot)
  //  - PnL-index-based: high-water mark of cumulative ledger profit, the closest
  //    thing to a strategy drawdown this ledger supports
  const cumPnlSeries = [];
  {
    let cum = 0;
    for (const d of series) {
      cum += dailyPnl.get(d.day) ?? 0;
      cumPnlSeries.push({ day: d.day, close: cum });
    }
  }
  const ddPnl = drawdowns(cumPnlSeries, 5);
  const ddPnlAbsolute = [...drawdowns(cumPnlSeries, 1000)]
    .sort((a, b) => (b.peak - b.trough) - (a.peak - a.trough))
    .slice(0, 5);
  const dd = drawdowns(series, 5);

  const insights = {
    generatedAt: new Date().toISOString(),
    definitions: {
      holdingPeriod: 'FIFO queue matching of fills; time between opening and closing exposure, not an exchange-reported position lifetime.',
      exposureRatio: 'daily traded notional (sum of |foreignNotional|) divided by that day\'s closing wallet equity.',
      winRate: 'share of profitable RealisedPNL ledger entries (position-close events), not orders.',
      kst: 'execution timestamps are UTC; day/hour buckets are KST (UTC+9).',
    },
    headline: {
      firstFill: exec.symbols.size ? [...exec.symbols.values()].map((s) => s.firstTs).sort()[0] : null,
      lastFill: [...exec.symbols.values()].map((s) => s.lastTs).sort().slice(-1)[0],
      fills: [...exec.symbols.values()].reduce((a, s) => a + s.fills, 0),
      roundTrips: tripsWithMs.length,
      finalEquityXBt: round(series[series.length - 1].close / SAT, 4),
      realisedPnlXBt: round(satToXbt(realisedTotal), 4),
      depositedXBt: round(satToXbt(totalDeposited), 4),
      withdrawnXBt: round(satToXbt(totalWithdrawn), 4),
      withdrawnShareOfProfit: round(-totalWithdrawn / realisedTotal, 4),
      feesXBt: round(satToXbt(feesSatoshi), 8),
      feesNote: 'gross of rebates: |maker rebate| + taker fee',
      netTradeFeeXBt: round(satToXbt(makerRebateSatoshi + takerFeeSatoshi), 8),
      fundingXBt: round(satToXbt(fundingSatoshi), 8),
      fundingNote: 'negative execComm on funding rows means the account received it',
      fundingReceivedXBt: round(satToXbt(-fundingSatoshi), 8),
      netFeePlusFundingXBt: round(satToXbt(makerRebateSatoshi + takerFeeSatoshi + fundingSatoshi), 8),
      netFeePlusFundingShareOfProfit: round(satToXbt(makerRebateSatoshi + takerFeeSatoshi + fundingSatoshi) / satToXbt(realisedTotal), 4),
      maxDrawdownPct: round((ddPnl[0]?.dd ?? 0), 4),
      maxDrawdownXBt: round((ddPnl[0] ? (ddPnl[0].peak - ddPnl[0].trough) / SAT : 0), 4),
      maxDrawdownByAbsoluteXBt: ddPnlAbsolute[0]
        ? {
          dropXBt: round((ddPnlAbsolute[0].peak - ddPnlAbsolute[0].trough) / SAT, 4),
          pct: round(ddPnlAbsolute[0].dd, 4),
          peakDay: ddPnlAbsolute[0].peakDay,
          troughDay: ddPnlAbsolute[0].troughDay,
        }
        : null,
      maxDrawdownBasis: 'cumulative ledger profit high-water mark',
      maxDrawdownPeakDay: ddPnl[0]?.peakDay ?? null,
      maxDrawdownTroughDay: ddPnl[0]?.troughDay ?? null,
      balanceColumnMaxDrawdownPct: round(dd[0]?.dd ?? 0, 4),
      balanceColumnMaxDrawdownNote: 'wallet-balance drawdown; includes withdrawals and a rounded day-level balance column, so it overstates strategy drawdown',
      makerShare: round(
        [...exec.symbols.values()].reduce((a, s) => a + s.maker, 0) /
        [...exec.symbols.values()].reduce((a, s) => a + s.fills, 0), 4),
    },
    symbolAttribution,
    exposure: {
      days: exposure.length,
      excludedDaysWithEquityUnder1Xbt: exposureExcludedLowEquityDays,
      unit: 'XBt-equivalent traded notional per day divided by that day\'s closing wallet equity',
      median: round(percentile(ratios, 0.5), 3),
      p90: round(percentile(ratios, 0.9), 3),
      p99: round(percentile(ratios, 0.99), 3),
      max: round(ratios[ratios.length - 1], 3),
      maxDay: exposure.find((e) => e.ratio === ratios[ratios.length - 1])?.day ?? null,
    },
    holdingPeriod: {
      trips: tripsWithMs.length,
      median: msToStr(percentile(durationsMs, 0.5)),
      p10: msToStr(percentile(durationsMs, 0.1)),
      p25: msToStr(percentile(durationsMs, 0.25)),
      p75: msToStr(percentile(durationsMs, 0.75)),
      p90: msToStr(percentile(durationsMs, 0.9)),
      shareUnder1h: round(durationsMs.filter((m) => m < 3600e3).length / durationsMs.length, 4),
      shareUnder1d: round(durationsMs.filter((m) => m < 86400e3).length / durationsMs.length, 4),
      long: {
        trips: dirStats.long.trips,
        notionalUsd: round(dirStats.long.notional, 0),
        median: msToStr(percentile(dirStats.long.ms.sort((a, b) => a - b), 0.5)),
      },
      short: {
        trips: dirStats.short.trips,
        notionalUsd: round(dirStats.short.notional, 0),
        median: msToStr(percentile(dirStats.short.ms.sort((a, b) => a - b), 0.5)),
      },
      bySymbol: holdBySymbol.slice(0, 10),
      histogram: holdHistogram,
    },
    withdrawalDiscipline: {
      withdrawals: withdrawals.length,
      deposits: deposits.length,
      totalWithdrawnXBt: round(satToXbt(totalWithdrawn), 4),
      totalDepositedXBt: round(satToXbt(totalDeposited), 4),
      withdrawalShareOfRealised: round(-totalWithdrawn / realisedTotal, 4),
      withdrawalsWithin5DaysOfAnEquityPeak: withdrawalsNearPeak,
      peakDaysDetected: peakDays.size,
      curve,
    },
    concentration: {
      closes: closes.length,
      top10Share: round(top10 / grossProfit, 4),
      top1pctShare: round(top1pct / grossProfit, 4),
      top5pctShare: round(top5pct / grossProfit, 4),
      grossProfitXBt: round(satToXbt(grossProfit), 4),
    },
    behaviour: {
      daysAfterWin: after.win.length,
      medianExposureRatioAfterWin: round(percentile(after.win.sort((a, b) => a - b), 0.5), 3),
      daysAfterLoss: after.loss.length,
      medianExposureRatioAfterLoss: round(percentile(after.loss.sort((a, b) => a - b), 0.5), 3),
    },
    timing: {
      hourFillsKST: exec.hourFills,
      hourNotionalKST: exec.hourNotional.map((v) => round(v, 0)),
      dowFills: exec.dowFills,
      dowNotional: exec.dowNotional.map((v) => round(v, 0)),
      hourDow: exec.hourDow,
      hourDowNotional: exec.hourDowNotional.map((row) => row.map((v) => round(v, 0))),
      dowLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    },
    activity: {
      tradingDays: activityDays.length,
      firstDay: activityDays[0] ?? null,
      lastDay: activityDays[activityDays.length - 1] ?? null,
      medianFillsPerActiveDay: Math.round(percentile(fillsPerDay, 0.5)),
      p90FillsPerActiveDay: Math.round(percentile(fillsPerDay, 0.9)),
      maxFillsPerActiveDay: fillsPerDay[fillsPerDay.length - 1],
    },
    drawdowns: ddPnl.map((d) => ({
      drawdownPct: round(d.dd, 4),
      basis: 'cumulative ledger profit',
      peakXBt: round(d.peak / SAT, 4),
      troughXBt: round(d.trough / SAT, 4),
      peakDay: d.peakDay,
      troughDay: d.troughDay,
      recoveredDay: d.recoveredDay,
    })),
    drawdownsOnWalletBalance: dd.map((d) => ({
      drawdownPct: round(d.dd, 4),
      basis: 'wallet balance column (includes withdrawals; rounded day-level snapshot)',
      peakDay: d.peakDay,
      troughDay: d.troughDay,
    })),
    monthly: monthly.map((m) => ({
      month: m.month,
      closes: m.closes,
      winRate: m.wins + m.losses ? round(m.wins / (m.wins + m.losses), 3) : null,
      realisedXBt: round(satToXbt(m.realised), 4),
      fundingXBt: round(satToXbt(m.funding), 4),
      feesXBt: round(satToXbt(m.fees), 4),
      notionalUsd: round(m.notional, 0),
      depositsXBt: round(satToXbt(m.deposits), 4),
      withdrawalsXBt: round(satToXbt(m.withdrawals), 4),
      endBalanceXBt: round(m.endBalance / SAT, 4),
    })),
  };

  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(path.join(OUT_DIR, 'insights.json'), JSON.stringify(insights, null, 2) + '\n');

  await fsp.writeFile(
    path.join(OUT_DIR, 'daily-activity.csv'),
    'date,fills,orders,notional_xbt,notional_usd,realised_xbt,funding_xbt\n'
      + dailyActivity.map((d) => [d.day, d.fills, d.orders, d.notionalXbt, d.notionalUsd, d.realisedXBt, d.fundingXBt].join(',')).join('\n') + '\n',
  );

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  await fsp.writeFile(
    path.join(OUT_DIR, 'symbol-attribution.csv'),
    'symbol,closes,pnl_xbt,share_of_pnl,win_rate,best_xbt,worst_xbt\n' +
      symbolAttribution.map((s) => [s.symbol, s.closes, s.pnlXBt, s.shareOfPnl, s.winRate, s.bestXBt, s.worstXBt].join(',')).join('\n') + '\n',
  );
  await fsp.writeFile(
    path.join(OUT_DIR, 'withdrawal-curve.csv'),
    'day,cum_realised_xbt,cum_withdrawn_xbt,cum_deposited_xbt,balance_xbt\n' +
      curve.map((c) => [c.day, c.cumPnl.toFixed(4), c.cumOut.toFixed(4), c.cumIn.toFixed(4), c.balance.toFixed(4)].join(',')).join('\n') + '\n',
  );

  console.log(JSON.stringify({
    headline: insights.headline,
    exposure: insights.exposure,
    holdingPeriod: { median: insights.holdingPeriod.median, p10: insights.holdingPeriod.p10, p90: insights.holdingPeriod.p90, shareUnder1h: insights.holdingPeriod.shareUnder1h, long: insights.holdingPeriod.long, short: insights.holdingPeriod.short },
    withdrawalDiscipline: { ...insights.withdrawalDiscipline, curve: undefined },
    concentration: insights.concentration,
    behaviour: insights.behaviour,
    drawdowns: insights.drawdowns,
    topSymbols: symbolAttribution.slice(0, 6),
    worstSymbols: symbolAttribution.slice(-5),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
