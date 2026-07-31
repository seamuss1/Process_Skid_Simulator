/**
 * tests/masstransfer.test.js — the `k_ov` / `k_eff` chain of `src/physics/masstransfer.js`.
 *
 * Contract: architecture-v2 §6.8 (module + the `epsPi` correction), §7.3.1 (the two unit
 * conversions people get wrong), §7.3.2 (the chain), §7.3.3 (the lysozyme worked example),
 * §7.3.4 (the shipped six-species table and the acceptance bands), §10 (this file's row).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOW THE EXPECTED VALUES ARE OBTAINED
 *
 * Two independent kinds of assertion are used, and both are needed:
 *
 *  1. TABLE assertions against the numbers the contract prints (§7.3.3, §7.3.4). Those are the
 *     acceptance criteria the rest of the document is evaluated at, so they are asserted as
 *     printed. §10 states the band as +/-2 %; where the contract prints five significant figures
 *     the assertion is tightened to HALF A UNIT IN THE LAST PRINTED PLACE, because a value printed
 *     to five figures is a claim about those five figures. The looser +/-2 % is kept alongside for
 *     the rows where rounding of a 2-significant-figure column (the "film %" column) makes a
 *     relative band meaningless — there an ABSOLUTE +/-0.05 percentage-point band is used instead,
 *     which is exactly the printed rounding.
 *
 *  2. CLOSED-FORM assertions, at 1e-12 relative, that recompute the quantity from §7.3.2's
 *     algebra with nothing but Math and the published constants. These are the ones with teeth:
 *     they cannot drift with the table, they pin the two unit factors (100 and 0.01) individually,
 *     and they prove the film and pore resistances are summed as RESISTANCES and not as rates.
 *
 * The species parameters come from the shipped preset through `presets.normalizePreset` ->
 * `bed.buildColumnCfg`, which is the only legal assembler of a `createColumn` cfg (§6.9/§6.11) and
 * therefore the only place `comp.epsPi` can be observed as the ingest boundary actually delivers
 * it. That matters: the whole point of §6.8 is that `epsPi` is per SPECIES and is not the resin's
 * `epsP`.
 *
 * No DOM, no `tests/helpers.js` — this file is self-contained on purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as presets from '../src/data/presets.js';
import * as bed from '../src/physics/bed.js';
import * as columnMod from '../src/physics/column.js';
import * as mt from '../src/physics/masstransfer.js';
import { KB_J_K } from '../src/core/util.js';

const PRESET = 'cex-capture-igg1-pilot';

/* ── The §7.3.4 operating point ─────────────────────────────────────────────────────────────── */
const U_CMS = 150 / 3600;      // 150 cm/h superficial
const T_C = 20.0;
const MU_CP = 1.002;
const RHO = 0.9982;

/* ── The §7.3.3 fixture. "The fixture is 25 degC / 0.945 cP and nothing else" (C-44). ───────── */
const LYS_T_C = 25.0;
const LYS_MU_CP = 0.945;
const LYS_RHO = 0.9982;
const LYS_DM = 1.211e-6;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * Helpers
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

function assertRel(actual, expected, relTol, what) {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(
    rel <= relTol,
    `${what}: got ${actual}, expected ${expected} (rel ${rel.toExponential(3)} > ${relTol})`);
}

function assertAbs(actual, expected, absTol, what) {
  const d = Math.abs(actual - expected);
  assert.ok(d <= absTol, `${what}: got ${actual}, expected ${expected} +/- ${absTol} (off by ${d})`);
}

/** The shipped pilot `createColumn` cfg, built through the one legal assembler. */
function pilotCfg(overrides) {
  const config = presets.normalizePreset(PRESET, overrides || {});
  return { config, cfg: bed.buildColumnCfg(config) };
}

function compOf(cfg, id) {
  const c = cfg.comps.find((x) => x.id === id);
  assert.ok(c, `species ${id} is transported in the pilot preset`);
  return c;
}

