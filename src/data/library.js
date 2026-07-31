/**
 * @file src/data/library.js — the authored-constant library (architecture-v2 §6.21, §5.7, §5.8).
 *
 * LAYER L0. **No imports at all.** Everything here is a frozen-by-convention `const` table plus
 * three lookups. No logic, no state, no top-level side effects.
 *
 * This file is the single home for every authored constant in the program:
 *
 *   - `SCALES`        — the three skid scales (LAB / PILOT / PROCESS) and everything that differs
 *                       between them: column defaults, pump envelope, mixer and loop options,
 *                       fraction-valve ports, downstream resistance, waste capacity and tank set.
 *   - `SEGMENT_TABLE` — the complete §5.7 hold-up rows, per scale, written out literally.
 *   - `RESINS`        — the enumerated resin library.
 *   - `SPECIES`       — the 15-entry species library, authored in HUMAN units
 *                       (`SpeciesConfigHuman`, §"Authoring types" below).
 *
 * ---------------------------------------------------------------------------------------------
 * UNITS (§1.1). Every number below carries its unit in the name. The ONE ingest conversion is
 * `data/presets.js::normalizePreset()`; nothing here is ever converted a second time.
 * ---------------------------------------------------------------------------------------------
 *
 * **THERE IS NO `Rhw_bar_per_mLs` ANYWHERE IN THIS FILE, AND THERE MUST NEVER BE ONE.**
 * Hardware pressure drop is `dP_hw = column.rFrit_bar_per_cms * u_cms * column.foulingFactor`
 * and nothing else (§7.1.4). An author who wires `dP_hw = Rhw * Q` gets 0.049 bar at the pilot's
 * nominal flow — a factor of 1000 above the correct 4.6e-5 bar — and nothing in the contract
 * catches it.
 */

/* =================================================================================================
 * AUTHORING TYPES
 * ===============================================================================================*/

/**
 * @typedef {Object} SegmentDef
 * @property {string} id     Segment id, unique within a scale (`'S1A'`, `'G2'`, `'D3'`, …).
 * @property {'SUCTION_A'|'SUCTION_B'|'SUCTION_S'|'GRADIENT'|'DETECTOR'|'DEAD_LEG'|'SAMPLE'|'WASTE'} group
 * @property {number} V_mL   Total hold-up of the segment, mL.
 * @property {number} N      Tanks-in-series plate count. Each segment is `N` equal CSTRs of
 *                           volume `V_mL / N`.
 */

/**
 * @typedef {Object} TankDef
 * @property {string}  id                A `TK-*` id, unique within the tank set.
 * @property {string}  label             Human label for the P&ID bubble and the System card.
 * @property {string}  port              Inlet port this tank is plumbed to: `'A1'`…`'A4'`,
 *                                       `'B1'`…`'B4'`, `'S1'`…`'S3'`.
 * @property {number}  nominalVolume_mL  Vessel capacity, mL.
 * @property {number}  startVolume_mL    Fill at run start, mL. Always `<= nominalVolume_mL`.
 * @property {number}  lowLevelPct       `WRN-TNK-01` threshold, percent of nominal (0–100).
 * @property {number}  emptyLevel_mL     Dip-tube dead volume, mL. At this level the pump starts
 *                                       ingesting gas (§6.13, the 2.0 s slurp cross-fade).
 * @property {number}  T_C               Tank temperature, °C.
 * @property {boolean} isSample          True for the feed tank drawn by the sample pump.
 * @property {TankComposition} composition
 */

/**
 * @typedef {Object} TankComposition
 * Solved ONCE at ingest by `normalizePreset` via `chem/ph.js::solveCounterIon` +
 * `buildTankVector` (§8.2). No salt number is ever stored: the NaCl top-up is
 * `saltTarget.total_mM - solveCounterIon(...).cation_mM`.
 * @property {Array<{speciesId:string, total_mM:number}>} buffers  Buffer TOTALS, mM.
 * @property {number|null} targetPH          pH the buffer is titrated to; `null` = untitrated.
 * @property {string} counterCation          Species id of the titrant cation (`'Na'`).
 * @property {string} counterAnion           Species id of the balancing anion (`'Cl'`).
 * @property {{ion:string, total_mM:number}|null} saltTarget  TOTAL of `ion` after titration, mM.
 * @property {number} organic_frac           Organic modifier, volume fraction 0–1.
 * @property {number} strongBase_mM          Strong base (NaOH) excess, mM.
 * @property {number} strongAcid_mM          Strong acid (HCl) excess, mM.
 * @property {Array<{speciesId:string, titer_gL:number}>} proteins
 *           Protein/macromolecule content in **g/L** (the human unit). `buildTankVector` converts
 *           with `mM = g/L * 1000 / MW_gmol` (R-U3). Empty for every buffer tank.
 */

/**
 * @typedef {Object} SpeciesConfigHuman
 * **The authored shape of every `SPECIES` entry.** This is the input side of the §1.1 R-U1 ingest
 * boundary; `normalizePreset` converts it ONCE into the canonical `SpeciesConfig` of §5.8.1 and
 * freezes the result. Field names match §5.8.1 exactly wherever the authored unit already IS the
 * canonical unit; the four fields whose authored unit genuinely differs carry a different name so
 * a mis-wired copy is a `undefined`, not a silent factor of 1000.
 *
 * @property {string} id                 Registry id. Also the `truth_<id>_mM` log-channel stem.
 * @property {string} name               Display name.
 * @property {'ion'|'buffer'|'baseExcess'|'product'|'impurity'|'aggregate'|'tracer'|'organic'} role
 * @property {number} MW_gmol            Molar mass, **g/mol**. Authored and canonical unit are the
 *                                       same (§1.1 "Molar mass | g/mol"); kDa is a *display* unit
 *                                       owned by `ui/format.js`, never an ingest unit. Authoring
 *                                       kDa here would put `22.990000000000002` into every small
 *                                       ion for no benefit.
 * @property {boolean} transported       `false` => never enters the column arrays (`colIdxOf` −1).
 * @property {'inert'|'donnan'|'binding'} kind   Drives the isotherm branch AND the normative
 *                                       species sort order (inert, then donnan, then binding).
 * @property {'COUNTER'|'CO'|'NONE'|null} donnanRole
 *           `null` = DERIVE per §5.8.3 from `charge * column.resinChargeSign`. A non-null value is
 *           the §5.8.3 authored override. Every entry below is `null`: authoring `charge` as the
 *           charge of the *ionised* form (acetate −1) makes the derivation correct on a CEX resin
 *           **and** on an AEX resin, so no override is needed and no preset can get it backwards.
 * @property {number} epsPi              Accessible pore porosity, dimensionless 0–1. **Authored
 *                                       directly**; `KD` is derived from it, never the reverse
 *                                       (§5.8.1). Clamped to `[0, column.epsP]` at ingest.
 * @property {number|null} Dm_cm2s       Free-solution diffusivity, cm²/s. `null` => Polson.
 * @property {number|null} Dp_cm2s       Pore diffusivity, cm²/s. `null` => Renkin/Mackie–Meares.
 * @property {number} keffScale          Dimensionless multiplier on `k_ov` (fitting knob).
 * @property {number} concScale_mM       Characteristic concentration scale, mM. Only consumer is
 *                                       the §6.9.4 active-window test: `tol = 1e-6 * concScale_mM`.
 * @property {number} nu                 SMA characteristic charge, dimensionless.
 * @property {number} sigma              SMA steric factor, dimensionless.
 * @property {number} Keq                SMA equilibrium constant, dimensionless.
 * @property {number} qmax_gLbead        Langmuir/HIC saturation capacity, **g per L of BEAD
 *                                       volume** (BASIS N1). Not read in `SMA` mode, where the
 *                                       capacity is the identity `q_max = Λ/(ν+σ)`.
 * @property {number} b0_Lmol            Langmuir/HIC affinity at zero salt, **L/mol**.
 * @property {number} beta_Lmol          HIC salting-out exponent `B`, **L/mol**.
 * @property {number} csRef_molL         Reference modulator concentration, **mol/L**. 0 = absolute.
 * @property {number} Klin               `LINEAR` mode partition coefficient, dimensionless.
 * @property {number} eps280_Lgcm        Mass extinction at 280 nm, L·g⁻¹·cm⁻¹.
 * @property {number} eps260_Lgcm        Mass extinction at 260 nm, L·g⁻¹·cm⁻¹.
 * @property {number} eps300_Lgcm        Mass extinction at 300 nm, L·g⁻¹·cm⁻¹.
 * @property {number} charge             Formal charge `z` of the **ionised** form. 0 for proteins.
 *                                       For a buffer TOTAL it is the charge of the ionised form
 *                                       (acetate: −1), paired with the `ionisedFraction` that
 *                                       `chem/ph.js` derives at ingest.
 * @property {number} lambda0_Scm2eq     Limiting equivalent conductivity, S·cm²/eq. 0 if
 *                                       non-conducting.
 * @property {number[]|null} bufferPkas  pKa ladder at 25 °C; `null` => not a buffer total.
 * @property {number} bufferZ0           Charge of the fully protonated form.
 * @property {number} bufferDpKadT       dpKa/dT, per °C.
 * @property {string} notes              Authoring note. Dropped at ingest; never read by physics.
 */

