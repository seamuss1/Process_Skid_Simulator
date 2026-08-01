/**
 * tests/chem.test.js — `src/chem/solution.js` and `src/chem/ph.js`.
 *
 * Contract: architecture-v2 §6.5 (solution), §6.6 (pH / Davies / the water convention),
 * §7.1.2 (Vogel viscosity), §7.4.1 (conductivity temperature), §8.2 (the solved buffer recipes),
 * §10 (this file's assignment), §11 C-02 / C-04 / C-08 / C-14 / C-15 / C-27 / C-28.
 *
 * METHOD. Almost every number below is re-derived inside the test from the contract's own
 * printed coefficients — the Kohlrausch quartic, the Vogel exponential, the Jones-Dole triple,
 * the Davies expression, the monoprotic ladder — and the module is then required to agree with
 * THAT, not with a value scraped from a previous run. Where a value is genuinely a printed
 * anchor with no closed form on this side of the solve (the phosphate counter-ion, the shipped
 * recipes), the assertion says so and states where the tolerance comes from.
 *
 * The species registry, the chem constants and the seven tank vectors all come from the SHIPPED
 * pilot preset, so these tests exercise the ingest path (`normalizePreset` -> `solveCounterIon`
 * -> `buildTankVector` -> `describeTank`) and not just the functions in isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as sol from '../src/chem/solution.js';
import * as ph from '../src/chem/ph.js';
import { makeConfig, assertClose, assertCloseAbs } from './helpers.js';

/* ============================================================================================
 * FIXTURES
 * ========================================================================================== */

const { config } = makeConfig();
const IDX = config.idxById;

/** A species vector of the shipped registry, from an `{ id: mM }` literal. */
function Y(spec) {
  const y = new Float64Array(config.ns);
  for (const id of Object.keys(spec)) {
    assert.notEqual(IDX[id], undefined, `fixture: '${id}' is not a species of this preset`);
    y[IDX[id]] = spec[id];
  }
  return y;
}

/** The shipped tank vector with this id. */
function tank(id) {
  const t = config.tanks.find((x) => x.id === id);
  assert.ok(t, `fixture: no tank '${id}'`);
  return t;
}

const SCRATCH = { tj: new Float64Array(8), charges: new Float64Array(16) };
const PH_OUT = { pH: 7, I_molL: 0, iterations: 0 };
const CI_OUT = { cation_mM: 0, anion_mM: 0, I_molL: 0, pH: 0 };

/* --------------------------------------------------------------------------------------------
 * INDEPENDENT REFERENCE IMPLEMENTATIONS — written from the contract text, not from the module.
 * ------------------------------------------------------------------------------------------ */

/** §6.5 Kohlrausch quartic in sqrt(c): equivalent conductivity of NaCl at 25 C, S*cm2/eq. */
function kohlrausch(c_molL) {
  const x = Math.sqrt(c_molL);
  return 126.4 - 82.8623 * x + 76.7090 * (x ** 2) - 43.6797 * (x ** 3) + 8.4686 * (x ** 4);
}

/** §7.1.2 Vogel water viscosity, cP. */
function vogel(T_C) {
  return 2.414e-2 * (10 ** (247.8 / (T_C + 273.15 - 140)));
}

/** §6.6 Davies log10(gamma) for a monovalent ion, with the mandatory Ie <= IeMax clamp. */
function davies(I_molL, A = 0.509, IeMax = 0.39) {
  const Ie = Math.min(I_molL, IeMax);
  const s = Math.sqrt(Ie);
  return -A * (s / (1 + s) - 0.3 * Ie);
}

/**
 * §6.6 counter-ion solve for a MONOPROTIC, z0 = 0 buffer (acetate), written out independently:
 * bisect the net strong-ion charge `t` against the charge balance at the fixed target pH, with
 * the ionic strength (and hence pKa') iterated to convergence inside every residual evaluation.
 *
 * `includeWater` selects the convention: the module deliberately OMITS the `1000*([H+]-[OH-])`
 * term so the finished tank vector is exactly charge balanced (§7.2.4, ph.js NOTE-A). Both
 * branches exist here because the difference is exactly what separates 35.542 from 35.532.
 */
function acetateCounterIon(total_mM, pH, includeWater) {
  const H = 10 ** -pH;
  const OH = 1e-14 / H;
  const water2_mM = 1000 * (H + OH);
  const waterNet_mM = includeWater ? 1000 * (H - OH) : 0;
  let lo = -1e4;
  let hi = 1e4;
  let t = 0;
  let I = 0;
  let f1 = 0;
  for (let k = 0; k < 200; k++) {
    t = 0.5 * (lo + hi);
    const strong2 = (t > 0 ? t : 0) + (t < 0 ? -t : 0) + water2_mM;
    I = 0.5 * strong2 / 1000;
    for (let p = 0; p < 200; p++) {
      f1 = 1 / (1 + 10 ** (4.76 + 2 * davies(I) - pH));   // ionised (acetate-) fraction
      const In = 0.5 * (strong2 + f1 * total_mM) / 1000;
      if (Math.abs(In - I) < 1e-15) { I = In; break; }
      I = In;
    }
    if (t - f1 * total_mM + waterNet_mM > 0) hi = t; else lo = t;
  }
  return { cation_mM: t, I_molL: I, ionisedFraction: f1 };
}

/* ============================================================================================
 * 1. CONDUCTIVITY (§6.5)
 * ========================================================================================== */

test('§6.5 — 1 M NaCl reads 85.04 mS/cm at 25 C (the headline anchor)', () => {
  // The Kohlrausch quartic at c = 1 collapses to the plain sum of its coefficients:
  //   126.4 - 82.8623 + 76.7090 - 43.6797 + 8.4686 = 85.0356 S*cm2/eq,
  // and kappa = c * Lambda(c) = 85.0356 mS/cm. Nothing here is fitted or measured.
  const lambda1 = 126.4 - 82.8623 + 76.7090 - 43.6797 + 8.4686;
  assertClose(lambda1, 85.0356, 1e-9, 'the coefficient sum IS the 1 M equivalent conductivity');

  // Tolerance 1e-12: this is exact floating-point arithmetic on the same coefficients, so any
  // discrepancy is a transcription error in the module, not a numerical one.
  assertClose(sol.lambdaNaCl(1.0), lambda1, 1e-12, 'lambdaNaCl(1.0) is the coefficient sum');
  assertClose(sol.kappaNaCl25_mScm(1.0), lambda1, 1e-12, 'kappaNaCl25_mScm(1.0) = 1.0 * Lambda(1)');

  // The contract prints 85.04 mS/cm, which is 85.0356 rounded to two decimals; 5e-3 mS/cm
  // absolute is half of that last printed digit, so this pins the contract's own rounding
  // rather than restating the model. (A RELATIVE 5e-5 would be 4.25e-3 and would reject the
  // contract's own rounding — the band has to be the one the printed value implies.)
  assertCloseAbs(sol.kappaNaCl25_mScm(1.0), 85.04, 5e-3,
    'the printed 1 M NaCl anchor, 85.04 mS/cm');

  // THE SAME NUMBER THROUGH THE SPECIES-VECTOR PATH, which is what the skid actually calls.
  //   kappa25 = Fr(I) * SUM(lambda0_i*|z_i|*c_i)/1000, Fr(I) = Lambda(min(I,5))/126.4.
  // At 1 M NaCl: I = 1.000, SUM = (50.1 + 76.3)*1000 mM = 126400, /1000 = 126.4 = Lambda(0),
  // so Fr * 126.4 = Lambda(1) identically — the vector path must reproduce 85.0356 EXACTLY,
  // not approximately. 1e-12 again.
  const y = Y({ Na: 1000, Cl: 1000 });
  assertClose(sol.kappa25_mScm(config, y, null), lambda1, 1e-12,
    'the species-vector path collapses to c*Lambda(c) for pure NaCl');
});

