# External reviews

Two independent reviews of this dataset were produced on the day it was published. Neither is
part of this repository's own verification, and neither should be treated as authoritative on its
own. They are recorded here because they change what is still open, and because one of them
reports checks this repository does not perform.

---

## 1. ChatGPT 6 Pro, local-file review (2026-09-22)

Requested and received through the `codex-chatgpt-web` bridge, with shell access to this
repository so it read the CSVs itself. Full text: `docs/external-review-2026-09-22.md`.

What it established independently, and this repository then reproduced with `validate.mjs`:

| Check | Its finding | `validate.mjs` |
| --- | --- | --- |
| `execid` uniqueness | all unique | 0 duplicates of 1,444,583 |
| Order quantity | all 23,416 orders reconcile | 0 mismatches of 23,416 |
| Timestamp inversions | 4,320 | 4,320 |
| Funding rows vs position | 5,368 / 5,368 | 5,368 / 5,368 |
| Settlement rows zero the position | 8 / 8 | 8 / 8 |
| Liquidation rows | 59, of which 28 use the zero order id | same |
| Trade fee / funding components | 78.0001 / 149.5754 XBt | same |
| Ledger reconciliation | exact to the satoshi | difference 0 |

What it contributed that this repository did not have:

- The finding that `walletbalance` is unusable as a running balance, which is why **no
  time-weighted return is reported here**.
- The directive not to add funding and fees back onto ledger PnL (they are already inside it).
- Four concrete defects in this repository's code, all since fixed (cancelled-withdrawal flow
  double count, funding double count in the monthly table, fee grouping by quote instead of
  settlement currency, and reporting a flow-adjusted TWR that the data cannot support).
- Three further inconsistencies it flagged in the generated outputs, all since fixed at source:
  the zero-uuid order count, the maker/taker split by liquidity flag vs cash-flow sign, and 488
  negative holding periods that fell outside every histogram bucket.

What it explicitly did **not** do: verify the publisher, verify exchange issuance, or compare any
fill against public tick data.

---

## 2. Claude artifact "워뇨띠 원장 감사" (2026-09-22)

Published by the user as a Claude artifact: <https://claude.ai/artifact/T7fjEp4zvhLdSBGxeafuGr>.
It is machine-generated content that has not been reviewed here line by line. Its method section
states it rebuilt positions, realised PnL and equity from the 1.44M fills using an average-cost
method, and used Binance 1-minute candles for price context.

What it reports that goes beyond this repository:

| Claim | Status here |
| --- | --- |
| Matched 72,718 sampled fills against BitMEX's public tick archive by unique id; 72,717 match, and the one mismatch is a liquidation, a fill type BitMEX does not publish | **Reproduced and exceeded.** This repository matched 81,263 of 81,268 fills across 64 sampled days; all five misses are liquidations, and symbol/size/price matched on every hit. See `docs/public-trade-verification.md` |
| Funding rates matched against the BitMEX API, 5,368 / 5,368 | Not reproduced here |
| Fee-tier completeness test: from 2021-08-18 BitMEX set taker fees from 30-day ADV, and all 61 fee-charged days are consistent with the visible volume, bounding hidden volume at $9.1M and $15.7M | Not reproduced here |
| Selection-bias natural experiment: win-rate odds for trades that do not span a funding timestamp, holding time controlled, 0.93 (p=0.66) → no sign of deleting losers | Not reproduced here |
| Time-weighted return index from 2018-04: ~29,000x in BTC, ~196,000x in USD, with annual Sharpe 2.3–3.8 | Not reproduced here; this repository deliberately reports no TWR |
| Regime decomposition: intraday and overnight PnL split by the day's BTC move — down days +6.6%, up days −0.38%, overnight net position averaging −0.3x growing to −0.58x | Not reproduced here |
| Skill test: sign-flip Monte Carlo (5×10⁻⁶), entry-quality t=7.4 across 10,862 entries, direction-randomisation z=4.1 → concludes skill rather than luck | Not reproduced here |
| Four behavioural stages, leverage top-5% falling from 29.9x to 2–3x | Not reproduced here |

### What was spot-checked against this repository's data

Five of its checkable claims were recomputed here from the same files. Four agree closely:

| Its claim | Recomputed here | Agreement |
| --- | --- | --- |
| Forced liquidations: 2 in 2019–2020 | `text=Liquidation` rows: 1 in 2019-Q3, 1 in 2020-Q1 | exact |
| Stop orders essentially abandoned, 0.0% of 2021 losing exits | `ordtype` starting with `Stop`: 0 of 748,684 fills in 2021 (1.17% in 2018) | exact |
| Maker share rising from ~31% to ~81% | taker share of fills by year: 50.9% / 55.0% / 53.1% / **14.1%** → maker 85.9% in 2021 | same direction and scale |
| 2021-05-19 blowup, a −52% day | worst ledger day in the file is a −281.84 XBt loss with the balance falling 625.75 → 357.14 XBt on the same event; the date differs by one day because the ledger uses UTC dates | same event, same magnitude |
| Annual returns +6,369% / +1,253% / +330% / +680% (BTC) | realised PnL by year: +188.43 / +516.37 / +763.64 / +2,068.88 XBt | **not reconciled**: the percentage depends on its TWR method and flow treatment, which are not published in enough detail to reproduce |

That is a spot check, not an audit. Its strongest claims — the tick-archive match and the fee-tier
test — are the ones this repository cannot confirm without pulling BitMEX's public archives itself.

---

## What remains open after both reviews

1. **~~Public market-data comparison.~~ CLOSED.** This repository now matches fills against
   BitMEX's public trade archive itself; see `docs/public-trade-verification.md`. Coverage is a
   5.6% sample, so a full pass remains open.
2. **Publisher and account ownership remain unverified.**
3. **The two 2018 balance dates** (2018-04-27 and 2018-04-28) remain unexplained.
4. **The three repeated `trdmatchid` values** remain unexplained.
5. **Leverage, margin mode and true exposure** still cannot be recovered from fills alone, which
   is why the site reports a turnover ratio rather than leverage. The Claude audit's leverage
   figures use a reconstruction this repository has not reviewed.
