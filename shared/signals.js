// 매매 시그널 엔진.
// "공시 코드 그대로" 보여주는 대신, 거래의 실질(콜옵션 신규매수 / 행사 / 기부 / 실매도)과
// 규모·신고지연·공시 이후 주가 반영도를 함께 계산해 행동안과 근거를 만든다.
import { closeOn, pctChange } from './quotes.js';
import { clamp, daysAgoISO, diffDays, fmtPct, fmtUSD, todayISO } from './util.js';

/** 거래 성격별 가중치. 콜옵션 신규 매수가 가장 강한 확신 신호로 본다. */
const KIND_WEIGHT = {
  CALL_BUY: 1.6,
  BUY: 1.0,
  EXERCISE: 0.4, // 이미 보유하던 옵션의 현물 전환 → 신규 자금 유입이 아님
  SELL: -1.0,
  PUT_BUY: -1.5,
  DONATION: 0,
  EXCHANGE: 0,
};

export const ACTIONS = {
  BUY: { key: 'BUY', label: '따라 매수 검토', tone: 'buy' },
  ACCUMULATE: { key: 'ACCUMULATE', label: '분할 매수 검토', tone: 'accumulate' },
  CHASE_RISK: { key: 'CHASE_RISK', label: '추격 주의 · 눌림목 대기', tone: 'caution' },
  WATCH: { key: 'WATCH', label: '관망', tone: 'watch' },
  REDUCE: { key: 'REDUCE', label: '비중 축소 신호', tone: 'sell' },
};

const sizeWeight = (amountMid) =>
  clamp(Math.log10(Math.max(amountMid ?? 0, 1000) / 1000) / 3, 0.15, 1.6);

const recencyWeight = (daysSinceTrade) => Math.exp(-Math.max(daysSinceTrade ?? 0, 0) / 240);

function scoreTrade(tx, today) {
  const daysSinceTrade = diffDays(tx.transactionDate, today) ?? 0;
  const kindWeight = KIND_WEIGHT[tx.kind] ?? 0;
  // 만기가 6개월 이상 남은 LEAPS 콜은 단기 트레이딩이 아니라 장기 베팅이라 가중.
  const leaps = tx.kind === 'CALL_BUY' && tx.option?.expiry && (diffDays(today, tx.option.expiry) ?? 0) > 180;
  const weight = sizeWeight(tx.amountMid) * (kindWeight + (leaps ? 0.2 : 0)) * recencyWeight(daysSinceTrade);
  return { ...tx, daysSinceTrade, daysSinceFiling: diffDays(tx.filingDate, today), leaps, weight };
}

/** 거래 한 건을 한국어 한 문장으로 풀어쓴다. */
function describeTrade(tx) {
  const who = tx.owner && tx.owner !== '본인' ? `${tx.owner} 명의로 ` : '';
  const size = tx.amountLabel;
  if (tx.kind === 'CALL_BUY' && tx.option) {
    const strike = tx.option.strike ? `행사가 $${tx.option.strike}` : '행사가 미상';
    const expiry = tx.option.expiry ? `만기 ${tx.option.expiry}` : '만기 미상';
    const n = tx.option.contracts ? `${tx.option.contracts.toLocaleString()}계약` : '옵션';
    return `${tx.transactionDate} ${who}콜옵션 ${n}(${strike}, ${expiry})을 ${size} 규모로 매수`;
  }
  if (tx.kind === 'PUT_BUY') return `${tx.transactionDate} ${who}풋옵션 매수 (${size}) — 하락 베팅`;
  if (tx.kind === 'BUY')
    return `${tx.transactionDate} ${who}현물 ${tx.shares ? `${tx.shares.toLocaleString()}주 ` : ''}매수 (${size})`;
  if (tx.kind === 'EXERCISE')
    return `${tx.transactionDate} ${who}보유 콜옵션 행사로 현물 전환 (${size})`;
  if (tx.kind === 'SELL')
    return `${tx.transactionDate} ${who}${tx.shares ? `${tx.shares.toLocaleString()}주 ` : ''}매도 (${size})`;
  if (tx.kind === 'DONATION') return `${tx.transactionDate} ${who}기부·증여 (${size}) — 실제 매도가 아님`;
  return `${tx.transactionDate} ${who}${tx.kindLabel} (${size})`;
}

