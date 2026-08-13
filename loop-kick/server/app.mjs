import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SESSION_URL = 'https://stockmarketloop.com/wp-json/sml-loop-kick/v1/session';
const DEFAULT_GATEWAY_URL = 'https://stockmarketloop.com/wp-json/sml-loop-kick/v1/gateway';
const DEFAULT_UPLOAD_URL = 'https://stockmarketloop.com/wp-json/sml-loop-kick/v1/upload';

function bearerToken(req) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(req.get('authorization') || ''));
  return match ? match[1] : '';
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text || `Upstream returned ${response.status}` };
  }
}

async function verifyWordPressSession(token) {
  if (!token) return null;
  const endpoint = process.env.LOOP_KICK_SESSION_URL || DEFAULT_SESSION_URL;
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) return null;
  const body = await response.json();
  return body?.userId && body?.wpUserId ? body : null;
}

async function callWordPressGateway(token, method, route, params = {}) {
  const endpoint = process.env.LOOP_KICK_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loop-Kick-Session': token,
    },
    body: JSON.stringify({ route, method, [method === 'GET' ? 'query' : 'payload']: params }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await readJson(response);
  if (!response.ok || body?.code) {
    const error = new Error(body?.message || `WordPress returned ${response.status}`);
    error.status = Number(body?.data?.status || response.status || 502);
    error.code = body?.code || 'wordpress_gateway_error';
    throw error;
  }
  return body;
}

