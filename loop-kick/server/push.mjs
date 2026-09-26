import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/**
 * Web push for LOOP-KICK. Subscriptions live in sqlite on the service disk
 * (better-sqlite3 was already a dependency); the sender is fed by the site's
 * SML Notify fan-out through POST /api/push/send, HMAC-signed with
 * SML_PUSH_SECRET over "{ts}.{path}.{sha256(rawBody)}" (60 s window) — the
 * same signing family the platform bridges use. Fail-closed everywhere:
 * no VAPID keys or no secret means the endpoints simply say so.
 */

function dataDir() {
  const configured = String(process.env.DATA_DIR || '').trim();
  if (configured) return configured;
  if (fs.existsSync('/var/data')) return '/var/data';
  return path.join(process.cwd(), 'data');
}

function openStore() {
  let Database;
  try { Database = require('better-sqlite3'); } catch (error) { return null; }
  try {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'push-subscriptions.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);`);
    return db;
  } catch (error) {
    return null;
  }
}

// better-sqlite3 is CJS; recreate require in this ESM file.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function loadWebPush() {
  try { return require('web-push'); } catch (error) { return null; }
}

export function createPushService({ env = process.env } = {}) {
  const vapidPublicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const vapidPrivateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const vapidSubject = String(env.VAPID_SUBJECT || 'mailto:alerts@stockmarketloop.com').trim();
  const pushSecret = String(env.SML_PUSH_SECRET || '').trim();
  const webPush = loadWebPush();
  const db = openStore();
  const enabled = Boolean(webPush && db && vapidPublicKey && vapidPrivateKey);
  if (enabled) webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  function subscriptionsFor(userId) {
    if (!db) return [];
    return db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(String(userId));
  }

  function saveSubscription(userId, subscription) {
    if (!db) return false;
    const endpoint = String(subscription?.endpoint || '');
    const p256dh = String(subscription?.keys?.p256dh || '');
    const auth = String(subscription?.keys?.auth || '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1024 || !p256dh || !auth) return false;
    db.prepare('INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth')
      .run(endpoint, String(userId), p256dh, auth, Date.now());
    return true;
  }

  function dropSubscription(endpoint) {
    if (db) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint));
  }

  function dropAllFor(userId) {
    if (db) db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(String(userId));
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
        await webPush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body, { TTL: 3600, urgency: 'normal' });
        sent++;
      } catch (error) {
        const status = Number(error?.statusCode || 0);
        if (status === 404 || status === 410) dropSubscription(row.endpoint); // the browser revoked it
      }
    }
    return { sent };
  }

  function verifySendSignature(req, rawBody) {
    if (pushSecret.length < 32) return false;
    const timestamp = String(req.get('x-sml-push-timestamp') || '');
    const provided = String(req.get('x-sml-push-signature') || '');
    if (!/^\d{10,12}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) return false;
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const expected = 'sha256=' + crypto.createHmac('sha256', pushSecret).update(`${timestamp}./api/push/send.${bodyHash}`).digest('hex');
    return provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  }

  return { enabled, vapidPublicKey, subscriptionsFor, saveSubscription, dropSubscription, dropAllFor, send, verifySendSignature };
}

/** The site-facing sender — MUST be mounted before the JSON body parser so the
 *  raw bytes are still available for the HMAC. */
export function mountPushSend(app, service) {
  app.post('/api/push/send', express.raw({ type: () => true, limit: '8kb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!service.verifySendSignature(req, rawBody)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (!service.enabled) return res.status(503).json({ ok: false, error: 'push_unconfigured' });
    let payload = null;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch (error) { payload = null; }
    const userId = String(payload?.user_id || '');
    if (!/^wp-\d{1,12}$/.test(userId)) return res.status(400).json({ ok: false, error: 'invalid_user' });
    const result = await service.send(userId, payload);
    return res.json({ ok: true, sent: result.sent });
  });
}

/** Member-facing subscription management (bearer-authenticated like the rest). */
export function mountPushMember(app, service, requireAuth) {
  app.get('/api/push/status', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    res.set('Cache-Control', 'no-store, private');
    res.json({
      enabled: service.enabled,
      vapidPublicKey: service.enabled ? service.vapidPublicKey : '',
      subscribed: service.enabled ? service.subscriptionsFor(auth.identity.userId).length > 0 : false,
    });
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
    if (endpoint) service.dropSubscription(endpoint);
    else service.dropAllFor(auth.identity.userId);
    return res.json({ ok: true });
  });
}
