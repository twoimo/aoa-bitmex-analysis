# Stated vs measured

The account holder has written publicly about how he trades for years: monthly settlement posts,
a BitMEX interview, a Q&A session, and a disclosure announcement. Because the ledger is now
available, most of those statements can be checked rather than taken on faith.

**Method.** Every "measured" number below comes from `results/` or from
`scripts/stated-vs-measured.mjs`, which is runnable against the dataset. Claims are quoted from
the sources listed at the end. Nothing here is a judgement about the person; it is a comparison
of what was said against what the files show.

---

## 1. His own disclosure announcement: six for six

In the post announcing the release (2026-09-22 11:28) he stated specific numbers. All six check
out.

| Claim | Stated | Measured | Verdict |
| --- | --- | --- | --- |
| Cumulative deposits | 14.4 BTC | 14.48925714 XBt | match |
| Cumulative realised PnL | 3,537 BTC | 3,537.32369404 XBt | match |
| Cumulative realised return | ~24,400% | 24,414% | match |
| Order count | ~23,000 | 23,416 | match |
| Fill count | ~1.4 million | 1,439,207 | match |
| Positions held | ~3,200 | **3,185** (1,184 flat→open + 2,001 long↔short reversals) | match |

The position count is the interesting one. The ledger has only 2,172 `RealisedPNL` entries, so a
naive read would call his 3,200 an overstatement. Reconstructing the position series per symbol
and counting every new directional position — including reversals that never pass through flat —
gives 3,185. His figure is right and the naive read was wrong.

---

## 2. Stated principles that the ledger confirms

### "출금해라" / harvest profits — confirmed

- Stated (2021-08-10, "윙스의 꿀통"): lists among the advice people ignore: "출금해라" — and
  separately criticises people who "withdraw and then, when underwater, deposit again to average
  down (제일 많이 봄)".
- Measured: **79.6% of realised profit (2,814.54 XBt) was withdrawn**, 56 completed withdrawals,
  27 of them within ±5 days of a high-water mark in cumulative profit.
- Measured: total deposits were **14.49 XBt over four years** — 0.4% of the eventual result. He
  essentially never topped the account up.

This is the single largest behaviour in the file and it matches what he told people to do.

### "보통 하루 정도 들고 있음" — confirmed

- Stated (Q&A): "보통 하루 정도 들고 있음. 원래는 분봉 위주의 매매를 하면서 한두 시간마다
  사고팔았으나, 자산 규모가 커짐에 따라 좀 더 길게 가져가고 있음."
- Measured: FIFO round-trip median hold **13.2 h**; 19.8% of trips close inside an hour, 60.0%
  inside a day.

### "승률에 더 신경 써라" — confirmed

- Stated (Q&A): "승률에 더 신경 쓰는 매매를 추천합니다. 손익비가 큰 것을 원한다면 결국 한방,
  요행을 바라는 매매로 갈 수밖에 없고, 이것은 제가 추구하는 매매 방식과는 다릅니다."
- Measured: win rate **66.99%**, profit factor **1.70**, payoff ratio **0.84** (average win 5.90
  XBt vs average loss 7.04 XBt). That is exactly the shape he describes: no reliance on large
  winners.

### "시총이 큰 코인 위주로 매매" — confirmed

- Stated (Q&A): "시장참여자들이 많으면 많을수록 차트 신뢰성이 높아지기에 시총이 큰 코인 위주로
  매매하는 편입니다."
- Measured: XBTUSD + ETHUSD produced **80.2%** of ledger profit. 46 symbols were traded, but the
  largest altcoin futures were net losers (`BCHUSD` −69.94, `LINKUSDT` −17.85, `XRPU18` −17.74).

### "비트코인과 이더리움 외의 코인에서는 승률이 꽤 낮습니다" — confirmed

- Stated (BitMEX interview, 2025-06-11): "사실 저는 비트코인과 이더리움 외의 코인에서는 승률이
  꽤 낮습니다. 이걸 알면서도 탐욕에 눈이 멀어 큰 손실을 봤던 때가 있었다는 점이 아쉽습니다."
- Measured: the 2018–2021 ledger shows the same pattern five years earlier — profit concentrated in
  BTC/ETH, losses in altcoin futures. The self-diagnosis is visible in the data.

### "자본의 최대 30% 이상을 잃지 않도록" — largely confirmed

- Stated (BitMEX interview): "첫 번째 원칙은 특정 포지션과 사랑에 빠지지 않는 것입니다. 절대
  올인하지 않습니다. 항상 제 자본의 최대 30% 이상을 잃지 않도록 리스크를 관리합니다."
- Measured: for the 717 losing ledger closes, the loss as a share of that day's closing equity:
  median **0.21%**, p90 **6.43%**, p99 **63.96%**.
  - **95.7% of losing closes cost less than 20% of equity.**
  - **97.5% cost less than 30% of equity.**
- Caveat: equity is the day-end rounded balance and the loss is a ledger close event, not the risk
  taken at entry. The distribution is directional evidence, not a risk-of-ruin calculation.

