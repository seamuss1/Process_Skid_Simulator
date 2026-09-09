/**
 * tests/network.test.js — the general hydraulic network solver and the interaction measure.
 *
 * Every hydraulic claim here is checked against something the solver had no part in computing:
 * the closed-form series and parallel laws for a square-law resistance, the balance condition of
 * a Wheatstone bridge, the classic three-reservoir junction problem solved independently by
 * bisection in this file, the closed-form branch quadratic in `pump.js`, and a design point
 * worked out with pencil arithmetic in the builder. Where two algorithms exist they are run
 * against each other — Hardy Cross corrects loops one at a time and the gradient method solves
 * them all at once, so agreement between them is real evidence and not a tautology.
 *
 * The RGA claims are checked against the algebraic identity that its rows and columns each sum
 * to one, which no amount of wrong arithmetic upstream can accidentally satisfy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINK, SOLVER, createNetwork, solveNetwork, hardyCross, nodeBalance, fundamentalLoops,
  loopResiduals, createDistributionNetwork, relativeGainArray, resistanceFromKv, kvForResistance,
} from '../src/process/network.js';
import { createValve, TRIM, kvToK, kvAt } from '../src/process/valve.js';
import { solveBranchFlow, headAt } from '../src/process/pump.js';
import { near, nearRel, PUMP } from './helpers.js';

/** Tolerance for a quantity the solver is required to hold at round-off, m3/h or m. */
const EXACT = 1e-9;

/**
 * The two-loop test network: a Wheatstone bridge between two reservoirs, with demands hung on
 * both junctions so no symmetry can rescue a wrong answer.
 * @param {number} bridgeR resistance of the bridge link, m per (m3/h)^2
 * @returns {object} the network
 */
function bridgeNetwork(bridgeR) {
  return createNetwork({
    tag: 'BRIDGE',
    nodes: [
      { id: 'S', fixed: true, head_m: 100 },
      { id: 'T', fixed: true, head_m: 0 },
      { id: 'J1', demand_m3h: 5 },
      { id: 'J2', demand_m3h: 3 },
    ],
    links: [
      { id: 'L1', from: 'S', to: 'J1', r: 0.02 },
      { id: 'L2', from: 'J1', to: 'T', r: 0.05 },
      { id: 'L3', from: 'S', to: 'J2', r: 0.08 },
      { id: 'L4', from: 'J2', to: 'T', r: 0.01 },
      { id: 'L5', from: 'J1', to: 'J2', r: bridgeR },
    ],
  });
}

test('resistances in series add, which is the simplest answer the solver must not get wrong', () => {
  const net = createNetwork({
    nodes: [
      { id: 'A', fixed: true, head_m: 100 },
      { id: 'J' },
      { id: 'B', fixed: true, head_m: 40 },
    ],
    links: [
      { id: 'R1', from: 'A', to: 'J', r: 0.006 },
      { id: 'R2', from: 'J', to: 'B', r: 0.004 },
    ],
  });
  assert.equal(net.ok, true, net.reason);
  const res = solveNetwork(net);
  assert.equal(res.ok, true, res.reason);

  const Qexact = Math.sqrt(60 / (0.006 + 0.004));
  nearRel(res.flow.R1, Qexact, 1e-12, 'flow through two resistances in series');
  near(res.head.J, 100 - 0.006 * Qexact * Qexact, 1e-9, 'the junction head between them');
  near(res.flow.R1 - res.flow.R2, 0, EXACT, 'the same flow must pass both links');
});

