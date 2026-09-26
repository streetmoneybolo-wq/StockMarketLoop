import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createPushService, mountPushSend, mountPushMember, validPushEndpoint } from './push.mjs';

const SECRET = 'p'.repeat(40);
const ENV = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', SML_PUSH_SECRET: SECRET, SML_SITE_URL: 'https://site.test' };
const EP = (n) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
const KEYS = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };

/* better-sqlite3-compatible shim over Node's built-in SQLite, so the tests run
   the real SQL without a native build */
function memoryDb() {
  const raw = new DatabaseSync(':memory:');
  return {
    exec: (sql) => raw.exec(sql),
    pragma: () => {},
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return { run: (...a) => stmt.run(...a), all: (...a) => stmt.all(...a), get: (...a) => stmt.get(...a) };
    },
    transaction: (fn) => () => {
      raw.exec('BEGIN');
      try { fn(); raw.exec('COMMIT'); } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
}

function service({ sends = [], failWith = null, optins = [] } = {}) {
  const webPush = {
    setVapidDetails() {},
    async sendNotification(sub, body) {
      if (failWith) { const e = new Error('push failed'); e.statusCode = failWith; throw e; }
      sends.push({ endpoint: sub.endpoint, body: JSON.parse(body) });
    },
  };
  const fetchImpl = async (url, init) => { optins.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: true }; };
  return createPushService({ env: ENV, db: memoryDb(), webPush, fetchImpl });
}

async function withApp(svc, run, identity = { userId: 'wp-7' }) {
  const app = express();
  mountPushSend(app, svc);
  app.use(express.json());
  mountPushMember(app, svc, async (req, res) => {
    if (req.get('authorization') !== 'Bearer good') { res.status(401).json({ error: 'no' }); return null; }
    return { token: 'good', identity };
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

function signed(pathName, bodyObj, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(bodyObj);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${pathName}.${hash}`).digest('hex');
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-sml-push-timestamp': String(ts), 'x-sml-push-signature': sig }, body };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('endpoint allowlist accepts real push services only', () => {
  assert.equal(validPushEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(validPushEndpoint('https://web.push.apple.com/abc'), true);
  assert.equal(validPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(validPushEndpoint('https://evil.example/collect'), false);
  assert.equal(validPushEndpoint('https://fcm.googleapis.com.evil.example/x'), false);
  assert.equal(validPushEndpoint('http://fcm.googleapis.com/x'), false);
  assert.equal(validPushEndpoint('https://fcm.googleapis.com:8443/x'), false);
});

test('subscribe requires auth, validates, mirrors opt-in to the site', async () => {
  const optins = [];
  const svc = service({ optins });
  await withApp(svc, async (base) => {
    const noAuth = await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noAuth.status, 401);
    const bad = await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'https://evil.example/x', keys: KEYS } }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: EP(1), keys: KEYS } }) });
    assert.equal(ok.status, 200);
    const status = await (await fetch(`${base}/api/push/status`, { headers: { authorization: 'Bearer good' } })).json();
    assert.equal(status.devices, 1);
    assert.equal(status.subscribed, true);
  });
  assert.equal(optins.length, 1);
  assert.equal(optins[0].url, 'https://site.test/wp-json/sml-loop-kick/v1/push-optin');
  assert.deepEqual(optins[0].body, { user_id: 'wp-7', optin: true });
  const ts = optins[0].headers['x-sml-push-timestamp'];
  const hash = crypto.createHash('sha256').update(JSON.stringify(optins[0].body)).digest('hex');
  assert.equal(optins[0].headers['x-sml-push-signature'], 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}./wp-json/sml-loop-kick/v1/push-optin.${hash}`).digest('hex'));
});

test('a member keeps at most five devices, oldest dropped', async () => {
  const svc = service();
  for (let i = 1; i <= 7; i++) {
    assert.equal(svc.saveSubscription('wp-7', { endpoint: EP(i), keys: KEYS }), true);
    await new Promise((r) => setTimeout(r, 2));
  }
  const rows = svc.subscriptionsFor('wp-7').map((r) => r.endpoint);
  assert.equal(rows.length, 5);
  assert.ok(!rows.includes(EP(1)) && !rows.includes(EP(2)));
});

