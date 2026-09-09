/**
 * src/process/network.js — a general hydraulic network: nodes, links, reservoirs, demands,
 * valves and pumps, solved simultaneously; and the interaction measure that says which valve
 * should control which consumer.
 *
 * Layer L1: imports `core/util.js`, `process/valve.js` and `process/pump.js`. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A NETWORK AND NOT ANOTHER BRANCH
 *
 * `pump.js` solves one branch into one header in closed form, and `plant.js` integrates one
 * header against one discharge line. That is the right model for the rig it describes and it is
 * useless for the question a pump station actually poses, which is: three consumers hang off a
 * common header, each with its own control valve, and every one of them is a load on the other
 * two. Open FCV-1 and the header sags; FCV-2 and FCV-3 see less differential and their flows fall;
 * their controllers open to compensate; the header sags further. Whether that settles or hunts
 * forever is not a tuning question. It is a PAIRING question, and it is decided before anybody
 * touches a gain.
 *
 * So this module does two things. It solves an arbitrary graph of nodes and links, and it
 * measures the interaction in the solved graph.
 *
 * ------------------------------------------------------------------------------------------
 * THE EQUATIONS
 *
 * Unknowns are the flow in every link, `Q_k` (m3/h, positive from the link's `from` node to its
 * `to` node), and the head at every junction node, `H_i` (m, on a common datum — so elevation is
 * simply part of the head).
 *
 *   ENERGY, one per link:      H_from - H_to = h_k(Q_k)
 *   CONTINUITY, one per node:  inflow - outflow = demand
 *
 * `h_k` is the head the link consumes:
 *
 *   RESISTANCE   h = r * Q * |Q|^(n-1),  n = 2 for Darcy-Weisbach, 1.852 for Hazen-Williams.
 *                Signed, so a link flows both ways when the differential reverses.
 *   VALVE        the same, with `r` the branch pipe plus `kvToK(kv)` from the trim characteristic
 *                at the current travel. Valve and branch pipe share one link because they share
 *                one flow; splitting them would add a node carrying no information.
 *   PUMP         h = r*Q*|Q| - H(Q, s), the homologous curve of `pump.js` with its sign flipped,
 *                because a pump is a link that PRODUCES head. Every derating a machine carries is
 *                already folded into its coefficients by `deratedPump`, so this file never learns
 *                what viscosity or wear are.
 *
 * ------------------------------------------------------------------------------------------
 * THE SOLVER — TODINI'S GLOBAL GRADIENT ALGORITHM
 *
 * Write the two residuals with the fixed-head nodes moved to the right-hand side:
 *
 *     F1 = h(Q) - A*H          (nl energy residuals, m)
 *     F2 = A'*Q + d            (nj continuity residuals, m3/h)
 *
 * with `A` the node-link incidence matrix (+1 at `from`, -1 at `to`). Newton's method on
 * [Q; H] gives
 *
 *     [ D   -A ] [dQ]   [-F1]                 D = diag(dh_k/dQ_k)
 *     [ A'   0 ] [dH] = [-F2]
 *
 * and eliminating dQ leaves the Schur complement — the GGA matrix:
 *
 *     (A' D^-1 A) dH = A' D^-1 F1 - F2
 *     dQ = D^-1 (A dH - F1)
 *
 * `A' D^-1 A` is the weighted graph Laplacian of the network: symmetric, positive definite,
 * and the same size as the number of junctions no matter how many links there are. It is
 * factored here by dense Cholesky, which is O(nj^3) and therefore honest only up to a few
 * hundred junctions — this is a teaching rig, not EPANET, and a sparse reordering would be
 * machinery bought for a network nobody here will build.
 *
 * TWO PROPERTIES WORTH KNOWING. First, F2 is LINEAR in Q, so a full Newton step satisfies
 * continuity exactly: after one undamped iteration every node balances to round-off, and it
 * stays balanced forever after. Mass conservation is not something this solver converges
 * toward, it is something it enforces. Second, the same is not true of energy — F1 is where
 * the nonlinearity lives, and it is what the iteration count is actually spent on.
 *
 * CONVERGENCE CRITERION. The iteration stops when the relative flow change
 *
 *     sum_k |dQ_k| / sum_k |Q_k|   <=   SOLVER.TOL
 *
 * which is EPANET's criterion and the right one: an absolute flow tolerance is meaningless
 * without knowing the size of the network, and an energy-residual tolerance in metres is
 * dominated by whichever link happens to be carrying the most head. The result also reports
 * the worst nodal imbalance so a caller can check the claim rather than trust it. Failure to
 * converge inside `SOLVER.MAX_ITER` returns `{ ok:false }` with the diagnostics attached —
 * a silent unconverged answer is the one failure mode a network solver must never have.
 *
 * REGULARISATION. dh/dQ = n*r*|Q|^(n-1) vanishes at zero flow for n > 1, which would make D
 * singular exactly when a branch is shut — the commonest state in a real plant. The gradient is
 * therefore evaluated at `max(|Q|, LOW_FLOW_M3H)` while the RESIDUAL keeps the true law, so the
 * iteration is a damped Newton on the exact equations rather than Newton on approximate ones.
 * The root it converges to is the true root.
 *
 * HARDY CROSS is here too, in `hardyCross()`, not because anyone should use it but because
 * seeing it fail is instructive. It corrects one loop at a time from a flow distribution that
 * already satisfies continuity, which means it converges LINEARLY and its rate collapses as the
 * loops become strongly coupled — the same coupling the RGA below is about to measure. On the
 * two-loop test network it needs a couple of hundred sweeps to reach what the gradient method
 * reaches in six. That is the whole history of network analysis in one comparison.
 *
 * ------------------------------------------------------------------------------------------
 * THE RELATIVE GAIN ARRAY
 *
 * Bristol's RGA is the one number that makes a multi-loop plant teachable. Take the steady-state
 * gain matrix G, with G[i][j] = dQ_i/du_j — the change in consumer i's flow per unit travel of
 * valve j, every other valve HELD. Then
 *
 *     RGA = G .* inv(G)'          (element-wise product)
 *
 * and RGA[i][j] is the ratio of the open-loop gain from u_j to Q_i to the gain that would remain
 * if every other loop were closed and perfect. Its rows and columns each sum to exactly one,
 * which is an algebraic identity and therefore the sharpest possible self-check on the whole
 * calculation.
 *
 *   RGA = 1     that pairing is unaffected by the other loops. Ideal.
 *   0 < RGA < 1 the other loops HELP; the pairing gets stronger when they close.
 *   RGA > 1     the other loops FIGHT; closing them weakens this pairing. Above about 5 the
 *               loops must be detuned against each other and the plant is sluggish by design.
 *   RGA < 0     the gain CHANGES SIGN when the other loops close. Pair here and the loop that
 *               was stable on its own goes unstable the moment its neighbour is put in auto —
 *               and worse, it is stable again if the neighbour trips. That is the pathology, and
 *               it is why "it only oscillates when both loops are in auto" is a pairing report
 *               and not a tuning report.
 *
 * The Niederlinski index is reported alongside for each candidate pairing: NI = det(G)/prod(diag)
 * after reordering onto the pairing. NI < 0 proves the diagonally-paired system cannot be made
 * stable with integral action in every loop. It is a necessary condition, not a sufficient one,
 * and it is stated that way in the result.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { KV_HEAD, kvToK, kvAt, trimFraction, createValve, TRIM } from './valve.js';
import { headAt } from './pump.js';

/** The kinds of link a network is built from. */
export const LINK = Object.freeze({
  /** A fixed quadratic (or Hazen-Williams) resistance: pipe, fitting, fixed orifice. */
  RESISTANCE: 'RESISTANCE',
  /** A control valve in series with its branch pipe. Its Kv follows the trim characteristic. */
  VALVE: 'VALVE',
  /** A pump: the homologous curve of `pump.js`, in series with its own suction/discharge loss. */
  PUMP: 'PUMP',
});

