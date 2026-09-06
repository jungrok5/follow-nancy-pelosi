// 공시 인덱스 → PTR PDF → 거래 파싱 → 시세 → 시그널로 이어지는 파이프라인.
import { DEFAULT_MEMBER, LOOKBACK_DAYS, CLERK } from './config.js';
import { loadIndex, matchMember, listTraders, fetchPtrPdf, FILING_TYPES } from './clerk.js';
import { parsePtr } from './ptr.js';
import { getQuotes } from './prices.js';
import { composeReport } from '../shared/report.js';
import { memoized } from './lib/cache.js';
import { daysAgoISO } from '../shared/util.js';

const REPORT_TTL = 15 * 60 * 1000;

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

export async function getReport({ member = DEFAULT_MEMBER, force = false, lookbackDays = LOOKBACK_DAYS } = {}) {
  const dataset = force
    ? await buildDataset({ member, force, lookbackDays })
    : await memoized(`dataset:${member}:${lookbackDays}`, REPORT_TTL, () => buildDataset({ member, lookbackDays }));
  return composeReport(dataset, { quotesFor: getQuotes, lookbackDays });
}

/** 공시 인덱스 → PTR PDF → 거래 레코드까지. (시세·시그널은 포함하지 않는다) */
export async function buildDataset({ member = DEFAULT_MEMBER, force = false, lookbackDays = LOOKBACK_DAYS } = {}) {
  const { filings, sources } = await loadIndex({ force });
  const mine = matchMember(filings, member);
  if (!mine.length) {
    const err = new Error(`'${member}' 이름의 공시를 찾지 못했습니다.`);
    err.status = 404;
    throw err;
  }

  // PTR(정기 거래 보고서)만 거래 내역을 담고 있다.
  const cutoff = daysAgoISO(lookbackDays + 120);
  const ptrFilings = mine
    .filter((f) => f.filingType === 'P' && f.filingDate && f.filingDate >= cutoff)
    .sort((a, b) => b.filingDate.localeCompare(a.filingDate))
    .slice(0, 20);

  const parsed = await mapLimit(ptrFilings, 4, async (filing) => {
    try {
      const { buffer, url } = await fetchPtrPdf(filing, { force });
      const transactions = await parsePtr(buffer, { ...filing, pdfUrl: url });
      return { filing: { ...filing, pdfUrl: url, transactionCount: transactions.length }, transactions };
    } catch (err) {
      return {
        filing: { ...filing, pdfUrl: CLERK.ptrPdfUrl(filing.indexYear, filing.docId), error: String(err.message ?? err) },
        transactions: [],
      };
    }
  });

  const transactions = parsed
    .flatMap((p) => p.transactions)
    .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate) || (b.filingDate ?? '').localeCompare(a.filingDate ?? ''));

  const profile = mine[0];
  return {
    member: {
      query: member,
      name: `${profile.first} ${profile.last}`.trim(),
      displayName: `${profile.prefix ? profile.prefix + ' ' : ''}${profile.first} ${profile.last}`.trim(),
      stateDst: profile.stateDst,
    },
    builtAt: new Date().toISOString(),
    lookbackDays,
    transactions,
    filings: parsed.map((p) => p.filing),
    otherFilings: mine
      .filter((f) => f.filingType !== 'P')
      .slice(0, 10)
      .map((f) => ({ ...f, typeLabel: FILING_TYPES[f.filingType] ?? f.filingType })),
    sources: {
      index: sources,
      origin: CLERK.searchUrl,
      note: '원본: 미 하원 사무처(Clerk of the U.S. House) 재무공시 데이터',
    },
  };
}

export async function getTraders() {
  return memoized('traders', REPORT_TTL, async () => {
    const { filings } = await loadIndex();
    return listTraders(filings);
  });
}
