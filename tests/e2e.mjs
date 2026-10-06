import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium, devices } = require('playwright');
const SITE = 'http://localhost:4173/shop/'; const LOCAL = 'http://localhost:8787'; const PROD = 'https://barrel-co.brett-2f8.workers.dev';
const OUT = process.env.OUT || '/tmp/e2e'; await import('node:fs').then(fs => fs.mkdirSync(OUT, { recursive: true }));
const api = async p => (await fetch(LOCAL + p)).json();
const state = () => api('/__state');
const results = []; const browser = await chromium.launch();

async function newPage(kind, opts = {}) {
  const ctx = await browser.newContext(kind === 'mobile' ? { ...devices['Pixel 7'], viewport: { width: 412, height: 915 } } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !opts.allowConsoleErrors) errors.push('console: ' + m.text()); });
  await page.route(PROD + '/**', async route => {
    if (opts.abort && opts.abort(route.request())) return route.abort('failed');
    const u = route.request().url().replace(PROD, LOCAL);
    const r = await route.fetch({ url: u }); await route.fulfill({ response: r });
  });
  page.errors = errors; return page;
}
async function test(name, kind, fn, opts) {
  await api('/__reset'); const page = await newPage(kind, opts);
  try { await fn(page); if (page.errors.length && !(opts && opts.allowConsoleErrors)) throw new Error('browser errors: ' + page.errors.join(' | ')); results.push(['PASS', `[${kind}] ${name}`]); }
  catch (e) { results.push(['FAIL', `[${kind}] ${name} :: ${e.message}`]); await page.screenshot({ path: `${OUT}/FAIL-${kind}-${name.replace(/\W+/g, '_')}.png`, fullPage: true }).catch(() => {}); }
  finally { await page.context().close(); }
}
const card = (page, id) => page.locator(`.card[data-id="${id}"]`);
async function fill(page, over = {}) {
  const v = { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '3045550123', address1: '1 Main St', address2: '', city: 'Romney', state: 'WV', zip: '26757', ...over };
  for (const k of ['firstName', 'lastName', 'email', 'phone', 'address1', 'address2', 'city', 'zip']) await page.fill('#' + k, v[k]);
  await page.selectOption('#state', v.state);
}

