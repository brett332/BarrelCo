// StockShift (index.html) check: cabin location/products seeded, cabin counts follow the Sheet,
// sync failures are visible. Runs against the fake-Sheets worker via request interception.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium, devices } = require('playwright');
const LOCAL = 'http://localhost:8787', PROD = 'https://barrel-co.brett-2f8.workers.dev', APP = 'http://localhost:4174/index.html';
const api = async (p, o) => (await fetch(LOCAL + p, o)).json();
await api('/__reset'); await api('/public/shop');          // seeds cabin stock 4/7/4
const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'] }); const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
let breakInv = false;
await page.route(PROD + '/**', async route => {
  if (breakInv && route.request().url().endsWith('/inventory') && route.request().method() === 'GET') return route.fulfill({ status: 500, body: 'x' });
  const r = await route.fetch({ url: route.request().url().replace(PROD, LOCAL) }); await route.fulfill({ response: r });
});
const out = []; const ok = (n, f) => { try { f(); out.push('PASS ' + n); } catch (e) { out.push('FAIL ' + n + ' :: ' + e.message); } };
await page.goto(APP); await page.waitForTimeout(2500);
const ls = async k => page.evaluate(k => JSON.parse(localStorage.getItem(k)), k);
const locs = await ls('ss_locations_v1_barrelco'), prods = await ls('ss_products_v1_barrelco'), inv = await ls('ss_inventory_v1_barrelco'), pr = await ls('ss_prices_v1_barrelco');
const keys = await page.evaluate(() => Object.keys(localStorage));
ok('storage keys discovered', () => assert.ok(locs && prods && inv, 'keys: ' + keys));
ok('cabin location present', () => assert.ok(locs.some(l => l.id === 'cabin_wv')));
ok('sphere product present, originals kept', () => { assert.ok(prods.some(p => p.id === 'p_sph')); assert.ok(prods.some(p => p.id === 'p_ob2')); assert.equal(locs.filter(l => l.id !== 'cabin_wv').length, 12); });
ok('mini barrel product seeded (MB, $125 at cabin)', () => { assert.ok(prods.some(p => p.id === 'p_mini' && p.code === 'MB')); assert.equal(pr['p_mini|cabin_wv'].price, 125); });
ok('cabin prices 95/65/60', () => assert.deepEqual([pr['p_ob2|cabin_wv'].price, pr['p_op|cabin_wv'].price, pr['p_sph|cabin_wv'].price], [95, 65, 60]));
ok('cabin counts pulled from Sheet 4/7/4', () => assert.deepEqual([inv['p_ob2|cabin_wv'], inv['p_op|cabin_wv'], inv['p_sph|cabin_wv']], [4, 7, 4]));
// a web order lowers the Sheet; StockShift (stale local) must follow on next foreground
await fetch(LOCAL + '/public/order', { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:4173' }, body: JSON.stringify({ orderToken: 'abcdefabcdefabcdef12', items: [{ id: 'planter', qty: 2 }], method: 'venmo', customer: { firstName: 'A', lastName: 'B', email: 'a@b.co', phone: '3045550123', address1: '1 St', city: 'X', state: 'WV', zip: '26757' } }) }).then(r => r.json()).then(d => assert.equal(d.ok, true));
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(1500);
const inv2 = await ls('ss_inventory_v1_barrelco');
ok('after web order, cabin planters 7 -> 5 in StockShift', () => assert.equal(inv2['p_op|cabin_wv'], 5));
ok('other locations untouched locally', () => assert.ok(!('p_ob2|bal_nl1' in inv2) || inv2['p_ob2|bal_nl1'] === inv['p_ob2|bal_nl1']));
// failure is visible
breakInv = true; await page.evaluate(() => ssSyncFromSheet()); await page.waitForTimeout(1200);
const toast = await page.evaluate(() => (document.querySelector('.toast, #toast') || {}).textContent || document.body.innerText.match(/Could not load counts[^\n]*/)?.[0] || '');
ok('inventory pull failure shows a visible warning', () => assert.match(toast, /Could not load counts/));
ok('no page errors', () => assert.deepEqual(errs, []));
console.log(out.join('\n')); await page.screenshot({ path: '/tmp/claude-0/-home-claude/25f565f3-07e7-5841-aad2-46a49f269630/scratchpad/stockshift.png' });
await browser.close(); process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
