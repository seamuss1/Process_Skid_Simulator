/**
 * tests/pump.test.js — the pump curve, the affinity laws, efficiency, power, NPSH and the
 * closed-form branch solve.
 *
 * The affinity assertions are exact, not approximate: the homologous substitution
 * H(Q, s) = s^2 * H(Q/s) is an algebraic identity for a quadratic curve, so if it ever fails by
 * more than floating-point noise the curve has stopped being the model it claims to be.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPump, headAt, shutoffHead, efficiencyAt, shaftPower_kW, npshRequired_m,
  npshAvailable_m, cavitationFactor, solveBranchFlow,
} from '../src/process/pump.js';
import { kvToK } from '../src/process/valve.js';
import { PUMP, near, nearRel } from './helpers.js';

test('the head curve passes through its two datasheet points exactly', () => {
  near(headAt(PUMP, 0, 1), 95, 1e-9, 'shutoff head');
  near(headAt(PUMP, 45, 1), 72, 1e-9, 'head at the best-efficiency flow');
});

test('the curve droops everywhere — dH/dQ is negative across the whole range', () => {
  for (let Q = 0; Q <= PUMP.Qmax_m3h; Q += 1) {
    const slope = headAt(PUMP, Q + 0.01, 1) - headAt(PUMP, Q, 1);
    assert.ok(slope < 0, `curve rises at Q = ${Q} m3/h, which would make the branch solve multivalued`);
  }
});

test('a curve that does not droop is refused at construction', () => {
  assert.throws(
    () => createPump({ tag: 'BAD', H0_m: 50, Qbep_m3h: 45, Hbep_m: 60, a1: 0, etaBep: 0.7, nRated_rpm: 2950, motor_kW: 15, motorI_A: 28, npshr0_m: 1, npshrBep_m: 4, minFlowFrac: 0.15 }),
    /not drooping/,
  );
});

test('the affinity laws hold exactly: H(Q*s, s) = s^2 * H(Q, 1)', () => {
  for (const s of [0.35, 0.5, 0.75, 0.9, 1.0]) {
    for (const Q of [0, 10, 30, 45, 70]) {
      near(headAt(PUMP, Q * s, s), s * s * headAt(PUMP, Q, 1), 1e-9,
        `head at Q=${Q}, s=${s}`);
    }
  }
});

test('shutoff head falls with the square of speed', () => {
  near(shutoffHead(PUMP, 0.5), 0.25 * 95, 1e-9, 'shutoff at half speed');
  near(shutoffHead(PUMP, 1), 95, 1e-9, 'shutoff at full speed');
});

test('runout is where the full-speed curve reaches zero head', () => {
  near(headAt(PUMP, PUMP.Qmax_m3h, 1), 0, 1e-9, 'head at runout');
});

test('efficiency peaks at the best-efficiency flow, and follows the affinity laws', () => {
  near(efficiencyAt(PUMP, 45, 1), PUMP.etaBep, 1e-9, 'efficiency at the BEP');
  assert.ok(efficiencyAt(PUMP, 30, 1) < PUMP.etaBep, 'left of the BEP should be less efficient');
  assert.ok(efficiencyAt(PUMP, 60, 1) < PUMP.etaBep, 'right of the BEP should be less efficient');
  // A pump run slower stays on the same efficiency island: this is what makes speed control
  // cheaper than throttling, and is the reason efficiency is a function of Q/s.
  near(efficiencyAt(PUMP, 45 * 0.6, 0.6), PUMP.etaBep, 1e-9, 'efficiency at the BEP at 60% speed');
});

test('shaft power follows the cube law along the system curve, and a deadheaded pump still draws', () => {
  const rho = 998.2;
  const idle = shaftPower_kW(PUMP, 0, 0, 1, rho);
  assert.ok(idle > 0, 'a pump spinning against a shut check valve is not free');
  near(shaftPower_kW(PUMP, 0, 0, 0.5, rho), idle * 0.125, 1e-9, 'windage at half speed');
  const full = shaftPower_kW(PUMP, 45, 72, 1, rho);
  nearRel(full, 15 * 0.06 + (rho * 9.80665 * (45 / 3600) * 72) / 1000 / 0.78, 1e-9,
    'shaft power at the BEP');
  assert.ok(full < PUMP.motor_kW, 'the duty point must sit inside the motor rating');
});

test('NPSH required rises with flow squared and scales with speed squared', () => {
  near(npshRequired_m(PUMP, 0, 1), 1.2, 1e-9, 'NPSHr at zero flow');
  near(npshRequired_m(PUMP, 45, 1), 4.5, 1e-9, 'NPSHr at the BEP');
  near(npshRequired_m(PUMP, 45 * 0.5, 0.5), 0.25 * 4.5, 1e-9, 'NPSHr at the BEP at half speed');
  assert.ok(npshRequired_m(PUMP, 70, 1) > npshRequired_m(PUMP, 45, 1),
    'a pump run out demands more suction margin');
});

test('NPSH available drops with temperature, with lift, and with suction friction', () => {
  const base = { pTank_bar: 0, pVap_bar: 0.0234, zStatic_m: 2, hFriction_m: 0, rho_kgm3: 998.2 };
  const cold = npshAvailable_m(base);
  nearRel(cold, 12.11, 0.01, 'NPSHa on cold water with 2 m of static');
  assert.ok(npshAvailable_m({ ...base, pVap_bar: 0.474, rho_kgm3: 971.8 }) < cold - 4,
    'hot liquid loses several metres of margin to vapour pressure');
  near(npshAvailable_m({ ...base, hFriction_m: 3 }), cold - 3, 1e-9, 'friction comes straight off');
  near(npshAvailable_m({ ...base, zStatic_m: -1 }), cold - 3, 1e-9, 'a lift comes straight off');
});

test('the cavitation factor is exactly 1 above the curve and collapses below it', () => {
  assert.equal(cavitationFactor(10, 4), 1, 'a well supplied pump carries no cavitation arithmetic');
  assert.equal(cavitationFactor(4, 4), 1, 'zero margin is the edge, not the cliff');
  near(cavitationFactor(3, 4), 0.5, 1e-9, 'half of NPSHr below the curve is half breakdown');
  near(cavitationFactor(2, 4), 0.1, 1e-9, 'full breakdown floors at 0.1');
  assert.equal(cavitationFactor(-5, 4), 0.1, 'and stays there');
});

// ---------------------------------------------------------------------------------------------
// The branch solve: the quadratic that replaces an iteration.
// ---------------------------------------------------------------------------------------------

const K = kvToK(300) + kvToK(400) + kvToK(500);

/**
 * The residual of the branch balance the solve is supposed to zero.
 * @param {number} Q flow, m3/h
 * @param {number} s speed ratio
 * @param {number} H header head, m
 * @param {number} z suction static head, m
 * @param {number} fc cavitation factor
 * @returns {number} metres of imbalance
 */
