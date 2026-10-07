// ─────────────────────────────────────────────────────────────────────────────
// BarrelCo Cloudflare Worker
// Repo: https://github.com/brett332/BarrelCo
// Handles: StockShift inventory/history, Wishlist/Debug for all 3 apps,
//          ListingForge AI proxy
//
// ENV VARS to set in Cloudflare dashboard:
//   ANTHROPIC_API_KEY  — your Anthropic key
//   SHEET_ID           — Google Sheet ID (BarrelCo sheet)
//   SERVICE_ACCOUNT_EMAIL — service account email
//   SERVICE_ACCOUNT_KEY   — service account private key (PEM, paste full value)
//
// NEW (Oct 2026): /public/shop (GET) + /public/order (POST) — Milam Ridge cabin
// order site (Ridge-Co/RidgeCo shop/). Backed by Sheet tabs Shop_Products,
// Shop_Settings, Shop_Orders (auto-created on first use) and linked to the
// StockShift Inventory/History tabs (location id 'cabin_wv'). Every Sheets
// call on that path is status-checked and every failure is logged to the
// Debug tab (app='shop') and returned to the caller — nothing fails silently.
//
// NEW: /public/entities-feed — cross-hub integration contract for BrettOS.
// Deliberate, versioned, external-facing contract — internal routes/schema
// above can change freely; only a breaking change to THIS shape requires
// bumping `version`.
// ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-secret',
};

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // Never swallow: log the real error and return it (as JSON) so callers
      // and the UI can show "needs attention" instead of a silent failure.
      console.error('barrel-co unhandled error:', err && err.stack || err);
      return json({ ok: false, error: 'server_error', detail: String(err && err.message || err).slice(0, 300) }, 500);
    }
  }
};

async function handleRequest(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // ── ANTHROPIC PROXY (ListingForge) ──────────────────────────────────────
    if (path === '/ai') {
      const body = await request.json();
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── SHEETS ROUTES ────────────────────────────────────────────────────────
    const token = await getSheetToken(env);

    // ── MILAM RIDGE CABIN SHOP ───────────────────────────────────────────────
    if (path === '/public/shop' && request.method === 'GET') {
      return await shopGet(env, token);
    }
    if (path === '/public/order' && request.method === 'POST') {
      return await shopOrder(request, env, token);
    }

    if (path === '/public/entities-feed' && request.method === 'GET') {
      return await getEntitiesFeed(env, token);
    }

    if (path === '/inventory' && request.method === 'GET') {
      const data = await readSheet(env, token, 'Inventory');
      return json(data);
    }

    if (path === '/inventory' && request.method === 'POST') {
      const body = await request.json();
      await writeInventory(env, token, body);
      return json({ ok: true });
    }

    if (path === '/history' && request.method === 'GET') {
      const data = await readSheet(env, token, 'History');
      return json(data);
    }

    if (path === '/history' && request.method === 'POST') {
      const body = await request.json();
      await appendRow(env, token, 'History', historyRow(body));
      return json({ ok: true });
    }

    if (path === '/wishlist' && request.method === 'GET') {
      const app = url.searchParams.get('app') || 'lf';
      const data = await readSheet(env, token, 'Wishlist');
      const rows = (data.values || []).slice(1).filter(r => r[0] === app);
      return json(rows.map(r => ({ app: r[0], id: r[1], text: r[2], done: r[3] === 'TRUE', ts: r[4] })));
    }

    if (path === '/wishlist' && request.method === 'POST') {
      const body = await request.json();
      if (body.action === 'add') {
        await appendRow(env, token, 'Wishlist', [body.app, body.id, body.text, 'FALSE', body.ts]);
      } else if (body.action === 'toggle') {
        await updateWishlistDone(env, token, body.id, body.done);
      } else if (body.action === 'clearDone') {
        await clearDoneWishlist(env, token, body.app);
      }
      return json({ ok: true });
    }

    if (path === '/debug' && request.method === 'GET') {
      const app = url.searchParams.get('app') || 'lf';
      const data = await readSheet(env, token, 'Debug');
      const rows = (data.values || []).slice(1).filter(r => r[0] === app);
      return json(rows.map(r => ({ app: r[0], msg: r[1], ts: r[2] })));
    }

    if (path === '/debug' && request.method === 'POST') {
      const body = await request.json();
      if (body.action === 'log') {
        await appendRow(env, token, 'Debug', [body.app, body.msg, body.ts]);
      } else if (body.action === 'clear') {
        if (body.app === 'shop') return json({ ok: false, error: 'shop log cannot be cleared here' }, 403);
        await clearDebugApp(env, token, body.app);
      }
      return json({ ok: true });
    }

    return new Response('Not found', { status: 404, headers: CORS });
}

// ── CROSS-HUB ENTITY FEED (BrettOS integration) ─────────────────────────────
// GET /public/entities-feed
//
// HONEST CAVEAT: BarrelCo's Inventory tab only stores ProductId, LocationId,
// Count, LastUpdated — there's no dedicated product-name/catalog tab. This
// derives a display name for each product from the most recent History entry
// referencing that ProductId (productCode/listingCode columns). That's a
// best-effort mapping, not a guaranteed-accurate one — products with no
// History yet will just show their raw ProductId. Worth eyeballing the first
// sync result in BrettOS before trusting it for AI linking.
async function getEntitiesFeed(env, token) {
  const [invData, histData] = await Promise.all([
    readSheet(env, token, 'Inventory'),
    readSheet(env, token, 'History'),
  ]);

  const invRows = (invData.values || []).slice(1);   // ProductId, LocationId, Count, LastUpdated
  const histRows = (histData.values || []).slice(1); // id, ts, type, productId, productCode, locationId, listingCode, locationName, qty, newTotal, salePrice, revenue, note

  // Most recent productCode/listingCode per ProductId, used as the display name
  // fallback since Inventory itself has no name field.
  const nameMap = {};
  histRows.forEach(r => {
    const pid = r[3], productCode = r[4], listingCode = r[6];
    if (pid && !nameMap[pid]) nameMap[pid] = productCode || listingCode || pid;
  });

  const uniqueProductIds = [...new Set(invRows.map(r => r[0]).filter(Boolean))];
  const listings = uniqueProductIds.map(pid => {
    const name = nameMap[pid] || pid;
    return {
      id: pid,
      name,
      aliases: [String(pid).toLowerCase(), String(name).toLowerCase()].filter(Boolean),
    };
  });

  return json({ version: 1, generated_at: new Date().toISOString(), listings });
}

// ── SHEET HELPERS ─────────────────────────────────────────────────────────────

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Google requires JWT segments in base64url (no +, /, or = padding). Plain btoa()
// output is rejected with "Invalid signature for token".
function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getSheetToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: env.SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const unsigned = `${header}.${claim}`;
  const key = await importPrivateKey(env.SERVICE_ACCOUNT_KEY);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error('Google token request failed: ' + String(data.error_description || data.error || resp.status).slice(0, 200));
  }
  return data.access_token;
}

