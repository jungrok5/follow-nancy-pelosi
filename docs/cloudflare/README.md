# (선택) Cloudflare Workers로 배포하기

이 폴더는 **쓰지 않아도 되는 대안**입니다. 기본 배포는 GitHub Pages이고, 설정은 [../DEPLOY.md](../DEPLOY.md)에 있습니다.

Cloudflare Workers로 옮기면 **주가가 요청 시점 실시간**이 됩니다.
(Pages는 정적이라 시세가 30분 주기 빌드 시점 기준입니다.)

## 옮기는 방법

1. `deploy.yml`을 `.github/workflows/`로 복사합니다.
2. 충돌을 피하려면 `.github/workflows/pages.yml`은 지우거나 `schedule`/`push` 트리거를 제거하세요.
3. GitHub Secrets에 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`를 등록합니다.
   (토큰 발급 위치와 최소 권한은 [../DEPLOY.md](../DEPLOY.md)의 부록 참고)
4. main에 푸시하면 배포됩니다. 대시보드에서 워커를 미리 만들 필요는 없습니다 — `wrangler deploy`가 만듭니다.

저장소 루트의 `wrangler.toml`, `worker/`가 이 경로에서 쓰이는 파일들입니다.
Pages만 쓸 거라면 그대로 두어도 아무 동작도 하지 않습니다.
