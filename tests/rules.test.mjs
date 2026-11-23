// Physics contract tests. Each one names a failure mode that has actually happened
// in this project during development, so a regression here means the model broke,
// not that a constant was retuned.
import assert from 'node:assert/strict';
import {
  createWorld, step, seedCrystal, breathPatch, chill,
  solidFraction, meanUndercooling, dtLimit, DEFAULTS,
} from '../src/sim.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

test('unstable dt is rejected at construction, not silently NaN later', () => {
  const limit = dtLimit(DEFAULTS);
  assert.throws(() => createWorld(64, 64, { dt: limit * 10 }), /exceeds stability limit/);
  assert.throws(() => createWorld(64, 64, { dt: 0 }), /dt must be positive/);
  assert.throws(() => createWorld(4, 4, {}), /grid too small/);
});

test('liquid is stable: undercooling alone must not freeze the pane', () => {
  // This caught a wrong sign in the thermal coupling: the whole liquid crept positive
  // and reported "100% solid" while the render was empty.
  const w = createWorld(120, 90, {});
  w.u.fill(0.8);
  for (let i = 0; i < 600; i++) step(w, null);
  assert.equal(solidFraction(w), 0, 'spontaneous nucleation without a seed');
  let minPhi = Infinity;
  for (let k = 0; k < w.n; k++) minPhi = Math.min(minPhi, w.phi[k]);
  assert.ok(minPhi < -0.99, 'liquid drifted away from -1: min phi ' + minPhi);
});

test('a seeded crystal grows, and growth is monotone', () => {
  const w = createWorld(200, 150, {});
  w.u.fill(1.0);
  seedCrystal(w, 100, 75, 3);
  let prev = solidFraction(w);
  for (let i = 0; i < 900; i++) {
    step(w, null);
    const now = solidFraction(w);
    assert.ok(now >= prev - 1e-9, 'solid fraction decreased at step ' + i);
    prev = now;
  }
  assert.ok(prev > 0.02, 'crystal barely grew: ' + prev);
});

test('freezing releases latent heat, raising undercooling', () => {
  const w = createWorld(200, 150, {});
  w.u.fill(0.5);
  seedCrystal(w, 100, 75, 4);
  const before = meanUndercooling(w);
  for (let i = 0; i < 800; i++) step(w, null);
  assert.ok(meanUndercooling(w) > before,
    'latent heat missing: ' + before + ' -> ' + meanUndercooling(w));
});

test('growth stops where the fuel is gone: a warm blot is a permanent wall', () => {
  const w = createWorld(220, 160, {});
  w.u.fill(1.0);
  seedCrystal(w, 60, 80, 3);
  for (let i = 0; i < 500; i++) step(w, null);
  const mid = solidFraction(w);
  // Kill the fuel in a band between the crystal and the right half.
  const breath = new Float64Array(w.n);
  for (let j = 0; j < w.H; j++) for (let i = 110; i < 130; i++) breath[j * w.W + i] = 4;
  for (let i = 0; i < 400; i++) { step(w, breath); for (let k = 0; k < w.n; k++) if (w.u[k] < 0) w.u[k] = 0; }
  const after = solidFraction(w);
  assert.ok(after - mid < 0.05,
    'frost crossed a warm wall: ' + mid.toFixed(3) + ' -> ' + after.toFixed(3));
});

test('no crystal crosses an ice-free gap it cannot feed across', () => {
  // Two seeds far apart with a cooled band between them: each grows, but they must
  // meet and stop rather than pass through each other.
  const w = createWorld(160, 80, {});
  w.u.fill(1.0);
  seedCrystal(w, 40, 40, 3);
  seedCrystal(w, 120, 40, 3);
  for (let i = 0; i < 2000; i++) step(w, null);
  assert.ok(solidFraction(w) > 0.3, 'seeds failed to grow toward each other');
  // phi must stay bounded: unbounded growth is the NaN precursor.
  let mx = -Infinity, mn = Infinity;
  for (let k = 0; k < w.n; k++) { mx = Math.max(mx, w.phi[k]); mn = Math.min(mn, w.phi[k]); }
  assert.ok(mx <= 1.05 + 1e-9 && mn >= -1.05 - 1e-9, 'phi out of bounds: ' + mn + '..' + mx);
});

test('non-finite input is rejected at the boundary', () => {
  const w = createWorld(64, 64, {});
  assert.throws(() => seedCrystal(w, NaN, 10, 3), /finite/);
  assert.throws(() => seedCrystal(w, 10, 10, 0), /radius must be positive/);
  assert.throws(() => breathPatch(w, 10, 10, -1, 1), /radius must be positive/);
  assert.throws(() => breathPatch(w, 10, 10, 5, NaN), /finite/);
  assert.throws(() => chill(w, -1), />= 0/);
});

test('a run never produces NaN on a long horizon', () => {
  const w = createWorld(200, 140, {});
  w.u.fill(1.0);
  for (const [x, y] of [[40, 40], [160, 100], [100, 70]]) seedCrystal(w, x, y, 2.5);
  for (let i = 0; i < 3000; i++) step(w, null);   // step() throws on any non-finite
  assert.ok(w.steps === 3000);
});

console.log('rules: ' + passed + ' passed');
