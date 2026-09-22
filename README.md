# aoa-bitmex-analysis

Independent, unofficial analysis of the 2018–2021 BitMEX export published under the
account name `aoa` on 2026-09-22.

> The files were disclosed publicly by their owner in the DCInside 차트 마이너 갤러리
> ([post 5051684](https://gall.dcinside.com/mgallery/board/view/?id=chartanalysis&no=5051684)).
> This repository checks the **internal consistency** of those files and describes what they
> contain. It does **not** verify exchange issuance, account ownership, or authenticity, and it
> is not affiliated with the account owner or with BitMEX.

## What is here

| Path | What it is |
| --- | --- |
| `scripts/fetch-data.mjs` | Downloads the published archive and unpacks it into `.work/data/` |
| `scripts/validate.mjs` | Full anomaly and duplicate audit → `results/validation.json`, `results/anomalies.csv`, `manifest.json` |
| `scripts/analyze.mjs` | Descriptive statistics → `results/summary.json`, `results/monthly.csv`, `results/daily-balance.csv`, `results/symbols.csv`, `REPORT.md` |
| `scripts/insights.mjs` | Trader-facing questions (attribution, hold time, exposure, withdrawal discipline, concentration) → `results/insights.json`, `results/symbol-attribution.csv`, `results/withdrawal-curve.csv`, `FINDINGS.md` |
| `scripts/stated-vs-measured.mjs` | Checks the account holder's own published numbers and principles against the ledger → `results/stated-vs-measured.json` |
| `scripts/withdrawals.mjs` | Day-level and event-level cash-flow detail, including the round-lot withdrawal ladder → `results/withdrawals.json`, `results/withdrawals-daily.csv`, `results/withdrawals-events.csv`, `results/withdrawals-cumulative.svg` |
| `scripts/lib/csv.mjs` | Streaming RFC4180 reader + column maps + shared helpers |
| `scripts/diagnose-wallet-balance.mjs` | Reproduces the wallet-balance semantics finding |
| `docs/source.md` | Where the data came from, hashes, and what the discloser said about reuse |
| `docs/methodology.md` | Units, sign conventions, contract classes, definitions, and known limits |
| `docs/validation.md` | Every check, its result, and the ones that are still open |
| `docs/external-audits.md` | Two independent reviews of the same dataset: what they add, and which of their claims were spot-checked here |
| `docs/stated-vs-measured.md` | What he said about his own trading, next to what the files show |
| `FINDINGS.md` | What the record suggests about trading well, with confidence levels |

The raw CSVs are **not** redistributed here. They are 602 MB unpacked, and the discloser's
letter asks people not to turn the data into paid products.

## Run it

```bash
npm run fetch     # download + unpack into .work/data/  (needs network)
npm run validate  # anomaly / duplicate audit
npm run analyze   # descriptive statistics
npm run insights  # trader-facing metrics
npm run stated    # his published claims vs the ledger
npm run withdrawals # day-level and per-withdrawal cash-flow detail
npm test          # parser and definition tests, no dataset required
```

Everything is plain Node ≥ 20 with no dependencies.

## Headline numbers

| | |
| --- | --- |
| Window | 2018-03-05 → 2021-12-24 (fills), ledger to 2021-12-31 |
| Fills / orders | 1,439,207 fills across 23,416 orders, 46 symbols |
| Deposits | 18 deposits, 14.48925714 XBt |
| Withdrawals | 56 completed withdrawals, −2,814.54321713 XBt |
| Ledger realised PnL | 3,537.32369404 XBt |
| Final ledger balance | 737.26973405 XBt |
| Ledger reconciliation | exact to the satoshi |
| Maker share | 67.16% of fills |
| Net trade fee | 78.00012971 XBt (302.31 rebate received, 380.31 paid) |
| Funding | 149.57544093 XBt received |

See `FINDINGS.md` for what these numbers imply and how much weight each claim can carry, and
`docs/stated-vs-measured.md` for the same figures next to what the account holder published
about them.

## Publication scope

This repository is public. What it deliberately does **not** contain:

- the raw export files (600 MB unpacked) or the archive they came from
- any execution, order or transaction identifier
- the full text of any post by the account holder

What it *does* contain, and why: the analysis code, the documentation, and derived aggregates
including day-level balances, activity and cash flow. Every figure in those aggregates is already
present in the source the account holder published himself in order to have his deposit,
withdrawal, PnL and balance flows checked, and nothing here adds a field he withheld. The raw
files stay out because they are large and because his letter asks that the data not be turned
into paid products, not because the aggregates would reveal anything new.

`README.md`, `FINDINGS.md` and `docs/*` are written to be read by someone who wants to disagree
with the conclusions.

## License

The code in this repository is MIT (`LICENSE`). The dataset, the author's letter, and any
quoted material are **not** covered by that license and remain the property of their
respective owners.

## Static site

`site/` is a self-contained static report: `index.html`, `styles.css`, `app.js` and
`site/data/*.json`. No framework, no build step, no external fonts or CDNs. It renders from
`file://` as well as over HTTP, and falls back to a labelled offline snapshot if the JSON cannot
be fetched.

```bash
npm run site                         # regenerate site/data from results/
python3 -m http.server -d site 8899  # then open http://127.0.0.1:8899
```

`site/.qa/verify.mjs` is a 38-check harness (charts, data fields, responsive widths, keyboard
navigation, table sorting, reduced motion, offline mode) and `site/.qa/verification.json` holds
its last result. Both are local-only, not part of the published site.

The site deliberately excludes the raw CSVs, every execution/order/transaction identifier, and
the day-by-day withdrawal ledger (`results/withdrawals-daily.csv`). Those stay in this
repository.
