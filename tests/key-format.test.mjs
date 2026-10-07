import assert from 'node:assert/strict';
import worker from '../worker.js';
import { FakeSheets, makeEnv } from './fake-sheets.mjs';
const base = makeEnv(); const pem = base.SERVICE_ACCOUNT_KEY;
const variants = {
  'real PEM': pem,
  'literal \\n sequences': pem.trim().replace(/\n/g, '\\n'),
  'quoted + literal \\n': '"' + pem.trim().replace(/\n/g, '\\n') + '"',
  'whole service-account JSON': JSON.stringify({ type: 'service_account', private_key: pem }),
};
let bad = 0;
for (const [name, key] of Object.entries(variants)) {
  const s = new FakeSheets(); s.install();
  const r = await worker.fetch(new Request('https://w/inventory'), { ...base, SERVICE_ACCOUNT_KEY: key });
  s.uninstall(); const ok = r.status === 200; if (!ok) bad++; console.log(ok ? 'PASS' : 'FAIL', name, r.status);
}
const s = new FakeSheets(); s.install();
const r = await worker.fetch(new Request('https://w/inventory'), { ...base, SERVICE_ACCOUNT_KEY: 'not a key' }); s.uninstall();
const b = await r.json(); const ok = r.status === 500 && /not a valid PEM/.test(b.detail); if (!ok) bad++; console.log(ok ? 'PASS' : 'FAIL', 'garbage key -> clear 500 message');
process.exit(bad ? 1 : 0);