test('resistances in parallel combine as 1/sqrt(Req) = sum 1/sqrt(r)', () => {
  // The square law does not add in parallel the way a linear one does. Each leg carries
  // sqrt(dH/r), so the legs' CONDUCTANCES 1/sqrt(r) add, and that is the analytic result below.
  const r1 = 0.006;
  const rA = 0.02;
  const rB = 0.05;
  const net = createNetwork({
    nodes: [
      { id: 'A', fixed: true, head_m: 100 },
      { id: 'J' },
      { id: 'B', fixed: true, head_m: 0 },
    ],
    links: [
      { id: 'FEED', from: 'A', to: 'J', r: r1 },
      { id: 'LEGA', from: 'J', to: 'B', r: rA },
      { id: 'LEGB', from: 'J', to: 'B', r: rB },
    ],
  });
  const res = solveNetwork(net);
  assert.equal(res.ok, true, res.reason);

  const invSqrtReq = 1 / Math.sqrt(rA) + 1 / Math.sqrt(rB);
  const Req = 1 / (invSqrtReq * invSqrtReq);
  const Qexact = Math.sqrt(100 / (r1 + Req));
  nearRel(res.flow.FEED, Qexact, 1e-11, 'total flow through feed plus two parallel legs');
  nearRel(res.flow.LEGA, Math.sqrt(Req / rA) * Qexact, 1e-11, 'split into the low-resistance leg');
  nearRel(res.flow.LEGB, Math.sqrt(Req / rB) * Qexact, 1e-11, 'split into the high-resistance leg');
  near(res.flow.LEGA + res.flow.LEGB - res.flow.FEED, 0, EXACT, 'the split must add back up');
});

test('a balanced Wheatstone bridge carries exactly no flow in its bridge link', () => {
  // The hand-solvable two-loop network. With r1/r2 = r3/r4 the two dividers put the same head on
  // both junctions, so the bridge sees no differential whatever its own resistance is. Any error
  // in the loop topology, the incidence signs or the Jacobian shows up here as a non-zero flow
  // in a link that is provably carrying none.
  const net = createNetwork({
    tag: 'BALANCED',
    nodes: [
      { id: 'S', fixed: true, head_m: 100 },
      { id: 'T', fixed: true, head_m: 0 },
      { id: 'J1' },
      { id: 'J2' },
    ],
    links: [
      { id: 'L1', from: 'S', to: 'J1', r: 1 },
      { id: 'L2', from: 'J1', to: 'T', r: 4 },
      { id: 'L3', from: 'S', to: 'J2', r: 2 },
      { id: 'L4', from: 'J2', to: 'T', r: 8 },
      { id: 'BR', from: 'J1', to: 'J2', r: 3 },
    ],
  });
  const res = solveNetwork(net);
  assert.equal(res.ok, true, res.reason);

  near(res.flow.BR, 0, 1e-10, 'a balanced bridge must carry no flow at all');
  near(res.head.J1, res.head.J2, 1e-10, 'balance means the two junction heads are equal');
  // The two arms then reduce to independent series pairs with known closed-form flows.
  nearRel(res.flow.L1, Math.sqrt(100 / 5), 1e-10, 'left arm, r = 1 + 4');
  nearRel(res.flow.L3, Math.sqrt(100 / 10), 1e-10, 'right arm, r = 2 + 8');
  near(res.head.J1, 100 - 1 * (100 / 5), 1e-9, 'divider head, 100 - r1*Q^2');
});