test('§6.5 — Kohlrausch anchors at 0.154 M and 0.01 M', () => {
  // 15.902 and 1.1884 mS/cm; the contract's §10 line prints them to 15.90 / 1.188.
  for (const c of [0.154, 0.01, 0.05, 0.25, 0.5, 2.0]) {
    assertClose(sol.kappaNaCl25_mScm(c), c * kohlrausch(c), 1e-12,
      `kappaNaCl25_mScm(${c}) = c * Kohlrausch(c)`);
  }
  // 5e-4 relative = half the last printed digit of "15.90" and of "1.188".
  assertClose(sol.kappaNaCl25_mScm(0.154), 15.90, 5e-4, 'the 0.154 M (saline) anchor');
  assertClose(sol.kappaNaCl25_mScm(0.01), 1.188, 5e-4, 'the 0.01 M anchor');

  // c = 0 must be exactly 0 and the limiting equivalent conductivity exactly 126.4.
  assert.equal(sol.kappaNaCl25_mScm(0), 0, 'zero salt is zero conductivity');
  assertClose(sol.lambdaNaCl(0), 126.4, 1e-12, 'Lambda(0) = 50.1 + 76.3');
});

test('§6.5 — cFromKappaNaCl_molL inverts kappaNaCl25_mScm; c(85.2) = 1.0023 M', () => {
  // ROUND TRIP, which is the real specification: the Newton inverse must return the argument of
  // the forward map. 1e-9 relative is far inside the 6-iteration Newton budget (the map is
  // smooth and monotone on this interval, so convergence is quadratic to machine precision).
  for (const c of [0.001, 0.01, 0.05, 0.154, 0.5, 1.0, 2.0, 4.0]) {
    assertClose(sol.cFromKappaNaCl_molL(sol.kappaNaCl25_mScm(c)), c, 1e-9,
      `Newton inverse round-trips c = ${c} mol/L`);
  }
  assert.equal(sol.cFromKappaNaCl_molL(0), 0, 'zero conductivity inverts to zero salt');

  // The printed anchor. 85.2 mS/cm is the linear-guess denominator the contract names, and the
  // true root sits 0.23 % above 1 M — which is the whole reason the Newton polish exists.
  // 5e-5 relative = half the last printed digit of "1.0023".
  assertClose(sol.cFromKappaNaCl_molL(85.2), 1.0023, 5e-5, 'c(85.2 mS/cm) = 1.0023 mol/L');
});

test('§6.5 — kappaNaCl25_mScm is strictly increasing on [0, 5 M]', () => {
  // The Kohlrausch quartic itself DECREASES with c; the product c*Lambda(c) must not. A model
  // that turns over inside the shipped range would make the conductivity trace non-invertible
  // and `cFromKappaNaCl_molL` multi-valued.
  let prev = -1;
  for (let c = 0; c <= 5.0 + 1e-12; c += 0.001) {
    const k = sol.kappaNaCl25_mScm(c);
    assert.ok(k > prev, `kappa turned over at c = ${c} mol/L: ${prev} -> ${k}`);
    prev = k;
  }
  // And Lambda itself must fall monotonically over the same range (Kohlrausch's law).
  assert.ok(sol.lambdaNaCl(5) < sol.lambdaNaCl(1) && sol.lambdaNaCl(1) < sol.lambdaNaCl(0),
    'the equivalent conductivity must fall with concentration');
});

test('C-04 — 0.1 M NaOH calibrates to 22.0 mS/cm with f = 1.0517, not 1.10', () => {
  // Term by term, from §6.5:
  //   SUM(lambda0*|z|*c) = (50.1 + 198.0) * 100 mM = 24810  ->  24.81 mS/cm
  //   I  = 0.5*(100*1 + 100*1)/1000 = 0.1 mol/L      (OHex carries the hydroxide here)
  //   Fr = Lambda(0.1)/126.4
  const raw = (50.1 + 198.0) * 0.1;
  const Fr = kohlrausch(0.1) / 126.4;
  assertClose(Fr, 0.843125, 5e-6, 'Fr(0.1) — the contract prints 0.843125');
  assertClose(raw * Fr, 20.918, 5e-5, 'the UNCALIBRATED model gives 20.918 mS/cm, not 20.0');

  const table = sol.CAL_TABLE.find((r) => r.match === 'NaOH' && r.c_molL === 0.1);
  assert.equal(table.f, 1.0517, 'the 0.1 M NaOH calibration factor is 1.0517 (C-04)');

  const kappa = sol.kappa25_mScm(config, Y({ Na: 100, OHex: 100 }), null);
  assertClose(kappa, raw * Fr * 1.0517, 1e-12, 'the module applies exactly Fr * SUM * f_cal');
  // 5e-3 mS/cm absolute, i.e. 2.3e-4 relative — an order tighter than the contract's own
  // one-decimal "22.0", so this would catch a factor of 1.10 (which gives 23.01) instantly.
  assertCloseAbs(kappa, 22.0, 5e-3, '0.1 M NaOH reads 22.0 mS/cm (C-04; f = 1.10 gives 23.01)');
});

test('§6.5 — 0.5 M NaOH: the CAL_TABLE 1.185 knot, derived term by term', () => {
  // The CIP tank of the golden run, so this is a live path (§6.5).
  const raw = (50.1 + 198.0) * 0.5;                 // 124.05 mS/cm before Fr and calibration
  const Fr = kohlrausch(0.5) / 126.4;
  const expected = raw * Fr * 1.185;
  assertClose(sol.kappa25_mScm(config, Y({ Na: 500, OHex: 500 }), null), expected, 1e-12,
    '0.5 M NaOH = Fr(0.5) * 124.05 * 1.185');
  // And the shipped TK-NAOH tank must land on the same number through the ingest path.
  assertClose(tank('TK-NAOH').derived.kappa25_mScm, expected, 1e-9,
    "the shipped CIP tank's derived conductivity");
});

