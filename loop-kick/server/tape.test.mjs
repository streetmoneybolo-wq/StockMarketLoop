import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTapeEngine } from './tape.mjs';

function makeEngine({ open = true } = {}) {
  let t = 1_700_000_000_000;
  const engine = createTapeEngine({ now: () => t, sessionOpen: () => open });
  return {
    engine,
    tick(ms, quotes) { t += ms; engine.ingest(quotes); },
    at: () => t,
  };
}

const q = (sym, last, pct, vol, hi = null, lo = null, pc = null) => ({ [sym]: { sym, last, pct, vol, hi, lo, pc } });

test('unchanged snapshots produce no samples and no events', () => {
  const { engine, tick } = makeEngine();
  for (let i = 0; i < 20; i++) tick(10_000, q('SPY', 500, 0.1, 1_000_000));
  assert.equal(engine.snapshot().events.length, 0);
});

test('sharp rise fires on a fast move and cooldown blocks a repeat', () => {
  const { engine, tick } = makeEngine();
  // build a calm 6-minute baseline
  for (let i = 0; i < 36; i++) tick(10_000, q('SPY', 500 + i * 0.01, 0.10 + i * 0.002, 1_000_000 + i * 10_000));
  // +0.9% day-change jump inside the 5-min window
  tick(10_000, q('SPY', 505, 1.05, 1_400_000));
  let ev = engine.snapshot().events;
  const sharp = ev.find((e) => e.family === 'SHARP_RISE');
  assert.ok(sharp, 'expected SHARP_RISE');
  assert.equal(sharp.dir, 1);
  // another jump 2 min later is inside the 10-min family cooldown
  tick(120_000, q('SPY', 510, 2.0, 1_500_000));
  ev = engine.snapshot().events.filter((e) => e.family === 'SHARP_RISE');
  assert.equal(ev.length, 1);
});

test('huge volume fires with direction from price', () => {
  const { engine, tick } = makeEngine();
  for (let i = 0; i < 12; i++) tick(10_000, q('AMD', 150 + i * 0.01, 0.1, 2_000_000 + i * 20_000));
  // ~10x the interval-volume rate, price down-tick
  tick(10_000, q('AMD', 149.9, 0.05, 2_240_000 + 200_000));
  const ev = engine.snapshot().events.find((e) => e.family === 'HVOL_DN');
  assert.ok(ev, 'expected HVOL_DN');
  assert.equal(ev.dir, -1);
  assert.ok(ev.vol >= 200_000);
});

test('7%+ crossing fires once', () => {
  const { engine, tick } = makeEngine();
  tick(10_000, q('SOUN', 10, 6.5, 5_000_000));
  tick(10_000, q('SOUN', 10.1, 7.2, 5_200_000));
  tick(10_000, q('SOUN', 10.2, 7.9, 5_400_000));
  const ev = engine.snapshot().events.filter((e) => e.family === 'RISE7');
  assert.equal(ev.length, 1);
});

test('top reversal needs a high touch then a pull', () => {
  const { engine, tick } = makeEngine();
  // rides at the day high, then pulls back 0.7% with a negative 5-min move
  for (let i = 0; i < 30; i++) tick(10_000, q('TSLA', 300 + i * 0.001, 1.0 + i * 0.001, 1_000_000 + i * 10_000, 300.05, 290));
  tick(10_000, q('TSLA', 297.9, 0.3, 1_320_000, 300.05, 290));
  const ev = engine.snapshot().events.find((e) => e.family === 'TOP_REV');
  assert.ok(ev, 'expected TOP_REV');
  assert.equal(ev.dir, -1);
});

test('closed session ignores stocks but BTC still runs price families', () => {
  const { engine, tick } = makeEngine({ open: false });
  for (let i = 0; i < 36; i++) {
    tick(10_000, { ...q('SPY', 500 + i, 0.1 + i, 1_000_000 * i), ...q('BTC', 77_000 + i * 5, 0.05 + i * 0.003, null) });
  }
  tick(10_000, { ...q('SPY', 600, 9, 99_000_000), ...q('BTC', 78_100, 1.5, null) });
  const fams = engine.snapshot().events.map((e) => `${e.sym}:${e.family}`);
  assert.ok(fams.some((f) => f.startsWith('BTC:')), 'BTC should fire');
  assert.ok(!fams.some((f) => f.startsWith('SPY:')), 'closed-session stock must not fire');
});

test('BTC detects moves even though its 24h notional volume jitters down', () => {
  const { engine, tick } = makeEngine({ open: false });
  // vol wobbles up AND down every sample — must not wipe the ring; the
  // baseline must outlast the 10-min Skyrocket window
  for (let i = 0; i < 70; i++) tick(10_000, q('BTC', 77_000 + i, 0.05 + i * 0.001, 5_000_000_000 + (i % 2 ? -3_000_000 : 4_000_000)));
  tick(10_000, q('BTC', 79_600, 3.4, 5_010_000_000));
  const fams = engine.snapshot().events.map((e) => e.family);
  assert.ok(fams.includes('SKYROCKET'), 'expected SKYROCKET, got ' + fams.join(','));
});

test('a pct-baseline rebase (UTC-midnight open / new prev close) never fires', () => {
  const { engine, tick } = makeEngine({ open: false });
  // steady +4% day all evening, price flat
  for (let i = 0; i < 36; i++) tick(10_000, q('BTC', 77_000, 4.0, null, null, null, 74_000));
  // midnight UTC: pct rebases to ~0 with the SAME price — must be silent
  tick(10_000, q('BTC', 77_000, 0.01, null, null, null, 76_990));
  tick(10_000, q('BTC', 77_005, 0.02, null, null, null, 76_990));
  assert.equal(engine.snapshot().events.length, 0);
});

test('a hostile flood of symbols stays bounded', () => {
  const { engine, tick } = makeEngine();
  for (let batch = 0; batch < 10; batch++) {
    const quotes = {};
    for (let i = 0; i < 60; i++) {
      const sym = 'FAKE' + batch + '_' + i;
      quotes[sym] = { sym, last: 10 + i, pct: 0.1, vol: 1_000_000 + batch };
    }
    tick(10_000, quotes);
  }
  assert.ok(engine.snapshot().universe.length <= 200, 'universe must stay capped');
});

test('counts tally bullish vs bearish', () => {
  const { engine, tick } = makeEngine();
  // volume kept at its baseline rate so only the price family fires
  for (let i = 0; i < 36; i++) tick(10_000, q('NVDA', 180 + i * 0.01, 0.1, 3_000_000 + i * 30_000));
  tick(10_000, q('NVDA', 182.5, 1.2, 4_110_000));
  const s = engine.snapshot();
  assert.equal(s.counts.bull, 1);
  assert.equal(s.counts.bear, 0);
  assert.ok(s.universe.includes('NVDA'));
});
