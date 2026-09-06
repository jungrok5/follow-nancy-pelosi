# 배포 가이드 — 퍼블릭 전환 + Cloudflare 연결

이 문서 하나만 따라 하면 됩니다. 순서대로 **① 안전 점검 → ② 값 3개 발급 → ③ GitHub에 등록 → ④ 배포 확인**.

---

## ① 퍼블릭으로 바꾸기 전 안전 점검

퍼블릭 저장소는 GitHub Actions 분이 소모되지 않지만, **한 번 공개된 커밋은 지워도 캐시·포크로 남습니다.**
전환 전에 아래를 확인하세요.

### 1. 비밀값이 커밋에 섞여 있지 않은지 확인

단어가 아니라 **값처럼 생긴 문자열**을 찾습니다. (`${{ secrets.NAME }}` 같은 *참조*는 비밀값이 아니라 정상입니다)

```bash
# 과거 커밋 전체에서 "키 = 긴 문자열" 형태 검색
git grep -InE '(api[_-]?key|secret|token|password)["'"'"']?[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9/_+=.-]{24,}' \
  $(git rev-list --all) -- . | grep -v 'secrets\.'

# 개인키 파일이 섞여 들어갔는지
git grep -InE 'BEGIN [A-Z ]*PRIVATE KEY' $(git rev-list --all) -- .
```

둘 다 출력이 없으면 깨끗합니다. **이 저장소는 현재 둘 다 비어 있습니다.**

무언가 나온다면 퍼블릭 전환을 멈추고, ① 해당 키를 발급처에서 먼저 폐기(rotate)한 뒤
② `git filter-repo`로 히스토리에서 제거하세요. 지운 뒤에도 그 키는 죽은 것으로 취급해야 합니다.

전환 후에는 GitHub의 자동 감시도 켜두세요 — 퍼블릭 저장소는 무료입니다.
**Settings → Code security → Secret scanning**과 **Push protection**을 모두 Enable 하면,
실수로 토큰을 커밋해도 푸시 단계에서 막아줍니다.

### 2. 무시 목록 확인

`.gitignore`에 아래가 들어 있어야 합니다 (이미 설정되어 있습니다).

```
node_modules/
.cache/          # 다운로드 캐시
.wrangler/       # wrangler 로컬 상태
.env
```

추가로 Cloudflare 로컬 개발용 변수 파일을 쓸 계획이면 `.dev.vars`도 넣으세요.

### 3. 공개해도 되는 값 / 안 되는 값

| 값 | 공개 가능? | 어디에 둘까 |
| --- | --- | --- |
| `wrangler.toml`의 워커 이름, `compatibility_date` | ✅ 공개 무관 | 저장소 |
| KV 네임스페이스 ID | ✅ 식별자일 뿐, 이것만으론 접근 불가 | 저장소 또는 시크릿(취향) |
| Cloudflare **Account ID** | ⚠️ 비밀은 아니지만 굳이 공개할 이유 없음 | **GitHub Secret** |
| Cloudflare **API Token** | ❌ 절대 공개 금지 | **GitHub Secret** |
| `wrangler login` 자격증명 (`~/.config/.wrangler/`) | ❌ | 로컬에만, 저장소에 복사 금지 |

이 저장소는 API 키 없이 동작합니다(하원 사무처·야후 모두 공개 엔드포인트). 그래서 **코드에 넣을 비밀값이 아예 없습니다.**
Cloudflare 자격증명은 오직 GitHub Secrets에만 들어갑니다.

### 4. 퍼블릭 전환

저장소 → **Settings → General → 맨 아래 Danger Zone → Change repository visibility → Make public**

### 5. 전환 직후 Actions 설정 점검

**Settings → Actions → General** 한 화면에서 아래 네 가지를 확인합니다.
대부분 GitHub 기본값이 이미 안전한 쪽이라, 실제로 바꿀 것은 많아야 하나입니다.

| 항목 | 기본값 | 이 프로젝트에 필요한 값 |
| --- | --- | --- |
| **Workflow permissions** | `Read repository contents and packages permissions` | **그대로.** 이 워크플로들은 저장소에 쓰기를 하지 않습니다 |
| Allow GitHub Actions to create and approve pull requests | 해제 | **그대로 해제** |
| **Actions permissions** | `Allow all actions and reusable workflows` | 그대로 두면 동작합니다 (아래 선택 사항 참고) |
| **Fork pull request workflows** | `Require approval for first-time contributors` | 퍼블릭이면 `Require approval for all external contributors`로 올리는 것을 권장 |