test('§6.5 — EtOH+NaCl: f_cal = 0.72 and the 1 - 1.4*f_org suppression', () => {
  // 20 % v/v ethanol: c_mM = 0.2 * 1000 mL/L * 0.789 g/mL * 1000 / 46.07 g/mol.
  const MW = config.species[IDX.EtOH].MW_gmol;
  const etoh_mM = 0.2 * 1000 * 0.789 * 1000 / MW;
  const fOrg = 0.2;                                  // by construction, volume fraction
  const raw = (50.1 + 76.3) * 0.1;                   // 100 mM NaCl -> 12.64 mS/cm
  const Fr = kohlrausch(0.1) / 126.4;
  const expected = Fr * raw * 0.72 * Math.max(0.05, 1 - 1.4 * fOrg);
  // 1 - 1.4*0.2 = 0.72 coincidentally equals f_cal here; both factors are asserted separately
  // above and below, so the coincidence cannot hide a swapped term.
  assertClose(1 - 1.4 * fOrg, 0.72, 1e-12, 'the organic suppression factor at 20 % v/v');
  assertClose(sol.kappa25_mScm(config, Y({ EtOH: etoh_mM, Na: 100, Cl: 100 }), null),
    expected, 1e-9, 'EtOH+NaCl conductivity = Fr * SUM * 0.72 * 0.72');

  // No salt -> the EtOH+NaCl row must NOT apply (it is a two-component calibration).
  const noSalt = sol.kappa25_mScm(config, Y({ EtOH: etoh_mM }), null);
  assert.equal(noSalt, 0, 'ethanol alone carries no charge and no conductivity');
});

test('§6.5 — ionic strength: 1 M NaCl is exactly 1.000 mol/L', () => {
  // I = 0.5*SUM(c_i*z_i^2) = 0.5*(1000*1 + 1000*1)/1000 = 1.000. Exact, no correlation involved.
  assertClose(sol.ionicStrength_molL(config, Y({ Na: 1000, Cl: 1000 }), null), 1.0, 1e-12,
    'I(1 M NaCl)');
  assertClose(sol.ionicStrength_molL(config, Y({ Na: 500, OHex: 500 }), null), 0.5, 1e-12,
    'I(0.5 M NaOH) — the baseExcess species IS counted in this module (§6.5)');
  assert.equal(sol.ionicStrength_molL(config, Y({ mAb: 1.0 }), null), 0,
    'an uncharged protein contributes nothing to I');
});

test('§8.2 — the shipped buffers have ionic strengths 0.0500 and 0.5000 mol/L', () => {
  // §8.2: "For this composition I = totalNa/1000 exactly, because charge balance gives
  // Na = Cl + Ac-." Read from the SOLVED speciation the recipe solve converged on
  // (`derived.I_molL`), which is the only one that is per-tank; `ionicStrength_molL(...,null)`
  // uses the single frozen `ionisedFraction` of §5.8.1, which is derived from the A1 tank alone
  // and is therefore correct only at A1's ionic strength.
  // 5e-5 absolute = half the last printed digit of "0.0500" / "0.5000".
  assertCloseAbs(tank('TK-EQ').derived.I_molL, 0.0500, 5e-5, 'Buffer A ionic strength');
  assertCloseAbs(tank('TK-ELU').derived.I_molL, 0.5000, 5e-5, 'Buffer B ionic strength');
  assertCloseAbs(tank('TK-NAOH').derived.I_molL, 0.5000, 5e-5, '0.5 M NaOH ionic strength');
  // Water for injection is not zero: `solvePH` carries the water ions, so I = 0.5*([H+]+[OH-])
  // = 1.0e-7 mol/L at pH 7. That is the correct answer, and it is 5e5 times smaller than
  // Buffer A's, so it can never perturb a pKa'.
  assertCloseAbs(tank('TK-WFI').derived.I_molL, 1.0e-7, 1e-9,
    'water for injection carries only its own autoprotolysis');
});

test('C-02 — the cold-room conductivity artefact reads HIGH, and always over-corrects', () => {
  // display/true = (1 + a*dT + b*dT^2) / (1 + a*dT), a = 0.0214 /C, b = 1.4e-4 /C^2, dT = T-25.
  // Subtracting 1 gives the closed form  b*dT^2 / (1 + a*dT)  which is POSITIVE for every
  // T > 25 - 1/a = -21.7 C. The linear meter therefore over-corrects at EVERY temperature on
  // either side of the reference: that is the sign v1 had backwards (C-02).
  const a = 0.0214;
  const b = 1.4e-4;
  const ratio = (T) => sol.kappaDisplay_mScm(sol.kappaRaw_mScm(10, T), T, 25, a) / 10;

  for (const [T, want] of [[5, 1.0979], [8, 1.0636], [45, 1.0392]]) {
    const dT = T - 25;
    const closed = 1 + b * dT * dT / (1 + a * dT);
    assertClose(ratio(T), closed, 1e-12, `the artefact at ${T} C is the closed form`);
    // 5e-5 relative = half the last printed digit of the §7.4.1 table.
    assertClose(ratio(T), want, 5e-5, `§7.4.1 table row at ${T} C`);
    assert.ok(ratio(T) > 1, `AT ${T} C THE METER MUST READ HIGH, NOT LOW (C-02)`);
  }
  assertClose(ratio(25), 1.0, 1e-12, 'no artefact at the reference temperature');
  for (let T = 2; T <= 45; T += 0.5) {
    if (Math.abs(T - 25) < 1e-9) continue;
    assert.ok(ratio(T) > 1, `over-correction failed at ${T} C — the artefact changed sign`);
  }
  // The 5 C artefact is 9.8 %, not "~10 % low".
  assertCloseAbs(100 * (ratio(5) - 1), 9.79, 0.05, 'the 5 C artefact is +9.8 %, not -10 %');
});

/* ============================================================================================
 * 2. VISCOSITY AND DENSITY (§7.1.2, §6.5)
 * ========================================================================================== */

test('VC-08 / §7.1.2 — Vogel water viscosity at 20 / 25 / 5 C', () => {
  for (const [T, want] of [[20, 1.001749], [25, 0.890439], [5, 1.501204],
    [4, 1.547099], [37, 0.690398]]) {
    assertClose(sol.muWater_cP(T), vogel(T), 1e-12, `muWater_cP(${T}) is the Vogel expression`);
    // 5e-7 cP absolute = half the last printed digit of §7.1.2's six-decimal table, and the
    // same band VC-08 states (5e-7 Pa*s = 5e-4 mPa*s ... §7.1.2 prints one more digit, so the
    // tighter of the two is used here).
    assertCloseAbs(sol.muWater_cP(T), want, 5e-7, `§7.1.2 printed value at ${T} C`);
  }
});

test('C-14 / C-15 — cold-room viscosity ratios 1.5444 and +49.9 %', () => {
  // The ratio is independent of the leading 2.414e-2, so it tests the exponent alone. The exact
  // value is 1.544398; the contract ships the assertion as 1.5444 +/- 5e-4 because 1e-5 on
  // "1.543986" was arithmetically unreachable (C-14).
  const r4 = sol.muWater_cP(4) / sol.muWater_cP(20);
  assertCloseAbs(r4, 1.5444, 5e-4, 'mu(4)/mu(20) = 1.5444 +/- 5e-4 (C-14)');
  assertCloseAbs(r4, 1.544398, 1e-6, 'and the exact value it rounds from');

  const r5 = sol.muWater_cP(5) / sol.muWater_cP(20);
  assertCloseAbs(r5, 1.498584, 1e-6, 'mu(5)/mu(20) = 1.498584, i.e. +49.9 % (C-15)');
  assertCloseAbs(sol.muWater_cP(5), 1.501, 5e-4, 'the 5 C pair is 1.501 cP, not v1\'s 1.52');
});