/** Solver limits and regularisation. Every one of these is explained in the header comment. */
export const SOLVER = Object.freeze({
  /** Relative flow-change convergence threshold, `sum|dQ| / sum|Q|`. EPANET's criterion. */
  TOL: 1e-10,
  /** Iteration cap for the gradient method. A well-posed network takes five to fifteen. */
  MAX_ITER: 60,
  /** Hardy Cross iteration cap. Two orders of magnitude larger, and that is the point. */
  MAX_SWEEPS: 5000,
  /** Flow at which the headloss GRADIENT is frozen, m3/h. Keeps D non-singular at a shut branch. */
  LOW_FLOW_M3H: 1e-3,
  /** Absolute floor on the headloss gradient, m per (m3/h). Catches a zero-resistance link. */
  MIN_GRADIENT: 1e-8,
  /** Gradient of a shut check valve or a stopped pump, m per (m3/h): 1 m3/h costs 1e6 m. */
  CLOSED_GRADIENT: 1e6,
  /** Speed ratio below which a pump link is shut. The same 0.02 `pump.js` uses. */
  MIN_SPEED: 0.02,
  /** Newton backtracking halvings before the full step is taken anyway. */
  MAX_BACKTRACK: 6,
});

// ---------------------------------------------------------------------------------------------
// Building a network
// ---------------------------------------------------------------------------------------------

/**
 * The quadratic resistance coefficient of a fixed orifice of known Kv — the bridge between a
 * catalogue number and the `r` a RESISTANCE link wants.
 * @param {number} kv Kv, m3/h at 1 bar
 * @returns {number} r, m per (m3/h)^2
 */
export function resistanceFromKv(kv) {
  return kvToK(kv);
}

/**
 * The Kv that produces a wanted quadratic resistance — the inverse of {@link resistanceFromKv},
 * used when sizing a valve for a design pressure drop.
 * @param {number} r resistance, m per (m3/h)^2
 * @returns {number} Kv, m3/h at 1 bar
 */
export function kvForResistance(r) {
  if (!(r > 0)) return Infinity;
  return 1 / (KV_HEAD * Math.sqrt(r));
}

/**
 * Build a frozen network from a node/link description.
 *
 * Everything is validated here rather than in the solver, because a topology error produces a
 * singular gradient matrix twenty iterations later and the message it produces there names
 * nothing an engineer can act on. The connectivity check in particular: a junction with no path
 * to any fixed-head node has no equation fixing its head, the Laplacian is singular, and the
 * solve fails for a reason that is obvious here and invisible from the numerics.
 *
 * @param {object} spec the network
 * @param {string} [spec.tag] a name, for messages
 * @param {Array<object>} spec.nodes nodes; `{id, fixed, head_m, demand_m3h, elevation_m}`. A node
 *   with `fixed:true` is a reservoir held at `head_m`; any other node is a junction whose head is
 *   solved for and which withdraws `demand_m3h` (negative for an inflow).
 * @param {Array<object>} spec.links links; `{id, kind, from, to, ...}` where `from`/`to` are node
 *   ids and the remaining fields depend on `kind`: `r` and `n` for RESISTANCE, `valve` and
 *   `travel` (plus optional series `r`) for VALVE, `pump` and `speed` (plus optional series `r`)
 *   for PUMP. `check:true` blocks reverse flow; it defaults true on a PUMP.
 * @returns {object} `{ok:true, ...}` the frozen network, or `{ok:false, reason}`
 */
export function createNetwork(spec) {
  if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    return { ok: false, reason: 'a network needs a non-empty nodes array' };
  }
  if (!Array.isArray(spec.links) || spec.links.length === 0) {
    return { ok: false, reason: 'a network needs a non-empty links array' };
  }

  const index = Object.create(null);
  const nodes = [];
  const juncOf = [];
  const slotNode = [];
  let fixedCount = 0;
  for (let i = 0; i < spec.nodes.length; i += 1) {
    const n = spec.nodes[i];
    if (!n || typeof n.id !== 'string' || n.id === '') {
      return { ok: false, reason: `node ${i} needs a non-empty string id` };
    }
    if (index[n.id] !== undefined) return { ok: false, reason: `duplicate node id "${n.id}"` };
    const fixed = n.fixed === true;
    if (fixed && !Number.isFinite(n.head_m)) {
      return { ok: false, reason: `fixed-head node "${n.id}" needs a finite head_m` };
    }
    if (!fixed && n.demand_m3h !== undefined && !Number.isFinite(n.demand_m3h)) {
      return { ok: false, reason: `node "${n.id}" has a non-finite demand_m3h` };
    }
    index[n.id] = i;
    if (fixed) {
      fixedCount += 1;
      juncOf.push(-1);
    } else {
      juncOf.push(slotNode.length);
      slotNode.push(i);
    }
    nodes.push(Object.freeze({
      id: n.id,
      fixed,
      head_m: fixed ? n.head_m : 0,
      elevation_m: Number.isFinite(n.elevation_m) ? n.elevation_m : 0,
      demand_m3h: Number.isFinite(n.demand_m3h) ? n.demand_m3h : 0,
    }));
  }
  if (fixedCount === 0) {
    return {
      ok: false,
      reason: 'a network needs at least one fixed-head node — with none, head is only defined '
        + 'up to a constant and the solve has no unique answer',
    };
  }

  const linkIndex = Object.create(null);
  const links = [];
  for (let k = 0; k < spec.links.length; k += 1) {
    const l = spec.links[k];
    if (!l || typeof l.id !== 'string' || l.id === '') {
      return { ok: false, reason: `link ${k} needs a non-empty string id` };
    }
    if (linkIndex[l.id] !== undefined) return { ok: false, reason: `duplicate link id "${l.id}"` };
    const from = index[l.from];
    const to = index[l.to];
    if (from === undefined) return { ok: false, reason: `link "${l.id}" has unknown from "${l.from}"` };
    if (to === undefined) return { ok: false, reason: `link "${l.id}" has unknown to "${l.to}"` };
    if (from === to) return { ok: false, reason: `link "${l.id}" starts and ends at "${l.from}"` };
    const kind = l.kind || LINK.RESISTANCE;
    if (!LINK[kind]) return { ok: false, reason: `link "${l.id}" has unknown kind "${kind}"` };
    const r = l.r === undefined ? 0 : l.r;
    if (!(r >= 0) || !Number.isFinite(r)) {
      return { ok: false, reason: `link "${l.id}" needs a finite non-negative r` };
    }
    const n = l.n === undefined ? 2 : l.n;
    if (!(n >= 1)) return { ok: false, reason: `link "${l.id}" needs a headloss exponent n >= 1` };
    if (kind === LINK.VALVE && !(l.valve && l.valve.kvMax_m3h > 0)) {
      return { ok: false, reason: `valve link "${l.id}" needs a valve from createValve()` };
    }
    if (kind === LINK.PUMP && !(l.pump && Number.isFinite(l.pump.H0_m) && l.pump.a2 > 0)) {
      return { ok: false, reason: `pump link "${l.id}" needs a pump from createPump()` };
    }
    if (kind === LINK.RESISTANCE && !(r > 0)) {
      return { ok: false, reason: `resistance link "${l.id}" needs r > 0` };
    }
    linkIndex[l.id] = k;
    links.push(Object.freeze({
      id: l.id,
      kind,
      from,
      to,
      r,
      n,
      valve: kind === LINK.VALVE ? l.valve : null,
      travel: kind === LINK.VALVE ? clamp(l.travel === undefined ? 1 : l.travel, 0, 1) : 0,
      pump: kind === LINK.PUMP ? l.pump : null,
      speed: kind === LINK.PUMP ? (l.speed === undefined ? 1 : l.speed) : 0,
      check: l.check === undefined ? kind === LINK.PUMP : l.check === true,
    }));
  }

  // Connectivity, from the fixed-head nodes outward. Anything unreached has no head reference.
  const seen = new Array(nodes.length).fill(false);
  const queue = [];
  for (let i = 0; i < nodes.length; i += 1) if (nodes[i].fixed) { seen[i] = true; queue.push(i); }
  const incident = [];
  for (let i = 0; i < nodes.length; i += 1) incident.push([]);
  for (let k = 0; k < links.length; k += 1) {
    incident[links[k].from].push(k);
    incident[links[k].to].push(k);
  }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const v = queue[qi];
    for (const k of incident[v]) {
      const w = links[k].from === v ? links[k].to : links[k].from;
      if (!seen[w]) { seen[w] = true; queue.push(w); }
    }
  }
  for (let i = 0; i < nodes.length; i += 1) {
    if (!seen[i]) {
      return {
        ok: false,
        reason: `node "${nodes[i].id}" has no path to any fixed-head node, so its head is `
          + 'undetermined and the gradient matrix would be singular',
      };
    }
  }

  return Object.freeze({
    ok: true,
    tag: spec.tag || 'NET',
    nodes: Object.freeze(nodes),
    links: Object.freeze(links),
    index: Object.freeze(index),
    linkIndex: Object.freeze(linkIndex),
    /** Junction slot of each node, or -1 if the node is a fixed head. */
    juncOf: Object.freeze(juncOf),
    /** Node index of each junction slot — the inverse of `juncOf`. */
    slotNode: Object.freeze(slotNode),
    nJunctions: slotNode.length,
    incident: Object.freeze(incident.map((a) => Object.freeze(a))),
  });
}