/**
 * `SpeciesConfigHuman` → `SpeciesConfig` (§5.8.1). **This is the complete and exact conversion**
 * `data/presets.js::normalizePreset` performs, once, at ingest. Every line is either a copy or the
 * stated arithmetic; there is no third case.
 *
 * ```
 *   id, name, role, transported, kind          -> copied verbatim
 *   MW_gmol                                    -> MW_gmol                      (copy)
 *   donnanRole                                 -> donnanRole ?? derive(§5.8.3)
 *   epsPi                                      -> epsPi = clamp(epsPi, 0, column.epsP)
 *   (derived)                                  -> KD    = epsPi_clamped / column.epsP   (display)
 *   Dm_cm2s, Dp_cm2s                           -> copied (null => correlation, §7.3.2)
 *   keffScale, concScale_mM                    -> copied
 *   nu, sigma, Keq, Klin                       -> copied (all dimensionless)
 *   qmax_gLbead   [g/L bead]                   -> qmax_mM  = qmax_gLbead * 1000 / MW_gmol
 *   b0_Lmol       [L/mol]                      -> b0_mM1   = b0_Lmol   / 1000
 *   beta_Lmol     [L/mol]                      -> beta_mM1 = beta_Lmol / 1000
 *   csRef_molL    [mol/L]                      -> csRef_mM = csRef_molL * 1000
 *   eps280_Lgcm, eps260_Lgcm, eps300_Lgcm      -> copied (already L/g/cm)
 *   charge, lambda0_Scm2eq                     -> copied
 *   bufferPkas, bufferZ0, bufferDpKadT         -> copied
 *   (derived)                                  -> ionisedFraction  <- chem/ph.js, from the tank's
 *                                                 solved pH and the Davies-adjusted pKa ladder
 *                                                 (1.0 for strong ions, 0 for proteins)
 *   notes                                      -> DROPPED
 * ```
 *
 * Worked, and these four reproduce the spec tables exactly:
 * ```
 *   mAb  qmax_gLbead 40.0  / MW 148000 -> 0.27027027027027023 mM  (= 2.7027e-4 mol/L bead)
 *   AGG  qmax_gLbead 25.0  / MW 296000 -> 0.08445945945945946 mM  (= 8.4459e-5 mol/L bead)
 *   WHI  qmax_gLbead 90.0  / MW  45000 -> 2.0                 mM  (= 2.0000e-3 mol/L bead)
 *   HHI  qmax_gLbead 100.0 / MW  30000 -> 3.3333333333333335  mM  (= 3.3333e-3 mol/L bead)
 *   mAb  b0_Lmol 50 -> 0.05 mM^-1 ;  beta_Lmol 8.0 -> 0.008 mM^-1
 * ```
 * The three fields `KD`, `ionisedFraction` and (when authored `null`) `donnanRole` are **DERIVED
 * AT INGEST AND NEVER AUTHORED**. `tortuosity` does not exist — `masstransfer.tortuosityMM(epsP)`
 * computes it, and a stored copy was a live trap (§5.8.1).
 */

/* =================================================================================================
 * SEGMENT / HOLD-UP TABLES (§5.7) — written out literally, one array per scale.
 *
 * Derived hold-ups are computed from these rows by `skid/skid.js::buildTopology` and MUST
 * reproduce §5.7.3 exactly:
 *
 *   VcolOutToUV_mL   = D1 + D2 + D3/2                          0.57  / 36.25  / 652.5
 *   VuvToCond_mL     = D3/2 + D4 + D5/2                        0.22  /  6.75  / 107.5
 *   VcondToPh_mL     = D5/2 + D6 + D7/2                        0.45  / 17.50  / 300.0
 *   VphToFracValve_mL= D7/2 + D8                               0.55  / 26.00  / 425.0
 *   VuvToFracValve_mL= D3/2 + D4 + D5 + D6 + D7 + D8           1.22  / 50.25  / 832.5
 *   VfracDeadLeg_mL  = D9                                      0.35  / 18.00  / 250.0
 *   Vsuction_mL      = S1 + S2                                 1.55  / 37.00  / 600.0
 *   Vgrad_mL         = G1..G9                                  3.80  / 245.0  / 3940.0
 *   sigmaGrad_mL     = sqrt(sum V^2/N over G1..G9)             2.026 / 113.40 / 1733.6
 *   NeffGrad         = Vgrad^2 / sigmaGrad^2                   3.518 /   4.67 /    5.16
 *   sigmaInjToUV_mL  = sqrt(sum V^2/N over G6..G9,D1,D2,D3/2)  0.2561/ 16.155 /  291.90
 *
 * Two ingest-time substitutions apply to the GRADIENT rows and are `normalizePreset`'s job:
 *   - `G2` is replaced by the selected mixer: `V_mL = config.skid.mixerVolume_mL` (one of
 *     `scale.mixerOptions_mL`) and `N = config.skid.mixerN` (1 = DYNAMIC, 10 = STATIC).
 *   - `G5` becomes `{ V_mL: 0.05, N: 1 }` when `config.skid.airTrap === false`.
 *   - `G4` becomes `{ V_mL: 0,    N: 1 }` when `config.skid.inlineFilter === false`.
 *
 * The PILOT table instantiates 203 CSTRs in total, which is the tank count §2.1.1's per-tick
 * budget is built on.
 * ===============================================================================================*/

/** @type {{LAB: SegmentDef[], PILOT: SegmentDef[], PROCESS: SegmentDef[]}} */
export const SEGMENT_TABLE = {
  LAB: [
    // --- suction, per branch: inlet select valve + line, then pump head + check valves (§5.7.1)
    { id: 'S1A', group: 'SUCTION_A', V_mL: 1.20, N: 15 },
    { id: 'S2A', group: 'SUCTION_A', V_mL: 0.35, N: 2 },
    { id: 'S1B', group: 'SUCTION_B', V_mL: 1.20, N: 15 },
    { id: 'S2B', group: 'SUCTION_B', V_mL: 0.35, N: 2 },
    { id: 'S1S', group: 'SUCTION_S', V_mL: 1.20, N: 15 },
    { id: 'S2S', group: 'SUCTION_S', V_mL: 0.35, N: 2 },
    // --- gradient path: mixing tee -> column inlet frit (§5.7.2)
    { id: 'G1', group: 'GRADIENT', V_mL: 0.25, N: 12 },  // pump outlets -> mixing tee
    { id: 'G2', group: 'GRADIENT', V_mL: 2.00, N: 1 },   // inline mixer chamber (replaced at ingest)
    { id: 'G3', group: 'GRADIENT', V_mL: 0.15, N: 10 },  // mixer -> inline filter
    { id: 'G4', group: 'GRADIENT', V_mL: 0.25, N: 3 },   // inline filter housing
    { id: 'G5', group: 'GRADIENT', V_mL: 0.20, N: 1 },   // air trap / bubble trap
    { id: 'G6', group: 'GRADIENT', V_mL: 0.20, N: 8 },   // sample inlet valve + injection tee
    { id: 'G7', group: 'GRADIENT', V_mL: 0.20, N: 12 },  // pre-column P/T + line to column valve
    { id: 'G8', group: 'GRADIENT', V_mL: 0.35, N: 6 },   // column valve, inlet leg
    { id: 'G9', group: 'GRADIENT', V_mL: 0.20, N: 5 },   // column inlet distributor / header
    // --- detector path: column outlet frit -> fraction outlet port (§5.7.3)
    { id: 'D1', group: 'DETECTOR', V_mL: 0.20, N: 5 },   // column outlet header / frit
    { id: 'D2', group: 'DETECTOR', V_mL: 0.35, N: 6 },   // column valve outlet leg + post-col P/T
    { id: 'D3', group: 'DETECTOR', V_mL: 0.04, N: 2 },   // UV flow cell           <- measurement plane
    { id: 'D4', group: 'DETECTOR', V_mL: 0.15, N: 10 },  // UV -> conductivity line
    { id: 'D5', group: 'DETECTOR', V_mL: 0.10, N: 2 },   // conductivity cell      <- measurement plane
    { id: 'D6', group: 'DETECTOR', V_mL: 0.30, N: 10 },  // conductivity -> pH line
    { id: 'D7', group: 'DETECTOR', V_mL: 0.20, N: 2 },   // pH flow chamber        <- measurement plane
    { id: 'D8', group: 'DETECTOR', V_mL: 0.45, N: 12 },  // pH -> fraction valve seat
    { id: 'D9', group: 'DEAD_LEG', V_mL: 0.35, N: 10 },  // fraction valve -> outlet port (dead leg)
    // --- ancillary (§5.7.4)
    { id: 'A1', group: 'SAMPLE', V_mL: 1.00, N: 15 },    // sample suction line
    { id: 'A2', group: 'SAMPLE', V_mL: 0.80, N: 12 },    // sample pump -> injection tee
    { id: 'A3', group: 'WASTE', V_mL: 1.00, N: 8 },      // fraction valve -> waste
  ],

  PILOT: [
    { id: 'S1A', group: 'SUCTION_A', V_mL: 25, N: 15 },
    { id: 'S2A', group: 'SUCTION_A', V_mL: 12, N: 2 },
    { id: 'S1B', group: 'SUCTION_B', V_mL: 25, N: 15 },
    { id: 'S2B', group: 'SUCTION_B', V_mL: 12, N: 2 },
    { id: 'S1S', group: 'SUCTION_S', V_mL: 25, N: 15 },
    { id: 'S2S', group: 'SUCTION_S', V_mL: 12, N: 2 },
    { id: 'G1', group: 'GRADIENT', V_mL: 8, N: 12 },
    { id: 'G2', group: 'GRADIENT', V_mL: 100, N: 1 },
    { id: 'G3', group: 'GRADIENT', V_mL: 6, N: 10 },
    { id: 'G4', group: 'GRADIENT', V_mL: 25, N: 3 },
    { id: 'G5', group: 'GRADIENT', V_mL: 50, N: 1 },
    { id: 'G6', group: 'GRADIENT', V_mL: 12, N: 8 },
    { id: 'G7', group: 'GRADIENT', V_mL: 8, N: 12 },
    { id: 'G8', group: 'GRADIENT', V_mL: 18, N: 6 },
    { id: 'G9', group: 'GRADIENT', V_mL: 18, N: 5 },
    { id: 'D1', group: 'DETECTOR', V_mL: 18, N: 5 },
    { id: 'D2', group: 'DETECTOR', V_mL: 18, N: 6 },
    { id: 'D3', group: 'DETECTOR', V_mL: 0.5, N: 2 },
    { id: 'D4', group: 'DETECTOR', V_mL: 5, N: 10 },
    { id: 'D5', group: 'DETECTOR', V_mL: 3, N: 2 },
    { id: 'D6', group: 'DETECTOR', V_mL: 12, N: 10 },
    { id: 'D7', group: 'DETECTOR', V_mL: 8, N: 2 },
    { id: 'D8', group: 'DETECTOR', V_mL: 22, N: 12 },
    { id: 'D9', group: 'DEAD_LEG', V_mL: 18, N: 10 },
    { id: 'A1', group: 'SAMPLE', V_mL: 20, N: 15 },
    { id: 'A2', group: 'SAMPLE', V_mL: 25, N: 12 },
    { id: 'A3', group: 'WASTE', V_mL: 40, N: 8 },
  ],

  PROCESS: [
    { id: 'S1A', group: 'SUCTION_A', V_mL: 400, N: 15 },
    { id: 'S2A', group: 'SUCTION_A', V_mL: 200, N: 2 },
    { id: 'S1B', group: 'SUCTION_B', V_mL: 400, N: 15 },
    { id: 'S2B', group: 'SUCTION_B', V_mL: 200, N: 2 },
    { id: 'S1S', group: 'SUCTION_S', V_mL: 400, N: 15 },
    { id: 'S2S', group: 'SUCTION_S', V_mL: 200, N: 2 },
    { id: 'G1', group: 'GRADIENT', V_mL: 120, N: 12 },
    { id: 'G2', group: 'GRADIENT', V_mL: 1500, N: 1 },
    { id: 'G3', group: 'GRADIENT', V_mL: 100, N: 10 },
    { id: 'G4', group: 'GRADIENT', V_mL: 450, N: 3 },
    { id: 'G5', group: 'GRADIENT', V_mL: 800, N: 1 },
    { id: 'G6', group: 'GRADIENT', V_mL: 200, N: 8 },
    { id: 'G7', group: 'GRADIENT', V_mL: 120, N: 12 },
    { id: 'G8', group: 'GRADIENT', V_mL: 300, N: 6 },
    { id: 'G9', group: 'GRADIENT', V_mL: 350, N: 5 },
    { id: 'D1', group: 'DETECTOR', V_mL: 350, N: 5 },
    { id: 'D2', group: 'DETECTOR', V_mL: 300, N: 6 },
    { id: 'D3', group: 'DETECTOR', V_mL: 5, N: 2 },
    { id: 'D4', group: 'DETECTOR', V_mL: 80, N: 10 },
    { id: 'D5', group: 'DETECTOR', V_mL: 50, N: 2 },
    { id: 'D6', group: 'DETECTOR', V_mL: 200, N: 10 },
    { id: 'D7', group: 'DETECTOR', V_mL: 150, N: 2 },
    { id: 'D8', group: 'DETECTOR', V_mL: 350, N: 12 },
    { id: 'D9', group: 'DEAD_LEG', V_mL: 250, N: 10 },
    { id: 'A1', group: 'SAMPLE', V_mL: 350, N: 15 },
    { id: 'A2', group: 'SAMPLE', V_mL: 400, N: 12 },
    { id: 'A3', group: 'WASTE', V_mL: 600, N: 8 },
  ],
};

