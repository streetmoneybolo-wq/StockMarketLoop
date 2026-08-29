/**
 * Market Monitor tape engine — honest unusual-activity detection from the
 * quote snapshots the server ALREADY fetches for /api/quotes clients.
 *
 * Zero extra provider load by design: ingest() is fed from the /api/quotes
 * cache-fill path only. No tick data exists here, so the families are the ones
 * consecutive snapshots can truly support (sharp/extreme moves, 7%+ day
 * crossings, interval-volume spikes, day-high/low reversals). Block trades and
 * order-flow families are deliberately absent — they would be fabrication.
 *
 * Honesty gates: a snapshot with unchanged price+volume adds no sample (a
 * closed market produces silence, not noise); stocks only ingest during the
 * regular 9:30–16:00 ET session; BTC (24/7, no day hi/lo or interval volume in
 * its feed) runs price-move families only, around the clock.
 */

const RING_MS = 45 * 60e3;
const MAX_EVENTS = 300;
const FRESH_MS = 30 * 60e3;

const T = {
  SHARP_PCT: 0.5,   // |Δ day-%| over ~5 min
  SKY_PCT: 2.0,     // |Δ day-%| over ~10 min
  DAY7: 7,          // day-change crossing
  HVOL_RATIO: 4,    // interval volume rate vs median rate
  HVOL_MIN: 25000,  // min interval shares so illiquid noise can't fire
  REV_BAND: 0.0012, // "touched" the day high/low within 0.12%
  REV_PULL: 0.005,  // pulled back 0.5% from that extreme
};

const COOLDOWN_MS = { default: 10 * 60e3, RISE7: 4 * 3600e3, FALL7: 4 * 3600e3 };
const SYM_GAP_MS = 90e3;