function actionFor({ score, net, driftPct, hasFreshFiling }) {
  if (net <= -0.35) return ACTIONS.REDUCE;
  if (net <= 0.1) return ACTIONS.WATCH;
  if (Number.isFinite(driftPct) && driftPct >= 30) return ACTIONS.CHASE_RISK;
  if (score >= 70 && hasFreshFiling) return ACTIONS.BUY;
  if (score >= 55) return ACTIONS.ACCUMULATE;
  return ACTIONS.WATCH;
}

const PLAYBOOK = {
  BUY: '동일 비중을 한 번에 담기보다 2~3회로 나눠 진입하고, 공시 이후 급등 구간이면 눌림목을 기다리세요. 옵션 복제(레버리지)는 개인 계좌에서 손실 배수가 커집니다.',
  ACCUMULATE: '신호는 유효하지만 확신도가 중간입니다. 소액으로 분할 진입하고 다음 공시(45일 주기)에서 매수가 이어지는지 확인한 뒤 비중을 늘리세요.',
  CHASE_RISK: '공시 이후 이미 크게 오른 구간입니다. 지금 사면 의원이 산 가격보다 훨씬 비싸게 사는 것이므로, 20일 이동평균선 부근까지 조정을 기다리는 편이 낫습니다.',
  WATCH: '방향성이 뚜렷하지 않거나 신규 자금 유입이 아닌 거래(옵션 행사·기부 등)입니다. 다음 공시를 기다리세요.',
  REDUCE: '매도가 우세합니다. 보유 중이라면 분할 익절 또는 비중 축소를 검토하고, 신규 진입은 보류하세요. 다만 세금·기부 목적 매도일 수 있어 매도 사유를 함께 확인하세요.',
};

