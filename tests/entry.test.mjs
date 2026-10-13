import assert from 'node:assert/strict';
import worker from '../worker.js';
import { FakeSheets, makeEnv } from './fake-sheets.mjs';

const env = makeEnv();
let sheets; let mom; let results = [];

const HEAD = ['Action', 'Location', 'Product', 'Qty', 'To Location', 'Price', 'Note', 'Status', 'Result', 'Processed At'];
function seed() {
  sheets = new FakeSheets();
  sheets.tab('Inventory', [['ProductId', 'LocationId', 'Count', 'LastUpdated', 'Venture'],
    ['p_ob2', 'cabin_wv', '4', 't', 'barrelco'], ['p_op', 'cabin_wv', '7', 't', 'barrelco'], ['p_ob2', 'loc_woodlawn_md', '10', 't', 'barrelco']]);
  sheets.tab('Catalog', [['ProductId', 'Code', 'Name', 'Unit Cost', 'CF Sale Price', 'Cabin Shop Price', 'Active', 'Notes'],
    ['p_ob2', 'OB2', 'Weathered Oak Whiskey Barrel', '28', '110', '95', 'yes', ''],
    ['p_op', 'OP', 'Whiskey Barrel Planter', '18', '85', '65', 'yes', ''],
    ['p_mini', 'MINI', 'Mini Barrel', '', '', '', 'yes', '']]);
  sheets.tab('Locations', [['LocationId', 'Name', 'Type', 'Monthly Cost', 'Notes'],
    ['cabin_wv', 'Cabin (Milam Ridge WV)', 'own', '0', ''], ['loc_woodlawn_md', 'Woodlawn MD Storage', 'own', '800', ''],
    ['loc_waynesboro_va', 'Waynesboro VA', 'own', '0', '']]);
  sheets.tab('Entry', [HEAD.slice()]);
  sheets.tab('Config', [['Key', 'Value'], ['Entry_Run_Token', TOKEN]]);
  mom = null;
}
const entry = (...rows) => rows.forEach(r => { const row = Array(10).fill(''); r.forEach((v, i) => { row[i] = v; }); sheets.tabs.get('Entry').push(row); });
const E = (action, loc, prod, qty, extra = {}) => [action, loc, prod, String(qty), extra.to || '', extra.price || '', extra.note || ''];
const status = (n = 1) => { const r = sheets.tabs.get('Entry')[n]; return { status: r[7], result: r[8], at: r[9] }; };
const TOKEN = 'test-entry-token-123';
let lastRes = null;
// The processor is now run by the master scheduler calling POST /entry/run (no cron). run() does exactly that.
async function run(w = worker, e = env, body = {}, token = TOKEN) {
  const r = await w.fetch(new Request('https://w/entry/run', { method: 'POST', headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e);
  lastRes = { status: r.status, body: await r.json() };
  return lastRes;
}
const hist = () => sheets.objects('History');
const debug = () => sheets.objects('Debug').filter(d => d.app === 'entry');

async function test(name, fn) {
  seed(); sheets.install();
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' :: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')]); }
  finally { sheets.uninstall(); }
}

