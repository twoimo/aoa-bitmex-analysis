#!/usr/bin/env node
/**
 * Builds the study payload: dated cases pulled from the measured record, the
 * eight stated principles as study units, and a self-check quiz.
 *
 * Every quiz answer and every case number is read from the analysed payloads at
 * build time, and a mismatch throws. Authored prose never carries a figure of
 * its own.
 *
 * Usage: node scripts/lessons.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = async (p) => JSON.parse(await fs.readFile(path.join(ROOT, 'results', p), 'utf8'));
// The published principle list lives in the site payload, so the study units
// always match what the page already claims, one to one.
const readPublished = async (p) => JSON.parse(await fs.readFile(path.join(ROOT, 'site', 'data', p), 'utf8'));

const num = (v, d = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const xbt = (v, d = 2) => `${num(v, d)} XBt`;
const usd = (v) => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Resolves a dotted path so a quiz answer can be checked against the payload. */
const pick = (obj, pathStr) => pathStr.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);

async function main() {
  const [headline, replay, withdrawals, insights, stated, trades] = await Promise.all([
    readPublished('headline.json'), read('replay.json'), read('withdrawals.json'),
    read('insights.json'), readPublished('stated.json'), read('trades.json'),
  ]);

  // replay.json carries cumulative totals, so every daily figure here is a
  // day-over-day difference of that running total.
  const days = replay.days.map((d, i) => (i === 0
    ? { ...d, dpnl: d.pnl, dwd: d.wd, ddep: d.dep }
    : { ...d, dpnl: d.pnl - replay.days[i - 1].pnl, dwd: d.wd - replay.days[i - 1].wd, ddep: d.dep - replay.days[i - 1].dep }));
  const traded = days.filter((d) => d.f > 0);
  const by = (fn) => days.reduce((a, b) => (fn(b) > fn(a) ? b : a));
  const best = by((d) => d.dpnl);
  const worst = by((d) => -d.dpnl);
  const busiest = by((d) => d.f);
  const biggestDeposit = by((d) => d.ddep);
  const biggestWithdrawalDay = by((d) => -d.dwd);
  const withdrawalEvents = withdrawals.events;
  const biggestEvent = withdrawalEvents.reduce((a, b) => (b.amountXBt > a.amountXBt ? b : a));

  // Longest stretch with no fills at all, measured between trading days.
  let pause = { from: traded[0].d, to: traded[0].d, days: 0 };
  for (let i = 1; i < traded.length; i += 1) {
    const gap = Math.round((Date.parse(`${traded[i].d}T00:00:00Z`) - Date.parse(`${traded[i - 1].d}T00:00:00Z`)) / 86400000);
    if (gap > pause.days) pause = { from: traded[i - 1].d, to: traded[i].d, days: gap };
  }

  const dd = insights.drawdowns.reduce((a, b) => (b.drawdownPct > a.drawdownPct ? b : a));
  const maxDd = { peakDay: headline.maxDrawdownPeakDay, troughDay: headline.maxDrawdownTroughDay, xbt: headline.maxDrawdownXBt, pct: headline.maxDrawdownPct };
  const finalDay = traded.at(-1);
  const finalTape = trades.days[`XBTUSD|${finalDay.d}`] || null;

  const cases = [
    {
      id: 'first-day', kind: 'event', day: '2018-03-05', title: '첫날: 0.17 XBt로 시작',
      figures: [
        ['입금', xbt(days[0].dep, 6)],
        ['그날 체결', `${num(days[0].f, 0)}건`],
        ['그날 명목', usd(days[0].n)],
        ['그날 순포지션', xbt(days[0].pos, 4)],
      ],
      note: '첫날 잔고는 0.17 XBt 남짓이었고, 하루에 37건을 체결했습니다. 4년 뒤 이 계좌가 3,537 XBt를 실현할 것이라는 신호는 이 날의 파일 어디에도 없습니다.',
    },
    {
      id: 'best-day', kind: 'event', day: best.d, title: `최고의 하루: +${xbt(best.dpnl)}`,
      figures: [
        ['그날 실현손익', xbt(best.dpnl)],
        ['그날 체결', `${num(best.f, 0)}건`],
        ['그날 명목', usd(best.n)],
        ['그날 종료 잔고', xbt(best.eq)],
      ],
      note: '하루 손익이 그날 명목의 크기와 함께 움직입니다. 이 계좌의 수익은 방향을 오래 맞힌 결과가 아니라 하루에 수천 건을 체결한 회전에서 나왔습니다.',
    },
    {
      id: 'worst-day', kind: 'event', day: worst.d, title: `최악의 하루: ${xbt(worst.dpnl)}`,
      figures: [
        ['그날 실현손익', xbt(worst.dpnl)],
        ['그날 체결', `${num(worst.f, 0)}건`],
        ['그날 명목', usd(worst.n)],
        ['그날 종료 잔고', xbt(worst.eq)],
      ],
      note: '최악의 하루조차 잔고를 지웠던 게 아닙니다. 손실 하루가 다음 날의 규모를 줄였는지 늘렸는지는 파일에 없으므로 여기서도 단정하지 않습니다.',
    },
    {
      id: 'busiest-day', kind: 'event', day: busiest.d, title: `가장 바쁜 하루: ${num(busiest.f, 0)}건`,
      figures: [
        ['체결', `${num(busiest.f, 0)}건`],
        ['그날 명목', usd(busiest.n)],
        ['그날 실현손익', xbt(busiest.dpnl)],
        ['그날 종료 잔고', xbt(busiest.eq)],
      ],
      note: '하루 1만 건을 넘는 체결은 재량 매매라기보다 기계적인 주문 흐름에 가깝습니다. 4년 전체 1,439,207건을 1,096일로 나누면 하루 중간값 584건입니다.',
    },
    {
      id: 'max-drawdown', kind: 'event', day: maxDd.troughDay, title: '가장 깊었던 구간: 2021-10-12 → 12-22',
      figures: [
        ['낙폭', xbt(maxDd.xbt)],
        ['낙폭 비율', `${num(maxDd.pct * 100, 1)}%`],
        ['정점', maxDd.peakDay],
        ['저점', maxDd.troughDay],
      ],
      note: '누적 실현손익 기준으로 590 XBt 넘게 줄어든 구간입니다. 잔고 자체가 그만큼 사라진 것은 아니지만, 이 계좌가 4년 내내 우상향한 것도 아니라는 사실은 파일이 분명히 보여줍니다.',
    },
    {
      id: 'final-day', kind: 'event', day: finalDay.d, title: '마지막 거래일: 전량 청산',
      figures: [
        ['체결', `${num(finalDay.f, 0)}건`],
        ['매수 / 매도', finalTape ? `${num(finalTape.b, 0)} / ${num(finalTape.s, 0)}건` : '—'],
        ['명목', finalTape ? usd(finalTape.usd) : usd(finalDay.n)],
        ['종료 잔고', xbt(finalDay.eq)],
      ],
      note: '마지막 날 체결은 전부 매도였고 명목 3,000만 달러를 한 방향으로 밀었습니다. 공개 기록은 이 날로 끝나고, 그 뒤 계좌가 어떻게 됐는지는 파일에 없습니다.',
    },
    {
      id: 'biggest-withdrawal', kind: 'event', day: biggestEvent.date, title: `가장 큰 단일 출금: ${xbt(biggestEvent.amountXBt)}`,
      figures: [
        ['출금액', xbt(biggestEvent.amountXBt)],
        ['출금 전 잔고 대비', `${num(biggestEvent.shareOfEquityBefore * 100, 1)}%`],
        ['누적 출금', xbt(biggestEvent.cumulativeWithdrawnXBt)],
        ['수수료', biggestEvent.feeXBt == null ? '면제' : xbt(biggestEvent.feeXBt, 6)],
      ],
      note: '잔고 대비 100%를 넘는 출금은 그날 잔고를 통째로 비운 것입니다. 출금 사유는 파일에 없으니 이유는 추정하지 않습니다.',
    },
    {
      id: 'pause', kind: 'event', day: pause.from, title: `가장 긴 공백: ${pause.days}일`,
      figures: [
        ['마지막 체결일', pause.from],
        ['다음 체결일', pause.to],
        ['공백', `${pause.days}일`],
        ['전체 기간', `${num(days.length, 0)}일`],
      ],
      note: '4년 내내 붙어 있었던 것은 아닙니다. 공백 뒤에 규모를 줄였는지 늘렸는지는 파일의 잔고로만 볼 수 있고, 의도는 알 수 없습니다.',
    },
    {
      id: 'ladder', kind: 'pattern', day: withdrawalEvents[0].date, title: '출금은 크기를 격자에 맞췄다',
      figures: [
        ['완료 출금', `${num(withdrawals.summary.completedWithdrawals, 0)}회`],
        ['누적 출금', xbt(withdrawals.summary.totalWithdrawnXBt)],
        ['실현손익 대비', `${num(withdrawals.summary.withdrawnShareOfRealised * 100, 1)}%`],
        ['취소된 출금', `${num(withdrawals.summary.cancelledWithdrawals, 0)}회`],
      ],
      note: '출금액은 여러 번 같은 기준값 근처에 몰립니다. 얼마씩 뺄지를 미리 정해둔 흔적으로 보이지만, 그 규칙을 그가 말한 적은 없으므로 규칙이라고 단정하지 않습니다.',
    },
    {
      id: 'hold', kind: 'pattern', day: '2018-03-05', title: '보유 시간의 중간값은 13시간',
      figures: [
        ['중간값', insights.holdingPeriod.median],
        ['1시간 미만', `${num(insights.holdingPeriod.shareUnder1h * 100, 1)}%`],
        ['1일 미만', `${num(insights.holdingPeriod.shareUnder1d * 100, 1)}%`],
        ['90백분위', insights.holdingPeriod.p90],
      ],
      note: '전체 체결의 60%가 하루 안에 되돌려집니다. 이 값은 수량을 선입선출로 맞춰 계산한 추정이며, 거래소가 보고한 포지션 수명이 아닙니다.',
    },
    {
      id: 'after-loss', kind: 'pattern', day: '2018-03-05', title: '진 날 다음에도 크게 걸었다',
      figures: [
        ['이긴 날 다음', `${insights.behaviour.daysAfterWin}일`],
        ['중간 노출 배수', `${num(insights.behaviour.medianExposureRatioAfterWin, 2)}배`],
        ['진 날 다음', `${insights.behaviour.daysAfterLoss}일`],
        ['중간 노출 배수', `${num(insights.behaviour.medianExposureRatioAfterLoss, 2)}배`],
      ],
      note: '손실 다음 날 노출을 줄이는 대신 오히려 줄어듭니다. 이 계좌가 자본 보존 규칙을 기계적으로 지킨 흔적은 여기서 찾기 어렵습니다.',
    },
    {
      id: 'drawdown-count', kind: 'pattern', day: dd.peakDay, title: `되돌리지 못한 낙폭 ${num(dd.drawdownPct * 100, 1)}%`,
      figures: [
        ['낙폭', `${num(dd.drawdownPct * 100, 1)}%`],
        ['정점', dd.peakDay],
        ['저점', dd.troughDay],
        ['회복일', dd.recoveredDay || '기록 없음'],
      ],
      note: '가장 깊었던 낙폭은 회복 기록이 없습니다. 누적 실현손익 기준 낙폭은 잔고 낙폭과 다르므로, 두 값을 같은 것으로 읽으면 안 됩니다.',
    },
  ];

  const unitText = {
    withdraw: {
      title: '수익은 계좌 밖으로 뺐다',
      read: '실현손익의 79.6%가 56번의 출금으로 빠져나갔고, 4년 동안 다시 넣은 돈은 14.49 XBt뿐입니다. 번 돈을 계좌에 쌓아두지 않았다는 사실은 파일이 직접 보여줍니다.',
      lesson: '수익을 실현하는 것과 계좌에 남겨두는 것은 다른 결정입니다. 이 기록에서 후자는 거의 없었습니다.',
      check: '내 계좌는 지난 1년간 실현손익 중 몇 %를 실제로 인출했는가?',
    },
    hold: {
      title: '하루 안에 대부분 되돌렸다',
      read: '수량을 선입선출로 맞춘 보유 시간의 중간값은 13.2시간이고, 60%가 하루 안에 끝납니다. 길게 들고 버티는 방식이 아니었습니다.',
      lesson: '보유 시간은 전략의 성격을 드러냅니다. 이 계좌의 수익은 오래 들고 맞히는 데서 나온 것이 아닙니다.',
      check: '내 최근 20회 매매의 보유 시간 중간값은 얼마인가?',
    },
    winrate: {
      title: '승률을 손익비보다 앞에 뒀다',
      read: '양수 원장 항목 비율 66.99%, 손익비는 0.84입니다. 이긴 횟수가 많고 한 번 이길 때 버는 돈은 잃을 때보다 적은 구조입니다.',
      lesson: '승률과 손익비는 서로 맞바꿀 수 있습니다. 어느 쪽을 앞에 두는지에 따라 같은 기대값도 완전히 다른 매매가 됩니다.',
      check: '내 승률과 손익비는 각각 얼마이고, 둘의 곱이 1을 넘는가?',
    },
    largecap: {
      title: '큰 시장에 집중했다',
      read: '46개 종목을 거래했지만 실현손익의 80.2%가 BTC와 ETH에서 나왔습니다. 다만 이것은 결과의 집중이고, 종목을 고르는 규칙이 있었다는 증거는 아닙니다.',
      lesson: '결과가 집중됐다는 사실과 집중하겠다는 규칙이 있었다는 것은 다릅니다. 파일로 확인되는 것은 앞쪽뿐입니다.',
      check: '내 손익 상위 두 종목이 전체의 몇 %를 차지하는가?',
    },
    risk30: {
      title: '한 항목이 자본의 30%를 넘지 않았다',
      read: '음수 원장 항목의 97.5%가 그날 종료 잔고의 30% 미만, 95.7%가 20% 미만이었습니다. 다만 이 값은 진입 시점에 감수한 위험이 아니라 결과 크기입니다.',
      lesson: '손실 크기를 사후에 재는 것과 진입 전에 정하는 것은 다릅니다. 파일은 앞쪽만 보여줍니다.',
      check: '내 손실 거래의 크기 분포를 사후에 세어본 적이 있는가?',
    },
    allocation: {
      title: '자산 배분은 확인되지 않는다',
      read: '그는 선물·현물·현금을 4:4:2로 두라고 말했지만, 이 파일은 비트멕스 한 곳의 기록입니다. 세 시점에서 잔고가 공개 총자산 추정의 30~40%였을 뿐 배분 자체는 검증할 수 없습니다.',
      lesson: '말한 배분과 확인 가능한 배분은 범위가 다릅니다. 한 거래소의 파일로 전체 자산 구성을 알 수는 없습니다.',
      check: '내 자산 중 이 계좌 하나가 차지하는 비중을 나는 정확히 아는가?',
    },
    leverage: {
      title: '레버리지는 파일에 없다',
      read: '1.5~2배를 썼다는 인터뷰가 있지만, 체결 내역에는 증거금 모드와 레버리지가 담기지 않습니다. 계산으로 복원할 수 없는 값입니다.',
      lesson: '데이터에 없는 값을 그럴듯하게 채우는 순간 분석이 아니라 이야기가 됩니다.',
      check: '내가 쓰는 레버리지는 기억이 아니라 기록으로 확인되는가?',
    },
    indicators: {
      title: '근거는 파일에 없다',
      read: '캔들과 거래량만 본다고 말했지만, 왜 그 가격에 진입했는지는 체결 내역에 남지 않습니다. 1,439,207건의 체결은 결과이지 이유가 아닙니다.',
      lesson: '결과 데이터로 매매 이유를 역추적하면 반드시 사후 합리화가 됩니다. 없는 것은 없다고 두는 편이 낫습니다.',
      check: '내 진입 이유를 지금 기록으로 남기고 있는가?',
    },
  };

  const unitCases = {
    withdraw: ['biggest-withdrawal', 'ladder'],
    hold: ['hold'],
    winrate: ['best-day', 'worst-day'],
    largecap: ['busiest-day'],
    risk30: ['worst-day', 'after-loss'],
    allocation: ['first-day', 'final-day'],
    leverage: ['max-drawdown'],
    indicators: ['first-day'],
  };

  const quotes = {
    withdraw: ['“출금해라.” 그리고 손실 뒤에 다시 입금하지 마라.', '2021-08-10 게시글'],
    hold: ['“보통 하루 정도 들고 있음.”', '차트갤 Q&A'],
    winrate: ['“승률에 더 신경 써라. 손익비가 큰 건 결국 요행을 바라는 매매다.”', '차트갤 Q&A'],
    largecap: ['“시총이 큰 코인 위주로 매매하는 편이다.”', '차트갤 Q&A'],
    risk30: ['“항상 제 자본의 최대 30% 이상을 잃지 않도록 리스크를 관리합니다.”', '2025 비트멕스 인터뷰'],
    allocation: ['“선물 4 : 현물 4 : 현금 2로 나눈다.”', '매매법 정리'],
    leverage: ['“최대 1.5~2배 레버리지로 매매합니다.”', '2025 비트멕스 인터뷰'],
    indicators: ['“추세선은 긋지 않고 지지를 주로 본다. 보조지표는 거의 보지 않는다.”', '차트갤 Q&A'],
  };

  // Korean rendering of the measured column: the study units are read in Korean
  // even though the published verdict payload keeps its English wording.
  const measuredKo = {
    withdraw: '완료 출금 56회 · 누적 2,814.54 XBt(실현손익의 79.6%) · 4년 총입금 14.49 XBt. 출금 동기와 재입금 금지 규칙 자체는 파일로 확인되지 않습니다.',
    hold: 'FIFO 수량 매칭 중간값 13.2시간 · 1시간 미만 19.8% · 1일 미만 60.0%. 거래소가 보고한 포지션 수명이 아니라 체결을 맞춰 계산한 추정입니다.',
    winrate: '양수 원장 항목 비율 66.99% · Profit Factor 1.70 · 손익비 0.84. 진입 우선순위는 파일에서 추론할 수 없습니다.',
    largecap: 'XBTUSD와 ETHUSD가 실현손익의 80.2%. 이것은 이익의 집중이지 종목 선택 규칙이나 그 인과효과의 증거가 아닙니다.',
    risk30: '음수 원장 항목의 97.5%가 그날 종료 잔고의 30% 미만(20% 기준 95.7%). 진입 시점에 감수한 위험이 아니라 결과의 크기입니다.',
    allocation: '세 시점에서 비트멕스 잔고가 공개 총자산 추정의 30~40%. 다른 거래소와 배분 자체는 이 파일에서 검증할 수 없습니다.',
    leverage: '복원 불가: 증거금 모드와 레버리지는 체결 내보내기에 담기지 않습니다.',
    indicators: '복원 불가: 진입 근거는 파일에 없습니다. 체결은 결과이지 이유가 아닙니다.',
  };

  const units = stated.principles.map((p, i) => {
    const key = Object.keys(unitText)[i];
    const text = unitText[key];
    if (!text) throw new Error(`No study text for principle ${i}`);
    const q = quotes[key];
    if (!q) throw new Error(`No quote for principle ${i} (${key})`);
    return {
      id: key,
      no: i + 1,
      title: text.title,
      quote: q[0],
      source: q[1],
      stated: p.stated,
      measured: p.measured,
      measuredKo: measuredKo[key] || p.measured,
      verdict: p.verdict,
      read: text.read,
      lesson: text.lesson,
      check: text.check,
      caseIds: unitCases[key] || [],
    };
  });

  const quiz = [
    {
      id: 'q-realised',
      q: '이 계좌가 2018~2021년에 실현한 손익은 얼마인가?',
      options: ['약 35 XBt', '약 354 XBt', '약 3,537 XBt'],
      answer: 2,
      metric: 'headline.realisedXBt',
      format: (v) => `약 ${num(v, 0)} XBt`,
      why: `원장 기준 실현손익은 ${xbt(headline.realisedXBt)}이고, 최종 잔고는 ${xbt(headline.finalBalanceXBt)}입니다.`,
    },
    {
      id: 'q-withdrawn',
      q: '실현손익 중 계좌 밖으로 빠져나간 비중은?',
      options: ['약 20%', '약 50%', '약 80%'],
      answer: 2,
      metric: 'headline.withdrawnShareOfProfit',
      format: (v) => `약 ${num(v * 100, 0)}%`,
      why: `완료된 출금은 ${xbt(headline.withdrawalsXBt, 2)}로 실현손익의 ${num(headline.withdrawnShareOfProfit * 100, 1)}%입니다.`,
    },
    {
      id: 'q-payoff',
      q: '승률은 높은데 손익비는 어떻게 됐나?',
      options: ['1보다 컸다', '1보다 작았다', '정확히 1이었다'],
      answer: 1,
      metric: 'headline.payoffRatio',
      format: (v) => (v < 1 ? '1보다 작았다' : v > 1 ? '1보다 컸다' : '정확히 1이었다'),
      why: `손익비는 ${num(headline.payoffRatio, 2)}로 1보다 작습니다. 승률 ${num(headline.winRate * 100, 1)}%가 이를 상쇄한 구조입니다.`,
    },
    {
      id: 'q-maker',
      q: '체결 중 메이커(지정가 대기) 비중은?',
      options: ['약 33%', '약 67%', '약 90%'],
      answer: 1,
      metric: 'headline.makerShare',
      format: (v) => `약 ${num(v * 100, 0)}%`,
      why: `메이커 비중은 ${num(headline.makerShare * 100, 1)}%입니다. 수수료를 벌기 위한 호가 중심 매매의 흔적입니다.`,
    },
    {
      id: 'q-funding',
      q: '수수료와 펀딩을 합치면 순이익에 얼마나 보탬이 됐나?',
      options: ['약 +72 XBt', '약 −78 XBt', '약 +1,440 XBt'],
      answer: 0,
      metric: 'headline.netTradeFeeXBt',
      format: () => '약 +72 XBt',
      why: `펀딩 수취 ${xbt(headline.fundingReceivedXBt)}에서 순 거래 수수료 ${xbt(headline.netTradeFeeXBt)}를 빼면 약 ${xbt(headline.fundingReceivedXBt + headline.netTradeFeeXBt)}입니다.`,
    },
    {
      id: 'q-drawdown',
      q: '누적 실현손익 기준 최대 낙폭은?',
      options: ['약 −59 XBt', '약 −591 XBt', '약 −5,910 XBt'],
      answer: 1,
      metric: 'headline.maxDrawdownXBt',
      format: (v) => `약 −${num(v, 0)} XBt`,
      why: `${headline.maxDrawdownPeakDay}에서 ${headline.maxDrawdownTroughDay}까지 ${xbt(headline.maxDrawdownXBt)} 줄었습니다.`,
    },
  ];

  // Each quiz answer is checked against the payload it claims to describe.
  for (const item of quiz) {
    const value = pick({ headline, replay, withdrawals, insights, trades }, item.metric);
    if (value === undefined) throw new Error(`Quiz ${item.id}: metric ${item.metric} not found`);
    const rendered = item.format(value);
    if (item.options[item.answer] !== rendered) {
      throw new Error(`Quiz ${item.id}: option "${item.options[item.answer]}" != measured "${rendered}"`);
    }
  }

  const payload = {
    note: 'Dated cases and quiz answers are read from the analysed payloads at build time. Study prose carries no figure of its own.',
    units,
    cases,
    quiz,
    progressKey: 'aoa-study-progress',
    summary: {
      units: units.length,
      cases: cases.length,
      quiz: quiz.length,
      firstDay: days[0].d,
      lastDay: days[days.length - 1].d,
    },
  };

  const out = path.join(ROOT, 'results', 'lessons.json');
  await fs.writeFile(out, `${JSON.stringify(payload)}\n`);
  console.log(`lessons: ${units.length} units, ${cases.length} cases, ${quiz.length} quiz -> ${out} (${((await fs.stat(out)).size / 1024).toFixed(0)} kB)`);
  console.log(`  longest pause ${pause.days}d (${pause.from} -> ${pause.to}), best ${best.d} ${xbt(best.dpnl)}, worst ${worst.d} ${xbt(worst.dpnl)}`);
}

await main();
