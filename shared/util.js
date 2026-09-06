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
