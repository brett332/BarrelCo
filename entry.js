// ─────────────────────────────────────────────────────────────────────────────
// Entry-sheet processor (Oct 2026)
//
// Brett (and his mother, for Waynesboro) type manual stock changes into an
// "Entry" tab. A cron trigger (every minute) applies each new row to the
// StockShift Inventory + History tabs and writes the outcome back into the
// row's Status / Result / Processed At cells.
//
//   Status blank        -> new, will be processed
//   Status PROCESSING   -> claimed (never re-applied; a stuck one is flagged CHECK)
//   Status OK           -> applied
//   Status ERROR: ...   -> rejected BEFORE anything was written (safe to fix and re-enter)
//   Status CHECK: ...   -> something may be half-applied — look at Inventory/History
//
// Nothing fails silently: every problem lands in the row's Status and in the
// Debug tab (app='entry').
//
// Columns are found by HEADER NAME, so the main sheet and the separate
// Waynesboro sheet (different layout) share this code.
//   Action | Location | Product | Qty | To Location | Price | Note | Status | Result | Processed At
// Status, Result, Processed At must be adjacent, in that order.
// ─────────────────────────────────────────────────────────────────────────────

const VENTURE = 'barrelco';
export const ALL_ACTIONS = ['Received', 'Sold', 'Set count', 'Transfer', 'Remove (lost/damaged)'];
const ACTION_ALIASES = {
  'received': 'Received', 'receive': 'Received', 'add': 'Received', 'in': 'Received',
  'sold': 'Sold', 'sale': 'Sold', 'sell': 'Sold',
  'set count': 'Set count', 'set': 'Set count', 'count': 'Set count', 'recount': 'Set count',
  'transfer': 'Transfer', 'move': 'Transfer',
  'remove (lost/damaged)': 'Remove (lost/damaged)', 'remove': 'Remove (lost/damaged)', 'lost': 'Remove (lost/damaged)', 'damaged': 'Remove (lost/damaged)',
};
const STUCK_MS = 10 * 60 * 1000;
const MAX_PER_RUN = 25;

const norm = s => String(s === undefined || s === null ? '' : s).trim().toLowerCase();
const cell = (r, i) => (i >= 0 && r && r[i] !== undefined && r[i] !== null) ? String(r[i]).trim() : '';
const sheetBase = id => `https://sheets.googleapis.com/v4/spreadsheets/${id}`;

async function readTab(deps, env, token, sheetId, tab) {
  const data = await deps.sheetsFetch(env, token, `${sheetBase(sheetId)}/values/${encodeURIComponent(tab)}`, {}, `read ${tab}`);
  return data.values || [];
}