/** 티커별로 거래를 묶어 시그널을 만든다. */
export function buildSignals(transactions, quotes = {}, { today = todayISO(), lookbackDays = 400 } = {}) {
  const cutoff = daysAgoISO(lookbackDays);
  const scored = transactions
    .filter((t) => t.ticker && t.transactionDate >= cutoff)
    .map((t) => scoreTrade(t, today));

  const byTicker = new Map();
  for (const tx of scored) {
    if (!byTicker.has(tx.ticker)) byTicker.set(tx.ticker, []);
    byTicker.get(tx.ticker).push(tx);
  }

  const signals = [];
  for (const [ticker, trades] of byTicker) {
    trades.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
    const quote = quotes[ticker];

    const bull = trades.filter((t) => t.weight > 0).reduce((s, t) => s + t.weight, 0);
    const bear = trades.filter((t) => t.weight < 0).reduce((s, t) => s - t.weight, 0);
    const net = bull - bear;

    const latest = trades[0];
    const latestFiling = trades.map((t) => t.filingDate).filter(Boolean).sort().at(-1) ?? null;
    const daysSinceFiling = diffDays(latestFiling, today);
    const hasFreshFiling = daysSinceFiling != null && daysSinceFiling <= 45;

    // 공시 이후 주가가 얼마나 움직였는지 = 따라 사기의 실질 불리함.
    const refTrade = trades.find((t) => t.weight > 0) ?? latest;
    const tradeClose = closeOn(quote, refTrade.transactionDate);
    const filingClose = closeOn(quote, latestFiling ?? refTrade.transactionDate);
    const price = quote?.price ?? null;
    const driftPct = pctChange(tradeClose, price);
    const sinceFilingPct = pctChange(filingClose, price);

    const directional = Math.abs(net) > 0.05; // 기부·교환처럼 방향성 없는 건은 가감점 없이 중립 유지
    let score = clamp(50 + 22 * net, 0, 100);
    const adjustments = [];
    if (!directional) adjustments.push('방향성 없는 이벤트(기부·분할·교환 등)');
    if (directional && !hasFreshFiling && net > 0) {
      score *= 0.75;
      adjustments.push('공시 후 45일이 지나 신호 감쇠');
    }
    if (directional && Number.isFinite(driftPct)) {
      if (driftPct >= 30) { score -= 15; adjustments.push('거래일 대비 30% 이상 급등 → 추격 위험'); }
      else if (driftPct >= 15) { score -= 8; adjustments.push('거래일 대비 15% 이상 상승'); }
      else if (driftPct < 0) { score += 6; adjustments.push('아직 의원 매수가 근처 또는 그 아래'); }
    }
    score = Math.round(clamp(score, 0, 100));

    const action = actionFor({ score, net, driftPct, hasFreshFiling });
    const reasons = buildReasons({ ticker, trades, latest, latestFiling, daysSinceFiling, quote, price, tradeClose, refTrade, driftPct, sinceFilingPct, net, bull, bear });

    signals.push({
      ticker,
      name: quote?.name ?? latest.asset,
      action: action.key,
      actionLabel: action.label,
      tone: action.tone,
      score,
      confidence: score >= 70 ? '높음' : score >= 50 ? '보통' : '낮음',
      net: Number(net.toFixed(2)),
      bull: Number(bull.toFixed(2)),
      bear: Number(bear.toFixed(2)),
      price,
      currency: quote?.currency ?? 'USD',
      priceSource: quote?.source ?? null,
      priceError: quote?.error ?? null,
      tradeClose,
      driftPct,
      sinceFilingPct,
      latestTradeDate: latest.transactionDate,
      latestFilingDate: latestFiling,
      daysSinceFiling,
      avgLagDays: Math.round(
        trades.map((t) => t.lagDays).filter((v) => v != null).reduce((s, v, _, arr) => s + v / arr.length, 0),
      ) || null,
      totalBuyMid: trades.filter((t) => t.direction > 0).reduce((s, t) => s + (t.amountMid ?? 0), 0),
      totalSellMid: trades.filter((t) => t.direction < 0).reduce((s, t) => s + (t.amountMid ?? 0), 0),
      adjustments,
      reasons,
      playbook: PLAYBOOK[action.key],
      trades: trades.map((t) => ({ ...t, summary: describeTrade(t) })),
    });
  }

  // 방향성 있는 신호를 먼저, 그 안에서 점수순으로.
  signals.sort((a, b) => {
    const tier = (s) => (Math.abs(s.net) > 0.05 ? 1 : 0);
    const rank = (s) => (s.action === 'REDUCE' ? s.score + 10 : s.score);
    return tier(b) - tier(a) || rank(b) - rank(a) || (b.latestFilingDate ?? '').localeCompare(a.latestFilingDate ?? '');
  });

  return { signals, summary: summarize(scored, signals, today) };
}

