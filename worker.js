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
        await clearDebugApp(env, token, body.app);
      }
      return json({ ok: true });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  }
};

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

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function getSheetToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = btoa(JSON.stringify({
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
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();
  return data.access_token;
}

async function importPrivateKey(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function readSheet(env, token, tab) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.json();
}

async function appendRow(env, token, tab, values) {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(tab)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    }
  );
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
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[count, ts, v]] }),
      }
    );
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
    await deleteRow(env, token, toDelete[i]);
  }
}

async function clearDebugApp(env, token, app) {
  const data = await readSheet(env, token, 'Debug');
  const rows = data.values || [];
  const toDelete = [];
  rows.forEach((r, i) => { if (i > 0 && r[0] === app) toDelete.push(i); });
  for (let i = toDelete.length - 1; i >= 0; i--) {
    await deleteRow(env, token, toDelete[i]);
  }
}

async function deleteRow(env, token, rowIndex) {
  // rowIndex is 0-based array index; sheet row = rowIndex + 1
  // We need the sheet's spreadsheet ID and a batchUpdate to delete by index
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: 0, // 0=first sheet tab; update if Wishlist/Debug tabs are not tab index 0
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            }
          }
        }]
      }),
    }
  );
}
