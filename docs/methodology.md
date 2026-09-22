# Methodology and data dictionary

## Files and shapes

| File | Rows | Columns | Notes |
| --- | --- | --- | --- |
| `aoa-execution-*.csv` (4 files) | 1,444,587 lines | 41 | Trade 1,439,207 · Funding 5,368 · Settlement 8, plus 4 header lines |
| `aoa-wallet-*.csv` | 2,253 transactions | 14 | 18 Deposit · 56 completed Withdrawal · 7 cancelled Withdrawal · 2,172 RealisedPNL |
| `90일 서한.txt` | — | — | The discloser's market letter, UTF-8, CRLF |

The wallet file also contains 2,135 fully blank rows (lines of commas). They are padding and
carry no data.

## Column maps

### Execution export (41 fields)

```
0  date            1  execid          2  orderid        3  clordid        4  clordlinkid
5  account         6  symbol          7  side           8  lastqty        9  lastpx
10 lastliquidityind 11 orderqty       12 price          13 displayqty    14 stoppx
15 pegOffsetValue  16 pegPriceType   17 currency       18 settlcurrency 19 exectype
20 ordtype         21 timeinforce     22 execinst       23 contingencytype 24 ordstatus
25 triggered       26 workingindicator 27 ordrejreason  28 leavesqty     29 cumqty
30 avgpx           31 commission      32 tradepublishindicator 33 text      34 trdmatchid
35 execCost        36 execComm        37 homeNotional   38 foreignNotional 39 transacttime
40 timestamp
```

### Wallet export (14 fields)

```
0 date  1 transactid  2 account  3 currency  4 amount  5 transactstatus  6 address
7 network  8 text  9 timestamp  10 transacttime  11 transacttype  12 tx  13 walletbalance
```

## Units and sign conventions

Getting these wrong is the single largest source of bad numbers in this dataset.

- **Satoshi.** `amount`, `walletbalance`, `execCost` and `execComm` are integers in 1e-8 XBt.
  Divide by 1e8 for coins.
- **`execCost` on a Trade row** is the notional in satoshi (XBt-settled), and
  `execComm = execCost × commission`. Its *sign follows `execCost`*, which is positive for some
  fills and negative for others, so never sum `execComm` to get "fees paid" without splitting
  maker from taker. Use `|execComm|` grouped by `lastliquidityind`.
- **`execCost` on a Funding row is not the funding payment.** It is the position notional.
  The cash flow is in `execComm`, and the `commission` column holds the funding *rate*
  (e.g. `-1.0E-4`). Summing `execCost` here inflates the funding total by roughly 200 XBt.
- **A negative `execComm` on a Funding row means the account received money.**
- **`foreignNotional`** is the quote-currency notional of the fill (USD for inverse contracts,
  USDT for the stablecoin-quoted ones). `homeNotional` is the base-currency notional.
- **`walletbalance` is not a per-row running balance.** It is a day-level snapshot repeated on
  every row of that day, and it is rounded (407 of 2,253 rows are exact multiples of 1e-2 XBt).
  See `docs/validation.md`.
- **`timestamp` / `transacttime` in the wallet file are unusable.** They contain elapsed-time
  strings such as `57:26.3`, not wall-clock times. Only `date` can be used, which means rows
  cannot be ordered inside a day except by file order.
- **Execution timestamps are UTC.** Day and hour buckets in `insights.mjs` convert to KST
  (UTC+9) because the trader is Korean.

## Contract classes present

All 1,444,583 execution rows have `settlcurrency = XBt`, including symbols whose names end in
`USDT`. Do not infer the margin currency from the symbol name. Three classes appear:

1. **Inverse, USD-quoted** — `XBTUSD`, `ETHUSD`, `XRPUSD`, `LTCUSD`, `BCHUSD`. Contract value
   1 USD; `homeNotional` is denominated in XBt. Profit is
   `Q × (1/P_entry − 1/P_exit)` in XBt. About 94% of fills.
2. **Quanto altcoin futures** — e.g. `TRXZ18`, `ADAZ18`, `EOSM18`. `homeNotional` is denominated
   in the base coin, not XBt, so it must not be added to XBt notional.
3. **Stablecoin-quoted / quanto perpetuals** — `DOTUSDT`, `DOGEUSDT`, `LINKUSDT`, and the dated
   XBT futures (`XBTU21`, `XBTH20`, …). Treating these as USDT-linear because of the name is
   wrong for the period covered here.

`aoa-bitmex-analysis` does **not** carry a full contract specification table (multiplier,
listing and delisting dates, settlement price source). That is the main open gap for any
PnL decomposition that goes below the ledger level.

## Definitions used

