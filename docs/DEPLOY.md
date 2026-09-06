# 배포 가이드 — GitHub Pages (로컬 작업 없음)

**이 저장소는 GitHub 웹 화면만으로 배포됩니다.** 터미널·로컬 설치·API 키가 전혀 필요 없습니다.

- 시크릿 등록: **0개**
- 로컬 명령: **0개**
- 비용: **0원** (퍼블릭 저장소면 Actions 분도 무제한)

| 단계 | 어디서 | 걸리는 시간 |
| --- | --- | --- |
| ① 저장소 퍼블릭 전환 | GitHub Settings | 1분 |
| ② Pages 켜기 | GitHub Settings → Pages | 30초 |
| ③ 브랜치 머지 | GitHub PR 화면 | 1분 |
| ④ 첫 배포 실행 | GitHub Actions 탭 | 2분 |

---

## ① 저장소를 퍼블릭으로

퍼블릭이면 Actions 분이 소모되지 않고, GitHub Pages도 무료로 켜집니다.

### 먼저 비밀값 점검

이 프로젝트는 **API 키를 하나도 쓰지 않습니다**(하원 사무처·야후 모두 공개 엔드포인트).
그래도 습관적으로 한 번 확인하세요. 단어가 아니라 *값처럼 생긴 문자열*을 찾습니다.

```bash
git grep -InE '(api[_-]?key|secret|token|password)["'"'"']?[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9/_+=.-]{24,}' \
  $(git rev-list --all) -- . | grep -v 'secrets\.'
git grep -InE 'BEGIN [A-Z ]*PRIVATE KEY' $(git rev-list --all) -- .
```

둘 다 출력이 없으면 깨끗합니다. **현재 이 저장소는 둘 다 비어 있습니다.**
(터미널을 열기 싫으면 건너뛰어도 됩니다. 이 저장소에 넣은 비밀값이 없다는 건 위에서 확인했습니다.)

### 전환

**Settings → General → 맨 아래 Danger Zone → Change repository visibility → Make public**

전환 후 **Settings → Code security**에서 **Secret scanning**과 **Push protection**을 켜두면,
나중에 실수로 토큰을 커밋해도 푸시 단계에서 막아줍니다. 퍼블릭 저장소는 무료입니다.

---

## ② GitHub Pages 켜기

**Settings → Pages → Build and deployment → Source** 를 **`GitHub Actions`** 로 선택합니다.

> "Deploy from a branch"가 아니라 **GitHub Actions**여야 합니다. 이 저장소는 매번 공시를 새로 파싱해
> 정적 파일을 만들어 올리기 때문입니다.

선택만 하면 됩니다. 브랜치나 폴더는 고르지 않습니다.

---

## ③ 작업 브랜치를 `main`에 머지

스케줄(크론)은 **기본 브랜치에 있는 워크플로만** 실행합니다. 웹에서 머지하면 됩니다.

1. 저장소 상단 **Pull requests → New pull request**
2. base: `main` ← compare: `claude/pelosi-stock-tracker-cvsl96`
3. **Create pull request → Merge pull request**

---

## ④ 첫 배포 실행

**Actions 탭 → 왼쪽에서 `Deploy to GitHub Pages` → 우측 `Run workflow` → 초록 버튼**

2분쯤 뒤 초록 체크가 뜨면 끝입니다. 주소는 두 곳에서 확인할 수 있습니다.

- **Settings → Pages** 상단에 표시되는 주소
- 실행된 워크플로의 `deploy` 단계 출력

보통 이 형태입니다:

```
https://jungrok5.github.io/follow-nancy-pelosi/
```

---

## ⑤ 이후 자동 갱신

`pages.yml`이 아래 세 경우에 자동으로 돕니다.

- **30분마다** — 공시를 다시 파싱하고 시세를 새로 받아 재배포
- **main에 푸시할 때**
- **Run workflow 수동 실행**

> ⚠️ 저장소에 **60일간 아무 활동이 없으면 GitHub이 스케줄을 자동 중지**합니다.
> 그때는 아무 커밋이나 하나 넣거나 Run workflow를 한 번 누르면 다시 시작됩니다.