// Accepts the key however it got pasted into the dashboard: real PEM, PEM with
// literal "\n" sequences (copied out of the JSON key file), wrapped in quotes,
// or the whole service-account JSON. Fails with a clear message otherwise.
async function importPrivateKey(pem) {
  let k = String(pem || '').trim();
  if (!k) throw new Error('SERVICE_ACCOUNT_KEY is empty or not set');
  if (k.startsWith('{')) {
    try { k = String(JSON.parse(k).private_key || ''); }
    catch (e) { throw new Error('SERVICE_ACCOUNT_KEY looks like JSON but could not be parsed: ' + e.message); }
  }
  k = k.replace(/^["']+|["']+$/g, '').replace(/\\n/g, '\n');
  const b64 = k.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  let der;
  try { der = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }
  catch (e) { throw new Error('SERVICE_ACCOUNT_KEY is not a valid PEM private key (could not base64-decode it)'); }
  try {
    return await crypto.subtle.importKey('pkcs8', der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (e) { throw new Error('SERVICE_ACCOUNT_KEY is not a valid PEM private key (' + e.message + ')'); }
}

async function readSheet(env, token, tab) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.json();
}

// Status-checked Sheets call. Throws (with the Sheets error text) on any non-2xx
// so a failed write can never look like a success.
async function sheetsFetch(env, token, url, opts, what) {
  const o = opts || {};
  const resp = await fetch(url, { ...o, headers: { Authorization: `Bearer ${token}`, ...(o.headers || {}) } });
  const text = await resp.text();
  if (!resp.ok) {
    const e = new Error(`${what}: Sheets ${resp.status} ${text.slice(0, 300)}`);
    e.status = resp.status; e.body = text;
    throw e;
  }
  try { return text ? JSON.parse(text) : {}; }
  catch (_) { throw new Error(`${what}: unreadable Sheets response`); }
}

async function appendRow(env, token, tab, values, raw) {
  const mode = raw ? 'RAW' : 'USER_ENTERED';
  return sheetsFetch(env, token,
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}:append?valueInputOption=${mode}&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) },
    `append ${tab}`);
}

