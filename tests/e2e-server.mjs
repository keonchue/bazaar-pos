/* 화면까지 통째로 해 보는 시험 서버 — `node tests/e2e-server.mjs` 후 http://localhost:5199
   - index.html 의 Firebase 주소를 tests/fake-firebase 로 바꿔서 준다 (메모리 Firestore · 자동 로그인)
   - firebase-config.js 는 가짜 값으로 준다
   - POST /sheet      apps-script/Code.gs 를 시트 흉내(mock-sheets.mjs) 위에서 그대로 돌린다
   - GET  /sheet-dump 지금 시트 내용
   - POST /sheet-tamper 사람이 시트를 손댄 것처럼 판매기록 2행 금액을 +500 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScript } from './mock-sheets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = loadScript();
S.props.set('MIRROR_TOKEN', 'e2e-token');
S.ctx.시트_만들기();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const cors = { 'Access-Control-Allow-Origin': '*' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/sheet' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let out;
      try { out = S.ctx.doPost({ postData: { contents: body } }).body; }
      catch (e) { out = JSON.stringify({ ok: false, error: String(e) }); }
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(out);
    });
    return;
  }
  if (url.pathname === '/sheet-dump') {
    const dump = {};
    S.ss.getSheets().forEach(s => { dump[s.getName()] = s.records(); });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
    res.end(JSON.stringify(dump, null, 1));
    return;
  }
  if (url.pathname === '/sheet-tamper' && req.method === 'POST') {
    const sh = S.ss.getSheetByName('판매기록');
    const c = sh.rows[0].indexOf('금액');
    sh.rows[1][c] = Number(sh.rows[1][c]) + 500;
    res.writeHead(200, cors); res.end('ok');
    return;
  }
  const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  if (p === '/firebase-config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end('export const firebaseConfig = { apiKey: "fake-e2e" }; export const STORE_EMAIL = "bazaar@test";');
    return;
  }
  if (p === '/sw.js') { res.writeHead(404); res.end(); return; }
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  let data = fs.readFileSync(file);
  if (p === '/index.html') data = Buffer.from(String(data).replaceAll('https://www.gstatic.com/firebasejs/10.12.2/', '/tests/fake-firebase/'));
  res.writeHead(200, { 'Content-Type': (types[path.extname(p)] || 'text/plain') + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}).listen(5199, () => console.log('http://localhost:5199'));
