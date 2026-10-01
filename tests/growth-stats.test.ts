import test from 'node:test';
import assert from 'node:assert/strict';
import { benjaminiHochberg, holmAdjust, normalCdf, normalQuantile, sequentialNominalAlpha, spentAlpha, studentTCdf, twoProportionTest, welchTest } from '../packages/growth/stats.js';

const close = (actual: number | null, expected: number, tolerance = 1e-9) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

test('normal distribution matches reference values in the center and tails', () => {
  close(normalCdf(1.959963984540054), 0.975, 1e-12);
  close(normalCdf(0), 0.5);
  close(normalCdf(-3), 0.0013498980316301, 1e-13);
  close(normalCdf(-8) / 6.22096057427178e-16, 1, 1e-9);
  close(normalQuantile(0.975), 1.959963984540054);
  close(normalQuantile(0.001), -3.090232306167814);
  close(normalQuantile(1e-10), -6.361340902404056, 1e-8);
  for (const p of [0.01, 0.2, 0.5, 0.8, 0.999]) close(normalCdf(normalQuantile(p)), p, 1e-12);
});

test('Student t CDF matches tabulated critical values', () => {
  close(studentTCdf(12.706204736174707, 1), 0.975);
  close(studentTCdf(2.228138851986274, 10), 0.975);
  close(studentTCdf(1, 1), 0.75);
  close(studentTCdf(-2.570581835636314, 5), 0.025);
  close(studentTCdf(0, 7), 0.5);
  close(studentTCdf(1.959963984540054, 1e7), 0.975, 1e-6);
});

test('two-proportion pooled z-test matches a hand-computed example', () => {
  const result = twoProportionTest({ successes: 100, trials: 1000 }, { successes: 130, trials: 1000 }, 0.05);
  close(result.diff, 0.03, 1e-12);
  close(result.effect, 0.3, 1e-12);
  // z = 0.03 / sqrt(0.115·0.885·0.002) = 2.1022…
  close(result.pValue, 0.0355, 1e-3);
  assert.ok(result.ciLow! < 0.3 && result.ciHigh! > 0.3);
  assert.equal(twoProportionTest({ successes: 0, trials: 100 }, { successes: 5, trials: 100 }, 0.05).effect, null);
  assert.equal(twoProportionTest({ successes: 0, trials: 0 }, { successes: 5, trials: 100 }, 0.05).pValue, null);
});

test('Welch test matches R t.test and needs two values per arm', () => {
  const result = welchTest([1, 2, 3, 4, 5], [3, 4, 5, 6, 7, 8], 0.05);
  close(result.diff, 2.5, 1e-12);
  close(result.df, 8.989361702127662, 1e-9);
  close(result.pValue, 0.03980308, 1e-6);
  close(result.effect, 2.5 / 3, 1e-12);
  assert.ok(result.ciLow! > 0);
  assert.deepEqual(welchTest([1], [2, 3], 0.05), { effect: null, diff: null, ciLow: null, ciHigh: null, pValue: null, df: null });
});

test('Holm and Benjamini-Hochberg follow textbook adjustments in input order', () => {
  const p = [0.01, 0.04, 0.03, 0.005];
  assert.deepEqual(holmAdjust(p).map(value => Number(value.toFixed(10))), [0.03, 0.06, 0.06, 0.02]);
  assert.deepEqual(benjaminiHochberg(p).map(value => Number(value.toFixed(10))), [0.02, 0.04, 0.04, 0.02]);
  assert.deepEqual(holmAdjust([0.6, 0.9]), [1, 1]);
});

test('alpha spending is monotone, spends full alpha at the end and increments sum to alpha', () => {
  close(spentAlpha(0.05, 1, 'obrien_fleming'), 0.05, 1e-12);
  close(spentAlpha(0.05, 1, 'pocock'), 0.05, 1e-12);
  close(spentAlpha(0.05, 0.5, 'obrien_fleming'), 0.005574596680784, 1e-10);
  assert.equal(spentAlpha(0.05, 0, 'pocock'), 0);
  for (const spending of ['obrien_fleming', 'pocock'] as const) {
    const increments = [1, 2, 3, 4].map(k => sequentialNominalAlpha(0.05, k, 4, spending));
    close(increments.reduce((a, b) => a + b, 0), 0.05, 1e-12);
    assert.ok(increments.every(value => value > 0 && value < 0.05));
  }
  assert.ok(sequentialNominalAlpha(0.05, 1, 4, 'obrien_fleming') < sequentialNominalAlpha(0.05, 1, 4, 'pocock'));
  assert.equal(sequentialNominalAlpha(0.05, 5, 4, 'pocock'), 0);
});