// ---------------------------------------------------------------------------------------------
// The link laws
// ---------------------------------------------------------------------------------------------

/**
 * Resolve every link's parameters for one solve, applying the caller's overrides.
 * @param {object} net the network
 * @param {object} opts solve options; `travel`, `speed`, `kv`, `r` maps keyed by link id
 * @returns {Array<object>} one resolved parameter record per link, in link order
 */
function resolveLinks(net, opts) {
  const travel = opts.travel || {};
  const speed = opts.speed || {};
  const kvOv = opts.kv || {};
  const rOv = opts.r || {};
  const out = [];
  for (const l of net.links) {
    let r = rOv[l.id] === undefined ? l.r : rOv[l.id];
    let closed = false;
    let pump = null;
    let s = 0;
    let kv = 0;
    if (l.kind === LINK.VALVE) {
      kv = kvOv[l.id] === undefined
        ? kvAt(l.valve, travel[l.id] === undefined ? l.travel : clamp(travel[l.id], 0, 1))
        : kvOv[l.id];
      if (kv > 0) r += kvToK(kv); else closed = true;
    } else if (l.kind === LINK.PUMP) {
      s = speed[l.id] === undefined ? l.speed : speed[l.id];
      if (s > SOLVER.MIN_SPEED) pump = l.pump; else closed = true;
    }
    out.push({
      id: l.id, kind: l.kind, from: l.from, to: l.to, r, n: l.n, kv, pump, speed: s, check: l.check, closed,
    });
  }
  return out;
}

/**
 * Head consumed by a link at a flow, m. Negative for a pump that is producing more than it loses.
 * @param {object} p a resolved link record
 * @param {number} Q flow, m3/h, positive from `from` to `to`
 * @returns {number} `H_from - H_to`, m
 */
function linkHead_m(p, Q) {
  // A shut link is modelled as an enormous linear resistance rather than by removing it from the
  // system. Removing it changes the size of the matrix mid-iteration, and a solver whose
  // dimension flickers with the check valves is a solver that will not converge.
  if (p.closed) return SOLVER.CLOSED_GRADIENT * Q;
  if (p.check && Q < 0) {
    const shutoff = p.pump ? -headAt(p.pump, 0, p.speed) : 0;
    return shutoff + SOLVER.CLOSED_GRADIENT * Q;
  }
  const a = Math.abs(Q);
  let h = p.r * Q * (p.n === 2 ? a : Math.pow(a, p.n - 1));
  if (p.pump) h -= headAt(p.pump, Q, p.speed);
  return h;
}

/**
 * `dh/dQ` for a link, the diagonal of the gradient method's D matrix.
 * @param {object} p a resolved link record
 * @param {number} Q flow, m3/h
 * @returns {number} the gradient, m per (m3/h), always strictly positive
 */
function linkGradient(p, Q) {
  if (p.closed) return SOLVER.CLOSED_GRADIENT;
  if (p.check && Q < 0) return SOLVER.CLOSED_GRADIENT;
  const a = Math.max(Math.abs(Q), SOLVER.LOW_FLOW_M3H);
  let g = p.n * p.r * (p.n === 2 ? a : Math.pow(a, p.n - 1));
  if (p.pump) g += p.speed * p.pump.a1 + 2 * p.pump.a2 * Q;
  return Math.max(g, SOLVER.MIN_GRADIENT);
}

// ---------------------------------------------------------------------------------------------
// Dense linear algebra, kept minimal and local
// ---------------------------------------------------------------------------------------------

/**
 * Solve `S x = b` for a symmetric positive-definite S held row-major, by Cholesky factorisation.
 *
 * A small diagonal ridge is tried once if the factorisation meets a non-positive pivot. That is
 * not a fudge: the GGA matrix is provably positive definite for strictly positive gradients, so a
 * failed pivot means round-off on a badly scaled network, and the ridge costs a rounding error to
 * step past it. A second failure is reported rather than papered over.
 *
 * @param {Float64Array} S the matrix, m*m, row-major (overwritten with its factor)
 * @param {Float64Array} b the right-hand side (overwritten with the solution)
 * @param {number} m the order
 * @returns {boolean} true if the factorisation succeeded
 */
function choleskySolve(S, b, m) {
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = S[i * m + j];
      for (let t = 0; t < j; t += 1) sum -= S[i * m + t] * S[j * m + t];
      if (i === j) {
        if (!(sum > 0)) return false;
        S[i * m + i] = Math.sqrt(sum);
      } else {
        S[i * m + j] = sum / S[j * m + j];
      }
    }
  }
  for (let i = 0; i < m; i += 1) {
    let sum = b[i];
    for (let t = 0; t < i; t += 1) sum -= S[i * m + t] * b[t];
    b[i] = sum / S[i * m + i];
  }
  for (let i = m - 1; i >= 0; i -= 1) {
    let sum = b[i];
    for (let t = i + 1; t < m; t += 1) sum -= S[t * m + i] * b[t];
    b[i] = sum / S[i * m + i];
  }
  return true;
}

/**
 * Invert a small dense matrix by Gauss-Jordan elimination with partial pivoting, returning the
 * determinant alongside because the Niederlinski index wants it and it is free here.
 * @param {Array<Array<number>>} A the matrix, n rows of n
 * @param {number} n the order
 * @returns {{ok:boolean, inv:Array<Array<number>>, det:number, reason?:string}} the inverse
 */