/* =================================================================================================
 * TANK SETS — the default source-tank array per scale.
 *
 * SOURCE TANKS ONLY (§5.1). There is no waste tank and no `isWaste` field: waste is the scalar
 * `run.wasteVolume_mL` measured against `SCALES[x].wasteCapacity_mL`, and it has exactly one log
 * channel, `waste_L`. A preset that shipped a waste tank would emit both `tank_TK-WASTE_L` and
 * `waste_L` and silently change the mandated CSV column count.
 *
 * The PILOT set is §8.4.2 verbatim. LAB and PROCESS carry the same chemistry (buffer recipes are
 * scale-invariant) with vessel sizes from the same table scaled by column volume:
 *   CV   = 40.2124 mL (LAB, 1.60x20) / 1570.7963 mL (PILOT, 10x20) / 31808.6 mL (PROCESS, 45x20)
 *   demand ratio vs PILOT = 0.025601 (LAB) / 20.250 (PROCESS)
 * Every `startVolume_mL` below clears the §8.4.2 per-tank method demand at its own scale with
 * margin, so `PRC-02` passes on a fresh load at all three scales.
 * ===============================================================================================*/

/** Buffer A / wash / feed background: 50 mM acetate titrated to pH 5.00, total Na 50 mM (§8.2). */
const COMP_BUFFER_A = {
  buffers: [{ speciesId: 'AcT', total_mM: 50 }],
  targetPH: 5.00,
  counterCation: 'Na',
  counterAnion: 'Cl',
  saltTarget: { ion: 'Na', total_mM: 50.0 },
  organic_frac: 0,
  strongBase_mM: 0,
  strongAcid_mM: 0,
  proteins: [],
};

/** Buffer B / strip: 50 mM acetate pH 5.00, total Na 500 mM (§8.2). */
const COMP_BUFFER_B = {
  buffers: [{ speciesId: 'AcT', total_mM: 50 }],
  targetPH: 5.00,
  counterCation: 'Na',
  counterAnion: 'Cl',
  saltTarget: { ion: 'Na', total_mM: 500.0 },
  organic_frac: 0,
  strongBase_mM: 0,
  strongAcid_mM: 0,
  proteins: [],
};

/** Water for injection: nothing dissolved. */
const COMP_WFI = {
  buffers: [],
  targetPH: null,
  counterCation: 'Na',
  counterAnion: 'Cl',
  saltTarget: null,
  organic_frac: 0,
  strongBase_mM: 0,
  strongAcid_mM: 0,
  proteins: [],
};

/** CIP: 0.5 M NaOH. True pH 13.699 under the §6.6 water convention; the probe reads 12.900. */
const COMP_NAOH = {
  buffers: [],
  targetPH: null,
  counterCation: 'Na',
  counterAnion: 'Cl',
  saltTarget: null,
  organic_frac: 0,
  strongBase_mM: 500,
  strongAcid_mM: 0,
  proteins: [],
};

/**
 * Clarified harvest: Buffer A EXACTLY (§8.4.2 — this is deliberate and load-bearing; the load runs
 * at the equilibration modulator so nothing binds or elutes because the *buffer* changed) plus the
 * four proteins at the §8.1 feed titres, 5.00 g/L total.
 */
const COMP_FEED = {
  buffers: [{ speciesId: 'AcT', total_mM: 50 }],
  targetPH: 5.00,
  counterCation: 'Na',
  counterAnion: 'Cl',
  saltTarget: { ion: 'Na', total_mM: 50.0 },
  organic_frac: 0,
  strongBase_mM: 0,
  strongAcid_mM: 0,
  proteins: [
    { speciesId: 'mAb', titer_gL: 4.25 },
    { speciesId: 'WKI', titer_gL: 0.45 },
    { speciesId: 'AGG', titer_gL: 0.20 },
    { speciesId: 'SBI', titer_gL: 0.10 },
  ],
};

/** @type {TankDef[]} */
const TANKS_LAB = [
  { id: 'TK-EQ', label: 'Equilibration / wash', port: 'A1', nominalVolume_mL: 2000, startVolume_mL: 1000, lowLevelPct: 10, emptyLevel_mL: 20, T_C: 25, isSample: false, composition: COMP_BUFFER_A },
  { id: 'TK-WASH', label: 'Spare wash (= A1)', port: 'A2', nominalVolume_mL: 2000, startVolume_mL: 500, lowLevelPct: 10, emptyLevel_mL: 20, T_C: 25, isSample: false, composition: COMP_BUFFER_A },
  { id: 'TK-WFI', label: 'Water for injection', port: 'A3', nominalVolume_mL: 2000, startVolume_mL: 500, lowLevelPct: 10, emptyLevel_mL: 20, T_C: 25, isSample: false, composition: COMP_WFI },
  { id: 'TK-NAOH', label: '0.5 M NaOH (CIP)', port: 'A4', nominalVolume_mL: 1000, startVolume_mL: 250, lowLevelPct: 10, emptyLevel_mL: 20, T_C: 25, isSample: false, composition: COMP_NAOH },
  { id: 'TK-ELU', label: 'Elution buffer B', port: 'B1', nominalVolume_mL: 2000, startVolume_mL: 900, lowLevelPct: 10, emptyLevel_mL: 20, T_C: 25, isSample: false, composition: COMP_BUFFER_B },
  { id: 'TK-STRIP', label: 'Strip (= B1)', port: 'B2', nominalVolume_mL: 2000, startVolume_mL: 250, lowLevelPct: 10, emptyLevel_mL: 20, T_C: 25, isSample: false, composition: COMP_BUFFER_B },
  { id: 'TK-FEED', label: 'Clarified harvest', port: 'S1', nominalVolume_mL: 1000, startVolume_mL: 200, lowLevelPct: 10, emptyLevel_mL: 20, T_C: 25, isSample: true, composition: COMP_FEED },
];

