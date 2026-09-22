# What this record does and does not say about trading well

The goal of this analysis is not to describe the file. It is to ask what, if anything, a
complete four-year fill history of a profitable discretionary trader teaches about trading.
That is a harder question, and most of the honest answer is about limits.

Confidence labels used below:

- **Solid** — follows directly from a reconciled number in `results/`, and survives the
  alternative explanations I could think of.
- **Directional** — the pattern is visible but the measurement is approximate, or the sample
  behind it is small.
- **Speculative** — a plausible reading, not established by this data.

---

## 1. The profit came from two instruments, not from breadth — Solid

| Symbol | Ledger PnL (XBt) | Share of total | Closes | Win rate |
| --- | ---: | ---: | ---: | ---: |
| XBTUSD | +2,007.08 | 56.7% | 1,377 | 63.0% |
| ETHUSD | +830.36 | 23.5% | 312 | 67.3% |
| XBTU21 (BTC future) | +246.33 | 7.0% | 11 | 72.7% |
| XRPUSD | +173.86 | 4.9% | 109 | 89.9% |
| ETHUSDM21 (ETH future) | +140.93 | 4.0% | 5 | 80.0% |
| XBTH20 (BTC future) | +119.20 | 3.4% | 14 | 78.6% |

BTC and ETH together produced **80.2%** of ledger profit. Of 46 traded symbols, the largest
losers were `BCHUSD` (−69.94), `LINKUSDT` (−17.85), `XRPU18` (−17.74), `XBTM19` (−14.76).

The reading: the edge was in the two most liquid instruments, and excursions into smaller
altcoin futures were where money was lost. Breadth did not help.

**Confounder.** A small number of closes carries a large share of the PnL in the futures
symbols (11 closes for XBTU21, 5 for ETHUSDM21). Those rows are close to being single events,
so "XBTU21 was profitable" is much weaker evidence than "XBTUSD was profitable".

---

## 2. A high hit rate with a below-1 payoff ratio — Solid

- 2,172 ledger closes: 1,455 winners, 717 losers → **win rate 66.99%**
- Gross profit 8,585.94 XBt vs gross loss 5,048.62 XBt → **profit factor 1.70**
- Average win **5.90 XBt**, average loss **7.04 XBt** → payoff ratio **0.84**

This is the arithmetic of a scalper, not of a trend follower. The account wins often and loses
bigger, and the win rate is what carries it. That has a direct consequence for anyone reading
this as a template: **the strategy has no margin of safety in its win rate.** Dropping the hit
rate from 67% to roughly 55% turns 1.70 into something close to 1.0.

**What would falsify this.** If the ledger's `RealisedPNL` rows are not per-position-close
events but some coarser settlement, the win rate is measuring the wrong thing. Nothing in the
file confirms the granularity, so treat the 66.99% as "share of profitable ledger entries",
which is how `docs/methodology.md` defines it.

---

## 3. Most of the profit was moved off the exchange — Solid

- Deposits: 18, totalling **14.49 XBt** (about 0.4% of the eventual result)
- Completed withdrawals: 56, totalling **2,814.54 XBt**
- **79.6% of all realised profit left the venue**
- 27 of the 56 withdrawals happened within ±5 days of a high-water mark in cumulative profit

This is the single most transferable behaviour in the data. The account was not compounding on
the exchange; it was harvesting. A separate Korean trader who commented publicly on the same
disclosure on 2026-09-22 described exactly this pattern — "whenever he collected 100 BTC he
immediately pulled 50 out" — and concluded the lesson was discipline rather than technique. The
ledger is consistent with that description.

**Confounder.** Withdrawals are also what an operator does when moving funds to another venue
or to cold storage, so "risk reduction" and "reallocation" are not distinguishable here. The
result is a capital-flow fact; the motive is inference.

---

## 4. Short-biased, and most trades do not last a day — Directional