function buildReasons(ctx) {
  const { ticker, trades, latest, latestFiling, daysSinceFiling, price, tradeClose, refTrade, driftPct, sinceFilingPct, net, bull, bear } = ctx;
  const reasons = [];

  // 1) 무엇을 했는가
  const headline = trades.filter((t) => t.weight !== 0).slice(0, 3).map(describeTrade);
  reasons.push({
    tag: '거래 내용',
    text: headline.length ? headline.join(' / ') : describeTrade(latest),
  });

  // 2) 옵션 성격
  const leaps = trades.find((t) => t.leaps);
  if (leaps?.option) {
    const dte = diffDays(new Date().toISOString().slice(0, 10), leaps.option.expiry);
    reasons.push({
      tag: '포지션 성격',
      text: `만기까지 약 ${dte}일 남은 장기 콜옵션(LEAPS)입니다. 현물 대신 레버리지를 택했다는 것은 만기 전 상승 확신이 크다는 뜻입니다. 행사가 ${fmtUSD(leaps.option.strike)} 기준으로 현재가 ${fmtUSD(price)}는 ${price && leaps.option.strike ? (price > leaps.option.strike ? '내가격(ITM)' : '외가격(OTM)') : '판단 불가'}입니다.`,
    });
  }

  // 3) 신고 지연 = 정보의 신선도
  if (latestFiling) {
    const lag = latest.lagDays;
    reasons.push({
      tag: '정보 시차',
      text: `거래일 ${latest.transactionDate} → 공시일 ${latestFiling} (신고까지 ${lag ?? '?'}일). 오늘 기준 공시 후 ${daysSinceFiling}일 경과 — ${daysSinceFiling <= 7 ? '가장 신선한 구간입니다.' : daysSinceFiling <= 45 ? '아직 유효 구간이지만 초기 반응은 지났습니다.' : '이미 시장에 충분히 알려진 정보입니다.'}`,
    });
  }

  // 4) 가격이 얼마나 반영됐는가
  if (Number.isFinite(driftPct)) {
    reasons.push({
      tag: '가격 반영도',
      text: `의원 거래일(${refTrade.transactionDate}) 종가 ${fmtUSD(tradeClose)} → 현재 ${fmtUSD(price)} (${fmtPct(driftPct)})${Number.isFinite(sinceFilingPct) ? `, 공시 이후 ${fmtPct(sinceFilingPct)}` : ''}. ${driftPct >= 30 ? '따라 사면 의원보다 훨씬 비싼 가격에 진입하게 됩니다.' : driftPct >= 10 ? '일부 반영됐으나 아직 추격 여지는 있습니다.' : '아직 거래 당시 가격대와 크게 다르지 않습니다.'}`,
    });
  } else {
    reasons.push({ tag: '가격 반영도', text: '시세 데이터를 가져오지 못해 가격 반영도는 계산하지 못했습니다.' });
  }

  // 5) 반복/규모
  const buys = trades.filter((t) => t.direction > 0);
  const sells = trades.filter((t) => t.kind === 'SELL');
  const donations = trades.filter((t) => t.kind === 'DONATION');
  if (buys.length > 1) {
    const total = buys.reduce((s, t) => s + (t.amountMid ?? 0), 0);
    reasons.push({
      tag: '반복 매수',
      text: `조회 구간에서 ${ticker} 매수 성격 거래가 ${buys.length}건, 신고금액 중간값 합계 약 ${fmtUSD(total)}입니다. 여러 차례 나눠 담았다는 건 일회성 리밸런싱이 아니라는 신호입니다.`,
    });
  }
  if (sells.length) {
    reasons.push({
      tag: '매도 내역',
      text: `실제 매도 ${sells.length}건 (${sells.map((t) => `${t.transactionDate} ${t.amountLabel}`).join(', ')}). 매수 가중치 ${bull.toFixed(2)} vs 매도 가중치 ${bear.toFixed(2)} → 순 방향성 ${net > 0 ? '매수 우위' : net < 0 ? '매도 우위' : '중립'}.`,
    });
  }
  if (donations.length) {
    reasons.push({
      tag: '오해 주의',
      text: `공시상 '매도(S)'로 찍힌 ${donations.length}건은 기부·증여입니다(예: ${donations[0].description.slice(0, 60)}…). 약세 신호로 세지 않았습니다.`,
    });
  }
  const exercises = trades.filter((t) => t.kind === 'EXERCISE');
  if (exercises.length) {
    reasons.push({
      tag: '오해 주의',
      text: `${exercises.length}건은 과거에 산 콜옵션의 행사(현물 전환)입니다. 신규 매수 자금이 아니므로 가중치를 40%만 반영했습니다.`,
    });
  }

  return reasons;
}

function summarize(scored, signals, today) {
  const lags = scored.map((t) => t.lagDays).filter((v) => v != null);
  const latestFiling = scored.map((t) => t.filingDate).filter(Boolean).sort().at(-1) ?? null;
  return {
    today,
    tradeCount: scored.length,
    tickerCount: signals.length,
    buyCount: scored.filter((t) => t.direction > 0).length,
    sellCount: scored.filter((t) => t.kind === 'SELL').length,
    optionCount: scored.filter((t) => t.kind === 'CALL_BUY' || t.kind === 'PUT_BUY').length,
    avgLagDays: lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
    maxLagDays: lags.length ? Math.max(...lags) : null,
    latestFilingDate: latestFiling,
    daysSinceLatestFiling: diffDays(latestFiling, today),
    topBuy: signals.filter((s) => s.net > 0).slice(0, 3).map((s) => s.ticker),
    topSell: signals.filter((s) => s.net < 0).slice(0, 3).map((s) => s.ticker),
  };
}