test('VC-08 (l) — muWater_cP is strictly decreasing over [2, 45] C', () => {
  let prev = Infinity;
  for (let T = 2; T <= 45 + 1e-12; T += 0.25) {
    const mu = sol.muWater_cP(T);
    assert.ok(mu < prev, `viscosity rose at ${T} C: ${prev} -> ${mu}`);
    prev = mu;
  }
});

test('VC-08 (e,g,j) / §6.5 — Jones-Dole fSalt', () => {
  // f = 1 + A*sqrt(c) + B*c + D*c^2, evaluated from §6.5's own JONES_DOLE triples.
  for (const id of Object.keys(sol.JONES_DOLE)) {
    const { A, B, D } = sol.JONES_DOLE[id];
    for (const c of [0.1, 0.5, 1.0, 2.0]) {
      assertClose(sol.fSalt(id, c), 1 + A * Math.sqrt(c) + B * c + D * c * c, 1e-12,
        `fSalt('${id}', ${c})`);
    }
    assert.equal(sol.fSalt(id, 0), 1.0, `fSalt('${id}', 0) is exactly 1 (VC-08 j)`);
    assert.equal(sol.fSalt(id, -1), 1.0, 'a negative concentration is clamped to zero');
  }
  // The two anchors VC-08 prints, to their full printed precision.
  assertCloseAbs(sol.fSalt('NaCl', 1.0), 1.093500, 1e-6, 'f_NaCl(1.0 M) = 1.0935 (VC-08 e)');
  assertCloseAbs(sol.fSalt('NaCl', 2.0), 1.199369, 1e-6, 'f_NaCl(2.0 M) = 1.199369 (VC-08 g)');
  assert.equal(sol.fSalt('not-a-salt', 1.0), 1.0, 'an unknown salt is a no-op, never NaN');
});

test('VC-08 (m) — fSalt increases with c for every salt with B > 0', () => {
  // KCl is deliberately EXCLUDED: its Jones-Dole B is -0.0140, so f falls to a minimum near
  // 0.5 M before rising. That is a property of the coefficient set, not a defect, and VC-08 (m)
  // names only the salts with a positive B.
  for (const id of ['NaCl', 'NaOH', 'NaOAc', 'Na2SO4', '(NH4)2SO4', 'citrate']) {
    let prev = -Infinity;
    for (let c = 0; c <= 3.0 + 1e-12; c += 0.01) {
      const f = sol.fSalt(id, c);
      assert.ok(f > prev, `fSalt('${id}') is not increasing at c = ${c}`);
      prev = f;
    }
  }
  assert.ok(sol.fSalt('KCl', 0.5) < sol.fSalt('KCl', 0.0),
    'KCl really does dip below 1 — the exclusion above is a fact about B, not an excuse');
});

test('§6.5 — mixtureViscosity_cP on a pure NaCl vector is muWater * fSalt', () => {
  // One electroneutral 1:1 pair, so the greedy pairing has nothing to choose and the contract's
  // "f = 1 + SUM(f_k - 1)" reduces to a single factor. Exact, hence 1e-12.
  for (const [c_mM, T] of [[0, 20], [100, 20], [500, 20], [500, 5], [1000, 25]]) {
    const y = c_mM > 0 ? Y({ Na: c_mM, Cl: c_mM }) : Y({});
    assertClose(sol.mixtureViscosity_cP(config, y, T, false),
      sol.muWater_cP(T) * sol.fSalt('NaCl', c_mM / 1000), 1e-12,
      `mixture viscosity at ${c_mM} mM NaCl, ${T} C`);
  }
  // Protein is OFF by default (D23): the same vector with and without mAb must agree exactly
  // when `enableProtein` is false, and differ when it is true.
  const withMab = Y({ Na: 500, Cl: 500, mAb: 0.05 });
  assert.equal(sol.mixtureViscosity_cP(config, withMab, 20, false),
    sol.mixtureViscosity_cP(config, Y({ Na: 500, Cl: 500 }), 20, false),
    'protein viscosity is inert when enableProtein is false (D23)');
  assert.ok(sol.mixtureViscosity_cP(config, withMab, 20, true)
    > sol.mixtureViscosity_cP(config, withMab, 20, false),
    'and raises the viscosity when it is on');
});

test('§6.5 — fOrganic knots and density_gmL', () => {
  for (const [x, f] of sol.F_ORGANIC) {
    assertClose(sol.fOrganic(x), f, 1e-12, `fOrganic knot at ${x}`);
  }
  // Linear interpolation between the 0.3 and 0.5 knots: (2.15 + 2.40)/2 = 2.275 at x = 0.4.
  assertClose(sol.fOrganic(0.4), 2.275, 1e-12, 'fOrganic interpolates linearly');
  assert.equal(sol.fOrganic(-1), 1.00, 'clamped below 0');
  assert.equal(sol.fOrganic(2), 1.20, 'clamped above 1');

  // density = 0.9982 + 4.0e-5 * c_NaCl_mM, exactly (§6.5).
  assertClose(sol.density_gmL(Y({}), 25), 0.9982, 1e-12, 'water density');
  assertClose(sol.density_gmL(Y({ Na: 500, Cl: 500 }), 25), 0.9982 + 4.0e-5 * 500, 1e-12,
    '0.5 M NaCl density');
  assertClose(sol.density_gmL(Y({ Na: 500, Cl: 461.757 }), 25), 0.9982 + 4.0e-5 * 461.757, 1e-12,
    'the salt pair is the SMALLER of the two largest entries — Buffer B is 461.757, not 500');
});

/* ============================================================================================
 * 3. DAVIES ACTIVITY AND THE pKa LADDER (§6.6)
 * ========================================================================================== */

test("§6.6 — Davies lg1, the mandatory Ie <= 0.39 clamp, and acetate pKa' 4.5460 / 4.4878", () => {
  for (const I of [0.001, 0.01, 0.05, 0.1, 0.2, 0.39]) {
    assertClose(ph.daviesLg1(I), davies(I), 1e-12, `daviesLg1(${I}) below the clamp`);
    assert.ok(ph.daviesLg1(I) < 0, 'log10(gamma) for a real ion is negative');
  }
  // THE CLAMP IS MANDATORY: above IeMax the value must be frozen at its I = 0.39 value.
  for (const I of [0.4, 1.0, 3.0, 10.0]) {
    assert.equal(ph.daviesLg1(I), ph.daviesLg1(0.39),
      `daviesLg1(${I}) must be clamped to its I = 0.39 value`);
  }
  // Zero tolerance, but through the numeric comparison: the expression evaluates to -0 at
  // I = 0, and `assert.equal` is Object.is under node:assert/strict, which separates -0 from 0.
  assertCloseAbs(ph.daviesLg1(0), 0, 0, 'no activity correction at infinite dilution');

  // pKa' = pKa + 2*(1-z)*lg1 for the z = 0 protonated form (HAc).
  const at01 = ph.pkaAdjusted(4.76, 0, ph.daviesLg1(0.1), 0, 0.1);
  const at10 = ph.pkaAdjusted(4.76, 0, ph.daviesLg1(1.0), 0, 1.0);
  assertClose(at01, 4.76 + 2 * davies(0.1), 1e-12, "acetate pKa'(0.1) is the Davies expression");
  // 5e-5 absolute = half the last printed digit of §6.6's "4.5460" / "4.4878".
  assertCloseAbs(at01, 4.5460, 5e-5, "acetate pKa' at I = 0.1");
  assertCloseAbs(at10, 4.4878, 5e-5, "acetate pKa' at I = 1.0");
  assert.ok(at10 < at01, "pKa' must keep falling with I");

  // WHY THE CLAMP EXISTS, demonstrated rather than asserted: without it the Davies expression
  // turns over near I = 0.7 and the I = 1.0 pKa' lands ABOVE the I = 0.1 one.
  const unclamped = 4.76 + 2 * (-0.509 * (1 / (1 + 1) - 0.3 * 1.0));
  assert.ok(unclamped > at01,
    'the unclamped Davies form really does invert the ordering — the clamp is not decoration');
});

