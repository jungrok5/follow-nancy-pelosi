// 재시도 + 타임아웃이 붙은 얇은 fetch 래퍼.
// 하원 사무처 / 야후 파이낸스 모두 브라우저 UA가 없으면 종종 차단하므로 기본 헤더를 붙인다.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 헤더까지 필요할 때 쓰는 저수준 버전. 재시도 정책은 fetchRaw와 동일하다. */
export async function fetchResponse(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ac.signal,
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
      });
      if (!res.ok && (res.status >= 500 || res.status === 429)) {
        lastErr = new Error(`HTTP ${res.status} ${res.statusText} - ${url}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`요청 실패: ${url}`);
}

export async function fetchRaw(url, { headers = {}, timeoutMs = 30000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
      });
      if (!res.ok) {
        // 4xx 중 재시도가 의미 있는 건 요청 과다(429)뿐.
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`HTTP ${res.status} ${res.statusText} - ${url}`);
        }
        lastErr = new Error(`HTTP ${res.status} ${res.statusText} - ${url}`);
        continue;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && /HTTP 4\d\d/.test(err.message) && !/429/.test(err.message)) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`요청 실패: ${url}`);
}

export async function fetchText(url, opts) {
  return (await fetchRaw(url, opts)).toString('utf8');
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}
