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

## Cloudflare 배포 (자동 배포 포함)

**결론: 가능합니다. 단, 앱을 그대로 올릴 수는 없어서 무거운 부분과 가벼운 부분을 나눴습니다.**

Cloudflare Workers 런타임(workerd)에서는 `pdfjs-dist`가 모듈 초기화 단계에서 실패합니다
(`TypeError: Cannot set properties of undefined (setting '_isSameOrigin')` — legacy/일반 빌드 모두).
게다가 무료 플랜은 요청당 CPU 10ms 제한이라, PDF 여러 개를 파싱하는 작업 자체가 맞지 않습니다.
그래서 **PDF 파싱만 GitHub Actions로 빼고, 나머지는 Worker에서 실행**합니다.

```
GitHub Actions (매시 정각)                       Cloudflare Worker (요청 시)
┌────────────────────────────┐                 ┌──────────────────────────────┐
│ 사무처 ZIP → PTR PDF 파싱   │  snapshot.json  │ 스냅샷 로드 (KV → assets)     │
│ npm run build:data         │ ──────────────▶ │ + 야후 실시간 시세 조회        │
│ wrangler deploy            │                 │ + 시그널 재계산 → /api/report │
└────────────────────────────┘                 └──────────────────────────────┘
```

- **주가는 항상 실시간**입니다. 시세 조회와 시그널 계산은 요청 시점에 Worker가 수행합니다
  (네트워크 대기는 Workers CPU 시간에 산정되지 않고, 시그널 계산은 수 ms 수준이라 무료 플랜으로 충분).
- **공시 데이터는 크론 주기**(기본 1시간)로 갱신됩니다. 원본 공시가 하루 단위로 올라오므로 실질적인 손실은 없습니다.
- 리포트 응답은 엣지에서 5분 캐시하고, `?refresh=1`로 우회할 수 있습니다.

### 1) 수동 배포

```bash
npx wrangler login
npm run cf:deploy      # = build:data + wrangler deploy
```

`https://follow-nancy-pelosi.<계정>.workers.dev` 로 뜹니다. 커스텀 도메인은 Cloudflare 대시보드에서 연결하세요.

> 📄 **클릭 단위 상세 가이드(퍼블릭 전환 안전 점검 + Cloudflare 값 발급 위치)는 [docs/DEPLOY.md](docs/DEPLOY.md)에 있습니다.**

### 2) 자동 배포 (GitHub Actions)

`.github/workflows/deploy.yml`이 **푸시 · 매시 정각 · 수동 실행** 세 가지로 동작합니다.
저장소 Settings → Secrets and variables → Actions 에 두 개만 넣으면 끝입니다.

| 시크릿 | 얻는 곳 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare 대시보드 → My Profile → API Tokens → **Edit Cloudflare Workers** 템플릿 |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages 개요 페이지 우측 |
| `KV_NAMESPACE_ID` *(선택)* | `npx wrangler kv namespace create TRACKER_KV` 출력값 |

> 스케줄 트리거는 **기본 브랜치(main)에 워크플로 파일이 있어야** 동작합니다. 브랜치에 머지한 뒤부터 크론이 돕니다.

`KV_NAMESPACE_ID`를 넣고 `wrangler.toml`의 `[[kv_namespaces]]` 주석을 풀면, 공시 갱신 때
**재배포 없이 KV만 업데이트**됩니다(배포 횟수를 아끼고 롤백 위험도 줄어듭니다). 없으면 배포에 포함된
`public/data/snapshot.json`을 그대로 사용합니다.

### 3) Node 서버를 그대로 올리고 싶다면

Worker로 나누는 게 싫다면 PDF 파싱까지 한 프로세스에서 도는 원본 구조 그대로
Fly.io · Render · Railway · 일반 VPS(도커 없이 `npm start`)에 올리면 됩니다.
Cloudflare 안에서 굳이 한다면 Workers 대신 **Cloudflare Containers**(유료)를 써야 합니다.

### 비용

무료 플랜으로 충분합니다 — Workers 10만 요청/일, KV 10만 읽기·1천 쓰기/일(크론 24회 사용),
GitHub Actions는 **퍼블릭 저장소면 분 소모가 아예 없고**, 프라이빗이면 무료 플랜 2,000분/월을 씁니다
(이 워크플로 1회 ≈ 1~2분이므로 30분 크론이면 월 1,400~2,800분 → 프라이빗에서는 한도를 넘길 수 있습니다.
프라이빗을 유지하려면 크론을 2~3시간 간격으로 늘리거나, 배포 대신 KV 갱신만 하도록 바꾸세요).
참고로 스케줄 워크플로는 저장소에 60일간 활동이 없으면 자동으로 비활성화됩니다.

## 얼마나 실시간인가

"펠로시가 산 걸 실시간으로 본다"는 말은 두 개의 다른 지연이 섞여 있습니다. 나눠서 보면 이렇습니다.