마지막 항목만 부연하면 — 기본값은 *한 번이라도 머지된 적 있는 기여자*의 PR은 승인 없이 워크플로가 도는 설정입니다.
`all external contributors`로 올리면 내 저장소 멤버가 아닌 모든 사람의 PR이 매번 수동 승인을 거칩니다.
개인 프로젝트라면 올려두는 편이 낫고, 외부 기여를 자주 받을 생각이면 기본값이 편합니다.

> 어느 쪽이든 **포크 PR에는 GitHub이 시크릿을 절대 넘기지 않습니다.** 게다가 배포 워크플로(`deploy.yml`)는
> `push`/`schedule`/`workflow_dispatch`만 쓰고 `pull_request`를 쓰지 않으므로, 남이 PR로 배포를 유발할 수 없습니다.
> CI 워크플로(`ci.yml`)는 `pull_request`를 쓰지만 시크릿을 전혀 사용하지 않습니다.

### 6. (선택) 공급망 리스크까지 줄이려면

`Actions permissions`를 `Allow <계정>, and select non-<계정>, actions and reusable workflows`로 바꾸고
허용 목록에 이 저장소가 쓰는 것만 넣습니다.

```
actions/*, cloudflare/wrangler-action@*
```

한 단계 더 가려면 같은 화면의 **Require actions to be pinned to a full-length commit SHA**를 켤 수 있는데,
이걸 켜면 워크플로의 `@v4` 같은 **태그 참조가 전부 막힙니다.** 태그는 나중에 다른 커밋으로 옮겨질 수 있어
SHA 고정이 더 안전하지만, 켜기 전에 `.github/workflows/*.yml`의 액션을 모두 커밋 SHA로 바꿔야 합니다.
(예: `actions/checkout@8f4b7f8...  # v4.2.2`) 지금은 켜져 있지 않으므로 워크플로는 그대로 동작합니다.

---

## ② Cloudflare에서 값 3개 발급

### 값 1 — `CLOUDFLARE_ACCOUNT_ID`

1. https://dash.cloudflare.com 로그인
2. 좌측 메뉴 **Compute (Workers) / Workers & Pages** 클릭
3. 우측 사이드바의 **Account ID** 옆 복사 버튼 클릭
   - 안 보이면 주소창을 보세요: `dash.cloudflare.com/`**`여기가 Account ID`**`/workers`
4. 32자리 16진수 문자열입니다. 예: `a1b2c3d4e5f6...`

### 값 2 — `CLOUDFLARE_API_TOKEN` (가장 중요)

1. https://dash.cloudflare.com/profile/api-tokens 로 직접 이동
   (또는 우상단 프로필 아이콘 → **My Profile → API Tokens**)
2. **Create Token** 클릭
3. 템플릿 목록에서 **Edit Cloudflare Workers** 의 **Use template** 클릭
4. 권한이 아래로 채워져 있는지 확인하고, **없는 건 추가·있는 건 그대로** 두세요.

   | 종류 | 항목 | 권한 |
   | --- | --- | --- |
   | Account | Workers Scripts | **Edit** |
   | Account | Workers KV Storage | **Edit** *(KV를 쓸 때만 필요)* |
   | Account | Account Settings | **Read** |
   | Zone | Workers Routes | Edit *(커스텀 도메인을 붙일 때만. `workers.dev`만 쓸 거면 삭제해도 됩니다)* |

5. **Account Resources** → `Include → 본인 계정 하나만` 선택 (All accounts 금지)
6. **Client IP Address Filtering** → 비워두세요 (GitHub Actions는 IP가 고정되지 않습니다)
7. **TTL** → 만료일을 1년 정도로 설정해두면 방치 위험이 줄어듭니다
8. **Continue to summary → Create Token**
9. ⚠️ **토큰 값은 이 화면에서 한 번만 보입니다.** 바로 복사하세요. 잃어버리면 새로 만들면 됩니다.

> 유출이 의심되면 같은 화면에서 해당 토큰의 **Roll**(값 교체) 또는 **Delete**를 누르세요. 즉시 무효화됩니다.

