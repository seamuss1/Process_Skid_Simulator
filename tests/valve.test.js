/**
 * tests/valve.test.js — trim characteristics and the head-basis sizing relation.
 *
 * The first test is the one that matters: it pins the catalogue definition of Kv. Everything the
 * plant computes about flow through an orifice is downstream of that one number, so if it drifts,
 * every duty point in the simulator drifts with it and nothing else would notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createValve, TRIM, KV_HEAD, trimFraction, kvAt, flowThrough, flowSlope, headLoss, kvToK,
} from '../src/process/valve.js';
import { near, nearRel } from './helpers.js';

const linear = createValve({ tag: 'V-LIN', kvMax_m3h: 100, trim: TRIM.LINEAR, leakFrac: 0.001 });
const eqpct = createValve({ tag: 'V-EQ', kvMax_m3h: 100, trim: TRIM.EQUAL_PCT, rangeability: 50, leakFrac: 0.001 });
const quick = createValve({ tag: 'V-QO', kvMax_m3h: 100, trim: TRIM.QUICK, leakFrac: 0.001 });

test('Kv means what the catalogue says: 1 m3/h of water at 1 bar', () => {
  // 1 bar of water head is 1e5 / (1000 * 9.80665) = 10.1972 m.
  const oneBar_m = 1e5 / (1000 * 9.80665);
  near(flowThrough(1, oneBar_m), 1, 1e-9,
    'a Kv of 1 must pass exactly 1 m3/h across 1 bar, or every duty point in the rig is wrong');
  near(KV_HEAD, Math.sqrt(9.80665 / 100), 1e-12, 'the m3/h-per-Kv-per-root-metre constant');
});

test('the head basis is density-free — that is the point of working in metres', () => {
  // The derivation cancels rho exactly, so flowThrough takes no density argument at all. This
  // test documents the consequence: the same head across the same trim passes the same flow
  // whatever the liquid, because head already carries the density.
  assert.equal(flowThrough.length, 2, 'flowThrough must not take a density');
  near(flowThrough(50, 16), KV_HEAD * 50 * 4, 1e-12, 'flow across 16 m');
});

test('flow reverses when the differential does', () => {
  near(flowThrough(20, -9), -flowThrough(20, 9), 1e-12, 'a reversed differential reverses the flow');
  near(flowThrough(20, 0), 0, 1e-12, 'no differential, no flow');
});

test('linear trim is proportional to travel; equal-percentage is exponential', () => {
  near(trimFraction(linear, 0.5), 0.5, 1e-12, 'linear at half travel');
  near(trimFraction(linear, 1), 1, 1e-12, 'linear at full travel');

  near(trimFraction(eqpct, 1), 1, 1e-12, 'equal-percentage at full travel');
  near(trimFraction(eqpct, 0.5), 50 ** -0.5, 1e-12, 'equal-percentage at half travel');
  // The defining property: equal increments of travel give equal RATIOS of flow.
  const r1 = trimFraction(eqpct, 0.6) / trimFraction(eqpct, 0.4);
  const r2 = trimFraction(eqpct, 0.9) / trimFraction(eqpct, 0.7);
  nearRel(r1, r2, 1e-9, 'the same travel increment must give the same flow ratio anywhere');

  assert.ok(trimFraction(quick, 0.25) > 0.45, 'quick-opening front-loads its capacity');
});

test('every trim honours its seat leakage, so the network stays well-posed at zero travel', () => {
  for (const v of [linear, eqpct, quick]) {
    assert.ok(kvAt(v, 0) > 0,
      `${v.tag}: a valve with exactly zero Kv would make the header a closed volume with no `
      + 'outlet, and the head-flow balance would lose its unique solution');
    near(kvAt(v, 0), v.kvMax_m3h * v.leakFrac, 1e-12, `${v.tag} leakage`);
  }
});

test('headLoss inverts flowThrough', () => {
  for (const kv of [5, 50, 300]) {
    for (const Q of [1, 20, 90]) {
      near(headLoss(kv, flowThrough(kv, 7) * 0 + Q), (Q / (KV_HEAD * kv)) ** 2, 1e-12, 'loss');
      near(flowThrough(kv, headLoss(kv, Q)), Q, 1e-9, `round trip at kv=${kv}, Q=${Q}`);
    }
  }
});

test('kvToK gives the quadratic coefficient the branch solve wants', () => {
  for (const kv of [10, 100, 500]) {
    for (const Q of [5, 40]) {
      near(kvToK(kv) * Q * Q, headLoss(kv, Q), 1e-12,
        'K*Q^2 and headLoss are two spellings of one number');
    }
  }
  assert.equal(kvToK(0), Infinity, 'a shut restriction has infinite resistance');
});

test('flowSlope matches the derivative of flowThrough, and is finite at zero differential', () => {
  const eps = 1e-6;
  for (const dH of [0.5, 5, 40]) {
    const numeric = (flowThrough(40, dH + eps) - flowThrough(40, dH - eps)) / (2 * eps);
    nearRel(flowSlope(40, dH), numeric, 1e-5, `dQ/d(dH) at ${dH} m`);
  }
  assert.ok(Number.isFinite(flowSlope(40, 0)),
    'the true square-root slope is unbounded at zero, so the model must floor it');
});