FIFO round-trip matching over 1,417,925 matched trips:

| | Trips | Median hold |
| --- | ---: | ---: |
| Long | 402,351 | 4.7 h |
| Short | 1,015,574 | 20.3 h |

- Overall median hold: **13.2 h**; 19.8% of trips close inside an hour, 60.0% inside a day.
- Shorts outnumber longs 2.5:1 and carry more notional.

**How much weight this can carry.** The FIFO reconstruction is a queue-matching approximation
on 1.44M fills, not an exchange-reported position lifetime. Cross-margin netting, single fills
that reverse a position, and the −29,080,100-contract XBTUSD position still open at the end all
break the simple model. The 2.5:1 short skew is large enough to survive that noise; the exact
medians are not precise.

---

## 5. Fees and funding were a net credit, not a drag — Solid

| Component | XBt | Account view |
| --- | ---: | --- |
| Maker rebate | 302.31 | received |
| Taker fee | 380.31 | paid |
| **Net trade fee** | **78.00** | paid |
| Funding | 149.58 | **received** |

67.16% of fills were maker fills. Net trading cost was 78.00 XBt, i.e. **2.2% of realised
profit**; funding added 149.58 XBt back, so the two together were a **net credit of 74.53 XBt**.

Two consequences:

1. **A maker-heavy style was load-bearing.** Had the same flow been entirely taker, the fee
   line would have been roughly 5× larger and the net funding credit would not have covered it.
2. **The short bias paid.** Funding was received on net, which fits a book that was short more
   often than long during a period when perpetual funding was frequently positive.

**Caveat.** Funding is already inside the ledger's `RealisedPNL`. These are components, not
additional cash flows. Adding them to the ledger PnL double counts.

---

## 6. The record ends in a large, unfinished drawdown — Solid

Measured on the high-water mark of cumulative ledger profit:

| | |
| --- | --- |
| Peak | 2021-10-12 |
| Trough | 2021-12-22 |
| Drop | **590.98 XBt (−14.4%)** |

The last three months: 2021-10 −215.77, 2021-11 −196.70, 2021-12 −155.19 XBt. December's win
rate collapsed to 35.5% from 63–85% in the preceding months, and the position was still open
when the file ends.

**This is where most summaries of this dataset would go wrong.** The wallet-balance column
shows a 100% drawdown in March 2018, but that is a withdrawal, not a loss. Conversely the
balance column understates the final drawdown because 2,814 XBt had already been withdrawn.
Neither the balance-based number nor the PnL-index number is "the" drawdown, because unrealised
PnL is not in the file and the book was not flat at the end.

---

## 7. Exposure fell after losing days — Directional

Daily turnover (XBt-equivalent traded notional ÷ closing equity), median across days:

- after a winning day: **6.12×** (727 days)
- after a losing day: **3.88×** (346 days)

The direction is the opposite of revenge trading: less activity after losses. But the sample is
uneven (727 vs 346 days) and turnover is a noisy proxy for risk — it counts activity, not open
exposure, and it cannot see the position that was actually carried.

---

## 8. Where the result actually came from — Speculative

Putting the pieces together: a maker-heavy, short-biased, intraday-to-multiday scalper, trading
almost entirely XBTUSD and ETHUSD, winning ~2 times in 3 with a sub-1 payoff ratio, withdrawing
~80% of profits as they accrued.

That describes a **high-frequency, high-discipline, risk-controlled** operation. It does not
describe a method anyone can copy from the file. The file contains *what was traded*, not *why*,
and the discloser's own letter says as much: there is no bot, no signal room, and he warns
against buying one built from this data.

**The honest conclusion is uncomfortable for the "learn to trade from a pro's history"
premise.** Four years of complete fills pin down the shape of the outcome — concentration,
hit rate, cost structure, harvesting behaviour — but not a single entry or exit rule. The
transferable content is the risk posture, not the trades.

---