function invertMatrix(A, n) {
  const a = [];
  const inv = [];
  for (let i = 0; i < n; i += 1) {
    a.push(A[i].slice());
    const row = new Array(n).fill(0);
    row[i] = 1;
    inv.push(row);
  }
  let det = 1;
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let i = c + 1; i < n; i += 1) if (Math.abs(a[i][c]) > Math.abs(a[piv][c])) piv = i;
    if (!(Math.abs(a[piv][c]) > 0)) {
      return { ok: false, inv: [], det: 0, reason: 'the gain matrix is singular — two inputs move the outputs identically' };
    }
    if (piv !== c) {
      const t = a[piv]; a[piv] = a[c]; a[c] = t;
      const u = inv[piv]; inv[piv] = inv[c]; inv[c] = u;
      det = -det;
    }
    const d = a[c][c];
    det *= d;
    for (let j = 0; j < n; j += 1) { a[c][j] /= d; inv[c][j] /= d; }
    for (let i = 0; i < n; i += 1) {
      if (i === c) continue;
      const f = a[i][c];
      if (f === 0) continue;
      for (let j = 0; j < n; j += 1) { a[i][j] -= f * a[c][j]; inv[i][j] -= f * inv[c][j]; }
    }
  }
  return { ok: true, inv, det };
}

// ---------------------------------------------------------------------------------------------
// The gradient solver
// ---------------------------------------------------------------------------------------------

/**
 * Fill the energy and continuity residuals and return the merit function they define.
 * @param {object} net the network
 * @param {Array<object>} P resolved links
 * @param {Float64Array} Q link flows, m3/h
 * @param {Float64Array} H node heads, m
 * @param {Float64Array} d nodal demands, m3/h
 * @param {Float64Array} F1 energy residuals, filled (m)
 * @param {Float64Array} F2 continuity residuals, filled (m3/h)
 * @returns {number} the sum of squares of both residuals — a merit function for the line search,
 *   not a physical quantity, which is why it is never reported
 */
function residuals(net, P, Q, H, d, F1, F2) {
  let merit = 0;
  for (let k = 0; k < P.length; k += 1) {
    const f = linkHead_m(P[k], Q[k]) - (H[P[k].from] - H[P[k].to]);
    F1[k] = f;
    merit += f * f;
  }
  F2.fill(0);
  for (let k = 0; k < P.length; k += 1) {
    const i = net.juncOf[P[k].from];
    const j = net.juncOf[P[k].to];
    if (i >= 0) F2[i] += Q[k];
    if (j >= 0) F2[j] -= Q[k];
  }
  for (let s = 0; s < F2.length; s += 1) {
    F2[s] += d[net.slotNode[s]];
    merit += F2[s] * F2[s];
  }
  return merit;
}

/**
 * Solve a network at steady state by the global gradient algorithm.
 *
 * @param {object} net a network from {@link createNetwork}
 * @param {object} [opts] overrides and solver settings
 * @param {Object<string,number>} [opts.travel] valve travels by link id, 0..1
 * @param {Object<string,number>} [opts.kv] direct Kv overrides by link id, winning over `travel`
 * @param {Object<string,number>} [opts.speed] pump speed ratios by link id
 * @param {Object<string,number>} [opts.r] series resistance overrides by link id, for fouling
 * @param {Object<string,number>} [opts.demand] nodal demands by node id, m3/h
 * @param {Object<string,number>} [opts.head] fixed-head overrides by node id, m
 * @param {Float64Array} [opts.Q0] warm-start link flows, m3/h
 * @param {Float64Array} [opts.H0] warm-start node heads, m
 * @param {number} [opts.tol] relative flow-change tolerance
 * @param {number} [opts.maxIter] iteration cap
 * @returns {object} `{ok:true, Q, H, flow, head, iterations, ...}` or `{ok:false, reason, ...}`
 */