| 구간 | 현재 | 줄일 수 있나 |
| --- | --- | --- |
| ① 거래 → 공시 제출 | 펠로시 실측 **평균 21일, 최대 30일** (법정 한도 45일) | **불가능.** STOCK Act가 정한 신고 기한이라 어떤 사이트도 못 줄입니다 |
| ② 공시 게시 → 데이터 반영 | **≤ 30분** (크론 주기) | 크론 주기를 줄이면 더 짧아짐 |
| ③ 데이터 → 화면 | 엣지 캐시 5분 (`?refresh=1`로 우회) | 즉시 |
| ④ 주가 | **요청 시점 실시간** | — |

②가 이 프로젝트에서 실제로 개선한 부분입니다. 대부분의 트래커는 사무처의 연도별 `FD.ZIP` 인덱스만 보는데,
이 파일은 **평일에 하루 한 번꼴로만 다시 만들어집니다**(예: 일요일에 확인하면 금요일 13:00 UTC 판이 최신).
그래서 파이프라인은 ZIP 인덱스와 함께 **사무처 검색 폼의 라이브 DB**(`POST /FinancialDisclosure/ViewMemberSearchResult`)를
조회해, ZIP에 아직 없는 신규 PTR을 게시 직후에 잡아냅니다. 이렇게 찾은 공시는 화면에 `실시간 검색으로 감지` 배지가 붙습니다.

또한 PTR PDF의 HTTP `Last-Modified` 헤더가 **공시가 실제로 공개된 분 단위 시각**입니다.
(예: 문서 20035143 → `Fri, 21 Aug 2026 14:26:48 GMT` = 미 동부 오전 10:26)
이 값을 받아와 "공시 게시 N시간 전"으로 표시하고, 게시 24시간 이내면 시그널 근거에
*"방금 공개된 정보로, 따라 살 여지가 가장 큰 구간"* 이라고 명시합니다.

정리하면 — **거래 자체를 실시간으로 보는 방법은 없습니다.** 공시 전에 그걸 아는 건 내부자 정보입니다.
다만 *공시가 공개된 순간을 남보다 먼저 아는 것*은 가능하고, 알파가 있다면 공시 직후 몇 시간에 몰려 있으므로
그 구간을 놓치지 않는 것이 이 프로젝트가 할 수 있는 최선입니다.

### 더 빠르게 만들려면

- `deploy.yml`의 크론을 `*/10 * * * *`로 (퍼블릭 저장소는 Actions 분이 무제한). 단 매번 재배포하지 않도록
  `KV_NAMESPACE_ID`를 설정해 KV만 갱신하는 편이 좋습니다.
- 새 공시를 감지했을 때 알림(Slack/Telegram/이메일)을 워크플로 마지막 단계에 추가.
  `sources.liveSearch.newFilings > 0` 이면 새 문서가 잡힌 것입니다.

## 한계와 주의

- **최대 45일의 신고 지연**이 구조적 한계입니다(펠로시 실측 평균 21일). 공시를 본 시점엔 이미 주가가
  움직였을 수 있어, 각 시그널에 "거래일 대비 현재가"를 반드시 함께 표시합니다. 자세한 지연 구조는
  위의 [얼마나 실시간인가](#얼마나-실시간인가) 참고.
- 거래 금액은 구간(예: `$1,000,001 ~ $5,000,000`)으로만 공개되어 정확한 규모를 알 수 없습니다.
- 대부분의 거래는 배우자(폴 펠로시) 명의이며, 의원 본인의 판단이라는 보장이 없습니다.
- PTR PDF의 표 레이아웃이 바뀌면 파서 보정이 필요합니다(`server/ptr.js`).
- 이 프로젝트는 공개 정보를 정리·해석한 **정보 제공용**이며 투자 자문이 아닙니다. 투자 판단과 책임은 본인에게 있습니다.

## 구조

```
server/         Node 런타임 (로컬 개발 / 자체 호스팅 / 스냅샷 빌드)
  index.js     HTTP 서버 + 정적 파일 + /api
  tracker.js   인덱스 → PDF → 파싱 → 시세 → 시그널 파이프라인
  clerk.js     하원 사무처 공시 인덱스/PDF
  ptr.js       PTR PDF → 거래 레코드 파서
  prices.js    시세 캐시 계층
  lib/         http 재시도, 디스크 캐시, 최소 ZIP 리더
shared/         Node·Workers 공용 (런타임 의존성 없음)
  signals.js   시그널 점수·행동안·근거 문장 생성
  quotes.js    시세(Yahoo → Stooq 폴백), fetch만 사용
  report.js    데이터셋 + 시세 → 최종 리포트
  util.js      날짜/포맷 유틸
worker/         Cloudflare Worker 엔트리
scripts/
  build-data.js  공시 스냅샷 빌드(GitHub Actions에서 실행)
  smoke-test.js  원본 호출까지 포함한 최소 검증
public/        정적 프런트엔드(바닐라 JS) + data/snapshot.json
```

## 로컬에서 Worker 버전 확인

```bash
npm run build:data     # 스냅샷 굽기
npm run cf:dev         # workerd 로컬 실행 (http://localhost:8787)
```
