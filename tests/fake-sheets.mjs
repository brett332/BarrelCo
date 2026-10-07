// In-memory fake of the Google OAuth + Sheets v4 endpoints the Worker uses.
// Test-only. Supports: values GET/append/PUT, batchUpdate addSheet, failure injection.
import { generateKeyPairSync } from 'node:crypto';

export function makeEnv() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    SHEET_ID: 'SHEET123', SERVICE_ACCOUNT_EMAIL: 'svc@test.iam.gserviceaccount.com',
    SERVICE_ACCOUNT_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export class FakeSheets {
  constructor() {
    this.tabs = new Map();           // title -> array of rows
    this.calls = [];                 // [method, url]
    this.fail = [];                  // [{match: RegExp, status, times}]
    this.delayMs = 0;
    this.tab('Inventory', [['ProductId', 'LocationId', 'Count', 'LastUpdated', 'Venture'],
      ['p_ob2', 'bal_nl1', '9', 't', 'barrelco']]);
    this.tab('History', [['id', 'ts', 'type', 'productId', 'productCode', 'locationId', 'listingCode', 'locationName', 'qty', 'newTotal', 'salePrice', 'revenue', 'note', 'venture']]);
    this.tab('Debug', [['app', 'msg', 'ts']]);
  }
  tab(name, rows) { this.tabs.set(name, rows); return rows; }
  failNext(match, status = 500, times = 1) { this.fail.push({ match, status, times }); }
  install() {
    const self = this;
    this._orig = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => self.handle(String(url), opts);
  }
  uninstall() { globalThis.fetch = this._orig; }
  res(status, obj) { return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status }); }
  async handle(url, opts) {
    const method = (opts.method || 'GET').toUpperCase();
    this.calls.push([method, url]);
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    if (url.startsWith('https://oauth2.googleapis.com/token')) return this.res(200, { access_token: 'tok' });
    for (const f of this.fail) if (f.times > 0 && f.match.test(method + ' ' + decodeURIComponent(url))) { f.times--; return this.res(f.status, { error: { message: 'injected failure' } }); }
    const base = 'https://sheets.googleapis.com/v4/spreadsheets/SHEET123';
    if (!url.startsWith(base)) return this.res(404, 'unknown host ' + url);
    const rest = url.slice(base.length);
    if (rest.startsWith('?fields=')) return this.res(200, { sheets: [...this.tabs.keys()].map((title, i) => ({ properties: { title, sheetId: 1000 + i } })) });
    if (rest.startsWith(':batchUpdate')) {
      const body = JSON.parse(opts.body);
      for (const r of body.requests) if (r.deleteDimension) {
        const { sheetId, startIndex } = r.deleteDimension.range; const name = [...this.tabs.keys()][sheetId - 1000];
        if (!name) return this.res(400, { error: { message: 'bad sheetId' } }); this.tabs.get(name).splice(startIndex, 1);
      }
      for (const r of body.requests) if (r.addSheet) {
        const t = r.addSheet.properties.title;
        if (this.tabs.has(t)) return this.res(400, { error: { message: `A sheet with the name "${t}" already exists.` } });
        this.tabs.set(t, []);
      }
      return this.res(200, {});
    }
    const m = /^\/values\/([^?]+?)(:append)?(\?.*)?$/.exec(rest);
    if (!m) return this.res(404, 'bad path ' + rest);
    const range = decodeURIComponent(m[1]); const [tabName, cells] = range.split('!');
    if (!this.tabs.has(tabName)) return this.res(400, { error: { message: `Unable to parse range: ${range}` } });
    const rows = this.tabs.get(tabName);
    if (m[2] && method === 'POST') {
      const all = JSON.parse(opts.body).values.map(v => v.map(x => x === undefined ? '' : x));
      const first = rows.length + 1; rows.push(...all); const n = rows.length;
      const last = String.fromCharCode(64 + Math.max(1, all[0].length));
      return this.res(200, { updates: { updatedRange: `${tabName}!A${first}:${last}${n}`, updatedRows: all.length } });
    }
    if (method === 'GET') {
      if (!cells) return this.res(200, { values: rows.map(r => r.map(String)) });
      const mm = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(cells); const r0 = +mm[2] - 1; const c0 = mm[1].charCodeAt(0) - 65; const c1 = mm[3].charCodeAt(0) - 65;
      const out = []; for (let r = r0; r <= +mm[4] - 1; r++) if (rows[r]) out.push(rows[r].slice(c0, c1 + 1).map(String));
      return this.res(200, { values: out });
    }
    if (method === 'PUT') {
      const vals = JSON.parse(opts.body).values;
      const mm = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(cells);
      const r0 = +mm[2] - 1; const c0 = mm[1].charCodeAt(0) - 65;
      vals.forEach((row, ri) => row.forEach((v, ci) => { rows[r0 + ri] = rows[r0 + ri] || []; rows[r0 + ri][c0 + ci] = v; }));
      return this.res(200, { updatedCells: 1 });
    }
    return this.res(405, 'unsupported');
  }
  invCount(pid, lid = 'cabin_wv') { const r = this.tabs.get('Inventory').find((x, i) => i > 0 && x[0] === pid && x[1] === lid); return r ? parseInt(r[2]) : undefined; }
  objects(tab) { const t = this.tabs.get(tab) || []; const h = t[0] || []; return t.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); }
}
