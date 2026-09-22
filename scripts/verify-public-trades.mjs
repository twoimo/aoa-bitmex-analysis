#!/usr/bin/env node
/**
 * External verification: match this repository's fills against BitMEX's public
 * trade archive.
 *
 * Everything else in this repository checks the disclosed files against each
 * other. That can confirm the record is internally consistent; it cannot confirm
 * that the fills happened. This script does the outside check: it downloads the
 * official daily trade archives for a sample of days and looks up our fills by
 * `trdMatchID`, then compares symbol, side, size and price.
 *
 * Method
 *   - Sample days deterministically: a fixed stride across the 1,096 days that
 *     have fills, so the sample is reproducible and not hand-picked.
 *   - One pass over the local execution CSVs collecting only those days.
 *   - For each day, stream the public archive (gzip) and test membership.
 *
 * BitMEX does not publish every execution type. Liquidation fills in particular
 * are absent from the archive, so an unmatched fill is not automatically a
 * problem; the script reports what the unmatched rows say about themselves, so
 * the claim can be assessed rather than assumed.
 *
 * Usage: node scripts/verify-public-trades.mjs [--count 20] [--days 2018-03-05,2021-05-19]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseCsv, num, EXEC_COL } from './lib/csv.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DATA_DIR = path.resolve(arg('--data', path.join(ROOT, '.work', 'data')));
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'results')));
const COUNT = Number(arg('--count', '20'));
const EXTRA = arg('--days', '2018-03-05,2021-05-19').split(',').map((s) => s.trim()).filter(Boolean);
const ARCHIVE = (yyyymmdd) => `https://s3-eu-west-1.amazonaws.com/public.bitmex.com/data/trade/${yyyymmdd}.csv.gz`;

const ymd = (day) => day.replace(/-/g, '');

// ---------------------------------------------------------------------------
// pass 1: collect our fills for the sample days only
// ---------------------------------------------------------------------------

async function collectLocal(days) {
  const want = new Set(days.map((d) => ymd(d)));
  const byDay = new Map();
  const allFiles = await fsp.readdir(DATA_DIR);
  const execFiles = allFiles.filter((f) => /^aoa-execution-.*\.csv$/.test(f)).sort();

  for (const f of execFiles) {
    await parseCsv(path.join(DATA_DIR, f), (r) => {
      if (r.length < 25) return;
      if (r[EXEC_COL.exectype] !== 'Trade') return;
      const ts = r[EXEC_COL.transacttime] || r[EXEC_COL.date];
      const key = ts.slice(0, 10).replace(/-/g, '');
      if (!want.has(key)) return;
      const id = r[EXEC_COL.trdmatchid];
      if (!id) return;
      if (!byDay.has(key)) byDay.set(key, new Map());
      byDay.get(key).set(id, {
        symbol: r[EXEC_COL.symbol],
        side: r[EXEC_COL.side],
        size: num(r[EXEC_COL.lastqty]),
        price: num(r[EXEC_COL.lastpx]),
        ts,
        text: (r[EXEC_COL.text] || '').trim().split('\n')[0],
        liquidity: r[EXEC_COL.liquidity],
      });
    });
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// pass 2: stream each public archive and look up our ids
// ---------------------------------------------------------------------------

async function checkDay(dayKey, ours) {
  const res = await fetch(ARCHIVE(dayKey), { redirect: 'follow' });
  if (!res.ok) return { day: dayKey, error: `HTTP ${res.status}`, archiveRows: 0, matched: 0 };

  const found = new Map();
  let archiveRows = 0;
  let buffer = '';

  const stream = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line || line.charCodeAt(0) === 116) continue; // skip header
      archiveRows += 1;
      // columns: timestamp,symbol,side,size,price,tickDirection,trdMatchID,...
      const parts = line.split(',');
      const id = parts[6];
      if (id && ours.has(id)) found.set(id, { symbol: parts[1], side: parts[2], size: Number(parts[3]), price: Number(parts[4]) });
    }
  }
  if (buffer) archiveRows += 1;

  let matched = 0;
  let fieldMismatch = 0;
  let sideRuleChecked = 0;
  let sideRuleViolations = 0;
  const unmatched = [];
  const mismatches = [];
  const sideViolations = [];
  for (const [id, local] of ours) {
    const remote = found.get(id);
    if (!remote) { unmatched.push({ id: id.slice(0, 8), ...local }); continue; }
    matched += 1;

    // The public archive records the TAKER's side. In our private export `side`
    // is our own side. So for a fill where we were the maker the two must be
    // opposite, and where we were the taker they must agree. That makes this
    // comparison an independent check of our liquidity classification too.
    const weWereMaker = local.liquidity === 'AddedLiquidity';
    const expectedRemoteSide = weWereMaker
      ? (local.side === 'Buy' ? 'Sell' : 'Buy')
      : local.side;
    sideRuleChecked += 1;
    if (remote.side !== expectedRemoteSide) {
      sideRuleViolations += 1;
      if (sideViolations.length < 10) sideViolations.push({ id: id.slice(0, 8), local, remote, expectedRemoteSide });
    }

    if (remote.symbol !== local.symbol
      || Math.abs(remote.size - local.size) > 1e-6
      || Math.abs(remote.price - local.price) > 1e-12 * Math.max(1, Math.abs(local.price))) {
      fieldMismatch += 1;
      if (mismatches.length < 10) mismatches.push({ id: id.slice(0, 8), local, remote });
    }
  }
  return { day: dayKey, archiveRows, ours: ours.size, matched, unmatched, fieldMismatch, mismatches, sideRuleChecked, sideRuleViolations, sideViolations };
}

// ---------------------------------------------------------------------------

async function main() {
  // deterministic sample: fixed stride across the days that have fills
  const allFiles = await fsp.readdir(DATA_DIR);
  const execFiles = allFiles.filter((f) => /^aoa-execution-.*\.csv$/.test(f)).sort();
  const activeDays = new Set();
  for (const f of execFiles) {
    await parseCsv(path.join(DATA_DIR, f), (r) => {
      if (r.length < 25 || r[EXEC_COL.exectype] !== 'Trade') return;
      const ts = r[EXEC_COL.transacttime] || r[EXEC_COL.date];
      activeDays.add(ts.slice(0, 10));
    });
  }
  const days = [...activeDays].sort();
  const stride = Math.max(1, Math.floor(days.length / COUNT));
  const sample = new Set();
  for (let i = 0; i < days.length; i += stride) sample.add(days[i]);
  for (const d of EXTRA) if (days.includes(d)) sample.add(d);
  const list = [...sample].sort();
  process.stderr.write(`[verify] ${days.length} active days, sampling ${list.length}\n`);

  const local = await collectLocal(list);
  const results = [];
  let tMatched = 0; let tOurs = 0; let tUnmatched = 0; let tFieldMismatch = 0;
  let tSideChecked = 0; let tSideViolations = 0;
  for (const d of list) {
    const ours = local.get(ymd(d));
    if (!ours || ours.size === 0) { results.push({ day: d, skipped: 'no local fills' }); continue; }
    process.stderr.write(`[verify] ${d}: ${ours.size} local fills…\n`);
    const r = await checkDay(ymd(d), ours);
    results.push(r);
    if (!r.error) {
      tOurs += r.ours ?? 0;
      tMatched += r.matched ?? 0;
      tUnmatched += (r.unmatched?.length ?? 0);
      tFieldMismatch += r.fieldMismatch ?? 0;
      tSideChecked += r.sideRuleChecked ?? 0;
      tSideViolations += r.sideRuleViolations ?? 0;
    }
  }

  const unmatchedReason = new Map();
  for (const r of results) for (const u of r.unmatched ?? []) {
    const k = u.text || '(no text)';
    unmatchedReason.set(k, (unmatchedReason.get(k) ?? 0) + 1);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'Fills from the disclosed export looked up by trdMatchID in BitMEX\'s official daily trade archive (s3-eu-west-1.amazonaws.com/public.bitmex.com/data/trade). Days sampled by a fixed stride across all days with fills, plus two named days, so the sample is reproducible rather than hand-picked.',
    source: 'https://public.bitmex.com/?prefix=data/trade/',
    days: list.length,
    localFillsChecked: tOurs,
    matched: tMatched,
    unmatched: tUnmatched,
    fieldMismatches: tFieldMismatch,
    matchRate: tOurs ? Number((tMatched / tOurs).toFixed(6)) : null,
    sideRule: 'The public archive records the taker side, so a maker fill of ours must appear with the opposite side and a taker fill with the same side. Checking this also validates our lastliquidityind classification.',
    sideRuleChecked: tSideChecked,
    sideRuleViolations: tSideViolations,
    unmatchedByLocalText: Object.fromEntries([...unmatchedReason].sort((a, b) => b[1] - a[1])),
    perDay: results.map((r) => ({
      day: r.day, archiveRows: r.archiveRows ?? null, localFills: r.ours ?? null,
      matched: r.matched ?? null, unmatched: r.unmatched?.length ?? null,
      fieldMismatches: r.fieldMismatch ?? null,
      sideRuleViolations: r.sideRuleViolations ?? null, error: r.error ?? null, skipped: r.skipped ?? null,
    })),
    unmatchedExamples: results.flatMap((r) => (r.unmatched ?? []).slice(0, 3)).slice(0, 20),
    fieldMismatchExamples: results.flatMap((r) => r.mismatches ?? []).slice(0, 10),
    sideRuleViolationExamples: results.flatMap((r) => r.sideViolations ?? []).slice(0, 10),
  };

  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(path.join(OUT_DIR, 'public-trade-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    days: report.days, localFillsChecked: report.localFillsChecked, matched: report.matched,
    unmatched: report.unmatched, fieldMismatches: report.fieldMismatches, matchRate: report.matchRate,
    sideRuleChecked: report.sideRuleChecked, sideRuleViolations: report.sideRuleViolations,
    unmatchedByLocalText: report.unmatchedByLocalText,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