/** The §7.3.3 lysozyme fixture: 90 um beads, 30 nm pores, epsPi 0.85, explicit Dm. */
function lysozyme(over) {
  return Object.assign({
    id: 'lysozyme',
    MW_gmol: 14300,
    epsPi: 0.85,
    Dm_cm2s: LYS_DM,
    Dp_cm2s: null,
    keffScale: 1.0,
  }, over || {});
}
const LYS_COLCFG = { dp_cm: 9.0e-3, rp_cm: 4.5e-3, epsC: 0.35, rPore_cm: 3.0e-6 };

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §7.3.1 — the two conversions people get wrong
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§7.3.1 — Re = 100*rho*u*dp/mu and Sc = 0.01*mu/(rho*Dm), to 1e-12', () => {
  const { cfg } = pilotCfg();
  for (const comp of cfg.comps) {
    const b = mt.kovBreakdown(cfg, comp, U_CMS, T_C, MU_CP, RHO);
    // Closed form, canonical units: u cm/s, dp cm, rho g/mL, mu cP, D cm^2/s.
    const Re = 100 * RHO * Math.abs(U_CMS) * cfg.dp_cm / MU_CP;
    const Sc = 0.01 * MU_CP / (RHO * b.Dm_cm2s);
    assertRel(b.Re, Re, 1e-12, `Re (${comp.id})`);
    assertRel(b.Sc, Sc, 1e-12, `Sc (${comp.id})`);
  }
});

test('§7.3.1 — Re and Sc sit inside the dev sanity bands for every shipped species', () => {
  const { cfg } = pilotCfg();
  for (const comp of cfg.comps) {
    const b = mt.kovBreakdown(cfg, comp, U_CMS, T_C, MU_CP, RHO);
    assert.ok(b.Re >= 1e-5 && b.Re <= 1e2, `Re out of [1e-5, 1e2] for ${comp.id}: ${b.Re}`);
    assert.ok(b.Sc >= 1e2 && b.Sc <= 1e5, `Sc out of [1e2, 1e5] for ${comp.id}: ${b.Sc}`);
  }
});

test('§7.3.1 — dropping either unit factor is caught (the silent-failure trap)', () => {
  const { cfg } = pilotCfg();
  const mAb = compOf(cfg, 'mAb');
  const b = mt.kovBreakdown(cfg, mAb, U_CMS, T_C, MU_CP, RHO);

  // Sc without the 0.01 leaves the band immediately — that is what the band is for.
  const ScNoFactor = MU_CP / (RHO * b.Dm_cm2s);
  assert.ok(ScNoFactor > 1e5, `Sc missing its 0.01 must leave [1e2, 1e5]; got ${ScNoFactor}`);

  // Re without the 100 does NOT leave [1e-5, 1e2] at this operating point (3.96e-4), so the band
  // alone cannot catch it — which is precisely why the identity above is asserted directly. What
  // it does do is move Sh, and therefore k_f, by (1/100)^(1/3):
  const ReNoFactor = RHO * Math.abs(U_CMS) * cfg.dp_cm / MU_CP;
  assert.ok(ReNoFactor > 1e-5 && ReNoFactor < 1e2,
    'documented: the Re band does not catch a dropped factor of 100 at 150 cm/h');
  assertRel(Math.cbrt(b.Re / ReNoFactor), Math.cbrt(100), 1e-12, 'Sh error from a dropped Re factor');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §7.3.2 — the individual links of the chain
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§7.3.2 — Polson D20w = 2.74e-5*MW^(-1/3) with the T/mu correction', () => {
  // At the reference state (20 degC, 1.002 cP) the correction factors are both exactly 1.
  const D20w = 2.74e-5 * Math.pow(14300, -1 / 3);
  assertRel(mt.diffusivityPolson_cm2s(14300, 20, 1.002), D20w, 1e-14, 'D20w at the reference state');
  // Dm scales as (T/293.15) and as (1.002/mu).
  assertRel(mt.diffusivityPolson_cm2s(14300, 25, 0.945),
    D20w * (298.15 / 293.15) * (1.002 / 0.945), 1e-14, 'Polson T/mu correction');
  // Non-physical inputs must give 0 (a fully immobile component), never NaN.
  assert.equal(mt.diffusivityPolson_cm2s(0, 20, 1.002), 0);
  assert.equal(mt.diffusivityPolson_cm2s(14300, 20, 0), 0);
});

test('§7.3.2 — Stokes-Einstein radius, with the one permitted local SI excursion', () => {
  const rs = mt.stokesRadius_cm(LYS_DM, LYS_T_C, LYS_MU_CP);
  const expect = (KB_J_K * (LYS_T_C + 273.15) / (6 * Math.PI * (LYS_MU_CP * 1e-3) * (LYS_DM * 1e-4))) * 100;
  assertRel(rs, expect, 1e-14, 'rs from the closed form');
  // A molecule that cannot move is infinitely large, which the hindrance chain turns into
  // "fully excluded" rather than NaN.
  assert.equal(mt.stokesRadius_cm(0, 20, 1.002), Infinity);
  assert.equal(mt.stokesRadius_cm(1e-6, 20, 0), Infinity);
});

