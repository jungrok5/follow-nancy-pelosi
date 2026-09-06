// 공시 인덱스 → PTR PDF → 거래 파싱 → 시세 → 시그널로 이어지는 파이프라인.
import { DEFAULT_MEMBER, LOOKBACK_DAYS, CLERK } from './config.js';
import {
  loadIndex, matchMember, listTraders, fetchPtrPdf, FILING_TYPES,
  searchLiveFilings, fetchPtrPublishedAt,
} from './clerk.js';
import { parsePtr } from './ptr.js';
import { getQuotes } from './prices.js';
import { composeReport } from '../shared/report.js';
import { memoized } from './lib/cache.js';
import { daysAgoISO, etDate } from '../shared/util.js';

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
  const profile0 = mine[0];
  const byDoc = new Map();
  for (const f of mine) {
    if (f.filingType !== 'P') continue;
    byDoc.set(f.docId, { ...f, discoveredVia: 'index' });
  }

  // 연도별 ZIP은 평일 하루 1회 정도만 갱신되므로(주말엔 금요일자 그대로),
  // 라이브 검색으로 ZIP에 아직 없는 신규 공시를 함께 잡는다.
  let liveError = null;
  try {
    const years = [...new Set(mine.map((f) => f.indexYear))];
    for (const f of await searchLiveFilings({ last: profile0.last, years })) {
      if (byDoc.has(f.docId)) continue;
      byDoc.set(f.docId, {
        ...f,
        first: profile0.first,
        last: profile0.last,
        prefix: profile0.prefix,
        filingDate: null, // 게시 시각(Last-Modified)에서 채운다
        discoveredVia: 'live-search',
      });
    }
  } catch (err) {
    liveError = String(err.message ?? err);
  }

  // PDF의 Last-Modified = 공시가 실제로 공개된 시각(분 단위).
  const candidates = [...byDoc.values()];
  await mapLimit(candidates, 4, async (f) => {
    try {
      f.publishedAt = await fetchPtrPublishedAt(f);
    } catch {
      f.publishedAt = null;
    }
    if (!f.filingDate && f.publishedAt) f.filingDate = etDate(f.publishedAt);
  });

  const ptrFilings = candidates
    .filter((f) => f.filingDate && f.filingDate >= cutoff)
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
      liveSearch: liveError ? { ok: false, error: liveError } : { ok: true, newFilings: candidates.filter((f) => f.discoveredVia === 'live-search').length },
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
