// Node와 Cloudflare Workers 양쪽에서 쓰는 순수 유틸(런타임 의존성 없음).
export const DAY_MS = 86400000;

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const isoFrom = (ms) => new Date(ms).toISOString().slice(0, 10);

export const daysAgoISO = (days) => isoFrom(Date.now() - days * DAY_MS);

/** 두 ISO 날짜 사이의 일수. 하나라도 없으면 null. */
export function diffDays(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / DAY_MS);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const fmtUSD = (n) =>
  Number.isFinite(n) ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—';

export const fmtPct = (n) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—');

/** ISO 시각을 미 동부(공시 기준 시간대) 날짜 'YYYY-MM-DD'로. */
export const etDate = (iso) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

/** ISO 시각을 '2026-08-21 10:26 ET' 형태로. */
export const etDateTime = (iso) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso)).replace(',', '') + ' ET';

export const hoursSince = (iso) => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 3600000) : null);