/** @type {TankDef[]} — §8.4.2 verbatim. */
const TANKS_PILOT = [
  { id: 'TK-EQ', label: 'Equilibration / wash', port: 'A1', nominalVolume_mL: 100000, startVolume_mL: 40000, lowLevelPct: 10, emptyLevel_mL: 500, T_C: 25, isSample: false, composition: COMP_BUFFER_A },
  { id: 'TK-WASH', label: 'Spare wash (= A1)', port: 'A2', nominalVolume_mL: 100000, startVolume_mL: 20000, lowLevelPct: 10, emptyLevel_mL: 500, T_C: 25, isSample: false, composition: COMP_BUFFER_A },
  { id: 'TK-WFI', label: 'Water for injection', port: 'A3', nominalVolume_mL: 100000, startVolume_mL: 20000, lowLevelPct: 10, emptyLevel_mL: 500, T_C: 25, isSample: false, composition: COMP_WFI },
  { id: 'TK-NAOH', label: '0.5 M NaOH (CIP)', port: 'A4', nominalVolume_mL: 25000, startVolume_mL: 10000, lowLevelPct: 10, emptyLevel_mL: 500, T_C: 25, isSample: false, composition: COMP_NAOH },
  { id: 'TK-ELU', label: 'Elution buffer B', port: 'B1', nominalVolume_mL: 50000, startVolume_mL: 35000, lowLevelPct: 10, emptyLevel_mL: 500, T_C: 25, isSample: false, composition: COMP_BUFFER_B },
  { id: 'TK-STRIP', label: 'Strip (= B1)', port: 'B2', nominalVolume_mL: 50000, startVolume_mL: 10000, lowLevelPct: 10, emptyLevel_mL: 500, T_C: 25, isSample: false, composition: COMP_BUFFER_B },
  { id: 'TK-FEED', label: 'Clarified harvest', port: 'S1', nominalVolume_mL: 50000, startVolume_mL: 8000, lowLevelPct: 10, emptyLevel_mL: 500, T_C: 25, isSample: true, composition: COMP_FEED },
];

/** @type {TankDef[]} */
const TANKS_PROCESS = [
  { id: 'TK-EQ', label: 'Equilibration / wash', port: 'A1', nominalVolume_mL: 1500000, startVolume_mL: 800000, lowLevelPct: 10, emptyLevel_mL: 10000, T_C: 25, isSample: false, composition: COMP_BUFFER_A },
  { id: 'TK-WASH', label: 'Spare wash (= A1)', port: 'A2', nominalVolume_mL: 1500000, startVolume_mL: 400000, lowLevelPct: 10, emptyLevel_mL: 10000, T_C: 25, isSample: false, composition: COMP_BUFFER_A },
  { id: 'TK-WFI', label: 'Water for injection', port: 'A3', nominalVolume_mL: 1500000, startVolume_mL: 400000, lowLevelPct: 10, emptyLevel_mL: 10000, T_C: 25, isSample: false, composition: COMP_WFI },
  { id: 'TK-NAOH', label: '0.5 M NaOH (CIP)', port: 'A4', nominalVolume_mL: 200000, startVolume_mL: 150000, lowLevelPct: 10, emptyLevel_mL: 10000, T_C: 25, isSample: false, composition: COMP_NAOH },
  { id: 'TK-ELU', label: 'Elution buffer B', port: 'B1', nominalVolume_mL: 1000000, startVolume_mL: 600000, lowLevelPct: 10, emptyLevel_mL: 10000, T_C: 25, isSample: false, composition: COMP_BUFFER_B },
  { id: 'TK-STRIP', label: 'Strip (= B1)', port: 'B2', nominalVolume_mL: 1000000, startVolume_mL: 200000, lowLevelPct: 10, emptyLevel_mL: 10000, T_C: 25, isSample: false, composition: COMP_BUFFER_B },
  { id: 'TK-FEED', label: 'Clarified harvest', port: 'S1', nominalVolume_mL: 500000, startVolume_mL: 160000, lowLevelPct: 10, emptyLevel_mL: 10000, T_C: 25, isSample: true, composition: COMP_FEED },
];

/* =================================================================================================
 * SCALES (§6.21)
 *
 * ASSEMBLY RULE for `normalizePreset` — each value below appears in EXACTLY ONE place, so nothing
 * can drift:
 *
 *   config.column      <- { ...RESINS[scale.column.defaultResinId] mapped, ...scale.column,
 *                           ...preset.column }
 *   config.skid        <- { ...scale.skid,
 *                           Qmax_mLs, Qmin_mLs, QminAbs_mLs, rampRate_mLs2, Vstroke_mL,
 *                           wasteCapacity_mL            <- the FLAT scale fields,
 *                           mixerVolume_mL              <- scale.skid.mixerVolume_mL
 *                                                          (must be one of scale.mixerOptions_mL),
 *                           fracValve: { ...scale.skid.fracValve,
 *                                        tSwitch_s: scale.tSwitch_s,
 *                                        ports:     scale.fracValvePorts },
 *                           press:     { ...scale.skid.press,
 *                                        Rdown_bar_per_mLs: scale.Rdown_bar_per_mLs },
 *                           segments:  SEGMENT_TABLE[scale.segmentTableKey],
 *                           ...preset.skid }
 *   config.tanks       <- scale.tankSet, overridden per-tank by the preset
 *   alarm thresholds   <- ALARM_TABLE row threshold, then scale.alarmThresholdOverrides[id]
 *
 * `tSwitch_s`, `fracValvePorts`, `Rdown_bar_per_mLs`, `Qmax_mLs`, `Qmin_mLs`, `QminAbs_mLs`,
 * `rampRate_mLs2`, `Vstroke_mL` and `wasteCapacity_mL` are FLAT and authoritative; the nested
 * `skid.fracValve` and `skid.press` objects deliberately omit them so there is no second copy.
 * ===============================================================================================*/

/**
 * Per-scale skid and column defaults.
 *
 * Pump envelope, from the equipment table (mL/min -> mL/s at ingest-free authoring time, i.e.
 * already divided by 60 here because `_mLs` is the canonical unit and R-U1 forbids a second
 * conversion downstream):
 *
 * ```
 *              Q_max            Q_min(spec)      Q_min(abs)     ramp            V_stroke  t_switch
 *   LAB        20   mL/min      0.40 mL/min      0.10 mL/min    20 % Qmax/s     0.10 mL   0.20 s
 *   PILOT      1000 mL/min      20   mL/min      5    mL/min    10 % Qmax/s     5.0  mL   0.80 s
 *   PROCESS    13333 mL/min     267  mL/min      65   mL/min     5 % Qmax/s     60   mL   1.50 s
 * ```
 * On each scale's own reference column that `Q_max` is 597 / 764 / 503 cm/h.
 *
 * `Rdown_bar_per_mLs` is chosen so `P2` at each scale's nominal flow is ~0.088 bar
 * (§6.21): LAB 0.530 x 0.16755 = 0.0888; PILOT 0.027 x 3.27249 = 0.0884;
 * PROCESS 0.00133 x 66.268 = 0.0881 bar.
 *
 * `filter.R0_bar_per_mLs` follows the same rule and lands the nominal filter drop at ~0.0131 bar
 * everywhere, matching §5.6.2's pilot budget. `filter.kFoul_per_mg` is inversely proportional to
 * the scale's nominal load mass (feed 5.00 g/L over the 3.5294 CV load), so a full load fouls the
 * filter by the same factor of 1.554 at every scale — and PILOT reproduces §2.1's 2.0e-5 exactly:
 * `0.554 / 27720 mg = 2.0e-5`.
 *
 * `column.rFrit_bar_per_cms` keeps the hardware drop deliberately negligible at every scale
 * (5.5e-5 / 4.6e-5 / 6.4e-5 bar at nominal), scaled from PILOT's normative 0.0011 by the
 * 0.6 / 1.0 / 1.4 hardware-resistance ratio of the equipment table. This is what makes §5.6.2's
 * `fouled-column-high-dp` scenario (which raises the BASE frit resistance to 0.030) the only way
 * to reach the dP ladder, and it must stay that way.
 *
 * `alarmThresholdOverrides` is `{}` at all three scales **on purpose**: §5.6's ladder is quoted
 * "(all)" for every row because it was derived from the hydraulics, which are written in linear
 * velocity and are therefore scale-invariant (§5.6.2). The field exists so a future scale can
 * deviate without a schema change; leaving it empty is the correct current value, not an omission.
 */