## Metacognition: how I could be wrong

| Claim | Main way it breaks |
| --- | --- |
| Ledger PnL is complete and correct | It reconciles to the satoshi internally. It would still be wrong if the export itself omitted rows before disclosure — nothing internal can detect that |
| 66.99% win rate | Depends on `RealisedPNL` being per-close. Unverified |
| Short-biased, 13.2 h median hold | FIFO approximation; open position at period end; reversals inside single fills |
| Maker share 67.16% | Fill-weighted, not notional-weighted; notional-weighted it is about 70.8% |
| Turnover ratio as "exposure" | Counts traded notional, not carried position. Not leverage |
| Drawdown of 590.98 XBt | Ignores unrealised PnL; the book was open at the end |
| Fees/funding net credit | Both are components already inside ledger PnL; the split between maker rebate and taker fee depends on correct liquidity classification |

Two structural traps that already caught an earlier revision of this code, and that anyone
re-deriving these numbers should avoid:

1. **Funding rows**: `execCost` is the position notional, `execComm` is the cash flow. Using
   `execCost` inflates funding by roughly 200 XBt.
2. **The wallet balance column**: it is a rounded day-level snapshot, not a running balance.
   Building an intraday equity curve or a time-weighted return on it produces a number that
   looks precise and is not. That is why this repository reports **no TWR at all**.

## What I would need to go further

1. BitMEX contract specifications for the covered period (multipliers, listing dates, funding
   history) so contract-level PnL can be reconstructed below the ledger.
2. Public tick data to match against `trdmatchid`, which would move this from "internally
   consistent" to "externally corroborated".
3. A statement from the account holder about export completeness and time zone.
4. Position and margin history, without which leverage, liquidation risk, and true exposure
   cannot be recovered from fills alone.

---

## Addendum: what he said, checked against what the files show

`docs/stated-vs-measured.md` compares his published statements with the ledger. The short version:

**His own disclosure announcement is accurate on every count.** Cumulative deposits 14.4 BTC
(measured 14.48925714), realised PnL 3,537 BTC (measured 3,537.32369404), return ~24,400%
(measured 24,414%), ~23,000 orders (23,416), ~1.4M fills (1,439,207), ~3,200 positions
(**3,185**). The position figure is the one worth pausing on: the ledger has only 2,172
`RealisedPNL` entries, so a naive read calls it inflated. Counting every new directional
position, including long↔short reversals that never pass through flat, gives 3,185. The claim
survives a stricter test than the ledger's own event count.

**Five stated principles leave a measurable footprint, and all five match.**

| Stated | Measured |
| --- | --- |
| "출금해라" and stop re-depositing after a loss | 79.6% of profit withdrawn; total deposits 14.49 XBt over four years |
| "보통 하루 정도 들고 있음" | FIFO round-trip median 13.2 h |
| "승률에 더 신경 써라" | win rate 66.99%, payoff ratio 0.84 |
| "시총이 큰 코인 위주로 매매" | BTC+ETH = 80.2% of profit |
| "자본의 최대 30% 이상을 잃지 않도록" | 97.5% of losing closes cost under 30% of that day's equity |

**One number does not reconcile.** His two 2019 progress posts state cumulative withdrawals ~43.1
BTC below the ledger at both dates, with an identical offset six months apart. Something the
ledger counts as a withdrawal was not counted as one by him. The file cannot tell whether that is
an internal transfer or an error, so it stays open.

**What this changes about the conclusion above.** It raises confidence in the risk-posture
findings (sections 2–5) because they are now corroborated by an independent source — his own
statements, made years before the data was public — rather than only by my reading of the files.
It does not change section 8: none of the confirmed statements is an entry rule. The one post
where he gave an actual method (2020-01-08, the $6,500 entry using inverse head-and-shoulders,
support lines, and analogous-shape reading) is a single after-the-fact anecdote that he labels
himself as unschooled analysis.
