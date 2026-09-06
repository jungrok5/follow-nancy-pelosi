#!/usr/bin/env node
// 원본 공시 → 파싱 → 시그널까지 실제로 도는지 확인하는 최소 스모크 테스트.
import { getReport } from '../server/tracker.js';
import { buildSignals } from '../shared/signals.js';

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✔ ${msg}`);

// 1) 시그널 엔진: 기부는 매도로 세지 않는다 (고정 입력 검증)
const fixture = [
  { ticker: 'TST', asset: 'Test Corp', transactionDate: '2026-08-01', filingDate: '2026-08-10',
    kind: 'CALL_BUY', kindLabel: '콜옵션 매수', direction: 1, amountLow: 500001, amountHigh: 1000000,
    amountMid: 750000, amountLabel: '$500,001 ~ $1,000,000', option: { side: 'call', strike: 10, expiry: '2027-06-17' }, lagDays: 9, description: '' },
  { ticker: 'TST', asset: 'Test Corp', transactionDate: '2026-08-02', filingDate: '2026-08-10',
    kind: 'DONATION', kindLabel: '기부', direction: 0, amountLow: 1000001, amountHigh: 5000000,
    amountMid: 3000000, amountLabel: '$1,000,001 ~ $5,000,000', option: null, lagDays: 8, description: 'Contribution to Donor-Advised Fund.' },
];
const { signals } = buildSignals(fixture, {}, { today: '2026-08-20', lookbackDays: 400 });
if (signals.length !== 1) fail(`시그널 1개를 기대했지만 ${signals.length}개`);
else if (signals[0].bear !== 0) fail(`기부가 약세 가중치로 잡혔습니다 (bear=${signals[0].bear})`);
else ok(`시그널 엔진: 기부 제외 확인 (${signals[0].ticker} ${signals[0].actionLabel}, ${signals[0].score}점)`);

// 2) 실제 공시 파이프라인
const report = await getReport({ force: true });
if (!report.transactions.length) fail('공시에서 거래를 하나도 파싱하지 못했습니다');
else ok(`공시 파이프라인: ${report.member.displayName} 거래 ${report.transactions.length}건 / 시그널 ${report.signals.length}개`);

const withTicker = report.transactions.filter((t) => t.ticker).length;
if (withTicker === 0) fail('티커를 추출한 거래가 없습니다 (PDF 레이아웃 변경 의심)');
else ok(`티커 추출 ${withTicker}/${report.transactions.length}건`);

if (!report.signals.every((s) => s.reasons?.length)) fail('근거가 비어 있는 시그널이 있습니다');
else ok('모든 시그널에 근거 문장 존재');
