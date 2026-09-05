# 펠로시 트래커 (Follow Nancy Pelosi)

미 하원 사무처(Clerk of the U.S. House) **공시 원본을 실시간으로 직접 파싱**해서
낸시 펠로시(및 다른 하원의원)의 주식 거래를 보여주고, **무엇을 사고/팔지 근거와 함께** 제시하는 웹앱입니다.

3rd-party 트래킹 사이트(Quiver, Capitol Trades 등)를 크롤링하지 않고,
연도별 공시 인덱스 ZIP → PTR(정기 거래 보고서) PDF → 거래 레코드까지 서버가 직접 처리합니다. **API 키가 필요 없습니다.**

<p align="center"><em>매매 시그널 · 오늘의 결론 · 전체 거래 내역 · 원본 PDF 링크</em></p>

## 실행

```bash
npm install
npm start          # http://localhost:3000
```

환경변수(전부 선택):

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 서버 바인딩 |
| `MEMBER` | `Pelosi, Nancy` | 기본 추적 대상 (`성, 이름`) |
| `LOOKBACK_DAYS` | `400` | 시그널 계산에 포함할 거래일 범위 |
| `YEARS_BACK` | `2` | 공시 인덱스를 훑을 연도 수 |
| `CACHE_DIR` | `./.cache` | 다운로드 캐시 위치 |

## 데이터 파이프라인

```
disclosures-clerk.house.gov/public_disc/financial-pdfs/{연도}FD.ZIP   ← 공시 인덱스(누가 언제 무엇을 제출했는가)
        │  unzip → XML 파싱 → 대상 의원의 FilingType=P(PTR)만 추출
        ▼
disclosures-clerk.house.gov/public_disc/ptr-pdfs/{연도}/{DocID}.pdf   ← 실제 거래 내역
        │  pdfjs로 텍스트 추출 → 좌표 기반 표 복원 → 거래 레코드
        ▼
Yahoo Finance(실패 시 Stooq) 일봉/현재가  →  시그널 엔진  →  /api/report
```

- 인덱스 ZIP은 3시간, PTR PDF는 DocID 단위로 영구, 시세는 10분 캐시합니다.
- 원본이 일시적으로 죽으면 마지막 캐시로 서비스가 계속 동작합니다.
- 브라우저의 **새로고침** 버튼은 캐시를 무시하고 원본을 다시 받아옵니다(`?refresh=1`).

## 시그널을 어떻게 계산하나

공시 코드(P/S)를 그대로 믿으면 오독합니다. 이 앱은 설명문까지 읽어 **거래의 실질**을 먼저 분류합니다.

| 분류 | 의미 | 가중치 |
| --- | --- | --- |
| `CALL_BUY` | 콜옵션 신규 매수(레버리지 강세 베팅) | **+1.6** (만기 6개월 이상 LEAPS면 +0.2) |
| `BUY` | 현물 매수 | +1.0 |
| `EXERCISE` | 과거 매수한 콜옵션의 행사 → 현물 전환 (신규 자금 아님) | +0.4 |
| `SELL` | 실제 매도 | −1.0 |
| `PUT_BUY` | 풋옵션 매수(하락 베팅) | −1.5 |
| `DONATION` | 기부·증여 (공시에는 '매도(S)'로 찍히지만 약세 신호가 아님) | 0 |
| `EXCHANGE` | 분할·스핀오프 등 이벤트 | 0 |

각 거래 가중치 = `규모가중치 × 성격가중치 × 최신성감쇠`

- **규모**: 신고 금액 구간의 중간값을 로그 스케일로 (약 $1M ≈ 1.0)
- **최신성**: `exp(-거래 후 경과일 / 240)`
- 티커별로 합산한 순 방향성(`net`)을 0~100 점수로 환산한 뒤 다음을 보정합니다.
  - 최근 공시가 45일을 넘겼으면 ×0.75 (정보가 이미 퍼짐)
  - 의원 거래일 종가 대비 현재가가 **+30% 이상이면 −15점**, +15% 이상 −8점, 하락 상태면 +6점
- 결과를 5개 행동안으로 매핑: `따라 매수 검토` / `분할 매수 검토` / `추격 주의·눌림목 대기` / `관망` / `비중 축소 신호`

각 카드에는 점수 대신 **읽을 수 있는 근거**가 붙습니다 — 거래 내용, 옵션 만기·행사가와 ITM/OTM 여부,
신고 지연일과 공시 후 경과일, 거래일 종가 대비 현재가(= 지금 따라 사면 얼마나 비싸게 사는지), 반복 매수 여부,
그리고 기부·옵션행사처럼 오해하기 쉬운 항목의 별도 설명.

## API

| 엔드포인트 | 설명 |
| --- | --- |
| `GET /api/report?member=Pelosi,%20Nancy&refresh=1&days=400` | 시그널 + 거래 + 공시 문서 + 시세 전체 |
| `GET /api/traders` | 최근 PTR을 제출한 의원 목록(검색 자동완성용) |
| `GET /api/health` | 헬스체크 |

`/api/report` 응답 요약:

```jsonc
{
  "member": { "displayName": "Hon. Nancy Pelosi", "stateDst": "CA11" },
  "summary": { "latestFilingDate": "…", "avgLagDays": 21, "topBuy": ["INTC", "BE"] },
  "signals": [{ "ticker": "INTC", "action": "BUY", "score": 100, "driftPct": 3.8,
                "reasons": [{ "tag": "가격 반영도", "text": "…" }], "playbook": "…", "trades": [] }],
  "transactions": [{ "ticker": "BE", "kind": "CALL_BUY", "option": { "strike": 100, "expiry": "2027-06-17" } }],
  "filings": [{ "docId": "20035143", "pdfUrl": "https://disclosures-clerk.house.gov/…" }]
}
```

## 한계와 주의

- **최대 45일의 신고 지연**이 구조적 한계입니다. 공시를 본 시점엔 이미 주가가 움직였을 수 있어,
  각 시그널에 "거래일 대비 현재가" 를 반드시 함께 표시합니다.
- 거래 금액은 구간(예: `$1,000,001 ~ $5,000,000`)으로만 공개되어 정확한 규모를 알 수 없습니다.
- 대부분의 거래는 배우자(폴 펠로시) 명의이며, 의원 본인의 판단이라는 보장이 없습니다.
- PTR PDF의 표 레이아웃이 바뀌면 파서 보정이 필요합니다(`server/ptr.js`).
- 이 프로젝트는 공개 정보를 정리·해석한 **정보 제공용**이며 투자 자문이 아닙니다. 투자 판단과 책임은 본인에게 있습니다.

## 구조

```
server/
  index.js     HTTP 서버 + 정적 파일 + /api
  tracker.js   인덱스 → PDF → 파싱 → 시세 → 시그널 파이프라인
  clerk.js     하원 사무처 공시 인덱스/PDF
  ptr.js       PTR PDF → 거래 레코드 파서
  prices.js    시세(Yahoo → Stooq 폴백)
  signals.js   시그널 점수·행동안·근거 문장 생성
  lib/         http 재시도, 디스크 캐시, 최소 ZIP 리더
public/        정적 프런트엔드(바닐라 JS)
```
