import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, HOST, PUBLIC_DIR, DEFAULT_MEMBER } from './config.js';
import { getReport, getTraders } from './tracker.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: '접근 불가' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: '찾을 수 없습니다' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/report') {
      const member = url.searchParams.get('member') || DEFAULT_MEMBER;
      const force = ['1', 'true'].includes(url.searchParams.get('refresh') ?? '');
      const lookbackDays = Number(url.searchParams.get('days')) || undefined;
      return sendJson(res, 200, await getReport({ member, force, lookbackDays }));
    }
    if (url.pathname === '/api/traders') {
      return sendJson(res, 200, { traders: await getTraders() });
    }
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, member: DEFAULT_MEMBER, time: new Date().toISOString() });
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: '없는 엔드포인트' });
    return serveStatic(res, url.pathname);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[error]', err);
    sendJson(res, status, { error: String(err.message ?? err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`▶ 펠로시 트래커 실행 중: http://localhost:${PORT}  (추적 대상: ${DEFAULT_MEMBER})`);
});