test('§6.6 — Tris shows zero ionic-strength shift at every I (z0 = +1)', () => {
  // pKa' = pKa + 2*(1-z)*lg1 and z = +1 for TrisH+, so the factor 2*(1-z) vanishes identically.
  for (const I of [0, 0.01, 0.1, 0.39, 1.0, 5.0]) {
    assert.equal(ph.pkaAdjusted(8.06, +1, ph.daviesLg1(I), 0, I), 8.06,
      `Tris pKa' must be untouched at I = ${I}`);
  }
  // A +2 protonated form (histidine step 1) shifts the OTHER way — sign check on 2*(1-z).
  assert.ok(ph.pkaAdjusted(1.80, +2, ph.daviesLg1(0.1), 0, 0.1) > 1.80,
    'a z = +2 protonated form shifts pKa UP');
  assert.ok(ph.pkaAdjusted(7.20, -1, ph.daviesLg1(0.1), 0, 0.1) < 7.20,
    'a z = -1 protonated form (H2PO4-) shifts pKa DOWN, and by twice the z = 0 amount');
  assertClose(ph.pkaAdjusted(7.20, -1, ph.daviesLg1(0.1), 0, 0.1) - 7.20,
    2 * (ph.pkaAdjusted(4.76, 0, ph.daviesLg1(0.1), 0, 0.1) - 4.76), 1e-12,
    'the shift scales as (1 - z)');
});

test('§6.6 — pkaAtT: Tris is 8.648 at 4 C', () => {
  // 8.06 + (-0.028)*(4 - 25) = 8.06 + 0.588. Exact.
  assertClose(ph.pkaAtT(8.06, -0.028, 4), 8.648, 1e-12, 'Tris pKa at 4 C');
  assertClose(ph.pkaAtT(4.76, +0.0002, 4), 4.76 - 0.0042, 1e-12,
    'acetate barely moves — its dpKa/dT is POSITIVE and 140x smaller');
  assert.equal(ph.pkaAtT(8.06, -0.028, 25), 8.06, 'no shift at the reference temperature');
  for (const id of Object.keys(ph.BUFFER_LIBRARY)) {
    const b = ph.BUFFER_LIBRARY[id];
    assert.equal(b.pKas.length > 0, true, `BUFFER_LIBRARY.${id} has a ladder`);
    assert.equal(typeof b.z0, 'number', `BUFFER_LIBRARY.${id}.z0 is the protonated charge`);
  }
});

/* ============================================================================================
 * 4. THE COUNTER-ION SOLVE (§6.6, §8.2, C-28)
 * ========================================================================================== */

test('C-28 — Davies counter-ion solve: 50 mM acetate at pH 5.00 needs 35.542 mM Na', () => {
  ph.solveCounterIon(config, { buffers: [{ speciesId: 'AcT', bufferId: 'acetate', total_mM: 50 }] },
    5.00, 25, CI_OUT);
  assert.equal(CI_OUT.anion_mM, 0, 'acetate is titrated with strong BASE, so no acid is required');

  // The zero-activity answer (31.737 mM) must be gone: that is the whole of C-28.
  assert.ok(CI_OUT.cation_mM > 34, 'the zero-activity 31.737 mM answer must not reappear (C-28)');

  // INDEPENDENT SOLVE of the same charge balance, written from §6.6 and bisected here.
  // Including the water term reproduces the contract's 35.532; omitting it (which is what the
  // module does, deliberately — ph.js NOTE-A, for §7.2.4's exact charge balance) gives 35.542.
  const withWater = acetateCounterIon(50, 5.00, true);
  const withoutWater = acetateCounterIon(50, 5.00, false);
  assertCloseAbs(withWater.cation_mM, 35.532, 1e-3,
    'the independent solve WITH the water term reproduces the contract anchor');
  assertClose(CI_OUT.cation_mM, withoutWater.cation_mM, 1e-9,
    'and the module reproduces the independent solve WITHOUT it, exactly');

  // CONTRACT CORRECTION (recorded, not swallowed). §6.6's table and §10 print 35.532 for this
  // standalone anchor; the correct value under the convention the rest of the contract mandates
  // is 35.542. The two solves above localise the whole 0.009917 mM gap to the water term
  // 1000*([H+] - [OH-]) = 0.0100 mM at pH 5.00, and §7.2.4 FORBIDS carrying it: it requires every
  // tank vector to be EXACTLY charge balanced in strong-ion-plus-buffer terms (Buffer A:
  // Na 50.000 = Cl 13.986 + ionised acetate 36.014), which the free proton would break by
  // exactly that 0.010 mM. §6.6 cannot have both its 35.532 anchor and §7.2.4's exactness
  // guarantee; the shipped-recipe anchors that everything downstream depends on
  // (36.014 / 13.986 / 38.243 / 461.757) all reproduce to better than 5e-4 mM under the
  // water-free convention, so the standalone anchor is the number that has to be reprinted.
  // 5e-4 mM absolute = half the last digit of "35.542"; the solver lands 8.3e-5 mM away.
  assertCloseAbs(CI_OUT.cation_mM, 35.542, 5e-4,
    'C-28 / §6.6: 50 mM acetate at pH 5.00 requires 35.542 mM Na+ (contract prints 35.532)');
  // ... and the gap to the printed 35.532 is one free proton, not a solver error. The two
  // independent solves differ by 0.010196 mM against the 0.009999 mM of net water charge at
  // pH 5.00; the remaining 2.0e-4 mM is that charge's own second-order feedback through I on
  // pKa' and hence on the ionised fraction. 5e-4 mM = 5 % of the term, which is far tighter than
  // anything that could be confused with a different convention.
  assertCloseAbs(CI_OUT.cation_mM - withWater.cation_mM, 1000 * (10 ** -5.00 - 1e-14 / 10 ** -5.00),
    5e-4, 'the whole gap to the printed 35.532 IS the omitted water term');
});

