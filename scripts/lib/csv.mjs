/**
 * Minimal streaming CSV reader for the BitMEX export files.
 *
 * The execution CSVs are ~600 MB combined and some rows contain quoted,
 * multi-line `text` fields, so this parses incrementally and never holds more
 * than one record in memory.
 */

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * Stream a CSV file, calling onRow(fields, lineNumber) for every record.
 * Fields are raw strings; no type coercion is performed here.
 */
export async function parseCsv(file, onRow) {
  const rs = fs.createReadStream(file, { highWaterMark: 1 << 22 });
  const dec = new StringDecoder('utf8');
  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 0;
  let first = true;

  const emit = () => {
    line += 1;
    const r = first ? [stripBom(row[0] ?? ''), ...row.slice(1)] : row;
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

export const num = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const SAT = 1e8; // satoshi per XBt

export const satToXbt = (s) => s / SAT;
export const round = (n, d = 8) => Number(n.toFixed(d));
export const monthOf = (ts) => ts.slice(0, 7);
export const dayOf = (ts) => ts.slice(0, 10);

/** BitMEX execution export column indexes (41 fields, no trailing newline issue). */
export const EXEC_COL = {
  date: 0, execid: 1, orderid: 2, account: 5, symbol: 6, side: 7, lastqty: 8,
  lastpx: 9, liquidity: 10, orderqty: 11, price: 12, currency: 17, settlcurrency: 18,
  exectype: 19, ordtype: 20, timeinforce: 21, ordstatus: 24,
  leavesqty: 28, cumqty: 29, avgpx: 30, commission: 31,
  text: 33, trdmatchid: 34, execCost: 35,
  execComm: 36, homeNotional: 37, foreignNotional: 38, transacttime: 39, timestamp: 40,
};

/** BitMEX wallet export column indexes (14 fields). */
export const WALLET_COL = {
  date: 0, transactid: 1, account: 2, currency: 3, amount: 4, status: 5,
  address: 6, network: 7, text: 8, timestamp: 9, transacttime: 10,
  transacttype: 11, tx: 12, balance: 13,
};

/** Percentile of an already-sorted numeric array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
