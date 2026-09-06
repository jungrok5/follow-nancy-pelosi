// 미 하원 사무처(Clerk of the House) 공시 인덱스 처리.
// 연도별 FD.ZIP 안의 XML이 "누가 언제 무슨 보고서를 냈는지"의 원본 목록이다.
// 개별 거래 내역은 PTR(Periodic Transaction Report) PDF 안에 들어있다.
import { CLERK, TTL, YEARS_BACK } from './config.js';
import { cached, cachedJson } from './lib/cache.js';
import { fetchRaw, fetchResponse } from './lib/http.js';
import { unzip } from './lib/zip.js';

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
};

/** 'M/D/YYYY' → 'YYYY-MM-DD' */
function normalizeDate(usDate) {
  const m = usDate?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export const FILING_TYPES = {
  P: '정기 거래 보고서(PTR)',
  O: '연간 보고서',
  A: '수정 보고서',
  C: '후보자 보고서',
  X: '신규 임용 보고서',
  W: '면제 신청',
  D: '기타',
  T: '종료 보고서',
};

async function loadYearIndex(year, { force = false } = {}) {
  const { buffer, cachedAt, fromCache } = await cached(
    `clerk-index-${year}`,
    TTL.index,
    () => fetchRaw(CLERK.zipUrl(year), { timeoutMs: 60000 }),
    { force },
  );
  const files = unzip(buffer);
  const xmlName = [...files.keys()].find((n) => n.toLowerCase().endsWith('.xml'));
  if (!xmlName) throw new Error(`${year}FD.ZIP 안에 XML이 없습니다`);
  const xml = files.get(xmlName).toString('utf8');

  const filings = [];
  for (const block of xml.match(/<Member>[\s\S]*?<\/Member>/g) ?? []) {
    const last = tag(block, 'Last');
    const first = tag(block, 'First');
    filings.push({
      last,
      first,
      prefix: tag(block, 'Prefix'),
      suffix: tag(block, 'Suffix'),
      name: `${last}, ${first}`.trim(),
      filingType: tag(block, 'FilingType'),
      stateDst: tag(block, 'StateDst'),
      year: Number(tag(block, 'Year')) || year,
      indexYear: year,
      filingDate: normalizeDate(tag(block, 'FilingDate')),
      docId: tag(block, 'DocID'),
    });
  }
  return { filings, cachedAt, fromCache };
}

/** 최근 YEARS_BACK 연도의 공시 인덱스를 합쳐서 반환. */
export async function loadIndex({ years = YEARS_BACK, force = false } = {}) {
  const thisYear = new Date().getUTCFullYear();
  const wanted = Array.from({ length: years }, (_, i) => thisYear - i);
  const results = await Promise.allSettled(wanted.map((y) => loadYearIndex(y, { force })));

  const filings = [];
  const sources = [];
  for (const [i, res] of results.entries()) {
    if (res.status === 'fulfilled') {
      filings.push(...res.value.filings);
      sources.push({ year: wanted[i], count: res.value.filings.length, cachedAt: res.value.cachedAt, fromCache: res.value.fromCache });
    } else {
      sources.push({ year: wanted[i], error: String(res.reason?.message ?? res.reason) });
    }
  }
  if (!filings.length) throw new Error('하원 사무처 공시 인덱스를 가져오지 못했습니다.');
  return { filings, sources };
}

const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

/** '펠로시' 같은 표기까지 흡수하기 위해 성/이름을 느슨하게 매칭한다. */
export function matchMember(filings, query) {
  const [qLast, qFirst] = String(query).split(',').map((s) => norm(s || ''));
  return filings.filter((f) => {
    if (!qLast) return false;
    if (!norm(f.last).includes(qLast)) return false;
    if (qFirst && !norm(f.first).startsWith(qFirst)) return false;
    return true;
  });
}

/** PTR을 한 번이라도 낸 의원 목록(검색용). */
export function listTraders(filings) {
  const map = new Map();
  for (const f of filings) {
    if (f.filingType !== 'P') continue;
    const key = f.name;
    const cur = map.get(key) ?? { name: key, last: f.last, first: f.first, stateDst: f.stateDst, ptrCount: 0, latestFiling: null };
    cur.ptrCount++;
    if (!cur.latestFiling || (f.filingDate ?? '') > cur.latestFiling) cur.latestFiling = f.filingDate;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => (b.latestFiling ?? '').localeCompare(a.latestFiling ?? ''));
}

/** PTR PDF 원문을 받아온다(DocID 단위로 영구 캐시). */
export async function fetchPtrPdf(filing, { force = false } = {}) {
  const url = CLERK.ptrPdfUrl(filing.indexYear ?? filing.year, filing.docId);
  const { buffer } = await cached(`ptr-${filing.docId}`, TTL.pdf, () => fetchRaw(url, { timeoutMs: 60000 }), { force });
  return { buffer, url };
}

// ── 실시간 공시 탐지 ────────────────────────────────────────────────
// 연도별 FD.ZIP은 평일에 하루 한 번 정도만 다시 만들어진다(주말에는 금요일자 그대로).
// 사무처 검색 폼은 라이브 DB를 조회하므로, 이걸 같이 쓰면 ZIP에 아직 없는 신규 공시를
// 게시 직후에 잡아낼 수 있다.
const SEARCH_PAGE = 'https://disclosures-clerk.house.gov/FinancialDisclosure/ViewSearch';
const SEARCH_POST = 'https://disclosures-clerk.house.gov/FinancialDisclosure/ViewMemberSearchResult';

const stripTags = (html) =>
  html.replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** 검색 폼의 위조 방지 토큰과 세션 쿠키를 함께 얻는다. */
async function getSearchToken() {
  const res = await fetchResponse(SEARCH_PAGE, { timeoutMs: 20000, retries: 2 });
  const html = await res.text();
  const token = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
  if (!token) throw new Error('검색 토큰을 찾지 못했습니다');
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  return { token, cookie };
}

/** 라이브 검색으로 특정 의원의 공시 문서를 찾는다(연도별). */
export async function searchLiveFilings({ last, years = [new Date().getUTCFullYear()] }) {
  const { token, cookie } = await getSearchToken();
  const found = [];

  for (const year of years) {
    const body = new URLSearchParams({
      LastName: last,
      FilingYear: String(year),
      State: '',
      District: '',
      __RequestVerificationToken: token,
    });
    const res = await fetchResponse(SEARCH_POST, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, referer: SEARCH_PAGE },
      body,
      timeoutMs: 25000,
      retries: 2,
    });
    if (!res.ok) continue;
    const html = await res.text();

    for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
      const href = row.match(/href="([^"]*ptr-pdfs\/(\d{4})\/(\d+)\.pdf)"/i);
      if (!href) continue; // PTR이 아닌 문서(연간보고서 등)는 건너뛴다
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => stripTags(m[1]));
      found.push({
        docId: href[3],
        indexYear: Number(href[2]),
        year: Number(cells[2]) || Number(href[2]),
        name: cells[0] ?? '',
        stateDst: cells[1] ?? '',
        filingType: 'P',
        filingLabel: cells[3] ?? 'PTR',
        pdfUrl: new URL(href[1], 'https://disclosures-clerk.house.gov/').toString(),
        discoveredVia: 'live-search',
      });
    }
  }
  return found;
}

/**
 * PTR PDF의 게시 시각. 사무처 서버의 Last-Modified가 곧 "공시가 공개된 순간"이라
 * 공시 후 경과 시간을 시간 단위로 알 수 있다.
 */
export async function fetchPtrPublishedAt(filing) {
  const url = filing.pdfUrl ?? CLERK.ptrPdfUrl(filing.indexYear ?? filing.year, filing.docId);
  const { buffer } = await cachedJson(
    `ptr-meta-${filing.docId}`,
    TTL.pdf,
    async () => {
      const res = await fetchResponse(url, { method: 'HEAD', timeoutMs: 20000, retries: 2 });
      const lastModified = res.headers.get('last-modified');
      return { publishedAt: lastModified ? new Date(lastModified).toISOString() : null };
    },
  ).then((r) => ({ buffer: r.value }));
  return buffer.publishedAt ?? null;
}
