import assert from 'node:assert/strict';
import worker from '../worker.js';
import { FakeSheets, makeEnv } from './fake-sheets.mjs';

const env = { ...makeEnv(), SHOP_ALLOW_LOCALHOST: '1' };
const ORIGIN = 'https://ridge-co.github.io';
let sheets; let results = []; let tokN = 0;
const tok = () => 'tok-' + String(++tokN).padStart(4, '0') + '-aaaaaaaaaaaa';
const good = (over = {}) => ({
  orderToken: tok(), items: [{ id: 'barrel', qty: 1 }], method: 'venmo', source: 'sign', marketingOptIn: true,
  customer: { firstName: 'Jane', lastName: 'Doe', email: 'Jane@Example.com', phone: '(304) 555-0123', address1: '1 Main St', address2: '', city: 'Romney', state: 'wv', zip: '26757' }, ...over });
const get = (p = '/public/shop') => worker.fetch(new Request('https://w' + p), env);
const post = (b, origin = ORIGIN, raw) => worker.fetch(new Request('https://w/public/order', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: raw ?? JSON.stringify(b) }), env);
async function test(name, fn) {
  sheets = new FakeSheets(); sheets.install();
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); }
  finally { sheets.uninstall(); }
}
const j = async r => ({ ...(await r.json()), status: r.status });

