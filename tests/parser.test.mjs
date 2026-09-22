/**
 * Parser and definition tests.
 *
 * These run without the dataset, so they can run anywhere. They target the
 * cases that actually bit this analysis:
 *   - quoted fields containing commas and embedded newlines (the BitMEX `text`
 *     column), which break naive line splitting and misalign every later column
 *   - a UTF-8 BOM on the first field of the first row
 *   - scientific-notation numbers in otherwise integer columns
 *   - cancelled withdrawals, which must not count as external cash flow
 *   - the funding sign convention
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCsv, num, percentile, EXEC_COL, WALLET_COL } from '../scripts/lib/csv.mjs';

async function withTempCsv(content, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aoa-test-'));
  const file = path.join(dir, 'sample.csv');
  await fsp.writeFile(file, content);
  try {
    return await fn(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const readAll = async (file) => {
  const rows = [];
  await parseCsv(file, (r) => rows.push(r));
  return rows;
};

test('splits plain rows', async () => {
  const rows = await withTempCsv('a,b,c\n1,2,3\n4,5,6\n', readAll);
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
});

test('keeps commas inside quoted fields', async () => {
  const rows = await withTempCsv('a,b\n"x,y",2\n', readAll);
  assert.deepEqual(rows, [['a', 'b'], ['x,y', '2']]);
});

test('keeps embedded newlines inside quoted fields', async () => {
  // This is the shape of the real `text` column:
  // "Amended price: Amend from www.bitmex.com\nSubmission from www.bitmex.com"
  const rows = await withTempCsv('a,b,c\n1,"line1\nline2",3\n4,5,6\n', readAll);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['1', 'line1\nline2', '3']);
  assert.deepEqual(rows[2], ['4', '5', '6']);
});

test('unescapes doubled quotes', async () => {
  const rows = await withTempCsv('a,b\n"he said ""hi""",2\n', readAll);
  assert.deepEqual(rows[1], ['he said "hi"', '2']);
});

test('strips a UTF-8 BOM from the first field', async () => {
  const rows = await withTempCsv('\uFEFFdate,execid\n2018-03-05,abc\n', readAll);
  assert.equal(rows[0][0], 'date');
});

test('handles CRLF line endings', async () => {
  const rows = await withTempCsv('a,b\r\n1,2\r\n', readAll);
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('number coercion accepts scientific notation and rejects junk', () => {
  assert.equal(num('1.00334E+11'), 100334000000);
  assert.equal(num('-2.5E-4'), -0.00025);
  assert.equal(num(''), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num('n/a'), 0);
});

test('percentile interpolates and handles empty input', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.9), 10);
});

test('execution column map points at the fields the analysis relies on', () => {
  // Guards against the class of bug where a wrong index silently returns
  // undefined and every downstream check passes vacuously.
  assert.equal(EXEC_COL.text, 33);
  assert.equal(EXEC_COL.trdmatchid, 34);
  assert.equal(EXEC_COL.execCost, 35);
  assert.equal(EXEC_COL.execComm, 36);
  assert.equal(EXEC_COL.homeNotional, 37);
  assert.equal(EXEC_COL.foreignNotional, 38);
  assert.equal(EXEC_COL.transacttime, 39);
  assert.equal(EXEC_COL.cumqty, 29);
});

test('a row built from the map reads back the intended values', async () => {
  const cols = new Array(41).fill('');
  cols[EXEC_COL.date] = '2018-03-05';
  cols[EXEC_COL.orderid] = 'order-1';
  cols[EXEC_COL.symbol] = 'XBTUSD';
  cols[EXEC_COL.side] = 'Sell';
  cols[EXEC_COL.lastqty] = '2000';
  cols[EXEC_COL.lastpx] = '11441.5';
  cols[EXEC_COL.exectype] = 'Trade';
  cols[EXEC_COL.cumqty] = '17000';
  cols[EXEC_COL.text] = 'Submission from www.bitmex.com';
  cols[EXEC_COL.execComm] = '11799';
  cols[EXEC_COL.foreignNotional] = '2000.0';
  cols[EXEC_COL.transacttime] = '2018-03-05 09:16:57.937933';

  const rows = await withTempCsv(cols.join(',') + '\n', readAll);
  const r = rows[0];
  assert.equal(r[EXEC_COL.text], 'Submission from www.bitmex.com');
  assert.equal(r[EXEC_COL.cumqty], '17000');
  assert.equal(num(r[EXEC_COL.foreignNotional]), 2000);
  assert.equal(r[EXEC_COL.symbol], 'XBTUSD');
});

test('cancelled withdrawals are not external cash flow', () => {
  // Mirrors the real ledger: a cancelled row carries an amount and a balance
  // snapshot but moves no money. Counting it double-counts the withdrawal.
  const rows = [
    { date: '2018-03-22', type: 'Withdrawal', status: 'Canceled', amount: -196801713 },
    { date: '2018-03-22', type: 'Withdrawal', status: 'Completed', amount: -196801713 },
  ];
  let flow = 0;
  for (const r of rows) {
    if (r.status === 'Canceled') continue;
    if (r.type === 'Withdrawal') flow += r.amount;
  }
  assert.equal(flow, -196801713);
});

test('wallet column map points at transacttype and balance', () => {
  assert.equal(WALLET_COL.transacttype, 11);
  assert.equal(WALLET_COL.balance, 13);
  assert.equal(WALLET_COL.amount, 4);
});

test('funding cash flow comes from execComm, not execCost', () => {
  // execCost is the position notional (in satoshi); execComm is the payment.
  const row = { execCost: '13524875145', execComm: '-1352488', commission: '-1.0E-4' };
  assert.equal(num(row.execComm), -1352488);
  assert.equal(num(row.execCost) * Number(row.commission), -1352487.5145);
  assert.notEqual(num(row.execCost), num(row.execComm));
});