test('§7.3.2 — Mackie-Meares tortuosity ((2-eps)/eps)^2, on epsPi and not epsP', () => {
  assertRel(mt.tortuosityMM(0.85), Math.pow((2 - 0.85) / 0.85, 2), 1e-15, 'tau(0.85)');
  assertAbs(mt.tortuosityMM(0.85), 1.8304, 5e-5, 'tau(0.85) against the printed 1.8304 (§7.3.3)');
  // The pilot's own per-species porosities give materially different tortuosities — this is the
  // magnitude of the §6.8 ambiguity, before k_ov's own 1/epsPi factor is even applied.
  assertRel(mt.tortuosityMM(0.70), Math.pow((2 - 0.70) / 0.70, 2), 1e-15, 'tau(0.70)');
  assertRel(mt.tortuosityMM(0.45), Math.pow((2 - 0.45) / 0.45, 2), 1e-15, 'tau(0.45)');
  assert.ok(mt.tortuosityMM(0.70) / mt.tortuosityMM(0.85) > 1.8,
    'mAb epsPi 0.70 vs resin epsP 0.85 is worth ~1.9x on tortuosity alone');
  assert.equal(mt.tortuosityMM(0), Infinity);
});

test('§7.3.2 — Renkin hindrance psi = Phi*Kd_hyd, and exclusion at lambda >= 1', () => {
  const rs = mt.stokesRadius_cm(LYS_DM, LYS_T_C, LYS_MU_CP);
  const rPore = 3.0e-6;
  const l = rs / rPore;
  const Phi = (1 - l) * (1 - l);
  const Kd = 1 - 2.104 * l + 2.089 * l ** 3 - 0.948 * l ** 5;
  assertRel(mt.hindrance(rs, rPore), Phi * Kd, 1e-14, 'psi from the closed form');
  // A solute at or beyond the pore radius is EXACTLY excluded, and NaN must not propagate.
  assert.equal(mt.hindrance(rPore, rPore), 0, 'lambda = 1 is excluded');
  assert.equal(mt.hindrance(2 * rPore, rPore), 0, 'lambda > 1 is excluded');
  assert.equal(mt.hindrance(NaN, rPore), 0, 'NaN must not leak through the hindrance chain');
  assert.equal(mt.hindrance(rs, 0), 0, 'a non-physical pore radius gives 0');
  // Monotone decreasing in lambda over the physical range.
  let prev = Infinity;
  for (const f of [0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 0.95]) {
    const v = mt.hindrance(f * rPore, rPore);
    assert.ok(v < prev, `psi must fall with lambda (lambda=${f})`);
    assert.ok(v >= 0, 'psi >= 0');
    prev = v;
  }
});

test('§7.3.2 — Sherwood: Sh = (1.09/epsC)*(Re*Sc)^(1/3), kf = Sh*Dm/dp', () => {
  const b = mt.kovBreakdown(LYS_COLCFG, lysozyme(), U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);
  const Re = 100 * LYS_RHO * U_CMS * LYS_COLCFG.dp_cm / LYS_MU_CP;
  const Sc = 0.01 * LYS_MU_CP / (LYS_RHO * LYS_DM);
  const Sh = (1.09 / LYS_COLCFG.epsC) * Math.cbrt(Re * Sc);
  assertRel(b.Sh, Sh, 1e-12, 'Sh from Wilson-Geankoplis');
  assertRel(b.kf_cms, Sh * LYS_DM / LYS_COLCFG.dp_cm, 1e-12, 'kf = Sh*Dm/dp');
  // filmCoefficient_cms must agree with the breakdown exactly — one kernel, one answer.
  assert.equal(
    mt.filmCoefficient_cms({
      u_cms: U_CMS, dp_cm: LYS_COLCFG.dp_cm, epsC: LYS_COLCFG.epsC,
      Dm_cm2s: LYS_DM, mu_cP: LYS_MU_CP, rho_gmL: LYS_RHO,
    }),
    b.kf_cms, 'filmCoefficient_cms === kovBreakdown().kf_cms');
  // Reverse flow has the same film coefficient (only |u| is used).
  assert.equal(
    mt.filmCoefficient_cms({
      u_cms: -U_CMS, dp_cm: LYS_COLCFG.dp_cm, epsC: LYS_COLCFG.epsC,
      Dm_cm2s: LYS_DM, mu_cP: LYS_MU_CP, rho_gmL: LYS_RHO,
    }),
    b.kf_cms, 'kf is sign-independent');
  // Sh must rise as u^(1/3): doubling u multiplies Sh by 2^(1/3).
  const b2 = mt.kovBreakdown(LYS_COLCFG, lysozyme(), 2 * U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);
  assertRel(b2.Sh / b.Sh, Math.cbrt(2), 1e-12, 'Sh ~ u^(1/3)');
});