test('the classic three-reservoir junction matches an independently bisected junction head', () => {
  const H = [100, 60, 20];
  const r = [0.02, 0.03, 0.05];
  const demand = 12;
  const net = createNetwork({
    tag: 'THREE-RES',
    nodes: [
      { id: 'R1', fixed: true, head_m: H[0] },
      { id: 'R2', fixed: true, head_m: H[1] },
      { id: 'R3', fixed: true, head_m: H[2] },
      { id: 'J', demand_m3h: demand },
    ],
    links: [
      { id: 'P1', from: 'R1', to: 'J', r: r[0] },
      { id: 'P2', from: 'R2', to: 'J', r: r[1] },
      { id: 'P3', from: 'R3', to: 'J', r: r[2] },
    ],
  });

  // The textbook method, implemented here and nowhere near the solver: guess the junction head,
  // sum the signed inflows each reservoir would then deliver, and bisect until they match the
  // draw-off. It is one scalar monotone equation, so bisection is exact to machine precision.
  const inflow = (HJ) => {
    let q = 0;
    for (let i = 0; i < 3; i += 1) {
      const dH = H[i] - HJ;
      q += Math.sign(dH) * Math.sqrt(Math.abs(dH) / r[i]);
    }
    return q - demand;
  };
  let lo = 20;
  let hi = 100;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (inflow(mid) > 0) lo = mid; else hi = mid;
  }
  const HJ = 0.5 * (lo + hi);

  const res = solveNetwork(net);
  assert.equal(res.ok, true, res.reason);
  nearRel(res.head.J, HJ, 1e-11, 'junction head against the bisected textbook answer');
  for (let i = 0; i < 3; i += 1) {
    const dH = H[i] - HJ;
    const want = Math.sign(dH) * Math.sqrt(Math.abs(dH) / r[i]);
    nearRel(res.flow[`P${i + 1}`], want, 1e-9, `reservoir ${i + 1} contribution, signed`);
  }
  assert.ok(res.flow.P3 < 0, 'the lowest reservoir must be receiving, not supplying');
});

test('mass balance holds at every node to round-off, because continuity is linear in Q', () => {
  const net = bridgeNetwork(0.03);
  const res = solveNetwork(net);
  assert.equal(res.ok, true, res.reason);

  const bal = nodeBalance(net, res);
  assert.equal(bal.ok, true, bal.reason);
  near(bal.maxImbalance_m3h, 0, EXACT,
    'a full Newton step satisfies continuity exactly; anything else means the incidence matrix '
    + 'and the residual disagree about which way a link points');
  near(bal.imbalance.J1, 0, EXACT, 'J1 balance');
  near(bal.imbalance.J2, 0, EXACT, 'J2 balance');
  // What the reservoirs supply must equal what the junctions draw off. Nothing else is available.
  near(bal.supply.S + bal.supply.T, 5 + 3, EXACT,
    'the two reservoirs together must deliver exactly the total demand');
  assert.ok(bal.supply.S > 0 && bal.supply.T < 0,
    'the high reservoir delivers and the low one receives the through-flow, so their supplies '
    + 'carry opposite signs and only their SUM is the demand');
  near(res.maxImbalance_m3h, 0, EXACT, 'the solver must report the same imbalance it achieved');
});

test('the energy residual is zero around every fundamental loop', () => {
  const net = bridgeNetwork(0.03);
  const res = solveNetwork(net);
  const lp = fundamentalLoops(net);
  assert.equal(lp.ok, true, lp.reason);
  assert.equal(lp.loops.length, net.links.length - net.nJunctions,
    'a connected network has exactly nLinks - nJunctions independent loops once the reservoirs '
    + 'are merged — two real loops here plus one pseudo-loop between the two reservoirs');

  const lr = loopResiduals(net, res);
  assert.equal(lr.ok, true, lr.reason);
  near(lr.max_m, 0, 1e-9,
    'continuity comes free from a Newton step; the loop energy balance is the nonlinear half '
    + 'and is the one that says the answer is converged rather than merely stationary');
});

test('Hardy Cross reaches the same answer the gradient method does, far more slowly', () => {
  const net = bridgeNetwork(0.03);
  const gga = solveNetwork(net);
  const hc = hardyCross(net);
  assert.equal(gga.ok, true, gga.reason);
  assert.equal(hc.ok, true, hc.reason);

  for (const l of net.links) {
    nearRel(hc.flow[l.id], gga.flow[l.id], 1e-6,
      `${l.id}: two independent algorithms on the same network must agree`);
  }
  for (const n of net.nodes) {
    near(hc.head[n.id], gga.head[n.id], 1e-5, `${n.id}: recovered head must agree`);
  }
  assert.ok(hc.iterations > 4 * gga.iterations,
    'Hardy Cross corrects one loop at a time and converges linearly; the gradient method solves '
    + `all the loops at once and converges quadratically (${hc.iterations} sweeps against `
    + `${gga.iterations} iterations)`);
  const bal = nodeBalance(net, hc);
  near(bal.maxImbalance_m3h, 0, 1e-9,
    'Hardy Cross corrects around closed circuits, so continuity survives every sweep');
});