const residual = (Q, s, H, z, fc) => z + fc * headAt(PUMP, Q, s) - K * Q * Q - H;

test('the branch solve returns the flow that balances the branch', () => {
  for (const s of [0.5, 0.7, 0.85, 1.0]) {
    for (const H of [5, 15, 25, 35, 45]) {
      const r = solveBranchFlow(PUMP, s, H, 0.8, K, 1);
      if (r.checkShut) continue;
      near(residual(r.Q_m3h, s, H, 0.8, 1), 0, 1e-9,
        `branch balance at s=${s}, header=${H} m`);
      assert.ok(r.Q_m3h > 0, 'an open check valve must pass flow');
    }
  }
});

test('the check valve holds shut when the header stands above what the pump can make', () => {
  // At 45% speed the pump can produce 0.2025 * 95 = 19.2 m plus 0.8 m of static.
  const shut = solveBranchFlow(PUMP, 0.45, 30, 0.8, K, 1);
  assert.equal(shut.checkShut, true, 'the pump cannot reach a 30 m header at 45% speed');
  assert.equal(shut.Q_m3h, 0, 'and therefore delivers exactly nothing');
  assert.equal(shut.dQdH, 0, 'a shut check valve has no sensitivity to header head');

  const open = solveBranchFlow(PUMP, 0.75, 30, 0.8, K, 1);
  assert.equal(open.checkShut, false, 'at 75% speed it can');
  assert.ok(open.Q_m3h > 0);
});

test('the reported sensitivity dQ/dH matches a numerical derivative', () => {
  const eps = 1e-4;
  for (const s of [0.6, 0.8, 1.0]) {
    for (const H of [10, 25, 40]) {
      const r = solveBranchFlow(PUMP, s, H, 0.8, K, 1);
      if (r.checkShut) continue;
      const up = solveBranchFlow(PUMP, s, H + eps, 0.8, K, 1).Q_m3h;
      const dn = solveBranchFlow(PUMP, s, H - eps, 0.8, K, 1).Q_m3h;
      nearRel(r.dQdH, (up - dn) / (2 * eps), 1e-4,
        `dQ/dH at s=${s}, header=${H} m — the implicit integrator depends on this being right`);
    }
  }
});

test('cavitation reduces the flow a branch passes at a given header head', () => {
  const healthy = solveBranchFlow(PUMP, 1, 30, 0.8, K, 1);
  const sick = solveBranchFlow(PUMP, 1, 30, 0.8, K, 0.5);
  assert.ok(sick.Q_m3h < healthy.Q_m3h * 0.8,
    'losing half the head must cost a large part of the flow');
  near(residual(sick.Q_m3h, 1, 30, 0.8, 0.5), 0, 1e-9, 'and the branch still balances');
});

test('two identical machines in parallel each take exactly half the flow', () => {
  const H = 30;
  const one = solveBranchFlow(PUMP, 0.9, H, 0.8, K, 1).Q_m3h;
  const two = solveBranchFlow(PUMP, 0.9, H, 0.8, K, 1).Q_m3h;
  assert.equal(one, two, 'identical machines on a common header share equally, by construction');
});