test('§7.3.2 — the film and pore terms sum as RESISTANCES: 1/k_ov = rp/(3 kf) + rp^2/(15 epsPi Dp)', () => {
  const { cfg } = pilotCfg();
  for (const comp of cfg.comps) {
    const b = mt.kovBreakdown(cfg, comp, U_CMS, T_C, MU_CP, RHO);
    const rp = cfg.rp_cm;
    const tauFilm = rp / (3 * b.kf_cms);
    const tauPore = (rp * rp) / (15 * comp.epsPi * b.Dpore_cm2s);
    assertRel(b.tauFilm_s, tauFilm, 1e-12, `tau_film (${comp.id})`);
    assertRel(b.tauPore_s, tauPore, 1e-12, `tau_pore (${comp.id})`);
    assertRel(b.kOv_s1, 1 / (tauFilm + tauPore), 1e-12, `k_ov (${comp.id})`);
    assertRel(b.filmFraction, tauFilm / (tauFilm + tauPore), 1e-12, `film fraction (${comp.id})`);
    // The classic mistake — summing the two as RATES rather than resistances — is a different
    // number by more than a factor of two here, so the assertion above genuinely discriminates.
    const wrong = 1 / tauFilm + 1 / tauPore;
    assert.ok(Math.abs(wrong - b.kOv_s1) / b.kOv_s1 > 0.01,
      `fixture must discriminate rate-summing from resistance-summing (${comp.id})`);
  }
});

test('§6.8 — a stagnant hold drops the film term (tau_film := 0), pore diffusion governs', () => {
  const flowing = mt.kovBreakdown(LYS_COLCFG, lysozyme(), U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);
  const held = mt.kovBreakdown(LYS_COLCFG, lysozyme(), 0, LYS_T_C, LYS_MU_CP, LYS_RHO);
  assert.equal(held.tauFilm_s, 0, 'tau_film must be exactly 0 below |u| = 1e-7 cm/s');
  assert.equal(held.filmFraction, 0, 'film fraction must be exactly 0 during a hold');
  assertRel(held.kOv_s1, 1 / held.tauPore_s, 1e-12, 'k_ov during a hold is the pore term alone');
  assert.ok(held.kOv_s1 > flowing.kOv_s1,
    'a hold must not freeze the column — k_ov may only rise when the film resistance is dropped');
  // Just above the threshold the film term is back.
  const barelyMoving = mt.kovBreakdown(LYS_COLCFG, lysozyme(), 1e-6, LYS_T_C, LYS_MU_CP, LYS_RHO);
  assert.ok(barelyMoving.tauFilm_s > 0, 'the film term returns above |u| = 1e-7 cm/s');
});

