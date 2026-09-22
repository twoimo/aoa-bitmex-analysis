# External verification against BitMEX's public trade archive

Everything else in this repository compares the disclosed files with each other. That can show
the record is internally consistent; it cannot show the fills happened. This is the outside check.

Reproduce with:

```bash
npm run verify:public            # 20-day sample plus two named days
node scripts/verify-public-trades.mjs --count 60 --days 2018-09-21,2020-03-12,2021-05-19,2021-12-24
```

## Method

BitMEX publishes every trade, day by day, in a public archive
(`s3-eu-west-1.amazonaws.com/public.bitmex.com/data/trade/YYYYMMDD.csv.gz`, listed at
<https://public.bitmex.com/?prefix=data/trade/>). Each row carries a `trdMatchID` that cannot be
guessed, so a fill in the disclosed export can be looked up directly rather than inferred from
price and time.

- **Day sample.** A fixed stride across all 1,090 days that have fills, plus four named days
  (2018-09-21, 2020-03-12, 2021-05-19, 2021-12-24). The stride makes the sample reproducible and
  not hand-picked. 64 days were sampled.
- **One pass over the local execution CSVs** collecting only those days.
- **Per day, the public archive is streamed** (gzip) and every `trdMatchID` we hold is looked up.
  Symbol, size and price are then compared.

## Result

| | |
| --- | --- |
| Days sampled | 64 of 1,090 days with fills (5.9%) |
| Fills checked | 81,268 of 1,439,207 (5.6%) |
| Found in the public archive | **81,263** |
| Match rate | **99.9938%** |
| Symbol / size / price mismatches | **0** |
| Side-rule violations | **0** of 81,263 |

### The five that do not match

All five are the same thing:

| Day | Symbol | Side | Size | Price | Local `text` | Local liquidity |
| --- | --- | --- | ---: | ---: | --- | --- |
| 2018-03-31 | XBTUSD | Buy | 50,000 | 7,154.60 | `Liquidation` | RemovedLiquidity |
| 2018-09-21 | XRPU18 | Sell | 10,000 | 0.000095 | `Liquidation` | RemovedLiquidity |
| 2018-09-21 | XRPU18 | Buy | 330,000 | 0.00012972 | `Liquidation` | RemovedLiquidity |
| 2018-09-21 | XRPU18 | Sell | 218 | 0.00008241 | `Liquidation` | RemovedLiquidity |
| 2020-03-12 | XBTUSD | Sell | 126 | 5,767.03 | `Liquidation` | RemovedLiquidity |

Every unmatched fill is a **liquidation**, and BitMEX does not publish liquidation executions in
the trade archive. So the correct reading is not "five fills could not be verified" but "five
fills are of a type the archive does not contain, and every other fill on those days matched".
The 2018-09-21 date is the XRP spike where the account was liquidated on a short.

## A side effect: the maker/taker classification is now externally checked

The public archive records the **taker's** side, while a private execution export records **your
own** side. That gives a testable rule: for a fill where we were the maker, our side must be the
*opposite* of the archive's, and where we were the taker they must be the *same*.

Applied to all 81,263 matched fills, using our `lastliquidityind` to decide maker or taker:

**0 violations.**

That is stronger than it first looks. Before this check, "maker 67.16% of fills" was an internal
label with no outside confirmation. The archive now confirms the label on every matched fill: a
fill we call a maker appears in the public record with the opposite side, exactly as a maker fill
must.

## What this changes

- The repository's largest open item — "no fill has been matched against public market data" — is
  **closed by this repository**, not merely reported by a third party.
- The internal-consistency findings (order quantities, funding quantities, settlements, the ledger
  identity) now sit on top of an externally corroborated fill set rather than standing alone.
- It independently reproduces the third-party claim recorded in `docs/external-audits.md`, and
  covers more fills (81,268 vs 72,718) over more days (64 vs 17).

## What it still does not establish

- **Coverage is a sample, not the whole record.** 5.6% of fills across 5.9% of days. A full pass
  would mean downloading roughly 1,090 archives (~19 GB) and has not been run. The sample is
  spread by stride across the whole window, so there is no obvious reason the unsampled days
  would behave differently, but that is an argument, not a measurement.
- **It does not prove the account owner is who he says he is.** Matching fills show the file
  describes real BitMEX trades; they say nothing about whose account produced them.
- **It does not cover the 2022+ period**, which is outside the disclosed window.
- **Wallet flows are not covered.** Only the trade archive is public; deposits and withdrawals
  cannot be checked against a public source this way.
