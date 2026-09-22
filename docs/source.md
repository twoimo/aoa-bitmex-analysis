# Data source

## Where the files came from

The archive was published publicly by the account holder on **2026-09-22** in the DCInside
차트 마이너 갤러리, post **5051684** ("거래내역 공개합니다."):

- Post: <https://gall.dcinside.com/mgallery/board/view/?id=chartanalysis&no=5051684>
- Drive link in the post: `https://drive.google.com/file/d/1XDwxbriz_kOq44iH-mHcjsYTBklMnMW3/view`
- Archive name: `aoa_public_2021-12-31_with_letter.zip` (108 MiB compressed, 602 MB unpacked)

Fetched on 2026-09-22. `scripts/fetch-data.mjs` reproduces the download.

## Files and hashes

`npm run validate` regenerates `manifest.json`. Current values:

| File | Bytes |
| --- | --- |
| `90일 서한.txt` | 8,798 |
| `aoa-execution-2018-03-01-2018-12-31.csv` | 67,993,490 |
| `aoa-execution-2019-01-01-2020-12-31.csv` | 219,076,835 |
| `aoa-execution-2021-01-01-2021-06-30.csv` | 191,784,153 |
| `aoa-execution-2021-07-01-2021-12-31.csv` | 122,612,445 |
| `aoa-wallet-2018-03-01-2021-12-31.csv` | 318,791 |
| `aoa_public_2021-12-31_with_letter.zip` | 113,381,570 |

SHA-256 of the archive as downloaded:

```
b6f1dc7aadf8209bf6c99fd516a06c0cabdc77c5f16f9fc8df92fdf1d8d01b9a
```

A hash only proves the copy you hold is the copy that was hashed. It says nothing about
who produced the file or whether the exchange issued it.

## What the discloser said about reuse

From the post body (translated):

> The trade identifiers, exact execution times, prices, and quantities needed for verification
> are left as they are. You can compare them against the official execution data BitMEX has
> published to check whether they match real market records. The wallet history is included so
> deposits, withdrawals, PnL and balance flows can be checked. The record contains every trade
> for the period, including losing ones. Wallet addresses, tx hashes and other personal
> information not required for verification were removed. You may use it for your own analysis
> or to build programs, but please avoid selling secondary products or trading bots built on
> this data. Uncompressed it is about 600 MB and 1.4 million rows.

From the accompanying letter (`90일 서한.txt`):

> I am not running any YouTube channel, referral scheme, paid signal room, or bot system.
> I am worried that someone will build a trading bot from this data and sell it. If a bot were
> actually profitable, I would already be running it myself. Please do not be fooled and do not
> buy one.

Two consequences for this repository:

1. **Do not treat the disclosure as a general reuse licence.** The permission given is
   "analyse it yourself", with an explicit request against commercial derivative products.
2. **Do not present past profitability as a reproducible strategy.** Nothing in the data
   identifies a rule set, and the discloser says there is not one worth selling.

## Scope limits

- The window ends 2021-12-31. There is no later data in the archive.
- One account (`aoa`) on one venue (BitMEX). Nothing here generalises to other venues,
  instruments, or periods.
- The disclosure post is the only source. The publisher's identity and the exchange's
  issuance were not independently verified.
