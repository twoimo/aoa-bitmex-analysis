#!/usr/bin/env node
/**
 * Download the publicly disclosed BitMEX archive and unpack it.
 *
 * Google Drive serves files this large behind a "can't scan for viruses"
 * interstitial, so the flow is: request the file, parse the interstitial for
 * the confirm token, then request again with the token.
 *
 * The data lands in .work/data/ which is gitignored on purpose: the CSVs are
 * not redistributed with this repository. See docs/source.md.
 *
 * Usage: node scripts/fetch-data.mjs
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORK = path.join(ROOT, '.work');
const DATA = path.join(WORK, 'data');
const FILE_ID = '1XDwxbriz_kOq44iH-mHcjsYTBklMnMW3';
const ARCHIVE = path.join(WORK, 'aoa_public_2021-12-31_with_letter.zip');
const EXPECTED_SHA256 = 'b6f1dc7aadf8209bf6c99fd516a06c0cabdc77c5f16f9fc8df92fdf1d8d01b9a';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function download() {
  if (fs.existsSync(ARCHIVE)) {
    process.stderr.write(`[fetch] archive already present: ${ARCHIVE}\n`);
    return;
  }
  await fsp.mkdir(WORK, { recursive: true });

  const interstitial = await fetch(`https://drive.google.com/uc?export=download&id=${FILE_ID}`, {
    headers: { 'user-agent': UA },
    redirect: 'follow',
  });
  const html = await interstitial.text();
  const uuid = (html.match(/name="uuid" value="([^"]+)"/) || [])[1] ?? '';
  const at = (html.match(/name="at" value="([^"]+)"/) || [])[1] ?? '';

  const url = `https://drive.usercontent.google.com/download?id=${FILE_ID}&export=download&authuser=0&confirm=t`
    + (uuid ? `&uuid=${uuid}` : '') + (at ? `&at=${encodeURIComponent(at)}` : '');

  process.stderr.write('[fetch] downloading…\n');
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://drive.google.com/' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000 || buf.subarray(0, 2).toString() !== 'PK') {
    throw new Error(`unexpected payload (${buf.length} bytes, not a zip). Google may be asking for confirmation again; open the Drive link in a browser and download manually into ${ARCHIVE}.`);
  }
  await fsp.writeFile(ARCHIVE, buf);
  process.stderr.write(`[fetch] saved ${buf.length} bytes\n`);
}

async function unpack() {
  await fsp.mkdir(DATA, { recursive: true });
  // macOS tar (bsdtar) reads zip and handles the non-ASCII filename correctly;
  // GNU unzip needs -O CP949 for the same result.
  const tar = spawnSync('tar', ['-xf', ARCHIVE, '-C', DATA], { stdio: 'inherit' });
  if (tar.status === 0) return;
  const unzip = spawnSync('unzip', ['-o', '-q', ARCHIVE, '-d', DATA], { stdio: 'inherit' });
  if (unzip.status !== 0) throw new Error('could not unpack the archive with tar or unzip');
}

async function verify() {
  const crypto = await import('node:crypto');
  const h = crypto.createHash('sha256');
  const s = fs.createReadStream(ARCHIVE);
  await new Promise((resolve, reject) => {
    s.on('data', (d) => h.update(d));
    s.on('end', resolve);
    s.on('error', reject);
  });
  const digest = h.digest('hex');
  if (digest !== EXPECTED_SHA256) {
    process.stderr.write(`[fetch] WARNING sha256 mismatch\n  expected ${EXPECTED_SHA256}\n  actual   ${digest}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write('[fetch] sha256 matches the hash recorded in docs/source.md\n');
  }
}

await download();
await verify();
await unpack();
process.stderr.write(`[fetch] data in ${DATA}\n`);