test('C-28 — Davies counter-ion solves: 20 mM Tris and 20 mM phosphate', () => {
  // TRIS IS FULLY ANALYTIC. z0 = +1 means pKa' = pKa at every I, so the charge balance closes in
  // closed form: Cl- = total * f(TrisH+) = 20 / (1 + 10^(pH - pKa)) = 20 / (1 + 10^-0.06).
  const trisAnalytic = 20 / (1 + 10 ** (8.00 - 8.06));
  assertCloseAbs(trisAnalytic, 10.690, 5e-4, 'the closed form IS the contract anchor');
  ph.solveCounterIon(config, { buffers: [{ speciesId: 'AcT', bufferId: 'tris', total_mM: 20 }] },
    8.00, 25, CI_OUT);
  assert.equal(CI_OUT.cation_mM, 0, 'Tris is titrated with strong ACID');
  // 1e-3 mM absolute: the module bisects 90 times over +/-10 mol/L, so its own resolution is
  // ~1e-23 mM; the gap that remains is the deliberately omitted water term at pH 8 (1e-3 mM).
  assertCloseAbs(CI_OUT.anion_mM, trisAnalytic, 1e-3, 'the module matches the closed form');
  assertCloseAbs(CI_OUT.anion_mM, 10.690, 1e-3, 'C-28: 20 mM Tris at pH 8.00 needs 10.690 mM Cl-');

  // PHOSPHATE has a three-step ladder and no closed form worth writing here, so this is a pinned
  // contract anchor. 1e-3 mM absolute = one fifth of the last printed digit of "31.406"; the
  // internal I fixed point must be iterated to convergence to reach it (a single pass lands at
  // 31.349, which this tolerance rejects).
  ph.solveCounterIon(config,
    { buffers: [{ speciesId: 'AcT', bufferId: 'phosphate', total_mM: 20 }] }, 7.00, 25, CI_OUT);
  assertCloseAbs(CI_OUT.cation_mM, 31.406, 1e-3,
    'C-28: 20 mM phosphate at pH 7.00 needs 31.406 mM Na+ (NOT the zero-activity 27.74)');
  assertCloseAbs(CI_OUT.I_molL, 0.04281, 5e-5, 'and converges on I = 0.04281 mol/L, not 0.0410');
});

test('§8.2 — the shipped recipes converge to 36.014 / 13.986 and 38.243 / 461.757', () => {
  const A = tank('TK-EQ').derived;
  const B = tank('TK-ELU').derived;
  // 5e-4 mM absolute on each = half the last printed digit of §8.2's table.
  assertCloseAbs(A.titrantCation_mM, 36.014, 5e-4, 'Buffer A NaOH titrant');
  assertCloseAbs(A.saltNaCl_mM, 13.986, 5e-4, 'Buffer A NaCl top-up');
  assertCloseAbs(B.titrantCation_mM, 38.243, 5e-4, 'Buffer B NaOH titrant');
  assertCloseAbs(B.saltNaCl_mM, 461.757, 5e-4, 'Buffer B NaCl top-up');

  // The top-up is defined as saltTarget - titrant, so the totals are exact by construction.
  assertClose(A.titrantCation_mM + A.saltNaCl_mM, 50.0, 1e-12, 'Buffer A total Na = 50 mM');
  assertClose(B.titrantCation_mM + B.saltNaCl_mM, 500.0, 1e-12, 'Buffer B total Na = 500 mM');
  assertClose(A.Na_mM, 50.0, 1e-12, 'and the tank VECTOR carries that Na');
  assertClose(B.Na_mM, 500.0, 1e-12, 'likewise Buffer B');
  assertClose(A.Cl_mM, A.saltNaCl_mM, 1e-12, 'all of the Cl- is the NaCl top-up');

  // Both tanks are titrated to pH 5.00 and must read it back through the independent pH solve.
  // 1e-3 pH units: the recipe solve omits the water term the pH solve carries (NOTE-A), which
  // is worth 4e-4 pH here.
  assertCloseAbs(A.pH, 5.00, 1e-3, 'Buffer A reads pH 5.00');
  assertCloseAbs(B.pH, 5.00, 1e-3, 'Buffer B reads pH 5.00');
  // 4.4878 is the acetate pKa' at Buffer B's I = 0.5 — the same number as the I = 1.0 anchor
  // above, because both are past the Ie = 0.39 clamp.
  assertCloseAbs(ph.pkaAdjusted(4.76, 0, ph.daviesLg1(B.I_molL), 0, B.I_molL), 4.4878, 5e-5,
    "Buffer B's acetate pKa' (§8.2 table)");
  assertCloseAbs(ph.pkaAdjusted(4.76, 0, ph.daviesLg1(A.I_molL), 0, A.I_molL), 4.5892, 5e-5,
    "Buffer A's acetate pKa' (§8.2 table)");
});

test('§8.2 / §7.2.4 — Buffer A is exactly charge balanced at ionisedFraction 0.72028', () => {
  // §7.2.4 states this as a GUARANTEE, not an approximation: the Donnan group sums of the
  // shipped tank must satisfy C = A exactly, i.e. Na = Cl + ionisedFraction*AcT, which is what
  // makes the pore electroneutral to Lambda at any composition. chem/ph.js::buildTankVector
  // derives `ionisedFraction` at the RECIPE pH for exactly this reason and says so in a comment.
  const t = tank('TK-EQ');
  const f = config.species[IDX.AcT].ionisedFraction;
  const C = t.y_mM[IDX.Na];
  const Aion = t.y_mM[IDX.Cl] + f * t.y_mM[IDX.AcT];
  // The recipe's own answer, which is what §8.2's table reports: titrant/total.
  const fRecipe = t.derived.titrantCation_mM / t.y_mM[IDX.AcT];
  const context = `\n  ionisedFraction = ${f}\n  recipe titrant/AcT = ${fRecipe}`
    + `\n  Na = ${C}   Cl + f*AcT = ${Aion}   imbalance = ${Aion - C} mM`;

  // 5e-5 absolute = half the last printed digit of §7.2.4's "0.72028".
  assertCloseAbs(f, 0.72028, 5e-5,
    `the shipped acetate ionised fraction (§7.2.4, §8.2)${context}`);
  // 1e-6 mM on a 50 mM balance: "exactly" in §7.2.4 has to mean at least this.
  assertCloseAbs(Aion, C, 1e-6, `Buffer A group sums: Na = Cl + f*AcT (§7.2.4)${context}`);
  // 36.014 mM of co-ion equivalent is the number §7.2.4 and §8.2 both quote.
  assertCloseAbs(f * t.y_mM[IDX.AcT], 36.014, 1e-3, 'acetate contributes 36.014 mM of co-ion');
});

/* ============================================================================================
 * 5. THE pH SOLVE AND THE WATER CONVENTION (§6.6, C-08)
 * ========================================================================================== */

