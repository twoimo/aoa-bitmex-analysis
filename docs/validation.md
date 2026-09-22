# Validation results

Regenerate with `npm run validate`. Raw output: `results/validation.json`,
`results/anomalies.csv`, `manifest.json`.

**"Consistent" below means internally consistent. It does not mean the exchange issued these
files or that any particular person owns the account.**

## Summary

| Check | Result | Reading |
| --- | --- | --- |
| Field counts | every row 41 columns (executions), 14 (wallet) | the multi-line quoted `text` field is parsed correctly; no malformed rows |
| Blank rows | 0 in executions, 2,135 in the wallet file | wallet padding only |
| `execid` uniqueness | 1,444,583 unique, 0 duplicates | — |
| `trdmatchid` uniqueness (Trade rows) | 1,439,204 unique of 1,439,207 → **3 repeats** | single repeated rows, not obvious maker/taker pairs; harmless for totals, needs market-side comparison to interpret |
| Order quantity | **0 mismatches across 23,416 orders** (`sum(lastqty)` = `max(cumqty)`) | strong internal consistency |
| Zero order id | 28 Trade rows use the all-zero UUID | these are not real orders and must be excluded from order counts |
| Timestamp inversions | **4,320** of 1,444,583 rows | ~0.3%; fills are buffered per UTC day and sorted before any position or holding-period work |
| Funding quantity | **5,368 / 5,368** funding rows match the reconstructed position size | strong internal consistency |
| Settlement | **8 / 8** settlement rows drive the reconstructed position to exactly zero | strong internal consistency |
| Liquidation rows | 59 (`text = "Liquidation"`), of which 28 use the zero order id | neither "no liquidations" nor "59 liquidations" is a correct summary without modelling the position change |
| Open position at end | `XBTUSD −29,080,100` contracts | the period does not end flat; do not assume a closing trade |
| Wallet `transactid` | 0 duplicates | — |
| Wallet date inversions (file order) | **5** | the wallet file is not date-sorted; it must be sorted before any day-level work |
| Wallet ledger reconciliation | final balance = start + deposits + withdrawals + RealisedPNL, **difference 0 satoshi** | the amount column is complete and correct |
| Wallet per-row balance | 946 of 2,253 rows disagree with the running sum | explained by the balance column's semantics, below |
| Wallet day-end balance | 154 of 1,380 days disagree; 2 materially | 152 are ≤0.0045 XBt (rounding); 2018-04-27 and 2018-04-28 are off by 0.54595876 and 1.00120000 XBt |

## The wallet balance column is a rounded day-level snapshot

This is the single most important structural finding, and it invalidates any intraday equity
curve built from that column.

- On **1,302 of 1,380 days**, every row of the day carries the *same* `walletbalance` value.
- **407 of 2,253** balances are exact multiples of 0.01 XBt, i.e. the column is rounded.
- Worked example, 2021-06-08: all seven `RealisedPNL` rows show `120302000000` satoshi
  (1,203.02 XBt exactly) while the running sum moves from 1,031.65 to 1,203.02 XBt.

So the balance column is usable as a coarse end-of-day anchor and as the final reconciliation
figure, and **not** usable as a per-transaction balance.

Two days remain genuinely inconsistent even at day end:

| Date | Running sum | Reported balance | Difference |
| --- | --- | --- | --- |
| 2018-04-27 | 326,341,302 | 380,937,178 | −0.54595876 XBt |
| 2018-04-28 | 380,937,178 | 481,057,178 | −1.00120000 XBt |

The two differences involve the same 100,120,000-satoshi withdrawal amount that also appears as
a cancelled withdrawal pair on 2018-04-18. The amounts still reconcile at period end, so this is
a balance-column defect, not missing money. It is **not** evidence of forgery and should be
described as an unresolved inconsistency.

## What is still open

1. **External comparison by this repository.** No fill here has been matched against public
   market ticks, and no contract specification (multiplier, listing dates, funding rate history,
   settlement price) has been pulled from BitMEX. An independent third-party audit published on
   the same day reports having matched 72,717 of 72,718 sampled fills against BitMEX's public
   tick archive; that claim has not been reproduced here. See `docs/external-audits.md`.
   Until it is, every contract-level PnL figure below the ledger stays unverified.
2. **Provenance.** The post, its author, and the file upload were not independently
   authenticated.
3. **Per-row balance continuity.** 946 rows cannot be reconciled to the running sum, for the
   structural reason above plus the two days noted.
4. **Time zone.** Execution timestamps are assumed UTC. That assumption has not been confirmed
   against an independent source.
5. **The three repeated `trdmatchid` values.** Whether they are self-matches, corrected prints,
   or an export artefact is undetermined.