test('§6.8 — precedence: explicit Dm verbatim, explicit Dp overrides Renkin/Mackie-Meares', () => {
  // Explicit Dm wins over Polson.
  const explicitDm = mt.kovBreakdown(LYS_COLCFG, lysozyme({ Dm_cm2s: LYS_DM }),
    U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);
  assert.equal(explicitDm.Dm_cm2s, LYS_DM, 'an explicit Dm is used verbatim');
  const polson = mt.kovBreakdown(LYS_COLCFG, lysozyme({ Dm_cm2s: null }),
    U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);
  assert.equal(polson.Dm_cm2s, mt.diffusivityPolson_cm2s(14300, LYS_T_C, LYS_MU_CP),
    'a null Dm falls back to Polson');

  // Explicit Dp overrides the computed pore diffusivity.
  const DP = 2.5e-7;
  const explicitDp = mt.kovBreakdown(LYS_COLCFG, lysozyme({ Dp_cm2s: DP }),
    U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);
  assert.equal(explicitDp.Dpore_cm2s, DP, 'an explicit Dp is used verbatim');
  assert.notEqual(explicitDm.Dpore_cm2s, DP, 'fixture must actually override something');

  // ... and the computed one is exactly Dm*psi/tau_MM(epsPi).
  assertRel(explicitDm.Dpore_cm2s,
    LYS_DM * mt.hindrance(explicitDm.rs_cm, LYS_COLCFG.rPore_cm) * (1 / mt.tortuosityMM(0.85)),
    1e-13, 'Dpore = Dm*psi/tau_MM');
  assertRel(mt.porediff_cm2s({
    Dm_cm2s: LYS_DM, rs_cm: explicitDm.rs_cm, rPore_cm: LYS_COLCFG.rPore_cm, epsPi: 0.85,
  }), explicitDm.Dpore_cm2s, 1e-15, 'porediff_cm2s === the breakdown value');
});

test('§6.8 — keffScale multiplies k_ov and the result is clamped to [1e-6, 1e4] 1/s', () => {
  const base = mt.computeKov_s1(LYS_COLCFG, lysozyme(), U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);
  assertRel(mt.computeKov_s1(LYS_COLCFG, lysozyme({ keffScale: 0.5 }),
    U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO), 0.5 * base, 1e-14, 'keffScale 0.5');
  assertRel(mt.computeKov_s1(LYS_COLCFG, lysozyme({ keffScale: 2 }),
    U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO), 2 * base, 1e-14, 'keffScale 2');
  assert.equal(mt.computeKov_s1(LYS_COLCFG, lysozyme({ keffScale: 1e9 }),
    U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO), 1e4, 'upper clamp');
  assert.equal(mt.computeKov_s1(LYS_COLCFG, lysozyme({ keffScale: 0 }),
    U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO), 1e-6, 'lower clamp');
  // An excluded solute (lambda >= 1) still returns a finite, clamped coefficient.
  const excluded = mt.computeKov_s1({ ...LYS_COLCFG, rPore_cm: 1e-8 }, lysozyme(),
    U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);
  assert.equal(excluded, 1e-6, 'a size-excluded solute clamps at k_ov = 1e-6, not 0 or NaN');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §7.3.3 — the lysozyme worked example
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§7.3.3 — lysozyme at T = 25 degC, mu = 0.945 cP: every printed row', () => {
  const b = mt.kovBreakdown(LYS_COLCFG, lysozyme(), U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);

  // Two bands per row: the contract's stated +/-2 % (§7.3.3, §10) and, tighter, half a unit in the
  // last printed place — a value the contract prints to five figures is a claim about five figures.
  const rows = [
    ['rs_cm', b.rs_cm, 1.9083e-7, 0.5e-11],
    ['lambda', b.lambda, 0.06361, 0.5e-5],
    ['psi', b.psi, 0.7599, 0.5e-4],
    ['tau_MM', b.tortuosity, 1.8304, 0.5e-4],
    ['Dpore_cm2s', b.Dpore_cm2s, 5.0277e-7, 0.5e-11],
    ['Re', b.Re, 0.0396, 0.5e-4],
    ['Sc', b.Sc, 7818, 0.5],
    ['Sh', b.Sh, 21.07, 0.5e-2],
    ['kf_cms', b.kf_cms, 2.8350e-3, 0.5e-7],
    ['k_ov_s1', b.kOv_s1, 0.2711, 0.5e-4],
  ];
  for (const [name, actual, expected, halfUlp] of rows) {
    assertRel(actual, expected, 2e-2, `${name} (contract band +/-2 %)`);
    assertAbs(actual, expected, halfUlp, `${name} (half a unit in the last printed place)`);
  }
  // "film fraction 14.3 %": printed to three figures, so +/-0.05 percentage points is the rounding.
  assertAbs(100 * b.filmFraction, 14.3, 0.05, 'film fraction, percentage points');
  assertRel(b.filmFraction, 0.143, 2e-2, 'film fraction (contract band +/-2 %)');
});

