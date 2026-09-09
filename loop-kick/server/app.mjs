import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createTapeEngine } from './tape.mjs';

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

  /* Liveness: tiny, no external calls — safe for Render health checks and
     uptime probes. */
  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'loop-kick', uptime_s: Math.round(process.uptime()) });
  });

  /* Readiness: verifies the one essential upstream (the WordPress REST
     gateway) with a short timeout. Reports status only — never credentials. */
  app.get('/readyz', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    /* reachability check: ANY HTTP status from the session route proves the
       WordPress upstream is up (an unauthenticated probe correctly gets 401) */
    const probe = process.env.LOOP_KICK_SESSION_URL || DEFAULT_SESSION_URL;
    let wordpress = 'unreachable';
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(probe, { method: 'GET', signal: ctl.signal, headers: { accept: 'application/json' } });
      clearTimeout(timer);
      wordpress = 'ok_status_' + r.status;
    } catch {
      wordpress = 'unreachable';
    }
    const ready = wordpress.indexOf('ok') === 0;
    res.status(ready ? 200 : 503).json({ ok: ready, service: 'loop-kick', wordpress });
  });

  app.get('/api/bootstrap', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      // One WordPress request (bridge >= 1.6.0 serves /sml-loop-kick/v1/bootstrap); older bridges
      // deny the route, in which case we fan out as before.
      try {
        const bundle = await gateway(auth.token, 'GET', '/sml-loop-kick/v1/bootstrap');
        if (bundle && bundle.threads && bundle.people) {
          res.set('Cache-Control', 'no-store, private');
          return res.json({ identity: auth.identity, ...bundle });
        }
      } catch (bundleError) {
        if (bundleError?.code !== 'sml_lk_route_denied' && bundleError?.code !== 'rest_no_route') throw bundleError;
      }
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
  app.post('/api/typing', (req, res) => proxy(req, res, 'POST', '/sml-loop-typing/v1/typing', req.body));   // "… is typing" (plugin sml-loop-typing)
  // A feed post inside the phone: read it, then like / reply / share from there (plugin sml-share-cards, sml-loop-kick-post/v1)
  app.get('/api/post', (req, res) => proxy(req, res, 'GET', '/sml-loop-kick-post/v1/post', req.query));
  app.post('/api/post/action', (req, res) => proxy(req, res, 'POST', '/sml-loop-kick-post/v1/action', req.body));
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

  // ---- ticker voice rooms: the SAME per-ticker room the ticker terminal runs
  //      (WordPress plugin sml-ticker-voice-room-v7; routes allow-listed in the bridge gateway) ----
  app.get('/api/ticker-room', (req, res) => proxy(req, res, 'GET', '/sml-ticker-voice/v1/room', req.query));
  app.post('/api/ticker-room/join', (req, res) => proxy(req, res, 'POST', '/sml-ticker-voice/v1/join', req.body));
  app.post('/api/ticker-room/heartbeat', (req, res) => proxy(req, res, 'POST', '/sml-ticker-voice/v1/heartbeat', req.body));
  app.post('/api/ticker-room/leave', (req, res) => proxy(req, res, 'POST', '/sml-ticker-voice/v1/leave', req.body));
  app.get('/api/ticker-room/signals', (req, res) => proxy(req, res, 'GET', '/sml-ticker-voice/v1/signals', req.query));
  app.post('/api/ticker-room/signals', (req, res) => proxy(req, res, 'POST', '/sml-ticker-voice/v1/signals', req.body));

  // ---- market data (read-only) ----
  // Live quotes from massive.com (Polygon-compatible snapshot). API key in the
  // MASSIVE_API_KEY env var (server-side only, never sent to the browser). ~10s
  // per-symbol-set cache, CORS-open. If the key is missing or the upstream errors
  // we return an empty quote set so the site shows "—" and never fabricates.
  const MASSIVE_KEY = process.env.MASSIVE_API_KEY || '';
  const MASSIVE_BASE = (process.env.MASSIVE_BASE || 'https://api.massive.com').replace(/\/+$/, '');
  const DEFAULT_SYMS = 'SPY,QQQ,NVDA,AAPL,TSLA,MSFT,AMD,META,AMZN,GOOGL,NFLX,COIN';
  const quoteCache = new Map(); // symbolSet -> { at, body }
  // Market Monitor tape: detections are computed ONLY from snapshots this
  // server already fetched for /api/quotes clients — zero extra provider load.
  const tape = options.tape || createTapeEngine();

  // Build a quote set (10s cache), feed the tape, return the body. Throws on a
  // stocks upstream error so callers can serve a stale copy. Shared by the
  // /api/quotes route and the server-side tape-ingest loop.
  async function fetchQuoteSet(syms) {
    const key = syms.join(',');
    const now = Date.now();
    const hit = quoteCache.get(key);
    if (hit && now - hit.at < 10000) return hit.body;
    // BTC is crypto: it rides Kraken's public ticker (real, live, no key),
    // never the stocks snapshot. Everything else stays on Massive.
    const wantBtc = syms.includes('BTC');
    const stockSyms = syms.filter((x) => x !== 'BTC');
    const quotes = {};
    let data = { tickers: [] };
    if (stockSyms.length) {
      const url = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(stockSyms.join(','))}&include_otc=true`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${MASSIVE_KEY}` }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`massive ${r.status}`);
      data = await r.json();
    }
    if (wantBtc) {
      try {
        const kr = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', { signal: AbortSignal.timeout(5000) });
        const kj = await kr.json();
        const tick = kj && kj.result && kj.result[Object.keys(kj.result)[0]];
        const last = tick ? Number(tick.c?.[0]) : NaN;
        const open = tick ? Number(tick.o) : NaN;
        const vol24 = tick ? Number(tick.v?.[1]) : NaN;
        if (Number.isFinite(last) && last > 0 && Number.isFinite(open) && open > 0) {
          quotes.BTC = {
            sym: 'BTC',
            last: Math.round(last * 100) / 100,
            chg: Math.round((last - open) * 100) / 100,
            pct: Math.round(((last - open) / open) * 10000) / 100,
            vol: Number.isFinite(vol24) ? Math.round(vol24 * last) : null, // 24h notional USD
            pc: Math.round(open * 100) / 100, // today's UTC open — crypto has no close
            t: new Date().toISOString().slice(11, 19),
          };
        }
      } catch { /* BTC row degrades to em-dashes; stocks still serve */ }
    }
    for (const t of (data.tickers || [])) {
      /* On a closed market (holidays) the provider sends 0 for lastTrade.p and day.c, not null: a 0 must never win.
         Fall through to the previous close and report a flat day, so the tape shows real prices instead of $0.00. */
      const pick = (...vals) => vals.find((v) => typeof v === 'number' && v > 0) ?? null;
      const last = pick(t.lastTrade?.p, t.day?.c, t.prevDay?.c);
      const closed = last != null && !(t.lastTrade?.p > 0) && !(t.day?.c > 0);
      /* closed market: the provider's todaysChange is 0 (no session yet). Show the LAST session's move
         (previous day open → close) instead of a flat 0.00%, so the tape never reads as broken overnight or on holidays. */
      const po = Number(t.prevDay?.o) || 0, pcl = Number(t.prevDay?.c) || 0;
      const prevMove = po > 0 && pcl > 0 ? { chg: pcl - po, pct: ((pcl - po) / po) * 100 } : { chg: 0, pct: 0 };
      const chg = closed ? prevMove.chg : (typeof t.todaysChange === 'number' ? t.todaysChange : null);
      const pct = closed ? prevMove.pct : (typeof t.todaysChangePerc === 'number' ? t.todaysChangePerc : null);
      quotes[t.ticker] = {
        sym: t.ticker,
        last: last == null ? null : Math.round(last * 100) / 100,
        chg: chg == null ? null : Math.round(chg * 100) / 100,
        pct: pct == null ? null : Math.round(pct * 100) / 100,
        vol: t.day?.v ?? null,
        pc: t.prevDay?.c ?? null,
        hi: t.day?.h ?? null,
        lo: t.day?.l ?? null,
        t: t.updated ? new Date(Math.floor(t.updated / 1e6)).toISOString().slice(11, 19) : null,
      };
    }
    const body = { ok: true, quotes };
    if (quoteCache.size > 300) quoteCache.delete(quoteCache.keys().next().value);
    quoteCache.set(key, { at: now, body });
    try { tape.ingest(quotes); } catch { /* the tape must never break quotes */ }
    return body;
  }

  // ---- history bars: the Analyst Dashboard's fast lane (owner call 2026-09-09) ----
  // Same provider, same timeframe table and same response shape as the WordPress /sml/v1/history route, minus the
  // ~2s WordPress bootstrap. 20s cache for intraday, 30min for daily+; a failed upstream serves the last copy as stale.
  const HISTORY_TF = { '1m': [1, 'minute', 5], '3m': [3, 'minute', 10], '5m': [5, 'minute', 15], '10m': [10, 'minute', 30], '15m': [15, 'minute', 45], '30m': [30, 'minute', 90], '1h': [1, 'hour', 180], '2h': [2, 'hour', 365], '4h': [4, 'hour', 730], '1D': [1, 'day', 1825], '1W': [1, 'week', 3650], '1M': [1, 'month', 7300], '1Q': [1, 'quarter', 18250] };
  const historyCache = new Map(); // 'SYM|tf' -> { at, body }
  app.get('/api/history', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    const sym = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 15);
    const tf = String(req.query.tf || '15m');
    const cfg = HISTORY_TF[tf];
    if (!sym || !cfg) return res.status(400).json({ ok: false, reason: 'bad-request', bars: [] });
    if (!MASSIVE_KEY) return res.status(404).json({ ok: false, reason: 'no-key', bars: [] });
    const key = `${sym}|${tf}`;
    const now = Date.now();
    const ttl = ['1D', '1W', '1M', '1Q'].includes(tf) ? 30 * 60 * 1000 : 20 * 1000;
    const hit = historyCache.get(key);
    if (hit && now - hit.at < ttl) return res.json(hit.body);
    const day = 86400000;
    const to = new Date(now).toISOString().slice(0, 10);
    const from = new Date(now - cfg[2] * day).toISOString().slice(0, 10);
    try {
      const url = `${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${cfg[0]}/${cfg[1]}/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${MASSIVE_KEY}` }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`massive ${r.status}`);
      const j = await r.json();
      const bars = (Array.isArray(j.results) ? j.results : [])
        .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
        .map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw, n: b.n, source: 'massive-rest', quality: 'authoritative' }));
      const body = { ok: true, bars, symbol: sym, tf, source: 'massive-rest', quality: 'authoritative', asOf: now, resultCount: bars.length };
      if (historyCache.size > 500) historyCache.delete(historyCache.keys().next().value);
      historyCache.set(key, { at: now, body });
      return res.json(body);
    } catch {
      if (hit) return res.json({ ...hit.body, stale: true });
      return res.status(502).json({ ok: false, reason: 'upstream-error', bars: [] });
    }
  });

  // ---- generic bars for the dashboard chart (the WP /sml/v1/dash-bars contract: symbol, mult, unit, days) ----
  const UNITS = new Set(['minute', 'hour', 'day', 'week', 'month']);
  const barsCache = new Map(); // 'SYM|mult|unit|days' -> { at, body }
  app.get('/api/bars', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    const sym = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 15);
    const mult = Math.max(1, Math.min(60, parseInt(String(req.query.mult || '1'), 10) || 1));
    const unit = String(req.query.unit || 'minute');
    const days = Math.max(1, Math.min(3650, parseInt(String(req.query.days || '2'), 10) || 2));
    if (!sym || !UNITS.has(unit)) return res.status(400).json({ available: false, reason: 'bad-request', bars: [] });
    if (!MASSIVE_KEY) return res.status(404).json({ available: false, reason: 'no-key', bars: [] });
    const key = `${sym}|${mult}|${unit}|${days}`;
    const now = Date.now();
    const ttl = unit === 'minute' || unit === 'hour' ? 20 * 1000 : 30 * 60 * 1000;
    const hit = barsCache.get(key);
    if (hit && now - hit.at < ttl) return res.json(hit.body);
    const day = 86400000;
    const to = new Date(now).toISOString().slice(0, 10);
    const from = new Date(now - days * day).toISOString().slice(0, 10);
    try {
      const url = `${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${mult}/${unit}/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${MASSIVE_KEY}` }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`massive ${r.status}`);
      const j = await r.json();
      const bars = (Array.isArray(j.results) ? j.results : [])
        .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
        .map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
      const sessions = new Set(bars.map((b) => new Date(b.t).toISOString().slice(0, 10))).size;
      const body = { available: bars.length > 0, bars, asof: now, source: 'massive-rest', session_count: sessions };
      if (barsCache.size > 500) barsCache.delete(barsCache.keys().next().value);
      barsCache.set(key, { at: now, body });
      return res.json(body);
    } catch {
      if (hit) return res.json({ ...hit.body, stale: true });
      return res.status(502).json({ available: false, reason: 'upstream-error', bars: [] });
    }
  });

  // ---- symbol universe: instant ticker suggestions (owner call 2026-09-09) ----
  // Every active US stock/ETF/ADR listing (Massive reference tickers, ~10k rows) is held in memory and refreshed daily.
  // /api/symbols?q= answers a prefix search in ~1ms; /api/symbols/all ships the compact list so the page can answer
  // suggestions locally with zero network. Shape mirrors the WP /sml/v1/symbol-directory results.
  const EXCH = { XNYS: 'NYSE', XNAS: 'NASDAQ', ARCX: 'NYSE ARCA', BATS: 'CBOE', XASE: 'NYSE AMERICAN', XCBO: 'CBOE', IEXG: 'IEX', OTCM: 'OTC' };
  const TYPE = { CS: 'STOCK', ETF: 'ETF', ADRC: 'ADR', ETN: 'ETN', ETV: 'ETF', PFD: 'PREFERRED', FUND: 'FUND', UNIT: 'UNIT', WARRANT: 'WARRANT', RIGHT: 'RIGHT', SP: 'SP', ETS: 'ETF', OS: 'STOCK', GDR: 'GDR', ADRP: 'ADR', ADRR: 'ADR' };
  let universe = []; // [{ s, n, e, t }] sorted by symbol
  let universeAt = 0, universeLoading = null;
  async function loadUniverse() {
    if (!MASSIVE_KEY) return;
    if (universeLoading) return universeLoading;
    universeLoading = (async () => {
      const rows = [];
      let url = `${MASSIVE_BASE}/v3/reference/tickers?market=stocks&active=true&limit=1000&sort=ticker&order=asc`;
      for (let page = 0; page < 40 && url; page += 1) {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${MASSIVE_KEY}` }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`massive ${r.status}`);
        const j = await r.json();
        for (const t of (j.results || [])) {
          if (!t.ticker || !/^[A-Z0-9.\-]{1,10}$/.test(t.ticker)) continue;
          rows.push({ s: t.ticker, n: String(t.name || '').slice(0, 80), e: EXCH[t.primary_exchange] || (t.primary_exchange || ''), t: TYPE[t.type] || (t.type || 'STOCK') });
        }
        url = j.next_url ? (j.next_url.includes('apiKey=') ? j.next_url : j.next_url) : '';
      }
      if (rows.length > 1000) { rows.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)); universe = rows; universeAt = Date.now(); }
    })().catch(() => {}).finally(() => { universeLoading = null; });
    return universeLoading;
  }
  if (MASSIVE_KEY && options.symbolUniverse !== false) {
    setTimeout(() => { loadUniverse(); }, 3000);
    setInterval(() => { loadUniverse(); }, 24 * 60 * 60 * 1000).unref?.();
  }
  function symbolRow(x) {
    const exch = x.e || '';
    return { symbol: x.s, code: `US.${x.s}`, name: x.n, exchange: exch, type: x.t, source: 'StockMarketLoop market directory', verified: true, tradable: true, message: 'Verified active U.S. market listing.', tradingview_symbol: `${exch === 'NYSE ARCA' ? 'AMEX' : exch.replace(/\s.*$/, '')}:${x.s}`, terminal_url: `https://stockmarketloop.com/stock-chart/?symbol=${encodeURIComponent(x.s)}&exchange=${encodeURIComponent(exch)}`, community_url: `https://stockmarketloop.com/stock-chart/?symbol=${encodeURIComponent(x.s)}`, has_moomoo_community_id: false };
  }
  const POPULAR_SYMS = 'SPY QQQ NVDA AAPL TSLA MSFT AMD META AMZN GOOGL GOOG NFLX COIN AVGO SMCI PLTR SOFI RIVN MSTR INTC MU CRM ORCL ADBE UBER ABNB SHOP PYPL HOOD DKNG BA CAT DIS NKE SBUX MCD WMT COST TGT HD JPM BAC WFC GS MS V MA XOM CVX OXY COP PFE MRNA JNJ LLY UNH ABBV AMGN T VZ TMUS F GM NIO LCID CCL AAL UAL DAL MARA RIOT CLSK GME AMC SOUN BBAI IONQ RGTI QUBT ARM SNOW NET DDOG CRWD PANW ROKU SPOT IWM DIA VXX TQQQ SQQQ SOXL SOXS UVXY TLT GLD SLV USO XLF XLE XLK ARKK BRK.B TSM BABA JD PDD BIDU NVO ASML LMT RTX NOC GE HON IBM CSCO QCOM TXN AMAT LRCX KLAC MRVL ON MCHP ADI ANET DELL HPQ WDC STX SNDK'.split(' ');
  const POP_RANK = new Map(POPULAR_SYMS.map((s, i) => [s, i + 1]));
  // company-name aliases: a typed prefix of a well-known name surfaces its ticker (TES → TSLA, APPLE → AAPL)
  const ALIAS_MAP = 'TESLA:TSLA APPLE:AAPL GOOGLE:GOOGL ALPHABET:GOOGL AMAZON:AMZN MICROSOFT:MSFT NVIDIA:NVDA FACEBOOK:META META:META NETFLIX:NFLX DISNEY:DIS WALMART:WMT COSTCO:COST BOEING:BA NIKE:NKE STARBUCKS:SBUX MCDONALDS:MCD COINBASE:COIN PALANTIR:PLTR SPDR:SPY SP500:SPY NASDAQ:QQQ BERKSHIRE:BRK.B INTEL:INTC MICRON:MU ORACLE:ORCL SALESFORCE:CRM ADOBE:ADBE UBER:UBER AIRBNB:ABNB SHOPIFY:SHOP PAYPAL:PYPL ROBINHOOD:HOOD DRAFTKINGS:DKNG CATERPILLAR:CAT HOMEDEPOT:HD JPMORGAN:JPM CHASE:JPM GOLDMAN:GS MORGANSTANLEY:MS VISA:V MASTERCARD:MA EXXON:XOM CHEVRON:CVX PFIZER:PFE MODERNA:MRNA JOHNSON:JNJ LILLY:LLY UNITEDHEALTH:UNH VERIZON:VZ TMOBILE:TMUS FORD:F GENERALMOTORS:GM RIVIAN:RIVN LUCID:LCID CARNIVAL:CCL AMERICANAIRLINES:AAL UNITEDAIRLINES:UAL DELTA:DAL GAMESTOP:GME SOUNDHOUND:SOUN SNOWFLAKE:SNOW CLOUDFLARE:NET DATADOG:DDOG CROWDSTRIKE:CRWD PALOALTO:PANW SPOTIFY:SPOT RUSSELL:IWM DOWJONES:DIA GOLD:GLD SILVER:SLV OIL:USO TAIWAN:TSM TSMC:TSM ALIBABA:BABA NOVONORDISK:NVO LOCKHEED:LMT BROADCOM:AVGO SUPERMICRO:SMCI MICROSTRATEGY:MSTR STRATEGY:MSTR MARATHON:MARA CISCO:CSCO QUALCOMM:QCOM TEXASINSTRUMENTS:TXN APPLIED:AMAT LAMRESEARCH:LRCX MARVELL:MRVL DELL:DELL HEWLETT:HPQ WESTERNDIGITAL:WDC SEAGATE:STX SANDISK:SNDK IBM:IBM HONEYWELL:HON GENERALELECTRIC:GE RAYTHEON:RTX NORTHROP:NOC AMD:AMD ARM:ARM'.split(' ').map((x) => x.split(':'));
  function aliasHits(q) { q = String(q || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (q.length < 2) return []; const out = []; const seen = new Set(); for (const [name, sym] of ALIAS_MAP) { if (name.startsWith(q) && !seen.has(sym)) { seen.add(sym); out.push(sym); } } return out; }
  function searchUniverse(q, type, limit) {
    q = String(q || '').trim().toUpperCase(); const out = []; const seen = new Set();
    const want = (x) => type === 'all' || !type || (/^etfs?$/.test(type) ? x.t === 'ETF' : /^stocks?$/.test(type) ? x.t !== 'ETF' : true);
    const push = (x) => { if (!seen.has(x.s) && want(x)) { seen.add(x.s); out.push(x); } };
    if (!q) { for (const x of universe) { push(x); if (out.length >= limit) break; } return out; }
    for (const x of universe) { if (x.s === q) push(x); }
    const al = aliasHits(q); if (al.length) { const bySym = new Map(universe.map((x) => [x.s, x])); for (const sym of al) { const x = bySym.get(sym); if (x) push(x); } }
    // well-known names first among prefix matches (NV → NVDA before NVA), then alphabetical
    const pre = universe.filter((x) => x.s !== q && x.s.startsWith(q)).sort((a, b) => (POP_RANK.get(a.s) || 9999) - (POP_RANK.get(b.s) || 9999) || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
    for (const x of pre) { if (out.length >= limit) break; push(x); }
    const ql = q.toLowerCase();
    const np = universe.filter((x) => x.n.toLowerCase().startsWith(ql)).sort((a, b) => (POP_RANK.get(a.s) || 9999) - (POP_RANK.get(b.s) || 9999) || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
    for (const x of np) { if (out.length >= limit) break; push(x); }
    for (const x of universe) { if (out.length >= limit) break; if (x.s.includes(q) || x.n.toLowerCase().includes(ql)) push(x); }
    return out.slice(0, limit);
  }
  app.get('/api/symbols/all', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (!universe.length) { res.set('Cache-Control', 'no-store'); return res.status(503).json({ ok: false, reason: universeLoading ? 'loading' : 'empty', at: universeAt }); }
    res.set('Cache-Control', 'public, max-age=3600');
    return res.json({ ok: true, at: universeAt, count: universe.length, rows: universe.map((x) => [x.s, x.n, x.e, x.t]) });
  });
  app.get('/api/symbols', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    if (!universe.length) return res.status(503).json({ available: false, reason: universeLoading ? 'loading' : 'empty', results: [] });
    const q = String(req.query.q || '').replace(/[^A-Za-z0-9.\- &']/g, '').slice(0, 30);
    const type = String(req.query.type || 'all').toLowerCase();
    const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit || '12'), 10) || 12));
    const rows = searchUniverse(q, type, limit).map(symbolRow);
    return res.json({ available: true, query: q, count: rows.length, results: rows, source: 'render-universe' });
  });

  app.get('/api/quotes', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    if (!MASSIVE_KEY) return res.json({ ok: false, reason: 'no-key', quotes: {} });
    const syms = String(req.query.symbols || DEFAULT_SYMS)
      .toUpperCase().replace(/[^A-Z0-9,.\-]/g, '').split(',').filter(Boolean).slice(0, 60);
    try {
      return res.json(await fetchQuoteSet(syms));
    } catch {
      const hit = quoteCache.get(syms.join(','));
      if (hit && Date.now() - hit.at < 60000) return res.json({ ...hit.body, stale: true });
      return res.json({ ok: false, reason: 'upstream-error', quotes: {} });
    }
  });

  // Server-side Market Monitor ingest: keep the tape populated across a broad,
  // market-wide universe continuously — independent of who is viewing. The
  // stocks plan is unlimited, so one ~50-symbol snapshot every 45s (~1.3
  // calls/min) is trivial. The tape engine gates stocks to market hours; BTC
  // ingests around the clock. TAPE_SYMBOLS env overrides the default set.
  const TAPE_UNIVERSE = String(process.env.TAPE_SYMBOLS ||
    'SPY,QQQ,IWM,DIA,SOXX,BTC,NVDA,TSLA,AAPL,MSFT,AMD,META,AMZN,GOOGL,NFLX,AVGO,MU,SMCI,PLTR,COIN,MSTR,MARA,RIOT,SOFI,HOOD,NIO,F,BAC,INTC,CSCO,DIS,BABA,UBER,SHOP,SNAP,PYPL,ROKU,DKNG,PLUG,IONQ,RIVN,LCID,GME,AMC,TSM,ARM,DELL,CRWD,NET,SNOW')
    .toUpperCase().replace(/[^A-Z0-9,.\-]/g, '').split(',').filter(Boolean).slice(0, 60);
  let tapeIngestTimer = null;
  if (MASSIVE_KEY && options.tapeIngest !== false) {
    tapeIngestTimer = setInterval(() => { fetchQuoteSet(TAPE_UNIVERSE).catch(() => {}); }, 45000);
    if (tapeIngestTimer.unref) tapeIngestTimer.unref();
  }

  // Market Monitor tape backfill: pure memory read, no upstream calls.
  app.get('/api/tape', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    try { return res.json(tape.snapshot()); } catch { return res.json({ ok: false, events: [], counts: { bull: 0, bear: 0 } }); }
  });

  // Company logo per ticker, via massive.com ticker branding. Image bytes are
  // cached in memory (7d, misses 1h) so massive is hit at most once per symbol.
  const logoCache = new Map(); // SYM -> { at, type, buf } (buf null = known miss)
  // Watch deck: the site's watch index (public /watch/ videos + live streams, searchable) plus the
  // desk's viewer count; a YouTube desk stream from /watch/ when nothing else is on air. 20s cache per query.
  const watchCache = new Map();
  const ytLiveCache = new Map();   // video id -> { at, live }: YouTube's own "isLiveNow" flag, 60s
  async function youtubeIsLive(id) {
    const hit = ytLiveCache.get(id);
    if (hit && Date.now() - hit.at < 60000) return hit.live;
    let live = false;
    try {
      const html = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(id), { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' }, signal: AbortSignal.timeout(6000) }).then((r) => r.text());
      live = /"isLiveNow"\s*:\s*true/.test(html);
    } catch { live = false; }
    if (ytLiveCache.size > 100) ytLiveCache.clear();
    ytLiveCache.set(id, { at: Date.now(), live });
    return live;
  }
  app.get('/api/watch', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    try {
      const hit = watchCache.get(q);
      if (hit && Date.now() - hit.at < 20000) return res.json(hit.body);
      const handle = 'grandmasterobi';
      const tasks = await Promise.allSettled([
        fetch('https://stockmarketloop.com/wp-json/sml-watch-index/v1/index?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(8000) }).then((r) => r.json()),
        fetch(`https://stockmarketloop.com/wp-json/sml-lw/v1/presence?handle=${handle}`, { signal: AbortSignal.timeout(7000) }).then((r) => r.json()),
        q ? Promise.resolve('') : fetch('https://stockmarketloop.com/watch/', { redirect: 'follow', signal: AbortSignal.timeout(9000) }).then((r) => r.text()),
      ]);
      const body = { live: [], videos: [], viewers: 0 };
      const idx = tasks[0].status === 'fulfilled' ? tasks[0].value : null;
      if (idx && typeof idx === 'object') {
        body.live = Array.isArray(idx.live) ? idx.live : [];
        body.videos = Array.isArray(idx.videos) ? idx.videos : [];
      }
      const page = tasks[2].status === 'fulfilled' ? String(tasks[2].value || '') : '';
      if (page && !body.live.some((l) => l && l.src)) {
        const yt = /youtube\.com\/(?:live\/|watch\?v=|embed\/)([A-Za-z0-9_-]{8,14})/.exec(page);
        if (yt) {
          const ogTitle = /<meta property="og:title" content="([^"]+)"/.exec(page);
          const item = { id: 'yt-' + yt[1], title: (ogTitle && ogTitle[1]) || 'Loop Live Desk', ytId: yt[1], url: 'https://stockmarketloop.com/live/', creator: 'Loop Desk', handle };
          /* only a stream YouTube itself reports as on air is a LIVE row; otherwise the desk video is an ordinary video */
          if (await youtubeIsLive(yt[1])) body.live.unshift({ ...item, kind: 'live', status: 'live' });
          else body.videos.unshift({ ...item, kind: 'vod', date: '' });
        }
      }
      const pres = tasks[1].status === 'fulfilled' ? tasks[1].value : null;
      if (pres && typeof pres.count === 'number') body.viewers = pres.count;
      if (watchCache.size > 200) watchCache.clear();
      watchCache.set(q, { at: Date.now(), body });
      res.json(body);
    } catch {
      res.status(502).json({ message: 'watch sources unavailable' });
    }
  });

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
    if (tapeIngestTimer) { clearInterval(tapeIngestTimer); tapeIngestTimer = null; }
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  return { app, server, close };
}