export const SCALES = {
  LAB: {
    id: 'LAB',
    name: 'Lab skid',
    description: 'Bench system, 1–20 mL/min, glass columns up to ~2 cm ID. High-pressure gradient forming with two pumps.',
    segmentTableKey: 'LAB',

    // ---- pump envelope (canonical mL/s and mL/s^2) --------------------------------------------
    Qmax_mLs: 0.33333,        // 20 mL/min
    Qmin_mLs: 0.0066667,      // 0.40 mL/min, the +/-2 % accuracy floor
    QminAbs_mLs: 0.0016667,   // 0.10 mL/min, degraded accuracy but still delivered
    rampRate_mLs2: 0.066667,  // 20 % Qmax per s
    Vstroke_mL: 0.10,         // twin-piston; f_ripple = 2*Q/Vstroke
    tSwitch_s: 0.20,          // fraction-valve actuation
    Rdown_bar_per_mLs: 0.530, // -> P2 = 0.0888 bar at the 300 cm/h nominal
    wasteCapacity_mL: 10000,  // 10 L carboy; method total is ~1871 mL

    mixerOptions_mL: [0.6, 2.0, 5.0],
    loopOptions_mL: [0.1, 0.5, 2, 10],
    fracValvePorts: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'],
    alarmThresholdOverrides: {},
    tankSet: TANKS_LAB,

    column: {
      id_cm: 1.60,
      L_cm: 20.0,
      defaultResinId: 'PrepSP-90HF',
      defaultFlow_cmh: 300,
      hardwarePressureLimit_bar: 5.0,
      rFrit_bar_per_cms: 0.00066,
      foulingFactor: 1.0,
      channellingFactor: 0.0,
      nz: 400,
    },

    skid: {
      gradientMode: 'HPGF',   // two metering pumps; no chopper, so no LPGF ripple to average
      chopPeriod_s: 1.0,
      tMinOpen_s: 0.040,
      mixerVolume_mL: 2.0,
      mixerN: 1,
      airTrap: true,
      inlineFilter: true,
      estopRamp_s: 0.1,
      rippleFlow_frac: 0.015,
      ripplePress_frac: 0.03,
      QswitchMax_frac: 0.10,
      ambientT_C: 25.0,
      fluidTau_s: 300,
      bubbleSensorThreshold_frac: 0.02,
      uv: {
        pathlength_cm: 0.02, strayLight: 3.0e-3, channels_nm: [280, 260, 300],
        tau_s: 0.5, noiseWhite_AU: 8e-5, noisePink_AU: 2.5e-4,
        driftWarm_AU_s: 2.78e-7, driftStart_AU: 0.025, driftTau_s: 400,
        foulPerCycle_AU: 2e-4, kRI_AU_per_mScm_s: 1.5e-3,
        overrange_AU: 2.00, saturated_AU: 2.40, dilutionRatio: 1.0,
        airSpike_AU: 3.0,
      },
      cond: {
        Kcell_cm1: 5.0, tau_s: 0.3, noiseAbs_mScm: 0.005, noiseRel: 5e-4,
        noisePinkRel: 2e-4, driftRel_s: 2.78e-7, foulPerCycle: -0.003,
        ptTau_s: 20, dryThreshold_frac: 0.5,
      },
      ph: {
        tau_s: 3.0, tauAsymRising: 1.6, tauElec_s: 1.0, noise_pH: 0.003,
        drift_pH_s: 5.56e-6, slopePct: 99.0, offset_mV: 0.0,
        slopeDecayPerCycle: 0.4, offsetDecayPerCycle: 0.3,
        freezeAir_frac: 0.30,
      },
      press: {
        P1FS_bar: 20.0, P2FS_bar: 20.0, accuracyFS: 0.005, noiseFS: 0.002,
        tauDisp_s: 0.5, tauAlarm_s: 0.2,
      },
      filter: { R0_bar_per_mLs: 0.0785, kFoul_per_mg: 7.8e-4 },
      fracValve: { overflowTo: 'WASTE', portCapacity_mL: 50 },
    },
  },

  PILOT: {
    id: 'PILOT',
    name: 'Pilot skid',
    description: 'Clinical-supply system, 20–1000 mL/min, 10–20 cm ID columns. Low-pressure gradient forming with a chopper valve and a mixing chamber.',
    segmentTableKey: 'PILOT',

    Qmax_mLs: 16.667,         // 1000 mL/min -> 764 cm/h on the 10 cm column
    Qmin_mLs: 0.333,          // 20 mL/min
    QminAbs_mLs: 0.0833,      // 5 mL/min
    rampRate_mLs2: 1.6667,    // 10 % Qmax per s
    Vstroke_mL: 5.0,
    tSwitch_s: 0.80,
    Rdown_bar_per_mLs: 0.027, // -> P2 = 0.0884 bar at the 150 cm/h nominal
    wasteCapacity_mL: 200000, // the DENOMINATOR of wasteFull/wasteHigh (§5.6 rows 17/18)

    mixerOptions_mL: [50, 100, 250],
    loopOptions_mL: [10, 50, 200],
    fracValvePorts: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'],
    alarmThresholdOverrides: {},
    tankSet: TANKS_PILOT,

    column: {
      id_cm: 10.0,
      L_cm: 20.0,
      defaultResinId: 'PrepSP-90HF',
      defaultFlow_cmh: 150,
      hardwarePressureLimit_bar: 4.0,
      rFrit_bar_per_cms: 0.0011,
      foulingFactor: 1.0,
      channellingFactor: 0.0,
      nz: 400,
    },

    skid: {
      gradientMode: 'LPGF',
      chopPeriod_s: 2.0,
      tMinOpen_s: 0.040,
      mixerVolume_mL: 100,
      mixerN: 1,
      airTrap: true,
      inlineFilter: true,
      estopRamp_s: 0.5,
      rippleFlow_frac: 0.015,
      ripplePress_frac: 0.03,
      QswitchMax_frac: 0.10,
      ambientT_C: 25.0,
      fluidTau_s: 900,
      bubbleSensorThreshold_frac: 0.02,
      uv: {
        pathlength_cm: 0.02, strayLight: 3.0e-3, channels_nm: [280, 260, 300],
        tau_s: 2.0, noiseWhite_AU: 8e-5, noisePink_AU: 2.5e-4,
        driftWarm_AU_s: 2.78e-7, driftStart_AU: 0.025, driftTau_s: 400,
        foulPerCycle_AU: 2e-4, kRI_AU_per_mScm_s: 1.5e-3,
        overrange_AU: 2.00, saturated_AU: 2.40, dilutionRatio: 1.0,
        airSpike_AU: 3.0,
      },
      cond: {
        Kcell_cm1: 5.0, tau_s: 1.0, noiseAbs_mScm: 0.005, noiseRel: 5e-4,
        noisePinkRel: 2e-4, driftRel_s: 2.78e-7, foulPerCycle: -0.003,
        ptTau_s: 60, dryThreshold_frac: 0.5,
      },
      ph: {
        tau_s: 8.0, tauAsymRising: 1.6, tauElec_s: 2.0, noise_pH: 0.003,
        drift_pH_s: 5.56e-6, slopePct: 99.0, offset_mV: 0.0,
        slopeDecayPerCycle: 0.4, offsetDecayPerCycle: 0.3,
        freezeAir_frac: 0.30,
      },
      press: {
        P1FS_bar: 10.0, P2FS_bar: 10.0, accuracyFS: 0.005, noiseFS: 0.002,
        tauDisp_s: 0.5, tauAlarm_s: 0.2,
      },
      filter: { R0_bar_per_mLs: 0.004, kFoul_per_mg: 2.0e-5 },
      fracValve: { overflowTo: 'WASTE', portCapacity_mL: 500 },
    },
  },

  PROCESS: {
    id: 'PROCESS',
    name: 'Process skid',
    description: 'Commercial manufacturing system, 0.3–13 L/min, 45–60 cm ID columns into bags and totes.',
    segmentTableKey: 'PROCESS',

    Qmax_mLs: 222.22,         // 13 333 mL/min -> 503 cm/h on the 45 cm column
    Qmin_mLs: 4.45,           // 267 mL/min
    QminAbs_mLs: 1.0833,      // 65 mL/min
    rampRate_mLs2: 11.111,    // 5 % Qmax per s
    Vstroke_mL: 60,
    tSwitch_s: 1.50,
    Rdown_bar_per_mLs: 0.00133, // -> P2 = 0.0881 bar at the 150 cm/h nominal
    wasteCapacity_mL: 3000000,  // 3 000 L; method total is ~1.48e6 mL

    mixerOptions_mL: [600, 1500, 3000],
    loopOptions_mL: [250, 1000, 5000],
    fracValvePorts: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'],
    alarmThresholdOverrides: {},
    tankSet: TANKS_PROCESS,

    column: {
      id_cm: 45.0,
      L_cm: 20.0,
      defaultResinId: 'PrepSP-90HF',
      defaultFlow_cmh: 150,
      hardwarePressureLimit_bar: 3.0,
      rFrit_bar_per_cms: 0.00154,
      foulingFactor: 1.0,
      channellingFactor: 0.0,
      nz: 400,
    },

    skid: {
      gradientMode: 'LPGF',
      chopPeriod_s: 2.0,
      tMinOpen_s: 0.040,
      mixerVolume_mL: 1500,
      mixerN: 1,
      airTrap: true,
      inlineFilter: true,
      estopRamp_s: 1.0,
      rippleFlow_frac: 0.015,
      ripplePress_frac: 0.03,
      QswitchMax_frac: 0.10,
      ambientT_C: 25.0,
      fluidTau_s: 1800,
      bubbleSensorThreshold_frac: 0.02,
      uv: {
        pathlength_cm: 0.02, strayLight: 3.0e-3, channels_nm: [280, 260, 300],
        tau_s: 4.0, noiseWhite_AU: 8e-5, noisePink_AU: 2.5e-4,
        driftWarm_AU_s: 2.78e-7, driftStart_AU: 0.025, driftTau_s: 400,
        foulPerCycle_AU: 2e-4, kRI_AU_per_mScm_s: 1.5e-3,
        overrange_AU: 2.00, saturated_AU: 2.40, dilutionRatio: 1.0,
        airSpike_AU: 3.0,
      },
      cond: {
        Kcell_cm1: 5.0, tau_s: 2.0, noiseAbs_mScm: 0.005, noiseRel: 5e-4,
        noisePinkRel: 2e-4, driftRel_s: 2.78e-7, foulPerCycle: -0.003,
        ptTau_s: 120, dryThreshold_frac: 0.5,
      },
      ph: {
        tau_s: 15.0, tauAsymRising: 1.6, tauElec_s: 3.0, noise_pH: 0.003,
        drift_pH_s: 5.56e-6, slopePct: 99.0, offset_mV: 0.0,
        slopeDecayPerCycle: 0.4, offsetDecayPerCycle: 0.3,
        freezeAir_frac: 0.30,
      },
      press: {
        P1FS_bar: 6.0, P2FS_bar: 6.0, accuracyFS: 0.005, noiseFS: 0.002,
        tauDisp_s: 0.5, tauAlarm_s: 0.2,
      },
      filter: { R0_bar_per_mLs: 1.97e-4, kFoul_per_mg: 1.0e-6 },
      fracValve: { overflowTo: 'WASTE', portCapacity_mL: 25000 },
    },
  },
};