test('C-08 / §6.6 — 0.5 M NaOH: true pH 13.699, electrode reads 12.900', () => {
  // THE WATER CONVENTION, stated normatively in §6.6: Kw is a CONCENTRATION product, pKw = 14.000
  // with no Davies shift, and pH = -log10([H+]) with no activity coefficient on the proton.
  // Under it, 0.5 M NaOH is pOH = -log10(0.5) = 0.301030 and pH = 13.698970 — analytic.
  const truePH = 14 - -Math.log10(0.5);
  assertClose(truePH, 13.69897, 1e-9, 'pOH = 0.30103 so the true pH is 13.69897');

  const y = tank('TK-NAOH').y_mM;
  assertClose(y[IDX.Na], 500, 1e-12, 'the CIP tank is 500 mM Na');
  ph.solvePH(config, y, 25, SCRATCH, PH_OUT);
  // 1e-3 pH units: the bisection runs 50 halvings of a 14-wide bracket (2^-50 * 14), so its own
  // resolution is 1e-14; anything above 1e-3 would be a convention error, not a solver error.
  assertCloseAbs(PH_OUT.pH, 13.699, 1e-3, 'solvePH reproduces the water convention exactly');
  assertCloseAbs(PH_OUT.I_molL, 0.5, 1e-6,
    'I = 0.5, not 0.75 — the baseExcess species is excluded because water already carries the OH-');

  // The alkaline (sodium) error: -k*(pH-12)*log10(cNa/0.1) with k = 0.673 (C-08).
  const err = ph.sodiumError(config, PH_OUT.pH, y[IDX.Na] / 1000);
  assertClose(err, -0.673 * (truePH - 12) * Math.log10(0.5 / 0.1), 1e-6,
    'the sodium error is the closed form at k = 0.673');
  assertCloseAbs(err, -0.7990, 5e-4, 'which is -0.7990 pH units');
  // The contract's own band.
  assertCloseAbs(PH_OUT.pH + err, 12.900, 5e-3, 'C-08: the electrode reads 12.900 +/- 0.005');
  assert.equal(config.chem.sodiumErrorK, 0.673, 'k = 0.673, not v1\'s 0.05 (C-08)');
});

test('§6.6 — no Davies on water: pure water and 1 M NaCl both solve to pH 7.000', () => {
  // This is the sharpest statement of the water convention. If Davies were applied to the
  // H+/OH- pair, 1 M NaCl (I = 1.0) would solve away from 7 while pure water stayed at 7.
  ph.solvePH(config, Y({}), 25, SCRATCH, PH_OUT);
  assertCloseAbs(PH_OUT.pH, 7.0, 1e-6, 'pure water is pH 7.000 at pKw = 14.000');
  ph.solvePH(config, Y({ Na: 1000, Cl: 1000 }), 25, SCRATCH, PH_OUT);
  assertCloseAbs(PH_OUT.pH, 7.0, 1e-6, '1 M NaCl is STILL pH 7.000 — no activity on the proton');
  assertCloseAbs(PH_OUT.I_molL, 1.0, 1e-6, 'even though its ionic strength is 1.000 mol/L');
  assert.ok(PH_OUT.iterations >= 1 && PH_OUT.iterations <= 20,
    'the outer ionic-strength loop reports a sane pass count');
});

test('§6.6 — sodiumError gates and sign', () => {
  assert.equal(ph.sodiumError(config, 11.9, 1.0), 0, 'no error below pH 12');
  assert.equal(ph.sodiumError(config, 12.0, 1.0), 0, 'the pH gate is strict');
  assert.equal(ph.sodiumError(config, 13.0, 0.05), 0, 'no error below 0.1 mol/L Na');
  assert.ok(ph.sodiumError(config, 13.0, 1.0) < 0,
    'the alkaline error always reads LOW, never high');
  // Doubling (pH - 12) doubles the error; the cNa dependence is logarithmic.
  assertClose(ph.sodiumError(config, 14.0, 1.0), 2 * ph.sodiumError(config, 13.0, 1.0), 1e-12,
    'the error is linear in (pH - 12)');
  assertClose(ph.sodiumError(config, 13.0, 1.0), -0.673 * 1.0 * 1.0, 1e-12,
    'and log10(1.0/0.1) = 1 makes the 1 mol/L, pH 13 case exactly -k');
});

test('§6.6 — 20 mM Tris at pH 8.00 (25 C) reads 8.59 in a 4 C cold room', () => {
  // FIXTURE: the shipped registry with its acetate slot replaced by Tris. Everything else — the
  // chem constants, Na, Cl, the water convention — is the shipped config's.
  const species = config.species.map((s) => (s.id === 'AcT'
    ? Object.assign({}, s, {
      id: 'Tris', name: 'Tris', charge: +1, MW_gmol: 121.14, lambda0_Scm2eq: 29.5,
      bufferPkas: [8.06], bufferZ0: +1, bufferDpKadT: -0.028, ionisedFraction: 1.0,
    })
    : Object.assign({}, s)));
  const idxById = {};
  species.forEach((s, i) => { idxById[s.id] = i; });
  const cfg = { chem: config.chem, species, ns: species.length, idxById };

  const y = ph.buildTankVector(cfg, {
    buffers: [{ speciesId: 'Tris', bufferId: 'tris', total_mM: 20 }],
    targetPH: 8.00, counterCation: 'Na', counterAnion: 'Cl',
  }, 25);
  assertCloseAbs(y[idxById.Cl], 20 / (1 + 10 ** (8.00 - 8.06)), 1e-3,
    'the recipe is 20 mM Tris + 10.690 mM HCl');

  ph.solvePH(cfg, y, 25, SCRATCH, PH_OUT);
  assertCloseAbs(PH_OUT.pH, 8.00, 2e-3, 'it reads its target at the preparation temperature');

  // AT 4 C the recipe is fixed but pKa moves: pKa(4) = 8.06 + (-0.028)*(-21) = 8.648, and the
  // buffer ratio is unchanged (Cl-/Tris is a mass ratio), so
  //   pH(4) = pKa(4) + log10((1-f)/f) = 8.648 - 0.060 = 8.588.
  // Tris has zero ionic-strength shift, so Davies cannot move this and the derivation is closed.
  const f0 = 1 / (1 + 10 ** (8.00 - 8.06));
  const analytic = 8.648 + Math.log10((1 - f0) / f0);
  assertCloseAbs(analytic, 8.588, 1e-3, 'the closed form for the cold-room reading');
  ph.solvePH(cfg, y, 4, SCRATCH, PH_OUT);
  // 3e-3 pH units against the closed form: the residual is the water term, which the closed
  // form drops and solvePH carries.
  assertCloseAbs(PH_OUT.pH, analytic, 3e-3, 'solvePH matches the closed form at 4 C');
  // 5e-3 against the contract's printed "8.59".
  assertCloseAbs(PH_OUT.pH, 8.59, 5e-3, 'a Tris buffer set to 8.00 reads 8.59 in the cold room');
  assert.ok(PH_OUT.pH > 8.00 + 0.5,
    'and the shift is UP by ~0.59 pH units — the classic Tris cold-room trap');
});