### 값 3 (선택) — `KV_NAMESPACE_ID`

공시 갱신 때마다 재배포하는 대신 **데이터만 갈아끼우고 싶을 때** 쓰는 저장소입니다.

```bash
npx wrangler login                       # 브라우저로 로그인
npx wrangler kv namespace create TRACKER_KV
```

출력에 나오는 `id = "..."` 값을 복사한 뒤:

1. GitHub Secret `KV_NAMESPACE_ID`로 등록
2. `wrangler.toml`의 아래 세 줄 주석을 풀고 id를 붙여넣기

```toml
[[kv_namespaces]]
binding = "TRACKER_KV"
id = "붙여넣은_네임스페이스_ID"
```

---

## ③ GitHub에 등록

저장소 → **Settings → Secrets and variables → Actions → New repository secret**

| Name (정확히 이 철자로) | Secret |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | 값 1 |
| `CLOUDFLARE_API_TOKEN` | 값 2 |
| `KV_NAMESPACE_ID` | 값 3 (선택 — 안 넣으면 이 단계는 자동으로 건너뜁니다) |

이름이 하나라도 다르면 워크플로가 조용히 인증에 실패합니다. 복사·붙여넣기를 권합니다.

---

## ④ 배포하고 확인

### 처음 한 번은 로컬에서

```bash
npm install
npx wrangler login
npm run cf:deploy      # 공시 스냅샷 빌드 + 배포
```

끝나면 `https://pelosi-tracker.<계정서브도메인>.workers.dev` 주소가 출력됩니다.
`workers.dev subdomain not configured` 오류가 나면 대시보드 **Workers & Pages → 우측 subdomain 설정**에서 서브도메인을 한 번 만들어 주세요.

### 그다음부터는 자동

1. 이 브랜치를 **`main`에 머지**합니다. (스케줄 트리거는 기본 브랜치의 워크플로만 실행됩니다)
2. **Actions 탭 → Deploy to Cloudflare Workers → Run workflow** 로 한 번 수동 실행해 초록불을 확인합니다.
3. 이후로는 **푸시할 때마다 + 30분마다** 자동으로 공시를 다시 파싱하고 배포합니다.

### 잘 되는지 보는 법

```bash
curl https://<배포주소>/api/health
```

```jsonc
{ "ok": true, "dataOrigin": "snapshot", "dataBuiltAt": "2026-09-06T12:03:59Z", "transactions": 30 }
```

- `dataOrigin`: `kv`면 KV에서, `snapshot`이면 배포에 포함된 파일에서 읽은 것
- `dataBuiltAt`: 공시를 마지막으로 파싱한 시각 (30분 이내여야 정상)

---

## 자주 나는 오류

| 증상 | 원인과 해결 |
| --- | --- |
| `Authentication error [code: 10000]` | 토큰 권한 부족. **Workers Scripts: Edit**과 **Account Settings: Read**가 있는지 확인 |
| `You do not have permission to modify this KV namespace` | 토큰에 **Workers KV Storage: Edit** 누락 |
| 크론이 안 돎 | ① 워크플로가 기본 브랜치에 있는지 ② 저장소에 60일간 활동이 없으면 스케줄이 자동 비활성화됩니다(아무 커밋이나 하면 재개) |
| 배포는 됐는데 데이터가 안 바뀜 | KV를 쓰는 경우 `wrangler.toml`의 `[[kv_namespaces]]` 주석을 풀었는지 확인. 엣지 캐시는 5분이니 `?refresh=1`로 우회 |
| `/api/report`가 404 | 스냅샷이 없는 상태. `npm run build:data` 후 다시 배포 |

## 비용 정리

| 항목 | 무료 한도 | 이 프로젝트 사용량 |
| --- | --- | --- |
| Workers 요청 | 10만/일 | 방문자 수만큼 |
| Workers KV 쓰기 | 1,000/일 | 48회 (30분 크론) |
| GitHub Actions | 퍼블릭 **무제한** / 프라이빗 2,000분·월 | 회당 1~2분 × 48회/일 |

프라이빗을 유지하려면 크론을 `0 */3 * * *`(3시간) 정도로 늦추세요. 퍼블릭이면 그대로 두면 됩니다.