test('a pump link reproduces the closed-form branch quadratic in pump.js', () => {
  const zStatic = 3;
  const K = 0.01;
  const Hheader = 55;
  const s = 0.9;
  const net = createNetwork({
    tag: 'BRANCH',
    nodes: [
      { id: 'SUCTION', fixed: true, head_m: zStatic },
      { id: 'MID' },
      { id: 'HEADER', fixed: true, head_m: Hheader },
    ],
    links: [
      { id: 'P-1', kind: LINK.PUMP, from: 'SUCTION', to: 'MID', pump: PUMP, speed: s, r: 0 },
      { id: 'DISCH', from: 'MID', to: 'HEADER', r: K },
    ],
  });
  const res = solveNetwork(net);
  assert.equal(res.ok, true, res.reason);

  // pump.js solves `zStatic + H(Q,s) - K*Q^2 = Hheader` as a quadratic, with no iteration at all.
  // The network solver has to find the same root the hard way.
  const exact = solveBranchFlow(PUMP, s, Hheader, zStatic, K);
  assert.equal(exact.checkShut, false, 'the branch should be delivering at these conditions');
  nearRel(res.flow['P-1'], exact.Q_m3h, 1e-10,
    'the network solve must land on the same root the closed form gives');
  near(res.head.MID, zStatic + headAt(PUMP, exact.Q_m3h, s), 1e-8,
    'the pump discharge head is the suction head plus the developed head');
});

test('a stopped pump holds its check valve shut instead of siphoning the header backwards', () => {
  const net = createNetwork({
    nodes: [
      { id: 'SUCTION', fixed: true, head_m: 0 },
      { id: 'MID' },
      { id: 'HEADER', fixed: true, head_m: 40 },
    ],
    links: [
      { id: 'P-1', kind: LINK.PUMP, from: 'SUCTION', to: 'MID', pump: PUMP, speed: 0, r: 0 },
      { id: 'DISCH', from: 'MID', to: 'HEADER', r: 0.01 },
    ],
  });
  const res = solveNetwork(net, { speed: { 'P-1': 0 } });
  assert.equal(res.ok, true, res.reason);
  // A 40 m header standing on a shut machine: the closed gradient is 1e6 m per m3/h, so the
  // leak-back is bounded by 40/1e6 and the header cannot drain through a stopped pump.
  assert.ok(Math.abs(res.flow['P-1']) < 1e-4,
    `a stopped pump must pass essentially nothing, got ${res.flow['P-1']} m3/h`);

  // And with the machine running the same header is fed forwards, which proves the block above
  // is the check valve doing its job rather than the network being unable to flow at all.
  const running = solveNetwork(net, { speed: { 'P-1': 1 } });
  assert.ok(running.flow['P-1'] > 10, 'the same branch must deliver once the pump is turning');
});