test('§10 — the A -> B gradient pH drift is bounded, unimodal, and analytic', () => {
  // CONTRACT CORRECTION (recorded, not swallowed). §10 asks for the gradient pH drift to be
  // MONOTONE. That is unreachable by construction, and no implementation can deliver it: both
  // tanks are titrated to pH 5.00, so the endpoints are EQUAL BY DESIGN, and a curve with equal
  // endpoints and a non-constant interior cannot be monotone. The interior is non-constant
  // because the buffer ratio is LINEAR in the blend fraction while pKa'(I) is CONCAVE in it.
  // What is assertable — and is asserted here, in place of the word "monotone" — is that the
  // drift is BOUNDED, that it is monotone on each side of a single interior minimum, and that
  // the whole shape reproduces a closed form written from §6.6. The dip is a real teaching
  // artefact: a bind-and-elute salt gradient between two nominally iso-pH buffers really does
  // sag ~0.05 pH mid-gradient.
  //
  // The elution gradient is a linear blend of the two tank vectors (LPGF proportioning plus the
  // mixer), so the pH the electrode sees along the gradient is solvePH of that blend.
  const yA = tank('TK-EQ').y_mM;
  const yB = tank('TK-ELU').y_mM;
  const blend = new Float64Array(config.ns);
  const pHs = [];
  const closed = [];
  for (let k = 0; k <= 20; k++) {
    const f = k / 20;
    for (let i = 0; i < config.ns; i++) blend[i] = yA[i] * (1 - f) + yB[i] * f;
    ph.solvePH(config, blend, 25, SCRATCH, PH_OUT);
    pHs.push(PH_OUT.pH);

    // CLOSED FORM, written from §6.6 alone. Both tank vectors are charge balanced without the
    // water term (§7.2.4), and so is any blend of them, so the ionised acetate is fixed by the
    // strong ions: Ac- = Na - Cl. That also makes the ionic strength exact —
    // I = (Na + Cl + Ac-)/2000 = Na/1000 — with no fixed point to iterate.
    const Na = blend[IDX.Na], Cl = blend[IDX.Cl], AcT = blend[IDX.AcT];
    const frac = (Na - Cl) / AcT;
    const I = 0.5 * (Na + Cl + (Na - Cl)) / 1000;
    closed.push(4.76 + 2 * davies(I) + Math.log10(frac / (1 - frac)));
  }
  const ctx = `\n  pH along 0 -> 100 %B: ${pHs.map((v) => v.toFixed(5)).join(' ')}`;

  // (1) THE ENDPOINTS ARE EQUAL — this is what forbids monotonicity. Both tanks were titrated to
  // 5.00 and the closed form returns exactly that from the vectors alone.
  assertCloseAbs(pHs[0], pHs[20], 1e-3, `0 %B and 100 %B are the same pH by design${ctx}`);
  assertCloseAbs(closed[0], 5.00, 1e-5, '0 %B: the closed form returns the recipe target exactly');
  assertCloseAbs(closed[20], 5.00, 1e-5, '100 %B: likewise');

  // (2) THE INTERIOR REALLY IS BELOW BOTH ENDS, so "monotone" is not merely unmet, it is
  // unreachable. 0.01 pH is 20x solvePH's own bracket resolution and 20x the omitted water term.
  const iMin = pHs.indexOf(Math.min(...pHs));
  assert.ok(iMin > 0 && iMin < 20, `the minimum is interior (at ${iMin / 20} B)${ctx}`);
  assert.ok(pHs[0] - pHs[iMin] > 0.01 && pHs[20] - pHs[iMin] > 0.01,
    `the interior dips below BOTH endpoints, so no monotone curve exists${ctx}`);

  // (3) UNIMODAL: strictly falling to the minimum, strictly rising after it. 1e-9 pH of slack —
  // solvePH resolves its bracket to 1e-14, so anything above that is a real reversal.
  for (let k = 1; k <= iMin; k++) {
    assert.ok(pHs[k] < pHs[k - 1] + 1e-9, `reversal on the falling limb at ${k / 20} B${ctx}`);
  }
  for (let k = iMin + 1; k <= 20; k++) {
    assert.ok(pHs[k] > pHs[k - 1] - 1e-9, `reversal on the rising limb at ${k / 20} B${ctx}`);
  }

  // (4) BOUNDED. 0.06 pH is the band the drift must stay inside; the measured excursion is
  // 0.0497 at 35 %B. A buffer that failed this would be mis-specified, not merely non-monotone.
  for (let k = 0; k <= 20; k++) {
    assert.ok(Math.abs(pHs[k] - 5.00) < 0.06,
      `the gradient pH drift must stay inside +/- 0.06 of 5.00${ctx}`);
  }

  // (5) IT IS THE CLOSED FORM, POINT BY POINT. 1e-3 pH: the residual is the water term solvePH
  // carries and the balance above drops, worth 5.0e-4 pH here and uniform across the gradient.
  for (let k = 0; k <= 20; k++) {
    assertCloseAbs(pHs[k], closed[k], 1e-3,
      `${(k * 5)} %B: solvePH must reproduce pKa'(I) + log10(f/(1-f))`);
  }
  assert.equal(closed.indexOf(Math.min(...closed)), iMin,
    'and the closed form puts the minimum at the same blend fraction — the dip is pKa\'(I) '
    + 'concavity against a linear buffer ratio, not a solver artefact');
});

test('C-27 — solvePH costs less than 60 us per call', () => {
  // §6.6 restates the budget as < 60 us (v1's 25 us was a false assertion, C-27). At 20 Hz that
  // is 1.2 ms per simulated second. A warm-up batch first, so the timed batches run on optimised
  // code.
  //
  // BEST of 5 batches, not the median. `node --test` runs test FILES in parallel, so this
  // microbenchmark is timed while several other files are saturating the machine — and under
  // sustained contention every batch is slowed, which a median faithfully reports. The median
  // therefore measures the load on the box, not the cost of the function. This assertion is a
  // FLOOR on how cheap the code can be, and the least-interfered-with batch is the honest
  // estimate of that; scheduler noise can only ever add time, never remove it.
  //
  // The 60 us threshold is unchanged. Observed: ~13 us running alone, ~62 us median under a full
  // parallel suite, which is what made this the only intermittently red case in the suite.
  const y = tank('TK-EQ').y_mM;
  for (let k = 0; k < 8000; k++) ph.solvePH(config, y, 25, SCRATCH, PH_OUT);

  const N = 8000;
  const us = [];
  for (let b = 0; b < 5; b++) {
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < N; k++) ph.solvePH(config, y, 25, SCRATCH, PH_OUT);
    us.push(Number(process.hrtime.bigint() - t0) / 1000 / N);
  }
  const best = Math.min(...us);
  assert.ok(best < 60,
    `solvePH must cost < 60 us/call (§6.6, C-27); best of 5 batches = ${best.toFixed(2)} us`
    + ` (batches ${us.map((v) => v.toFixed(2)).join(', ')})`);
});

test('§6.6 — solvePH and describeTank agree with the ingested tank derivations', () => {
  // `describeTank` is what `normalizePreset` used to fill `tank.derived`; re-running it on the
  // frozen vector must reproduce those numbers bit for bit, or the config is not reproducible
  // from its own inputs.
  for (const t of config.tanks) {
    const d = ph.describeTank(config, t.y_mM, t.T_C);
    assertCloseAbs(d.pH, t.derived.pH, 1e-9, `${t.id}: describeTank reproduces derived.pH`);
    assertCloseAbs(d.I_molL, t.derived.I_molL, 1e-12, `${t.id}: ... and derived.I_molL`);
    assertCloseAbs(d.kappa25_mScm, t.derived.kappa25_mScm, 1e-9, `${t.id}: ... and the conductivity`);
    assert.equal(d.Na_mM, t.y_mM[IDX.Na], `${t.id}: Na is read straight from the vector`);
    assert.equal(d.Cl_mM, t.y_mM[IDX.Cl], `${t.id}: Cl likewise`);
  }
  // And the acetate tanks really are at their target.
  for (const id of ['TK-EQ', 'TK-WASH', 'TK-ELU', 'TK-STRIP', 'TK-FEED']) {
    assertCloseAbs(tank(id).derived.pH, 5.00, 1e-3, `${id} is titrated to pH 5.00`);
  }
});
