// 시세 조회. fetch만 사용하므로 Node/Workers/브라우저 어디서든 동작한다.
//
// 소스 우선순위와 이유:
//   1) stockanalysis.com — 키 불필요, 데이터센터 IP에서도 열리고 CORS도 허용
//   2) Yahoo Finance     — 데이터가 가장 정확하지만 클라우드 IP에 429를 자주 준다
//   3) Stooq CSV         — 최후 수단(브라우저 검증 페이지에 막히는 경우가 있음)
// GitHub Actions 러너에서 야후가 전부 429를 반환해 시세가 통째로 비는 사고가 있어
// 1)을 기본으로 두었다.
import { DAY_MS, isoFrom } from './util.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const SA = 'https://stockanalysis.com/api';

/** 상장 폐지·심볼 변경 등으로 종목 페이지가 없으면 404가 온다. */
async function fromStockAnalysis(ticker, fromMs) {
  const symbol = encodeURIComponent(ticker.toLowerCase());
  // 1년치(약 24KB)로 충분하면 굳이 5년치(약 115KB)를 받지 않는다.
  const range = Date.now() - fromMs > 340 * DAY_MS ? '5Y' : '1Y';

  const hist = await getJson(`${SA}/symbol/s/${symbol}/history?range=${range}&period=Daily`);
  const rows = Array.isArray(hist?.data) ? hist.data : [];
  const history = rows
    .filter((r) => r?.t && Number.isFinite(r.c))
    .map((r) => ({ date: r.t, close: r.c }))
    .sort((a, b) => a.date.localeCompare(b.date)); // API는 최신순 → 오름차순으로
  if (!history.length) throw new Error('히스토리 없음');

  // 현재가는 별도 엔드포인트가 더 신선하다(장중 실시간, 시간외 포함).
  let price = history.at(-1).close;
  let asOf = `${history.at(-1).date}T00:00:00Z`;
  let previousClose = history.at(-2)?.close ?? null;
  try {
    const q = (await getJson(`${SA}/quotes/s/${symbol}`))?.data;
    if (Number.isFinite(q?.p)) {
      price = q.p;
      previousClose = Number.isFinite(q.cl) ? q.cl : previousClose;
      asOf = q.ts ? new Date(q.ts).toISOString() : asOf;
    }
  } catch {
    // 현재가 조회가 막혀도 종가 기준으로 계속 진행
  }

  return {
    ticker,
    price,
    previousClose,
    currency: 'USD',
    exchange: null,
    name: null,
    history,
    source: 'stockanalysis.com',
    asOf,
  };
}

async function fromYahoo(ticker, fromMs) {
  const period1 = Math.floor((fromMs - 10 * DAY_MS) / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  let lastErr;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const json = await getJson(
        `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`,
      );
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description ?? '결과 없음');
      const closes = result.indicators?.quote?.[0]?.close ?? [];
      const history = (result.timestamp ?? [])
        .map((t, i) => ({ date: isoFrom(t * 1000), close: closes[i] }))
        .filter((p) => Number.isFinite(p.close));
      const meta = result.meta ?? {};
      return {
        ticker,
        price: meta.regularMarketPrice ?? history.at(-1)?.close ?? null,
        previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
        currency: meta.currency ?? 'USD',
        exchange: meta.fullExchangeName ?? null,
        name: meta.longName ?? meta.shortName ?? null,
        history,
        source: 'Yahoo Finance',
        asOf: meta.regularMarketTime
          ? new Date(meta.regularMarketTime * 1000).toISOString()
          : new Date().toISOString(),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('야후 응답 없음');
}

async function fromStooq(ticker) {
  const res = await fetch(`https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`, {
    headers: { 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.text()).trim().split('\n').slice(1).map((l) => l.split(','));
  const history = rows
    .filter((r) => r.length >= 5 && Number.isFinite(Number(r[4])))
    .map((r) => ({ date: r[0], close: Number(r[4]) }));
  if (!history.length) throw new Error('Stooq 응답 파싱 실패');
  return {
    ticker,
    price: history.at(-1).close,
    previousClose: history.at(-2)?.close ?? null,
    currency: 'USD',
    exchange: null,
    name: null,
    history,
    source: 'Stooq (지연 시세)',
    asOf: `${history.at(-1).date}T00:00:00Z`,
  };
}

/** 티커 하나의 시세+일봉. 실패해도 예외 대신 error 필드를 담아 돌려준다. */
export async function fetchQuote(ticker, fromISO) {
  const fromMs = fromISO ? Date.parse(fromISO) : Date.now() - 365 * DAY_MS;
  const errors = [];
  for (const [name, load] of [
    ['stockanalysis', () => fromStockAnalysis(ticker, fromMs)],
    ['yahoo', () => fromYahoo(ticker, fromMs)],
    ['stooq', () => fromStooq(ticker)],
  ]) {
    try {
      return await load();
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  return { ticker, error: `시세 조회 실패 (${errors.join(' / ')})`, history: [], price: null };
}

/** 동시 요청 수를 제한해 공개 API에 부담을 주지 않는다. */
export async function fetchQuotes(tickers, fromISO, { concurrency = 4 } = {}) {
  const unique = [...new Set(tickers.filter(Boolean))];
  const out = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
      while (cursor < unique.length) {
        const i = cursor++;
        out[i] = await fetchQuote(unique[i], fromISO);
      }
    }),
  );
  return Object.fromEntries(out.map((q) => [q.ticker, q]));
}

/** 해당 날짜(또는 그 이전 최근 거래일)의 종가. */
export function closeOn(quote, dateISO) {
  if (!quote?.history?.length) return null;
  let best = null;
  for (const point of quote.history) {
    if (point.date <= dateISO) best = point;
    else break;
  }
  return best?.close ?? null;
}

export const pctChange = (from, to) =>
  Number.isFinite(from) && Number.isFinite(to) && from > 0 ? ((to - from) / from) * 100 : null;