### "선물 4 : 현물 4 : 현금 2" — roughly confirmed

- Stated (Q&A): "선물 4, 현물 4, 은행 2를 유지."
- Measured: comparing his own monthly "비트 환산" totals with the BitMEX ledger balance:

| Date | His stated total (BTC) | BitMEX ledger balance (XBt) | BitMEX share |
| --- | ---: | ---: | ---: |
| 2021-05-31 | 2,290 | 795.65 | 34.7% |
| 2021-06-30 | 2,870 | 1,139.87 | 39.7% |
| 2021-07-31 | 3,270 | 987.49 | 30.2% |

BitMEX held 30–40% of his stated book, bracketing the 40% he said he keeps in futures.

---

## 3. Stated numbers that do not reconcile

### Cumulative withdrawals, 2019

He posted two progress snapshots with withdrawal totals:

| Date | His post | Ledger balance | Ledger cumulative withdrawals | Implied balance (stated total − stated withdrawals) |
| --- | --- | ---: | ---: | ---: |
| 2019-05-06 | "16빗 → 345빗 (158빗 출금)" | 171.06 | 201.04 | 187 |
| 2019-11-26 | "16빗 → 600빗 (298빗 출금)" | 301.00 | 341.13 | 302 |

- The **implied balance matches the ledger** at 2019-11-26 (302 vs 301.00) and is close at
  2019-05-06 (187 vs 171.06).
- But his stated withdrawal totals are **consistently ~43.1 BTC below the ledger** (158 vs 201.04;
  298 vs 341.13). The offset is the same at both dates, six months apart, so it is not drift.

The most likely reading is a definitional difference: something the ledger records as a withdrawal
(43.1 BTC before May 2019) that he did not count as "출금" — for example a transfer between his own
venues. The file cannot distinguish the two, so this stays an open discrepancy rather than an
error.

### Positions

- Stated: ~3,200. Measured: 3,185 under the "new directional position" definition (match), but
  2,172 ledger close events and 1,183 returns-to-flat. Which of those is "a position" depends on
  definition; his is defensible and so is the ledger count.

---

## 4. What cannot be checked at all

| Stated | Why it is unverifiable here |
| --- | --- |
| "별다른 보조지표를 보지 않고 오직 캔들과 거래량만" | Entry reasoning is not in the file |
| "3이 들어간 분봉 빼고 모든 분봉" | Chart timeframes are not in the file |
| "최대 1.5~2배 레버리지" (interview) | Margin mode and leverage are not in the file; only fills are. Daily turnover ÷ equity (median 5.3×) measures activity, not leverage |
| "3,000만원 시절 시드의 25%로 25배" | Same reason |
| "기술적 분석 9 : 뉴스 1" | Not observable |
| Order cancellations and amendments | He said this himself: "체결 시각과 가격, 수량만으로는 진입을 보류하거나 주문을 취소·변경한 판단 과정까지 재현할 수 없다" — and it is exactly the limit `docs/validation.md` records |

---

## 5. What this comparison actually establishes

1. **The stated numbers are accurate.** Every quantity he published about the dataset — deposits,
   PnL, return, orders, fills, positions — matches the files. Whatever else is uncertain, he did
   not inflate the record.
2. **The stated process is mostly the measured process.** Harvesting profits, holding about a day,
   preferring hit rate over payoff, concentrating in BTC/ETH, keeping single-trade risk under
   about a third of equity: all five show up in the fills and the ledger.
3. **The stated process is not a strategy.** These are risk-posture statements, not entry rules.
   Confirming them tells you how he managed money, not how he decided to enter. The one place
   where he gave an actual method — the 2020-01-08 post on the $6,500 entry, using inverse
   head-and-shoulders, support lines, and analogous-shape reading — is a single anecdote, and he
   labels it himself as "야매" (unschooled) analysis written after the fact.
4. **The most transferable item is the least technical one.** Withdrawing ~80% of profits and
   never re-depositing is a rule anyone can follow and it is the behaviour with the clearest
   footprint in the data. He said it repeatedly, and the ledger shows he did it.

---

## Sources

| What | Where |
| --- | --- |
| Disclosure announcement | `gall.dcinside.com` chartanalysis post 5050579 (2026-09-22 11:28) |
| BitMEX interview | `economybloc.com/article/87110` (2025-06-11), and the BitMEX blog series it quotes |
| Q&A compilations | `excelcel.tistory.com/3`, `evrdh.tistory.com/entry/aoa-trading`, `thothbooks2023.tistory.com` |
| Post index | `gall.dcinside.com` chartanalysis post 2321834 ("주문하신 워뇨띠 글 모음", 2023-06-12) |
| Posts used | 36 posts authored by `rlaow200` (gallog id), 2019-05-06 to 2023-06-05, fetched via the post index above |

The post bodies are **not** redistributed with this repository. DCInside's terms (제16조) require
prior written consent for crawling and for use of their content in AI training data, so the corpus
stays local and only short quotes needed for the comparison appear here.
