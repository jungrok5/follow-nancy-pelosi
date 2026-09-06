// 데이터셋(공시 파싱 결과) + 시세 → 최종 리포트.
// Node 서버와 Cloudflare Worker가 같은 코드를 쓴다.
import { buildSignals } from './signals.js';
import { daysAgoISO } from './util.js';

/**
 * @param dataset  { member, transactions, filings, otherFilings, sources }
 * @param quotesFor (tickers, fromISO) => Promise<Record<ticker, quote>>
 */
export async function composeReport(dataset, { quotesFor, lookbackDays = 400 } = {}) {
  const started = Date.now();
  const windowStart = daysAgoISO(lookbackDays);
  const transactions = dataset.transactions ?? [];

  const tickers = [
    ...new Set(transactions.filter((t) => t.ticker && t.transactionDate >= windowStart).map((t) => t.ticker)),
  ];
  const earliest = transactions.filter((t) => t.ticker).map((t) => t.transactionDate).sort()[0] ?? windowStart;
  const quotes = tickers.length && quotesFor ? await quotesFor(tickers, earliest > windowStart ? windowStart : earliest) : {};

  const { signals, summary } = buildSignals(transactions, quotes, { lookbackDays });

  return {
    member: dataset.member,
    generatedAt: new Date().toISOString(),
    dataBuiltAt: dataset.builtAt ?? null,
    elapsedMs: Date.now() - started,
    lookbackDays,
    summary,
    signals,
    transactions,
    filings: dataset.filings ?? [],
    otherFilings: dataset.otherFilings ?? [],
    quotes: Object.fromEntries(
      Object.entries(quotes).map(([t, q]) => [
        t,
        { price: q.price, currency: q.currency, source: q.source, asOf: q.asOf, error: q.error ?? null, name: q.name ?? null },
      ]),
    ),
    sources: dataset.sources ?? null,
  };
}