export function solveNetwork(net, opts = {}) {
  if (!net || net.ok !== true || !Array.isArray(net.links)) {
    return { ok: false, reason: 'solveNetwork wants a network from createNetwork()' };
  }
  const P = resolveLinks(net, opts);
  const nl = net.links.length;
  const nn = net.nodes.length;
  const m = net.nJunctions;
  const tol = opts.tol === undefined ? SOLVER.TOL : opts.tol;
  const maxIter = opts.maxIter === undefined ? SOLVER.MAX_ITER : opts.maxIter;
  const headOv = opts.head || {};
  const demandOv = opts.demand || {};

  const H = new Float64Array(nn);
  const d = new Float64Array(nn);
  let fixedSum = 0;
  let fixedCount = 0;
  for (let i = 0; i < nn; i += 1) {
    const node = net.nodes[i];
    d[i] = demandOv[node.id] === undefined ? node.demand_m3h : demandOv[node.id];
    if (node.fixed) {
      H[i] = headOv[node.id] === undefined ? node.head_m : headOv[node.id];
      fixedSum += H[i];
      fixedCount += 1;
    }
  }
  const seedHead = fixedSum / Math.max(1, fixedCount);
  for (let s = 0; s < m; s += 1) {
    const i = net.slotNode[s];
    H[i] = opts.H0 && Number.isFinite(opts.H0[i]) ? opts.H0[i] : seedHead;
  }
  const Q = new Float64Array(nl);
  for (let k = 0; k < nl; k += 1) {
    Q[k] = opts.Q0 && Number.isFinite(opts.Q0[k]) ? opts.Q0[k] : 1;
  }

  const F1 = new Float64Array(nl);
  const F2 = new Float64Array(m);
  const tF1 = new Float64Array(nl);
  const tF2 = new Float64Array(m);
  const dQ = new Float64Array(nl);
  const dH = new Float64Array(m);
  const S = new Float64Array(m * m);
  const b = new Float64Array(m);
  const Qt = new Float64Array(nl);
  const Ht = new Float64Array(nn);

  let merit = residuals(net, P, Q, H, d, F1, F2);
  let iterations = 0;
  let relChange = Infinity;
  let converged = false;

  for (let it = 0; it < maxIter; it += 1) {
    iterations = it + 1;
    S.fill(0);
    b.fill(0);
    for (let k = 0; k < nl; k += 1) {
      const w = 1 / linkGradient(P[k], Q[k]);
      const i = net.juncOf[P[k].from];
      const j = net.juncOf[P[k].to];
      if (i >= 0) { S[i * m + i] += w; b[i] += w * F1[k]; }
      if (j >= 0) { S[j * m + j] += w; b[j] -= w * F1[k]; }
      if (i >= 0 && j >= 0) { S[i * m + j] -= w; S[j * m + i] -= w; }
      dQ[k] = w;                              // stash the weight; the step needs it below
    }
    for (let s = 0; s < m; s += 1) b[s] -= F2[s];

    if (m > 0) {
      if (!choleskySolve(S, b, m)) {
        // Rebuild and retry once with a ridge; see the note on choleskySolve.
        S.fill(0);
        b.fill(0);
        for (let k = 0; k < nl; k += 1) {
          const w = dQ[k];
          const i = net.juncOf[P[k].from];
          const j = net.juncOf[P[k].to];
          if (i >= 0) { S[i * m + i] += w; b[i] += w * F1[k]; }
          if (j >= 0) { S[j * m + j] += w; b[j] -= w * F1[k]; }
          if (i >= 0 && j >= 0) { S[i * m + j] -= w; S[j * m + i] -= w; }
        }
        for (let s = 0; s < m; s += 1) { b[s] -= F2[s]; S[s * m + s] *= 1 + 1e-12; }
        if (!choleskySolve(S, b, m)) {
          return {
            ok: false,
            reason: 'the gradient matrix would not factor — the network is singular at this state',
            iterations,
          };
        }
      }
      for (let s = 0; s < m; s += 1) dH[s] = b[s];
    }

    for (let k = 0; k < nl; k += 1) {
      const i = net.juncOf[P[k].from];
      const j = net.juncOf[P[k].to];
      const grad = (i >= 0 ? dH[i] : 0) - (j >= 0 ? dH[j] : 0);
      dQ[k] *= grad - F1[k];
    }

    // Backtracking on the merit function. If nothing improves, take the full Newton step anyway:
    // continuity is LINEAR, so only a full step drives the mass balance to zero, and a solver
    // that keeps taking sixteenth-steps to protect a merit function never gets there.
    let alpha = 1;
    let accepted = false;
    for (let t = 0; t < SOLVER.MAX_BACKTRACK; t += 1) {
      for (let k = 0; k < nl; k += 1) Qt[k] = Q[k] + alpha * dQ[k];
      Ht.set(H);
      for (let s = 0; s < m; s += 1) Ht[net.slotNode[s]] = H[net.slotNode[s]] + alpha * dH[s];
      const trial = residuals(net, P, Qt, Ht, d, tF1, tF2);
      if (trial <= merit || t === SOLVER.MAX_BACKTRACK - 1) {
        if (trial > merit) alpha = 1;
        accepted = true;
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) alpha = 1;

    let sumAbsDQ = 0;
    let sumAbsQ = 0;
    for (let k = 0; k < nl; k += 1) {
      const step = alpha * dQ[k];
      Q[k] += step;
      sumAbsDQ += Math.abs(step);
      sumAbsQ += Math.abs(Q[k]);
    }
    for (let s = 0; s < m; s += 1) H[net.slotNode[s]] += alpha * dH[s];
    merit = residuals(net, P, Q, H, d, F1, F2);

    relChange = sumAbsDQ / Math.max(sumAbsQ, 1e-12);
    if (relChange <= tol) { converged = true; break; }
  }

  let maxImbalance = 0;
  for (let s = 0; s < m; s += 1) maxImbalance = Math.max(maxImbalance, Math.abs(F2[s]));
  const res = buildResult(net, P, Q, H, d, {
    method: 'gga', iterations, converged, relFlowChange: relChange, maxImbalance_m3h: maxImbalance,
  });
  if (!converged) {
    // The diagnostics ride along with the refusal so a caller can see how close it got, but `ok`
    // is spread LAST: an unconverged answer that reports success is the one failure mode a
    // network solver must never have.
    return {
      ...res,
      ok: false,
      reason: `the gradient method did not reach ${tol} relative flow change in ${maxIter} `
        + `iterations (reached ${relChange.toPrecision(3)})`,
    };
  }
  return res;
}

/**
 * Assemble the public result object shared by both solvers.
 * @param {object} net the network
 * @param {Array<object>} P resolved links
 * @param {Float64Array} Q link flows, m3/h
 * @param {Float64Array} H node heads, m
 * @param {Float64Array} d nodal demands used, m3/h
 * @param {object} meta method, iteration and convergence fields
 * @returns {object} the result
 */
function buildResult(net, P, Q, H, d, meta) {
  const flow = Object.create(null);
  const head = Object.create(null);
  const loss = Object.create(null);
  for (let k = 0; k < net.links.length; k += 1) {
    flow[net.links[k].id] = Q[k];
    loss[net.links[k].id] = linkHead_m(P[k], Q[k]);
  }
  for (let i = 0; i < net.nodes.length; i += 1) head[net.nodes[i].id] = H[i];
  return {
    ok: true,
    ...meta,
    Q,
    H,
    demand_m3h: d,
    resolved: P,
    /** Link flow by link id, m3/h. */
    flow,
    /** Node head by node id, m. */
    head,
    /** Head consumed by each link, m — negative where a pump is producing. */
    loss,
  };
}

// ---------------------------------------------------------------------------------------------
// Balances — the checks a caller should make rather than trust
// ---------------------------------------------------------------------------------------------

/**
 * Nodal mass balance of a solved network.
 *
 * At a junction this must be zero to round-off, and it is: continuity is linear in Q, so a full
 * Newton step satisfies it exactly. At a fixed-head node it is not a residual at all but the flow
 * the reservoir is supplying, which is the number a suction tank level model wants.
 *
 * @param {object} net the network
 * @param {object} res a solved result from {@link solveNetwork} or {@link hardyCross}
 * @returns {{ok:boolean, imbalance:Object<string,number>, supply:Object<string,number>,
 *   maxImbalance_m3h:number, reason?:string}} per-junction residual and per-reservoir supply
 */
export function nodeBalance(net, res) {
  if (!net || net.ok !== true || !res || !res.Q) {
    return { ok: false, reason: 'nodeBalance wants a network and a solved result', imbalance: {}, supply: {}, maxImbalance_m3h: 0 };
  }
  const net_ = new Float64Array(net.nodes.length);
  for (let k = 0; k < net.links.length; k += 1) {
    net_[net.links[k].from] += res.Q[k];
    net_[net.links[k].to] -= res.Q[k];
  }
  const imbalance = Object.create(null);
  const supply = Object.create(null);
  let worst = 0;
  for (let i = 0; i < net.nodes.length; i += 1) {
    const node = net.nodes[i];
    if (node.fixed) {
      supply[node.id] = net_[i];
    } else {
      // net_ is the flow leaving node i through links; continuity wants it to equal -demand.
      const e = net_[i] + res.demand_m3h[i];
      imbalance[node.id] = e;
      worst = Math.max(worst, Math.abs(e));
    }
  }
  return { ok: true, imbalance, supply, maxImbalance_m3h: worst };
}

// ---------------------------------------------------------------------------------------------
// Loops — the topology Hardy Cross needs, and the energy check everyone needs
// ---------------------------------------------------------------------------------------------

/**
 * The vertex a node belongs to once every fixed-head node is merged into one.
 *
 * That merge is the standard trick for handling several reservoirs. A cycle that passes "through"
 * the merged vertex is a PSEUDO-LOOP: it is not a loop in the pipework, it is a path between two
 * reservoirs, and its energy equation balances against their head difference rather than against
 * zero. Handling both kinds with one piece of code is the whole reason for the merge.
 *
 * @param {object} net the network
 * @param {number} i node index
 * @returns {number} vertex index; 0 is the merged reservoir vertex
 */
function superNode(net, i) {
  const j = net.juncOf[i];
  return j < 0 ? 0 : j + 1;
}

/**
 * Breadth-first spanning tree of the merged graph, rooted at the reservoir vertex.
 * @param {object} net the network
 * @returns {object} `{nv, order, parentLink, parentVertex, inTree}`
 */
function spanningTree(net) {
  const nv = net.nJunctions + 1;
  const adj = [];
  for (let v = 0; v < nv; v += 1) adj.push([]);
  for (let k = 0; k < net.links.length; k += 1) {
    const a = superNode(net, net.links[k].from);
    const b = superNode(net, net.links[k].to);
    if (a === b) continue;
    adj[a].push(k);
    adj[b].push(k);
  }
  const parentLink = new Array(nv).fill(-1);
  const parentVertex = new Array(nv).fill(-1);
  const seen = new Array(nv).fill(false);
  const order = [0];
  seen[0] = true;
  for (let qi = 0; qi < order.length; qi += 1) {
    const v = order[qi];
    for (const k of adj[v]) {
      const a = superNode(net, net.links[k].from);
      const w = a === v ? superNode(net, net.links[k].to) : a;
      if (seen[w]) continue;
      seen[w] = true;
      parentLink[w] = k;
      parentVertex[w] = v;
      order.push(w);
    }
  }
  const inTree = new Array(net.links.length).fill(false);
  for (let v = 1; v < nv; v += 1) if (parentLink[v] >= 0) inTree[parentLink[v]] = true;
  return { nv, adj, order, parentLink, parentVertex, inTree };
}

/**
 * The signed walk from a vertex back to the root, along tree links.
 * @param {object} net the network
 * @param {object} tree from {@link spanningTree}
 * @param {number} v the vertex
 * @returns {Array<{k:number, sign:number}>} link indices with +1 for forward traversal
 */
function pathToRoot(net, tree, v) {
  const path = [];
  let cur = v;
  while (cur !== 0 && tree.parentLink[cur] >= 0) {
    const k = tree.parentLink[cur];
    path.push({ k, sign: superNode(net, net.links[k].from) === cur ? 1 : -1 });
    cur = tree.parentVertex[cur];
  }
  return path;
}

/**
 * The fundamental loops of a network: one per link outside a spanning tree.
 *
 * There are exactly `nLinks - nJunctions` of them once the reservoirs are merged, and every
 * possible loop equation is a linear combination of these. That count is worth checking on a
 * network you have drawn by hand — if it surprises you, the drawing is wrong.
 *
 * @param {object} net the network
 * @returns {{ok:boolean, loops:Array<{links:number[], signs:number[]}>, reason?:string}} the loops
 */
export function fundamentalLoops(net) {
  if (!net || net.ok !== true) return { ok: false, loops: [], reason: 'fundamentalLoops wants a network' };
  const tree = spanningTree(net);
  const loops = [];
  for (let k = 0; k < net.links.length; k += 1) {
    if (tree.inTree[k]) continue;
    const a = superNode(net, net.links[k].from);
    const b = superNode(net, net.links[k].to);
    const acc = new Map();
    const add = (kk, s) => { acc.set(kk, (acc.get(kk) || 0) + s); };
    add(k, 1);
    if (a !== b) {
      for (const e of pathToRoot(net, tree, b)) add(e.k, e.sign);
      for (const e of pathToRoot(net, tree, a)) add(e.k, -e.sign);
    }
    const links = [];
    const signs = [];
    for (const [kk, s] of acc) {
      if (s === 0) continue;
      links.push(kk);
      signs.push(s);
    }
    loops.push({ links, signs });
  }
  return { ok: true, loops };
}

/**
 * The known head difference a loop must balance against: zero for a true loop in the pipework,
 * and the reservoir head difference for a pseudo-loop between two fixed-head nodes.
 * @param {object} net the network
 * @param {{links:number[], signs:number[]}} loop the loop
 * @param {Float64Array} H node heads (only the fixed entries are read)
 * @returns {number} the offset, m
 */
function loopHeadOffset(net, loop, H) {
  let off = 0;
  for (let t = 0; t < loop.links.length; t += 1) {
    const l = net.links[loop.links[t]];
    const hf = net.nodes[l.from].fixed ? H[l.from] : 0;
    const ht = net.nodes[l.to].fixed ? H[l.to] : 0;
    off += loop.signs[t] * (hf - ht);
  }
  return off;
}

/**
 * Energy residual around every fundamental loop of a solved network, m.
 *
 * This is the check the gradient method does NOT get for free. Continuity it enforces exactly;
 * the loop energy balance is the nonlinear half, and it is the one that says the answer is
 * actually converged rather than merely stationary.
 *
 * @param {object} net the network
 * @param {object} res a solved result
 * @returns {{ok:boolean, residuals:number[], max_m:number, reason?:string}} per-loop residual
 */
export function loopResiduals(net, res) {
  if (!net || net.ok !== true || !res || !res.Q || !res.resolved) {
    return { ok: false, residuals: [], max_m: 0, reason: 'loopResiduals wants a solved result' };
  }
  const lp = fundamentalLoops(net);
  if (!lp.ok) return { ok: false, residuals: [], max_m: 0, reason: lp.reason };
  const out = [];
  let worst = 0;
  for (const loop of lp.loops) {
    let sum = 0;
    for (let t = 0; t < loop.links.length; t += 1) {
      const k = loop.links[t];
      sum += loop.signs[t] * linkHead_m(res.resolved[k], res.Q[k]);
    }
    const e = sum - loopHeadOffset(net, loop, res.H);
    out.push(e);
    worst = Math.max(worst, Math.abs(e));
  }
  return { ok: true, residuals: out, max_m: worst };
}

// ---------------------------------------------------------------------------------------------
// Hardy Cross — kept for the comparison, not for the answer
// ---------------------------------------------------------------------------------------------

/**
 * Solve a network by the Hardy Cross method of balanced heads.
 *
 * The method starts from ANY flow distribution that satisfies continuity — obtained here by
 * loading the spanning tree from the leaves inward, so continuity holds by construction — and
 * then corrects one loop at a time by the amount that would zero that loop's energy residual if
 * no other loop existed. Continuity survives every correction, because a loop correction adds the
 * same flow to every link around a closed circuit.
 *
 * That last property is the method's charm and its failing. Because each loop is corrected in
 * ignorance of the others, the iteration is a Gauss-Seidel sweep on the loop equations and
 * converges LINEARLY, at a rate set by how strongly the loops share links. On a header feeding
 * three consumers — where every loop shares the pump — it crawls. The gradient method solves all
 * the loops at once and converges quadratically. Run both on the same network and the difference
 * is not subtle.
 *
 * @param {object} net a network from {@link createNetwork}
 * @param {object} [opts] the same overrides as {@link solveNetwork}, plus `tolFlow_m3h`/`maxSweeps`
 * @returns {object} the same result shape as {@link solveNetwork}, with `method:'hardy-cross'`
 */
export function hardyCross(net, opts = {}) {
  if (!net || net.ok !== true || !Array.isArray(net.links)) {
    return { ok: false, reason: 'hardyCross wants a network from createNetwork()' };
  }
  const P = resolveLinks(net, opts);
  const nl = net.links.length;
  const nn = net.nodes.length;
  const tolFlow = opts.tolFlow_m3h === undefined ? 1e-11 : opts.tolFlow_m3h;
  const maxSweeps = opts.maxSweeps === undefined ? SOLVER.MAX_SWEEPS : opts.maxSweeps;
  const headOv = opts.head || {};
  const demandOv = opts.demand || {};

  const H = new Float64Array(nn);
  const d = new Float64Array(nn);
  for (let i = 0; i < nn; i += 1) {
    const node = net.nodes[i];
    d[i] = demandOv[node.id] === undefined ? node.demand_m3h : demandOv[node.id];
    if (node.fixed) H[i] = headOv[node.id] === undefined ? node.head_m : headOv[node.id];
  }

  const tree = spanningTree(net);
  const Q = new Float64Array(nl);
  if (opts.Q0) {
    for (let k = 0; k < nl; k += 1) if (Number.isFinite(opts.Q0[k])) Q[k] = opts.Q0[k];
  }
  // Load the tree from the leaves inward: every vertex settles its own demand plus whatever its
  // children and the non-tree links already carry, and hands the balance to its parent link.
  for (let oi = tree.order.length - 1; oi >= 1; oi -= 1) {
    const v = tree.order[oi];
    const pk = tree.parentLink[v];
    if (pk < 0) continue;
    let leaving = 0;
    for (const k of tree.adj[v]) {
      if (k === pk) continue;
      leaving += superNode(net, net.links[k].from) === v ? Q[k] : -Q[k];
    }
    const need = -d[net.slotNode[v - 1]] - leaving;
    Q[pk] = superNode(net, net.links[pk].from) === v ? need : -need;
  }

  const lp = fundamentalLoops(net);
  const offsets = lp.loops.map((loop) => loopHeadOffset(net, loop, H));
  let sweeps = 0;
  let maxCorr = Infinity;
  let converged = lp.loops.length === 0;
  for (let it = 0; it < maxSweeps && !converged; it += 1) {
    sweeps = it + 1;
    maxCorr = 0;
    for (let li = 0; li < lp.loops.length; li += 1) {
      const loop = lp.loops[li];
      let R = -offsets[li];
      let Gsum = 0;
      for (let t = 0; t < loop.links.length; t += 1) {
        const k = loop.links[t];
        R += loop.signs[t] * linkHead_m(P[k], Q[k]);
        Gsum += linkGradient(P[k], Q[k]);
      }
      const corr = -R / Math.max(Gsum, SOLVER.MIN_GRADIENT);
      for (let t = 0; t < loop.links.length; t += 1) Q[loop.links[t]] += loop.signs[t] * corr;
      maxCorr = Math.max(maxCorr, Math.abs(corr));
    }
    if (maxCorr <= tolFlow) converged = true;
  }

  // Heads follow from the converged flows: walk out from the reservoirs, dropping each link's
  // loss as it goes. With the loops balanced, every route to a junction gives the same answer.
  const known = new Array(nn).fill(false);
  const queue = [];
  for (let i = 0; i < nn; i += 1) if (net.nodes[i].fixed) { known[i] = true; queue.push(i); }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const v = queue[qi];
    for (const k of net.incident[v]) {
      const l = net.links[k];
      const w = l.from === v ? l.to : l.from;
      if (known[w]) continue;
      const h = linkHead_m(P[k], Q[k]);
      H[w] = l.from === v ? H[v] - h : H[v] + h;
      known[w] = true;
      queue.push(w);
    }
  }

  const res = buildResult(net, P, Q, H, d, {
    method: 'hardy-cross', iterations: sweeps, converged, maxCorrection_m3h: maxCorr,
  });
  if (!converged) {
    return {
      ...res,
      ok: false,
      reason: `Hardy Cross did not settle below ${tolFlow} m3/h in ${maxSweeps} sweeps `
        + `(last correction ${maxCorr.toPrecision(3)} m3/h) — the loops are strongly coupled`,
    };
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// The distribution case: one header, three consumers, three control valves
// ---------------------------------------------------------------------------------------------

/**
 * Build a pump station feeding several consumers at different elevations, each through its own
 * control valve, from a common header.
 *
 * SIZED, NOT GUESSED. The builder does the arithmetic a process engineer does on paper:
 *
 *   1. the header head is whatever the pump makes at the TOTAL design flow, less the loss from
 *      the suction tank to the header;
 *   2. each branch therefore has `dH_i = H_header - z_i` to spend, and at its design flow that
 *      fixes the branch's total resistance exactly: `K_i = dH_i / Q_i^2`;
 *   3. the valve takes `authority` of that drop and the branch pipe takes the rest — the
 *      valve-authority rule, which exists because a valve with too little of the drop has almost
 *      no effect on flow until it is nearly shut, and then all of it at once;
 *   4. the valve is sized so that it reaches its share AT THE DESIGN TRAVEL, not at full open,
 *      which is what leaves it room to open further when the branch fouls.
 *
 * Because every step is arithmetic, the network the builder returns has a KNOWN answer: solved at
 * the design travels and the design speed it must reproduce the design flows exactly. That makes
 * this both the interesting case and a validation of the solver.
 *
 * @param {object} spec the station
 * @param {string} [spec.tag] a name
 * @param {object} spec.pump a pump from `createPump` or `deratedPump`
 * @param {number} [spec.speed=1] pump speed ratio
 * @param {number} [spec.suctionHead_m=0] head at the suction tank surface, m on the datum
 * @param {number} [spec.supplyK=0.002] resistance from the tank through the pump to the header,
 *   m per (m3/h)^2
 * @param {Array<object>} spec.consumers `{tag, elevation_m, designFlow_m3h, valveAuthority,
 *   designTravel, trim, rangeability}` — one per consumer
 * @returns {object} `{ok:true, net, design, consumers, travel, speed, solveOpts, ...}` or
 *   `{ok:false, reason}`
 */
export function createDistributionNetwork(spec) {
  if (!spec || !spec.pump || !(spec.pump.a2 > 0)) {
    return { ok: false, reason: 'a distribution network needs a pump from createPump()' };
  }
  if (!Array.isArray(spec.consumers) || spec.consumers.length < 1) {
    return { ok: false, reason: 'a distribution network needs at least one consumer' };
  }
  const s = spec.speed === undefined ? 1 : spec.speed;
  if (!(s > SOLVER.MIN_SPEED)) {
    return { ok: false, reason: 'the design speed must be above the pump minimum, or nothing flows' };
  }
  const suctionHead = spec.suctionHead_m === undefined ? 0 : spec.suctionHead_m;
  const supplyK = spec.supplyK === undefined ? 0.002 : spec.supplyK;

  let Qtot = 0;
  for (const c of spec.consumers) {
    if (!c || typeof c.tag !== 'string' || !(c.designFlow_m3h > 0)) {
      return { ok: false, reason: 'every consumer needs a tag and a positive designFlow_m3h' };
    }
    Qtot += c.designFlow_m3h;
  }
  const pumpHead = headAt(spec.pump, Qtot, s);
  const headerHead = suctionHead + pumpHead - supplyK * Qtot * Qtot;

  const nodes = [
    { id: 'SUCTION', fixed: true, head_m: suctionHead },
    { id: 'HEADER' },
  ];
  const links = [{
    id: spec.pumpTag || 'P-NET',
    kind: LINK.PUMP,
    from: 'SUCTION',
    to: 'HEADER',
    pump: spec.pump,
    speed: s,
    r: supplyK,
    check: true,
  }];
  const consumers = [];
  const travel = Object.create(null);
  for (const c of spec.consumers) {
    const z = c.elevation_m === undefined ? 0 : c.elevation_m;
    const dH = headerHead - z;
    if (!(dH > 0)) {
      return {
        ok: false,
        reason: `consumer "${c.tag}" sits at ${z} m and the header only reaches `
          + `${headerHead.toFixed(2)} m at the design flow — nothing would reach it`,
      };
    }
    const authority = c.valveAuthority === undefined ? 0.35 : c.valveAuthority;
    if (!(authority > 0 && authority < 1)) {
      return { ok: false, reason: `consumer "${c.tag}" needs 0 < valveAuthority < 1` };
    }
    const designTravel = c.designTravel === undefined ? 0.6 : c.designTravel;
    const Kbranch = dH / (c.designFlow_m3h * c.designFlow_m3h);
    const Kvalve = authority * Kbranch;
    const Kpipe = (1 - authority) * Kbranch;
    const probe = createValve({
      tag: c.valveTag || `${c.tag}-FCV`,
      kvMax_m3h: 1,
      trim: c.trim || TRIM.EQUAL_PCT,
      rangeability: c.rangeability || 50,
    });
    const frac = trimFraction(probe, designTravel);
    const valve = createValve({
      tag: probe.tag,
      kvMax_m3h: kvForResistance(Kvalve) / frac,
      trim: probe.trim,
      rangeability: probe.rangeability,
    });
    nodes.push({ id: c.tag, fixed: true, head_m: z, elevation_m: z });
    links.push({
      id: valve.tag, kind: LINK.VALVE, from: 'HEADER', to: c.tag, valve, travel: designTravel, r: Kpipe,
    });
    travel[valve.tag] = designTravel;
    consumers.push(Object.freeze({
      tag: c.tag,
      valveTag: valve.tag,
      elevation_m: z,
      designFlow_m3h: c.designFlow_m3h,
      designTravel,
      valveAuthority: authority,
      branchK: Kbranch,
      valveK: Kvalve,
      pipeK: Kpipe,
      kvMax_m3h: valve.kvMax_m3h,
      valve,
    }));
  }

  const net = createNetwork({ tag: spec.tag || 'DIST', nodes, links });
  if (!net.ok) return net;
  const pumpTag = links[0].id;
  const speedMap = Object.create(null);
  speedMap[pumpTag] = s;
  return Object.freeze({
    ok: true,
    net,
    pumpTag,
    headerNode: 'HEADER',
    consumers: Object.freeze(consumers),
    travel: Object.freeze(travel),
    speed: Object.freeze(speedMap),
    /** Ready to hand straight to {@link solveNetwork} for the design point. */
    solveOpts: Object.freeze({ travel, speed: speedMap }),
    design: Object.freeze({
      totalFlow_m3h: Qtot,
      pumpHead_m: pumpHead,
      headerHead_m: headerHead,
      suctionHead_m: suctionHead,
      supplyK,
      speed: s,
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// Interaction: the steady-state gain matrix and the relative gain array
// ---------------------------------------------------------------------------------------------

/**
 * The steady-state gain matrix and Bristol's relative gain array for a set of valves acting on a
 * set of flows.
 *
 * Gains are measured, not derived: each valve is nudged by `delta/2` either side of its base
 * travel and the network is re-solved, warm-started from the base solution so the difference is
 * clean of solver noise. Central differences, because a one-sided difference on a square-law
 * network carries a first-order error that is the same size as the interaction being measured.
 *
 * @param {object} net a network from {@link createNetwork}
 * @param {object} spec what to measure
 * @param {string[]} spec.inputs valve link ids — the manipulated variables
 * @param {string[]} spec.outputs link ids whose FLOW is the controlled variable
 * @param {object} [spec.solve] base solve options: travels, speeds, demands
 * @param {number} [spec.delta=1e-4] total travel perturbation, fraction of full travel
 * @returns {object} `{ok:true, G, rga, pairings, best, base}` or `{ok:false, reason}`
 */
export function relativeGainArray(net, spec) {
  if (!net || net.ok !== true) return { ok: false, reason: 'relativeGainArray wants a network' };
  if (!spec || !Array.isArray(spec.inputs) || !Array.isArray(spec.outputs)) {
    return { ok: false, reason: 'relativeGainArray wants inputs and outputs arrays' };
  }
  const n = spec.inputs.length;
  if (n < 1 || spec.outputs.length !== n) {
    return { ok: false, reason: 'the RGA is only defined for as many inputs as outputs' };
  }
  if (n > 6) {
    return { ok: false, reason: 'the pairing search is factorial; keep it to six loops or fewer' };
  }
  for (const id of spec.inputs) {
    const k = net.linkIndex[id];
    if (k === undefined) return { ok: false, reason: `input "${id}" is not a link in this network` };
    if (net.links[k].kind !== LINK.VALVE) {
      return { ok: false, reason: `input "${id}" is not a valve, so it has no travel to move` };
    }
  }
  for (const id of spec.outputs) {
    if (net.linkIndex[id] === undefined) {
      return { ok: false, reason: `output "${id}" is not a link in this network` };
    }
  }

  const baseOpts = spec.solve || {};
  const delta = spec.delta === undefined ? 1e-4 : spec.delta;
  const base = solveNetwork(net, baseOpts);
  if (!base.ok) return { ok: false, reason: `the base case did not solve: ${base.reason}` };

  const baseTravel = Object.create(null);
  for (const l of net.links) {
    if (l.kind !== LINK.VALVE) continue;
    const t = baseOpts.travel && baseOpts.travel[l.id] !== undefined ? baseOpts.travel[l.id] : l.travel;
    baseTravel[l.id] = clamp(t, 0, 1);
  }

  const outIdx = spec.outputs.map((id) => net.linkIndex[id]);
  const G = [];
  for (let i = 0; i < n; i += 1) G.push(new Array(n).fill(0));
  for (let j = 0; j < n; j += 1) {
    const id = spec.inputs[j];
    // Keep the pair of perturbed travels inside [0, 1] by sliding the pair, never by shrinking
    // it: an asymmetric difference would report a gain that is part curvature.
    let lo = baseTravel[id] - delta / 2;
    let hi = baseTravel[id] + delta / 2;
    if (lo < 0) { lo = 0; hi = delta; }
    if (hi > 1) { hi = 1; lo = 1 - delta; }
    const warm = { ...baseOpts, Q0: base.Q, H0: base.H };
    const up = solveNetwork(net, { ...warm, travel: { ...baseTravel, ...(baseOpts.travel || {}), [id]: hi } });
    const dn = solveNetwork(net, { ...warm, travel: { ...baseTravel, ...(baseOpts.travel || {}), [id]: lo } });
    if (!up.ok || !dn.ok) {
      return { ok: false, reason: `perturbing "${id}" broke the solve: ${(up.ok ? dn : up).reason}` };
    }
    for (let i = 0; i < n; i += 1) G[i][j] = (up.Q[outIdx[i]] - dn.Q[outIdx[i]]) / (hi - lo);
  }

  const invRes = invertMatrix(G, n);
  if (!invRes.ok) return { ok: false, reason: invRes.reason, G };
  const rga = [];
  for (let i = 0; i < n; i += 1) {
    const row = new Array(n);
    for (let j = 0; j < n; j += 1) row[j] = G[i][j] * invRes.inv[j][i];
    rga.push(row);
  }

  const pairings = [];
  for (const perm of permutations(n)) {
    // perm[i] is the input driving output i.
    let score = 0;
    let minLambda = Infinity;
    for (let i = 0; i < n; i += 1) {
      const lam = rga[i][perm[i]];
      score += Math.abs(1 - lam);
      minLambda = Math.min(minLambda, lam);
    }
    const M = [];
    for (let i = 0; i < n; i += 1) {
      const row = new Array(n);
      for (let j = 0; j < n; j += 1) row[j] = G[i][perm[j]];
      M.push(row);
    }
    const mres = invertMatrix(M, n);
    let prod = 1;
    for (let i = 0; i < n; i += 1) prod *= M[i][i];
    const ni = mres.ok && prod !== 0 ? mres.det / prod : NaN;
    pairings.push({
      /** `pairs[i] = {output, input}` — which valve is asked to hold which flow. */
      pairs: spec.outputs.map((o, i) => ({ output: o, input: spec.inputs[perm[i]] })),
      permutation: perm.slice(),
      lambda: perm.map((j, i) => rga[i][j]),
      score,
      minLambda,
      niederlinski: ni,
      /** Both conditions are NECESSARY for stability with integral action in every loop. */
      integralStable: minLambda > 0 && ni > 0,
    });
  }
  pairings.sort((a, b) => {
    if (a.integralStable !== b.integralStable) return a.integralStable ? -1 : 1;
    return a.score - b.score;
  });

  return {
    ok: true,
    inputs: spec.inputs.slice(),
    outputs: spec.outputs.slice(),
    G,
    rga,
    det: invRes.det,
    pairings,
    best: pairings[0],
    worst: pairings[pairings.length - 1],
    base,
  };
}

/**
 * Every permutation of `0..n-1`, smallest first. Used to score candidate pairings exhaustively,
 * which is affordable precisely because the RGA is only worth looking at on a handful of loops.
 * @param {number} n the order
 * @returns {Array<number[]>} the permutations
 */
function permutations(n) {
  const out = [];
  const cur = [];
  const used = new Array(n).fill(false);
  const walk = () => {
    if (cur.length === n) { out.push(cur.slice()); return; }
    for (let i = 0; i < n; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      walk();
      cur.pop();
      used[i] = false;
    }
  };
  walk();
  return out;
}
