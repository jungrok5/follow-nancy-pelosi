// Cloudflare Worker 엔트리.
//
// 역할 분담:
//   · PDF 파싱(무거움, workerd에서 pdfjs 동작 불가) → GitHub Actions가 미리 스냅샷으로 구움
//   · 시세 조회 + 시그널 계산(가벼움, I/O 위주)   → 이 워커가 요청 시점에 실행 = 가격은 항상 실시간
//
// 데이터 출처 우선순위: KV(있으면) → 배포에 포함된 /data/snapshot.json
import { composeReport } from '../shared/report.js';
import { fetchQuotes } from '../shared/quotes.js';

const DEFAULT_MEMBER = 'Pelosi, Nancy';
const EDGE_TTL = 300; // 리포트 엣지 캐시 5분

const slug = (member) => member.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const json = (body, { status = 200, maxAge = 0 } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=0, s-maxage=${maxAge}` : 'no-store',
    },
  });

async function loadDataset(env, request, member) {
  if (env.TRACKER_KV) {
    const fromKv = await env.TRACKER_KV.get(`dataset:${slug(member)}`, 'json');
    if (fromKv) return { dataset: fromKv, origin: 'kv' };
  }
  const url = new URL('/data/snapshot.json', new URL(request.url).origin);
  const res = await env.ASSETS.fetch(new Request(url, { headers: { accept: 'application/json' } }));
  if (!res.ok) return { dataset: null, origin: 'none' };
  const dataset = await res.json();
  const wanted = slug(member);
  if (wanted !== slug(dataset.member?.query ?? '') && wanted !== slug(dataset.member?.name ?? '')) {
    return { dataset: null, origin: 'mismatch', snapshotMember: dataset.member?.name };
  }
  return { dataset, origin: 'snapshot' };
}

async function handleReport(request, env, ctx) {
  const url = new URL(request.url);
  const member = url.searchParams.get('member') || DEFAULT_MEMBER;
  const lookbackDays = Number(url.searchParams.get('days')) || undefined;
  const bypass = ['1', 'true'].includes(url.searchParams.get('refresh') ?? '');

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/report?member=${encodeURIComponent(member)}&days=${lookbackDays ?? ''}`, request);
  if (!bypass) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const { dataset, origin, snapshotMember } = await loadDataset(env, request, member);
  if (!dataset) {
    return json(
      {
        error:
          origin === 'mismatch'
            ? `이 배포에는 '${snapshotMember}' 데이터만 포함되어 있습니다. 다른 의원을 조회하려면 GitHub Actions의 MEMBERS 설정에 추가한 뒤 KV에 적재하세요.`
            : '공시 스냅샷을 찾지 못했습니다. `npm run build:data` 후 다시 배포하세요.',
      },
      { status: 404 },
    );
  }

  const report = await composeReport(dataset, {
    quotesFor: fetchQuotes,
    lookbackDays: lookbackDays ?? dataset.lookbackDays ?? 400,
  });
  report.deployment = { mode: 'live', dataOrigin: origin, runtime: 'cloudflare-workers' };

  const res = json(report, { maxAge: EDGE_TTL });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (url.pathname === '/api/report') return await handleReport(request, env, ctx);

      if (url.pathname === '/api/traders') {
        const { dataset } = await loadDataset(env, request, url.searchParams.get('member') || DEFAULT_MEMBER);
        return json({ traders: dataset?.traders ?? [] }, { maxAge: 3600 });
      }

      if (url.pathname === '/api/health') {
        const { dataset, origin } = await loadDataset(env, request, DEFAULT_MEMBER);
        return json({
          ok: true,
          runtime: 'cloudflare-workers',
          dataOrigin: origin,
          dataBuiltAt: dataset?.builtAt ?? null,
          transactions: dataset?.transactions?.length ?? 0,
          time: new Date().toISOString(),
        });
      }

      return json({ error: '없는 엔드포인트' }, { status: 404 });
    } catch (err) {
      return json({ error: String(err?.message ?? err) }, { status: 500 });
    }
  },
};