async function writeInventory(env, token, { pid, lid, count, ts, venture }) {
  const v = venture || 'barrelco';
  // Read current inventory to find existing row or append
  const data = await readSheet(env, token, 'Inventory');
  const rows = data.values || [];
  // rows[0] = header: ProductId, LocationId, Count, LastUpdated, Venture
  let rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === pid && r[1] === lid && (r[4] || 'barrelco') === v);
  if (rowIdx === -1) {
    await appendRow(env, token, 'Inventory', [pid, lid, count, ts, v]);
  } else {
    const range = `Inventory!C${rowIdx + 1}:E${rowIdx + 1}`;
    await sheetsFetch(env, token,
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[count, ts, v]] }) },
      'update Inventory');
  }
}

function historyRow(e) {
  return [e.id, e.ts, e.type, e.productId, e.productCode, e.locationId,
    e.listingCode, e.locationName, e.qty, e.newTotal, e.salePrice, e.revenue, e.note || '', e.venture || 'barrelco'];
}

async function updateWishlistDone(env, token, id, done) {
  const data = await readSheet(env, token, 'Wishlist');
  const rows = data.values || [];
  const rowIdx = rows.findIndex((r, i) => i > 0 && r[1] === String(id));
  if (rowIdx === -1) return;
  const range = `Wishlist!D${rowIdx + 1}`;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[done ? 'TRUE' : 'FALSE']] }),
    }
  );
}

async function clearDoneWishlist(env, token, app) {
  const data = await readSheet(env, token, 'Wishlist');
  const rows = data.values || [];
  // Collect row numbers (1-indexed) to delete (done=TRUE for this app), process in reverse
  const toDelete = [];
  rows.forEach((r, i) => { if (i > 0 && r[0] === app && r[3] === 'TRUE') toDelete.push(i); });
  for (let i = toDelete.length - 1; i >= 0; i--) {
    await deleteRow(env, token, 'Wishlist', toDelete[i]);
  }
}

async function clearDebugApp(env, token, app) {
  const data = await readSheet(env, token, 'Debug');
  const rows = data.values || [];
  const toDelete = [];
  rows.forEach((r, i) => { if (i > 0 && r[0] === app) toDelete.push(i); });
  for (let i = toDelete.length - 1; i >= 0; i--) {
    await deleteRow(env, token, 'Debug', toDelete[i]);
  }
}

