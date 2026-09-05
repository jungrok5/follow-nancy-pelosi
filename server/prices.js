// 시세 조회. 기본은 야후 파이낸스 차트 API(키 불필요),
// 막히면 Stooq CSV로 대체한다. 둘 다 실패해도 앱은 가격 없이 동작한다.
import { TTL } from './config.js';
import { memoized } from './lib/cache.js';
import { fetchJson, fetchText } from './lib/http.js';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

async function fromYahoo(ticker, fromMs) {
  const period1 = Math.floor((fromMs - 10 * DAY) / 1000);
  const period2 = Math.floor(Date.now() / 1000) + DAY / 1000;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`;
      const json = await fetchJson(url, { timeoutMs: 20000, retries: 1 });
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description ?? '결과 없음');
      const closes = result.indicators?.quote?.[0]?.close ?? [];
      const history = (result.timestamp ?? [])
        .map((t, i) => ({ date: iso(t * 1000), close: closes[i] }))
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
        asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('야후 응답 없음');
}

async function fromStooq(ticker) {
  const csv = await fetchText(`https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`, {
    timeoutMs: 20000,
    retries: 1,
  });
  const rows = csv.trim().split('\n').slice(1).map((l) => l.split(','));
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

/** 티커 하나의 시세+일봉을 가져온다(10분 캐시). */
export async function getQuote(ticker, fromISO) {
  const fromMs = fromISO ? Date.parse(fromISO) : Date.now() - 365 * DAY;
  return memoized(`quote:${ticker}:${iso(fromMs)}`, TTL.quote, async () => {
    try {
      return await fromYahoo(ticker, fromMs);
    } catch (yahooErr) {
      try {
        return await fromStooq(ticker);
      } catch {
        return { ticker, error: `시세 조회 실패: ${yahooErr.message}`, history: [], price: null };
      }
    }
  });
}

export async function getQuotes(tickers, fromISO) {
  const unique = [...new Set(tickers.filter(Boolean))];
  const results = await Promise.all(unique.map((t) => getQuote(t, fromISO)));
  return Object.fromEntries(results.map((q) => [q.ticker, q]));
}

/** 해당 날짜(이전 최근 거래일 포함)의 종가. */
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
