// Node용 시세 계층: 순수 fetch 모듈(shared/quotes.js)에 10분 메모리 캐시를 씌운다.
import { TTL } from './config.js';
import { memoized } from './lib/cache.js';
import { fetchQuote, fetchQuotes } from '../shared/quotes.js';
import { isoFrom, DAY_MS } from '../shared/util.js';

export { closeOn, pctChange } from '../shared/quotes.js';

export async function getQuote(ticker, fromISO) {
  const fromMs = fromISO ? Date.parse(fromISO) : Date.now() - 365 * DAY_MS;
  return memoized(`quote:${ticker}:${isoFrom(fromMs)}`, TTL.quote, () => fetchQuote(ticker, fromISO));
}

export async function getQuotes(tickers, fromISO) {
  const unique = [...new Set(tickers.filter(Boolean))];
  const results = await Promise.all(unique.map((t) => getQuote(t, fromISO)));
  return Object.fromEntries(results.map((q) => [q.ticker, q]));
}

export { fetchQuotes };
