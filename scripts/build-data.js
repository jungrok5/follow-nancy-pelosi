#!/usr/bin/env node
// 공시 원본을 파싱해 정적 스냅샷(JSON)으로 굽는다.
// Cloudflare Workers에서는 PDF 파싱이 불가능하므로, 이 스크립트를
// GitHub Actions(또는 로컬)에서 돌려 만든 결과를 Worker가 서빙한다.
//
//   node scripts/build-data.js                       # 기본 대상(MEMBER) 스냅샷
//   node scripts/build-data.js --member "Pelosi, Nancy" --out public/data/snapshot.json
import fs from 'node:fs';
import path from 'node:path';
import { buildDataset, getTraders } from '../server/tracker.js';
import { getQuotes } from '../server/prices.js';
import { composeReport } from '../shared/report.js';
import { DEFAULT_MEMBER, LOOKBACK_DAYS, ROOT } from '../server/config.js';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const member = argOf('member', DEFAULT_MEMBER);
const lookbackDays = Number(argOf('days', LOOKBACK_DAYS));
const out = path.resolve(ROOT, argOf('out', 'public/data/snapshot.json'));
const withTraders = !args.includes('--no-traders');
// 정적 호스팅(GitHub Pages 등)에서는 서버가 없으므로 시세·시그널까지 구운
// 완제품 리포트를 함께 만들어 둔다. Worker 배포에서는 쓰이지 않는다.
const withReport = !args.includes('--no-report');

const dataset = await buildDataset({ member, lookbackDays, force: true });
if (withTraders) {
  try {
    dataset.traders = (await getTraders()).slice(0, 200);
  } catch (err) {
    console.warn('의원 목록 수집 실패(무시하고 진행):', err.message);
  }
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(dataset));
const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(
  `✔ ${dataset.member.displayName} · 공시 ${dataset.filings.length}건 · 거래 ${dataset.transactions.length}건 → ${path.relative(ROOT, out)} (${kb} KB)`,
);

if (withReport) {
  const report = await composeReport(dataset, { quotesFor: getQuotes, lookbackDays });
  report.traders = dataset.traders ?? [];
  report.deployment = { mode: 'static', builtAt: new Date().toISOString() };
  const reportOut = path.join(path.dirname(out), 'report.json');
  fs.writeFileSync(reportOut, JSON.stringify(report));
  const rkb = (fs.statSync(reportOut).size / 1024).toFixed(1);
  console.log(
    `✔ 시그널 ${report.signals.length}개 · 시세 ${Object.keys(report.quotes).length}종목 → ${path.relative(ROOT, reportOut)} (${rkb} KB)`,
  );
}