test('the distribution case returns the design flows it was sized for', () => {
  // The builder does pencil arithmetic: header head from the pump curve at total design flow,
  // K = dH/Q^2 per branch, split between valve and pipe by the authority rule. So the answer is
  // known before the solver runs, and reproducing it is a check on the whole chain — the pump
  // curve, the Kv-to-head conversion, the trim characteristic and the network solve together.
  const dist = createDistributionNetwork({
    tag: 'STATION',
    pump: PUMP,
    speed: 1,
    suctionHead_m: 2,
    supplyK: 0.002,
    consumers: [
      { tag: 'C1', elevation_m: 10, designFlow_m3h: 16, valveAuthority: 0.35, designTravel: 0.6 },
      { tag: 'C2', elevation_m: 25, designFlow_m3h: 15, valveAuthority: 0.4, designTravel: 0.6 },
      { tag: 'C3', elevation_m: 40, designFlow_m3h: 12, valveAuthority: 0.45, designTravel: 0.55 },
    ],
  });
  assert.equal(dist.ok, true, dist.reason);

  const Qtot = 16 + 15 + 12;
  near(dist.design.totalFlow_m3h, Qtot, 1e-12, 'total design flow');
  near(dist.design.headerHead_m, 2 + headAt(PUMP, Qtot, 1) - 0.002 * Qtot * Qtot, 1e-12,
    'header head is the pump curve at total flow less the supply loss');

  const res = solveNetwork(dist.net, dist.solveOpts);
  assert.equal(res.ok, true, res.reason);
  for (const c of dist.consumers) {
    nearRel(res.flow[c.valveTag], c.designFlow_m3h, 1e-9,
      `${c.tag}: the solver must reproduce the flow the branch was sized for`);
  }
  nearRel(res.flow[dist.pumpTag], Qtot, 1e-9, 'the pump must be carrying the sum of the branches');
  near(res.head.HEADER, dist.design.headerHead_m, 1e-8, 'header head at the design point');
  near(nodeBalance(dist.net, res).maxImbalance_m3h, 0, EXACT, 'header mass balance');

  // The authority rule is not decoration: check the valve really is taking the share it was
  // sized for at the design travel.
  for (const c of dist.consumers) {
    const kv = kvAt(c.valve, c.designTravel);
    const dropValve = kvToK(kv) * c.designFlow_m3h * c.designFlow_m3h;
    const dropBranch = c.branchK * c.designFlow_m3h * c.designFlow_m3h;
    nearRel(dropValve / dropBranch, c.valveAuthority, 1e-9,
      `${c.tag}: the valve must take its design share of the branch drop`);
  }
});

test('the Kv and resistance conversions are exact inverses of each other', () => {
  for (const kv of [1, 12.5, 300]) {
    nearRel(kvForResistance(resistanceFromKv(kv)), kv, 1e-12, `round trip at Kv ${kv}`);
  }
  near(resistanceFromKv(10), kvToK(10), 0, 'resistanceFromKv is valve.js kvToK under another name');
});

test('a decoupled plant has an identity RGA — every valve owns its own flow completely', () => {
  // Three consumers, three valves, three separate supplies. Nothing is shared, so the gain
  // matrix is diagonal and the RGA must be exactly the identity. If it is not, the finite
  // differences are leaking between loops and every interaction number below is worthless.
  const mkValve = (tag) => createValve({ tag, kvMax_m3h: 40, trim: TRIM.LINEAR });
  const net = createNetwork({
    tag: 'DECOUPLED',
    nodes: [
      { id: 'S1', fixed: true, head_m: 80 }, { id: 'S2', fixed: true, head_m: 80 },
      { id: 'S3', fixed: true, head_m: 80 },
      { id: 'C1', fixed: true, head_m: 10 }, { id: 'C2', fixed: true, head_m: 25 },
      { id: 'C3', fixed: true, head_m: 40 },
    ],
    links: [
      { id: 'V1', kind: LINK.VALVE, from: 'S1', to: 'C1', valve: mkValve('V1'), travel: 0.6, r: 0.01 },
      { id: 'V2', kind: LINK.VALVE, from: 'S2', to: 'C2', valve: mkValve('V2'), travel: 0.6, r: 0.01 },
      { id: 'V3', kind: LINK.VALVE, from: 'S3', to: 'C3', valve: mkValve('V3'), travel: 0.6, r: 0.01 },
    ],
  });
  assert.equal(net.ok, true, net.reason);

  const r = relativeGainArray(net, { inputs: ['V1', 'V2', 'V3'], outputs: ['V1', 'V2', 'V3'] });
  assert.equal(r.ok, true, r.reason);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      near(r.rga[i][j], i === j ? 1 : 0, 1e-9,
        `RGA[${i}][${j}] on a plant with nothing shared between the loops`);
      if (i !== j) near(r.G[i][j], 0, 1e-9, `off-diagonal gain G[${i}][${j}] must be exactly zero`);
    }
  }
  assert.equal(r.best.permutation.join(''), '012', 'the only sensible pairing is the obvious one');
});