### 잘 도는지 확인하는 법

사이트 상단의 **신선도 스트립** 두 번째 칸(`② 공시 → 이 사이트 인지`)에
`N분 전 수집`이 표시됩니다. 30분 안쪽이면 정상입니다.

---

## 이 구성의 한 가지 한계

GitHub Pages는 정적 호스팅이라 **서버가 없습니다.** 그래서:

| | GitHub Pages (지금) | Cloudflare Workers (선택) |
| --- | --- | --- |
| 공시 데이터 | 30분마다 갱신 | 30분마다 갱신 |
| **주가** | **빌드 시점 기준 (최대 30분 지연)** | 요청 시점 실시간 |
| 다른 의원 조회 | ❌ 기본 대상(펠로시)만 | ✅ 이름 입력으로 조회 |
| 필요한 시크릿 | 없음 | 2개 |
| 로컬 작업 | 없음 | 없음 |

브라우저에서 야후 파이낸스를 직접 부르면 CORS로 차단되기 때문에, 정적 배포에서는
시세를 **빌드할 때 미리 받아 구워둡니다.** 장중에 30분 지난 가격이 보일 수 있다는 뜻입니다.
"거래일 대비 현재가 +37%" 같은 판단에는 지장이 없지만, 초 단위 시세가 필요하면 아래 부록을 보세요.

---

## 자주 나는 문제

| 증상 | 해결 |
| --- | --- |
| Actions 탭에 `Run workflow` 버튼이 없음 | 워크플로가 아직 `main`에 없습니다. ③번 머지를 먼저 하세요 |
| 배포는 성공했는데 404 | **Settings → Pages → Source**가 `GitHub Actions`인지 확인 |
| `Resource not accessible by integration` | Settings → Actions → General → Workflow permissions가 read여도 괜찮습니다. 이 오류는 Pages Source가 아직 Actions로 안 잡힌 경우가 대부분입니다 |
| 30분 크론이 안 돎 | ① 워크플로가 `main`에 있는지 ② 60일 비활성으로 중지됐는지 확인 |
| 화면은 뜨는데 데이터가 옛날 것 | 브라우저 캐시입니다. 새로고침 버튼을 누르거나 강력 새로고침(Ctrl/Cmd+Shift+R) |
| 액션이 차단됨 (`is not allowed to be used`) | Settings → Actions 허용 목록에 `actions/*`가 있으면 됩니다. Pages 워크플로는 전부 `actions/` 소속입니다 |

---

## 부록: 실시간 시세가 필요하면 (Cloudflare Workers)

주가를 요청 시점에 가져오고 다른 의원도 조회하려면 Cloudflare Workers로 배포하면 됩니다.
**이 경우에도 로컬 작업은 없고**, 대시보드에서 워커를 미리 만들 필요도 없습니다(`wrangler deploy`가 만듭니다).
시크릿 2개만 등록하면 GitHub Actions가 알아서 배포합니다.

옮기는 절차는 [`cloudflare/README.md`](cloudflare/README.md)에 있고, 값 발급 위치는 이렇습니다.

| 시크릿 | 어디서 얻나 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → **Workers & Pages** → 우측 사이드바 **Account ID** (주소창 `dash.cloudflare.com/여기/workers`) |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com/profile/api-tokens → **Create Token** → **Edit Cloudflare Workers** 템플릿 → Account Resources는 본인 계정만 → 생성 후 **한 번만 표시되니 즉시 복사** |

넣는 곳은 저장소 **Settings → Secrets and variables → Actions → New repository secret** 입니다.

토큰 최소 권한: `Workers Scripts: Edit` + `Account Settings: Read` (KV를 쓸 때만 `Workers KV Storage: Edit`).
`workers.dev` 주소만 쓸 거면 Zone 권한은 필요 없습니다. 유출이 의심되면 같은 화면에서 **Roll** 또는 **Delete**.

> Cloudflare 대시보드의 **Workers Builds(Git 연동)** 화면은 쓰지 않습니다.
> 스케줄 빌드가 없어서 30분 자동 갱신이 안 되고, GitHub Actions와 배포가 중복됩니다.
