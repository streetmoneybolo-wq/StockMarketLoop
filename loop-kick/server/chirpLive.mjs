/**
 * Group Chirp LIVE — signalling for a peer-to-peer WebRTC audio fan-out (owner call 2026-09-10:
 * "stream as fast as possible, hear it in real time, highest quality").
 *
 * No media touches this server. A speaker (analyst / owner with the group mic) opens one
 * RTCPeerConnection per listener and the audio flows browser-to-browser (TURN from /api/ice when
 * needed). This module only holds the rooms in memory and relays offers / answers / ICE
 * candidates with LONG-POLLING, so a signal reaches its peer within milliseconds instead of on
 * the next fixed-interval poll. Membership and mic rights come from WordPress
 * (GET /sml-group-kick/v1/me through the gateway, cached two minutes per session).
 *
 *   POST /api/chirp-live/join      { group, mode: 'speaker'|'listener' }   → { self, members[], server_time }
 *   POST /api/chirp-live/signal    { group, to, type, payload }            → { ok }
 *   GET  /api/chirp-live/poll?group=ID&wait=1                              → { signals[], members[], server_time }  (holds ≤ 25 s)
 *   POST /api/chirp-live/leave     { group }
 *
 * Every call refreshes the caller's presence; members silent for 50 s are swept.
 */

const ROOM_SWEEP_MS = 15_000;
const MEMBER_TTL_MS = 50_000;
const LONG_POLL_MS = 25_000;
const PERM_TTL_MS = 120_000;
const MAX_QUEUE = 200;