export function createLoopKickServer(options = {}) {
  const distDir = options.distDir || path.join(ROOT, 'dist');
  const verifySession = options.verifySession || verifyWordPressSession;
  const gateway = options.gateway || callWordPressGateway;
  const app = express();
  const server = http.createServer(app);
  const sessionCache = new Map();

  async function authenticate(req) {
    const token = bearerToken(req);
    if (!token) return null;
    const cached = sessionCache.get(token);
    if (cached?.expiresAt > Date.now()) return { token, identity: cached.identity };
    const identity = await verifySession(token);
    if (!identity?.userId) return null;
    sessionCache.set(token, { identity, expiresAt: Date.now() + 60_000 });
    return { token, identity };
  }

  async function requireAuth(req, res) {
    try {
      const auth = await authenticate(req);
      if (!auth) res.status(401).json({ error: 'A valid StockMarketLoop session is required.' });
      return auth;
    } catch (error) {
      console.error('LOOP-KICK session verification failed:', error.message);
      res.status(502).json({ error: 'StockMarketLoop session verification is temporarily unavailable.' });
      return null;
    }
  }

  function sendError(res, error) {
    const status = Number(error?.status || 502);
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: error?.message || 'The messenger service is temporarily unavailable.',
      code: error?.code || 'loop_kick_gateway_error',
    });
  }

  async function proxy(req, res, method, route, params = {}) {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await gateway(auth.token, method, route, params));
    } catch (error) {
      return sendError(res, error);
    }
  }

  app.disable('x-powered-by');

  // Upload must receive the untouched multipart body before the JSON parser.
  app.post('/api/upload', express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      const endpoint = process.env.LOOP_KICK_UPLOAD_URL || DEFAULT_UPLOAD_URL;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': req.get('content-type') || 'application/octet-stream',
          'X-Loop-Kick-Session': auth.token,
        },
        body: req.body,
        signal: AbortSignal.timeout(30000),
      });
      const body = await readJson(response);
      if (!response.ok || body?.code) {
        const error = new Error(body?.message || `Upload returned ${response.status}`);
        error.status = Number(body?.data?.status || response.status);
        throw error;
      }
      return res.json(body);
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'loop-kick', source: 'wordpress-messenger' });
  });

  app.get('/api/bootstrap', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      const [threads, people, notifications, preferences, chirp, incoming] = await Promise.all([
        gateway(auth.token, 'GET', '/sml-loop/v1/threads', { per_page: 100 }),
        gateway(auth.token, 'GET', '/sml-mhub/v1/people'),
        gateway(auth.token, 'GET', '/sml-mhub/v1/notifications'),
        gateway(auth.token, 'GET', '/sml-loop/v1/preferences'),
        gateway(auth.token, 'GET', '/sml-loop/v1/chirp/settings'),
        gateway(auth.token, 'GET', '/sml-loop/v1/chirp/incoming'),
      ]);
      res.set('Cache-Control', 'no-store, private');
      return res.json({ identity: auth.identity, threads, people, notifications, preferences, chirp, incoming });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/threads', (req, res) => proxy(req, res, 'GET', '/sml-loop/v1/threads', req.query));
  app.post('/api/threads', (req, res) => proxy(req, res, 'POST', '/sml-loop/v1/threads', req.body));
  app.get('/api/threads/:id/messages', (req, res) => proxy(req, res, 'GET', `/sml-loop/v1/threads/${Number(req.params.id)}/messages`, req.query));
  app.post('/api/threads/:id/messages', (req, res) => proxy(req, res, 'POST', `/sml-loop/v1/threads/${Number(req.params.id)}/messages`, req.body));
  app.delete('/api/threads/:id/messages', (req, res) => proxy(req, res, 'DELETE', `/sml-loop/v1/threads/${Number(req.params.id)}/messages`));
  for (const action of ['read', 'flags', 'request']) {
    app.post(`/api/threads/:id/${action}`, (req, res) => proxy(req, res, 'POST', `/sml-loop/v1/threads/${Number(req.params.id)}/${action}`, req.body));
  }
  app.delete('/api/messages/:id', (req, res) => proxy(req, res, 'DELETE', `/sml-loop/v1/messages/${Number(req.params.id)}`));
  app.get('/api/poll', (req, res) => proxy(req, res, 'GET', '/sml-loop/v1/poll', req.query));
  app.get('/api/people', (req, res) => proxy(req, res, 'GET', '/sml-mhub/v1/people'));
  app.get('/api/search', (req, res) => proxy(req, res, 'GET', '/sml-mhub/v1/search', req.query));
  app.get('/api/notifications', (req, res) => proxy(req, res, 'GET', '/sml-mhub/v1/notifications'));
  app.post('/api/notifications', (req, res) => proxy(req, res, 'POST', '/sml-mhub/v1/notifications', req.body));
  app.get('/api/preferences', (req, res) => proxy(req, res, 'GET', '/sml-loop/v1/preferences'));
  app.post('/api/preferences', (req, res) => proxy(req, res, 'POST', '/sml-loop/v1/preferences', req.body));
  app.get('/api/chirp/settings', (req, res) => proxy(req, res, 'GET', '/sml-loop/v1/chirp/settings'));
  app.post('/api/chirp/settings', (req, res) => proxy(req, res, 'POST', '/sml-loop/v1/chirp/settings', req.body));
  app.post('/api/chirp/allow', (req, res) => proxy(req, res, 'POST', '/sml-loop/v1/chirp/allow', req.body));
  app.get('/api/chirp/presence', (req, res) => proxy(req, res, 'GET', '/sml-loop/v1/chirp/presence', req.query));
  app.post('/api/chirp/presence', (req, res) => proxy(req, res, 'POST', '/sml-loop/v1/chirp/presence', req.body));
  app.post('/api/chirp/start', (req, res) => proxy(req, res, 'POST', '/sml-loop/v1/chirp/start', req.body));
  app.get('/api/chirp/incoming', (req, res) => proxy(req, res, 'GET', '/sml-loop/v1/chirp/incoming', req.query));
  app.get('/api/chirp/sessions/:id/signal', (req, res) => proxy(req, res, 'GET', `/sml-loop/v1/chirp/sessions/${Number(req.params.id)}/signal`));
  app.post('/api/chirp/sessions/:id/signal', (req, res) => proxy(req, res, 'POST', `/sml-loop/v1/chirp/sessions/${Number(req.params.id)}/signal`, req.body));
  app.post('/api/chirp/sessions/:id/end', (req, res) => proxy(req, res, 'POST', `/sml-loop/v1/chirp/sessions/${Number(req.params.id)}/end`, req.body));

  // ---- market data (read-only) ----
  // Proxies to the moomoo OpenD bridge running on the user's PC, reached via a
  // Cloudflare tunnel whose URL is set in the QUOTE_UPSTREAM env var. Cached ~2s
  // and CORS-open (quotes are public, read-only). If the bridge is unreachable
  // (PC off / tunnel down) we return an empty quote set so the site shows "—"
  // and never fabricates a price.
  const QUOTE_UPSTREAM = (process.env.QUOTE_UPSTREAM || '').replace(/\/+$/, '');
  let quoteCache = { at: 0, body: null };
  app.get('/api/quotes', async (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    if (!QUOTE_UPSTREAM) return res.json({ ok: false, reason: 'no-upstream', quotes: {} });
    const now = Date.now();
    if (quoteCache.body && now - quoteCache.at < 2000) return res.json(quoteCache.body);
    try {
      const r = await fetch(`${QUOTE_UPSTREAM}/quotes`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const data = await r.json();
      quoteCache = { at: now, body: { ok: true, quotes: data.quotes || {}, age: data.age ?? null } };
      return res.json(quoteCache.body);
    } catch {
      if (quoteCache.body && now - quoteCache.at < 30000) return res.json({ ...quoteCache.body, stale: true });
      return res.json({ ok: false, reason: 'upstream-unreachable', quotes: {} });
    }
  });

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.join(distDir, 'index.html'));
      return next();
    });
  }

  async function close() {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  return { app, server, close };
}