| Term | Definition used here | Where it is weak |
| --- | --- | --- |
| Fill | one execution row with `exectype = Trade` | — |
| Order | distinct `orderid` on Trade rows; the all-zero UUID is excluded | — |
| Round trip | FIFO queue matching of fills per symbol: an opening lot and the opposite fills that consume it | Not an exchange position lifetime. Cross-margin netting, reversals inside one fill, and the open position at period end are not modelled |
| Holding period | `close timestamp − open timestamp` of a FIFO round trip | Same caveat; fills are buffered per UTC day and sorted before matching because ~0.3% of rows are out of order |
| Win rate | share of profitable `RealisedPNL` ledger entries | Those are position-close events, not orders or round trips |
| Profit factor | gross positive ledger PnL ÷ gross negative ledger PnL | — |
| Turnover ratio | daily XBt-equivalent traded notional ÷ that day's closing ledger equity | Not leverage. Only inverse USD contracts contribute notional; days with equity under 1 XBt are excluded |
| Drawdown | high-water mark drawdown of the **cumulative ledger profit** index | Ignores unrealised PnL; a second balance-based number is reported separately with its own caveat |
| Time-weighted return | **not reported** | The ledger has no per-transaction timestamps and no unrealised PnL |

## What is deliberately not computed

- **Leverage, margin mode, liquidation cushion.** Quantity paths cannot recover these; BitMEX
  manages margin separately from position size, and cross margin couples all positions.
- **Sharpe / Sortino.** Daily ledger PnL swings are not a return series with a stable base.
- **Order cancellation rate, quote lifetime, fill rate.** Unfilled and cancelled orders are not
  in the export.
- **Exact PnL per round trip.** The ledger gives PnL per symbol-close event, not per FIFO lot.

## Reproducing

```bash
npm run fetch && npm run validate && npm run analyze && npm run insights
```

`validate` writes `manifest.json`, `results/validation.json` and `results/anomalies.csv`.
`analyze` writes `results/summary.json` and `REPORT.md`. `insights` writes
`results/insights.json` and `FINDINGS.md`.

## Market candles on the site

The candlestick panel draws real daily OHLCV from free, keyless public APIs, refreshed by
`npm run market` and committed to `results/market-history.json`:

| Panel | Source | From | Bars |
| --- | --- | --- | ---: |
| BTC | Bitstamp `BTC/USD` | 2011-08-18 | 5,515 |
| ETH | Bitfinex `ETH/USD` | 2016-03-09 | 3,843 |

- **Neither venue is BitMEX**, where this account traded, so prices differ slightly from its
  fills. The chart names the venue and the first day on every render.
- ETH mainnet launched 2015-07-30. The earliest ETH/USD daily series reachable from a free
  source here starts 2016-03-09; Kraken ignores the `since` parameter, Bitstamp has no ETH
  history that far back, Poloniex's public endpoint returned nothing and CryptoCompare now
  requires a key. The chart therefore starts where the data does, not where the chain does.
- Bitfinex candles are ordered `[MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]`, not the more common
  `[MTS, OPEN, HIGH, LOW, CLOSE, VOLUME]`. Reading them the common way produces bars where the
  close sits outside the high/low range, so the fetcher documents and follows the real order.
- **Resolution follows the range**, the way a real chart behaves: 1M-1Y draws daily bars, 2Y-5Y
  weekly, 10Y and ALL monthly, all aggregated from the same daily series. A decade of daily
  candles is sub-pixel mush.
- **The price axis switches to log automatically** when the range spans more than 8x, and can be
  forced to LOG or LIN. A linear axis over 2011-2026 collapses the first eight years onto the
  baseline.
- Each bar carries the account's own activity for that bar (`accountFills`,
  `accountNotionalXbt`, summed over the bar's span), drawn as a gold tick under the volume panel.
  The internal audit in `site/app.js` cross-checks those against the daily activity aggregate.

### Two payloads

`candles.json` (weekly, whole history, ~180 kB) is embedded in `index.html` for offline readers.
`candles-daily.json` (daily, ~9,400 bars, ~420 kB) is fetched at runtime over http(s) only;
embedding it would roughly double the page. Offline the chart draws weekly bars and says so.
Both asset and data URLs carry a build hash, because GitHub Pages caches them for ten minutes
and a fresh page reading stale aggregates would fail its own cross-checks.

## Replay and the fill footprint

`npm run replay` builds `results/replay.json`: one row per day with closing equity, cumulative
realised PnL, cumulative withdrawals, that day's fill count and notional, and the net position at
the close across XBTUSD and ETHUSD converted to BTC at that day's market close.

It is a **replay of the disclosed record, not a backtest of a strategy**. The export contains no
entry or exit rules, only executions, so nothing here can be replayed against different
parameters. The page uses it to scrub through time: moving the slider truncates the chart to that
date and shows the account's state on it.

`npm run footprint` builds `results/fill-footprint.json`: every fill in the export aggregated into
per-day buy and sell price ranges for the two charted symbols (1,268,435 of 1,439,207 fills,
88.1%), a price-level profile of notional, and a per-symbol table covering all 46 instruments so
the page can state exactly how much of the record is drawn. The export has no resting orders, so
this shows where fills happened, not where quotes were posted.
