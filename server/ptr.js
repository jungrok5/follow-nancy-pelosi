// PTR(정기 거래 보고서) PDF → 거래 레코드 파서.
// 사무처 PDF는 표 형태라 텍스트 아이템을 y좌표로 묶어 줄을 복원한 뒤,
// "소유자 | 자산명 | 거래유형 | 거래일 | 통지일 | 금액구간" 패턴으로 블록을 잘라낸다.
let pdfjsPromise;
const loadPdfjs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

const NOISE = [
  /^ID\s+Owner\s+Asset/i,
  /^Type\s+Date\s+Gains/i,
  /^\$200\?$/,
  /^Filing ID #/i,
  /Clerk of the House of Representatives/i,
  /asset type abbreviations/i,
  /^I CERTIFY/i,
  /^Digitally Signed/i,
  /^Name:/i,
  /^Status:/i,
  /^State\/District:/i,
  /^Yes\s+No$/i,
  /^\*/,
  // 서명/인증 문단(자간이 벌어진 머리글 포함)
  /^I\s+P\s+O\b/,
  /^C\s+S\s*$/,
  /my knowledge and belief/i,
  /STOCK Act/i,
  /^P\s+T\s+R\s*$/,
  /^F\s+I\s*$/,
  /^T\s*$/,
  /^[A-Z]\s*$/, // 자간이 벌어진 머리글의 잔여 글자
];

const OWNERS = { SP: '배우자', DC: '자녀', JT: '공동명의', '': '본인' };

export const ASSET_TYPES = {
  ST: '상장주식',
  OP: '옵션',
  AB: '비상장/파트너십',
  MF: '뮤추얼펀드',
  EF: 'ETF',
  CS: '기업채',
  GS: '국공채',
  OT: '기타',
  PS: '비상장주식',
  RP: '부동산',
};

/** PDF 페이지의 텍스트 아이템을 시각적 줄 단위로 복원한다. */
async function extractLines(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5]);
      const key = [...rows.keys()].find((v) => Math.abs(v - y) <= 3) ?? y;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push([item.transform[4], item.str]);
    }
    for (const [, items] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
      // 사무처 PDF는 라벨(FILING STATUS 등)의 자간을 NUL 문자로 채운다. 공백으로 바꿔둔다.
      const raw = items
        .sort((a, b) => a[0] - b[0])
        .map((i) => i[1])
        .join(' ')
        .replace(/\u0000/g, ' ')
        .replace(/[ \t]+$/, '');
      if (raw) lines.push(raw);
    }
  }
  await doc.destroy();
  return lines;
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const toISO = (us) => {
  const m = us?.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};
const money = (s) => Math.round(Number(String(s).replace(/[^\d.]/g, ''))) || 0;