async function putRange(deps, env, token, sheetId, range, values, what) {
  return deps.sheetsFetch(env, token,
    `${sheetBase(sheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }, what);
}

// Log to the Debug tab, but not the same message again within an hour (the cron
// runs every minute, so a persistent problem would otherwise flood the tab).
async function logOnce(env, token, deps, msg) {
  console.error('[entry]', msg);
  try {
    const rows = await readTab(deps, env, token, env.SHEET_ID, 'Debug');
    const cutoff = Date.now() - 3600 * 1000;
    const seen = rows.some((r, i) => i > 0 && r[0] === 'entry' && r[1] === String(msg).slice(0, 900) && Date.parse(r[2]) > cutoff);
    if (seen) return;
    await deps.appendRow(env, token, 'Debug', ['entry', String(msg).slice(0, 900), new Date().toISOString()], true);
  } catch (e) { console.error('[entry] could not write Debug row:', e && e.message); }
}

// Reads the optional Config tab (Key | Value). A missing tab just means "no extra sheets".
async function readConfig(env, token, deps) {
  let rows;
  try { rows = await readTab(deps, env, token, env.SHEET_ID, 'Config'); }
  catch (e) { if (/Unable to parse range/i.test(e.body || '')) return {}; throw e; }
  const cfg = {};
  rows.forEach((r, i) => { if (i > 0 && cell(r, 0)) cfg[cell(r, 0)] = cell(r, 1); });
  return cfg;
}

export async function runEntryProcessors(env, token, deps) {
  const targets = [{ sheetId: env.SHEET_ID, tab: 'Entry', label: 'main', allowed: ALL_ACTIONS, defaults: {} }];
  try {
    const cfg = await readConfig(env, token, deps);
    if (cfg.WaynesboroEntrySheetId) {
      targets.push({
        sheetId: cfg.WaynesboroEntrySheetId, tab: cfg.WaynesboroEntryTab || 'Sales', label: 'waynesboro',
        allowed: ['Sold'], defaults: { action: 'Sold', location: cfg.WaynesboroLocationId || 'loc_waynesboro_va' },
      });
    }
  } catch (e) { await logOnce(env, token, deps, `Config tab unreadable: ${e.message}`); }

  const report = [];
  for (const t of targets) {
    try { report.push(await processEntrySheet(env, token, deps, t)); }
    catch (e) {
      report.push({ label: t.label, error: e.message });
      await logOnce(env, token, deps, `entry sheet "${t.label}" (${t.tab}) problem: ${e.message}`);
    }
  }
  return report;
}

export async function processEntrySheet(env, token, deps, t) {
  const res = { label: t.label, ok: 0, errors: 0, checks: 0 };
  let values;
  try { values = await readTab(deps, env, token, t.sheetId, t.tab); }
  catch (e) {
    if (/Unable to parse range/i.test(e.body || '')) throw new Error(`tab "${t.tab}" not found`);
    throw e;
  }
  if (!values.length) return res;

  const header = values[0].map(norm);
  const col = n => header.indexOf(norm(n));
  const C = { action: col('Action'), loc: col('Location'), prod: col('Product'), qty: col('Qty'), to: col('To Location'),
    price: col('Price'), note: col('Note'), status: col('Status'), result: col('Result'), at: col('Processed At') };
  const need = [['prod', 'Product'], ['qty', 'Qty'], ['status', 'Status'], ['result', 'Result'], ['at', 'Processed At']];
  if (!t.defaults.action) need.push(['action', 'Action']);
  if (!t.defaults.location) need.push(['loc', 'Location']);
  const missing = need.filter(([k]) => C[k] < 0).map(([, n]) => n);
  if (missing.length) throw new Error(`missing column(s): ${missing.join(', ')}`);
  if (C.result !== C.status + 1 || C.at !== C.status + 2) throw new Error('Status, Result, Processed At must be adjacent columns in that order');

  const L = deps.colLetter;
  const writeStatus = (i, status, result, at) => putRange(deps, env, token, t.sheetId,
    `${t.tab}!${L(C.status)}${i + 1}:${L(C.at)}${i + 1}`, [[status, result, at]], `write status row ${i + 1}`);

  // 1) find work; flag claims that never finished
  const work = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const status = cell(r, C.status);
    if (status) {
      if (status === 'PROCESSING') {
        const since = Date.parse(cell(r, C.at));
        if (!Number.isFinite(since) || Date.now() - since > STUCK_MS) {
          const msg = 'CHECK: stuck while updating — compare Inventory and History before re-entering';
          await writeStatus(i, msg, '', new Date().toISOString());
          await logOnce(env, token, deps, `${t.label} row ${i + 1} stuck in PROCESSING`);
          res.checks++;
        }
      }
      continue;
    }
    if ([C.action, C.loc, C.prod, C.qty].some(ci => cell(r, ci) !== '')) work.push(i);
  }
  if (!work.length) return res;

  // 2) lookups (main sheet) — only loaded when there is something to do
  const catalog = await readTab(deps, env, token, env.SHEET_ID, 'Catalog');
  const locations = await readTab(deps, env, token, env.SHEET_ID, 'Locations');
  const cH = (catalog[0] || []).map(norm); const lH = (locations[0] || []).map(norm);
  const ci = n => cH.indexOf(norm(n)); const li = n => lH.indexOf(norm(n));
  if ([ci('ProductId'), ci('Code'), ci('Name')].some(x => x < 0)) throw new Error('Catalog tab needs ProductId, Code, Name columns');
  if ([li('LocationId'), li('Name')].some(x => x < 0)) throw new Error('Locations tab needs LocationId, Name columns');
  const findProd = txt => {
    const k = norm(txt); if (!k) return null;
    const row = catalog.slice(1).find(r => [cell(r, ci('ProductId')), cell(r, ci('Code')), cell(r, ci('Name'))].some(v => norm(v) === k));
    return row ? { id: cell(row, ci('ProductId')), code: cell(row, ci('Code')), name: cell(row, ci('Name')), retail: cell(row, ci('Cabin Shop Price')) } : null;
  };
  const findLoc = txt => {
    const k = norm(txt); if (!k) return null;
    const row = locations.slice(1).find(r => norm(cell(r, li('LocationId'))) === k || norm(cell(r, li('Name'))) === k);
    return row ? { id: cell(row, li('LocationId')), name: cell(row, li('Name')) } : null;
  };

  // 3) process rows one at a time
  for (const i of work.slice(0, MAX_PER_RUN)) {
    const r = values[i] || [];
    const rowNo = i + 1;
    const fail = async (msg) => {                       // nothing written yet
      await writeStatus(i, 'ERROR: ' + msg, '', new Date().toISOString());
      res.errors++;
    };

    const actionTxt = cell(r, C.action) || t.defaults.action || '';
    const action = ACTION_ALIASES[norm(actionTxt)];
    if (!action) { await fail(`unknown action "${actionTxt}" (use: ${t.allowed.join(', ')})`); continue; }
    if (!t.allowed.includes(action)) { await fail(`"${action}" is not allowed on this sheet (use: ${t.allowed.join(', ')})`); continue; }

    const locTxt = cell(r, C.loc) || t.defaults.location || '';
    const loc = findLoc(locTxt);
    if (!loc) { await fail(`unknown location "${locTxt}"`); continue; }
    const prodTxt = cell(r, C.prod);
    const prod = findProd(prodTxt);
    if (!prod) { await fail(`unknown product "${prodTxt}"`); continue; }

    const qtyTxt = cell(r, C.qty).replace(/,/g, '');
    if (!/^\d+$/.test(qtyTxt)) { await fail(`quantity must be a whole number (got "${cell(r, C.qty)}")`); continue; }
    const qty = parseInt(qtyTxt, 10);
    if (qty === 0 && action !== 'Set count') { await fail('quantity must be at least 1'); continue; }
    if (qty > 100000) { await fail('quantity looks too large'); continue; }

    let toLoc = null;
    if (action === 'Transfer') {
      const toTxt = cell(r, C.to);
      toLoc = findLoc(toTxt);
      if (!toLoc) { await fail(toTxt ? `unknown "To Location" "${toTxt}"` : 'Transfer needs a "To Location"'); continue; }
      if (toLoc.id === loc.id) { await fail('Transfer To Location is the same as Location'); continue; }
    }

    let price = null;
    if (action === 'Sold') {
      const pTxt = cell(r, C.price) || prod.retail;
      const p = parseFloat(String(pTxt).replace(/[$,\s]/g, ''));
      price = Number.isFinite(p) && p >= 0 ? Math.round(p * 100) / 100 : 0;
      if (cell(r, C.price) && !(Number.isFinite(p) && p >= 0)) { await fail(`price "${cell(r, C.price)}" is not a number`); continue; }
    }

    // claim the row so it can never be applied twice
    try { await writeStatus(i, 'PROCESSING', '', new Date().toISOString()); }
    catch (e) { await logOnce(env, token, deps, `${t.label} row ${rowNo}: could not claim row (nothing applied): ${e.message}`); continue; }

    let wrote = false;
    try {
      const inv = await readTab(deps, env, token, env.SHEET_ID, 'Inventory');
      const find = (pid, lid) => inv.findIndex((x, k) => k > 0 && x[0] === pid && x[1] === lid && (x[4] || VENTURE) === VENTURE);
      const countAt = (pid, lid) => { const k = find(pid, lid); return k === -1 ? 0 : (parseInt(inv[k][2], 10) || 0); };
      const cur = countAt(prod.id, loc.id);

      let next; let toCur = 0; let toNext = 0;
      if (action === 'Received') next = cur + qty;
      else if (action === 'Set count') next = qty;
      else {                                            // Sold / Remove / Transfer: never go below zero
        if (qty > cur) {
          await writeStatus(i, `ERROR: only ${cur} of ${prod.name} at ${loc.name}, can't take out ${qty} — fix the count with "Set count" first`, '', new Date().toISOString());
          res.errors++; continue;
        }
        next = cur - qty;
        if (action === 'Transfer') { toCur = countAt(prod.id, toLoc.id); toNext = toCur + qty; }
      }

      const ts = new Date().toISOString();
      const setCount = async (lid, count) => {
        const k = find(prod.id, lid);
        if (k === -1) await deps.appendRow(env, token, 'Inventory', [prod.id, lid, count, ts, VENTURE], true);
        else await putRange(deps, env, token, env.SHEET_ID, `Inventory!C${k + 1}:E${k + 1}`, [[count, ts, VENTURE]], `update Inventory ${prod.id}`);
        wrote = true;
      };
      const noteBase = [cell(r, C.note), `entry:${t.label} row ${rowNo}`].filter(Boolean).join(' · ');
      const hist = (type, l, q, newTotal, extra) => deps.appendRow(env, token, 'History', deps.historyRow({
        id: 'h' + Date.now() + Math.floor(Math.random() * 1000), ts, type, productId: prod.id, productCode: prod.code,
        locationId: l.id, listingCode: prod.code, locationName: l.name, qty: q, newTotal,
        salePrice: 0, revenue: 0, note: noteBase, venture: VENTURE, ...extra,
      }), true);

      let result;
      if (action === 'Received') { await setCount(loc.id, next); await hist('add', loc, qty, next); result = `${loc.name}: ${cur} → ${next}`; }
      else if (action === 'Set count') { await setCount(loc.id, next); await hist('edit', loc, qty, next); result = `${loc.name}: ${cur} → ${next} (set)`; }
      else if (action === 'Sold') {
        await setCount(loc.id, next);
        await hist('sold', loc, qty, next, { salePrice: price, revenue: Math.round(price * qty * 100) / 100 });
        result = `${loc.name}: ${cur} → ${next}` + (price ? ` · $${(price * qty).toFixed(2)}` : ' · no price recorded');
      } else if (action === 'Remove (lost/damaged)') { await setCount(loc.id, next); await hist('adjust', loc, qty, next); result = `${loc.name}: ${cur} → ${next} (removed)`; }
      else {
        await setCount(loc.id, next);
        await setCount(toLoc.id, toNext);
        await hist('transfer', loc, qty, next, { note: `${noteBase} · transfer to ${toLoc.name}` });
        await hist('transfer', toLoc, qty, toNext, { note: `${noteBase} · transfer from ${loc.name}` });
        result = `${loc.name}: ${cur} → ${next}; ${toLoc.name}: ${toCur} → ${toNext}`;
      }

      // confirm the counts landed
      const after = await readTab(deps, env, token, env.SHEET_ID, 'Inventory');
      const got = (lid) => { const x = after.find((y, k) => k > 0 && y[0] === prod.id && y[1] === lid && (y[4] || VENTURE) === VENTURE); return x ? parseInt(x[2], 10) : NaN; };
      const bad = [];
      if (got(loc.id) !== next) bad.push(`${loc.name} shows ${got(loc.id)}, expected ${next}`);
      if (toLoc && got(toLoc.id) !== toNext) bad.push(`${toLoc.name} shows ${got(toLoc.id)}, expected ${toNext}`);
      // Data is fully written at this point. If only the status cell fails, the row
      // stays PROCESSING (never re-applied) and is flagged as stuck after 10 minutes.
      const finish = async (st) => {
        try { await writeStatus(i, st, result, ts); return true; }
        catch (e) { await logOnce(env, token, deps, `${t.label} row ${rowNo}: applied but could not write status "${st}": ${e.message}`); return false; }
      };
      if (bad.length) {
        await logOnce(env, token, deps, `${t.label} row ${rowNo}: count did not verify: ${bad.join('; ')}`);
        await finish('CHECK: count did not verify — ' + bad.join('; '));
        res.checks++; continue;
      }
      if (await finish('OK')) res.ok++; else res.checks++;
    } catch (e) {
      const status = (wrote ? 'CHECK: partly applied — ' : 'ERROR: ') + String(e.message).slice(0, 200);
      await logOnce(env, token, deps, `${t.label} row ${rowNo}: ${status}`);
      try { await writeStatus(i, status, '', new Date().toISOString()); } catch (_) { /* row stays PROCESSING; flagged as stuck later */ }
      if (wrote) res.checks++; else res.errors++;
    }
  }
  return res;
}