/* =================================================================================================
 * RESINS
 *
 * `Lambda_mmolPerMLbed` is the VENDOR basis — **mmol of ionic groups per mL of PACKED BED**
 * (i.e. per mL of column volume), which is how every resin datasheet states it. `normalizePreset`
 * converts once, per §1.2:
 *
 *     Lambda_mM = Lambda_mmolPerMLbed * 1000 / (1 - epsC)          [BASIS N1, per BEAD volume]
 *
 * Verified: `0.2275 * 1000 / 0.65 = 350.0000` exactly. **0.22 gives 338.46 and is wrong** — that
 * number does not appear anywhere in this program (§11 C-05).
 *
 * `maxCycles` is the manufacturer's validated cycle life. `run.cycleIndex` (incremented by
 * `skid/engine.js` on every completed CIP block) is compared against it by the System view to
 * report `RETIRE`; the same counter drives `uv.foulPerCycle_AU`, `cond.foulPerCycle` and the pH
 * electrode's `slopeDecayPerCycle` / `offsetDecayPerCycle`.
 * ===============================================================================================*/

/**
 * @typedef {Object} ResinDef
 * @property {string} id
 * @property {string} name
 * @property {string} chemistry            Free text for the System card.
 * @property {'SMA'|'LANGMUIR'|'HIC'|'SEC'|'LINEAR'|'INERT'} isothermMode  Default for this resin.
 * @property {-1|0|1} resinChargeSign      −1 CEX, +1 AEX, 0 non-ionic. Drives `donnanRole` (§5.8.3).
 * @property {number} dp_cm                Volume-surface mean particle diameter, cm.
 * @property {number} epsC                 Interstitial (extra-particle) porosity.
 * @property {number} epsP                 Nominal intraparticle porosity. Per-species `epsPi` is
 *                                         clamped to `[0, epsP]` at ingest.
 * @property {number} rPore_cm             Mean pore radius, cm.
 * @property {number} Lambda_mmolPerMLbed  Ionic capacity, mmol per mL of PACKED BED (vendor basis).
 * @property {number} kKozeny              Blake–Kozeny constant.
 * @property {number} lambdaPack           van Deemter A-term packing factor: `A = 2*lambdaPack*dp`.
 * @property {number} gammaObstruction     van Deemter B-term obstruction factor: `B = 2*gamma*Dm`.
 * @property {{eps0:number, epsMin:number, Pc_bar:number}} compression  §7.1.3 fixed point.
 * @property {number} maxCycles            Validated cycle life (CIP cycles).
 * @property {number} enableDonnan         1 = evaluate the §7.2.4 Donnan group sums, 0 = skip.
 * @property {string} notes
 */

/** @type {{[id:string]: ResinDef}} */
export const RESINS = {
  'PrepSP-90HF': {
    id: 'PrepSP-90HF',
    name: 'PrepSP-90 HF',
    chemistry: 'Sulfopropyl (strong cation exchanger) on 6 % cross-linked agarose',
    isothermMode: 'SMA',
    resinChargeSign: -1,
    dp_cm: 9.0e-3,             // 90 um
    epsC: 0.35,
    epsP: 0.85,
    rPore_cm: 3.0e-6,          // 30 nm
    Lambda_mmolPerMLbed: 0.2275,  // -> 350.0000 mM on the bead basis
    kKozeny: 180,
    lambdaPack: 1.0,
    gammaObstruction: 0.7,
    compression: { eps0: 0.35, epsMin: 0.26, Pc_bar: 2.0 },
    maxCycles: 100,
    enableDonnan: 1,
    notes: 'The shipped default. High-flow capture/intermediate SP agarose; epsT = 0.9025.',
  },

  'PrepSP-45HF': {
    id: 'PrepSP-45HF',
    name: 'PrepSP-45 HF',
    chemistry: 'Sulfopropyl on 6 % cross-linked agarose, small-bead grade',
    isothermMode: 'SMA',
    resinChargeSign: -1,
    dp_cm: 4.5e-3,             // 45 um
    epsC: 0.35,
    epsP: 0.85,
    rPore_cm: 3.0e-6,
    Lambda_mmolPerMLbed: 0.2275,
    kKozeny: 180,
    lambdaPack: 1.0,
    gammaObstruction: 0.7,
    compression: { eps0: 0.35, epsMin: 0.26, Pc_bar: 1.6 },
    maxCycles: 100,
    enableDonnan: 1,
    notes: 'Same chemistry as PrepSP-90HF on half the bead. 4x the mass-transfer rate (NaCl k_ov '
      + '8.408 vs 2.2326 1/s, §7.3.4) and 4x the pressure drop; the teaching case for the '
      + 'efficiency/backpressure trade.',
  },

  'PrepQ-90HF': {
    id: 'PrepQ-90HF',
    name: 'PrepQ-90 HF',
    chemistry: 'Quaternary ammonium (strong anion exchanger) on 6 % cross-linked agarose',
    isothermMode: 'SMA',
    resinChargeSign: +1,
    dp_cm: 9.0e-3,
    epsC: 0.35,
    epsP: 0.85,
    rPore_cm: 3.0e-6,
    Lambda_mmolPerMLbed: 0.2470,  // -> 380.0000 mM on the bead basis
    kKozeny: 180,
    lambdaPack: 1.0,
    gammaObstruction: 0.7,
    compression: { eps0: 0.35, epsMin: 0.26, Pc_bar: 2.0 },
    maxCycles: 100,
    enableDonnan: 1,
    notes: 'The AEX overlay. resinChargeSign flips, so Na becomes the CO-ion and Cl the '
      + 'COUNTER-ion with no change to any species entry — that is exactly why donnanRole is '
      + 'derived from charge*resinChargeSign and not authored.',
  },

  'PrepPhenyl-90': {
    id: 'PrepPhenyl-90',
    name: 'PrepPhenyl-90',
    chemistry: 'Phenyl-substituted 6 % agarose (hydrophobic interaction)',
    isothermMode: 'HIC',
    resinChargeSign: 0,
    dp_cm: 9.0e-3,
    epsC: 0.35,
    epsP: 0.85,
    rPore_cm: 3.0e-6,
    Lambda_mmolPerMLbed: 0,    // non-ionic: no fixed charge, hence no Donnan
    kKozeny: 180,
    lambdaPack: 1.0,
    gammaObstruction: 0.7,
    compression: { eps0: 0.35, epsMin: 0.27, Pc_bar: 2.2 },
    maxCycles: 80,
    enableDonnan: 0,
    notes: 'Descending-salt aggregate removal. Modulated competitive Langmuir with beta > 0: '
      + 'b_i(cs) = b0_i * exp(beta_i * cs), so there is no shielded-counterion balance and no '
      + 'Newton iteration.',
  },

  'PrepSEC-200': {
    id: 'PrepSEC-200',
    name: 'PrepSEC-200',
    chemistry: 'Cross-linked agarose/dextran composite, Superdex-200-class selectivity',
    isothermMode: 'SEC',
    resinChargeSign: 0,
    dp_cm: 3.4e-3,             // 34 um
    epsC: 0.35,
    epsP: 0.95,                // must be >= the largest authored epsPi (salt marker, 0.95)
    rPore_cm: 1.5e-6,          // 15 nm
    Lambda_mmolPerMLbed: 0,
    kKozeny: 180,
    lambdaPack: 1.0,
    gammaObstruction: 0.7,
    compression: { eps0: 0.35, epsMin: 0.30, Pc_bar: 1.0 },  // soft medium, low Pc
    maxCycles: 150,
    enableDonnan: 0,
    notes: 'Retention is per-species epsPi and nothing else: q* = epsPi * c. On a 1.6 x 60 cm bed '
      + 'at 30 cm/h the Blake-Kozeny drop is 0.786 bar, which is why prep SEC always runs slow.',
  },

  'ProtA-85': {
    id: 'ProtA-85',
    name: 'ProtA-85',
    chemistry: 'Recombinant protein A ligand on rigid agarose',
    isothermMode: 'LANGMUIR',
    resinChargeSign: 0,
    dp_cm: 8.5e-3,             // 85 um
    epsC: 0.35,
    epsP: 0.80,
    rPore_cm: 4.0e-6,          // 40 nm
    Lambda_mmolPerMLbed: 0,
    kKozeny: 180,
    lambdaPack: 1.0,
    gammaObstruction: 0.7,
    compression: { eps0: 0.35, epsMin: 0.28, Pc_bar: 2.5 },
    maxCycles: 200,
    enableDonnan: 0,
    notes: 'Affinity capture; elution is by pH, not by salt, so the modulator term is unused and '
      + 'beta_Lmol is 0 for every species on this resin. 200 validated cycles is the usual '
      + 'protein-A economics driver.',
  },
};

/* =================================================================================================
 * SPECIES — 15 entries, authored in HUMAN units (`SpeciesConfigHuman`).
 *
 * The 10 that make up the shipped pilot registry, in the §2.1 `idxById` order (which is the
 * normative inert -> donnan -> binding sort, re-derived at ingest so authoring order never leaks):
 *
 *   inert    tracer(0)  EtOH(1)  OHex(2)
 *   donnan   Na(3)      Cl(4)    AcT(5)
 *   binding  WKI(6)     mAb(7)   AGG(8)    SBI(9)
 *
 * The other five are the library entries the HIC, SEC and AEX configurations draw on:
 *   WHI, HHI (HIC impurities) · FAB, BDex (SEC fragment and void marker) · DNA (AEX clearance).
 *
 * `Dm_cm2s` / `Dp_cm2s` for the four pilot proteins, for NaCl and for the acetone tracer are the
 * §7.3.4 values, and they reproduce that table's `k_ov` to five figures at 150 cm/h, dp = 90 um,
 * mu = 1.002 cP, T = 20 C:
 *   WKI 0.20418 (11.9 % film) · mAb 0.03008 (3.3 %) · AGG 0.0078165 (1.1 %) · SBI 0.06240 (4.0 %)
 *   NaCl 2.2326 (23.9 %) · acetone 3.1580 (34.7 %)
 * Do not "improve" any of them: the §8.1 predicted widths, apex heights and resolution bands are
 * evaluated at exactly these numbers.
 *
 * One entry serves every isotherm mode. `nu/sigma/Keq` (SMA), `qmax_gLbead/b0_Lmol/beta_Lmol`
 * (Langmuir & HIC) and `Klin` (LINEAR) all coexist on a single row because §5.8.1 reads only the
 * fields for `column.isothermMode`. The mAb row therefore carries its CEX SMA constants AND its
 * HIC Langmuir constants at once, which is what lets `cex-capture-igg1-pilot` and `hic-polish-agg`
 * share a library.
 *
 * Presets may override any field (the SEC preset re-authors `epsPi` for its own pore-size
 * distribution: BDex 0.00, AGG 0.26, mAb 0.40, FAB 0.68, salt 0.95). The values here are the
 * 90 um agarose defaults.
 * ===============================================================================================*/