test('RGA rows and columns each sum to one — the identity that checks the whole calculation', () => {
  const dist = distributionFixture();
  const tags = dist.consumers.map((c) => c.valveTag);
  const r = relativeGainArray(dist.net, {
    inputs: tags, outputs: tags, solve: dist.solveOpts,
  });
  assert.equal(r.ok, true, r.reason);

  for (let i = 0; i < 3; i += 1) {
    let rowSum = 0;
    let colSum = 0;
    for (let j = 0; j < 3; j += 1) { rowSum += r.rga[i][j]; colSum += r.rga[j][i]; }
    // Row i sums to (G * inv(G))[i][i] and column i to (inv(G) * G)[i][i]. Both are exactly one
    // for any non-singular G, so this checks the element-wise product and the inversion together
    // without knowing anything about the plant.
    near(rowSum, 1, 1e-10, `RGA row ${i} must sum to one`);
    near(colSum, 1, 1e-10, `RGA column ${i} must sum to one`);
  }
});

test('consumers on a shared header fight each other, and the RGA says by how much', () => {
  const dist = distributionFixture();
  const tags = dist.consumers.map((c) => c.valveTag);
  const r = relativeGainArray(dist.net, { inputs: tags, outputs: tags, solve: dist.solveOpts });
  assert.equal(r.ok, true, r.reason);

  for (let i = 0; i < 3; i += 1) {
    assert.ok(r.G[i][i] > 0, `opening ${tags[i]} must raise its own flow`);
    assert.ok(r.rga[i][i] > 1,
      `RGA[${i}][${i}] = ${r.rga[i][i].toFixed(3)}: with the other loops closed this pairing gets `
      + 'WEAKER, because they steal back the header pressure it just gave away — that is what an '
      + 'RGA above one means and it is why the three loops have to be detuned against each other');
    for (let j = 0; j < 3; j += 1) {
      if (i === j) continue;
      assert.ok(r.G[i][j] < 0,
        `opening ${tags[j]} must take flow away from ${tags[i]} by sagging the shared header`);
    }
  }
});

test('the diagonal pairing is recommended and a rotated one is flagged as unstabilisable', () => {
  const dist = distributionFixture();
  const tags = dist.consumers.map((c) => c.valveTag);
  const r = relativeGainArray(dist.net, { inputs: tags, outputs: tags, solve: dist.solveOpts });
  assert.equal(r.ok, true, r.reason);

  assert.equal(r.best.permutation.join(''), '012',
    'each valve should hold the flow it is actually in series with');
  assert.equal(r.best.integralStable, true, 'the diagonal pairing must pass both necessary tests');
  assert.ok(r.best.niederlinski > 0, 'a negative Niederlinski index would rule the pairing out');

  // Rotate the pairing: every valve is asked to hold its neighbour's flow. Row sums are one and
  // the diagonal elements each exceed one, so the off-diagonals a rotation picks must sum to a
  // negative number and at least one of them is negative. A negative relative gain means the
  // loop's sign flips when its neighbours go to auto: stable alone, unstable together, and
  // stable again the moment one of them trips.
  const rotated = r.pairings.find((p) => p.permutation.join('') === '120');
  assert.ok(rotated, 'the rotated pairing must be among the candidates scored');
  assert.ok(rotated.minLambda < 0,
    `the rotated pairing has a relative gain of ${rotated.minLambda.toFixed(3)}, so it changes `
    + 'sign when the other loops close');
  assert.equal(rotated.integralStable, false, 'and it must therefore be flagged, not merely ranked');
  assert.ok(rotated.score > r.best.score, 'and it must score worse than the diagonal pairing');
});