const ROW_START =
  /^(SP|JT|DC)?\s*(.+?)\s+(S \(partial\)|P|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s*(.*)$/;
// "D          : ..." / "F      S     : New" 처럼 자간이 벌어진 라벨 줄
const LABEL = /^([A-Z])(?:\s{2,}[A-Z\s]*?)?:\s*(.*)$/;

/** 설명문에서 옵션/수량 정보를 뽑아낸다. */
function parseDescription(description = '') {
  const d = description;
  const contracts = d.match(/([\d,]+)\s+(call|put)\s+options?/i);
  const strike = d.match(/strike price of \$?([\d,.]+)/i);
  const expiry = d.match(/expiration date of (\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const shares = d.match(/([\d,]+)\s+shares/i);
  return {
    contracts: contracts ? money(contracts[1]) : null,
    optionSide: contracts ? contracts[2].toLowerCase() : null,
    strike: strike ? Number(strike[1].replace(/,/g, '')) : null,
    expiry: expiry ? toISO(expiry[1]) : null,
    shares: shares ? money(shares[1]) : null,
    exercised: /exercis/i.test(d),
    // 기부·증여는 공시 코드상 '매도(S)'로 찍히지만 약세 신호가 아니다.
    donation: /donor-advised|charitab|gift|donation|contribution of|university|foundation/i.test(d),
  };
}

/**
 * 거래의 실질적 성격을 분류한다.
 * 공시 코드(P/S)만 보면 기부·옵션행사까지 매수/매도로 오해하게 되므로,
 * 설명문을 함께 읽어 실제 방향성을 구분한다.
 */
function classify(txType, assetCode, meta) {
  if (txType === 'E') return { kind: 'EXCHANGE', label: '교환', direction: 0 };
  if (txType.startsWith('S')) {
    if (meta.donation) return { kind: 'DONATION', label: '기부(비매도)', direction: 0 };
    return { kind: 'SELL', label: txType === 'S' ? '전량 매도' : '일부 매도', direction: -1 };
  }
  if (meta.exercised) return { kind: 'EXERCISE', label: '콜옵션 행사(현물 전환)', direction: 0.5 };
  if (meta.optionSide === 'put') return { kind: 'PUT_BUY', label: '풋옵션 매수(하락 베팅)', direction: -1 };
  if (meta.optionSide === 'call' || assetCode === 'OP')
    return { kind: 'CALL_BUY', label: '콜옵션 매수(레버리지 강세)', direction: 1 };
  return { kind: 'BUY', label: '현물 매수', direction: 1 };
}

/** PTR PDF 버퍼에서 거래 배열을 뽑는다. */
export async function parsePtr(buffer, filing = {}) {
  const lines = (await extractLines(buffer)).filter(
    (l) => !NOISE.some((re) => re.test(collapse(l))),
  );

  const blocks = [];
  let current = null;
  for (const raw of lines) {
    const line = collapse(raw);
    const start = line.match(ROW_START);
    if (start && toISO(start[4])) {
      if (current) blocks.push(current);
      current = { head: start, headerExtra: [start[6] ?? ''], description: [], status: null, raw: [line] };
      continue;
    }
    if (!current) continue;
    current.raw.push(line);

    const label = raw.match(LABEL);
    if (label) {
      const [, letter, rest] = label;
      if (letter === 'D') current.description.push(rest);
      else if (letter === 'F') current.status = rest;
      continue;
    }
    // 라벨 뒤 줄바꿈은 설명문의 연속, 그 전은 자산명/금액의 연속.
    if (current.description.length) current.description.push(line);
    else current.headerExtra.push(line);
  }
  if (current) blocks.push(current);

  return blocks.map((b) => toTransaction(b, filing)).filter(Boolean);
}

function toTransaction(block, filing) {
  const [, owner = '', assetHead, txType, txDate, notifyDate] = block.head;
  const headerText = collapse([assetHead, ...block.headerExtra].join(' '));

  const amounts = [...headerText.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) => money(m[1]));
  const openEnded = /\$[\d,]+\s*\+/.test(headerText);
  const amountLow = amounts[0] ?? null;
  const amountHigh = openEnded ? null : amounts.length > 1 ? amounts[amounts.length - 1] : amounts[0] ?? null;

  // 금액 구간("$500,001 - $1,000,000")을 통째로 걷어내야 자산명에 '-'가 남지 않는다.
  const assetText = collapse(
    headerText
      .replace(/\$[\d,.]+\s*-\s*/g, '')
      .replace(/\$[\d,.]+\s*\+?/g, '')
      .replace(/\s+-\s*$/, ''),
  );
  const tickers = [...assetText.matchAll(/\(([A-Z][A-Z.\-]{0,5})\)/g)].map((m) => m[1]);
  const codes = [...assetText.matchAll(/\[([A-Z]{2})\]/g)].map((m) => m[1]);
  const ticker = tickers.length ? tickers[tickers.length - 1] : null;
  const assetCode = codes.length ? codes[codes.length - 1] : null;

  const description = collapse(block.description.join(' '));
  const meta = parseDescription(description);
  const cls = classify(txType, assetCode, meta);

  const transactionDate = toISO(txDate);
  if (!transactionDate) return null;

  return {
    docId: filing.docId ?? null,
    filingDate: filing.filingDate ?? null,
    pdfUrl: filing.pdfUrl ?? null,
    owner: OWNERS[owner] ?? owner,
    ownerCode: owner || 'SELF',
    asset: collapse(assetText.replace(/\[[A-Z]{2}\]/g, '')),
    ticker,
    assetCode,
    assetType: ASSET_TYPES[assetCode] ?? (assetCode ? '기타' : null),
    txType,
    kind: cls.kind,
    kindLabel: cls.label,
    direction: cls.direction,
    transactionDate,
    notificationDate: toISO(notifyDate),
    amountLow,
    amountHigh,
    amountMid: amountHigh ? Math.round((amountLow + amountHigh) / 2) : amountLow,
    amountLabel:
      amountHigh == null
        ? `$${(amountLow ?? 0).toLocaleString()} 이상`
        : amountHigh === amountLow
          ? `$${amountLow.toLocaleString()}`
          : `$${amountLow.toLocaleString()} ~ $${amountHigh.toLocaleString()}`,
    description,
    filingStatus: block.status,
    option: meta.optionSide
      ? { side: meta.optionSide, contracts: meta.contracts, strike: meta.strike, expiry: meta.expiry }
      : null,
    shares: meta.shares,
    lagDays: diffDays(transactionDate, filing.filingDate),
    raw: block.raw.join('\n'),
  };
}

export function diffDays(fromISO, toISO_) {
  if (!fromISO || !toISO_) return null;
  return Math.round((Date.parse(toISO_) - Date.parse(fromISO)) / 86400000);
}