/** @type {{[id:string]: SpeciesConfigHuman}} */
export const SPECIES = {
  // ---- INERT ---------------------------------------------------------------------------------
  tracer: {
    id: 'tracer',
    name: 'Acetone tracer',
    role: 'tracer',
    MW_gmol: 58.08,
    transported: true,
    kind: 'inert',
    donnanRole: null,
    epsPi: 0.85,
    Dm_cm2s: 1.28e-5,
    Dp_cm2s: 7.68e-6,
    keffScale: 1.0,
    concScale_mM: 1.0,
    nu: 0, sigma: 0, Keq: 0,
    qmax_gLbead: 0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0.30, eps260_Lgcm: 0.55, eps300_Lgcm: 0.05,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'Unretained marker for PACKING_TEST and for the epsT = 0.9025 retention identity. It '
      + 'MUST absorb at 280 nm or the §7.6 packing analysis has no peak to integrate; 0.30 L/g/cm '
      + 'is the acetone value used by the SEC preset.',
  },

  EtOH: {
    id: 'EtOH',
    name: 'Ethanol',
    role: 'organic',
    MW_gmol: 46.07,
    transported: true,
    kind: 'inert',
    donnanRole: null,
    epsPi: 0.85,
    Dm_cm2s: 1.20e-5,
    Dp_cm2s: 7.20e-6,
    keffScale: 1.0,
    concScale_mM: 1000,
    nu: 0, sigma: 0, Keq: 0,
    qmax_gLbead: 0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0, eps260_Lgcm: 0, eps300_Lgcm: 0,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'Storage / sanitisation solvent. Its only live effect is on viscosity through '
      + 'solution.fOrganic (20 % v/v is a factor of 1.75) and on conductivity through the '
      + 'max(0.05, 1 - 1.4*f_org) suppression term.',
  },

  OHex: {
    id: 'OHex',
    name: 'Hydroxide excess (strong base)',
    role: 'baseExcess',
    MW_gmol: 17.007,
    transported: true,
    kind: 'inert',
    donnanRole: null,
    epsPi: 0.85,
    Dm_cm2s: 5.27e-5,
    Dp_cm2s: 1.84e-5,
    keffScale: 1.0,
    concScale_mM: 100,
    nu: 0, sigma: 0, Keq: 0,
    qmax_gLbead: 0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0, eps260_Lgcm: 0, eps300_Lgcm: 0,
    charge: -1,
    lambda0_Scm2eq: 198.0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'Carries the CIP strong-base excess. Its lambda0 of 198.0 is what makes 0.5 M NaOH read '
      + '~100 mS/cm; its charge feeds ionic strength and the pH solve. It is kind:inert rather '
      + 'than donnan on purpose — the column does no chromatography during a CIP block, and '
      + 'putting it in the Donnan group sums would let a NaOH front distort the pore charge '
      + 'balance for no pedagogical gain.',
  },

  // ---- DONNAN --------------------------------------------------------------------------------
  Na: {
    id: 'Na',
    name: 'Sodium',
    role: 'ion',
    MW_gmol: 22.99,
    transported: true,
    kind: 'donnan',
    donnanRole: null,          // -> COUNTER on CEX, CO on AEX (§5.8.3)
    epsPi: 0.85,
    Dm_cm2s: 1.33e-5,
    Dp_cm2s: 4.66e-6,
    keffScale: 1.0,
    concScale_mM: 100,
    nu: 0, sigma: 0, Keq: 0,
    qmax_gLbead: 0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0, eps260_Lgcm: 0, eps300_Lgcm: 0,
    charge: +1,
    lambda0_Scm2eq: 50.1,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'THE MODULATOR on every IEX preset (config.column.modulatorIdx). Dm/Dp are the '
      + 'AMBIPOLAR NaCl pair from §7.3.4, applied to both ions: a salt diffuses as an '
      + 'electroneutral unit, so giving Na and Cl their individual tracer diffusivities would '
      + 'model a charge separation that electroneutrality forbids.',
  },

  Cl: {
    id: 'Cl',
    name: 'Chloride',
    role: 'ion',
    MW_gmol: 35.45,
    transported: true,
    kind: 'donnan',
    donnanRole: null,          // -> CO on CEX, COUNTER on AEX (§5.8.3)
    epsPi: 0.85,
    Dm_cm2s: 1.33e-5,
    Dp_cm2s: 4.66e-6,
    keffScale: 1.0,
    concScale_mM: 100,
    nu: 0, sigma: 0, Keq: 0,
    qmax_gLbead: 0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0, eps260_Lgcm: 0, eps300_Lgcm: 0,
    charge: -1,
    lambda0_Scm2eq: 76.3,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'Ambipolar with Na — see that entry.',
  },

  AcT: {
    id: 'AcT',
    name: 'Acetate (total)',
    role: 'buffer',
    MW_gmol: 59.04,
    transported: true,
    kind: 'donnan',
    donnanRole: null,          // charge -1 derives CO on CEX and COUNTER on AEX, both correct
    epsPi: 0.85,
    Dm_cm2s: 1.09e-5,
    Dp_cm2s: 3.82e-6,
    keffScale: 1.0,
    concScale_mM: 10,
    nu: 0, sigma: 0, Keq: 0,
    qmax_gLbead: 0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0, eps260_Lgcm: 0, eps300_Lgcm: 0,
    charge: -1,                // the charge of the IONISED form, per §5.8.1
    lambda0_Scm2eq: 40.9,
    bufferPkas: [4.76], bufferZ0: 0, bufferDpKadT: 0.0002,
    notes: 'A buffer TOTAL, not a single ion. `charge` is the ionised form (-1) and ingest pairs '
      + 'it with the DERIVED ionisedFraction: at pH 5.00 with pKa\' 4.5892 that is '
      + '1/(1+10^(4.5892-5.00)) = 0.72028, so 50 mM AcT contributes 36.014 mM of co-ion '
      + 'equivalent to the §7.2.4 group sums. Treating it as fully ionised puts Buffer A 28 % out '
      + 'of charge balance (§11 C-03).',
  },

  // ---- BINDING -------------------------------------------------------------------------------
  WKI: {
    id: 'WKI',
    name: 'Weakly bound impurity (lumped HCP)',
    role: 'impurity',
    MW_gmol: 25000,
    transported: true,
    kind: 'binding',
    donnanRole: null,
    epsPi: 0.85,
    Dm_cm2s: 1.05e-6,
    Dp_cm2s: 3.68e-7,
    keffScale: 1.0,
    concScale_mM: 0.02,
    nu: 3.5, sigma: 69, Keq: 0.018,
    qmax_gLbead: 120.7, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0.95, eps260_Lgcm: 0.62, eps300_Lgcm: 0.030,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'sigma is derived from the target capacity, not fitted: q_max = Lambda/(nu+sigma), '
      + '120.7 g/L bead -> nu+sigma = 72.5 -> sigma = 69. Elutes at cs_R = 99.88 mM, 3.119 CV '
      + 'after gradient start. Its isocratic V_R at 50 mM is 11.5 CV, so lengthening the wash '
      + 'from 5 CV to 12 CV removes its gradient peak entirely — a deliberate, discoverable '
      + 'behaviour.',
  },

  mAb: {
    id: 'mAb',
    name: 'IgG1 monoclonal antibody (monomer)',
    role: 'product',
    MW_gmol: 148000,
    transported: true,
    kind: 'binding',
    donnanRole: null,
    epsPi: 0.70,
    Dm_cm2s: 4.00e-7,
    Dp_cm2s: 6.00e-8,
    keffScale: 1.0,
    concScale_mM: 0.05,
    nu: 5.2, sigma: 575, Keq: 0.044,
    qmax_gLbead: 40.0, b0_Lmol: 50, beta_Lmol: 8.0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 1.42, eps260_Lgcm: 0.76, eps300_Lgcm: 0.048,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'THE PRODUCT. pI 8.7, so at pH 5.00 it is strongly positive and binds SP. '
      + 'epsPi = 0.70 is authored, NOT derived from the resin epsP: using 0.85 gives k_ov 0.0363 '
      + 'instead of 0.03008 (+21 %) and moves every predicted width (§6.8, §7.3.4). '
      + 'SMA q_max = Lambda/(nu+sigma) = 0.60324 mM bead = 89.28 g/L bead = 58.03 g/L CV. '
      + 'The qmax_gLbead/b0_Lmol/beta_Lmol trio is the HIC parameter set and is read only when '
      + 'column.isothermMode is LANGMUIR or HIC. eps260 = 0.76 gives A280/A260 = 1.87, the value '
      + 'a pure protein must show.',
  },

  AGG: {
    id: 'AGG',
    name: 'IgG1 dimer / aggregate',
    role: 'aggregate',
    MW_gmol: 296000,
    transported: true,
    kind: 'binding',
    donnanRole: null,
    epsPi: 0.45,
    Dm_cm2s: 2.96e-7,
    Dp_cm2s: 2.37e-8,
    keffScale: 1.0,
    concScale_mM: 0.002,
    nu: 7.0, sigma: 1473, Keq: 0.0415,
    qmax_gLbead: 25.0, b0_Lmol: 400, beta_Lmol: 8.0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 1.48, eps260_Lgcm: 0.84, eps300_Lgcm: 0.103,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'Extinction is DELIBERATELY higher than the monomer at every wavelength because '
      + 'aggregates scatter: A300/A280 = 0.103/1.48 = 0.070 for aggregate vs 0.048/1.42 = 0.034 '
      + 'for monomer, which is the simulator\'s working turbidity diagnostic. Elutes 1.390 CV '
      + 'after the mAb at Rs = 0.37 — a shoulder buried under the product, which is the correct '
      + 'and pedagogically valuable answer (§8.1).',
  },

  SBI: {
    id: 'SBI',
    name: 'Strongly bound basic charge variant',
    role: 'impurity',
    MW_gmol: 148000,
    transported: true,
    kind: 'binding',
    donnanRole: null,
    epsPi: 0.68,
    Dm_cm2s: 9.20e-7,
    Dp_cm2s: 1.29e-7,
    keffScale: 1.0,
    concScale_mM: 0.002,
    nu: 9.0, sigma: 638, Keq: 1.33,
    qmax_gLbead: 80.1, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 1.42, eps260_Lgcm: 0.76, eps300_Lgcm: 0.048,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'A LUMPED SURROGATE. Its Dm/Dp are the §7.3.4 fitted pair that reproduces k_ov = '
      + '0.06240 1/s, and they are deliberately faster than the mAb\'s despite the identical '
      + 'nominal MW — the entry stands in for a family of basic variants, not for one 148 kDa '
      + 'molecule, and §8.1\'s 0.57 CV width and Rs = 1.64 against AGG are evaluated at exactly '
      + 'these values.',
  },

  WHI: {
    id: 'WHI',
    name: 'Weakly hydrophobic impurity',
    role: 'impurity',
    MW_gmol: 45000,
    transported: true,
    kind: 'binding',
    donnanRole: null,
    epsPi: 0.80,
    Dm_cm2s: 7.70e-7,
    Dp_cm2s: 1.05e-7,
    keffScale: 1.0,
    concScale_mM: 0.005,
    nu: 2.5, sigma: 60, Keq: 0.004,
    qmax_gLbead: 90.0, b0_Lmol: 2.0, beta_Lmol: 8.0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 1.10, eps260_Lgcm: 0.72, eps300_Lgcm: 0.035,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'HIC preset. Elutes FIRST on a descending salt gradient (cs_R = 829 mM) because it is '
      + 'the least hydrophobic. Dp is set so k_ov comes out at 0.047 1/s once the 1.2 M ammonium '
      + 'sulfate viscosity correction (Dm x 1.002/1.272 = 0.7877) is applied. Its SMA constants '
      + 'are plausible CEX values carried so the entry is usable outside HIC; no shipped preset '
      + 'reads them.',
  },

  HHI: {
    id: 'HHI',
    name: 'Hydrophobic host-cell protein',
    role: 'impurity',
    MW_gmol: 30000,
    transported: true,
    kind: 'binding',
    donnanRole: null,
    epsPi: 0.84,
    Dm_cm2s: 8.80e-7,
    Dp_cm2s: 3.33e-7,
    keffScale: 1.0,
    concScale_mM: 0.005,
    nu: 3.0, sigma: 80, Keq: 0.006,
    qmax_gLbead: 100.0, b0_Lmol: 800, beta_Lmol: 8.0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0.85, eps260_Lgcm: 0.60, eps300_Lgcm: 0.025,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'HIC preset, the most hydrophobic species: b0 = 800 L/mol puts cs_R at 23 mM, i.e. it '
      + 'does not come off until the 0 M hold. That is the correct HIC behaviour and it is what '
      + 'makes the strip block meaningful.',
  },

  FAB: {
    id: 'FAB',
    name: 'Fab fragment / half-mer',
    role: 'impurity',
    MW_gmol: 50000,
    transported: true,
    kind: 'binding',
    donnanRole: null,
    epsPi: 0.68,
    Dm_cm2s: 7.40e-7,
    Dp_cm2s: 1.85e-7,
    keffScale: 1.0,
    concScale_mM: 0.01,
    nu: 3.0, sigma: 250, Keq: 0.008,
    qmax_gLbead: 60.0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 1.38, eps260_Lgcm: 0.74, eps300_Lgcm: 0.046,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'SEC preset, the low-molecular-weight peak. On PrepSEC-200 the preset re-authors '
      + 'epsPi to 0.68, giving epsT = 0.7920 and V_R = 0.792 CV — the third point on the '
      + 'log10(MW) vs Kav calibration line.',
  },

  BDex: {
    id: 'BDex',
    name: 'Blue dextran void marker',
    role: 'tracer',
    MW_gmol: 2000000,
    transported: true,
    kind: 'inert',
    donnanRole: null,
    epsPi: 0.02,
    Dm_cm2s: 2.00e-7,
    Dp_cm2s: 8.00e-8,
    keffScale: 1.0,
    concScale_mM: 0.001,
    nu: 0, sigma: 0, Keq: 0,
    qmax_gLbead: 0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 0.30, eps260_Lgcm: 0.20, eps300_Lgcm: 0.25,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'Defines V_0 = epsC * V_col for the SEC Kav calibration. epsPi is 0.02 rather than a '
      + 'literal 0 so the pore term rp^2/(15*epsPi*Dpore) stays finite; the resulting k_ov is '
      + '~1.2e-3 1/s, legitimately BELOW the §7.3.4 acceptance band of [0.005, 15] because that '
      + 'band describes the six shipped rows of a pore-accessible species, not a size-excluded '
      + 'marker. Nothing enters the bead, so the coefficient is physically meaningless and only '
      + 'the [1e-6, 1e4] clamp applies.',
  },

  DNA: {
    id: 'DNA',
    name: 'Residual host-cell DNA',
    role: 'impurity',
    MW_gmol: 2000000,
    transported: true,
    kind: 'binding',
    donnanRole: null,
    epsPi: 0.25,
    Dm_cm2s: 1.30e-7,
    Dp_cm2s: 6.00e-8,
    keffScale: 1.0,
    concScale_mM: 1.0e-6,
    nu: 22, sigma: 200, Keq: 8000,
    qmax_gLbead: 5.0, b0_Lmol: 0, beta_Lmol: 0, csRef_molL: 0,
    Klin: 0,
    eps280_Lgcm: 10.0, eps260_Lgcm: 20.0, eps300_Lgcm: 2.0,
    charge: 0,
    lambda0_Scm2eq: 0,
    bufferPkas: null, bufferZ0: 0, bufferDpKadT: 0,
    notes: 'AEX clearance species, and the reason eps260 is a first-class parameter: its '
      + 'A260/A280 of 2.0 is dramatically different from the product\'s 0.54, which is exactly '
      + 'how the ratio trace is read on a real skid. The metric is log reduction, not resolution. '
      + 'At nu = 22 the SMA partition saturates the KT_MAX = 1e6 clamp below ~100 mM salt; that '
      + 'is the documented clamp behaviour (§6.7) and not a defect. epsPi 0.25 / Dp 6.0e-8 are '
      + 'chosen so k_ov = 0.0108 1/s and Dp/Dm = 0.46 both sit inside §7.3.4\'s sanity bands.',
  },
};