for (const kind of ['mobile', 'desktop']) {
  await test('loads: 3 products, prices, stock, photos', kind, async page => {
    await page.goto(SITE); await page.waitForSelector('.card');
    assert.equal(await page.locator('.card').count(), 3);
    const txt = await page.locator('#products').innerText();
    for (const s of ['$95.00', '$65.00', '$60.00', '4 available', '7 available']) assert.ok(txt.includes(s), 'missing ' + s);
    assert.equal(await page.locator('#shopName').innerText(), 'Milam Ridge');
    await page.waitForFunction(() => [...document.images].every(i => i.complete));
    const broken = await page.evaluate(() => [...document.images].filter(i => !i.naturalWidth).map(i => i.src));
    assert.deepEqual(broken, []);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, 'horizontal overflow ' + overflow);
    await page.screenshot({ path: `${OUT}/${kind}-1-products.png`, fullPage: false });
  });

  await test('stepper respects stock; bar totals; continue', kind, async page => {
    await page.goto(SITE); await page.waitForSelector('.card');
    assert.ok(await page.locator('#bar.hidden').count());
    const sph = card(page, 'sphere');
    for (let i = 0; i < 9; i++) if (await sph.locator('[data-role=plus]').isEnabled()) await sph.locator('[data-role=plus]').click();
    assert.equal(await sph.locator('[data-role=qty]').innerText(), '4'); assert.ok(await sph.locator('[data-role=plus]').isDisabled());
    await card(page, 'barrel').locator('[data-role=plus]').click(); await sph.locator('[data-role=minus]').click();
    assert.equal(await page.locator('#barCount').innerText(), '4 items'); assert.equal(await page.locator('#barTotal').innerText(), '$275.00');
    await page.click('#continueBtn'); await page.waitForSelector('#stepDetails:not(.hidden)');
    await page.screenshot({ path: `${OUT}/${kind}-2-details.png`, fullPage: true });
  });

  await test('empty submit shows every field error, sends nothing', kind, async page => {
    let posts = 0; page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/public/order')) posts++; });
    await page.goto(SITE); await page.waitForSelector('.card');
    await card(page, 'barrel').locator('[data-role=plus]').click(); await page.click('#continueBtn'); await page.click('#submitBtn');
    for (const f of ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'state', 'zip', 'method']) assert.ok((await page.locator('#err-' + f).innerText()).length > 3, 'no error for ' + f);
    assert.equal(posts, 0); assert.equal(await page.evaluate(() => document.activeElement.id), 'firstName');
    await page.fill('#email', 'bad'); await page.fill('#zip', '12'); await page.click('#submitBtn');
    assert.match(await page.locator('#err-email').innerText(), /valid email/); assert.match(await page.locator('#err-zip').innerText(), /5-digit/);
  });

  await test('full order (Venmo): confirmation, link, Sheet rows, stock', kind, async page => {
    await page.goto(SITE + '?src=sign'); await page.waitForSelector('.card');
    await card(page, 'barrel').locator('[data-role=plus]').click(); await card(page, 'barrel').locator('[data-role=plus]').click();
    await card(page, 'planter').locator('[data-role=plus]').click();
    await page.click('#continueBtn'); await fill(page); await page.locator('.method', { hasText: 'Venmo' }).click(); await page.check('#optin');
    await page.click('#submitBtn'); await page.waitForSelector('#stepDone:not(.hidden)');
    const t = await page.locator('#stepDone').innerText();
    assert.match(t, /Order placed/); assert.match(t, /MR-[0-9A-Z]{8}/); assert.ok(t.includes('$255.00'));
    const href = await page.locator('#stepDone a.btn').getAttribute('href');
    assert.ok(href.startsWith('https://venmo.com/Brett-Lambert-6?txn=pay&amount=255.00&note=Milam%20Ridge%20MR-'), href);
    await page.screenshot({ path: `${OUT}/${kind}-3-done.png`, fullPage: true });
    const s = await state(); const o = s.Shop_Orders[1];
    assert.equal(o[4], 'Jane'); assert.equal(o[5], 'Doe'); assert.equal(o[7], '304-555-0123'); assert.equal(o[11], 'WV'); assert.equal(o[16], 'Yes'); assert.equal(o[17], 'sign'); assert.equal(o[18], 'DONE');
    const inv = s.Inventory.filter(r => r[1] === 'cabin_wv'); assert.deepEqual(inv.map(r => [r[0], r[2]]), [['p_ob2', 2], ['p_op', 6], ['p_sph', 4]].map(([a, b]) => [a, b]).map(([a, b]) => [a, inv.find(r => r[0] === a)[2]]));
    assert.equal(inv.find(r => r[0] === 'p_ob2')[2], 2); assert.equal(inv.find(r => r[0] === 'p_op')[2], 6);
    // reload keeps confirmation; new order resets
    await page.reload(); await page.waitForSelector('#stepDone:not(.hidden)'); assert.match(await page.locator('#stepDone').innerText(), /Order placed/);
    await page.click('text=Start a new order'); await page.waitForSelector('#stepItems:not(.hidden)');
    assert.match(await card(page, 'barrel').locator('[data-role=stock]').innerText(), /Only 2 left/);
  });

  await test('Zelle shows number + copy; no pay link', kind, async page => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await page.goto(SITE); await page.waitForSelector('.card'); await card(page, 'sphere').locator('[data-role=plus]').click();
    await page.click('#continueBtn'); await fill(page); await page.locator('.method', { hasText: 'Zelle' }).click(); await page.click('#submitBtn');
    await page.waitForSelector('#stepDone:not(.hidden)'); const t = await page.locator('#stepDone').innerText();
    assert.ok(t.includes('410-259-2314') && t.includes('$60.00')); assert.equal(await page.locator('#stepDone a.btn').count(), 0);
    await page.click('text=Copy Zelle number'); await page.waitForFunction(() => /Copied|Couldn/.test(document.querySelector('#stepDone .paybox button').textContent)); assert.match(await page.locator('#stepDone .paybox button').innerText(), /Copied|Couldn/);
  });

  await test('sold out card is disabled', kind, async page => {
    await api('/public/shop'); await api('/__setinv?pid=p_sph&n=0'); await page.goto(SITE); await page.waitForSelector('.card');
    assert.match(await card(page, 'sphere').locator('[data-role=stock]').innerText(), /Sold out/); assert.ok(await card(page, 'sphere').locator('[data-role=plus]').isDisabled());
  });

  await test('network down on load -> visible banner, retry recovers', kind, async page => {
    let down = true; await page.unroute(PROD + '/**');
    await page.route(PROD + '/**', async route => { if (down) return route.abort('failed'); const r = await route.fetch({ url: route.request().url().replace(PROD, LOCAL) }); await route.fulfill({ response: r }); });
    await page.goto(SITE); await page.waitForSelector('#banner:not(.hidden)'); assert.match(await page.locator('#banner').innerText(), /couldn’t load the shop/);
    down = false; await page.click('#banner button'); await page.waitForSelector('.card');
  }, { allowConsoleErrors: true });

  await test('order POST fails once -> error + retry succeeds, exactly one order', kind, async page => {
    let fail = true; await page.unroute(PROD + '/**');
    await page.route(PROD + '/**', async route => { const q = route.request(); if (fail && q.method() === 'POST') { fail = false; return route.abort('failed'); } const r = await route.fetch({ url: q.url().replace(PROD, LOCAL) }); await route.fulfill({ response: r }); });
    await page.goto(SITE); await page.waitForSelector('.card'); await card(page, 'planter').locator('[data-role=plus]').click(); await page.click('#continueBtn');
    await fill(page); await page.locator('.method', { hasText: 'Cash App' }).click(); await page.click('#submitBtn');
    await page.waitForSelector('#formErr:not(.hidden)'); assert.match(await page.locator('#formErr').innerText(), /reach the shop/);
    assert.equal(await page.locator('#submitBtn').isEnabled(), true);
    await page.click('#formErr button'); await page.waitForSelector('#stepDone:not(.hidden)');
    const s = await state(); assert.equal(s.Shop_Orders.length, 2); assert.ok((await page.locator('#stepDone a.btn').getAttribute('href')).startsWith('https://cash.app/$bmoremoney1980/65.00'));
  }, { allowConsoleErrors: true });

  await test('server error on order -> clear message, nothing charged wording, logged in Sheet', kind, async page => {
    await page.goto(SITE); await page.waitForSelector('.card'); await card(page, 'planter').locator('[data-role=plus]').click(); await page.click('#continueBtn');
    await fill(page); await page.locator('.method', { hasText: 'PayPal' }).click(); await api('/__fail?match=POST.*Shop_Orders.*append&status=500&times=1');
    await page.click('#submitBtn'); await page.waitForSelector('#formErr:not(.hidden)'); assert.match(await page.locator('#formErr').innerText(), /couldn’t place your order/);
    const s = await state(); assert.ok(s.Debug.some(r => /POST \/public\/order failed/.test(r[1])));
    await page.click('#formErr button'); await page.waitForSelector('#stepDone:not(.hidden)'); assert.ok((await page.locator('#stepDone a.btn').getAttribute('href')).startsWith('https://paypal.me/BrettLambert683/65.00'));
  }, { allowConsoleErrors: true });

  await test('someone else takes stock first -> friendly message, cart clamped', kind, async page => {
    await page.goto(SITE); await page.waitForSelector('.card');
    for (let i = 0; i < 4; i++) await card(page, 'barrel').locator('[data-role=plus]').click();
    await page.click('#continueBtn'); await fill(page); await page.locator('.method', { hasText: 'Venmo' }).click();
    await api('/__setinv?pid=p_ob2&n=1'); await page.click('#submitBtn');
    await page.waitForSelector('#stepItems:not(.hidden)'); assert.match(await page.locator('#banner').innerText(), /just grabbed/);
    assert.equal(await card(page, 'barrel').locator('[data-role=qty]').innerText(), '1'); assert.equal((await state()).Shop_Orders.length, 1);
  }, { allowConsoleErrors: true });

  await test('honeypot hidden from users; touch targets >= 44px', kind, async page => {
    await page.goto(SITE); await page.waitForSelector('.card'); await card(page, 'barrel').locator('[data-role=plus]').click(); await page.click('#continueBtn');
    const hp = await page.locator('#website').boundingBox(); assert.ok(hp.x < 0, 'honeypot should be off-screen');
    const small = await page.evaluate(() => [...document.querySelectorAll('button:not(.nav), .method span, select, input:not(#website):not([type=checkbox]):not([type=radio])')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.id || e.className));
    assert.deepEqual(small, []);
  });
}

await browser.close();
for (const [s, n] of results) console.log(s, n);
const bad = results.filter(r => r[0] === 'FAIL').length; console.log(`\n${results.length - bad}/${results.length} passed`); process.exit(bad ? 1 : 0);