test('the guards refuse a network that cannot be solved, and say why', () => {
  assert.equal(createNetwork(null).ok, false, 'no spec at all');
  assert.match(createNetwork({ nodes: [{ id: 'A' }], links: [] }).reason, /links/,
    'a network with no links');
  assert.match(createNetwork({
    nodes: [{ id: 'A' }, { id: 'B' }],
    links: [{ id: 'L', from: 'A', to: 'B', r: 1 }],
  }).reason, /fixed-head/,
    'with no reservoir anywhere, head is only defined up to a constant');
  assert.match(createNetwork({
    nodes: [{ id: 'A', fixed: true, head_m: 10 }, { id: 'B' }, { id: 'ORPHAN' }],
    links: [{ id: 'L', from: 'A', to: 'B', r: 1 }],
  }).reason, /ORPHAN/, 'an unreachable junction must be named, not left to the Cholesky to find');
  assert.match(createNetwork({
    nodes: [{ id: 'A', fixed: true, head_m: 10 }, { id: 'A' }],
    links: [{ id: 'L', from: 'A', to: 'A', r: 1 }],
  }).reason, /duplicate/, 'duplicate node ids');
  assert.match(createNetwork({
    nodes: [{ id: 'A', fixed: true, head_m: 10 }, { id: 'B' }],
    links: [{ id: 'L', kind: LINK.PUMP, from: 'A', to: 'B' }],
  }).reason, /pump/, 'a pump link with no pump');

  assert.equal(solveNetwork({ ok: false }).ok, false, 'solving something that is not a network');
  const net = bridgeNetwork(0.03);
  assert.equal(relativeGainArray(net, { inputs: ['L1'], outputs: ['L1'] }).ok, false,
    'a plain resistance has no travel to move, so it cannot be an RGA input');
  assert.equal(relativeGainArray(net, { inputs: ['L1', 'L2'], outputs: ['L1'] }).ok, false,
    'the RGA is only defined for a square gain matrix');
});

test('a solve that will not converge is reported as a failure, never as an answer', () => {
  const net = bridgeNetwork(0.03);
  const res = solveNetwork(net, { maxIter: 1 });
  assert.equal(res.ok, false, 'one iteration cannot reach 1e-10 relative flow change');
  assert.match(res.reason, /did not reach/, 'and the reason must say so');
  assert.equal(res.converged, false, 'the diagnostics come back with it for debugging');
  assert.ok(res.iterations === 1, 'along with how far it got');
  assert.ok(SOLVER.MAX_ITER > 1, 'the shipped cap is not this one');
});

/**
 * The three-consumer station used by the interaction tests. Built once per test rather than
 * shared as module state, so no test can leave a mutated fixture behind for the next one.
 * @returns {object} the distribution network from {@link createDistributionNetwork}
 */
function distributionFixture() {
  const dist = createDistributionNetwork({
    tag: 'STATION',
    pump: PUMP,
    speed: 1,
    suctionHead_m: 2,
    supplyK: 0.002,
    consumers: [
      { tag: 'C1', elevation_m: 10, designFlow_m3h: 16, valveAuthority: 0.35, designTravel: 0.6 },
      { tag: 'C2', elevation_m: 25, designFlow_m3h: 15, valveAuthority: 0.4, designTravel: 0.6 },
      { tag: 'C3', elevation_m: 40, designFlow_m3h: 12, valveAuthority: 0.45, designTravel: 0.55 },
    ],
  });
  assert.equal(dist.ok, true, dist.reason);
  return dist;
}
