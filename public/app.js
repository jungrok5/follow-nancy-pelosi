// 프런트엔드: /api/report 를 받아 시그널 카드와 거래 테이블을 그린다.
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
};

const state = { report: null, filter: 'ALL', query: '', timer: null };

/** 표 셀. data-label은 모바일 카드형 레이아웃에서 항목 이름으로 쓰인다. */
const cell = ({ className = '', label, text, children }) => {
  const td = el('td', { className }, children ?? (text != null ? [text] : []));
  if (label != null) td.dataset.label = label;
  return td;
};

const usd = (n, digits = 2) =>
  Number.isFinite(n) ? `$${n.toLocaleString('en-US', { maximumFractionDigits: digits })}` : '—';
const pct = (n) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—');
const cls = (n) => (!Number.isFinite(n) ? 'flat' : n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const compactUSD = (n) =>
  !Number.isFinite(n) || n === 0 ? '—'
  : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n}`;

/** 공시 시각은 미 동부 기준. 'MM/DD HH:mm' 로 짧게. */
const etShort = (iso) => {
  const opts = { timeZone: 'America/New_York', hour12: false };
  const date = new Intl.DateTimeFormat('en-US', { ...opts, month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const time = new Intl.DateTimeFormat('en-GB', { ...opts, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  return `${date} ${time}`;
};

const KIND_CLASS = {
  BUY: 'k-buy', CALL_BUY: 'k-call', EXERCISE: 'k-neutral',
  SELL: 'k-sell', PUT_BUY: 'k-put', DONATION: 'k-neutral', EXCHANGE: 'k-neutral',
};

const FILTERS = [
  ['ALL', '전체'],
  ['BUY', '따라 매수'],
  ['ACCUMULATE', '분할 매수'],
  ['CHASE_RISK', '추격 주의'],
  ['REDUCE', '축소 신호'],
  ['WATCH', '관망'],
];

async function load({ refresh = false } = {}) {
  const member = $('#member').value.trim() || 'Pelosi, Nancy';
  const btn = $('#refresh');
  btn.disabled = true;
  setStatus(refresh ? '하원 사무처에서 최신 공시를 다시 받아오는 중…' : '공시 데이터를 불러오는 중…');
  try {
    const res = await fetch(`/api/report?member=${encodeURIComponent(member)}${refresh ? '&refresh=1' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    state.report = data;
    render();
  } catch (err) {
    setStatus(`불러오지 못했습니다: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function setStatus(text, isError = false) {
  const node = $('#status');
  node.hidden = false;
  node.textContent = text;
  node.classList.toggle('error', isError);
}

function render() {
  const r = state.report;
  const stale = r.summary.daysSinceLatestFiling;
  setStatus(
    `${r.member.displayName} (${r.member.stateDst}) · 최근 공시 ${r.summary.latestFilingDate ?? '없음'}` +
    `${stale != null ? ` (${stale}일 전)` : ''} · 공시 문서 ${r.filings.length}건에서 거래 ${r.transactions.length}건 파싱 · ` +
    `갱신 ${new Date(r.generatedAt).toLocaleString('ko-KR')}`,
  );
  renderFreshness(r);
  renderSummary(r);
  renderConclusion(r);
  renderFilters();
  renderSignals();
  renderTransactions();
  renderFilings(r);
}

/** 지연이 어디서 생기는지를 세 구간으로 나눠 보여준다. */
function renderFreshness(r) {
  const s = r.summary;
  const hrs = s.hoursSincePublished;
  const publishedText = s.latestPublishedAt ? `${etShort(s.latestPublishedAt)} ET` : (s.latestFilingDate ?? '—');
  const elapsed = hrs == null ? '' : hrs < 48 ? `${hrs}시간 전 게시` : `${Math.round(hrs / 24)}일 전 게시`;
  const dot = hrs == null ? 'cold' : hrs <= 24 ? '' : hrs <= 24 * 7 ? 'warm' : 'cold';

  const collected = r.dataBuiltAt ?? r.generatedAt;
  const collectedAgo = Math.round((Date.now() - Date.parse(collected)) / 60000);
  const live = r.sources?.liveSearch;

  const cells = [
    { k: '① 거래 → 공시 (법정 지연)', v: s.avgLagDays != null ? `평균 ${s.avgLagDays}일` : '—',
      s: `최대 ${s.maxLagDays ?? '—'}일 · 법정 한도 45일 — 이 구간은 누구도 못 줄입니다`, dot: 'cold' },
    { k: '② 공시 → 이 사이트 인지', v: collectedAgo < 90 ? `${collectedAgo}분 전 수집` : `${Math.round(collectedAgo / 60)}시간 전 수집`,
      s: live?.ok ? '사무처 ZIP 인덱스 + 실시간 검색 병행' : 'ZIP 인덱스 기준(실시간 검색 실패)', dot: collectedAgo < 120 ? '' : 'warm' },
    { k: '③ 최근 공시 게시 시각', v: publishedText, s: elapsed, dot },
    { k: '④ 주가', v: '요청 시점 실시간', s: Object.values(r.quotes ?? {})[0]?.source ?? '시세 소스 없음', dot: '' },
  ];

  $('#freshness').hidden = false;
  $('#freshness').replaceChildren(
    ...cells.map((c) =>
      el('div', {}, [
        el('div', { className: 'k' }, [el('span', { className: `dot ${c.dot}` }), c.k]),
        el('div', { className: 'v', textContent: c.v }),
        el('div', { className: 's', textContent: c.s }),
      ]),
    ),
  );
}

function renderSummary(r) {
  const s = r.summary;
  const stats = [
    ['최근 공시일', s.latestFilingDate ?? '—',
      s.hoursSincePublished != null && s.hoursSincePublished < 48
        ? `${s.hoursSincePublished}시간 전 게시`
        : s.daysSinceLatestFiling != null ? `${s.daysSinceLatestFiling}일 경과` : ''],
    ['조회 구간 거래', `${s.tradeCount}건`, `${r.lookbackDays}일 이내 · 종목 ${s.tickerCount}개`],
    ['매수 / 매도', `${s.buyCount} / ${s.sellCount}`, `옵션 거래 ${s.optionCount}건`],
    ['평균 신고 지연', s.avgLagDays != null ? `${s.avgLagDays}일` : '—', s.maxLagDays != null ? `최대 ${s.maxLagDays}일` : ''],
    ['매수 상위', s.topBuy.join(', ') || '—', s.topSell.length ? `매도: ${s.topSell.join(', ')}` : ''],
  ];
  $('#summary').replaceChildren(
    ...stats.map(([k, v, sub]) =>
      el('div', { className: 'stat' }, [
        el('div', { className: 'k', textContent: k }),
        el('div', { className: 'v', textContent: v }),
        el('div', { className: 's', textContent: sub }),
      ]),
    ),
  );
  $('#summary').hidden = false;
}

/** "그래서 뭘 사고 뭘 팔라는 건가"를 한 화면에 요약한다. */
function renderConclusion(r) {
  const pick = (...actions) => r.signals.filter((s) => actions.includes(s.action)).slice(0, 4);
  const groups = [
    { title: '지금 검토할 매수 후보', tone: 'buy', items: pick('BUY', 'ACCUMULATE'),
      why: (s) => `확신도 ${s.score} · ${s.latestTradeDate} 매수 · 거래일 대비 ${pct(s.driftPct)}` },
    { title: '기다렸다 사야 할 종목', tone: 'caution', items: pick('CHASE_RISK'),
      why: (s) => `이미 ${pct(s.driftPct)} 상승 · 눌림목 대기` },
    { title: '줄이거나 피할 종목', tone: 'sell', items: pick('REDUCE'),
      why: (s) => `매도 우위(순 ${s.net}) · 최근 매도 ${s.latestTradeDate}` },
  ];
  const node = $('#conclusion');
  node.hidden = false;
  node.replaceChildren(
    el('h2', { textContent: '오늘의 결론' }),
    el('p', { className: 'sub', textContent: `${r.member.displayName}의 최근 ${r.lookbackDays}일 공시를 규모·거래성격·신고지연·주가반영도로 채점한 결과입니다. 아래 카드에서 종목별 근거를 확인하세요.` }),
    el('div', { className: 'verdicts' }, groups.map((g) =>
      el('div', { className: `verdict tone-${g.tone}` }, [
        el('h3', { textContent: g.title }),
        g.items.length
          ? el('ul', {}, g.items.map((s) =>
              el('li', {}, [
                el('b', { textContent: `${s.ticker} ${s.price ? `· ${usd(s.price)}` : ''}` }),
                el('span', { textContent: g.why(s) }),
              ]),
            ))
          : el('p', { className: 'empty', textContent: '해당 종목 없음' }),
      ]),
    )),
  );
}

function renderFilters() {
  const counts = state.report.signals.reduce((acc, s) => ((acc[s.action] = (acc[s.action] ?? 0) + 1), acc), {});
  $('#filters').replaceChildren(
    ...FILTERS.map(([key, label]) => {
      const n = key === 'ALL' ? state.report.signals.length : counts[key] ?? 0;
      const chip = el('button', {
        className: 'chip', type: 'button', textContent: `${label} ${n}`,
        onclick: () => { state.filter = key; renderFilters(); renderSignals(); },
      });
      chip.setAttribute('aria-pressed', String(state.filter === key));
      return chip;
    }),
  );
}

function renderSignals() {
  const signals = state.report.signals.filter((s) => state.filter === 'ALL' || s.action === state.filter);
  $('#signals-section').hidden = false;
  if (!signals.length) {
    $('#signals').replaceChildren(el('p', { className: 'status', textContent: '해당 조건의 시그널이 없습니다.' }));
    return;
  }
  $('#signals').replaceChildren(...signals.map(signalCard));
}

function signalCard(s) {
  const priceLine = el('div', { className: 'price-row' }, [
    el('span', { className: 'price', textContent: s.price ? usd(s.price) : '시세 없음' }),
    Number.isFinite(s.driftPct)
      ? el('span', { className: `delta ${cls(s.driftPct)}`, textContent: `의원 거래일 대비 ${pct(s.driftPct)}` })
      : null,
    Number.isFinite(s.sinceFilingPct)
      ? el('span', { className: `delta ${cls(s.sinceFilingPct)}`, textContent: `공시 이후 ${pct(s.sinceFilingPct)}` })
      : null,
    el('span', { className: 'price-note', textContent: s.priceError ?? s.priceSource ?? '' }),
  ]);

  const gauge = el('div', { className: 'gauge' }, [
    el('div', { className: 'gauge-bar' }, [el('div', { className: 'gauge-fill', style: `width:${s.score}%` })]),
    el('span', { className: 'gauge-num', textContent: `확신도 ${s.score}/100 (${s.confidence})` }),
  ]);

  const reasons = el('ul', { className: 'reasons' },
    s.reasons.map((r) => el('li', {}, [el('span', { className: 'tag', textContent: r.tag }), el('span', { textContent: r.text })])),
  );

  const adjustments = s.adjustments.length
    ? el('div', { className: 'price-note', textContent: `점수 보정: ${s.adjustments.join(' · ')}` })
    : null;

  const trades = el('details', { className: 'trades' }, [
    el('summary', { textContent: `관련 거래 ${s.trades.length}건 보기 (매수 ${compactUSD(s.totalBuyMid)} / 매도 ${compactUSD(s.totalSellMid)})` }),
    el('ul', {}, s.trades.map((t) =>
      el('li', {}, [
        el('span', { textContent: t.summary }),
        el('span', { className: 'meta' }, [
          `${t.kindLabel} · 공시 ${t.filingDate ?? '—'} (지연 ${t.lagDays ?? '—'}일)`,
          t.pdfUrl ? el('a', { href: t.pdfUrl, target: '_blank', rel: 'noopener', textContent: ' · 원문 PDF' }) : null,
        ]),
      ]),
    )),
  ]);

  return el('article', { className: `card tone-${s.tone}` }, [
    el('div', { className: 'card-head' }, [
      el('div', {}, [
        el('div', { className: 'ticker', textContent: s.ticker }),
        el('div', { className: 'company', textContent: s.name ?? '' }),
      ]),
      el('span', { className: 'badge', textContent: s.actionLabel }),
    ]),
    priceLine,
    gauge,
    reasons,
    adjustments,
    el('div', { className: 'playbook' }, [el('b', { textContent: '어떻게 할까: ' }), s.playbook]),
    trades,
  ]);
}

function renderTransactions() {
  const q = state.query.toLowerCase();
  const rows = state.report.transactions.filter(
    (t) => !q || [t.ticker, t.asset, t.description, t.kindLabel].join(' ').toLowerCase().includes(q),
  );
  $('#tx-section').hidden = false;
  $('#tx-body').replaceChildren(
    ...rows.map((t) =>
      el('tr', {}, [
        cell({ className: 'mono', text: t.transactionDate }),
        cell({ className: 'mono', text: t.ticker ?? '—' }),
        cell({ className: 'asset', label: '', children: [t.asset, t.description ? el('span', { className: 'desc', textContent: t.description }) : null] }),
        cell({ label: '', children: [el('span', { className: `kind ${KIND_CLASS[t.kind] ?? 'k-neutral'}`, textContent: t.kindLabel })] }),
        cell({ className: 'mono', label: '신고금액', text: t.amountLabel }),
        cell({ label: '명의', text: t.owner }),
        cell({ className: 'mono', label: '공시', text: t.filingDate ?? '—' }),
        cell({ className: 'mono', label: '지연', text: t.lagDays != null ? `${t.lagDays}일` : '—' }),
        cell({ label: '', children: [t.pdfUrl ? el('a', { href: t.pdfUrl, target: '_blank', rel: 'noopener', textContent: '원문 PDF' }) : '—'] }),
      ]),
    ),
  );
}

function renderFilings(r) {
  $('#filings-section').hidden = false;
  $('#filings').replaceChildren(
    ...r.filings.map((f) =>
      el('li', {}, [
        el('span', {}, [
          `공시 ${f.filingDate} · 문서번호 ${f.docId} · 거래 ${f.transactionCount ?? 0}건`,
          f.publishedAt ? ` · 게시 ${etShort(f.publishedAt)} ET` : '',
          f.discoveredVia === 'live-search' ? el('span', { className: 'pill', textContent: '실시간 검색으로 감지' }) : '',
          f.error ? ` · 파싱 오류: ${f.error}` : '',
        ]),
        el('a', { href: f.pdfUrl, target: '_blank', rel: 'noopener', textContent: '원문 PDF 열기' }),
      ]),
    ),
  );
}

async function loadTraders() {
  try {
    const { traders } = await (await fetch('/api/traders')).json();
    $('#traders').replaceChildren(
      ...traders.slice(0, 200).map((t) =>
        el('option', { value: t.name, label: `${t.name} · ${t.stateDst} · PTR ${t.ptrCount}건` }),
      ),
    );
  } catch { /* 자동완성은 없어도 동작에 지장 없음 */ }
}

$('#refresh').addEventListener('click', () => load({ refresh: true }));
$('#member').addEventListener('change', () => load());
$('#search').addEventListener('input', (e) => { state.query = e.target.value; if (state.report) renderTransactions(); });
$('#auto').addEventListener('change', (e) => {
  clearInterval(state.timer);
  if (e.target.checked) state.timer = setInterval(() => load({ refresh: true }), 5 * 60 * 1000);
});

// 좁은 화면에서는 안내문을 접어둔다.
$('#notice').open = window.innerWidth > 760;

load();
loadTraders();