/* =================================================================================================
 * LOOKUPS — the only three functions in this file.
 * ===============================================================================================*/

/**
 * Look up a skid scale by id.
 *
 * @param {'LAB'|'PILOT'|'PROCESS'} id  Scale id, case-sensitive.
 * @returns {object} The `SCALES[id]` entry (see `SCALES` for the field list and the units of each).
 *                   The returned object is the shared table entry, not a copy: treat it as
 *                   read-only, exactly as `config` is (§2.3).
 * @throws {Error} If `id` is not one of the three scales. Failing loudly at ingest is deliberate —
 *                 returning `undefined` would propagate `NaN` into every derived hold-up.
 */
export function getScale(id) {
  const s = SCALES[id];
  if (!s) {
    throw new Error(`library.getScale: unknown scale '${id}'. Known: ${Object.keys(SCALES).join(', ')}`);
  }
  return s;
}

/**
 * Look up a resin by id.
 *
 * @param {string} id  Resin id, e.g. `'PrepSP-90HF'`.
 * @returns {ResinDef} The `RESINS[id]` entry. `Lambda_mmolPerMLbed` is per mL of PACKED BED and
 *                     must be converted with `Lambda_mM = Lambda_mmolPerMLbed * 1000 / (1 - epsC)`
 *                     before any physics module sees it (§1.2, BASIS N1).
 * @throws {Error} If `id` is unknown.
 */
export function getResin(id) {
  const r = RESINS[id];
  if (!r) {
    throw new Error(`library.getResin: unknown resin '${id}'. Known: ${Object.keys(RESINS).join(', ')}`);
  }
  return r;
}

/**
 * Look up a species by id.
 *
 * @param {string} id  Species registry id, e.g. `'mAb'`.
 * @returns {SpeciesConfigHuman} The `SPECIES[id]` entry, in AUTHORED HUMAN UNITS. It is **not** a
 *                               `SpeciesConfig`: `qmax_gLbead`, `b0_Lmol`, `beta_Lmol` and
 *                               `csRef_molL` still need the conversion documented on the
 *                               `SpeciesConfigHuman` typedef, and `KD`, `ionisedFraction` and a
 *                               null `donnanRole` are not resolved yet. Only
 *                               `presets.normalizePreset` may consume this directly.
 * @throws {Error} If `id` is unknown.
 */
export function getSpecies(id) {
  const s = SPECIES[id];
  if (!s) {
    throw new Error(`library.getSpecies: unknown species '${id}'. Known: ${Object.keys(SPECIES).join(', ')}`);
  }
  return s;
}