await test('GET /public/shop seeds tabs, prices, stock, methods', async () => {
  const r = await j(await get());
  assert.equal(r.status, 200); assert.equal(r.ok, true);
  assert.deepEqual(r.products.map(p => [p.id, p.price, p.available]), [['barrel', 95, 4], ['planter', 65, 7], ['sphere', 60, 4]]);
  assert.deepEqual(r.methods.map(m => m.id), ['venmo', 'cashapp', 'paypal', 'zelle']);
  assert.equal(r.shop.name, 'Milam Ridge'); assert.equal(r.shop.open, true);
  assert.equal(sheets.invCount('p_op'), 7); assert.equal(sheets.invCount('p_ob2', 'bal_nl1'), 9); // other location untouched
});
await test('GET twice does not re-seed', async () => {
  await get(); await get();
  assert.equal(sheets.objects('Shop_Products').length, 3); assert.equal(sheets.tabs.get('Inventory').length, 5);
});
await test('Seed does not overwrite existing cabin stock', async () => {
  sheets.tabs.get('Inventory').push(['p_op', 'cabin_wv', '5', 't', 'barrelco']);
  await get(); assert.equal(sheets.invCount('p_op'), 5);
});
await test('price edit in Sheet shows up; inactive hidden; bad price unavailable', async () => {
  await get();
  const t = sheets.tabs.get('Shop_Products'); t[1][2] = '$99.50'; t[2][5] = 'FALSE'; t[3][2] = 'abc';
  const r = await j(await get());
  assert.deepEqual(r.products.map(p => [p.id, p.price, p.available]), [['barrel', 99.5, 4], ['sphere', null, 0]]);
});
await test('happy path: order row, stock decrement, history row, verified', async () => {
  await get();
  const r = await j(await post(good({ items: [{ id: 'barrel', qty: 2 }, { id: 'planter', qty: 1 }] })));
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.ok, true); assert.equal(r.total, 255); assert.deepEqual(r.warnings, []);
  assert.match(r.orderId, /^MR-[0-9A-Z]{8}$/);
  const o = sheets.objects('Shop_Orders')[0];
  assert.equal(o.FirstName, 'Jane'); assert.equal(o.LastName, 'Doe'); assert.equal(o.Email, 'jane@example.com');
  assert.equal(o.Phone, '304-555-0123'); assert.equal(o.State, 'WV'); assert.equal(o.Subtotal, 255); assert.equal(o.StockStatus, 'DONE');
  assert.equal(o.Status, 'New'); assert.equal(o.MarketingOptIn, 'Yes'); assert.equal(o.Source, 'sign');
  assert.equal(sheets.invCount('p_ob2'), 2); assert.equal(sheets.invCount('p_op'), 6); assert.equal(sheets.invCount('p_sph'), 4);
  const h = sheets.objects('History'); assert.equal(h.length, 2); assert.equal(h[0].type, 'sold'); assert.equal(h[0].locationId, 'cabin_wv'); assert.equal(h[0].revenue, 190);
  const g = await j(await get()); assert.equal(g.products[0].available, 2);
});
await test('double submit (same token) is idempotent', async () => {
  await get(); const b = good();
  const a = await j(await post(b)); const c = await j(await post(b));
  assert.equal(c.duplicate, true); assert.equal(c.orderId, a.orderId);
  assert.equal(sheets.objects('Shop_Orders').length, 1); assert.equal(sheets.invCount('p_ob2'), 3);
});
await test('client-sent price is ignored (server prices)', async () => {
  await get(); const b = good(); b.items[0].price = 1;
  const r = await j(await post(b)); assert.equal(r.total, 95);
});
await test('over-stock request is refused with details, nothing written', async () => {
  await get(); const r = await j(await post(good({ items: [{ id: 'barrel', qty: 5 }] })));
  assert.equal(r.status, 409); assert.equal(r.error, 'stock'); assert.deepEqual(r.items, [{ id: 'barrel', name: 'Whiskey Barrel (Full Size)', available: 4 }]);
  assert.equal(sheets.objects('Shop_Orders').length, 0); assert.equal(sheets.invCount('p_ob2'), 4);
});
await test('unknown product / zero / fractional / dup lines rejected', async () => {
  await get();
  for (const items of [[{ id: 'nope', qty: 1 }], [{ id: 'barrel', qty: 0 }], [{ id: 'barrel', qty: 1.5 }], [{ id: 'barrel', qty: 1 }, { id: 'barrel', qty: 1 }], []]) {
    const r = await j(await post(good({ items }))); assert.ok([400, 409].includes(r.status), JSON.stringify(items) + ' -> ' + r.status);
  }
  assert.equal(sheets.objects('Shop_Orders').length, 0);
});
await test('field validation errors name the field', async () => {
  await get();
  const cases = [['firstName', { firstName: '' }], ['lastName', { lastName: ' ' }], ['email', { email: 'nope' }], ['phone', { phone: '123' }], ['address1', { address1: '' }], ['city', { city: '' }], ['state', { state: 'ZZ' }], ['zip', { zip: '1234' }]];
  for (const [field, patch] of cases) {
    const b = good(); Object.assign(b.customer, patch); const r = await j(await post(b));
    assert.equal(r.status, 400); assert.equal(r.field, field);
  }
  const r = await j(await post(good({ method: 'bitcoin' }))); assert.equal(r.field, 'method');
  const r2 = await j(await post(good({ orderToken: 'short' }))); assert.equal(r2.status, 400);
});
await test('bad origin / missing origin forbidden; bad json 400; huge body 413', async () => {
  await get();
  assert.equal((await post(good(), 'https://evil.example')).status, 403);
  assert.equal((await post(good(), null)).status, 403);
  assert.equal((await post(null, ORIGIN, '{nope')).status, 400);
  assert.equal((await post(null, ORIGIN, 'x'.repeat(9000))).status, 413);
  assert.equal((await post(good(), 'http://localhost:4173')).status, 200);
  assert.ok(!sheets.objects('Debug').some(d => /origin/.test(d.msg)), 'forged-origin hits must not write to the Sheet');
  const prod = { ...env, SHOP_ALLOW_LOCALHOST: undefined };
  assert.equal((await worker.fetch(new Request('https://w/public/order', { method: 'POST', headers: { Origin: 'http://localhost:4173' }, body: JSON.stringify(good()) }), prod)).status, 403);
});
await test('honeypot filled: visible error (not fake success), no order, no stock change', async () => {
  await get(); const r = await j(await post(good({ website: 'http://spam' })));
  assert.equal(r.status, 400); assert.equal(r.error, 'blocked'); assert.equal(sheets.objects('Shop_Orders').length, 0); assert.equal(sheets.invCount('p_ob2'), 4);
});
await test('shop closed switch blocks orders', async () => {
  await get(); sheets.tabs.get('Shop_Settings').find(r => r[0] === 'Open')[1] = 'FALSE';
  const r = await j(await post(good())); assert.equal(r.status, 409); assert.equal(r.error, 'closed');
  assert.equal((await j(await get())).shop.open, false);
});
await test('TEST orders are recorded but do not touch stock', async () => {
  await get(); const b = good(); b.customer.firstName = 'Test'; b.customer.lastName = 'Order';
  const r = await j(await post(b)); assert.equal(r.ok, true);
  const o = sheets.objects('Shop_Orders')[0]; assert.equal(o.Status, 'TEST'); assert.match(o.StockStatus, /TEST/);
  assert.equal(sheets.invCount('p_ob2'), 4); assert.equal(sheets.objects('History').length, 0);
});
await test('real customers named Testa/Tester are NOT treated as test orders', async () => {
  await get(); const b = good(); b.customer.lastName = 'Tester'; await post(b);
  assert.equal(sheets.objects('Shop_Orders')[0].Status, 'New'); assert.equal(sheets.invCount('p_ob2'), 3);
});
await test('oversold at decrement time: no stock written, order marked OVERSOLD, customer gets 409', async () => {
  await get(); const orig = sheets.handle.bind(sheets); let armed = true;
  sheets.handle = async (url, opts) => { const r = await orig(url, opts);   // another buyer empties the shelf right after our availability check
    if (armed && opts.method === 'POST' && /Shop_Orders.*append/.test(decodeURIComponent(url)) && sheets.tabs.get('Shop_Orders').length > 1) { armed = false; sheets.tabs.get('Inventory').find(r => r[0] === 'p_ob2' && r[1] === 'cabin_wv')[2] = '0'; } return r; };
  const r = await j(await post(good())); assert.equal(r.status, 409); assert.equal(r.error, 'stock');
  const o = sheets.objects('Shop_Orders')[0]; assert.equal(o.Status, 'OVERSOLD'); assert.match(o.StockStatus, /OVERSOLD/);
  assert.equal(sheets.invCount('p_ob2'), 0); assert.equal(sheets.objects('History').length, 0);
});
await test('price changed since page load -> 409 price_changed, nothing written', async () => {
  await get(); const r = await j(await post(good({ expectedTotal: 90 }))); assert.equal(r.status, 409); assert.equal(r.error, 'price_changed'); assert.equal(r.total, 95);
  assert.equal(sheets.objects('Shop_Orders').length, 0);
  assert.equal((await j(await post(good({ expectedTotal: 95 })))).ok, true);
});
await test('post-append hiccup (verify read fails) still returns success + warning, stock still decremented', async () => {
  await get(); sheets.failNext(/GET .*Shop_Orders!A\d+:A\d+/, 500);
  const r = await j(await post(good())); assert.equal(r.status, 200); assert.ok(r.warnings.includes('order_verify_failed')); assert.equal(sheets.invCount('p_ob2'), 3);
  assert.ok(sheets.objects('Debug').some(d => /could not be verified/.test(d.msg)));
});
await test('duplicate response carries the server lines/total', async () => {
  await get(); const b = good({ items: [{ id: 'barrel', qty: 2 }] }); await post(b); const d = await j(await post(b));
  assert.equal(d.duplicate, true); assert.equal(d.total, 190); assert.deepEqual(d.lines, [{ qty: 2, name: 'Whiskey Barrel (Full Size)', total: 190 }]);
});
await test('more than 10 units in one order refused', async () => {
  await get(); sheets.tabs.get('Inventory').find(r => r[0] === 'p_op' && r[1] === 'cabin_wv')[2] = '50'; sheets.tabs.get('Inventory').find(r => r[0] === 'p_ob2' && r[1] === 'cabin_wv')[2] = '50';
  const r = await j(await post(good({ items: [{ id: 'planter', qty: 8 }, { id: 'barrel', qty: 8 }] }))); assert.equal(r.status, 400);
});
await test('duplicate product Id in Sheet is an error, not a guess', async () => {
  await get(); sheets.tabs.get('Shop_Products').push([...sheets.tabs.get('Shop_Products')[1]]);
  assert.equal((await j(await get())).status, 500);
});
await test('/debug clear refuses app=shop; clear of other app deletes from the RIGHT tab', async () => {
  await get(); await post(good());   // makes tabs: Debug first? order matters not
  sheets.tabs.get('Debug').push(['lf', 'x', 't']); sheets.sheetIds = null;
  const r1 = await worker.fetch(new Request('https://w/debug', { method: 'POST', body: JSON.stringify({ action: 'clear', app: 'shop' }) }), env); assert.equal(r1.status, 403);
  const r2 = await worker.fetch(new Request('https://w/debug', { method: 'POST', body: JSON.stringify({ action: 'clear', app: 'lf' }) }), env); assert.equal(r2.status, 200);
  assert.ok(!sheets.tabs.get('Debug').some(r => r[0] === 'lf')); assert.equal(sheets.tabs.get('Inventory').length >= 2, true);
});
await test('hourly cap trips (non-test orders only) and is logged', async () => {
  await get(); sheets.tabs.get('Inventory').find(r => r[0] === 'p_op' && r[1] === 'cabin_wv')[2] = '100';
  for (let i = 0; i < 12; i++) assert.equal((await j(await post(good({ items: [{ id: 'planter', qty: 1 }] })))).ok, true);
  const r = await j(await post(good({ items: [{ id: 'planter', qty: 1 }] }))); assert.equal(r.status, 429);
  assert.ok(sheets.objects('Debug').some(d => /hourly cap/.test(d.msg)));
});
await test('formula-injection text is neutralized and stored RAW', async () => {
  await get(); const b = good(); b.customer.firstName = '=HYPERLINK("x")'; b.customer.address1 = '+cmd|calc';
  const r = await j(await post(b)); assert.equal(r.ok, true);
  const o = sheets.objects('Shop_Orders')[0]; assert.ok(!/^[=+\-@]/.test(o.FirstName)); assert.ok(!/^[=+\-@]/.test(o.Address1));
  assert.ok(sheets.calls.filter(c => /Shop_Orders.*append/.test(decodeURIComponent(c[1]))).every(c => /valueInputOption=RAW/.test(c[1])));
});
await test('name casing: all-lower becomes Title Case; mixed untouched', async () => {
  await get(); const b = good(); b.customer.firstName = 'mary ann'; b.customer.lastName = 'McDonald'; b.customer.city = 'ROMNEY';
  await post(b); const o = sheets.objects('Shop_Orders')[0]; assert.equal(o.FirstName, 'Mary Ann'); assert.equal(o.LastName, 'McDonald'); assert.equal(o.City, 'Romney');
});
// ── failure injection: nothing may fail silently ──
await test('order append fails -> 500, logged, stock untouched', async () => {
  await get(); sheets.failNext(/POST .*Shop_Orders.*append/, 500);
  const r = await j(await post(good())); assert.equal(r.status, 500); assert.equal(r.ok, false);
  assert.equal(sheets.invCount('p_ob2'), 4); assert.ok(sheets.objects('Debug').some(d => /POST \/public\/order failed/.test(d.msg)));
});
await test('inventory write fails -> order kept, warning returned, row flagged FAILED, logged', async () => {
  await get(); sheets.failNext(/PUT .*Inventory!C/, 500);
  const r = await j(await post(good())); assert.equal(r.status, 200); assert.ok(r.warnings.includes('stock_sync_failed'));
  const o = sheets.objects('Shop_Orders')[0]; assert.match(o.StockStatus, /^FAILED/); assert.ok(sheets.objects('Debug').some(d => /stock decrement failed/.test(d.msg)));
});
await test('status-cell update fails -> row stays PENDING, warning + log', async () => {
  await get(); sheets.failNext(/PUT .*Shop_Orders!/, 500);
  const r = await j(await post(good())); assert.ok(r.warnings.includes('status_update_failed'));
  assert.equal(sheets.objects('Shop_Orders')[0].StockStatus, 'PENDING'); assert.ok(sheets.objects('Debug').some(d => /status update failed/.test(d.msg)));
});
await test('Sheets read fails on GET /public/shop -> 500 shop_unavailable, logged', async () => {
  await get(); sheets.failNext(/GET .*Shop_Products/, 503);
  const r = await j(await get()); assert.equal(r.status, 500); assert.equal(r.error, 'shop_unavailable'); assert.ok(sheets.objects('Debug').some(d => /GET \/public\/shop failed/.test(d.msg)));
});
await test('missing required column in Shop_Products is an error, not a guess', async () => {
  await get(); sheets.tabs.get('Shop_Products')[0][2] = 'Cost';
  const r = await j(await get()); assert.equal(r.status, 500); assert.equal(r.error, 'shop_unavailable'); assert.ok(sheets.objects('Debug').some(d => /missing column/.test(d.msg)));
});
await test('product with no Inventory row is unavailable (not silently zero-priced)', async () => {
  await get(); sheets.tabs.set('Inventory', sheets.tabs.get('Inventory').filter(r => r[0] !== 'p_sph'));
  const r = await j(await get()); const s = r.products.find(p => p.id === 'sphere'); assert.equal(s.available, 0); assert.equal(s.unavailableReason, 'stock_link');
  const o = await j(await post(good({ items: [{ id: 'sphere', qty: 1 }] }))); assert.equal(o.status, 409);
});
await test('seed failure leaves nothing half-written; next request heals the tab', async () => {
  sheets.failNext(/POST .*Shop_Products.*append/, 500);
  const r = await j(await get()); assert.equal(r.status, 500);
  assert.ok(sheets.objects('Debug').some(d => /GET \/public\/shop failed/.test(d.msg)));
  const r2 = await j(await get()); assert.equal(r2.status, 200); assert.equal(r2.products.length, 3);
  assert.equal(sheets.objects('Shop_Products').length, 3);
});
await test('Google token failure surfaces as 500 JSON', async () => {
  const orig = globalThis.fetch; globalThis.fetch = async u => String(u).includes('oauth2') ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : orig(u);
  const r = await j(await get()); globalThis.fetch = orig; assert.equal(r.status, 500); assert.equal(r.ok, false);
});
await test('existing routes: /inventory POST now errors loudly on Sheets failure', async () => {
  sheets.failNext(/POST .*Inventory.*append/, 500);
  const r = await worker.fetch(new Request('https://w/inventory', { method: 'POST', body: JSON.stringify({ pid: 'x', lid: 'y', count: 1, ts: 't', venture: 'barrelco' }) }), env);
  assert.equal(r.status, 500);
  const ok = await worker.fetch(new Request('https://w/inventory', { method: 'POST', body: JSON.stringify({ pid: 'x', lid: 'y', count: 1, ts: 't', venture: 'barrelco' }) }), env);
  assert.equal(ok.status, 200);
});
await test('existing routes: /inventory GET, /history POST, 404 still work', async () => {
  assert.equal((await worker.fetch(new Request('https://w/inventory'), env)).status, 200);
  const h = await worker.fetch(new Request('https://w/history', { method: 'POST', body: JSON.stringify({ id: 'h1', ts: 't', type: 'sold', productId: 'p', productCode: 'c', locationId: 'l', listingCode: 'lc', locationName: 'n', qty: 1, newTotal: 0, salePrice: 1, revenue: 1 }) }), env);
  assert.equal(h.status, 200); assert.equal((await worker.fetch(new Request('https://w/nope'), env)).status, 404);
});

for (const [s, n] of results) console.log(s, n);
const bad = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