await test('Received: cabin barrels 4 -> 8, history add, row marked OK', async () => {
  entry(E('Received', 'Cabin (Milam Ridge WV)', 'Weathered Oak Whiskey Barrel', 4));
  await run();
  assert.equal(sheets.invCount('p_ob2'), 8);
  assert.equal(status().status, 'OK'); assert.match(status().result, /4 → 8/); assert.ok(status().at);
  const h = hist(); assert.equal(h.length, 1); assert.equal(h[0].type, 'add'); assert.equal(+h[0].qty, 4); assert.equal(+h[0].newTotal, 8); assert.equal(h[0].locationId, 'cabin_wv'); assert.equal(h[0].venture, 'barrelco');
});
await test('Sold: Woodlawn 10 -> 6, revenue from catalog price, product matched by code', async () => {
  entry(E('Sold', 'Woodlawn MD Storage', 'OB2', 4));
  await run();
  assert.equal(sheets.invCount('p_ob2', 'loc_woodlawn_md'), 6); assert.equal(sheets.invCount('p_ob2'), 4);   // cabin untouched
  const h = hist()[0]; assert.equal(h.type, 'sold'); assert.equal(+h.salePrice, 95); assert.equal(+h.revenue, 380);
  assert.match(status().result, /\$380\.00/);
});
await test('Sold with explicit price overrides catalog; $ and commas ok', async () => {
  entry(E('Sold', 'cabin_wv', 'p_op', 2, { price: '$70' }));
  await run(); assert.equal(sheets.invCount('p_op'), 5); assert.equal(+hist()[0].revenue, 140);
});
await test('Sold with no known price still sells and says so', async () => {
  sheets.tab('Inventory', [...sheets.tabs.get('Inventory'), ['p_mini', 'cabin_wv', '1', 't', 'barrelco']]);
  entry(E('Sold', 'cabin_wv', 'Mini Barrel', 1));
  await run(); assert.equal(sheets.invCount('p_mini'), 0); assert.match(status().result, /no price recorded/);
});
await test('Selling more than on hand is refused: ERROR, nothing changes', async () => {
  entry(E('Sold', 'cabin_wv', 'OB2', 9));
  await run(); assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(hist().length, 0);
  assert.match(status().status, /^ERROR: only 4/);
});
await test('Set count, Remove, Transfer', async () => {
  entry(E('Set count', 'cabin_wv', 'OB2', 12), E('Remove (lost/damaged)', 'cabin_wv', 'OB2', 2), E('Transfer', 'cabin_wv', 'OB2', 5, { to: 'Waynesboro VA' }));
  await run();
  assert.equal(sheets.invCount('p_ob2'), 5); assert.equal(sheets.invCount('p_ob2', 'loc_waynesboro_va'), 5);
  assert.deepEqual([1, 2, 3].map(n => status(n).status), ['OK', 'OK', 'OK']);
  assert.deepEqual(hist().map(h => h.type), ['edit', 'adjust', 'transfer', 'transfer']);
  assert.equal(+hist()[0].qty, 12);
});
await test('Received at a location/product with no Inventory row creates it', async () => {
  entry(E('Received', 'Waynesboro VA', 'Mini Barrel', 3));
  await run(); assert.equal(sheets.invCount('p_mini', 'loc_waynesboro_va'), 3);
  assert.deepEqual(sheets.tabs.get('Inventory').at(-1), ['p_mini', 'loc_waynesboro_va', 3, sheets.tabs.get('Inventory').at(-1)[3], 'barrelco']);
});
await test('Running twice never double-applies', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4));
  await run(); await run(); await run();
  assert.equal(sheets.invCount('p_ob2'), 8); assert.equal(hist().length, 1);
});
await test('Rows entered later are picked up; earlier ones untouched', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 1)); await run();
  entry(E('Received', 'cabin_wv', 'OB2', 1)); await run();
  assert.equal(sheets.invCount('p_ob2'), 6); assert.equal(hist().length, 2);
});
await test('Bad input is rejected with a clear message and writes nothing', async () => {
  entry(E('Dance', 'cabin_wv', 'OB2', 1), E('Received', 'Narnia', 'OB2', 1), E('Received', 'cabin_wv', 'Unicorn', 1), E('Received', 'cabin_wv', 'OB2', 'abc'),
    E('Received', 'cabin_wv', 'OB2', 0), E('Transfer', 'cabin_wv', 'OB2', 1, { to: 'cabin_wv' }), E('Transfer', 'cabin_wv', 'OB2', 1), E('Sold', 'cabin_wv', 'OB2', 1, { price: 'free' }));
  await run();
  const msgs = [1, 2, 3, 4, 5, 6, 7, 8].map(n => status(n).status);
  assert.ok(msgs.every(m => m.startsWith('ERROR: ')), msgs.join(' / '));
  assert.match(msgs[0], /unknown action/); assert.match(msgs[1], /unknown location/); assert.match(msgs[2], /unknown product/); assert.match(msgs[3], /whole number/);
  assert.match(msgs[4], /at least 1/); assert.match(msgs[5], /same as Location/); assert.match(msgs[6], /needs a "To Location"/); assert.match(msgs[7], /not a number/);
  assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(hist().length, 0);
});
await test('Blank rows and rows with a status are ignored', async () => {
  entry([], ['', '', '', '', '', '', '', 'OK', 'old', 'x']); await run();
  assert.equal(hist().length, 0); assert.equal(sheets.tabs.get('Entry')[2][7], 'OK');
});
await test('Names are case/space-insensitive; ids work too', async () => {
  entry(E('  received ', ' CABIN_WV ', ' whiskey barrel planter ', 1)); await run();
  assert.equal(sheets.invCount('p_op'), 8);
});
// ── failure injection: nothing may fail silently ──
await test('inventory write fails -> ERROR (nothing applied), logged, never retried blindly', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4));
  sheets.failNext(/PUT .*Inventory!C/, 500);
  await run();
  assert.match(status().status, /^ERROR: /); assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(hist().length, 0);
  assert.ok(debug().some(d => /row 2/.test(d.msg)));
  await run(); assert.equal(sheets.invCount('p_ob2'), 4);   // row has a status now: not re-applied
});
await test('history append fails after inventory write -> CHECK (partly applied), logged', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4));
  sheets.failNext(/POST .*History.*append/, 500);
  await run();
  assert.match(status().status, /^CHECK: partly applied/); assert.equal(sheets.invCount('p_ob2'), 8); assert.ok(debug().length >= 1);
});
await test('claim fails -> nothing applied, row left blank, next run succeeds', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4));
  sheets.failNext(/PUT .*Entry!H2:J2/, 500);
  await run(); assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(status().status, '');
  await run(); assert.equal(sheets.invCount('p_ob2'), 8); assert.equal(status().status, 'OK');
});
await test('final status write fails -> row stays PROCESSING (not re-applied); after 10 min flagged CHECK', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4));
  const orig = sheets.handle.bind(sheets); let n = 0;
  sheets.handle = async (url, opts) => { if ((opts.method || '') === 'PUT' && /Entry!H2/.test(decodeURIComponent(url)) && ++n === 2) return new Response('{"error":{"message":"boom"}}', { status: 500 }); return orig(url, opts); };
  await run(); assert.equal(status().status, 'PROCESSING'); assert.equal(sheets.invCount('p_ob2'), 8);
  sheets.handle = orig;
  await run(); assert.equal(sheets.invCount('p_ob2'), 8); assert.equal(status().status, 'PROCESSING');          // too fresh to call stuck
  sheets.tabs.get('Entry')[1][9] = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await run(); assert.match(status().status, /^CHECK: stuck/); assert.equal(sheets.invCount('p_ob2'), 8);
});
await test('count that does not verify after writing is flagged CHECK', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4));
  const orig = sheets.handle.bind(sheets); let armed = true;
  sheets.handle = async (url, opts) => { const r = await orig(url, opts);
    if (armed && (opts.method || '') === 'PUT' && /Inventory!C/.test(decodeURIComponent(url))) { armed = false; sheets.tabs.get('Inventory')[1][2] = '99'; } return r; };
  await run(); assert.match(status().status, /^CHECK: count did not verify/);
});
await test('Sheets read failure on Entry: cron does not crash, problem logged once per hour', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4));
  sheets.failNext(/GET .*Entry/, 503, 2);
  await run(); await run();
  assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(debug().length, 1);
  await run(); assert.equal(sheets.invCount('p_ob2'), 8);   // recovers by itself
});
await test('Entry tab missing a column is reported (once), not guessed', async () => {
  sheets.tabs.get('Entry')[0][7] = 'State'; entry(E('Received', 'cabin_wv', 'OB2', 4));
  await run(); await run();
  assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(debug().length, 1); assert.match(debug()[0].msg, /missing column/);
});
await test('Status/Result/Processed At must be adjacent', async () => {
  sheets.tabs.get('Entry')[0] = ['Action', 'Location', 'Product', 'Qty', 'Status', 'To Location', 'Result', 'Processed At'];
  entry(E('Received', 'cabin_wv', 'OB2', 4)); await run();
  assert.equal(sheets.invCount('p_ob2'), 4); assert.match(debug()[0].msg, /adjacent/);
});
await test('no Config tab at all: endpoint says the token is not set (503), changes nothing', async () => {
  sheets.tabs.delete('Config'); entry(E('Received', 'cabin_wv', 'OB2', 4));
  const r = await run(); assert.equal(r.status, 503); assert.equal(r.body.ok, false); assert.equal(r.body.error, 'entry_run_token_not_set');
  assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(status().status, '');
});
await test('Config tab without Entry_Run_Token: 503', async () => {
  sheets.tab('Config', [['Key', 'Value']]); const r = await run(); assert.equal(r.status, 503);
});
await test('wrong token: 401 and nothing applied', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4)); const r = await run(worker, env, {}, 'nope'); assert.equal(r.status, 401); assert.equal(r.body.ok, false);
  assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(status().status, '');
});
await test('missing token header: 401', async () => {
  const r = await worker.fetch(new Request('https://w/entry/run', { method: 'POST', body: '{}' }), env); assert.equal(r.status, 401);
});
await test('GET /entry/run is not a route (404)', async () => {
  const r = await worker.fetch(new Request('https://w/entry/run', { headers: { 'X-Auth-Token': TOKEN } }), env); assert.equal(r.status, 404);
});
await test('success answer shape: {ok:true, report:[{label:main, ok:1}]}', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4)); const r = await run(); assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal(r.body.report[0].label, 'main'); assert.equal(r.body.report[0].ok, 1);
});
await test('dry_run counts waiting rows and changes nothing', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4), E('Sold', 'cabin_wv', 'OB2', 1), ['', '', '', '', '', '', '', 'OK', 'old', 'x']);
  const r = await run(worker, env, { dry_run: true }); assert.equal(r.status, 200); assert.equal(r.body.dry_run, true);
  assert.deepEqual(r.body.waiting.main, { waiting: 2, stuck: 0 });
  assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(status(1).status, ''); assert.equal(hist().length, 0);
});
await test('dry_run reports stuck rows and a broken extra sheet without failing', async () => {
  const undo = withMom();
  try {
    entry(E('Received', 'cabin_wv', 'OB2', 4)); sheets.tabs.get('Entry')[1][7] = 'PROCESSING';
    mom.tabs.delete('Sales');
    const r = await run(worker, env, { dry_run: true }); assert.equal(r.status, 200);
    assert.equal(r.body.waiting.main.stuck, 1); assert.ok(r.body.waiting.waynesboro.error);
  } finally { undo(); }
});
await test('Sheets down while reading the token: 5xx {ok:false}, nothing applied (caller sees the failure)', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4)); sheets.failNext(/GET .*values\/Config/, 500, 99);
  const r = await run(); assert.ok(r.status >= 500); assert.equal(r.body.ok, false); assert.equal(sheets.invCount('p_ob2'), 4);
});
await test('a sheet-level problem (Entry tab unreadable) is inside the report, not hidden', async () => {
  sheets.failNext(/GET .*values\/Entry/, 503, 99);
  const r = await run(); assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.ok(r.body.report[0].error); assert.ok(debug().length >= 1);
});
await test('no scheduled() handler and no cron anywhere in BarrelCo', async () => {
  assert.equal(typeof worker.scheduled, 'undefined');
  const fs = await import('node:fs');
  assert.ok(!/^\s*crons\s*=/m.test(fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')));
  for (const f of ['../.github/workflows/pinterest-sync.yml']) { const t = fs.readFileSync(new URL(f, import.meta.url), 'utf8'); assert.ok(!/^\s*schedule:/m.test(t) && !/cron:/.test(t)); assert.match(t, /workflow_dispatch:/); }
});
await test('no Config tab and empty Entry: quiet no-op', async () => {
  await run(); assert.equal(debug().length, 0); assert.equal(hist().length, 0);
});
// ── Waynesboro sheet (second spreadsheet) ──
function withMom() {
  mom = new FakeSheets();
  mom.tab('Sales', [['Product', 'Qty', 'Price', 'Note', 'Status', 'Result', 'Processed At']]);
  sheets.tab('Config', [['Key', 'Value'], ['Entry_Run_Token', TOKEN], ['WaynesboroEntrySheetId', 'MOM789']]);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).includes('/spreadsheets/MOM789') ? mom.handle(String(url).replace('MOM789', 'SHEET123'), opts || {}) : orig(url, opts);
  return () => { globalThis.fetch = orig; };
}
await test('Waynesboro sheet: mother marks a sale -> main Inventory drawn down, her row marked OK', async () => {
  const undo = withMom();
  try {
    sheets.tabs.get('Inventory').push(['p_op', 'loc_waynesboro_va', '6', 't', 'barrelco']);
    mom.tabs.get('Sales').push(['Whiskey Barrel Planter', '2', '70', 'neighbor', '', '', '']);
    await run();
    assert.equal(sheets.invCount('p_op', 'loc_waynesboro_va'), 4);
    const row = mom.tabs.get('Sales')[1]; assert.equal(row[4], 'OK'); assert.match(row[5], /Waynesboro VA: 6 → 4/);
    const h = hist()[0]; assert.equal(h.type, 'sold'); assert.equal(h.locationId, 'loc_waynesboro_va'); assert.equal(+h.revenue, 140); assert.match(h.note, /waynesboro row 2/);
    await run(); assert.equal(sheets.invCount('p_op', 'loc_waynesboro_va'), 4);
  } finally { undo(); }
});
await test('Waynesboro sheet: only sales allowed; oversell refused', async () => {
  const undo = withMom();
  try {
    mom.tab('Sales', [['Action', 'Product', 'Qty', 'Price', 'Note', 'Status', 'Result', 'Processed At'],
      ['Received', 'Whiskey Barrel Planter', '5', '', '', '', '', ''], ['Sold', 'Whiskey Barrel Planter', '1', '', '', '', '', '']]);
    await run();
    const rows = mom.tabs.get('Sales');
    assert.match(rows[1][5], /^ERROR: "Received" is not allowed/); assert.match(rows[2][5], /^ERROR: only 0/);
    assert.equal(hist().length, 0);
  } finally { undo(); }
});
await test('Waynesboro sheet problem does not block the main Entry tab', async () => {
  const undo = withMom();
  try {
    mom.tab('Sales', [['Product', 'Qty']]);                       // broken: no Status columns
    entry(E('Received', 'cabin_wv', 'OB2', 4)); await run();
    assert.equal(sheets.invCount('p_ob2'), 8); assert.ok(debug().some(d => /waynesboro/.test(d.msg)));
  } finally { undo(); }
});
await test('Config sheet id pointing at a missing tab is reported', async () => {
  const undo = withMom();
  try { mom.tabs.delete('Sales'); await run(); assert.ok(debug().some(d => /not found/.test(d.msg))); } finally { undo(); }
});
await test('shop orders and entry rows coexist on the same Inventory tab', async () => {
  entry(E('Received', 'cabin_wv', 'OB2', 4)); await run();
  const r = await worker.fetch(new Request('https://w/inventory'), env); const d = await r.json();
  assert.ok(d.values.some(x => x[0] === 'p_ob2' && x[1] === 'cabin_wv' && x[2] === '8'));
});

for (const [s, n] of results) console.log(s, n);
const bad = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