test('§7.3.3 — the fixture is 25 degC / 0.945 cP and nothing else (C-44)', () => {
  const ref = mt.kovBreakdown(LYS_COLCFG, lysozyme(), U_CMS, LYS_T_C, LYS_MU_CP, LYS_RHO);

  // Water at 25 degC is 0.890 cP (§7.1.2 gives 0.890439). Evaluating the SAME fixture there moves
  // Sc well outside the +/-2 % band, which is why the contract pins the buffer viscosity.
  const water25 = mt.kovBreakdown(LYS_COLCFG, lysozyme(), U_CMS, 25, 0.890439, LYS_RHO);
  assert.ok(Math.abs(water25.Sc - ref.Sc) / ref.Sc > 0.02,
    `Sc at water's 25 degC viscosity must leave the +/-2 % band; got ${water25.Sc} vs ${ref.Sc}`);

  // At 20 degC / 1.002 cP the Stokes radius moves by more than 2 % as well.
  const at20 = mt.kovBreakdown(LYS_COLCFG, lysozyme(), U_CMS, 20, 1.002, LYS_RHO);
  assert.ok(Math.abs(at20.rs_cm - ref.rs_cm) / ref.rs_cm > 0.02,
    `rs at 20 degC / 1.002 cP must leave the +/-2 % band; got ${at20.rs_cm} vs ${ref.rs_cm}`);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §7.3.4 — the shipped table and the acceptance bands
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** §7.3.4, at 150 cm/h, dp = 90 um, mu = 1.002 cP, T = 20 degC. `tracer` is the acetone row. */
const SHIPPED_TABLE = [
  // id,      epsPi, Dm_cm2s,  Dp_cm2s,  Dp/Dm, k_ov_s1,  film %
  ['WKI', 0.85, 1.05e-6, 3.68e-7, 0.350, 0.20418, 11.9],
  ['mAb', 0.70, 4.00e-7, 6.00e-8, 0.150, 0.03008, 3.3],
  ['AGG', 0.45, 2.96e-7, 2.37e-8, 0.080, 0.00782, 1.1],
  ['SBI', 0.68, 9.20e-7, 1.29e-7, 0.140, 0.06240, 4.0],
  ['Na', 0.85, 1.33e-5, 4.66e-6, 0.350, 2.2326, 23.9],
  ['tracer', 0.85, 1.28e-5, 7.68e-6, 0.600, 3.1580, 34.7],
];

test('§7.3.4 — the shipped k_ov table reproduces to +/-2 %', () => {
  const { cfg } = pilotCfg();
  assertRel(cfg.dp_cm, 9.0e-3, 1e-15, 'dp = 90 um');
  assertRel(cfg.rp_cm, 4.5e-3, 1e-15, 'rp = dp/2');
  assertRel(cfg.epsC, 0.35, 1e-15, 'epsC');

  for (const [id, epsPi, Dm, Dp, DpOverDm, kOv, filmPct] of SHIPPED_TABLE) {
    const comp = compOf(cfg, id);
    const b = mt.kovBreakdown(cfg, comp, U_CMS, T_C, MU_CP, RHO);
    assert.equal(comp.epsPi, epsPi, `${id}: epsPi as authored`);
    assertRel(b.Dm_cm2s, Dm, 1e-12, `${id}: Dm`);
    assertRel(b.Dpore_cm2s, Dp, 1e-12, `${id}: Dp`);
    assertRel(b.Dpore_cm2s / b.Dm_cm2s, DpOverDm, 2e-3, `${id}: Dp/Dm`);
    assertRel(b.kOv_s1, kOv, 2e-2, `${id}: k_ov (contract band +/-2 %)`);
    // The film-% column is printed to at most three figures, so the honest band is the printed
    // rounding: +/-0.05 percentage points.
    assertAbs(100 * b.filmFraction, filmPct, 0.05, `${id}: film %, percentage points`);
  }
});

test('§7.3.4 — NaCl on 45 um beads gives k_ov = 8.408 1/s (the top of the acceptance band)', () => {
  const { cfg } = pilotCfg();
  const na = compOf(cfg, 'Na');
  const cfg45 = { ...cfg, dp_cm: 4.5e-3, rp_cm: 2.25e-3 };
  const k = mt.computeKov_s1(cfg45, na, U_CMS, T_C, MU_CP, RHO);
  assertRel(k, 8.408, 2e-2, 'k_ov, NaCl on 45 um beads');
  // Halving dp quarters the pore resistance (rp^2/...) and raises k_f, so the coefficient must
  // rise by roughly 4x — the reason v1's [0.01, 5] band fired on a legitimate configuration.
  const k90 = mt.computeKov_s1(cfg, na, U_CMS, T_C, MU_CP, RHO);
  assert.ok(k / k90 > 3.5 && k / k90 < 4.0, `dp halving should raise k_ov ~4x; got ${k / k90}`);
  assert.ok(k <= 15, 'and it must still sit inside the [0.005, 15] acceptance band');
});

test('§7.3.4 — acceptance bands: k_ov in [0.005, 15] 1/s and Dp/Dm in [0.05, 0.65] (C-45, C-46)', () => {
  const { cfg } = pilotCfg();
  for (const comp of cfg.comps) {
    const b = mt.kovBreakdown(cfg, comp, U_CMS, T_C, MU_CP, RHO);
    assert.ok(b.kOv_s1 >= 0.005 && b.kOv_s1 <= 15,
      `${comp.id}: k_ov ${b.kOv_s1} outside [0.005, 15]`);
    const ratio = b.Dpore_cm2s / b.Dm_cm2s;
    assert.ok(ratio >= 0.05 && ratio <= 0.65,
      `${comp.id}: Dp/Dm ${ratio} outside [0.05, 0.65]`);
  }
  // The two rows that make the widened bands necessary: v1's [0.01, 5] fired on AGG at the bottom
  // and on NaCl/45 um at the top, and v1's Dp/Dm [0.29, 0.42] excluded four of six shipped rows.
  const agg = mt.kovBreakdown(cfg, compOf(cfg, 'AGG'), U_CMS, T_C, MU_CP, RHO);
  assert.ok(agg.kOv_s1 < 0.01, 'AGG is legitimately below v1\'s lower bound');
  const mab = mt.kovBreakdown(cfg, compOf(cfg, 'mAb'), U_CMS, T_C, MU_CP, RHO);
  assert.ok(mab.Dpore_cm2s / mab.Dm_cm2s < 0.29, 'mAb is legitimately below v1\'s Dp/Dm bound');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §6.8 — THE contract correction: comp.epsPi, never colCfg.epsP
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§6.8 — epsPi (not epsP) feeds k_ov: mAb = 0.03008, and 0.0363 with the resin porosity', () => {
  const { cfg } = pilotCfg();
  const mAb = compOf(cfg, 'mAb');
  assert.equal(cfg.epsP, 0.85, 'the resin nominal porosity');
  assert.equal(mAb.epsPi, 0.70, 'mAb ships with an AUTHORED epsPi of 0.70, not the resin epsP');

  const right = mt.computeKov_s1(cfg, mAb, U_CMS, T_C, MU_CP, RHO);
  assertRel(right, 0.03008, 2e-2, 'k_ov(mAb) with epsPi = 0.70');

  // The trap: substituting the resin's epsP for the species' epsPi.
  const trap = mt.computeKov_s1(cfg, { ...mAb, epsPi: cfg.epsP }, U_CMS, T_C, MU_CP, RHO);
  assertRel(trap, 0.0363, 2e-2, 'k_ov(mAb) with the WRONG porosity epsP = 0.85');
  assert.ok(trap / right > 1.15,
    `the wrong porosity must be visible (+21 % per §7.3.4); got ${(100 * (trap / right - 1)).toFixed(1)} %`);
  // The published 0.0301 is only reachable at epsPi = 0.70. Assert the discrimination explicitly:
  // 0.0363 is 21 % away, i.e. ten times the +/-2 % acceptance band.
  assert.ok(Math.abs(trap - 0.03008) / 0.03008 > 0.10,
    'the +/-2 % band on 0.03008 must reject the epsP answer');
});

test('§6.8 — the same trap on AGG is worth +87 % (epsPi 0.45 vs epsP 0.85)', () => {
  const { cfg } = pilotCfg();
  const agg = compOf(cfg, 'AGG');
  assert.equal(agg.epsPi, 0.45);
  const right = mt.computeKov_s1(cfg, agg, U_CMS, T_C, MU_CP, RHO);
  const trap = mt.computeKov_s1(cfg, { ...agg, epsPi: cfg.epsP }, U_CMS, T_C, MU_CP, RHO);
  assertRel(right, 0.00782, 2e-2, 'k_ov(AGG) with epsPi = 0.45');
  assertRel(trap, 0.01463, 2e-2, 'k_ov(AGG) with the WRONG porosity epsP = 0.85');
  assertAbs(trap / right, 1.87, 0.05, 'the AGG error factor');

  // Mechanically, the pore resistance carries 1/epsPi, so with an explicit Dp the ratio of the
  // pore terms is exactly epsP/epsPi. Everything above that is the film term diluting it.
  const b = mt.kovBreakdown(cfg, agg, U_CMS, T_C, MU_CP, RHO);
  const bTrap = mt.kovBreakdown(cfg, { ...agg, epsPi: cfg.epsP }, U_CMS, T_C, MU_CP, RHO);
  assertRel(b.tauPore_s / bTrap.tauPore_s, cfg.epsP / agg.epsPi, 1e-12,
    'tau_pore ratio must be exactly epsP/epsPi');
});

test('§6.8 — physics/column.js wires comp.epsPi through to k_ov unchanged', () => {
  // The regression that matters end to end: `col.kOv_s1` after a coefficient refresh must be
  // byte-identical to what masstransfer.computeKov_s1 returns for the same species, i.e.
  // column.js must not substitute its own epsP anywhere along the way.
  const { cfg } = pilotCfg({ column: { nz: 20 } });
  const col = columnMod.createColumn(cfg);
  columnMod.setFlowDependentCoefficients(col, U_CMS, T_C, MU_CP, RHO);
  for (let i = 0; i < cfg.comps.length; i++) {
    const comp = cfg.comps[i];
    assert.equal(col.epsPi[i], comp.epsPi, `${comp.id}: col.epsPi mirrors comp.epsPi`);
    assert.equal(col.kOv_s1[i], mt.computeKov_s1(cfg, comp, U_CMS, T_C, MU_CP, RHO),
      `${comp.id}: col.kOv_s1 must equal computeKov_s1 exactly`);
  }
});

test('§6.8 — computeAllKov fills the array elementwise from computeKov_s1', () => {
  const { cfg } = pilotCfg();
  const out = new Float64Array(cfg.comps.length);
  mt.computeAllKov(cfg, cfg.comps, U_CMS, T_C, MU_CP, RHO, out);
  for (let i = 0; i < cfg.comps.length; i++) {
    assert.equal(out[i], mt.computeKov_s1(cfg, cfg.comps[i], U_CMS, T_C, MU_CP, RHO),
      `${cfg.comps[i].id}: computeAllKov[${i}]`);
  }
  // kovBreakdown must agree with computeKov_s1 bit for bit — same kernels, same clamps.
  for (const comp of cfg.comps) {
    assert.equal(mt.kovBreakdown(cfg, comp, U_CMS, T_C, MU_CP, RHO).kOv_s1,
      mt.computeKov_s1(cfg, comp, U_CMS, T_C, MU_CP, RHO), `${comp.id}: breakdown vs scalar`);
  }
});

test('§6.8 — k_ov depends on velocity only through the film term', () => {
  // "k_ov depends only on resin geometry, velocity, temperature and molecular size" — and the
  // velocity enters ONLY through k_f, so a species whose resistance is pore-dominated must be
  // almost flow-insensitive while a salt is not. That is the shape of the whole model.
  const { cfg } = pilotCfg();
  const at = (id, u) => mt.kovBreakdown(cfg, compOf(cfg, id), u, T_C, MU_CP, RHO);
  for (const id of ['AGG', 'mAb', 'Na', 'tracer']) {
    const slow = at(id, U_CMS / 4);
    const fast = at(id, 4 * U_CMS);
    assertRel(slow.tauPore_s, fast.tauPore_s, 1e-15, `${id}: tau_pore must not depend on u`);
    assert.ok(fast.kOv_s1 > slow.kOv_s1, `${id}: k_ov must rise with flow`);
  }
  // AGG is 1.1 % film at 150 cm/h, so a 16x flow change may move it by only a few per cent;
  // acetone is 34.7 % film and must move far more.
  const aggSpan = at('AGG', 4 * U_CMS).kOv_s1 / at('AGG', U_CMS / 4).kOv_s1;
  const acetoneSpan = at('tracer', 4 * U_CMS).kOv_s1 / at('tracer', U_CMS / 4).kOv_s1;
  assert.ok(aggSpan < 1.05, `AGG is pore-limited; span ${aggSpan}`);
  assert.ok(acetoneSpan > 1.3, `acetone is film-sensitive; span ${acetoneSpan}`);
});