const BULLISH = new Set(['SHARP_RISE', 'SKYROCKET', 'RISE7', 'HVOL_UP', 'BOT_REB']);

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function etParts(ts) {
  const p = {};
  for (const { type, value } of etFmt.formatToParts(new Date(ts))) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    hms: `${p.hour}:${p.minute}:${p.second}`,
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function createTapeEngine(opts = {}) {
  const now = opts.now || (() => Date.now());
  const sessionOpen = opts.sessionOpen || ((ts) => {
    const et = etParts(ts);
    return !['Sat', 'Sun'].includes(et.weekday) && et.minutes >= 570 && et.minutes < 960; // 9:30–16:00
  });

  const rings = new Map();      // SYM -> [{ts,last,pct,vol,hi,lo}]
  const cooldowns = new Map();  // 'SYM:FAMILY' -> ts
  const symLast = new Map();    // SYM -> ts of last event
  let events = [];              // newest LAST internally
  let seq = 0;
  let counts = { date: etParts(now()).date, bull: 0, bear: 0 };

  function rollDay(ts) {
    const date = etParts(ts).date;
    if (date !== counts.date) counts = { date, bull: 0, bear: 0 };
  }

  function fire(ts, sym, family, data) {
    const cdKey = `${sym}:${family}`;
    const cd = COOLDOWN_MS[family] || COOLDOWN_MS.default;
    if ((cooldowns.get(cdKey) || 0) > ts - cd) return false;
    const sl = symLast.get(sym) || 0;
    if (sl !== ts && sl > ts - SYM_GAP_MS) return false; // same-tick multi-family is fine
    cooldowns.set(cdKey, ts);
    symLast.set(sym, ts);
    const dir = BULLISH.has(family) ? 1 : -1;
    if (dir > 0) counts.bull += 1; else counts.bear += 1;
    events.push({ id: ++seq, ts, et: etParts(ts).hms, sym, family, dir, ...data });
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    return true;
  }

  function sampleAt(ring, target) {
    let best = null;
    for (const s of ring) { if (s.ts <= target) best = s; else break; }
    return best;
  }

  function detect(sym, ring, q, ts, isBtc) {
    const d = (base) => (base && Number.isFinite(base.pct) && Number.isFinite(q.pct)) ? q.pct - base.pct : null;
    const b5 = sampleAt(ring, ts - 5 * 60e3);
    const b10 = sampleAt(ring, ts - 10 * 60e3);
    const d5 = d(b5);
    const d10 = d(b10);
    const prev = ring.length > 1 ? ring[ring.length - 2] : null;
    let firedMove = false;

    // extreme move first; a Skyrocket should not also print as Sharp Rise
    if (d10 !== null && Math.abs(d10) >= T.SKY_PCT) {
      firedMove = fire(ts, sym, d10 > 0 ? 'SKYROCKET' : 'NOSEDIVE', { pct: q.pct, move: r2(d10) });
    }
    if (!firedMove && d5 !== null && Math.abs(d5) >= T.SHARP_PCT) {
      fire(ts, sym, d5 > 0 ? 'SHARP_RISE' : 'SHARP_FALL', { pct: q.pct, move: r2(d5) });
    }

    if (prev && Number.isFinite(prev.pct) && Number.isFinite(q.pct)) {
      if (prev.pct < T.DAY7 && q.pct >= T.DAY7) fire(ts, sym, 'RISE7', { pct: q.pct });
      if (prev.pct > -T.DAY7 && q.pct <= -T.DAY7) fire(ts, sym, 'FALL7', { pct: q.pct });
    }

    if (!isBtc && prev && Number.isFinite(q.vol) && Number.isFinite(prev.vol) && ring.length >= 6) {
      const dv = q.vol - prev.vol;
      const dt = ts - prev.ts;
      if (dv >= T.HVOL_MIN && dt > 0) {
        const rates = [];
        for (let i = 1; i < ring.length - 1; i++) {
          const rv = ring[i].vol - ring[i - 1].vol;
          const rt = ring[i].ts - ring[i - 1].ts;
          if (Number.isFinite(rv) && rv > 0 && rt > 0) rates.push(rv / rt);
        }
        const base = median(rates);
        if (base > 0 && (dv / dt) / base >= T.HVOL_RATIO) {
          const pdir = q.last - prev.last;
          if (pdir !== 0) fire(ts, sym, pdir > 0 ? 'HVOL_UP' : 'HVOL_DN', { pct: q.pct, vol: dv });
        }
      }
    }

    if (!isBtc && Number.isFinite(q.hi) && q.hi > 0 && Number.isFinite(q.lo) && q.lo > 0) {
      const cut = ts - FRESH_MS;
      const touchedHi = ring.some((s) => s.ts >= cut && s.last >= q.hi * (1 - T.REV_BAND));
      const touchedLo = ring.some((s) => s.ts >= cut && s.last <= q.lo * (1 + T.REV_BAND));
      if (touchedHi && (q.hi - q.last) / q.hi >= T.REV_PULL && d5 !== null && d5 < 0) {
        fire(ts, sym, 'TOP_REV', { pct: q.pct, move: r2(d5) });
      }
      if (touchedLo && (q.last - q.lo) / q.lo >= T.REV_PULL && d5 !== null && d5 > 0) {
        fire(ts, sym, 'BOT_REB', { pct: q.pct, move: r2(d5) });
      }
    }
  }

  function r2(x) { return Math.round(x * 100) / 100; }

  function ingest(quotes) {
    const ts = now();
    rollDay(ts);
    const open = sessionOpen(ts);
    for (const sym of Object.keys(quotes || {})) {
      const q = quotes[sym];
      if (!q || !Number.isFinite(q.last) || q.last <= 0) continue;
      const isBtc = sym === 'BTC';
      if (!isBtc && !open) continue;
      let ring = rings.get(sym);
      if (!ring) { ring = []; rings.set(sym, ring); }
      const prev = ring[ring.length - 1];
      // day-volume reset (new session) invalidates every window — start clean
      if (prev && Number.isFinite(prev.vol) && Number.isFinite(q.vol) && q.vol < prev.vol) ring.length = 0;
      // unchanged price+volume carries no information (closed/quiet feed)
      if (prev && prev.last === q.last && prev.vol === q.vol) continue;
      ring.push({ ts, last: q.last, pct: Number.isFinite(q.pct) ? q.pct : null, vol: Number.isFinite(q.vol) ? q.vol : null, hi: Number.isFinite(q.hi) ? q.hi : null, lo: Number.isFinite(q.lo) ? q.lo : null });
      while (ring.length && ring[0].ts < ts - RING_MS) ring.shift();
      detect(sym, ring, q, ts, isBtc);
    }
  }

  function snapshot() {
    const ts = now();
    rollDay(ts);
    const universe = [];
    for (const [sym, ring] of rings) {
      if (ring.length && ring[ring.length - 1].ts >= ts - FRESH_MS) universe.push(sym);
    }
    return {
      ok: true,
      events: [...events].reverse(),
      counts: { bull: counts.bull, bear: counts.bear, date: counts.date },
      session: { open: sessionOpen(ts), et: etParts(ts).hms },
      universe: universe.sort(),
    };
  }

  return { ingest, snapshot };
}
