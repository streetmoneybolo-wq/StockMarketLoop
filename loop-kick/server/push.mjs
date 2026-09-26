import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';

const require = createRequire(import.meta.url);

/**
 * Web push for LOOP-KICK. Subscriptions live in sqlite on the service disk; the
 * site's SML Notify fan-out feeds POST /api/push/send (one signed batch per site
 * request) and logouts hit POST /api/push/revoke. Both are HMAC-signed with
 * SML_PUSH_SECRET over "{ts}.{path}.{sha256(rawBody)}" (60 s window, single-use).
 * Subscribing/unsubscribing mirrors the member's opt-in back to the site, which
 * then only exports notifications for opted-in members. Fail-closed throughout.
 */

const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
const MAX_DEVICES = 5;
const MAX_FAILS = 5;
const SUBSCRIPTION_TTL_MS = 180 * 24 * 3600 * 1000;
const BATCH_CAP = 500;

function dataDir() {
  const configured = String(process.env.DATA_DIR || '').trim();
  if (configured) return configured;
  if (fs.existsSync('/var/data')) return '/var/data';
  return path.join(process.cwd(), 'data');
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0
); CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS push_seen_signatures (sig TEXT PRIMARY KEY, at INTEGER NOT NULL);`;

export function ensureSchema(db) {
  db.exec(SCHEMA);
  return db;
}

function openStore() {
  let Database;
  try { Database = require('better-sqlite3'); } catch (error) { return null; }
  try {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'push-subscriptions.db'));
    db.pragma('journal_mode = WAL');
    return ensureSchema(db);
  } catch (error) {
    return null;
  }
}

function loadWebPush() {
  try { return require('web-push'); } catch (error) { return null; }
}

export function validPushEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint || '')); } catch (error) { return false; }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || String(endpoint).length > 1024) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

export function createPushService({ env = process.env, fetchImpl = fetch, db: injectedDb = null, webPush: injectedWebPush = null } = {}) {
  const vapidPublicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const vapidPrivateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const vapidSubject = String(env.VAPID_SUBJECT || 'mailto:alerts@stockmarketloop.com').trim();
  const pushSecret = String(env.SML_PUSH_SECRET || '').trim();
  const siteUrl = String(env.SML_SITE_URL || 'https://stockmarketloop.com').trim().replace(/\/+$/, '');
  const webPush = injectedWebPush || loadWebPush();
  const db = injectedDb ? ensureSchema(injectedDb) : openStore();
  const enabled = Boolean(webPush && db && vapidPublicKey && vapidPrivateKey);
  if (enabled && typeof webPush.setVapidDetails === 'function') webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  function signedHeaders(pathName, body) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const signature = crypto.createHmac('sha256', pushSecret).update(`${timestamp}.${pathName}.${bodyHash}`).digest('hex');
    return { 'content-type': 'application/json', 'x-sml-push-timestamp': timestamp, 'x-sml-push-signature': `sha256=${signature}` };
  }

  /** Mirror the member's opt-in to the site so only opted-in members' alerts leave it. */
  function syncOptin(userId, optin) {
    if (pushSecret.length < 32) return;
    const pathName = '/wp-json/sml-loop-kick/v1/push-optin';
    const body = JSON.stringify({ user_id: String(userId), optin: Boolean(optin) });
    fetchImpl(`${siteUrl}${pathName}`, { method: 'POST', headers: signedHeaders(pathName, body), body, signal: AbortSignal.timeout(8000) }).catch(() => {});
  }

  function subscriptionsFor(userId) {
    if (!db) return [];
    const cutoff = Date.now() - SUBSCRIPTION_TTL_MS;
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND created_at < ?').run(String(userId), cutoff);
    return db.prepare('SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(String(userId));
  }

  function saveSubscription(userId, subscription) {
    if (!db) return false;
    const endpoint = String(subscription?.endpoint || '');
    const p256dh = String(subscription?.keys?.p256dh || '');
    const auth = String(subscription?.keys?.auth || '');
    if (!validPushEndpoint(endpoint) || !/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,64}$/.test(auth)) return false;
    const upsert = db.transaction(() => {
      db.prepare('INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at, fail_count) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at, fail_count = 0')
        .run(endpoint, String(userId), p256dh, auth, Date.now());
      /* a member keeps at most MAX_DEVICES; the oldest fall off */
      db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
        SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`).run(String(userId), String(userId), MAX_DEVICES);
    });
    upsert();
    syncOptin(userId, true);
    return true;
  }

  function dropOwned(userId, endpoint) {
    if (!db) return;
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(endpoint), String(userId));
    if (!subscriptionsFor(userId).length) syncOptin(userId, false);
  }

  function dropAllFor(userId, { notifySite = true } = {}) {
    if (!db) return;
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(String(userId));
    if (notifySite) syncOptin(userId, false);
  }

  async function send(userId, payload) {
    if (!enabled) return { sent: 0 };
    const rows = subscriptionsFor(userId);
    const body = JSON.stringify({
      title: String(payload.title || 'LOOP-KICK').slice(0, 80),
      body: String(payload.body || '').slice(0, 180),
      url: /^https:\/\//.test(String(payload.url || '')) ? String(payload.url) : 'https://stockmarketloop.com/#loop-kick',
      tag: String(payload.tag || 'loop-kick').slice(0, 40),
    });
    let sent = 0;
    for (const row of rows) {
      try {
        await webPush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body, { TTL: 3600, urgency: 'normal', timeout: 10000 });
        db.prepare('UPDATE push_subscriptions SET fail_count = 0 WHERE endpoint = ?').run(row.endpoint);
        sent++;
      } catch (error) {
        const status = Number(error?.statusCode || 0);
        if (status === 404 || status === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint); // the browser revoked it
        } else {
          db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?').run(row.endpoint);
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND fail_count >= ?').run(row.endpoint, MAX_FAILS);
        }
      }
    }
    if (rows.length && !subscriptionsFor(userId).length) syncOptin(userId, false);
    return { sent };
  }

  function verifySigned(req, rawBody, pathName) {
    if (pushSecret.length < 32 || !db) return false;
    const timestamp = String(req.get('x-sml-push-timestamp') || '');
    const provided = String(req.get('x-sml-push-signature') || '');
    if (!/^\d{10,12}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(provided)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) return false;
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const expected = 'sha256=' + crypto.createHmac('sha256', pushSecret).update(`${timestamp}.${pathName}.${bodyHash}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return false;
    /* single-use: a captured request can never be replayed */
    db.prepare('DELETE FROM push_seen_signatures WHERE at < ?').run(Date.now() - 600_000);
    const burned = db.prepare('INSERT OR IGNORE INTO push_seen_signatures (sig, at) VALUES (?, ?)').run(provided, Date.now());
    return burned.changes === 1;
  }

  return { enabled, vapidPublicKey, subscriptionsFor, saveSubscription, dropOwned, dropAllFor, send, verifySigned };
}

/** Site-facing signed routes — MUST be mounted before the JSON parser (raw bytes). */
export function mountPushSend(app, service) {
  const raw = express.raw({ type: () => true, limit: '256kb' });

  app.post('/api/push/send', raw, (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!service.verifySigned(req, rawBody, '/api/push/send')) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!service.enabled) return res.status(503).json({ ok: false, error: 'push_unconfigured' });
    let payload = null;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch (error) { payload = null; }
    const items = (Array.isArray(payload?.items) ? payload.items : payload ? [payload] : [])
      .filter((item) => /^wp-\d{1,12}$/.test(String(item?.user_id || '')))
      .slice(0, BATCH_CAP);
    /* answer first: the site's request never waits on FCM/APNs */
    res.json({ ok: true, queued: items.length });
    setImmediate(async () => {
      for (const item of items) {
        try { await service.send(String(item.user_id), item); } catch (error) { /* one member never blocks the rest */ }
      }
    });
    return undefined;
  });

  app.post('/api/push/revoke', raw, (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!service.verifySigned(req, rawBody, '/api/push/revoke')) return res.status(401).json({ ok: false, error: 'unauthorized' });
    let payload = null;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch (error) { payload = null; }
    const userId = String(payload?.user_id || '');
    if (!/^wp-\d{1,12}$/.test(userId)) return res.status(400).json({ ok: false, error: 'invalid_user' });
    service.dropAllFor(userId, { notifySite: false }); // the site already cleared its opt-in
    return res.json({ ok: true });
  });
}

/** Member-facing subscription management (bearer-authenticated like the rest). */
export function mountPushMember(app, service, requireAuth) {
  app.get('/api/push/status', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    res.set('Cache-Control', 'no-store, private');
    const devices = service.enabled ? service.subscriptionsFor(auth.identity.userId).length : 0;
    res.json({ enabled: service.enabled, vapidPublicKey: service.enabled ? service.vapidPublicKey : '', subscribed: devices > 0, devices });
  });
  app.post('/api/push/subscribe', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!service.enabled) return res.status(503).json({ ok: false, error: 'push_unconfigured' });
    const saved = service.saveSubscription(auth.identity.userId, req.body?.subscription);
    if (!saved) return res.status(400).json({ ok: false, error: 'invalid_subscription' });
    return res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const endpoint = String(req.body?.endpoint || '');
    if (endpoint) service.dropOwned(auth.identity.userId, endpoint);
    else service.dropAllFor(auth.identity.userId);
    return res.json({ ok: true });
  });
}