export function mountChirpLive(app, { requireAuth, gateway, allowOrigins = ['https://stockmarketloop.com', 'https://www.stockmarketloop.com'] }) {
  const rooms = new Map();   // gid -> Map<uid, member>
  const perms = new Map();   // token -> { at, groups: Map<gid, { member, canChirp }> }

  function cors(req, res) {
    const origin = String(req.get('origin') || '');
    if (allowOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
    }
    res.set('Cache-Control', 'no-store');
  }
  app.options(['/api/chirp-live/join', '/api/chirp-live/leave', '/api/chirp-live/signal', '/api/chirp-live/poll'], (req, res) => { cors(req, res); res.status(204).end(); });

  function room(gid) {
    let r = rooms.get(gid);
    if (!r) { r = new Map(); rooms.set(gid, r); }
    return r;
  }
  function snapshot(r) {
    const now = Date.now();
    return [...r.values()].filter((m) => now - m.lastSeen < MEMBER_TTL_MS).map((m) => ({ key: m.key, id: m.id, name: m.name, avatar: m.avatar, mode: m.mode, canChirp: m.canChirp, talking: m.talking || 0, channel: m.channel || 0 }));
  }
  async function permission(auth, gid) {
    const cached = perms.get(auth.token);
    if (cached && Date.now() - cached.at < PERM_TTL_MS && cached.groups.has(gid)) return cached.groups.get(gid);
    const me = await gateway(auth.token, 'GET', '/sml-group-kick/v1/me', {});
    const groups = new Map();
    for (const g of me?.groups || []) groups.set(Number(g.id), { member: true, canChirp: !!g.canChirp, name: g.name });
    perms.set(auth.token, { at: Date.now(), groups });
    return groups.get(gid) || { member: false, canChirp: false };
  }
  function wake(member) {
    const waiters = member.waiters; member.waiters = [];
    for (const w of waiters) { try { clearTimeout(w.timer); w.done(); } catch { /* gone */ } }
  }
  function uidOf(auth) { return Number(auth.identity.wpUserId || auth.identity.userId) || 0; }
  function clientOf(req) { return String(req.body?.client || req.query?.client || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'main'; }
  function keyOf(auth, req) { return uidOf(auth) + ':' + clientOf(req); }
  function profileOf(auth) {
    const p = auth.identity.profile || auth.identity;
    return { name: String(p.name || p.handle || 'Member'), avatar: String(p.avatar || '') };
  }

  app.post('/api/chirp-live/join', async (req, res) => {
    cors(req, res);
    const auth = await requireAuth(req, res); if (!auth) return;
    const gid = Number(req.body?.group) || 0; const wantSpeaker = req.body?.mode === 'speaker';
    if (!gid) return res.status(400).json({ error: 'group required' });
    let perm;
    try { perm = await permission(auth, gid); } catch (e) { return res.status(502).json({ error: 'Could not check the group membership: ' + (e.message || 'gateway') }); }
    if (!perm.member) return res.status(403).json({ error: 'Members only.' });
    if (wantSpeaker && !perm.canChirp) return res.status(403).json({ error: 'The group owner has not given you the mic.' });
    const uid = uidOf(auth); const key = keyOf(auth, req); const r = room(gid); const prof = profileOf(auth);
    const existing = r.get(key);
    const m = existing || { key, id: uid, queue: [], waiters: [], talking: 0 };
    Object.assign(m, { name: prof.name, avatar: prof.avatar, mode: wantSpeaker ? 'speaker' : 'listener', canChirp: perm.canChirp, lastSeen: Date.now() });
    r.set(key, m);
    // tell everyone else there is a new peer so a speaker can offer immediately
    for (const other of r.values()) if (other.key !== key) wake(other);
    return res.json({ ok: true, self: key, id: uid, members: snapshot(r), server_time: Date.now() });
  });

  app.post('/api/chirp-live/leave', async (req, res) => {
    cors(req, res);
    const auth = await requireAuth(req, res); if (!auth) return;
    const gid = Number(req.body?.group) || 0; const r = rooms.get(gid);
    if (r) { const key = keyOf(auth, req); const m = r.get(key); if (m) { wake(m); r.delete(key); for (const other of r.values()) wake(other); } }
    return res.json({ ok: true });
  });

  app.post('/api/chirp-live/signal', async (req, res) => {
    cors(req, res);
    const auth = await requireAuth(req, res); if (!auth) return;
    const gid = Number(req.body?.group) || 0; const to = String(req.body?.to || ''); const type = String(req.body?.type || '');
    const r = rooms.get(gid); const from = keyOf(auth, req);
    const me = r && r.get(from);
    if (!me) return res.status(409).json({ error: 'Join the room first.', rejoin: true });
    me.lastSeen = Date.now();
    if (!['offer', 'answer', 'candidate', 'talk', 'hangup'].includes(type)) return res.status(400).json({ error: 'bad signal type' });
    if (type === 'talk') { me.talking = req.body?.payload?.on ? Date.now() : 0; me.channel = Number(req.body?.payload?.channel) || 0; }
    const targets = to ? [r.get(to)].filter(Boolean) : [...r.values()].filter((m) => m.key !== from);
    const sig = { from, fromId: me.id, type, payload: req.body?.payload ?? null, at: Date.now() };
    for (const t of targets) { t.queue.push(sig); if (t.queue.length > MAX_QUEUE) t.queue.splice(0, t.queue.length - MAX_QUEUE); wake(t); }
    return res.json({ ok: true, delivered: targets.length });
  });

  app.get('/api/chirp-live/poll', async (req, res) => {
    cors(req, res);
    const auth = await requireAuth(req, res); if (!auth) return;
    const gid = Number(req.query.group) || 0; const r = rooms.get(gid); const key = keyOf(auth, req);
    const m = r && r.get(key);
    if (!m) return res.status(409).json({ error: 'Join the room first.', rejoin: true });
    m.lastSeen = Date.now();
    const reply = () => {
      const signals = m.queue.splice(0, m.queue.length);
      res.json({ signals, members: snapshot(r), server_time: Date.now() });
    };
    if (m.queue.length || String(req.query.wait) !== '1') return reply();
    // long-poll: answer the moment a signal lands or a peer joins/leaves, else after LONG_POLL_MS with the presence list
    await new Promise((done) => {
      const w = { done, timer: setTimeout(done, LONG_POLL_MS) };
      m.waiters.push(w);
      req.on('close', () => { clearTimeout(w.timer); m.waiters = m.waiters.filter((x) => x !== w); done(); });
    });
    if (!res.headersSent && !res.writableEnded) reply();
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [gid, r] of rooms) {
      for (const [key, m] of r) if (now - m.lastSeen > MEMBER_TTL_MS) { wake(m); r.delete(key); for (const other of r.values()) wake(other); }
      if (!r.size) rooms.delete(gid);
    }
    for (const [token, p] of perms) if (now - p.at > PERM_TTL_MS * 5) perms.delete(token);
  }, ROOM_SWEEP_MS);
  sweeper.unref?.();

  return { rooms, stop: () => clearInterval(sweeper) };
}
