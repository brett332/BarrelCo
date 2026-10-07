import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import worker from '../worker.js';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { SHEET_ID: 'S', SERVICE_ACCOUNT_EMAIL: 'svc@x.iam.gserviceaccount.com', SERVICE_ACCOUNT_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
let jwt = null; const orig = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  u = String(u);
  if (u.startsWith('https://oauth2')) { jwt = new URLSearchParams(o.body).get('assertion'); return new Response(JSON.stringify({ access_token: 't' })); }
  return new Response(JSON.stringify({ values: [['ProductId']] }));
};
// run several times: base64 padding / +,/ characters are random-ish per signature
for (let i = 0; i < 25; i++) {
  await worker.fetch(new Request('https://w/inventory'), env);
  const [h, c, s] = jwt.split('.');
  for (const seg of [h, c, s]) assert.match(seg, /^[A-Za-z0-9_-]+$/, 'segment is not base64url: ' + seg.slice(0, 30));
  const v = createVerify('RSA-SHA256'); v.update(h + '.' + c);
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')), 'signature does not verify');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, env.SERVICE_ACCOUNT_EMAIL);
}
globalThis.fetch = orig; console.log('PASS jwt base64url + verifiable signature (25 runs)');
