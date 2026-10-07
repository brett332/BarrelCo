// Local test server: the real worker.js backed by the in-memory fake Sheets.
// Test-only helper endpoints: /__state, /__reset, /__fail?match=REGEX&status=500, /__setinv?pid=..&n=..
import http from 'node:http';
import worker from '../worker.js';
import { FakeSheets, makeEnv } from './fake-sheets.mjs';
const env = { ...makeEnv(), SHOP_ALLOW_LOCALHOST: '1' }; let sheets;
function reset() { if (sheets) sheets.uninstall(); sheets = new FakeSheets(); sheets.install(); }
reset();
const server = http.createServer(async (req, res) => { try {
  const url = new URL(req.url, 'http://localhost:8787');
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/__reset') { reset(); return send(200, { ok: true }); }
  if (url.pathname === '/__state') return send(200, Object.fromEntries(sheets.tabs));
  if (url.pathname === '/__fail') { sheets.failNext(new RegExp(url.searchParams.get('match')), +url.searchParams.get('status') || 500, +url.searchParams.get('times') || 1); return send(200, { ok: true }); }
  if (url.pathname === '/__setinv') { const r = sheets.tabs.get('Inventory').find(x => x[0] === url.searchParams.get('pid') && x[1] === 'cabin_wv'); r[2] = url.searchParams.get('n'); return send(200, { ok: true }); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(url.href, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'transfer-encoding', 'expect'].includes(k))), body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
} catch (e) { console.error('serve error', e); res.writeHead(500); res.end(String(e)); } });
server.listen(8787, () => console.log('test worker on :8787'));
