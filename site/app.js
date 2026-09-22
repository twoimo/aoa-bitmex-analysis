/* Plain browser JavaScript. No dependencies, remote assets, or analytics.
 * Public aggregates only; the same snapshot is embedded for file:// readers.
 */
(() => {
  'use strict';
  // GitHub Pages caches these files for ten minutes. index.html is versioned by
  // the build, and the data must move with it or a fresh page can read stale
  // aggregates and fail its own cross-checks.
  const DATA_VERSION = window.__dataVersion ? `?v=${window.__dataVersion}` : '';
  const FILES = ['meta', 'headline', 'validation', 'stated', 'withdrawals', 'symbols', 'attribution', 'monthly', 'insights', 'activity', 'balance', 'candles'];
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
      $('chart-tooltip').hidden = true;
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
    let symbol = 'XBTUSD', range = '1Y';
    const RANGES = [['1M', '1M'], ['3M', '3M'], ['6M', '6M'], ['1Y', '1Y'], ['2Y', '2Y'], ['3Y', '3Y'], ['5Y', '5Y'], ['10Y', '10Y'], ['all', 'ALL']];
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

    const render = () => {
      const entry = source.get(symbol);
      const meta = entry.meta || {};
      const all = entry.bars;
      if (!all.length) return;
      const last = all.at(-1), previous = all.at(-2) || last;
      const end = dateMs(last.day);
      const spanDays = range === 'all' ? Math.round((end - dateMs(all[0].day)) / DAY) : (RANGE_DAYS[range] || 365);
      const from = range === 'all' ? dateMs(all[0].day) : end - spanDays * DAY;
      const res = resolutionFor(spanDays);
      const rows = bucketBars(all.filter((r) => dateMs(r.day) >= from), res);
      const withMa = rows.map((r, i, arr) => ({
        ...r,
        ma7: i < 6 ? null : sum(arr.slice(i - 6, i + 1), 'close') / 7,
        ma20: i < 19 ? null : sum(arr.slice(i - 19, i + 1), 'close') / 20,
      }));
      const W = 900, H = 372, L = 12, R = 78, T = 30, B = 244, VT = 280, VB = 334;
      const x = (ms) => L + 5 + (ms - from) / (end - from || DAY) * (W - L - R - 10);
      const prices = withMa.flatMap((r) => [r.low, r.high, ...(r.ma7 === null ? [] : [r.ma7]), ...(r.ma20 === null ? [] : [r.ma20])]);
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
      body += text(L, VT - 9, '시장 거래량', 'axis-unit') + line(L, VB, W - R, VB) + text(W - 6, VT + 4, shortNumber(maxVolume), '', 'end') + text(W - 6, VB + 3, '0', '', 'end');
      withMa.forEach((r) => {
        const xx = x(dateMs(r.day)), color = `var(--${r.close >= r.open ? 'profit' : 'loss'})`;
        body += `<line class="candle-wick" x1="${xx}" x2="${xx}" y1="${y(r.high)}" y2="${y(r.low)}" stroke="${color}" stroke-width="1"/>`;
        body += `<rect class="candle-body" data-day="${r.day}" x="${(xx - bodyWidth / 2).toFixed(2)}" y="${Math.min(y(r.open), y(r.close)).toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${Math.max(1, Math.abs(y(r.open) - y(r.close))).toFixed(2)}" fill="${color}"/>`;
        body += `<rect class="candle-volume" data-day="${r.day}" x="${(xx - bodyWidth / 2).toFixed(2)}" y="${vy(r.volume).toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${Math.max(.5, VB - vy(r.volume)).toFixed(2)}" fill="${color}" opacity=".55"/>`;
      });
      const traded = withMa.filter((r) => r.accountFills > 0);
      body += text(L, VB - 6, `계좌 거래 ${number(traded.length)} / ${number(withMa.length)}봉`, 'axis-unit');
      traded.forEach((r) => {
        const xx = x(dateMs(r.day));
        body += `<rect class="candle-mark" x="${(xx - Math.max(bodyWidth, 2) / 2).toFixed(2)}" y="${VB - 4}" width="${Math.max(bodyWidth, 2).toFixed(2)}" height="4" fill="var(--brass)" opacity=".85"/>`;
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
      body += line(L, y(last.close), W - R, y(last.close), 'last-price-line');
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
      body += dateLabels(from, end, x, VB + 23, 3);
      const host = $('candle-chart');
      host.innerHTML = svg(`${symbol} ${res} 시장 시세, 금색 눈금은 계좌가 거래한 봉`, body, W, H);
      Object.assign(host.dataset, { symbol, range, resolution: res, count: String(withMa.length), from: isoDay(from), to: last.day });
      const delta = (last.close - previous.close) / previous.close;
      $('candle-last').textContent = number(last.close, 2);
      $('candle-last').className = delta >= 0 ? 'positive' : 'negative';
      $('candle-change').textContent = `${signed(delta * 100, 2)}% · ${res} 기준 전봉 대비`;
      $('candle-note').textContent = `${meta.label || symbol} · ${meta.venue || '시장'} · ${isoDay(from)} → ${last.day} · ${number(withMa.length)}봉 (${res}) · ${resolutionLabel}. MA7/20은 봉 기준 단순이동평균입니다. 금색 눈금은 계좌가 체결된 봉이고, 이 구간에서 ${number(traded.length)}봉입니다.`;
      const readout = host.closest('figure').querySelector('.chart-readout');
      if (readout) readout.textContent = `${symbol} · ${last.day} 마지막 봉 · O ${number(last.open, 2)} / H ${number(last.high, 2)} / L ${number(last.low, 2)} / C ${number(last.close, 2)} USD`;
    };

    tabGroup($('symbol-filter'), 'candle-chart', [['XBTUSD', 'XBTUSD'], ['ETHUSD', 'ETHUSD']], symbol, (next) => { symbol = next; render(); }, 'symbol');
    tabGroup($('candle-periods'), 'candle-chart', RANGES, range, (next) => { range = next; render(); });
    tabGroup($('candle-scale'), 'candle-chart', [['auto', 'AUTO'], ['log', 'LOG'], ['lin', 'LIN']], scaleMode, (next) => { scaleMode = next; render(); }, 'scale');
    render();
    // The full daily history is ~9,400 bars, too large to embed for offline use.
    // It is fetched over http(s) only; under file:// the embedded weekly series
    // is what the chart shows, and the caption says so.
    if (/^https?:/.test(location.protocol)) {
      fetch(`data/candles-daily.json${DATA_VERSION}`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => {
          if (!payload || !payload.series) return;
          source = unpack(payload);
          resolution = '1D';
          resolutionLabel = '일봉 · 런타임 로드';
          render();
        })
        .catch(() => {});
    }
  }
  function monthlyPanels(d) {
    let pnl = 0n, out = 0n, peak = 0;
    const full = d.balance.monthly.map((m) => {
      pnl += satoshi(m.realisedXBt); out -= satoshi(m.withdrawalsXBt); peak = Math.max(peak, m.endBalanceXBt);
      return { ...m, pnl: Number(pnl) / 1e8, out: Number(out) / 1e8, peak, drawdown: peak ? (m.endBalanceXBt - peak) / peak : 0 };
    });
    for (const id of ['cumulative-chart', 'monthly-chart', 'balance-chart']) panelControls(id, (range) => {
      const rows = full.filter((m) => range === 'all' || m.month.startsWith(range));
      const W = 1000, H = 292, L = 62, R = 25, T = 28, B = 248;
      const x = (i) => L + (i + .5) / rows.length * (W - L - R);
      const key = id === 'cumulative-chart' ? 'pnl' : id === 'monthly-chart' ? 'realisedXBt' : 'endBalanceXBt';
      const values = rows.flatMap((m) => id === 'cumulative-chart' ? [m.pnl, m.out] : id === 'balance-chart' ? [m.endBalanceXBt, m.peak] : [m.realisedXBt]);
      const { y, markup } = yAxis(extent(values), L, W - R, T, B, 'BTC');
      const bw = (W - L - R) / rows.length * .68;
      let body = markup;
      if (id === 'cumulative-chart') {
        const before = full[full.indexOf(rows[0]) - 1];
        for (const [field, color, dash] of [['pnl', 'var(--profit)', ''], ['out', 'var(--brass)', 'stroke-dasharray="6 4"']]) {
          const path = `M${L},${y(before ? before[field] : 0)}` + rows.map((m, i) => `H${x(i)}V${y(m[field])}`).join('');
          body += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" ${dash}/>`;
        }
      } else if (id === 'balance-chart') {
        const path = rows.map((m, i) => `${i ? 'L' : 'M'}${x(i)},${y(m.endBalanceXBt)}`).join('');
        const peakPath = rows.map((m, i) => `${i ? 'L' : 'M'}${x(i)},${y(m.peak)}`).join('');
        const reverse = [...rows].reverse().map((m, i) => `L${x(rows.length - 1 - i)},${y(m.endBalanceXBt)}`).join('');
        body += `<path class="balance-area" d="${path}L${x(rows.length - 1)},${B}H${x(0)}Z" fill="var(--profit)" opacity=".1"/>`;
        body += `<path class="drawdown-area" d="${peakPath}${reverse}Z" fill="var(--loss)" opacity=".18"/>`;
        body += `<path d="${peakPath}" fill="none" stroke="var(--loss)" stroke-dasharray="4 4" opacity=".6"/><path d="${path}" fill="none" stroke="var(--profit)" stroke-width="2"/>`;
      }
      rows.forEach((m, i) => {
        const value = m[key];
        if (id === 'monthly-chart') body += `<rect x="${x(i) - bw / 2}" y="${Math.min(y(value), y(0))}" width="${bw}" height="${Math.max(.8, Math.abs(y(value) - y(0)))}" fill="var(--${value < 0 ? 'loss' : 'profit'})"/>`;
        const label = id === 'cumulative-chart' ? `${m.month} 월말 · BTC\n누적 실현손익 ${number(m.pnl, 8)}\n누적 출금 ${number(m.out, 8)}\n두 누계의 차이 ${number(m.pnl - m.out, 8)} (잔고 아님)\n기간을 바꿔도 누계는 전체 이력을 유지합니다.` : id === 'monthly-chart' ? `${m.month}\n원장 순실현손익 ${signed(value, 8)} BTC` : `${m.month} 월말\n장부 잔고 ${number(value, 8)} BTC\n이전 월말 최고 ${number(m.peak, 8)} BTC\n월말 관측 낙폭 ${signed(m.drawdown * 100, 2)}%\n출금과 반올림 포함 · 계좌 평가액이 아님`;
        body += `<rect x="${x(i) - bw / 2}" y="${T}" width="${bw}" height="${B - T}" fill="transparent" ${tip(label, `data-month="${m.month}" data-value="${value}" data-x="${x(i)}" data-y="${y(value)}" data-drawdown="${m.drawdown}"`)}/>`;
      });
      body += monthLabels(rows, x, B + 25);
      $(id).classList.add('wide-plot');
      $(id).innerHTML = svg(id === 'balance-chart' ? '월말 장부 잔고와 월말 고점 대비 감소, 평가액 아님' : id === 'monthly-chart' ? '월별 순실현손익' : '월말 누적 실현손익과 출금', body, W, H);
      const last = rows.at(-1), prev = full[full.indexOf(last) - 1];
      const delta = prev && prev[key] !== 0 ? (last[key] - prev[key]) / Math.abs(prev[key]) : null;
      panelQuote(id, id === 'balance-chart' ? 'BOOK / BTC' : 'PNL / BTC', signed(last[key], 2), `${last.month} · ${delta === null ? '비교 기준 없음' : signed(delta * 100, 2) + '% 전월 대비 / |전월 값|'}`, last[key] < 0 ? 'negative' : 'positive');
    });
    $('monthly-note').textContent = `마지막 3개월의 원장 실현손익은 ${signed(sum(full.slice(-3), 'realisedXBt'))} BTC입니다. 월별 확정 손익만 보여주며 미실현손익과 장중 낙폭은 포함하지 않습니다.`;
    const balanceFigure = $('balance-chart').closest('figure');
    balanceFigure.querySelector('figcaption').textContent = '붉은 음영은 전체 이력의 이전 월말 잔고 최고점과 관측 잔고의 차이입니다. 출금과 반올림도 반영됩니다. 이 곡선은 미실현손익을 포함한 계좌 평가액·전략 수익률·장중 최대 낙폭이 아닙니다.';
    const legend = document.createElement('div'); legend.className = 'line-legend';
    legend.innerHTML = '<span><i class="key-line profit"></i>월말 장부 잔고</span><span><i class="key-box loss"></i>이전 월말 고점과의 차이</span>';
    $('balance-chart').before(legend);
  }
  function dailyPanel(d) {
    panelControls('daily-chart', (range) => {
      const rows = d.activity.days.filter((r) => range === 'all' || r.d.startsWith(range));
      const start = dateMs(range === 'all' ? d.activity.summary.firstDay : `${range}-01-01`), end = dateMs(range === 'all' ? d.activity.summary.lastDay : `${range}-12-31`);
      const W = 1000, H = 350, L = 60, R = 25;
      const x = (ms) => L + (ms - start) / (end - start) * (W - L - R);
      const fills = yAxis(extent(rows.map((r) => r.f)), L, W - R, 30, 151, '체결 / 건');
      const notional = yAxis(extent(rows.map((r) => r.n)), L, W - R, 204, 305, '명목금액 / BTC 환산');
      let body = fills.markup + notional.markup;
      const bw = Math.max(.6, (W - L - R) / ((end - start) / DAY + 1) * .7);
      rows.forEach((r) => {
        const xx = x(dateMs(r.d));
        body += `<rect x="${xx - bw / 2}" y="${fills.y(r.f)}" width="${bw}" height="${151 - fills.y(r.f)}" fill="var(--profit)"/>`;
        body += `<rect x="${xx - bw / 2}" y="${notional.y(r.n)}" width="${bw}" height="${305 - notional.y(r.n)}" fill="var(--brass)"/>`;
        body += `<rect x="${xx - 2}" y="30" width="4" height="275" fill="transparent" ${tip(`${r.d} · KST · 전체 종목\nTrade 체결 ${number(r.f)}건\n명목금액 ${number(r.n, 4)} BTC 환산\n거래 규모이며 잔고·레버리지 아님`, `data-day="${r.d}" data-fills="${r.f}" data-notional="${r.n}" data-x="${xx}" data-y="${fills.y(r.f)}"`)}/>`;
      });
      body += dateLabels(start, end, x, 332, 4);
      $('daily-chart').innerHTML = svg('일별 체결 수와 BTC 환산 명목금액, 분리된 두 축', body, W, H);
      $('daily-chart').classList.add('wide-plot');
      panelQuote('daily-chart', 'ALL SYMBOLS / FILLS', number(rows.at(-1).f) + '건', rows.at(-1).d + ' 마지막 활동일 · 활동량, 손익 아님');
    });
  }
  function feePanel(d) {
    const f = d.insights.feeComponents;
    const rows = [{ label: '메이커 리베이트', value: -f.makerRebateXBt }, { label: '테이커 수수료', value: -f.takerFeeXBt }, { label: '펀딩 순수취', value: f.fundingReceivedXBt }];
    panelControls('fees-chart', () => {
      const W = 1000, H = 192, L = 138, R = 25, T = 30, B = 148, e = extent(rows.map((r) => r.value));
      const x = (v) => L + (v - e.lo) / (e.hi - e.lo) * (W - L - R);
      let body = text(L, 14, 'BTC / 수취 (+) · 지급 (−)', 'axis-unit');
      for (let n = e.lo; n <= e.hi; n += e.step) body += line(x(n), T - 5, x(n), B, n === 0 ? 'zero-line' : 'grid-line') + text(x(n), B + 24, n, '', 'middle');
      rows.forEach((r, i) => {
        const yy = T + i * 40;
        body += text(L - 14, yy + 16, r.label, '', 'end') + `<rect x="${Math.min(x(0), x(r.value))}" y="${yy}" width="${Math.abs(x(r.value) - x(0))}" height="25" fill="var(--${r.value < 0 ? 'loss' : 'profit'})" ${tip(`${r.label}\n${signed(r.value, 8)} BTC\n원장 손익에 이미 포함 · 중복 합산 금지`)}/>`;
      });
      $('fees-chart').innerHTML = svg('수수료와 펀딩의 수취 및 지급', body, W, H);
      $('fees-chart').querySelector('svg').dataset.axis = 'y';
      panelQuote('fees-chart', 'NET / BTC', signed(f.fundingReceivedXBt - f.netTradeFeeXBt, 2), '전 기간 구성 · 시점별 등락률 미산출', 'positive');
    }, false);
  }
  function histogram(id, rows, valueKey, unit, describe, height = 250) {
    const W = 550, L = 50, R = 14, T = 28, B = height - 48;
    const { y, markup } = yAxis(extent(rows.map((r) => r[valueKey])), L, W - R, T, B, unit);
    const step = (W - L - R) / rows.length, bw = step * .65;
    let body = markup;
    rows.forEach((r, i) => {
      const x = L + i * step + step / 2, value = r[valueKey];
      body += `<rect x="${x - bw / 2}" y="${y(value)}" width="${bw}" height="${Math.max(.8, B - y(value))}" fill="var(--${Object.hasOwn(r, 'unclassified') ? 'muted' : 'brass'})" ${tip(describe(r))}/>`;
      body += text(x, B + 21, r.label, '', 'middle');
      body += text(x, y(value) - 7, shortNumber(value), 'value-label', 'middle');
    });
    $(id).innerHTML = svg(unit + ' 분포', body, W, height);
  }
  function calendar(d) {
    const first = dateMs(d.activity.summary.firstDay), last = dateMs(d.activity.summary.lastDay);
    const days = new Map(d.activity.days.map((r) => [r.d, r]));
    const heat = (v) => v === 0 ? 0 : v < 100 ? 1 : v < 500 ? 2 : v < 1500 ? 3 : v < 5000 ? 4 : 5;
    const KO = ['월', '화', '수', '목', '금', '토', '일'];
    let html = '';
    for (let year = 2018; year <= 2021; year++) {
      const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1), offset = (new Date(start).getUTCDay() + 6) % 7;
      const L = 93, T = 29, S = 16.3, cell = 13.8;
      const coords = (ms) => { const n = (ms - start) / DAY + offset; return { x: L + Math.floor(n / 7) * S, y: T + (n % 7) * S, dow: n % 7 }; };
      const count = d.activity.days.filter((r) => r.d.startsWith(String(year)) && r.f > 0).length;
      let body = text(0, 65, year, 'year-label') + text(1, 88, count + ' 활동일', 'axis-unit');
      [0, 3, 6].forEach((i) => { body += text(L - 10, T + i * S + 10, KO[i], '', 'end'); });
      for (let month = 0; month < 12; month++) {
        const c = coords(Date.UTC(year, month, 1));
        body += text(c.x, 16, (month + 1) + '월', 'calendar-month');
        if (month) body += `<path d="M${c.x + S - 1},${T - 4}V${T + c.dow * S - 1}H${c.x - 1}V${T + 7 * S - 2}" fill="none" stroke="var(--brass)" opacity=".35" stroke-width=".7"/>`;
      }
      for (let ms = start; ms < end; ms += DAY) {
        const date = isoDay(ms), c = coords(ms), covered = ms >= first && ms <= last;
        const r = days.get(date), fills = r ? r.f : 0;
        const label = `${date} (${KO[c.dow]}) · KST\n체결 ${number(fills)}건${fills === 0 ? ' · 공개 파일 내 Trade 없음' : ''}`;
        body += `<rect x="${c.x}" y="${c.y}" width="${cell}" height="${cell}" rx="1.3" fill="${covered ? `var(--heat${heat(fills)})` : 'none'}" ${covered ? tip(label, `data-day="${date}" data-fills="${fills}"`) : 'stroke="var(--line)" stroke-width=".6" aria-hidden="true"'}/>`;
      }
      html += `<div class="calendar-year" data-year="${year}">${svg(year + '년 일별 체결 수', body, 976, 156, 'calendar')}</div>`;
    }
    $('calendar').innerHTML = html;
    const duration = (last - first) / DAY + 1;
    $('calendar-summary').textContent = `${d.activity.summary.firstDay} → ${d.activity.summary.lastDay} · ${number(duration)}일 중 ${number(d.headline.tradingDays)}활동일`;
    $('calendar-note').textContent = `${number(duration - d.headline.tradingDays)}일에는 공개 파일 안에 Trade가 없습니다. 최대 ${number(d.activity.summary.maxFillsPerActiveDay)}체결이 중간 값을 덮지 않도록 비선형 건수 구간으로 명암을 나눴습니다. 범위 밖 칸은 빈 윤곽으로 표시합니다. 좁은 화면은 달력을 좌우로 스크롤할 수 있습니다.`;
    tabGroup($('year-filter'), 'calendar', YEARS, 'all', (year) => {
      $('calendar').dataset.range = year;
      $('calendar').querySelectorAll('.calendar-year').forEach((el) => { el.hidden = year !== 'all' && el.dataset.year !== year; });
      $('calendar').closest('figure').querySelector('.chart-readout').textContent = `${year === 'all' ? '2018–2021' : year} · 날짜를 선택하면 체결 수를 표시합니다.`;
    }, 'year');
    const W = 550, L = 32, T = 30, sx = 21, sy = 24, labels = ['일', '월', '화', '수', '목', '금', '토'];
    let body = '', maximum = { value: -1, dow: 0, hour: 0 };
    const level = (n) => n === 0 ? 0 : n < 1000 ? 1 : n < 5000 ? 2 : n < 10000 ? 3 : n < 20000 ? 4 : 5;
    for (let h = 0; h < 24; h++) if (h % 3 === 0 || h === 23) body += text(L + h * sx + 8, 16, String(h).padStart(2, '0'), '', 'middle');
    [1, 2, 3, 4, 5, 6, 0].forEach((dow, row) => {
      body += text(L - 12, T + row * sy + 13, labels[dow], '', 'end');
      for (let h = 0; h < 24; h++) {
        const v = d.activity.hourDow[dow][h];
        if (v > maximum.value) maximum = { value: v, dow, hour: h };
        body += `<rect x="${L + h * sx}" y="${T + row * sy}" width="18" height="19" rx="1.5" fill="var(--heat${level(v)})" ${tip(`${labels[dow]}요일 ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 KST\n체결 ${number(v)}건 · 전체의 ${percent(v / d.headline.fills, 2)}`)}/>`;
      }
    });
    $('hour-dow').innerHTML = svg('요일과 시간대별 체결 수', body, W, 222, 'hours');
    $('hour-legend').innerHTML = ['0', '1–999', '1k–4,999', '5k–9,999', '10k–19,999', '20k+'].map((s, i) => `<span><i class="heat-${i}"></i>${s}</span>`).join('');
    $('hour-note').textContent = `가장 많은 체결은 ${labels[maximum.dow]}요일 ${maximum.hour}시대의 ${number(maximum.value)}건입니다. 활동 빈도이며, 이 시간대의 수익성이나 우위를 뜻하지 않습니다.`;
    const ranges = [[1, 100, '1–99'], [100, 500, '100–499'], [500, 1500, '500–1.4k'], [1500, 5000, '1.5k–4.9k'], [5000, Infinity, '5k+']];
    panelControls('fills-hist', (range) => {
      const days = d.activity.days.filter((r) => (range === 'all' || r.d.startsWith(range)) && r.f > 0);
      const rows = ranges.map(([lo, hi, label]) => ({ label, count: days.filter((r) => r.f >= lo && r.f < hi).length }));
      histogram('fills-hist', rows, 'count', '일수', (r) => `${r.label} 체결/일\n${number(r.count)}일 · 선택 기간 활동일의 ${percent(r.count / days.length)}`, 222);
      panelQuote('fills-hist', 'ACTIVE DAYS', number(days.length) + '일', `${range === 'all' ? '2018–2021' : range} 합계 · 등락률 미산출`);
    });
    panelControls('hour-dow', () => {}, false);
    panelQuote('hour-dow', 'FILLS / KST', number(d.headline.fills) + '건', '전 기간 합계 · 등락률 미산출');
    $('fills-note').textContent = `활동일 중위값 ${number(d.headline.medianFillsPerActiveDay)}체결, 90백분위 ${number(d.activity.summary.p90FillsPerActiveDay)}체결입니다. 체결 수는 의사결정이나 매매 횟수와 다릅니다.`;
  }
  function financialCharts(d) {
    const months = d.balance.monthly, W = 1000, H = 292, L = 62, R = 25, T = 28, B = 248;
    let pnl = 0n, out = 0n;
    const points = months.map((m) => { pnl += satoshi(m.realisedXBt); out -= satoshi(m.withdrawalsXBt); return { month: m.month, pnl: Number(pnl) / 1e8, out: Number(out) / 1e8 }; });
    const x = (i) => L + (i + 1) / months.length * (W - L - R);
    let axis = yAxis(extent(points.flatMap((r) => [r.pnl, r.out])), L, W - R, T, B, 'BTC');
    let body = axis.markup;
    for (const [key, color, dash] of [['pnl', 'var(--profit)', ''], ['out', 'var(--brass)', 'stroke-dasharray="7 4"']]) {
      let path = `M${L},${axis.y(0)}`;
      points.forEach((p, i) => { path += `H${x(i)}V${axis.y(p[key])}`; });
      body += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.4" ${dash}/>`;
    }
    points.forEach((p, i) => { body += `<rect x="${x(i) - 8}" y="${T}" width="16" height="${B - T}" fill="transparent" ${tip(`${p.month} 월말 · BTC\n누적 실현손익 ${number(p.pnl, 8)}\n누적 출금 ${number(p.out, 8)}\n두 누계의 차이 ${number(p.pnl - p.out, 8)} (잔고 아님)`, `data-month="${p.month}"`)}/>`; });
    body += monthLabels(months, x, B + 25);
    $('cumulative-chart').classList.add('wide-plot');
    $('cumulative-chart').innerHTML = svg('월말 누적 실현손익과 누적 출금의 계단형 비교', body, W, H);
    const barX = (i) => L + (i + .5) / months.length * (W - L - R), barWidth = (W - L - R) / months.length * .66;
    axis = yAxis(extent(months.map((m) => m.realisedXBt)), L, W - R, T, B, 'BTC');
    body = axis.markup;
    months.forEach((m, i) => { const value = m.realisedXBt; body += `<rect x="${barX(i) - barWidth / 2}" y="${Math.min(axis.y(value), axis.y(0))}" width="${barWidth}" height="${Math.max(.8, Math.abs(axis.y(value) - axis.y(0)))}" fill="var(--${value < 0 ? 'loss' : 'profit'})" ${tip(`${m.month}\n원장 순실현손익 ${signed(value, 8)} BTC`, `data-month="${m.month}" data-value="${value}"`)}/>`; });
    body += monthLabels(months, barX, B + 25);
    $('monthly-chart').classList.add('wide-plot');
    $('monthly-chart').innerHTML = svg('월별 순실현손익, 위는 이익 아래는 손실', body, W, H);
    const lastThree = months.slice(-3);
    $('monthly-note').textContent = `마지막 3개월의 원장 실현손익은 ${signed(sum(lastThree, 'realisedXBt'))} BTC입니다. 월별 확정 손익만 보여주며, 미실현손익과 장중 낙폭은 포함하지 않습니다.`;
    axis = yAxis(extent(months.map((m) => m.endBalanceXBt)), L, W - R, T, B, 'BTC');
    const bx = (i) => L + i / (months.length - 1) * (W - L - R);
    body = axis.markup + `<path d="${months.map((m, i) => `${i ? 'L' : 'M'}${bx(i)},${axis.y(m.endBalanceXBt)}`).join('')}" fill="none" stroke="var(--brass)" stroke-width="2.2"/>`;
    months.forEach((m, i) => { body += `<circle cx="${bx(i)}" cy="${axis.y(m.endBalanceXBt)}" r="4" fill="var(--brass)" ${tip(`${m.month} 월말\n장부 잔고 ${number(m.endBalanceXBt, 8)} BTC\n출금과 반올림의 영향을 받는 잔고 열 관측값`, `data-month="${m.month}" data-value="${m.endBalanceXBt}"`)}/>`; });
    body += monthLabels(months, bx, B + 25);
    $('balance-chart').classList.add('wide-plot');
    $('balance-chart').innerHTML = svg('월말 장부 잔고, 전략 수익률이 아님', body, W, H);

    const attrs = [...d.attribution].sort((a, b) => Math.abs(b.pnlXBt) - Math.abs(a.pnlXBt)).slice(0, 12);
    const AW = 550, AL = 95, AR = 62, AT = 20, rowH = 26, AB = AT + attrs.length * rowH;
    const min = Math.min(0, ...attrs.map((a) => a.pnlXBt)), max = Math.max(...attrs.map((a) => a.pnlXBt));
    const ax = (v) => AL + (v - min) / (max - min) * (AW - AL - AR);
    body = '';
    [0, 500, 1000, 1500, 2000].filter((v) => v <= max).forEach((v) => { body += line(ax(v), AT - 5, ax(v), AB, v === 0 ? 'zero-line' : 'grid-line') + text(ax(v), AB + 22, shortNumber(v), '', 'middle'); });
    attrs.forEach((a, i) => {
      const yy = AT + i * rowH;
      body += text(AL - 10, yy + 12, a.symbol, '', 'end');
      body += `<rect x="${Math.min(ax(0), ax(a.pnlXBt))}" y="${yy}" width="${Math.max(1, Math.abs(ax(a.pnlXBt) - ax(0)))}" height="17" fill="var(--${a.pnlXBt < 0 ? 'loss' : 'profit'})" ${tip(`${a.symbol}\n원장 실현손익 ${signed(a.pnlXBt, 4)} BTC\n손익 항목 ${number(a.closes)}건 · 총손익 기여 ${percent(a.shareOfPnl, 2)}`)}/>`;
      body += text(a.pnlXBt < 0 ? ax(0) + 5 : ax(a.pnlXBt) + 6, yy + 12, signed(a.pnlXBt, 1), 'value-label');
    });
    body += text(AW - AR, AB + 38, 'BTC', 'axis-unit', 'end');
    $('attribution-chart').innerHTML = svg('종목별 실현손익 기여도', body, AW, AB + 48);
    const combined = d.attribution.filter((s) => ['XBTUSD', 'ETHUSD'].includes(s.symbol)).reduce((a, s) => a + s.pnlXBt, 0);
    $('attribution-note').textContent = `XBTUSD와 ETHUSD 두 종목이 총 원장 손익의 ${percent(combined / d.headline.realisedXBt)}를 차지합니다. 거래량 대비 성과를 비교한 수치는 아닙니다.`;
    const hold = d.insights.holdingPeriod;
    $('hold-summary').textContent = `${number(hold.trips)}개 수량 대응 · 중위값 ${hold.median} · 미분류 ${number(hold.histogramCoverage.unclassifiedTrips)}개`;
    const holdRows = hold.histogram.map((r) => ({ label: r.label === '>30d' ? '30d+' : r.label, trips: r.trips }));
    if (hold.histogramCoverage.unclassifiedTrips) holdRows.push({ label: '미분류', trips: hold.histogramCoverage.unclassifiedTrips, unclassified: true });
    histogram('hold-chart', holdRows, 'trips', 'FIFO 대응 건수', (r) => `${r.label}\n${number(r.trips)}개 · 전체의 ${percent(r.trips / hold.trips, 2)}${Object.hasOwn(r, 'unclassified') ? '\n원본 구간 합계에서 빠진 대응 · 원인 미확인' : ''}`, AB + 48);
    $('hold-chart').closest('figure').querySelector('figcaption').textContent = `FIFO 대응의 경과시간입니다. m=분, h=시간, d=일. 구간은 왼쪽 포함·오른쪽 제외이며 폭이 다릅니다. 구간 합계 ${number(hold.histogramCoverage.classifiedTrips)}개와 전체의 차이 ${number(hold.histogramCoverage.unclassifiedTrips)}개는 미분류로 표시했습니다. 실제 포지션 수명이나 시간당 밀도가 아닙니다.`;
    const LW = 550, LL = 45, LR = 18, LT = 25, LB = 230, start = dateMs('2018-03-05'), end = dateMs('2021-12-31');
    const lx = (day) => LL + (dateMs(day) - start) / (end - start) * (LW - LL - LR), ly = (v) => LB - Math.log1p(v) / Math.log1p(500) * (LB - LT);
    body = text(LL, 12, '추정 BTC', 'axis-unit');
    [0, 1, 10, 50, 100, 400].forEach((v) => { body += line(LL, ly(v), LW - LR, ly(v)) + text(LL - 8, ly(v) + 3, v, '', 'end'); });
    [2019, 2020, 2021].forEach((y) => { body += text(lx(`${y}-01-01`), LB + 23, y, '', 'middle'); });
    body += text(LL, LB + 23, '2018', '', 'start');
    d.withdrawals.events.forEach((e) => { body += `<circle cx="${lx(e.date)}" cy="${ly(e.baseXBt)}" r="4.2" fill="${e.round ? 'var(--brass)' : 'var(--panel)'}" stroke="var(--brass)" stroke-width="1.2" ${tip(`${e.date}\n실제 차감 ${number(e.amountXBt, 8)} BTC\n추정 단위 ${number(e.baseXBt, 8)} BTC\n${e.round ? '정수 BTC 후보' : '기타 / 미분류'} · 수수료 후보 ${e.feeXBt === null ? '미분류' : number(e.feeXBt, 4) + ' BTC'}`)}/>`; });
    $('lot-chart').innerHTML = svg('완료 출금 이벤트별 추정 출금 단위', body, LW, 270);
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
    $('record-body').innerHTML = `<div class="record-grid"><div class="record-overview"><h3>체결 파일 4개, 지갑 파일 1개</h3><p>체결 파일에는 Trade 외에 Funding과 Settlement 행도 있습니다. 지갑의 취소 출금 ${number(c.cancelledWithdrawals)}건은 현금흐름 합산에서 제외합니다.</p><div class="record-counts"><div><strong>${number(c.executionRows)}</strong><span>실행내역 행</span></div><div><strong>${number(c.walletTransactions)}</strong><span>지갑 거래 행</span></div><div><strong>${number(c.ledgerPnlEntries)}</strong><span>원장 손익 항목</span></div></div><p>Funding ${number(c.fundingRows)}행 · Settlement ${number(c.settlementRows)}행. 원장 손익 항목, 주문, FIFO 수량 대응은 서로 다른 집계 단위입니다.</p>${evidence('meta', 'counts')}</div><div><div class="coverage"><div class="coverage-label">Trade 체결 기간 <span>UTC 가정 / 원본 시각</span></div><div class="coverage-bar" style="--coverage:99.5%"></div><p>${esc(d.meta.window.firstFill.slice(0, 10))} → ${esc(d.meta.window.lastFill.slice(0, 10))}</p></div><div class="coverage"><div class="coverage-label">지갑 원장 기간 <span>파일의 날짜 그대로</span></div><div class="coverage-bar"></div><p>${esc(d.meta.window.firstLedgerEvent)} → ${esc(d.meta.window.lastLedgerEvent)}</p></div><div class="coverage"><div class="coverage-label">공개 파일의 출처 <span>소유자 독립 인증 미완료</span></div><p>${external(d.meta.source.post, '거래내역 공개 게시글')}</p></div><p class="unit-note">단위: JSON 필드의 <code>XBt</code>는 코인 단위로 환산된 값이며 이 페이지에서는 BTC로 표기합니다. 원본 정수 금액은 10⁸로 나눕니다. 체결·요일 차트는 KST, 지갑 월별 집계는 파일 날짜 기준입니다.</p>${evidence('meta', 'window / source / ledgerSatoshi')}</div></div>`;
  }

  function validationReport(d) {
    const s = d.validation.summary, c = d.meta.counts;
    const rows = [
      ['최종 원장 금액 대사', '0 satoshi 차이', '입금 + 완료 출금 + 실현손익 = 최종 잔고. 출금은 음수로 합산합니다.'],
      ['실행 식별자 중복', `${number(s.execIdDuplicates)} / ${number(c.executionRows)}행`, '식별자 값은 공개하지 않고 중복 검사 건수만 제공합니다.'],
      ['시장 체결 식별자 반복', `${number(s.trdmatchidDuplicatePairs)}회 반복`, '원인을 확인하려면 거래소 시장 기록과 대조해야 합니다. 반복 값 자체는 공개하지 않습니다.'],
      ['주문 수량과 체결 합계', `${number(s.orderQtyMismatches)} / ${number(s.ordersChecked)}개 불일치`, '영 식별자를 제외한 주문별 체결 수량 합계와 최종 누적 수량이 일치합니다.'],
      ['펀딩 시점 포지션 수량', `${s.fundingQtyMatched}행 일치`, '체결로 재구성한 포지션 수량과 펀딩 행의 수량을 비교했습니다.'],
      ['만기 정산 후 포지션', `${s.settlementsZeroed}행 잔량 0`, '정산 행을 반영하면 해당 포지션이 정확히 0이 됩니다.'],
      ['기간 종료 시 미청산 포지션', 'XBTUSD −29,080,100계약', '파일은 포지션이 열린 상태로 끝납니다. 이후 청산이나 미실현손익을 가정하지 않습니다.'],
      ['실행내역 시각 역전', `${number(s.timeInversions)} / ${number(c.executionRows)}행`, '약 0.3%입니다. 포지션과 보유기간 분석 전에 UTC 일별로 정렬했습니다.'],
      ['지갑 파일 날짜 역전', `${number(s.walletDateInversionsInFileOrder)}회`, '파일 순서가 날짜 순서와 다릅니다. 날짜를 먼저 정렬해야 합니다.'],
      ['잔고 열 = 행별 누적 잔고?', `${number(s.walletRowLevelBalanceMismatches)} / ${number(c.walletTransactions)}행 불일치`, '이 전제는 성립하지 않습니다. 잔고 열은 같은 날 반복되는 반올림된 스냅샷입니다.'],
      ['일말 잔고와 재구성 금액', `${number(s.walletDayEndBalanceMismatches)} / 1,380일 불일치`, '152일은 반올림 범위입니다. 2018-04-27과 04-28의 0.54595876 / 1.00120000 BTC 차이는 미해결입니다.'],
      ['Liquidation 표시 실행 행', `${number(s.liquidationRows)}행 · 영 주문 ID ${number(s.liquidationRowsWithZeroOrderId)}행`, '실행 행의 표시입니다. 행 수만으로 독립적인 강제청산 사건 수를 확정하지 않습니다.'],
      ['외부 시장 체결 대조', '81,263 / 81,268행 일치', 'BitMEX 공개 체결 아카이브에서 trdMatchID로 직접 대조했습니다. 표본 64일의 81,268행 중 81,263행이 발견되었고(99.9938%), 미발견 5행은 모두 아카이브가 공개하지 않는 청산 체결입니다. 발견된 행은 심볼·수량·가격이 전부 일치했고, 테이커 기준 사이드 규칙도 81,263행 전부 성립해 메이커·테이커 분류가 외부로 확인됩니다.'],
      ['작성 주체·거래소 발급 여부', '미인증', '내부 금액이 맞아도 원본 누락, 편집 여부, 계정 소유자까지 인증되지는 않습니다.'],
    ];
    check(rows.length === d.validation.checks.length, '화면 검사 항목과 공개 JSON 개수');
    const counts = ['pass', 'note', 'fail', 'open'].map((v) => `${stamp(v)} ${d.validation.checks.filter((r) => r.verdict === v).length}항목`);
    $('checks-body').innerHTML = `<div class="checks-summary">${counts.map((r) => `<span>${r}</span>`).join('')}</div><div class="check-list">${rows.map(([name, result, note], i) => `<article class="check-row">${stamp(d.validation.checks[i].verdict)}<h3 class="check-name">${esc(name)}</h3><p class="check-result">${esc(result)}</p><p class="check-note">${esc(note)}</p></article>`).join('')}</div><div class="callout loss-border"><h3>FAIL은 ‘행별 잔고’라는 해석에 대한 판정입니다.</h3><p>최종 대사는 통과하지만 중간 잔고 열에는 구조적 한계와 이틀의 미해결 차이가 있습니다. 이것만으로 위조나 누락을 판정하지 않습니다.</p>${evidence('validation', 'checks / summary')}</div>`;
  }

  function comparisons(d) {
    const a = d.stated.announcement, h = d.headline, r = d.stated.riskProfile;
    const repo = d.meta.repository + '/blob/main/';
    const rows = [
      ['누적 입금', number(a.stated.cumulativeDepositsBTC, 1) + ' BTC', number(a.measured.cumulativeDepositsXBt, 8) + ' BTC', '공개 수치는 근삿값. 실측은 완료 입금의 합계입니다.'],
      ['누적 실현손익', number(a.stated.cumulativeRealisedPnlBTC) + ' BTC', number(a.measured.cumulativeRealisedPnlXBt, 8) + ' BTC', '원장 RealisedPNL의 순합계입니다.'],
      ['입금 대비 실현손익 비율', '약 ' + number(a.stated.cumulativeReturnPct) + '%', number(a.measured.cumulativeReturnPct) + '%', '실현손익 ÷ 누적 입금. 복리·연환산·시간가중 수익률이 아닙니다.'],
      ['주문', '약 ' + number(a.stated.orders) + '개', number(a.measured.orders) + '개', '영 식별자를 제외한 고유 주문입니다.'],
      ['체결', '약 ' + number(a.stated.fills) + '건', number(a.measured.fills) + '건', 'Trade 실행 행을 셉니다.'],
      ['방향성 포지션 시작', '약 ' + number(a.stated.positions) + '회', number(a.measured.positions) + '회', `${number(a.measured.positionsBreakdown.flatToOpen)}회 신규 진입 + ${number(a.measured.positionsBreakdown.longShortReversals)}회 방향 반전. 원장 손익 항목 수와 다릅니다.`],
    ];
    const combined = sum(d.attribution.filter((s) => ['XBTUSD', 'ETHUSD'].includes(s.symbol)), 'pnlXBt');
    // Quotes remain short; the source dossier records the original publications.
    const principles = [
      ['note', '“출금해라”', `${number(d.withdrawals.summary.completedWithdrawals)}건 출금 · 실현손익 대비 ${percent(h.withdrawnShareOfProfit)}`, '완료 출금은 관측됩니다. 출금 목적이나 이후 다른 거래소에서의 재투자는 알 수 없습니다.', 'docs/stated-vs-measured.md', '출처: 2021-08-10 게시글 / 대조 문서'],
      ['note', '“보통 하루 정도 들고 있음”', `FIFO 중위값 ${h.medianHold} · 1일 미만 ${percent(d.insights.holdingPeriod.shareUnder1d)}`, 'FIFO 수량 대응 기준의 근사입니다. 실제 포지션 수명을 직접 확인한 값이 아닙니다.', 'docs/stated-vs-measured.md', '출처: Q&A 인용 / 대조 문서'],
      ['note', '“승률에 더 신경 써라”', `양수 원장 항목 ${percent(h.winRate, 2)} · 평균 이익/손실 ${number(h.payoffRatio, 2)}`, '손익 항목의 양수 비율을 셌습니다. 체결·주문별 승률이나 진입 원칙은 검증하지 않습니다.', 'docs/stated-vs-measured.md', '출처: Q&A 인용 / 대조 문서'],
      ['note', '“시총이 큰 코인 위주로 매매”', `XBTUSD + ETHUSD = 총 원장 손익의 ${percent(combined / h.realisedXBt)}`, '손익 집중은 관측됩니다. 종목 선택이 초과 성과의 원인이라는 인과관계는 알 수 없습니다.', 'docs/stated-vs-measured.md', '출처: Q&A 인용 / 대조 문서'],
      ['note', '자본 손실 30% 이내 관리 원칙', `손실 항목의 ${percent(1 - r.shareLosingMoreThan30PctOfEquity)}가 일말 잔고의 30% 이하`, '종가성 잔고를 분모로 쓴 사후 비율입니다. 진입 당시 위험 한도나 원칙 준수를 입증하지 않습니다.', 'docs/stated-vs-measured.md', '출처: 2025-06-11 인터뷰 / 대조 문서'],
      ['open', '레버리지·보조지표 사용', '체결 파일로 복원할 수 없음', '증거금 모드와 진입 판단은 없습니다. 매매 명목금액 ÷ 잔고를 레버리지로 읽지 않습니다.', 'docs/stated-vs-measured.md', '출처: 인터뷰·Q&A / 대조 문서'],
    ];
    const gaps = d.stated.ledgerVsClaims.filter((c) => c.statedWithdrawn !== null);
    $('said-body').innerHTML = `<div class="table-scroll"><table class="comparison-table"><caption>공개 예고 수치 6개 — 근삿값과 정의를 맞춘 비교 ${stamp('note')}</caption><thead><tr><th scope="col">측정 대상</th><th scope="col">공개 수치</th><th scope="col">파일 재계산</th><th scope="col">판독 조건</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v, i) => `<td${i === 1 || i === 2 ? ' class="num"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="fine source-note">공개 수치 출처: ${external('https://gall.dcinside.com/mgallery/board/view/?id=chartanalysis&no=5050579', '2026-09-22 공개 예고')}. 수치는 대체로 부합하지만 근삿값을 정확한 일치로 표시하지 않습니다.</p><div class="principles">${principles.map(([verdict, title, measured, note, file, label]) => `<article class="principle"><div class="principle-head">${stamp(verdict)}<h3>${esc(title)}</h3></div><p class="measured">${esc(measured)}</p><p>${esc(note)}</p><p class="source-note fine">${external(repo + file, label)}</p></article>`).join('')}</div><div class="callout"><h3>${stamp('open')} 2019년 누적 출금 차이</h3>${gaps.map((g) => `<p><span class="mono">${esc(g.date)}</span> · 공개 ${number(g.statedWithdrawn)} BTC / 원장 ${number(g.cumulativeWithdrawnXBt, 3)} BTC / 원장 쪽이 ${number(-g.statedWithdrawnVsLedgerXBt, 3)} BTC 큽니다.</p>`).join('')}<p>두 차이는 약 43 BTC로 비슷하지만 정확히 같지는 않습니다. 내부 이체, 집계 정의 차이, 오류 중 어느 것인지는 이 파일만으로 구별할 수 없습니다.</p>${evidence('stated', 'ledgerVsClaims')}</div>`;
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

  function detailTables(d) {
    const decimal = (digits) => (v) => number(v, digits);
    sortable('events-table', '완료 출금 이벤트 · BTC 금액은 8자리까지 표시', [
      { key: 'date', label: '원장 날짜' }, { key: 'amountXBt', label: '차감액 (BTC)', numeric: true, format: decimal(8) },
      { key: 'baseXBt', label: '추정 단위 (BTC)', numeric: true, format: decimal(8) }, { key: 'feeXBt', label: '수수료 후보 (BTC)', numeric: true, format: decimal(8) },
      { key: 'round', label: '정수 단위 후보', format: (v) => v ? '해당' : '기타 / 미분류' },
      { key: 'daysSinceProfitPeak', label: '고점 이후 (일)', numeric: true, format: decimal(0) },
      { key: 'shareOfEquityBefore', label: '직전 장부 잔고 대비', numeric: true, format: (v) => percent(v, 2) },
    ], [...d.withdrawals.events]);
    $('ladder-count').textContent = `${number(d.withdrawals.ladder.length)}개 분류 · 추정 단위순`;
    sortable('ladder-table', '수수료 후보 제거 후의 출금 단위 · 정수 이외의 분류도 포함', [
      { key: 'baseXBt', label: '추정 단위 (BTC)', numeric: true, format: decimal(8) }, { key: 'count', label: '이벤트 수', numeric: true, format: decimal(0) },
      { key: 'firstDate', label: '첫 사용 날짜' }, { key: 'lastDate', label: '마지막 사용 날짜' }, { key: 'round', label: '정수 단위 후보', format: (v) => v ? '해당' : '기타 / 미분류' },
    ], [...d.withdrawals.ladder]);
    sortable('monthly-table', '월별 원장 금액 · 파일 날짜 기준 · 출금은 음수', [
      { key: 'month', label: '월' }, { key: 'realisedXBt', label: '순실현손익 (BTC)', numeric: true, signed: true, format: (v) => signed(v, 8) },
      { key: 'depositsXBt', label: '입금 (BTC)', numeric: true, format: decimal(8) }, { key: 'withdrawalsXBt', label: '출금 (BTC)', numeric: true, format: decimal(8) },
      { key: 'endBalanceXBt', label: '월말 장부 잔고 (BTC)', numeric: true, format: decimal(8) },
    ], [...d.monthly]);
    sortable('attribution-table', '전체 종목별 원장 손익 · 산출물 반올림 값 · 항목별 승률은 포지션 승률이 아님', [
      { key: 'symbol', label: '종목' }, { key: 'pnlXBt', label: '순실현손익 (BTC)', numeric: true, signed: true, format: (v) => signed(v, 4) },
      { key: 'shareOfPnl', label: '총손익 기여', numeric: true, format: (v) => percent(v, 2) }, { key: 'closes', label: '원장 손익 항목', numeric: true, format: decimal(0) },
      { key: 'winRate', label: '양수 항목 비율', numeric: true, format: (v) => percent(v, 2) },
    ], [...d.attribution], 1, true);
  }

  function interpretations(d) {
    const w = d.withdrawals.summary, h = d.headline, f = d.insights.feeComponents;
    $('withdrawal-stats').innerHTML = metric(number(w.completedWithdrawals), '건', '완료 출금 이벤트', `취소 ${number(w.cancelledWithdrawals)}건 제외`) + metric(percent(w.withdrawnShareOfRealised), '', '출금액 ÷ 총 원장 실현손익', number(w.totalWithdrawnXBt, 2) + ' BTC 출금') + metric(`${number(w.roundLotPattern.withdrawalsMatchingARoundLot)} / ${number(w.completedWithdrawals)}`, '건', '정수 BTC 단위 후보', '수수료 후보를 제거한 추정 분류');
    $('withdrawal-timing').innerHTML = `<div><p class="eyebrow">TIMING / LEDGER DATES</p><h3>누적 이익 고점과 출금 날짜</h3><div class="timing-big">${number(w.timingVsProfitPeak.within5Days)}<span> / ${number(w.completedWithdrawals)}건</span></div><p>직전 누적 실현손익 최고점으로부터 0~5일 뒤에 기록된 출금입니다. 고점을 기준으로 한 날짜 차이이며, 장중 선후관계나 의도를 설명하지 않습니다.</p></div><div class="timing-pair"><p><strong>${number(w.timingVsProfitPeak.medianDaysAfterPeak)}일</strong>고점 이후 경과일 중위값</p><p><strong>${number(w.spacingDays.median)}일</strong>출금 사이 간격 중위값</p></div><p>출금액은 직전 장부 잔고 대비 중위 ${percent(w.shareOfEquityAtWithdrawal.median)}입니다. 행별 시각과 정확한 평가액이 없으므로 근사적인 비율입니다.</p>${evidence('withdrawals', 'summary.timingVsProfitPeak')}`;
    $('profit-stats').innerHTML = metric(percent(h.winRate, 2), '', '원장 손익 항목 중 양수 비율', `${number(d.meta.counts.winningEntries)} / ${number(d.meta.counts.ledgerPnlEntries)}항목`) + metric(number(h.profitFactor, 2), '배', '총이익 ÷ 총손실 절댓값', '원장 항목 기준 Profit factor') + metric(number(h.payoffRatio, 2), '배', '평균 이익 ÷ 평균 손실 절댓값', '양수·음수 원장 항목의 평균');
    const benefit = f.fundingReceivedXBt - f.netTradeFeeXBt;
    $('fees-body').innerHTML = `<div class="fees-grid"><div><h3>수수료와 펀딩의 구성</h3>${[['메이커 리베이트 수취', -f.makerRebateXBt], ['테이커 수수료 지급', -f.takerFeeXBt], ['순거래 수수료 지급', -f.netTradeFeeXBt], ['펀딩 순수취', f.fundingReceivedXBt]].map(([label, v]) => `<div class="fee-row"><span>${label}</span><span class="${v < 0 ? 'negative' : 'positive'}">${signed(v, 8)} BTC</span></div>`).join('')}<p>메이커 비중 ${percent(h.makerShare, 2)}는 체결 건수 기준입니다. 순수수료와 펀딩을 합친 순수취는 ${number(benefit, 8)} BTC입니다. 이들은 원장 손익에 포함된 구성 항목으로, 총손익에 다시 더하지 않습니다.</p>${evidence('insights', 'feeComponents')}</div><div class="callout loss-border"><h3>기간 말의 미회복 낙폭</h3><p>누적 원장 실현손익 고점 ${esc(h.maxDrawdownPeakDay)}에서 ${esc(h.maxDrawdownTroughDay)}까지 ${number(h.maxDrawdownXBt, 2)} BTC, 고점 대비 ${percent(h.maxDrawdownPct)} 감소했습니다.</p><p>절대 금액 기준 최대 감소입니다. 미실현손익이 빠졌고 종료 시 포지션이 남아 있으므로, 계좌 전체의 최대 손실이나 청산 위험으로 읽지 않습니다.</p>${evidence('headline', 'maxDrawdownXBt / maxDrawdownPct')}</div></div>`;
    const limits = [
      ['거래소 발급과 계정 소유자', '파일의 내부 정합성은 발급 주체와 진위를 보증하지 않습니다. 공개 전 누락이나 변경은 내부 합산만으로 발견할 수 없습니다.'],
      ['실제 평가액·레버리지·청산 여유', '미실현손익, 증거금 모드, 포지션별 증거금 기록이 없습니다. 잔고나 일별 회전율로 레버리지를 대체하지 않습니다.'],
      ['진입 이유와 주문 취소 판단', '보조지표, 신호, 보류·취소·정정된 주문은 체결 기록에 남지 않습니다. 거래 규칙이나 재현 가능한 전략을 추출했다고 주장하지 않습니다.'],
      ['성과의 일반화와 인과관계', '한 계정, 한 거래소, 한 과거 기간의 관측입니다. 다른 시장·자본·시점에서 같은 결과가 날지는 확인할 수 없습니다.'],
      ['실제 포지션 수명과 승률', 'FIFO는 수량 대응의 근사이고, 양수 비율은 원장 손익 항목 기준입니다. 주문 수, 진입 횟수, 포지션 수와 서로 바꿔 쓰지 않습니다.'],
      ['계약 사양·출금 목적지', '체결 대조는 표본 5.6%까지만 했고, 당시 계약 승수·상장일·펀딩률 이력은 아직 받지 않았습니다. 출금이 보관·재배치·소비 중 무엇인지도 이 자료에는 없습니다.'],
    ];
    $('limits-body').innerHTML = `<div class="confidence-key"><div><span class="confidence solid">Solid · 직접 집계</span><p>공개 파일과 계산 정의에서 직접 나오는 수치. 파일 진위에 대한 보증은 아닙니다.</p></div><div><span class="confidence directional">Directional · 근사·패턴</span><p>방향은 관측되지만 가정, 표본, 재구성 방법에 민감한 값입니다.</p></div><div><span class="confidence speculative">Speculative · 해석</span><p>행동의 이유나 성과의 원인에 대한 설명. 이 보고서의 검증된 결론으로 채택하지 않습니다.</p></div></div><div class="limitations">${limits.map(([name, note]) => `<article class="limit-item"><h3>${stamp('open')}${esc(name)}</h3><p>${esc(note)}</p></article>`).join('')}</div><p class="fine source-note">판독 기준: ${external(d.meta.repository + '/blob/main/FINDINGS.md', 'FINDINGS.md')} · 정의와 한계: ${external(d.meta.repository + '/blob/main/docs/methodology.md', 'methodology.md')}</p>`;
  }

  function reproduction(d) {
    const base = d.meta.repository + '/blob/main/';
    const commands = `git clone ${d.meta.repository}.git\ncd aoa-bitmex-analysis\n\n# 직접 원본을 내려받아 검증 (최초 다운로드에 네트워크 필요)\nnpm run fetch\nnpm run validate\nnpm run analyze\nnpm run insights\nnpm run stated\nnpm run withdrawals\nnpm test\n\n# 공개 집계 갱신 — 사이트 열기에 필수인 빌드는 아님\nnode scripts/build-site.mjs\npython3 -m http.server 8000 --directory site`;
    $('reproduce-body').innerHTML = `<div class="repro-grid"><div><h3>분석부터 다시 실행</h3><p>Node.js 20 이상. npm 명령은 저장소의 스크립트를 실행하며 패키지 설치 단계는 없습니다. 원본은 직접 받아 재계산합니다.</p><pre><code>${esc(commands)}</code></pre><p>완성된 <code>site/</code>는 그대로 정적 호스팅할 수 있습니다. 로컬에서는 <code>index.html</code>을 직접 열어도 같은 집계 스냅샷으로 동작합니다.</p></div><div><h3>원본 해시와 근거</h3><p>압축파일 SHA-256 · ${esc(d.meta.source.archive)}</p><p class="hash">${esc(d.meta.source.sha256)}</p><p>해시는 같은 복사본인지 확인하는 값입니다. 발급 주체나 원본의 진위를 보증하지 않습니다.</p><ul class="source-list">${[['원본 게시글', d.meta.source.post, '공개 출처'], ['분석 저장소', d.meta.repository, '코드 / 원본 제외'], ['출처와 해시', base + 'docs/source.md', 'SOURCE'], ['계산 방법', base + 'docs/methodology.md', 'DEFINITIONS'], ['전수 감사', base + 'docs/validation.md', 'VALIDATION'], ['발언 대조', base + 'docs/stated-vs-measured.md', 'STATED / MEASURED'], ['해석 신뢰도', base + 'FINDINGS.md', 'CONFIDENCE'], ['집계 생성 코드', base + 'scripts/build-site.mjs', 'PUBLIC PAYLOAD']].map(([name, url, label]) => `<li>${external(url, name)}<span>${esc(label)}</span></li>`).join('')}</ul><p>원본 CSV, 거래·주문·체결 식별자, 일별 전체 현금흐름 장부와 게시글 전문은 사이트에 포함하지 않습니다. 아래 JSON은 공개용 집계만 담습니다.</p><div class="payload-links">${FILES.map((name) => `<a href="data/${name}.json">${name}.json ↗</a>`).join('')}</div></div></div><details class="data-details"><summary>산출물 간 차이와 사이트의 선택 <span>원본 분석 파일은 수정하지 않음</span></summary>${d.meta.sourceAdjustments.map((a) => `<div class="adjustment"><strong>${esc(a.field)} · ${esc(a.original)} → ${esc(a.published)}</strong><p>${esc(a.reason)}</p></div>`).join('')}<div class="adjustment"><strong>고점 기준과 출금 시점</strong><p>고점 후 5일 이내 44건은 withdrawals.summary.timingVsProfitPeak 기준입니다. insights의 잔고 고점 기준 27건과 기준이 다르므로 섞어 쓰지 않습니다. 2019년 누적 출금 차이도 반올림한 동일 수치가 아니라 날짜별 실제 값을 표시합니다.</p></div></details>`;
    $('footer-data').textContent = `DATA SNAPSHOT / ${d.meta.generatedAt} · FILES / ${FILES.length}`;
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

  async function main() {
    try {
      const loaded = await load();
      audit.mode = loaded.mode;
      const data = Object.fromEntries(FILES.map((name) => {
        if (!Object.hasOwn(loaded.payload, name + '.json')) throw new Error(`누락된 공개 집계: ${name}.json`);
        return [name, loaded.payload[name + '.json']];
      }));
      const d = strictData(data);
      validate(d);
      introduction(d);
      calendar(d);
      validationReport(d);
      comparisons(d);
      financialCharts(d);
      interpretations(d);
      detailTables(d);
      reproduction(d);
      terminal(d);
      monthlyPanels(d);
      dailyPanel(d);
      feePanel(d);
      for (const id of ['attribution-chart', 'hold-chart']) panelControls(id, () => {}, false);
      panelQuote('attribution-chart', 'ALL SYMBOLS / PNL', signed(d.headline.realisedXBt, 2) + ' BTC', '전 기간 합계 · 시점별 등락률 미산출', 'positive');
      panelQuote('hold-chart', 'FIFO / MEDIAN', d.insights.holdingPeriod.median, '전체 수량 대응 · 등락률 미산출');
      interactions();
      check(![...document.querySelectorAll('svg')].some((s) => /(?:NaN|Infinity|undefined)/.test(s.innerHTML)), 'SVG 좌표와 레이블 유효성');
      audit.state = 'ready';
      $('data-status').textContent = loaded.mode === 'json' ? '공개 JSON 교차 검사 완료' : loaded.mode === 'file' ? '오프라인 · 내장 집계 교차 검사 완료' : '내장 스냅샷 사용 · JSON 요청 실패';
      if (loaded.mode === 'snapshot') {
        $('load-notice').hidden = false;
        $('load-notice').textContent = `JSON을 읽지 못해 HTML에 포함된 ${d.meta.generatedAt} 집계 스냅샷을 표시합니다. 최신 집계와 다를 수 있습니다.`;
      }
    } catch (error) {
      audit.state = 'error';
      audit.error = error.message;
      console.error('보고서 렌더링 실패:', error);
      $('data-status').textContent = '데이터 확인 실패';
      $('hero-ledger').setAttribute('aria-busy', 'false');
      $('reconcile-stamp').classList.remove('verified');
      $('reconcile-stamp').querySelector('strong').textContent = '—';
      $('load-notice').hidden = false;
      $('load-notice').textContent = `보고서를 표시하지 못했습니다. ${error.message} 공개 JSON 또는 내장 스냅샷을 확인해 주세요.`;
    }
  }
  main();
})();
