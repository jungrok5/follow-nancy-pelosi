// 디스크 캐시. 사무처 ZIP/PDF는 용량이 크고 자주 바뀌지 않으므로
// 매 요청마다 원본을 때리지 않도록 TTL 기반으로 보관한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR } from '../config.js';

fs.mkdirSync(CACHE_DIR, { recursive: true });

const keyPath = (key) =>
  path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex').slice(0, 20));

export function readCache(key, ttlMs) {
  const file = keyPath(key);
  try {
    const stat = fs.statSync(file);
    if (ttlMs !== Infinity && Date.now() - stat.mtimeMs > ttlMs) return null;
    return { buffer: fs.readFileSync(file), cachedAt: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function writeCache(key, buffer) {
  fs.writeFileSync(keyPath(key), buffer);
}

/** TTL 안이면 캐시를, 아니면 loader()를 돌려 캐시에 적재한다. */
export async function cached(key, ttlMs, loader, { force = false } = {}) {
  if (!force) {
    const hit = readCache(key, ttlMs);
    if (hit) return { buffer: hit.buffer, cachedAt: hit.cachedAt, fromCache: true };
  }
  try {
    const buffer = await loader();
    writeCache(key, buffer);
    return { buffer, cachedAt: Date.now(), fromCache: false };
  } catch (err) {
    // 원본이 잠시 죽어도 과거 캐시가 있으면 그걸로 버틴다.
    const stale = readCache(key, Infinity);
    if (stale) return { buffer: stale.buffer, cachedAt: stale.cachedAt, fromCache: true, stale: true };
    throw err;
  }
}

export async function cachedJson(key, ttlMs, loader, opts) {
  const res = await cached(key, ttlMs, async () => Buffer.from(JSON.stringify(await loader())), opts);
  return { value: JSON.parse(res.buffer.toString('utf8')), cachedAt: res.cachedAt, fromCache: res.fromCache, stale: res.stale };
}

// 짧은 TTL 값에는 굳이 디스크를 쓸 필요가 없어 메모리 캐시도 함께 제공한다.
const mem = new Map();
export async function memoized(key, ttlMs, loader) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loader();
  mem.set(key, { at: Date.now(), value });
  return value;
}