async function deleteRow(env, token, tab, rowIndex) {
  // rowIndex is 0-based array index; sheet row = rowIndex + 1.
  // Looks up the tab's REAL sheetId (this used to hard-code 0, which deleted
  // rows from whatever tab happened to be first) and status-checks the call.
  const meta = await sheetsFetch(env, token,
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}?fields=sheets.properties`, {}, 'sheet metadata');
  const sheet = (meta.sheets || []).find(x => x.properties && x.properties.title === tab);
  if (!sheet) throw new Error(`deleteRow: tab "${tab}" not found`);
  await sheetsFetch(env, token,
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}:batchUpdate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ deleteDimension: { range: {
        sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 } } }] }) },
    `delete row ${tab}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// MILAM RIDGE CABIN SHOP  (GET /public/shop, POST /public/order)
// ═════════════════════════════════════════════════════════════════════════════
// Sheet tabs (auto-created with seed data on first use; edit prices/photos/text
// directly in the Sheet — no code change needed):
//   Shop_Products : what is for sale (price, photos, StockProductId link)
//   Shop_Settings : shop name, open/closed switch, payment handles, notes
//   Shop_Orders   : every order, one row each (Status / StockStatus columns)
// Stock lives in the existing StockShift `Inventory` tab at location 'cabin_wv'
// — an order decrements it and writes a 'sold' History row, so StockShift and
// the shop always agree.

const SHOP_LOC = 'cabin_wv';
const SHOP_LOC_NAME = 'Cabin (Milam Ridge WV)';
const SHOP_VENTURE = 'barrelco';
const SHOP_MAX_QTY_PER_LINE = 10;
const SHOP_HOURLY_ORDER_CAP = 12;   // circuit breaker against bot stock-drain

const SHOP_HEADERS = {
  Shop_Products: ['Id', 'Name', 'Price', 'Description', 'Photos', 'Active', 'SortOrder', 'StockProductId', 'StockCode'],
  Shop_Settings: ['Key', 'Value'],
  Shop_Orders: ['OrderId', 'Token', 'Timestamp', 'Status', 'FirstName', 'LastName', 'Email', 'Phone',
    'Address1', 'Address2', 'City', 'State', 'Zip', 'Items', 'Subtotal', 'PaymentMethod',
    'MarketingOptIn', 'Source', 'StockStatus', 'Notes'],
};

const SHOP_SEED = {
  Shop_Products: [
    ['barrel', 'Whiskey Barrel (Full Size)', 95, 'Full-size whiskey barrel.',
      'img/barrel-1.jpg,img/barrel-2.jpg,img/barrel-3.jpg', 'TRUE', 1, 'p_ob2', 'OB2'],
    ['planter', 'Whiskey Barrel Planter', 65, 'Half-barrel planter made from a real whiskey barrel.',
      'img/planter-1.jpg,img/planter-2.jpg,img/planter-3.jpg', 'TRUE', 2, 'p_op', 'OP'],
    ['sphere', 'Barrel Sphere', 60, 'Rustic sphere made from steel barrel hoops, with a hanging ring.',
      'img/sphere-1.jpg,img/sphere-2.jpg,img/sphere-3.jpg', 'TRUE', 3, 'p_sph', 'SPH'],
  ],
  Shop_Settings: [
    ['ShopName', 'Milam Ridge'],
    ['Tagline', 'Whiskey barrels, planters & spheres — right here at the cabin'],
    ['Open', 'TRUE'],
    ['PickupNote', 'Pick up your items at the cabin after you send payment.'],
    ['ContactPhone', '410-259-2314'],
    ['EnabledMethods', 'venmo,cashapp,paypal,zelle'],
    ['VenmoHandle', 'Brett-Lambert-6'],
    ['CashAppHandle', 'bmoremoney1980'],
    ['PayPalHandle', 'BrettLambert683'],
    ['ZelleNumber', '410-259-2314'],
  ],
};
// Starting cabin stock, written to the Inventory tab ONLY when the Shop_Products
// tab is first created and no row exists yet for that product at the cabin.
const SHOP_SEED_STOCK = { p_ob2: 4, p_op: 7, p_sph: 4 };

const SHOP_METHODS = [
  { id: 'venmo', label: 'Venmo', setting: 'VenmoHandle' },
  { id: 'cashapp', label: 'Cash App', setting: 'CashAppHandle' },
  { id: 'paypal', label: 'PayPal', setting: 'PayPalHandle' },
  { id: 'zelle', label: 'Zelle', setting: 'ZelleNumber' },
];

const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

// ── sheet plumbing (strict: every call status-checked) ──────────────────────
function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

async function shopLog(env, token, msg) {
  console.error('[shop]', msg);
  try { await appendRow(env, token, 'Debug', ['shop', String(msg).slice(0, 900), new Date().toISOString()], true); }
  catch (e) { console.error('[shop] could not write Debug row:', e && e.message); } // last resort: Worker logs
}

async function strictRead(env, token, tab) {
  const data = await sheetsFetch(env, token,
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}`,
    {}, `read ${tab}`);
  return data.values || [];
}

// Appends several rows in ONE call so a seed is all-or-nothing (a failure can
// never leave a half-filled tab).
async function appendRows(env, token, tab, rows) {
  return sheetsFetch(env, token,
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows }) },
    `append ${tab}`);
}

async function createShopTab(env, token, tab) {
  try {
    await sheetsFetch(env, token,
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}:batchUpdate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) },
      `create tab ${tab}`);
  } catch (e) {
    if (/already exists/i.test(e.body || '')) return false;   // another request created it first
    throw e;
  }
  await seedShopTab(env, token, tab);
  return true;
}

// Writes header + starter rows into an EMPTY tab (also used to heal a tab that
// was created but never seeded because an earlier request failed midway).
async function seedShopTab(env, token, tab) {
  await appendRows(env, token, tab, [SHOP_HEADERS[tab]].concat(SHOP_SEED[tab] || []));
  if (tab === 'Shop_Products') {
    const inv = await strictRead(env, token, 'Inventory');
    const rows = [];
    for (const row of SHOP_SEED.Shop_Products) {
      const pid = row[7];
      const has = inv.some((r, i) => i > 0 && r[0] === pid && r[1] === SHOP_LOC && (r[4] || 'barrelco') === SHOP_VENTURE);
      if (!has) rows.push([pid, SHOP_LOC, SHOP_SEED_STOCK[pid] || 0, new Date().toISOString(), SHOP_VENTURE]);
    }
    if (rows.length) await appendRows(env, token, 'Inventory', rows);
  }
}

// Reads a shop tab as header-keyed objects, creating+seeding it if missing.
async function readShopTab(env, token, tab) {
  let values;
  try { values = await strictRead(env, token, tab); }
  catch (e) {
    if (e.status === 400 && /Unable to parse range/i.test(e.body || '')) {
      await createShopTab(env, token, tab);
      values = await strictRead(env, token, tab);
    } else throw e;
  }
  if (!values.length) {            // tab exists but is empty: another request may be mid-seed — wait, then heal
    await new Promise(r => setTimeout(r, 1500));
    values = await strictRead(env, token, tab);
    if (!values.length) {
      await seedShopTab(env, token, tab);
      values = await strictRead(env, token, tab);
    }
  }
  const header = (values[0] || []).map(h => String(h).trim());
  const need = SHOP_HEADERS[tab];
  const missing = need.filter(h => !header.includes(h));
  if (!header.length || missing.length) throw new Error(`${tab} is missing column(s): ${missing.join(', ') || 'all'}`);
  const rows = values.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    header.forEach((h, c) => { o[h] = r[c] === undefined ? '' : String(r[c]); });
    return o;
  });
  return { header, rows };
}

function parsePrice(v) {
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function cleanPhotos(v) {
  return String(v || '').split(/[,\n]/).map(x => x.trim()).filter(x =>
    x && !x.includes('..') && (/^https:\/\/[^\s"'<>]+$/.test(x) || /^[A-Za-z0-9_\-./]+$/.test(x)));
}

async function loadShop(env, token) {
  const prods = await readShopTab(env, token, 'Shop_Products');
  const sets = await readShopTab(env, token, 'Shop_Settings');
  const inv = await strictRead(env, token, 'Inventory');
  const ids = prods.rows.map(r => r.Id.trim()).filter(Boolean);
  const dupId = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dupId) throw new Error(`Shop_Products has a duplicate Id "${dupId}"`);
  const settings = {};
  sets.rows.forEach(r => { if (r.Key) settings[r.Key.trim()] = r.Value.trim(); });
  const products = prods.rows
    .filter(r => r.Id && /^(true|yes|1)$/i.test(r.Active.trim()))
    .sort((a, b) => (parseFloat(a.SortOrder) || 999) - (parseFloat(b.SortOrder) || 999))
    .map(r => {
      const invRow = inv.find((x, i) => i > 0 && x[0] === r.StockProductId.trim() && x[1] === SHOP_LOC && (x[4] || 'barrelco') === SHOP_VENTURE);
      const stock = invRow ? Math.max(0, parseInt(invRow[2]) || 0) : 0;
      const price = parsePrice(r.Price);
      return {
        id: r.Id.trim(), name: r.Name.trim(), price, description: r.Description.trim(),
        photos: cleanPhotos(r.Photos), stockPid: r.StockProductId.trim(), stockCode: r.StockCode.trim(),
        stock, hasStockRow: !!invRow, invRowNum: invRow ? inv.indexOf(invRow) + 1 : null,
      };
    });
  return { products, settings, inv };
}

function enabledMethods(settings) {
  const on = String(settings.EnabledMethods || '').toLowerCase().split(',').map(x => x.trim());
  return SHOP_METHODS.filter(m => on.includes(m.id) && (settings[m.setting] || '').trim())
    .map(m => ({ id: m.id, label: m.label, handle: settings[m.setting].trim() }));
}

// ── GET /public/shop ────────────────────────────────────────────────────────
async function shopGet(env, token) {
  try {
    const { products, settings } = await loadShop(env, token);
    return json({
      ok: true,
      shop: {
        name: settings.ShopName || 'Milam Ridge',
        tagline: settings.Tagline || '',
        open: /^(true|yes|1)$/i.test(settings.Open || ''),
        pickupNote: settings.PickupNote || '',
        contactPhone: settings.ContactPhone || '',
      },
      methods: enabledMethods(settings),
      products: products.map(p => ({
        id: p.id, name: p.name, price: p.price, description: p.description, photos: p.photos,
        available: p.price === null || !p.hasStockRow ? 0 : Math.min(p.stock, SHOP_MAX_QTY_PER_LINE),
        unavailableReason: p.price === null ? 'price' : (!p.hasStockRow ? 'stock_link' : null),
      })),
    });
  } catch (e) {
    await shopLog(env, token, 'GET /public/shop failed: ' + e.message);
    return json({ ok: false, error: 'shop_unavailable' }, 500);
  }
}

// ── POST /public/order ──────────────────────────────────────────────────────
function originAllowed(origin, env) {
  if (!origin) return false;
  const extra = String(env.SHOP_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  return origin === 'https://ridge-co.github.io' || extra.includes(origin) ||
    (env.SHOP_ALLOW_LOCALHOST === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
}

function cleanText(v, max) {
  let s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[=+\-@]+\s*/, '');            // no spreadsheet-formula starts
  return s.slice(0, max);
}
function fixCase(s) { return (s.length > 1 && (s === s.toLowerCase() || s === s.toUpperCase())) ? s.toLowerCase().replace(/(^|[\s'\-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s; }

function validateOrder(b, methods) {
  const err = (field, message) => ({ error: { field, message } });
  if (!b || typeof b !== 'object') return err('form', 'Bad request.');
  const c = b.customer || {};
  const firstName = fixCase(cleanText(c.firstName, 60));
  const lastName = fixCase(cleanText(c.lastName, 60));
  if (!firstName) return err('firstName', 'Please enter your first name.');
  if (!lastName) return err('lastName', 'Please enter your last name.');
  const email = cleanText(c.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return err('email', 'Please enter a valid email address.');
  let digits = String(c.phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length !== 10) return err('phone', 'Please enter a 10-digit phone number.');
  const phone = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  const address1 = cleanText(c.address1, 100);
  if (!address1) return err('address1', 'Please enter your billing address.');
  const address2 = cleanText(c.address2, 100);
  const city = fixCase(cleanText(c.city, 60));
  if (!city) return err('city', 'Please enter your city.');
  const state = cleanText(c.state, 2).toUpperCase();
  if (!US_STATES.has(state)) return err('state', 'Please choose your state.');
  const zip = cleanText(c.zip, 10);
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return err('zip', 'Please enter a 5-digit ZIP code.');
  const method = String(b.method || '');
  if (!methods.some(m => m.id === method)) return err('method', 'Please choose how you will pay.');
  const token = String(b.orderToken || '');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(token)) return err('form', 'Bad request (order token).');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 10) return err('items', 'Please choose at least one item.');
  const seen = new Set(); const items = [];
  for (const it of b.items) {
    const id = String(it && it.id || '');
    const qty = Number(it && it.qty);
    if (!id || seen.has(id) || !Number.isInteger(qty) || qty < 1 || qty > SHOP_MAX_QTY_PER_LINE) return err('items', 'Please check your item quantities.');
    seen.add(id); items.push({ id, qty });
  }
  const optIn = b.marketingOptIn === true ? 'Yes' : 'No';
  const source = cleanText(b.source, 30).replace(/[^A-Za-z0-9_\-]/g, '');
  return { ok: { firstName, lastName, email, phone, address1, address2, city, state, zip, method, token, items, optIn, source } };
}

function parseItemsText(txt) {
  return String(txt || '').split('; ').filter(Boolean).map(t => {
    const m = /^(\d+) x (.+) @ \$[\d.]+ = \$([\d.]+)$/.exec(t);
    return m ? { qty: parseInt(m[1]), name: m[2], total: parseFloat(m[3]) } : { qty: 0, name: t, total: 0 };
  });
}
function newOrderId(existing) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let n = 0; n < 20; n++) {
    const b = crypto.getRandomValues(new Uint8Array(8));
    const id = 'MR-' + Array.from(b, x => A[x % A.length]).join('');
    if (!existing.has(id)) return id;
  }
  throw new Error('could not generate a unique order id');
}

async function shopOrder(request, env, token) {
  const origin = request.headers.get('Origin');
  if (!originAllowed(origin, env)) {
    console.error(`[shop] order rejected: origin not allowed (${origin || 'none'})`);   // Worker log only: forged hits must not flood the Sheet
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  const raw = await request.text();
  if (raw.length > 8000) return json({ ok: false, error: 'too_large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }

  // Honeypot: real people never fill this hidden field (but autofill sometimes does,
  // so the answer is a visible error, never a fake confirmation).
  if (body && typeof body.website === 'string' && body.website.trim()) {
    console.error('[shop] order blocked: honeypot filled');
    return json({ ok: false, error: 'blocked', message: 'Something looked off with that form. Please reload and try again, or text Brett.' }, 400);
  }

  let step = 'load'; let orderRow = null; let orderHeader = null;
  const setCell = async (name, value) => {
    const col = colLetter(orderHeader.indexOf(name));
    await sheetsFetch(env, token,
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(`Shop_Orders!${col}${orderRow}`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[value]] }) },
      `update order ${name}`);
  };
  try {
    const shop = await loadShop(env, token);
    const methods = enabledMethods(shop.settings);
    if (!/^(true|yes|1)$/i.test(shop.settings.Open || '')) return json({ ok: false, error: 'closed' }, 409);

    const v = validateOrder(body, methods);
    if (v.error) return json({ ok: false, error: 'invalid', field: v.error.field, message: v.error.message }, 400);
    const o = v.ok;
    if (o.items.reduce((n, it) => n + it.qty, 0) > SHOP_MAX_QTY_PER_LINE) return json({ ok: false, error: 'invalid', field: 'items', message: `Please order ${SHOP_MAX_QTY_PER_LINE} items or fewer at a time.` }, 400);

    step = 'read orders';
    const orders = await readShopTab(env, token, 'Shop_Orders');
    orderHeader = orders.header;
    const dup = orders.rows.find(r => r.Token === o.token);
    if (dup) {
      if (!/^(DONE|TEST)/.test(dup.StockStatus)) await shopLog(env, token, `order ${dup.OrderId} re-submitted while StockStatus="${dup.StockStatus}" — needs a look`);
      return json({ ok: true, duplicate: true, orderId: dup.OrderId, total: parseFloat(dup.Subtotal) || 0, status: dup.Status, lines: parseItemsText(dup.Items) });
    }

    const isTest = o.firstName.toUpperCase() === 'TEST' && o.lastName.toUpperCase() === 'ORDER';
    const hourAgo = Date.now() - 3600 * 1000;
    const recent = orders.rows.filter(r => r.Status !== 'TEST' && Date.parse(r.Timestamp) > hourAgo).length;
    if (!isTest && recent >= SHOP_HOURLY_ORDER_CAP) {
      await shopLog(env, token, `order rejected: hourly cap reached (${recent} orders in last hour)`);
      return json({ ok: false, error: 'busy' }, 429);
    }

    // Price + availability are decided here from the Sheet — never from the browser.
    const lines = []; const short = [];
    for (const it of o.items) {
      const p = shop.products.find(x => x.id === it.id);
      if (!p || p.price === null || !p.hasStockRow) { short.push({ id: it.id, name: p ? p.name : it.id, available: 0 }); continue; }
      if (it.qty > p.stock) { short.push({ id: p.id, name: p.name, available: p.stock }); continue; }
      lines.push({ p, qty: it.qty, lineTotal: Math.round(p.price * it.qty * 100) / 100 });
    }
    if (short.length) return json({ ok: false, error: 'stock', items: short }, 409);
    const total = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
    if (typeof body.expectedTotal === 'number' && Math.abs(body.expectedTotal - total) > 0.005)
      return json({ ok: false, error: 'price_changed', total }, 409);
    const itemsText = lines.map(l => `${l.qty} x ${l.p.name} @ $${l.p.price.toFixed(2)} = $${l.lineTotal.toFixed(2)}`).join('; ');
    const orderId = newOrderId(new Set(orders.rows.map(r => r.OrderId)));

    step = 'write order';
    const rec = {
      OrderId: orderId, Token: o.token, Timestamp: new Date().toISOString(), Status: isTest ? 'TEST' : 'New',
      FirstName: o.firstName, LastName: o.lastName, Email: o.email, Phone: o.phone,
      Address1: o.address1, Address2: o.address2, City: o.city, State: o.state, Zip: o.zip,
      Items: itemsText, Subtotal: total, PaymentMethod: o.method, MarketingOptIn: o.optIn, Source: o.source,
      StockStatus: isTest ? 'TEST (no stock change)' : 'PENDING', Notes: '',
    };
    const appended = await appendRow(env, token, 'Shop_Orders', orders.header.map(h => rec[h] === undefined ? '' : rec[h]), true);
    // ── From here the order IS recorded: nothing below may turn it into a "failed" answer. ──
    const warnings = [];
    const m = /!\$?[A-Z]+\$?(\d+)/.exec((appended.updates && appended.updates.updatedRange) || '');
    if (m) orderRow = parseInt(m[1]);
    else { warnings.push('row_unknown'); await shopLog(env, token, `order ${orderId} saved but row number not returned by Sheets (status cells will not update)`); }
    if (orderRow) {
      try {
        const back = await sheetsFetch(env, token,
          `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent('Shop_Orders!A' + orderRow + ':A' + orderRow)}`, {}, 'verify order row');
        if (!back.values || !back.values[0] || back.values[0][0] !== orderId) throw new Error('row did not contain the new order id');
      } catch (e) { warnings.push('order_verify_failed'); await shopLog(env, token, `order ${orderId} write could not be verified: ${e.message}`); }
    }

    let stockStatus = rec.StockStatus; let oversold = null;
    if (!isTest) {
      step = 'decrement stock';
      try {
        const inv = await strictRead(env, token, 'Inventory');
        const now = new Date().toISOString();
        const idxOf = l => inv.findIndex((r, i) => i > 0 && r[0] === l.p.stockPid && r[1] === SHOP_LOC && (r[4] || 'barrelco') === SHOP_VENTURE);
        const bad = [];
        for (const l of lines) {                       // check everything BEFORE changing anything
          const idx = idxOf(l);
          if (idx === -1) bad.push({ id: l.p.id, name: l.p.name, available: 0, why: `${l.p.stockPid}: no Inventory row` });
          else if ((parseInt(inv[idx][2]) || 0) < l.qty) bad.push({ id: l.p.id, name: l.p.name, available: parseInt(inv[idx][2]) || 0, why: `${l.p.stockPid}: only ${parseInt(inv[idx][2]) || 0} left, ordered ${l.qty}` });
        }
        if (bad.length) {
          oversold = bad; stockStatus = 'OVERSOLD: ' + bad.map(b => b.why).join(' | ');
          await shopLog(env, token, `order ${orderId} ${stockStatus}`);
        } else {
          for (const l of lines) {
            const idx = idxOf(l); const next = (parseInt(inv[idx][2]) || 0) - l.qty;
            await sheetsFetch(env, token,
              `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(`Inventory!C${idx + 1}:E${idx + 1}`)}?valueInputOption=RAW`,
              { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[next, now, SHOP_VENTURE]] }) },
              `update Inventory ${l.p.stockPid}`);
            inv[idx][2] = String(next);
            await appendRow(env, token, 'History', historyRow({
              id: 'h' + Date.now() + Math.floor(Math.random() * 1000), ts: now, type: 'sold',
              productId: l.p.stockPid, productCode: l.p.stockCode, locationId: SHOP_LOC,
              listingCode: `CAB-${l.p.stockCode}`, locationName: SHOP_LOC_NAME, qty: l.qty, newTotal: next,
              salePrice: l.p.price, revenue: l.lineTotal, note: `Web order ${orderId}`, venture: SHOP_VENTURE,
            }), true);
          }
          const after = await strictRead(env, token, 'Inventory');      // confirm the counts actually landed
          const problems = [];
          for (const l of lines) {
            const r = after.find((x, i) => i > 0 && x[0] === l.p.stockPid && x[1] === SHOP_LOC && (x[4] || 'barrelco') === SHOP_VENTURE);
            if (!r || (parseInt(r[2]) || 0) !== parseInt(inv[idxOf(l)][2])) problems.push(`${l.p.stockPid}: count did not verify after write`);
          }
          stockStatus = problems.length ? 'CHECK: ' + problems.join(' | ') : 'DONE';
          if (problems.length) { warnings.push('stock_check'); await shopLog(env, token, `order ${orderId} stock issue: ${problems.join(' | ')}`); }
        }
      } catch (e) {
        stockStatus = 'FAILED: ' + e.message.slice(0, 200);
        warnings.push('stock_sync_failed');
        await shopLog(env, token, `order ${orderId} stock decrement failed: ${e.message}`);
      }
      if (orderRow) {
        try {
          await setCell('StockStatus', stockStatus);
          if (oversold) await setCell('Status', 'OVERSOLD');
        } catch (e) {
          warnings.push('status_update_failed');
          await shopLog(env, token, `order ${orderId} status update failed (row left as PENDING): ${e.message}`);
        }
      }
    }
    if (oversold) return json({ ok: false, error: 'stock', items: oversold.map(b => ({ id: b.id, name: b.name, available: b.available })) }, 409);
    return json({ ok: true, duplicate: false, orderId, total, status: rec.Status, lines: lines.map(l => ({ qty: l.qty, name: l.p.name, total: l.lineTotal })), warnings });
  } catch (e) {
    await shopLog(env, token, `POST /public/order failed at "${step}": ${e.message}`);
    return json({ ok: false, error: 'order_failed', detail: step }, 500);
  }
}