test('unsubscribe by endpoint only deletes the caller own row', async () => {
  const svc = service();
  svc.saveSubscription('wp-9', { endpoint: EP(50), keys: KEYS });
  await withApp(svc, async (base) => {
    await fetch(`${base}/api/push/unsubscribe`, { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: EP(50) }) });
  }, { userId: 'wp-7' });
  assert.equal(svc.subscriptionsFor('wp-9').length, 1, 'another member row must survive');
});

test('send route: signed batch answers first, delivers per member, collapses by tag', async () => {
  const sends = [];
  const svc = service({ sends });
  svc.saveSubscription('wp-7', { endpoint: EP(1), keys: KEYS });
  svc.saveSubscription('wp-8', { endpoint: EP(2), keys: KEYS });
  await withApp(svc, async (base) => {
    const r = await fetch(`${base}/api/push/send`, signed('/api/push/send', { items: [
      { user_id: 'wp-7', title: 'New message', body: 'hi', url: 'https://stockmarketloop.com/#loop-kick', tag: 'loop-kick' },
      { user_id: 'wp-8', title: 'New like', body: 'x', url: 'javascript:alert(1)' },
      { user_id: 'nope', title: 'bad' },
    ] }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).queued, 2);
    await tick();
  });
  assert.equal(sends.length, 2);
  assert.equal(sends.find((s) => s.endpoint === EP(1)).body.tag, 'loop-kick');
  assert.equal(sends.find((s) => s.endpoint === EP(2)).body.url, 'https://stockmarketloop.com/#loop-kick', 'non-https urls are replaced');
});

test('send route rejects bad signatures, stale timestamps and replays', async () => {
  const svc = service();
  await withApp(svc, async (base) => {
    const wrong = await fetch(`${base}/api/push/send`, signed('/api/push/send', { items: [] }, { secret: 'x'.repeat(40) }));
    assert.equal(wrong.status, 401);
    const stale = await fetch(`${base}/api/push/send`, signed('/api/push/send', { items: [] }, { ts: Math.floor(Date.now() / 1000) - 120 }));
    assert.equal(stale.status, 401);
    const req = signed('/api/push/send', { items: [] });
    assert.equal((await fetch(`${base}/api/push/send`, req)).status, 200);
    assert.equal((await fetch(`${base}/api/push/send`, req)).status, 401, 'the same signature must never work twice');
    const crossRoute = signed('/api/push/send', { user_id: 'wp-7' });
    assert.equal((await fetch(`${base}/api/push/revoke`, crossRoute)).status, 401, 'a send signature cannot drive revoke');
  });
});

test('revoke drops every device of the member', async () => {
  const svc = service();
  svc.saveSubscription('wp-7', { endpoint: EP(1), keys: KEYS });
  svc.saveSubscription('wp-7', { endpoint: EP(2), keys: KEYS });
  await withApp(svc, async (base) => {
    const r = await fetch(`${base}/api/push/revoke`, signed('/api/push/revoke', { user_id: 'wp-7' }));
    assert.equal(r.status, 200);
  });
  assert.equal(svc.subscriptionsFor('wp-7').length, 0);
});

test('gone endpoints are pruned and the site opt-in cleared', async () => {
  const optins = [];
  const svc = service({ failWith: 410, optins });
  svc.saveSubscription('wp-7', { endpoint: EP(1), keys: KEYS });
  await svc.send('wp-7', { title: 't', body: 'b' });
  assert.equal(svc.subscriptionsFor('wp-7').length, 0);
  assert.deepEqual(optins.at(-1).body, { user_id: 'wp-7', optin: false });
});

test('push fails closed without VAPID keys', async () => {
  const svc = createPushService({ env: { SML_PUSH_SECRET: SECRET }, db: memoryDb(), webPush: { setVapidDetails() {}, sendNotification() {} }, fetchImpl: async () => ({ ok: true }) });
  assert.equal(svc.enabled, false);
  await withApp(svc, async (base) => {
    const status = await (await fetch(`${base}/api/push/status`, { headers: { authorization: 'Bearer good' } })).json();
    assert.equal(status.enabled, false);
    assert.equal(status.vapidPublicKey, '');
  });
});
