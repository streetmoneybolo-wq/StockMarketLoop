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
  // Live quotes from massive.com (Polygon-compatible snapshot). API key in the
  // MASSIVE_API_KEY env var (server-side only, never sent to the browser). ~10s
  // per-symbol-set cache, CORS-open. If the key is missing or the upstream errors
  // we return an empty quote set so the site shows "—" and never fabricates.
  const MASSIVE_KEY = process.env.MASSIVE_API_KEY || '';
  const MASSIVE_BASE = (process.env.MASSIVE_BASE || 'https://api.massive.com').replace(/\/+$/, '');
  const DEFAULT_SYMS = 'SPY,QQQ,NVDA,AAPL,TSLA,MSFT,AMD,META,AMZN,GOOGL,NFLX,COIN';
  const quoteCache = new Map(); // symbolSet -> { at, body }
  app.get('/api/quotes', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    if (!MASSIVE_KEY) return res.json({ ok: false, reason: 'no-key', quotes: {} });
    const syms = String(req.query.symbols || DEFAULT_SYMS)
      .toUpperCase().replace(/[^A-Z0-9,.\-]/g, '').split(',').filter(Boolean).slice(0, 60);
    const key = syms.join(',');
    const now = Date.now();
    const hit = quoteCache.get(key);
    if (hit && now - hit.at < 10000) return res.json(hit.body);
    try {
      const url = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(key)}&include_otc=true`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${MASSIVE_KEY}` }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`massive ${r.status}`);
      const data = await r.json();
      const quotes = {};
      for (const t of (data.tickers || [])) {
        const last = t.lastTrade?.p ?? t.day?.c ?? t.prevDay?.c ?? null;
        const chg = typeof t.todaysChange === 'number' ? t.todaysChange : null;
        const pct = typeof t.todaysChangePerc === 'number' ? t.todaysChangePerc : null;
        quotes[t.ticker] = {
          sym: t.ticker,
          last: last == null ? null : Math.round(last * 100) / 100,
          chg: chg == null ? null : Math.round(chg * 100) / 100,
          pct: pct == null ? null : Math.round(pct * 100) / 100,
          vol: t.day?.v ?? null,
          pc: t.prevDay?.c ?? null,
          t: t.updated ? new Date(Math.floor(t.updated / 1e6)).toISOString().slice(11, 19) : null,
        };
      }
      const body = { ok: true, quotes };
      quoteCache.set(key, { at: now, body });
      return res.json(body);
    } catch {
      if (hit && now - hit.at < 60000) return res.json({ ...hit.body, stale: true });
      return res.json({ ok: false, reason: 'upstream-error', quotes: {} });
    }
  });

  // Company logo per ticker, via massive.com ticker branding. Image bytes are
  // cached in memory (7d, misses 1h) so massive is hit at most once per symbol.
  const logoCache = new Map(); // SYM -> { at, type, buf } (buf null = known miss)
  app.get('/api/logo/:sym', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const sym = String(req.params.sym || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
    if (!sym || !MASSIVE_KEY) return res.status(404).end();
    const now = Date.now();
    const hit = logoCache.get(sym);
    if (hit && now - hit.at < (hit.buf ? 6048e5 : 36e5)) {
      if (!hit.buf) return res.status(404).end();
      res.set('Content-Type', hit.type); res.set('Cache-Control', 'public, max-age=86400');
      return res.send(hit.buf);
    }
    try {
      const r = await fetch(`${MASSIVE_BASE}/v3/reference/tickers/${encodeURIComponent(sym)}`, {
        headers: { Authorization: `Bearer ${MASSIVE_KEY}` }, signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) throw new Error(`ref ${r.status}`);
      const j = await r.json();
      const url = j.results?.branding?.icon_url || j.results?.branding?.logo_url;
      if (!url) throw new Error('no-branding');
      let img = await fetch(url, { headers: { Authorization: `Bearer ${MASSIVE_KEY}` }, signal: AbortSignal.timeout(6000) });
      if (!img.ok) img = await fetch(`${url}${url.includes('?') ? '&' : '?'}apiKey=${MASSIVE_KEY}`, { signal: AbortSignal.timeout(6000) });
      if (!img.ok) throw new Error(`img ${img.status}`);
      const buf = Buffer.from(await img.arrayBuffer());
      const type = img.headers.get('content-type') || 'image/png';
      if (logoCache.size > 300) logoCache.delete(logoCache.keys().next().value);
      logoCache.set(sym, { at: now, type, buf });
      res.set('Content-Type', type); res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    } catch {
      if (logoCache.size > 300) logoCache.delete(logoCache.keys().next().value);
      logoCache.set(sym, { at: now, type: '', buf: null });
      return res.status(404).end();
    }
  });

  // WebRTC ICE config for voice/video calls (STUN + TURN). Two easy ways to add
  // TURN (needed for cross-network / mobile calls):
  //  1. EASIEST — set METERED_TURN_URL to the one "credentials URL" from your
  //     Metered.ca dashboard; the server fetches the full TURN list from it.
  //  2. Manual — set TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL for any provider.
  let iceCache = { at: 0, servers: null };
  app.get('/api/ice', async (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    const now = Date.now();
    if (iceCache.servers && now - iceCache.at < 300000) return res.json({ iceServers: iceCache.servers });
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const turnUrls = String(process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      iceServers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
    if (process.env.METERED_TURN_URL) {
      try {
        const r = await fetch(process.env.METERED_TURN_URL, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const list = await r.json();
          if (Array.isArray(list)) list.forEach((s) => { if (s && s.urls) iceServers.push(s); });
        }
      } catch { /* keep STUN + any manual TURN */ }
    }
    iceCache = { at: now, servers: iceServers };
    res.json({ iceServers });
  });

  // LiveKit access token for group video rooms (SFU). Needs LIVEKIT_URL,
  // LIVEKIT_API_KEY, LIVEKIT_API_SECRET (from a free LiveKit Cloud project).
  // The room name is scoped per conversation; identity = the user's SML id.
  app.post('/api/livekit-token', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      return res.json({ ok: false, reason: 'no-livekit' });
    }
    const room = String(req.body?.room || 'loop').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'loop';
    const identity = String(auth.identity.userId || auth.identity.wpUserId || 'user');
    const name = String(auth.identity.name || auth.identity.handle || 'Loop');
    try {
      const { AccessToken } = await import('livekit-server-sdk');
      const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity, name, ttl: '2h' });
      at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();
      return res.json({ ok: true, token, url: process.env.LIVEKIT_URL, room, identity, name });
    } catch (error) {
      console.error('LiveKit token error:', error.message);
      return res.json({ ok: false, reason: 'token-error' });
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
