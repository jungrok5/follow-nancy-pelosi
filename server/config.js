import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const CACHE_DIR = process.env.CACHE_DIR || path.join(ROOT, '.cache');

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';

/** 기본 추적 대상. ?member=lastName,firstName 으로 바꿀 수 있다. */
export const DEFAULT_MEMBER = process.env.MEMBER || 'Pelosi, Nancy';

/** 인덱스에서 훑을 연도 수(올해 포함). 신고 지연이 최대 45일이라 2년이면 충분하다. */
export const YEARS_BACK = Number(process.env.YEARS_BACK || 2);

/** 시그널 계산에 포함할 거래일 범위(일). */
export const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 400);

export const TTL = {
  index: 3 * 60 * 60 * 1000, // 사무처 인덱스 ZIP: 3시간
  pdf: Infinity,             // DocID별 PDF는 불변
  quote: 10 * 60 * 1000,     // 시세: 10분
};

export const CLERK = {
  zipUrl: (year) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.ZIP`,
  ptrPdfUrl: (year, docId) =>
    `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`,
  searchUrl: 'https://disclosures-clerk.house.gov/FinancialDisclosure',
};
