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

const q = (sym, last, pct, vol, hi = null, lo = null) => ({ [sym]: { sym, last, pct, vol, hi, lo } });

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
