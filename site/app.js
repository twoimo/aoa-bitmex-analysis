/* Plain browser JavaScript. No dependencies, remote assets, or analytics.
 * Public aggregates only; the same snapshot is embedded for file:// readers.
 */
(() => {
  'use strict';
  // GitHub Pages caches these files for ten minutes. index.html is versioned by
  // the build, and the data must move with it or a fresh page can read stale
  // aggregates and fail its own cross-checks.
  const DATA_VERSION = window.__dataVersion ? `?v=${window.__dataVersion}` : '';
  const FILES = ['meta', 'lessons', 'headline', 'validation', 'stated', 'withdrawals', 'symbols', 'attribution', 'monthly', 'insights', 'activity', 'balance', 'candles'];
  const DAY = 86400000;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const number = (v, digits = 0) => v === null ? '미산출' : Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : (() => { throw new Error('숫자 필드가 유효하지 않습니다.'); })();
  const signed = (v, digits = 2) => (v < 0 ? '−' : v > 0 ? '+' : '') + number(Math.abs(v), digits);
  const percent = (v, digits = 1) => number(v * 100, digits) + '%';
  const stamp = (v) => `<span class="verdict ${v}">${v.toUpperCase()}</span>`;
  const dateMs = (s) => Date.parse(s + 'T00:00:00Z');
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const satoshi = (v) => BigInt(v.toFixed(8).replace('.', ''));
  const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
  const satSum = (rows, key) => rows.reduce((a, r) => a + satoshi(r[key]), 0n);
  const fmtSat = (v, showSign = true) => {
    const n = BigInt(v), a = n < 0n ? -n : n;
    return (n < 0n ? '−' : showSign && n > 0n ? '+' : '') + (a / 100000000n).toLocaleString('en-US') + '.' + String(a % 100000000n).padStart(8, '0');
  };
  const safeURL = (raw) => {
    const u = new URL(raw);
    if (u.protocol !== 'https:') throw new Error('허용하지 않는 근거 링크');
    return esc(u.href);
  };
  // Bar replay, TradingView style: the cursor is a date, and stepping moves one
  // bar of whatever resolution the chart is currently drawing. null = live.
  let replayDays = null;      // daily state rows from replay.json
  let tape = null;            // per-day fills from trades.json (http only)
  let lastBarDay = null;      // day of the rightmost bar the chart drew
  let replayDate = null;      // replay cursor
  let currentBars = [];       // bar days of the series the chart is drawing
  let replayTimer = null;
  let replayStepMs = 90;
  const replayCutoff = () => replayDate;

  const audit = { state: 'loading', fieldsRead: new Set(), missingFields: [], checks: [], mode: '' };
  window.reportAudit = audit;

  // Missing fields fail visibly instead of becoming zero, undefined, or NaN.
  function strictData(value, path = 'data', cache = new WeakMap()) {
    if (value === null || typeof value !== 'object') return value;
    if (cache.has(value)) return cache.get(value);
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
        if (!(key in target)) {
          const field = `${path}.${key}`;
          audit.missingFields.push(field);
          throw new Error(`필수 데이터 필드 없음: ${field}`);
        }
        audit.fieldsRead.add(`${path}.${key}`);
        return strictData(Reflect.get(target, key, receiver), `${path}.${key}`, cache);
      },
    });
    cache.set(value, proxy);
    return proxy;
  }
  function check(ok, description) {
    if (!ok) throw new Error(`데이터 교차 검사 실패: ${description}`);
    audit.checks.push(description);
  }
  function validate(d) {
    const h = d.headline, w = d.meta.ledgerSatoshi;
    check(BigInt(w.deposits) + BigInt(w.withdrawals) + BigInt(w.realised) === BigInt(w.finalBalance) && BigInt(w.diff) === 0n, '정수 사토시 원장 대사');
    check(satoshi(h.depositsXBt) === BigInt(w.deposits) && satoshi(h.withdrawalsXBt) === BigInt(w.withdrawals) && satoshi(h.realisedXBt) === BigInt(w.realised) && satoshi(h.finalBalanceXBt) === BigInt(w.finalBalance), '히어로와 감사 원장 일치');
    check(h.orders === d.validation.summary.ordersChecked && h.orders === d.stated.announcement.measured.orders, '유효 주문 수 일치');
    check(d.activity.days.length === new Set(d.activity.days.map((r) => r.d)).size && d.activity.days.every((r) => Number.isInteger(r.f) && r.f >= 0 && r.d >= d.activity.summary.firstDay && r.d <= d.activity.summary.lastDay), '활동일 중복·기간·건수 검사');
    check(sum(d.activity.days, 'f') === h.fills && d.activity.days.filter((r) => r.f > 0).length === h.tradingDays, '일별 체결 합계·활동일 일치');
    check(d.activity.hourDow.length === 7 && d.activity.hourDow.every((r) => r.length === 24 && r.every(Number.isFinite)) && d.activity.hourDow.flat().reduce((a, b) => a + b, 0) === h.fills, '요일·시간대 체결 합계 일치');
    check(d.monthly.length === 46 && d.monthly[0].month === '2018-03' && d.monthly.at(-1).month === '2021-12' && d.monthly.every((r, i, a) => !i || r.month > a[i - 1].month), '46개월 기간과 순서');
    check(satSum(d.monthly, 'realisedXBt') === BigInt(w.realised) && satSum(d.monthly, 'withdrawalsXBt') === BigInt(w.withdrawals) && satSum(d.monthly, 'depositsXBt') === BigInt(w.deposits), '월별 금액 합계 일치');
    check(d.balance.monthly.length === d.monthly.length && d.balance.monthly.every((m, i) => ['month', 'endBalanceXBt', 'realisedXBt', 'withdrawalsXBt', 'depositsXBt'].every((key) => m[key] === d.monthly[i][key])), '잔고와 월별 시리즈 일치');
    check(satoshi(d.balance.monthly.at(-1).endBalanceXBt) === BigInt(w.finalBalance), '마지막 월말 잔고 일치');
    check(d.withdrawals.events.length === d.withdrawals.summary.completedWithdrawals && satSum(d.withdrawals.events, 'amountXBt') === -BigInt(w.withdrawals), '완료 출금 이벤트 합계 일치');
    check(d.withdrawals.events.filter((e) => e.round).length === d.withdrawals.summary.roundLotPattern.withdrawalsMatchingARoundLot && sum(d.withdrawals.ladder, 'count') === d.withdrawals.events.length, '출금 단위 분류 합계');
    check(d.withdrawals.events.filter((e) => e.daysSinceProfitPeak >= 0 && e.daysSinceProfitPeak <= 5).length === d.withdrawals.summary.timingVsProfitPeak.within5Days, '고점 이후 5일 내 출금 건수');
    const hold = d.insights.holdingPeriod;
    check(sum(hold.histogram, 'trips') === hold.histogramCoverage.classifiedTrips && hold.histogramCoverage.classifiedTrips + hold.histogramCoverage.unclassifiedTrips === hold.trips && hold.histogramCoverage.unclassifiedTrips >= 0, '보유기간 구간 합계와 미분류 건수 대사');
    check(h.netTradeFeeXBt === d.insights.feeComponents.netTradeFeeXBt, '순거래 수수료 필드 일치');
    check(/^[a-f0-9]{64}$/.test(d.meta.source.sha256), '원본 압축파일 해시 형식');
    const candles = d.candles.series;
    check(d.candles.resolution === '1W' && d.candles.offlineFallback === true
      && candles.every((r) => ['XBTUSD', 'ETHUSD'].includes(r.symbol) && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && Number.isFinite(dateMs(r.day))
        && ['open', 'high', 'low', 'close', 'volume'].every((k) => Number.isFinite(r[k]))
        && r.low > 0 && r.high >= Math.max(r.open, r.close) && r.low <= Math.min(r.open, r.close) && r.volume >= 0
        && Number.isInteger(r.accountFills) && r.accountFills >= 0), '주봉 스냅샷 필수 필드·OHLC·거래량 유효성');
    const btcDays = candles.filter((r) => r.symbol === 'XBTUSD').length;
    const ethDays = candles.filter((r) => r.symbol === 'ETHUSD').length;
    check(btcDays >= 700 && ethDays >= 500, '주봉이 전 역사를 덮는지 (BTC 2011~, ETH 2016~)');
    check(new Set(candles.map((r) => r.symbol + '/' + r.day)).size === candles.length, '캔들 종목·날짜 중복 없음');
    const activity = new Map(d.activity.days.map((r) => [r.d, r]));
    const weekSum = (startDay, key) => {
      let total = 0;
      for (let i = 0; i < 7; i += 1) {
        const d2 = isoDay(dateMs(startDay) + i * DAY);
        const a = activity.get(d2);
        if (a) total += key === 'f' ? a.f : a.n;
      }
      return total;
    };
    check(d.activity.days.every((r) => Number.isFinite(r.n) && r.n >= 0)
      && candles.filter((r) => r.accountFills > 0).every((r) => r.accountFills === weekSum(r.day, 'f') && Math.abs(r.accountNotionalXbt - weekSum(r.day, 'n')) < .01),
      '주봉의 계좌 체결 표시가 그 주 일별 활동 합계와 일치');
  }
  async function load() {
    const embedded = () => JSON.parse($('site-data').textContent);
    if (location.protocol === 'file:') return { payload: embedded(), mode: 'file' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const payload = Object.fromEntries(await Promise.all(FILES.map(async (name) => {
        const response = await fetch(`data/${name}.json${DATA_VERSION}`, { signal: controller.signal, cache: 'no-cache' });
        if (!response.ok) throw new Error(`${name}.json: HTTP ${response.status}`);
        return [`${name}.json`, await response.json()];
      })));
      return { payload, mode: 'json' };
    } catch (error) {
      controller.abort();
      return { payload: embedded(), mode: 'snapshot', reason: error.message };
    } finally { clearTimeout(timeout); }
  }

  let svgIndex = 0;
  let bindCharts = () => {};
  const text = (x, y, value, cls = '', anchor = 'start') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(value)}</text>`;
  const line = (x1, y1, x2, y2, cls = 'grid-line') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const tip = (label, extra = '') => `data-tip="${esc(label)}" aria-label="${esc(label)}" tabindex="-1" role="button" ${extra}`;
  const svg = (title, body, width = 1000, height = 300, nav = 'linear') => {
    const id = `plot-${++svgIndex}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="${id}-title ${id}-desc" data-keynav="${nav}"><title id="${id}-title">${esc(title)}</title><desc id="${id}-desc">방향키로 값을 탐색하고 Enter로 확인합니다. Escape로 툴팁을 닫습니다.</desc>${body}</svg>`;
  };
  const shortNumber = (n) => Math.abs(n) >= 1000 ? number(n / 1000, Math.abs(n) % 1000 ? 1 : 0) + 'k' : number(n);
  function extent(values) {
    const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
    const raw = (hi - lo || 1) / 4, power = 10 ** Math.floor(Math.log10(raw)), f = raw / power;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * power;
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil((hi || step) / step) * step, step };
  }
  function yAxis(e, x0, x1, top, bottom, unit) {
    const y = (v) => bottom - (v - e.lo) / (e.hi - e.lo) * (bottom - top);
    let markup = text(x0, top - 12, unit, 'axis-unit');
    for (let v = e.lo; v <= e.hi + e.step / 2; v += e.step) {
      const n = Math.abs(v) < e.step / 10 ? 0 : v;
      markup += line(x0, y(n), x1, y(n), n === 0 ? 'zero-line' : 'grid-line') + text(x0 - 10, y(n) + 3, shortNumber(n), '', 'end');
    }
    return { y, markup };
  }
  function monthLabels(months, x, y) {
    return months.map((m, i) => i === 0 || m.month.endsWith('-01') || i === months.length - 1 ? text(x(i), y, i === 0 || i === months.length - 1 ? m.month.replace('-', '.') : m.month.slice(0, 4), '', i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle') : '').join('');
  }
  // Tabs use one keyboard stop, arrow/Home/End navigation and real data scopes.
  function tabGroup(container, panelId, options, selected, change, field = 'period') {
    container.setAttribute('role', 'tablist');
    container.innerHTML = options.map(([key, label]) => `<button type="button" role="tab" id="${container.id}-${key}" aria-controls="${panelId}" aria-selected="${key === selected}" aria-pressed="${key === selected}" tabindex="${key === selected ? 0 : -1}" data-${field}="${key}">${esc(label)}</button>`).join('');
    const buttons = [...container.querySelectorAll('button')];
    const activate = (button) => {
      buttons.forEach((b) => {
        b.setAttribute('aria-selected', String(b === button));
        b.setAttribute('aria-pressed', String(b === button));
        b.tabIndex = b === button ? 0 : -1;
      });
      const panel = $(panelId);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', button.id);
      change(button.dataset[field]);
      if ($('chart-tooltip')) $('chart-tooltip').hidden = true;
      bindCharts();
    };
    container.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button && buttons.includes(button)) activate(button);
    });
    container.addEventListener('keydown', (event) => {
      const i = buttons.indexOf(document.activeElement);
      if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
      activate(buttons[next]);
    });
    activate(buttons.find((b) => b.dataset[field] === selected));
  }
  const YEARS = [['all', '전체'], ['2018', '2018'], ['2019', '2019'], ['2020', '2020'], ['2021', '2021']];
  function panelControls(id, render, scoped = true) {
    const figure = $(id).closest('figure');
    const toolbar = document.createElement('div');
    toolbar.className = 'panel-toolbar';
    toolbar.innerHTML = `<span class="mono">${scoped ? '표시 기간 / 원자료 날짜 기준' : '2018–2021 · 연도별 집계 없음'}</span><div class="segmented" id="${id}-periods" aria-label="${esc(figure.querySelector('h3').textContent)} 기간"></div>`;
    figure.querySelector('.chart-heading').after(toolbar);
    tabGroup(toolbar.lastElementChild, id, scoped ? YEARS : [['all', '전체 집계']], 'all', (range) => { $(id).dataset.range = range; render(range); });
  }
  function panelQuote(id, symbol, value, detail, cls = '') {
    const heading = $(id).closest('figure').querySelector('.chart-heading');
    let quote = heading.querySelector('.panel-quote');
    if (!quote) { quote = document.createElement('div'); quote.className = 'panel-quote'; heading.append(quote); }
    quote.innerHTML = `<span>${esc(symbol)}</span><strong class="${cls}">${esc(value)}</strong><span>${esc(detail)}</span>`;
  }
  function dateLabels(start, end, x, y, count = 4) {
    let body = '';
    for (let i = 0; i <= count; i++) {
      const ms = start + (end - start) * i / count;
      body += text(x(ms), y, isoDay(ms), '', i === 0 ? 'start' : i === count ? 'end' : 'middle');
    }
    return body;
  }
  function terminal(d) {
    const h = d.headline;
    $('ticker-strip').innerHTML = [
      ['원장 순실현손익', signed(h.realisedXBt), 'BTC', 'positive'],
      ['완료 출금', number(-h.withdrawalsXBt, 2), 'BTC', ''],
      ['최종 장부 잔고', number(h.finalBalanceXBt, 2), 'BTC', ''],
      ['양수 원장 항목 비율', percent(h.winRate, 2), '전체 기간', ''],
      ['Trade 체결', number(h.fills), '건', ''],
      ['메이커 체결 비중', percent(h.makerShare, 2), '건수 기준', ''],
    ].map(([label, value, unit, cls]) => `<div class="ticker-item"><small>${label}</small><strong class="${cls}">${value}</strong><em>${unit}</em></div>`).join('');
    sortable('market-table', '전체 기간 손익 상위 6종목 · 실시간 호가 아님', [
      { key: 'symbol', label: '종목' },
      { key: 'pnlXBt', label: '손익 BTC', numeric: true, signed: true, format: (v) => signed(v, 2) },
      { key: 'shareOfPnl', label: '기여 %', numeric: true, signed: true, format: (v) => percent(v, 1) },
    ], [...d.attribution].sort((a, b) => b.pnlXBt - a.pnlXBt).slice(0, 6), 1, true);
    // Default to the whole history: the account only traded 2018-2021, so a
    // recent-window default would hide everything this chart is for.
    let symbol = 'XBTUSD', range = 'all';
    const RANGES = [['1M', '1M'], ['3M', '3M'], ['6M', '6M'], ['1Y', '1Y'], ['2Y', '2Y'], ['3Y', '3Y'], ['5Y', '5Y'], ['10Y', '10Y'], ['all', 'ALL']];
    // Three months of daily bars: wide enough to see the position being built,
    // narrow enough that individual buy/sell arrows stay legible.
    const REPLAY_WINDOW_DAYS = 90;
    const RANGE_DAYS = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '2Y': 730, '3Y': 1095, '5Y': 1826, '10Y': 3652 };
    // Real charts change resolution with the range: a decade of daily candles is
    // sub-pixel mush, so long ranges are aggregated from the same daily series.
    const resolutionFor = (days) => (days <= 400 ? '1D' : days <= 2200 ? '1W' : '1M');

    const unpack = (payload) => {
      const out = new Map();
      for (const s2 of payload.series) {
        const bars = [];
        let t = s2.t0;
        for (let i = 0, k = 0; i < s2.bars.length; i += 6, k += 1) {
          t += s2.bars[i];
          const acct = s2.account ? s2.account[k] : null;
          bars.push({
            day: isoDay(t * DAY), open: s2.bars[i + 1], high: s2.bars[i + 2], low: s2.bars[i + 3],
            close: s2.bars[i + 4], volume: s2.bars[i + 5],
            accountFills: acct ? acct[0] : 0, accountNotionalXbt: acct ? acct[1] : 0,
          });
        }
        out.set(s2.panel, { meta: s2, bars });
      }
      return out;
    };
    const fromWeekly = (payload) => {
      const out = new Map();
      for (const panel of ['XBTUSD', 'ETHUSD']) {
        const bars = payload.series.filter((r) => r.symbol === panel).sort((a, b) => a.day.localeCompare(b.day));
        out.set(panel, { meta: (payload.sources || []).find((s2) => (s2.panel === 'BTC' ? 'XBTUSD' : 'ETHUSD') === panel) || null, bars });
      }
      return out;
    };
    const bucketBars = (bars, res) => {
      if (res === '1D') return bars;
      const keyOf = res === '1W'
        ? (b) => { const dt = new Date(dateMs(b.day)); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); }
        : (b) => b.day.slice(0, 7);
      const out = [];
      for (const b of bars) {
        const k = keyOf(b);
        const last = out[out.length - 1];
        if (last && last.k === k) {
          last.high = Math.max(last.high, b.high);
          last.low = Math.min(last.low, b.low);
          last.close = b.close;
          last.volume += b.volume;
          last.accountFills += b.accountFills;
          last.accountNotionalXbt += b.accountNotionalXbt;
        } else {
          out.push({ ...b, k });
        }
      }
      return out;
    };

    let source = fromWeekly(d.candles);
    let resolution = '1W';
    let resolutionLabel = '주봉 · 오프라인 스냅샷';
    // A linear price axis over 2011-2026 is useless: BTC's first years collapse
    // onto the baseline because the range spans four orders of magnitude. The
    // axis therefore switches to log automatically and can be forced either way.
    let scaleMode = 'auto';
    // Where the account actually traded. 'range' draws the price band it bought
    // and sold in for each bar; 'profile' draws notional by price level.
    let marks = 'range';
    let footprint = null;
    let footprintNote = '체결 위치를 불러오는 중';

    const render = () => {
      const entry = source.get(symbol);
      const meta = entry.meta || {};
      const cutoff = replayCutoff();
      const replaying = !!cutoff;
      // The replay steps through the account's own daily record, so while it runs
      // the chart is forced to daily bars over a rolling window that ends at the
      // cursor. The range selector drives the ordinary view.
      const spanDays0 = replaying
        ? REPLAY_WINDOW_DAYS
        : range === 'all'
          ? Math.round((dateMs(entry.bars.at(-1).day) - dateMs(entry.bars[0].day)) / DAY)
          : RANGE_DAYS[range] || 365;
      const res0 = resolutionFor(spanDays0);
      const resFull = bucketBars(entry.bars, res0);
      // The replay slider covers the account's own window, one step per day. Bars
      // before the account existed would have no state to show, so they stay as
      // context rather than as steps.
      const winFrom = replayDays ? replayDays[0].d : null;
      const winTo = replayDays ? replayDays[replayDays.length - 1].d : null;
      const replayBars = winFrom ? entry.bars.filter((b) => b.day >= winFrom && b.day <= winTo) : [];
      currentBars = (replayBars.length >= 2 ? replayBars : entry.bars).map((b) => b.day);
      const all = cutoff ? resFull.filter((b) => b.day <= cutoff) : resFull;
      if (!all.length) return;
      const last = all.at(-1), previous = all.at(-2) || last;
      lastBarDay = last.day;
      const end = dateMs(last.day);
      const spanDays = replaying
        ? REPLAY_WINDOW_DAYS
        : range === 'all'
          ? Math.round((end - dateMs(all[0].day)) / DAY)
          : RANGE_DAYS[range] || 365;
      // While replaying, the cursor stays at the right edge and the window
      // extends back only as far as there is data.
      const from = Math.max(end - spanDays * DAY, dateMs(all[0].day));
      const res = resolutionFor(spanDays);
      const rows = bucketBars(all.filter((r) => dateMs(r.day) >= from), res);
      const withMa = rows.map((r, i, arr) => ({
        ...r,
        ma7: i < 6 ? null : sum(arr.slice(i - 6, i + 1), 'close') / 7,
        ma20: i < 19 ? null : sum(arr.slice(i - 19, i + 1), 'close') / 20,
        ma99: i < 98 ? null : sum(arr.slice(i - 98, i + 1), 'close') / 99,
      }));
      const barSides = new Map();
      if (footprint && marks !== 'off') {
        const rows0 = footprint.daysBySymbol.get(symbol) || [];
        let r0 = 0;
        for (const bar of withMa) {
          let bf = 0, sf = 0;
          while (r0 < rows0.length && rows0[r0].day <= bar.day) { bf += rows0[r0].buyFills; sf += rows0[r0].sellFills; r0 += 1; }
        }
      }
      const maxSideN = Math.max(1, ...[...barSides.values()].map((v) => Math.max(v.bf, v.sf)));
      const sizeOf = (n) => 2.2 + 3.4 * Math.min(1, Math.sqrt((n || 0) / maxSideN));
      const dense = withMa.length > 120;
      let gid = 0;
      const tri = (xx, yy, dir, size, color, label) => {
        const h = size * 1.45;
        const gap = size * 1.9;
        const tipY = dir > 0 ? yy + gap - h / 2 : yy - gap + h / 2;
        const base = dir > 0 ? yy + gap + h / 2 : yy - gap - h / 2;
        const pts = `${(xx - size).toFixed(2)},${base.toFixed(2)} ${(xx + size).toFixed(2)},${base.toFixed(2)} ${xx.toFixed(2)},${tipY.toFixed(2)}`;
        return `<circle class="fill-halo" cx="${xx.toFixed(2)}" cy="${yy.toFixed(2)}" r="${(size * 2.2).toFixed(2)}" fill="${color}" opacity=".13"/>`
          + `<polygon class="fill-mark" points="${pts}" fill="${color}" stroke="var(--panel)" stroke-width="1.1" stroke-linejoin="round" ${tip(label)}/>`;
      };
      const W = 900, H = 372, L = 12, R = 78, T = 30, B = 244, VT = 280, VB = 334;
      const x = (ms) => L + 5 + (ms - from) / (end - from || DAY) * (W - L - R - 10);
      const prices = withMa.flatMap((r) => [r.low, r.high, ...(r.ma7 === null ? [] : [r.ma7]), ...(r.ma20 === null ? [] : [r.ma20]), ...(r.ma99 === null ? [] : [r.ma99])]);
      const low = Math.min(...prices), high = Math.max(...prices), padding = (high - low || high * .01) * .08;
      const lo = Math.max(low - padding, low * 0.5);
      const hi = high + padding;
      const useLog = scaleMode === 'log' || (scaleMode === 'auto' && hi / Math.max(lo, 1e-9) > 8);
      const y = useLog
        ? (v) => B - (Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * (B - T)
        : (v) => B - (v - lo) / (hi - lo) * (B - T);
      const maxVolume = Math.max(...withMa.map((r) => r.volume), 1);
      const vy = (v) => VB - v / maxVolume * (VB - VT);
      const slot = (end - from || DAY) / Math.max(withMa.length, 1);
      const bodyWidth = Math.max(.7, Math.min(11, slot / DAY * (W - L - R - 10) * .68));
      const decimals = symbol === 'ETHUSD' ? 2 : 0;
      let body = text(L, 14, `${meta.label || symbol} · ${res} · ${meta.venue || 'market'} · ${useLog ? 'LOG' : 'LIN'}`, 'axis-unit');
      for (let i = 0; i <= 4; i += 1) {
        const value = useLog
          ? Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * i / 4)
          : lo + (hi - lo) * i / 4;
        body += line(L, y(value), W - R, y(value)) + text(W - 6, y(value) + 3, number(value, decimals), '', 'end');
      }
      body += text(L, VT - 9, `Vol(BTC) ${shortNumber(last.volume)} · Vol(USDT) ${shortNumber(last.volume * last.close)}`, 'axis-unit') + line(L, VB, W - R, VB) + text(W - 6, VT + 4, shortNumber(maxVolume), '', 'end') + text(W - 6, VB + 3, '0', '', 'end');
      withMa.forEach((r) => {
        const xx = x(dateMs(r.day)), color = `var(--${r.close >= r.open ? 'profit' : 'loss'})`;
        body += `<line class="candle-wick" x1="${xx}" x2="${xx}" y1="${y(r.high)}" y2="${y(r.low)}" stroke="${color}" stroke-width="1"/>`;
        body += `<rect class="candle-body" data-day="${r.day}" x="${(xx - bodyWidth / 2).toFixed(2)}" y="${Math.min(y(r.open), y(r.close)).toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${Math.max(1, Math.abs(y(r.open) - y(r.close))).toFixed(2)}" fill="${color}"/>`;
        body += `<rect class="candle-volume" data-day="${r.day}" x="${(xx - bodyWidth / 2).toFixed(2)}" y="${vy(r.volume).toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${Math.max(.5, VB - vy(r.volume)).toFixed(2)}" fill="${color}" opacity=".55"/>`;
      });
      for (const [key, color, dash] of [['ma7', 'var(--brass)', ''], ['ma20', 'var(--text)', 'stroke-dasharray="4 3"']]) {
        let path = '', previousDay = null;
        withMa.forEach((r) => {
          if (r[key] === null) { previousDay = null; return; }
          const day = dateMs(r.day);
          path += `${previousDay !== null && day - previousDay <= 31 * DAY ? 'L' : 'M'}${x(day)},${y(r[key])}`;
          previousDay = day;
        });
        body += `<path class="${key}" d="${path}" fill="none" stroke="${color}" stroke-width="1.4" ${dash}/>`;
      }
      {
        let path = '', previousDay = null;
        withMa.forEach((r) => {
          if (r.ma99 === null) { previousDay = null; return; }
          const day = dateMs(r.day);
          path += `${previousDay !== null && day - previousDay <= 31 * DAY ? 'L' : 'M'}${x(day)},${y(r.ma99)}`;
          previousDay = day;
        });
        body += `<path class="ma99" d="${path}" fill="none" stroke="var(--quiet)" stroke-width="1.2"/>`;
      }
      body += line(L, y(last.close), W - R, y(last.close), 'last-price-line');
      body += `<rect class="last-price-box" x="${W - R + 4}" y="${(y(last.close) - 9).toFixed(2)}" width="68" height="18" rx="4"/>`;
      body += text(W - 6, y(last.close) + 3, number(last.close, decimals), 'last-price-label', 'end');
      if (cutoff) {
        const cx = x(dateMs(last.day));
        body += `<line class="replay-cursor" x1="${cx.toFixed(2)}" x2="${cx.toFixed(2)}" y1="${T}" y2="${VB}" stroke="var(--brass)" stroke-width="1" stroke-dasharray="3 3" opacity=".9"/>`;
        body += `<text x="${(cx + 4).toFixed(2)}" y="${T + 11}" font-size="9" fill="var(--brass)">리플레이</text>`;
      }
      withMa.forEach((r) => {
        const xx = x(dateMs(r.day));
        const label = `${symbol} · ${r.day} · ${res}`
          + `\nO ${number(r.open, 2)} / H ${number(r.high, 2)}`
          + `\nL ${number(r.low, 2)} / C ${number(r.close, 2)} USD`
          + `\n시장 거래량 ${shortNumber(r.volume)}`
          + `\nMA7 ${r.ma7 === null ? '구간 부족' : number(r.ma7, 2)} / MA20 ${r.ma20 === null ? '구간 부족' : number(r.ma20, 2)}`
          + `\n계좌 체결 ${number(r.accountFills)}건 (전 종목)`
          + (r.accountFills ? ` · 명목 ${number(r.accountNotionalXbt, 3)} BTC` : ' · 이 봉 거래 없음')
          + `\n출처 ${meta.venue || 'market'} · ${meta.first || ''}부터`;
        body += `<rect class="candle-mark" x="${(xx - Math.max(bodyWidth, 4) / 2).toFixed(2)}" y="${T}" width="${Math.max(bodyWidth, 4).toFixed(2)}" height="${VB - T}" fill="transparent" ${tip(label, `data-day="${r.day}" data-x="${xx}" data-y="${y(r.close)}" data-close="${r.close}" data-volume="${r.volume}" data-ma7="${r.ma7 ?? ''}" data-ma20="${r.ma20 ?? ''}"`)}/>`;
      });
      // ---- account fill footprint -------------------------------------------
      if (footprint && marks !== 'off') {
        const rows = footprint.daysBySymbol.get(symbol) || [];
        let ri = 0;
        for (let i = 0; i < withMa.length; i += 1) {
          const bar = withMa[i];
          const startMs = dateMs(bar.day);
          const endMs = i + 1 < withMa.length ? dateMs(withMa[i + 1].day) : startMs + DAY;
          while (ri < rows.length && dateMs(rows[ri].day) < startMs) ri += 1;
          let rj = ri;
          let bLow = null; let bHigh = null; let sLow = null; let sHigh = null; let bf = 0; let sf = 0;
          while (rj < rows.length && dateMs(rows[rj].day) < endMs) {
            const r = rows[rj];
            if (r.buyLow !== null) { bLow = bLow === null ? r.buyLow : Math.min(bLow, r.buyLow); bHigh = bHigh === null ? r.buyHigh : Math.max(bHigh, r.buyHigh); }
            if (r.sellLow !== null) { sLow = sLow === null ? r.sellLow : Math.min(sLow, r.sellLow); sHigh = sHigh === null ? r.sellHigh : Math.max(sHigh, r.sellHigh); }
            bf += r.buyFills; sf += r.sellFills; rj += 1;
          }
          if (bf || sf) barSides.set(bar.day, { bf, sf });
          if (marks === 'range') {
            const xx = x(startMs);
            const w = Math.max(bodyWidth, 1.6);
            // Two densities, two jobs. Zoomed in, the chart marks individual
            // trades the way a trading terminal does: a size-scaled arrow with a
            // dark outline pointing at the price that side traded at, plus a
            // letter when there is room for one. Zoomed out, arrows would pile
            // into mush, so each bar becomes one green-to-red ribbon spanning the
            // prices the account touched, read as bought-low sold-high.
            if (dense) {
              const lo2 = bLow === null ? sLow : sLow === null ? bLow : Math.min(bLow, sLow);
              const hi2 = bHigh === null ? sHigh : sHigh === null ? bHigh : Math.max(bHigh, sHigh);
              if (lo2 !== null) {
                body += `<linearGradient id="rg${gid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="var(--profit)"/><stop offset="1" stop-color="var(--loss)"/></linearGradient>`
                  + `<line class="fill-ribbon" data-side="${bf > sf ? 'buy' : 'sell'}" x1="${xx.toFixed(2)}" x2="${xx.toFixed(2)}" y1="${y(hi2).toFixed(2)}" y2="${y(lo2).toFixed(2)}" stroke="url(#rg${gid})" stroke-width="${w.toFixed(2)}" opacity=".62" ${tip(`${symbol} · ${bar.day}\n매수 ${number(bf)}건 · ${number(bLow, 2)} ~ ${number(bHigh, 2)}\n매도 ${number(sf)}건 · ${number(sLow, 2)} ~ ${number(sHigh, 2)}`)}/>`;
                gid += 1;
              }
            } else {
              if (bLow !== null) body += `<line class="fill-band" x1="${xx.toFixed(2)}" x2="${xx.toFixed(2)}" y1="${y(bHigh).toFixed(2)}" y2="${y(bLow).toFixed(2)}" stroke="var(--profit)" stroke-width="${w.toFixed(2)}" opacity=".3"/>`;
              if (sLow !== null) body += `<line class="fill-band" x1="${xx.toFixed(2)}" x2="${xx.toFixed(2)}" y1="${y(sHigh).toFixed(2)}" y2="${y(sLow).toFixed(2)}" stroke="var(--loss)" stroke-width="${w.toFixed(2)}" opacity=".3"/>`;
              const sideN = barSides.get(bar.day) || { bf: 0, sf: 0 };
              if (bLow !== null) body += tri(xx - (sLow !== null ? 5 : 0), y((bLow + bHigh) / 2), 1, sizeOf(sideN.bf), 'var(--profit)', `${symbol} · ${bar.day}\n매수 ${number(bf)}건\n가격 ${number(bLow, 2)} ~ ${number(bHigh, 2)}`);
              if (sLow !== null) body += tri(xx + (bLow !== null ? 5 : 0), y((sLow + sHigh) / 2), -1, sizeOf(sideN.sf), 'var(--loss)', `${symbol} · ${bar.day}\n매도 ${number(sf)}건\n가격 ${number(sLow, 2)} ~ ${number(sHigh, 2)}`);
              // Letters only when there is room between bars for one.
              if (bLow !== null) body += text(xx, y(bHigh) - 5, 'B', 'fill-label buy-label');
              if (sLow !== null) body += text(xx, y(sLow) + 11, 'S', 'fill-label sell-label');
            }
          }
        }
        if (marks === 'profile') {
          const buckets = footprint.profile.get(symbol) || [];
          const maxN = Math.max(...buckets.map((b2) => b2.n), 1);
          const bw = 96;
          for (const b2 of buckets) {
            const yy = y(b2.p);
            if (yy < T || yy > B) continue;
            const ww = Math.max(0.6, b2.n / maxN * bw);
            body += `<rect class="fill-profile" x="${(W - R - ww).toFixed(2)}" y="${(yy - 1.6).toFixed(2)}" width="${ww.toFixed(2)}" height="3.2" fill="var(--brass)" opacity=".42"/>`;
          }
          body += text(W - R - bw - 6, T - 6, '계좌 체결 가격대', 'axis-unit');
        }
      }
      const traded = withMa.filter((r) => r.accountFills > 0);
      const buyBars = withMa.filter((r) => barSides.has(r.day) && barSides.get(r.day).bf > 0).length;
      const sellBars = withMa.filter((r) => barSides.has(r.day) && barSides.get(r.day).sf > 0).length;
      body += text(L, VB - 16, `계좌 매수 ${number(buyBars)}봉 / 매도 ${number(sellBars)}봉 (거래 ${number(traded.length)} / ${number(withMa.length)})`, 'axis-unit');
      withMa.forEach((r) => {
        const side = barSides.get(r.day);
        if (!side) return;
        const xx = x(dateMs(r.day));
        const w = Math.max(bodyWidth, 2);
        // Two thin rows under the volume panel: green where the bar contained
        // buys, red where it contained sells. Readable at any bar density, which
        // letters are not.
        if (side.bf > 0) body += `<rect class="candle-mark" data-side="buy" x="${(xx - w / 2).toFixed(2)}" y="${VB - 10}" width="${w.toFixed(2)}" height="4" fill="var(--profit)" opacity=".9"/>`;
        if (side.sf > 0) body += `<rect class="candle-mark" data-side="sell" x="${(xx - w / 2).toFixed(2)}" y="${VB - 5}" width="${w.toFixed(2)}" height="4" fill="var(--loss)" opacity=".9"/>`;
      });
      body += dateLabels(from, end, x, VB + 23, 3);
      const host = $('candle-chart');
      host.innerHTML = svg(`${symbol} ${res} 시장 시세, 금색 눈금은 계좌가 거래한 봉`, body, W, H);
      Object.assign(host.dataset, { symbol, range, resolution: res, count: String(withMa.length), from: isoDay(from), to: last.day });
      const delta = (last.close - previous.close) / previous.close;
      $('candle-last').textContent = number(last.close, 2);
      $('candle-last').className = delta >= 0 ? 'positive' : 'negative';
      $('candle-change').textContent = `${signed(delta * 100, 2)}% · ${res} 기준 전봉 대비`;
      const markLabel = marks === 'range' ? '세로 막대는 그 봉에 계좌가 매수한 가격 범위(초록)와 매도한 가격 범위(빨강)입니다' : marks === 'profile' ? '오른쪽 가로 막대는 계좌 체결 명목금액을 가격대별로 모은 것입니다' : '체결 표시를 껐습니다';
      $('candle-note').textContent = `${meta.label || symbol} · ${meta.venue || '시장'} · ${isoDay(from)} → ${last.day} · ${number(withMa.length)}봉 (${res}) · ${resolutionLabel}. MA7/20은 봉 기준 단순이동평균. 금색 눈금은 계좌가 체결된 봉이고 이 구간에서 ${number(traded.length)}봉. ${markLabel}. ${footprintNote}. 출처는 실행내역(체결)이며 호가 주문은 파일에 없습니다.`;
      const readout = host.closest('figure').querySelector('.chart-readout');
      if (readout) readout.textContent = `${symbol} · ${last.day} 마지막 봉 · O ${number(last.open, 2)} / H ${number(last.high, 2)} / L ${number(last.low, 2)} / C ${number(last.close, 2)} USD`;
    };

    // The tape prints the fills behind whatever the chart is currently showing:
    // the replay cursor's day while replaying, otherwise the last drawn bar.
    const renderTape = () => {
      const body = $('market-trades-body');
      if (!body) return;
      // While replaying, the cursor's day. Otherwise the latest day the account
      // actually traded at or before the rightmost bar, so the tape is never
      // empty just because the chart runs to today.
      let day = replayDate || lastBarDay;
      if (!replayDate && tape && day) {
        const prefix = `${symbol}|`;
        let best = null;
        for (const key of Object.keys(tape.days)) {
          if (!key.startsWith(prefix)) continue;
          const d = key.slice(prefix.length);
          if (d <= day && (!best || d > best)) best = d;
        }
        if (best) day = best;
      }
      const label = $('tape-day');
      const stats = $('tape-stats');
      if (label) label.textContent = day ? `${symbol} · ${day}` : '—';
      if (!tape) {
        if (stats) stats.textContent = '온라인에서 불러옵니다';
        body.innerHTML = '<p class="tape-empty">체결 테이프는 네트워크로 불러오는 페이로드입니다. 오프라인에서는 표시하지 않습니다.</p>';
        return;
      }
      const rec = day ? tape.days[`${symbol}|${day}`] : null;
      if (!rec) {
        if (stats) stats.textContent = '체결 없음';
        body.innerHTML = `<p class="tape-empty">${esc(symbol)} 은 ${esc(day || '이 봉')}에 체결이 없습니다.</p>`;
        return;
      }
      if (stats) {
        stats.textContent = `체결 ${number(rec.f)}건 · 매수 ${number(rec.b)} / 매도 ${number(rec.s)} · VWAP ${number(rec.v, 2)} USD · 명목 ${number(rec.usd)} USD · ${esc(rec.t0)}~${esc(rec.t1)} UTC`;
      }
      body.innerHTML = rec.x.map((f, i) => `<div class="tape-row ${f.b ? 'buy' : 'sell'}${i === 0 ? ' newest' : ''}">`
        + `<span class="t">${esc(f.t)}</span>`
        + `<span class="p">${number(f.p, 2)}</span>`
        + `<span class="q">${number(f.q, 4)}</span>`
        + `</div>`).join('');
    };
    renderChart = () => { render(); renderReplay(); renderTape(); };
    tabGroup($('symbol-filter'), 'candle-chart', [['XBTUSD', 'XBTUSD'], ['ETHUSD', 'ETHUSD']], symbol, (next) => { symbol = next; render(); }, 'symbol');
    tabGroup($('candle-periods'), 'candle-chart', RANGES, range, (next) => { range = next; render(); });
    tabGroup($('candle-scale'), 'candle-chart', [['auto', 'AUTO'], ['log', 'LOG'], ['lin', 'LIN']], scaleMode, (next) => { scaleMode = next; render(); }, 'scale');
    tabGroup($('candle-marks'), 'candle-chart', [['range', '체결 범위'], ['profile', '가격대'], ['off', '끔']], marks, (next) => { marks = next; render(); }, 'marks');
    renderReplay();
    render();
    // The full daily history is ~9,400 bars, too large to embed for offline use.
    // It is fetched over http(s) only; under file:// the embedded weekly series
    // is what the chart shows, and the caption says so.
    renderTape();
    if (/^https?:/.test(location.protocol)) {
      fetch(`data/trades.json${DATA_VERSION}`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => { if (payload && payload.days) { tape = payload; renderTape(); } })
        .catch(() => {});
      fetch(`data/replay.json${DATA_VERSION}`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => {
          if (!payload || !payload.days) return;
          replayDays = payload.days;
          replayDate = null;
          const toggle = $('replay-toggle');
          if (toggle) {
            toggle.disabled = false;
            toggle.addEventListener('click', () => (replayTimer ? stopReplay() : startReplay()));
          }
          const prev = $('replay-prev');
          if (prev) prev.addEventListener('click', () => { stopReplay(); stepReplay(-1); });
          const next = $('replay-next');
          if (next) next.addEventListener('click', () => { stopReplay(); stepReplay(1); });
          const reset = $('replay-reset');
          if (reset) reset.addEventListener('click', () => { stopReplay(); replayDate = null; renderReplay(); renderChart(); });
          const range2 = $('replay-range');
          if (range2) range2.addEventListener('input', () => {
            stopReplay();
            replayDate = Number(range2.value) >= currentBars.length - 1 ? null : currentBars[Number(range2.value)];
            renderReplay();
            renderChart();
          });
          // The replay payload arrives after the first paint, and the slider's
          // step count is derived from it, so redraw the chart once it lands.
          renderChart();
          try {
            tabGroup($('replay-speed'), 'candle-chart', [['400', '1×'], ['90', '4×'], ['25', '16×']], '90', (next) => {
              replayStepMs = Number(next);
              if (replayTimer) { stopReplay(); startReplay(); }
            }, 'speed');
          } catch (error) { audit.missingFields.push(`replay-speed: ${error.message}`); }
        })
        .catch(() => {});
      fetch(`data/fill-footprint.json${DATA_VERSION}`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => {
          if (!payload || !payload.days) return;
          const bySymbol = new Map();
          for (const r of payload.days) {
            if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
            bySymbol.get(r.symbol).push(r);
          }
          const profile = new Map(Object.entries(payload.profile || {}));
          footprint = { daysBySymbol: bySymbol, profile, coverage: payload.coverage };
          symbolTable(payload.symbols);
          footprintNote = `계좌 체결 ${number(payload.coverage.chartedFills)} / ${number(payload.coverage.totalFills)}건 (${percent(payload.coverage.chartedShare, 1)}) 표시`;
          render();
        })
        .catch(() => {});
      fetch(`data/candles-daily.json${DATA_VERSION}`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => {
          if (!payload || !payload.series) return;
          source = unpack(payload);
          resolution = '1D';
          resolutionLabel = '일봉 · 런타임 로드';
          // The daily series replaces the embedded weekly one, which changes the
          // replay's step count, so redraw the chart and the slider together.
          renderChart();
        })
        .catch(() => {});
    }
  }

  const evidence = (file, field = '') => `<a class="evidence-link" href="data/${esc(file)}.json">근거: ${esc(file)}.json${field ? ' · ' + esc(field) : ''} ↗</a>`;
  const external = (url, label) => `<a href="${safeURL(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
  const metric = (value, unit, label, detail = '') => `<div class="stat-item"><div><strong>${esc(value)}</strong><span class="stat-unit">${esc(unit)}</span></div><p>${esc(label)}</p>${detail ? `<span class="stat-detail">${esc(detail)}</span>` : ''}</div>`;

  function introduction(d) {
    const h = d.headline, w = d.meta.ledgerSatoshi, c = d.meta.counts;
    $('hero-ledger').innerHTML = [
      ['누적 입금', w.deposits, ''], ['완료 출금', w.withdrawals, ''],
      ['원장 실현손익', w.realised, 'positive'], ['최종 장부 잔고', w.finalBalance, 'total'],
    ].map(([label, value, cls]) => `<div class="ledger-row ${cls === 'total' ? cls : ''}"><span class="ledger-label">${label}</span><span class="ledger-number ${cls === 'positive' ? cls : ''}">${fmtSat(value, cls !== 'total')}</span></div>`).join('');
    $('hero-ledger').setAttribute('aria-busy', 'false');
    $('reconcile-stamp').querySelector('strong').textContent = w.diff;
    $('reconcile-stamp').classList.add('verified');
    $('hero-stats').innerHTML = [[h.fills, '건', 'Trade 체결 행'], [h.orders, '개', '유효 주문 · 영 식별자 제외'], [h.tradingDays, '일', 'KST 기준 거래한 날'], [h.symbols, '종목', '체결 기록이 있는 종목']].map(([v, u, label]) => `<div class="hero-stat"><span class="value">${number(v)}<span class="suffix">${u}</span></span><span class="label">${label}</span></div>`).join('');
  }



  function sortable(id, caption, columns, rows, initial = 0, descending = false) {
    const table = $(id);
    table.innerHTML = `<caption>${esc(caption)}</caption><thead><tr>${columns.map((c, i) => `<th scope="col"${c.numeric ? ' class="numeric"' : ''} aria-sort="none"><button type="button" data-column="${i}" aria-label="${esc(c.label)} 정렬">${esc(c.label)} <span aria-hidden="true">↕</span></button></th>`).join('')}</tr></thead><tbody></tbody>`;
    let current = initial, desc = descending;
    const paint = () => {
      const key = columns[current].key;
      const sorted = rows.map((row, i) => ({ row, i })).sort((a, b) => {
        const av = a.row[key], bv = b.row[key];
        if (av === null || bv === null) return av === bv ? a.i - b.i : av === null ? 1 : -1;
        const delta = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'en', { numeric: true });
        return (desc ? -delta : delta) || a.i - b.i;
      });
      table.querySelectorAll('th').forEach((th, i) => {
        th.setAttribute('aria-sort', i === current ? desc ? 'descending' : 'ascending' : 'none');
        th.querySelector('span').textContent = i === current ? desc ? '↓' : '↑' : '↕';
      });
      table.querySelector('tbody').innerHTML = sorted.map(({ row }) => `<tr>${columns.map((c) => {
        const value = row[c.key], label = value === null ? '미산출' : c.format ? c.format(value) : value;
        const cls = [c.numeric ? 'numeric' : '', c.signed && value !== null ? value < 0 ? 'negative' : value > 0 ? 'positive' : '' : ''].filter(Boolean).join(' ');
        return `<td${cls ? ` class="${cls}"` : ''}>${esc(label)}</td>`;
      }).join('')}</tr>`).join('');
    };
    table.querySelector('thead').addEventListener('click', (e) => {
      const button = e.target.closest('button[data-column]');
      if (!button) return;
      const next = Number(button.dataset.column);
      desc = next === current ? !desc : false;
      current = next;
      paint();
    });
    paint();
  }




  function interactions() {
    const tooltip = $('chart-tooltip');
    const bound = new WeakSet();
    let active = null, dismissed = null;
    const hide = () => {
      tooltip.hidden = true;
      if (active) active.removeAttribute('aria-describedby');
      active = null;
      document.querySelectorAll('.crosshair').forEach((cross) => cross.setAttribute('visibility', 'hidden'));
    };
    const show = (el, pointer) => {
      if (el === dismissed) return;
      if (active && active !== el) active.removeAttribute('aria-describedby');
      active = el;
      tooltip.textContent = el.dataset.tip;
      tooltip.hidden = false;
      el.setAttribute('aria-describedby', 'chart-tooltip');
      const bounds = el.getBoundingClientRect();
      const px = pointer ? pointer.clientX : bounds.left + bounds.width / 2;
      const py = pointer ? pointer.clientY : bounds.top;
      const box = tooltip.getBoundingClientRect();
      tooltip.style.left = Math.max(12, Math.min(innerWidth - box.width - 12, px + 14)) + 'px';
      tooltip.style.top = Math.max(12, Math.min(innerHeight - box.height - 12, py + 18)) + 'px';
      const readout = el.closest('figure')?.querySelector('.chart-readout');
      if (readout) readout.textContent = el.dataset.tip.replace(/\n/g, ' · ');
      const chart = el.closest('svg'), cross = chart.querySelector('.crosshair');
      const markBox = el.getBBox(), view = chart.viewBox.baseVal;
      const x = Number(el.dataset.x ?? markBox.x + markBox.width / 2);
      const y = Number(el.dataset.y ?? markBox.y + markBox.height / 2);
      cross.innerHTML = line(x, 20, x, view.height - 30, '') + line(0, y, view.width, y, '') + `<circle cx="${x}" cy="${y}" r="3"/>`;
      cross.setAttribute('visibility', 'visible');
      cross.dataset.label = el.dataset.tip.split('\n')[0];
    };
    bindCharts = () => {
      hide();
      dismissed = null;
      document.querySelectorAll('svg[data-keynav]').forEach((chart) => {
      if (bound.has(chart)) return;
      bound.add(chart);
      const marks = [...chart.querySelectorAll('[data-tip]')];
      if (!marks.length) return;
      const cross = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      cross.setAttribute('class', 'crosshair');
      cross.setAttribute('aria-hidden', 'true');
      cross.setAttribute('visibility', 'hidden');
      chart.append(cross);
      let index = 0;
      marks[0].setAttribute('tabindex', '0');
      const syncIndex = (el) => {
        marks[index].setAttribute('tabindex', '-1');
        index = marks.indexOf(el);
        marks[index].setAttribute('tabindex', '0');
      };
      const select = (next) => {
        syncIndex(marks[Math.max(0, Math.min(marks.length - 1, next))]);
        dismissed = null;
        marks[index].focus({ preventScroll: true });
        marks[index].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        show(marks[index]);
      };
      // Snap to an actual observation, including on thin candles. No synthetic
      // price is interpolated across dates where this account did not trade.
      const nearest = (event) => {
        const direct = event.target.closest('[data-tip]');
        if (direct && marks.includes(direct)) return direct;
        const matrix = chart.getScreenCTM();
        if (!matrix) return null;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        if (point.y < 20 || point.y > chart.viewBox.baseVal.height - 28) return null;
        let best = null, distance = Infinity;
        for (const mark of marks) {
          const b = mark.getBBox();
          const dx = point.x - Number(mark.dataset.x ?? b.x + b.width / 2);
          const dy = point.y - Number(mark.dataset.y ?? b.y + b.height / 2);
          const score = chart.dataset.axis === 'y' ? Math.abs(dy) : ['calendar', 'hours'].includes(chart.dataset.keynav) ? dx * dx + dy * dy : Math.abs(dx);
          if (score < distance) { best = mark; distance = score; }
        }
        return best;
      };
      chart.addEventListener('pointermove', (event) => {
        const el = nearest(event);
        if (el) { if (el !== active && el !== dismissed) dismissed = null; show(el, event); }
        else hide();
      });
      chart.addEventListener('pointerleave', () => { dismissed = null; hide(); });
      chart.addEventListener('focusin', (event) => {
        if (event.target.matches('[data-tip]')) { syncIndex(event.target); dismissed = null; show(event.target); }
      });
      chart.addEventListener('focusout', hide);
      chart.addEventListener('click', (event) => {
        const el = nearest(event);
        if (el) select(marks.indexOf(el));
      });
      chart.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { dismissed = active; hide(); return; }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dismissed = null; show(marks[index]); return; }
        const type = chart.dataset.keynav;
        const step = type === 'calendar' ? { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } : type === 'hours' ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -24, ArrowDown: 24 } : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
        if (event.key in step || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          select(event.key === 'Home' ? 0 : event.key === 'End' ? marks.length - 1 : index + step[event.key]);
        }
      });
    });
    };
    bindCharts();
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { dismissed = active; hide(); } });
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, { passive: true });
    if ('IntersectionObserver' in window) {
      const nav = [...document.querySelectorAll('.topnav a,.sidebar nav a')];
      const observer = new IntersectionObserver((entries) => {
        const entry = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!entry) return;
        nav.forEach((link) => link.hash === '#' + entry.target.id ? link.setAttribute('aria-current', 'location') : link.removeAttribute('aria-current'));
      }, { rootMargin: '-15% 0px -65% 0px' });
      document.querySelectorAll('.report-section').forEach((section) => observer.observe(section));
    }
  }

  function keyNumbers(d) {
    const h = d.headline, i = d.insights, c = d.meta.counts;
    const dd = { dropXBt: h.maxDrawdownXBt, pct: h.maxDrawdownPct, peakDay: h.maxDrawdownPeakDay, troughDay: h.maxDrawdownTroughDay };
    $('key-numbers').innerHTML = [
      ['승률', percent(h.winRate, 1), `${number(c.winningEntries)}승 ${number(c.losingEntries)}패`, '원장 손익 항목'],
      ['손익비', number(h.payoffRatio, 2), `Profit Factor ${number(h.profitFactor, 2)}`, '평균 이익 ÷ 평균 손실'],
      ['출금 비중', percent(h.withdrawnShareOfProfit, 1), `${number(-h.withdrawalsXBt, 0)} BTC 인출`, '실현손익 대비'],
      ['메이커 비중', percent(h.makerShare, 1), `수수료 순액 ${number(h.netTradeFeeXBt, 2)} BTC`, '체결 건수 기준'],
      ['최대 낙폭', number(dd.dropXBt, 0), `${esc(dd.peakDay || '')} → ${esc(dd.troughDay || '')}`, 'BTC · 누적손익 고점 기준'],
      ['중위 보유', i.holdingPeriod.median, `${number(i.holdingPeriod.trips)}회 라운드트립`, '진입에서 청산까지'],
    ].map(([label, value, detail, sub]) => `<div class="stat-item"><strong>${value}</strong><p>${label}<span class="stat-detail">${detail}</span></p><span class="stat-detail">${sub}</span></div>`).join('');
  }

  function findings(d) {
    const a = d.attribution, h = d.headline;
    const btc = a.find((r) => r.symbol === 'XBTUSD');
    const eth = a.find((r) => r.symbol === 'ETHUSD');
    const worst = a.slice(-3).map((r) => r.symbol).join(', ');
    const dd = { dropXBt: h.maxDrawdownXBt, pct: h.maxDrawdownPct, peakDay: h.maxDrawdownPeakDay, troughDay: h.maxDrawdownTroughDay };
    const items = [
      ['수익은 두 종목에서 나왔습니다', `XBTUSD ${number(btc.pnlXBt, 0)} BTC + ETHUSD ${number(eth.pnlXBt, 0)} BTC = 전체의 ${percent(btc.shareOfPnl + eth.shareOfPnl, 1)}. 나머지 ${number(a.length - 2)}개 종목을 합쳐도 손실입니다(${esc(worst)} 등).`],
      ['자주 이기고 더 크게 잃습니다', `승률 ${percent(h.winRate, 1)}, 손익비 ${number(h.payoffRatio, 2)}. 승률이 조금만 내려가도 수익 구조가 무너지는 모양입니다.`],
      ['이익 대부분을 거래소 밖으로 뺐습니다', `실현손익 ${number(h.realisedXBt, 0)} BTC 중 ${percent(h.withdrawnShareOfProfit, 1)}인 ${number(-h.withdrawalsXBt, 0)} BTC를 출금했습니다. 출금은 10·20·50·100 BTC 같은 라운드 단위였고, 대부분 누적손익 고점 근처에서 이뤄졌습니다.`],
      ['수수료와 펀딩은 비용이 아니라 순수취였습니다', `메이커 비중 ${percent(h.makerShare, 1)}로 리베이트를 받아 순거래 수수료가 ${number(h.netTradeFeeXBt, 2)} BTC에 그쳤고, 펀딩은 ${number(h.fundingReceivedXBt, 2)} BTC를 받았습니다.`],
      ['마지막은 큰 미완결 낙폭입니다', `${esc(dd.peakDay || '')}부터 ${esc(dd.troughDay || '')}까지 누적손익이 ${number(dd.dropXBt, 0)} BTC 줄었습니다(${percent(dd.pct, 1)}). 파일은 포지션이 열린 채 끝납니다.`],
    ];
    $('findings-body').innerHTML = items.map(([title, body]) => `<article class="limit-item"><h3>${stamp('note')}${esc(title)}</h3><p>${esc(body)}</p></article>`).join('');
  }

  function verification(d) {
    const v = d.validation.summary, r = d.meta.ledgerSatoshi;
    const rows = [
      ['pass', '원장 대사', `입금 + 출금 + 실현손익 = 최종 잔고, 차이 ${Number(r.diff).toLocaleString('en-US')} 사토시`],
      ['pass', '공개 아카이브 대조', 'BitMEX 공개 체결 아카이브와 trdMatchID로 대조해 표본 81,268건 중 81,263건 일치. 미일치 5건은 아카이브가 공개하지 않는 청산 체결입니다.'],
      ['pass', '내부 정합성', `실행 식별자 중복 ${v.execIdDuplicates}건 · 주문 수량 불일치 ${v.orderQtyMismatches}건 · 펀딩 ${v.fundingQtyMatched} · 만기 정산 ${v.settlementsZeroed}`],
      ['note', '알려진 한계', '지갑 잔고 열은 하루 단위 반올림 스냅샷이라 시간가중수익률을 낼 수 없습니다. 2018-04-27·28 이틀의 잔고 차이는 미해결입니다.'],
      ['open', '확인되지 않은 것', '거래소 발급 여부와 계좌 소유자는 인증되지 않았습니다. 입출금은 공개 소스가 없어 대조하지 못했습니다.'],
    ];
    $('verify-body').innerHTML = `<div class="check-list">${rows.map(([verdict, title, body]) => `<div class="check-row"><span class="verdict ${verdict}">${verdict.toUpperCase()}</span><span class="check-name">${esc(title)}</span><span class="check-note">${esc(body)}</span></div>`).join('')}</div>`;
  }

  function symbolTable(rows) {
    const host = $('symbol-table');
    if (!host) return;
    if (!rows) {
      host.innerHTML = '<caption>온라인에서 불러옵니다</caption>';
      return;
    }
    const shown = rows.slice(0, 10);
    host.innerHTML = `<caption>체결이 있는 종목 ${number(rows.length)}개 중 상위 ${number(shown.length)}개 · 전 종목 집계에 포함</caption>`
      + '<thead><tr><th>종목</th><th class="numeric">체결</th><th class="numeric">명목 USD</th><th>기간</th></tr></thead>'
      + `<tbody>${shown.map((r) => `<tr><td>${esc(r.symbol)}${r.charted ? ' <span class="muted">차트</span>' : ''}</td><td class="numeric">${number(r.fills)}</td><td class="numeric">${shortNumber(r.notionalUsd)}</td><td class="mono">${esc(r.firstDay)} → ${esc(r.lastDay)}</td></tr>`).join('')}</tbody>`;
  }

  function replayRow(date) {
    if (!replayDays || !date) return null;
    let lo = 0;
    let hi = replayDays.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (replayDays[mid].d <= date) { found = replayDays[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  function replayIndex() {
    if (replayDate === null || !currentBars.length) return currentBars.length - 1;
    const i = currentBars.indexOf(replayDate);
    if (i >= 0) return i;
    let at = 0;
    for (let k = 0; k < currentBars.length; k += 1) if (currentBars[k] <= replayDate) at = k;
    return at;
  }

  function renderReplay() {
    const readout = $('replay-readout');
    const label = $('replay-date');
    const range2 = $('replay-range');
    if (!readout) return;
    if (!replayDays) {
      readout.innerHTML = '';
      if (label) label.textContent = '리플레이 준비 중';
      return;
    }
    const max = Math.max(0, currentBars.length - 1);
    if (range2) {
      range2.max = String(max);
      range2.value = String(replayIndex());
      range2.disabled = currentBars.length === 0;
    }
    const at = replayDate === null ? currentBars[max] : replayDate;
    if (label) label.textContent = replayDate === null ? '전체 보기' : `${at} · ${replayIndex() + 1}/${currentBars.length}봉`;
    const day = replayRow(at);
    if (!day || day.d > at) {
      readout.innerHTML = `<div><strong>0.00 BTC</strong><span>장부 잔고 · 거래 시작 전</span></div>`
        + `<div><strong>0건</strong><span>체결 · ${esc(at)}</span></div>`
        + `<div><strong>—</strong><span>누적 실현손익</span></div>`
        + `<div><strong>—</strong><span>누적 출금</span></div>`
        + `<div><strong>—</strong><span>순포지션</span></div>`;
      return;
    }
    readout.innerHTML = [
      ['장부 잔고', `${number(day.eq, 2)} BTC`, `${esc(day.d)} 기준`],
      ['누적 실현손익', `${number(day.pnl, 1)} BTC`, `입금 ${number(day.dep, 2)}`],
      ['누적 출금', `${number(day.wd, 0)} BTC`, `잔고 + 출금 = ${number(day.eq + day.wd, 1)}`],
      ['순포지션', `${signed(day.pos, 1)} BTC`, 'BTC·ETH 합산 · 음수는 숏'],
      ['그날 체결', `${number(day.f)}건`, `명목 ${shortNumber(day.n)} USD`],
    ].map(([label2, value, sub]) => `<div><strong>${value}</strong><span>${esc(label2)} · ${esc(sub)}</span></div>`).join('');
  }

  function stepReplay(delta) {
    if (!replayDays || !currentBars.length) return;
    // From 전체 보기 a forward step enters the replay at the first trading day,
    // the same place play starts, instead of doing nothing.
    if (replayDate === null) {
      if (delta < 0) { replayDate = currentBars[currentBars.length - 1]; renderReplay(); renderChart(); return; }
      replayDate = currentBars.find((b) => b >= replayDays[0].d) || currentBars[0];
      renderReplay();
      renderChart();
      return;
    }
    const i = replayIndex() + delta;
    if (i < 0) { replayDate = currentBars[0]; }
    else if (i >= currentBars.length - 1) { replayDate = null; }
    else { replayDate = currentBars[i]; }
    renderReplay();
    renderChart();
  }

  function stopReplay() {
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = null;
    const button = $('replay-toggle');
    if (button) { button.dataset.playing = 'false'; button.textContent = '▶ 리플레이'; }
  }

  function startReplay() {
    if (!replayDays || !currentBars.length) return;
    // Start where the account starts trading, not at the first bar of 2011:
    // otherwise the replay spends eight minutes on years with no fills.
    if (replayDate === null) {
      const first = replayDays[0].d;
      replayDate = currentBars.find((d) => d >= first) || currentBars[0];
    }
    const button = $('replay-toggle');
    if (button) { button.dataset.playing = 'true'; button.textContent = '❚❚ 정지'; }
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = setInterval(() => {
      if (!replayDays || !currentBars.length) { stopReplay(); return; }
      if (replayIndex() >= currentBars.length - 1) { replayDate = null; renderReplay(); renderChart(); stopReplay(); return; }
      stepReplay(1);
    }, replayStepMs);
  }

  // The candle renderer lives inside terminal(); keep a handle so replay can redraw.
  let renderChart = () => {};

  // ---- 워뇨띠 지혜 학습실 -------------------------------------------------
  // 8개 원칙을 단원으로, 파일에서 뽑은 사례와 자가 점검을 붙인 학습 화면이다.
  // 진도는 localStorage에 남기고, 사례를 누르면 차트가 그 날짜로 이동한다.
  function study(d) {
    const L = d.lessons;
    const key = L.progressKey;
    const readProgress = () => {
      try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
    };
    const writeProgress = (set) => {
      try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* 사생활 보호 모드 */ }
    };
    const done = readProgress();
    const caseById = new Map(L.cases.map((c) => [c.id, c]));

    const caseButton = (id, cls = 'study-case-link') => {
      const c = caseById.get(id);
      if (!c) return '';
      return `<button type="button" class="${cls}" data-day="${esc(c.day)}" data-case="${esc(c.id)}">`
        + `<span class="mono">${esc(c.day)}</span> ${esc(c.title)}</button>`;
    };

    const paintProgress = () => {
      const host = $('study-progress');
      if (!host) return;
      const n = done.size;
      const pct = L.units.length ? Math.round((n / L.units.length) * 100) : 0;
      host.innerHTML = `<div class="study-bar"><i style="width:${pct}%"></i></div>`
        + `<p><strong>${n}</strong> / ${L.units.length}개 단원 완료 · 사례 ${L.cases.length}개 · 점검 ${L.quiz.length}문항</p>`
        + `<button type="button" class="study-reset" id="study-reset">진도 초기화</button>`;
      const reset = $('study-reset');
      if (reset) reset.addEventListener('click', () => { done.clear(); writeProgress(done); paintUnits(); paintProgress(); });
    };

    const paintUnits = () => {
      const host = $('study-units');
      if (!host) return;
      host.innerHTML = L.units.map((u) => {
        const isDone = done.has(u.id);
        const verdict = u.verdict === 'pass' ? '파일과 일치' : u.verdict === 'note' ? '부분 확인' : '확인 불가';
        return `<details class="study-unit${isDone ? ' done' : ''}" data-unit="${esc(u.id)}">`
          + `<summary>`
          + `<span class="unit-no mono">${u.no}</span>`
          + `<span class="unit-title">${esc(u.title)}</span>`
          + `<span class="verdict ${esc(u.verdict)}">${verdict}</span>`
          + `<span class="unit-mark mono">${isDone ? '완료' : ''}</span>`
          + `</summary>`
          + `<div class="unit-body">`
          + `<p class="unit-quote">${esc(u.quote)}<span class="fine"> · ${esc(u.source)}</span></p>`
          + `<div class="unit-grid">`
          + `<div><h4>파일에서 잰 값</h4><p>${esc(u.measuredKo || u.measured)}</p></div>`
          + `<div><h4>읽기</h4><p>${esc(u.read)}</p></div>`
          + `<div><h4>배울 점</h4><p>${esc(u.lesson)}</p></div>`
          + `<div><h4>스스로 점검</h4><p>${esc(u.check)}</p></div>`
          + `</div>`
          + `<div class="unit-foot">`
          + `<span class="unit-cases">${u.caseIds.map((id) => caseButton(id)).join('')}</span>`
          + `<button type="button" class="study-done" data-unit="${esc(u.id)}">${isDone ? '완료 취소' : '학습 완료로 표시'}</button>`
          + `</div></div></details>`;
      }).join('');
    };

    const paintCases = () => {
      const host = $('study-cases');
      if (!host) return;
      host.innerHTML = L.cases.map((c) => `<article class="study-case" id="case-${esc(c.id)}">`
        + `<div class="case-head"><h4>${esc(c.title)}</h4><span class="mono">${esc(c.day)}</span></div>`
        + `<dl class="case-figures">${c.figures.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join('')}</dl>`
        + `<p>${esc(c.note)}</p>`
        + `<button type="button" class="study-case-link" data-day="${esc(c.day)}">차트에서 이 날 보기</button>`
        + `</article>`).join('');
    };

    const paintQuiz = () => {
      const host = $('study-quiz');
      if (!host) return;
      host.innerHTML = L.quiz.map((q) => `<div class="quiz-item" data-quiz="${esc(q.id)}">`
        + `<p class="quiz-q">${esc(q.q)}</p>`
        + `<div class="quiz-options">${q.options.map((o, i) => `<button type="button" data-pick="${i}">${esc(o)}</button>`).join('')}</div>`
        + `<p class="quiz-why" hidden>${esc(q.why)}</p>`
        + `</div>`).join('');
    };

    // 사례를 누르면 리플레이 커서를 그 날짜로 옮기고 차트를 화면에 올린다.
    const focusDay = (day) => {
      if (replayDays && currentBars.length) {
        replayDate = currentBars.includes(day) ? day : (currentBars.find((b) => b >= day) || currentBars[0]);
        renderReplay();
        renderChart();
      }
      const chart = $('chart');
      if (chart) chart.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const host = $('wisdom-body');
    if (!host) return;
    host.innerHTML = `<div class="study-progress" id="study-progress"></div>`
      + `<div class="study-units" id="study-units"></div>`
      + `<h3 class="study-sub">사례 <span class="mono">파일에서 뽑은 날짜</span></h3>`
      + `<div class="study-cases" id="study-cases"></div>`
      + `<h3 class="study-sub">자가 점검 <span class="mono">정답은 파일에서 계산</span></h3>`
      + `<div class="study-quiz" id="study-quiz"></div>`;

    paintProgress();
    paintUnits();
    paintCases();
    paintQuiz();

    host.addEventListener('click', (event) => {
      const dayBtn = event.target.closest('[data-day]');
      if (dayBtn) { focusDay(dayBtn.dataset.day); return; }
      const doneBtn = event.target.closest('.study-done');
      if (doneBtn) {
        const id = doneBtn.dataset.unit;
        if (done.has(id)) done.delete(id); else done.add(id);
        writeProgress(done);
        paintUnits();
        paintProgress();
        const again = host.querySelector(`.study-unit[data-unit="${id}"]`);
        if (again) again.open = true;
        return;
      }
      const pick = event.target.closest('[data-pick]');
      if (pick) {
        const item = pick.closest('.quiz-item');
        const quiz = L.quiz.find((q) => q.id === item.dataset.quiz);
        const chosen = Number(pick.dataset.pick);
        item.querySelectorAll('[data-pick]').forEach((b) => {
          const i = Number(b.dataset.pick);
          b.dataset.state = i === quiz.answer ? 'correct' : (i === chosen ? 'wrong' : 'idle');
        });
        item.querySelector('.quiz-why').hidden = false;
      }
    });
  }

  async function main() {
    try {
      const loaded = await load();
      audit.mode = loaded.mode;
      const data = Object.fromEntries(FILES.map((name) => {
        if (!Object.hasOwn(loaded.payload, name + '.json')) throw new Error(`누락된 공개 집계: ${name}.json`);
        return [name, loaded.payload[name + '.json']];
      }));
      const d = strictData(data);
      // Each block is independent: a failure in one must not blank the page.
      // Each block is independent so one failure does not blank the page, but a
      // failure still puts the page into a visibly failed state rather than
      // quietly rendering partial numbers.
      const failed = [];
      for (const [name, fn] of [['validate', validate], ['introduction', introduction], ['terminal', terminal], ['keyNumbers', keyNumbers], ['findings', findings], ['study', study], ['verification', verification], ['interactions', interactions]]) {
        try { fn(d); } catch (error) { failed.push(`${name}: ${error.message}`); audit.missingFields.push(`${name}: ${error.message}`); }
      }
      if (failed.length) {
        audit.state = 'error';
        audit.error = failed.join(' / ');
        if ($('data-status')) $('data-status').textContent = '데이터 확인 실패';
        const stamp = $('reconcile-stamp');
        stamp.classList.remove('verified');
        stamp.querySelector('strong').textContent = '—';
        if ($('load-notice')) { $('load-notice').hidden = false; $('load-notice').textContent = `표시하지 못한 항목이 있습니다. ${failed.join(' / ')}`; }
        return;
      }
      check(![...document.querySelectorAll('svg')].some((s) => /(?:NaN|Infinity|undefined)/.test(s.innerHTML)), 'SVG 좌표와 레이블 유효성');
      $('foot-meta').textContent = `sha256 ${esc(d.meta.source.sha256.slice(0, 16))}… · 원본 CSV 미포함`;
      $('data-status').textContent = `${esc(d.meta.window.firstFill.slice(0, 10))} → ${esc(d.meta.window.lastFill.slice(0, 10))} · ${number(d.headline.fills)} 체결`;
      $('repo-link').href = d.meta.repository;
      if ($('chart-eyebrow')) {
        const src = d.candles.sources || [];
        const b = src.find((s2) => s2.panel === 'BTC') || {};
        const e = src.find((s2) => s2.panel === 'ETH') || {};
        $('chart-eyebrow').textContent = `시장 차트 · BTC ${esc(b.venue || '')} ${esc(b.first || '')} → 오늘 · ETH ${esc(e.venue || '')} ${esc(e.first || '')} → 오늘 · 초록·빨강은 계좌 체결`;
      }
      audit.state = 'ready';
      if ($('data-status')) $('data-status').textContent = `${esc(d.meta.window.firstFill.slice(0, 10))} → ${esc(d.meta.window.lastFill.slice(0, 10))} · ${number(d.headline.fills)} 체결`;
      if (loaded.mode === 'snapshot' && $('load-notice')) {
        $('load-notice').hidden = false;
        $('load-notice').textContent = `JSON을 읽지 못해 HTML에 포함된 ${d.meta.generatedAt} 집계 스냅샷을 표시합니다. 최신 집계와 다를 수 있습니다.`;
      }
    } catch (error) {
      audit.state = 'error';
      audit.error = error.message;
      console.error('보고서 렌더링 실패:', error);
      if ($('data-status')) $('data-status').textContent = '데이터 확인 실패';
      $('hero-ledger').setAttribute('aria-busy', 'false');
      $('reconcile-stamp').classList.remove('verified');
      $('reconcile-stamp').querySelector('strong').textContent = '—';
      if ($('load-notice')) {
        $('load-notice').hidden = false;
        $('load-notice').textContent = `보고서를 표시하지 못했습니다. ${error.message} 공개 JSON 또는 내장 스냅샷을 확인해 주세요.`;
      }
    }
  }
  main();
})();
