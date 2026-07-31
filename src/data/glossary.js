/**
 * @file src/data/glossary.js — the glossary content behind every info popover
 *                             (architecture-v2 §6.22.1, §9.6).
 *
 * LAYER: a zero-import data leaf beside `data/library.js`. **No imports at all**, no DOM, no state.
 * Read only by `src/ui/*`.
 *
 * §9.6 promises that "every tag and parameter label carries an `ⓘ` opening a popover with *what it
 * is* (one sentence), *units and typical range*, *why it matters*, and *what abnormal looks like*".
 * That promise is a contract on THIS FILE: **an entry is required before a label may render an
 * `ⓘ`.** If you add a P&ID tag or a numeric field to the Method or System view, add its entry here
 * in the same commit.
 *
 * It lives in `data/` and not in `ui/format.js` because `format.js` is a ~260-line display boundary
 * that every UI module imports; bundling ~350 lines of prose into it would make the most-imported
 * file in the UI layer the largest one.
 *
 * ENTRY SHAPE — all five fields are required and none may be empty:
 * ```
 * { term:    string,    // the display heading; the spelled-out name, not the id
 *   short:   string,    // WHAT IT IS. One sentence. No hedging, no "basically".
 *   why:     string,    // WHY IT MATTERS on a real skid, and what abnormal looks like.
 *   typical: string,    // UNITS and TYPICAL RANGE. Always leads with the unit.
 *   seeAlso: string[] } // ids of related entries; every id here must resolve.
 * ```
 *
 * IDS come in three flavours and the UI may pass any of them to `glossaryFor`:
 *   - **P&ID tags**, verbatim as they are drawn: `'UV-101'`, `'PT-101'`, `'TK-EQ'`.
 *   - **Config paths**, dot-separated: `'column.epsC'`, `'skid.uv.pathlength_cm'`.
 *   - **Concepts**, kebab-case: `'hetp'`, `'donnan'`, `'delay-volume'`.
 * Lookup is exact first, then through `ALIASES`, then case-insensitively. Nothing is parsed and
 * nothing is allocated per call beyond the miss path's `toLowerCase()`.
 */

/**
 * @typedef {Object} GlossaryEntry
 * @property {string}   term     Display heading.
 * @property {string}   short    What it is, in one sentence.
 * @property {string}   why      Why it matters, and what abnormal looks like.
 * @property {string}   typical  Units and typical range.
 * @property {string[]} seeAlso  Related entry ids.
 */

/** @type {{[id:string]: GlossaryEntry}} */
export const GLOSSARY = {

  /* ===========================================================================================
   * P&ID INSTRUMENT TAGS
   * =========================================================================================*/

  'FT-101': {
    term: 'FT-101 — Flow transmitter',
    short: 'Measures the volumetric flow leaving the pump head, which is the flow every totaliser integrates.',
    why: 'The method is written in column volumes, and a CV is only a CV if the flow reading is right. All volume counting uses the ACTUAL flow, not the setpoint, so a block specified in CV still delivers exactly its CV during a ramp or a pressure-driven flow reduction. A reading that lags the setpoint by more than a few seconds means the pump is ramping, cavitating or pressure-limited.',
    typical: 'mL/min (also shown as cm/h, CV/h and residence time). Pilot nominal 196 mL/min = 150 cm/h; envelope 5–1000 mL/min.',
    seeAlso: ['flow-rate', 'linear-velocity', 'residence-time', 'P-101', 'flow-reduction'],
  },

  'PT-101': {
    term: 'PT-101 — Pre-column pressure',
    short: 'Gauge pressure at the column inlet, upstream of the bed.',
    why: 'This is the number that protects the column hardware and the bed. It is the sum of everything downstream: bed drop, frits and distributors, inline filter, and the post-column line. A slow climb over cycles means fouling; a step change means a blockage or a valve in the wrong position.',
    typical: 'bar gauge. Pilot nominal ~0.29 bar at 150 cm/h; warn 1.60, trip 2.20; hardware rating 4.0.',
    seeAlso: ['PT-102', 'PDT-101', 'pressure-drop', 'column.hardwarePressureLimit_bar', 'fouling'],
  },

  'PT-102': {
    term: 'PT-102 — Post-column pressure',
    short: 'Gauge pressure at the column outlet, i.e. everything the detector train and fraction valve cost.',
    why: 'Subtracting it from PT-101 isolates the bed. Without it you cannot tell a fouled bed (ΔP rises, PT-102 flat) from a blocked outlet line (both rise together). It is also the reason a column ΔP alarm is meaningful at all.',
    typical: 'bar gauge. ~0.088 bar at nominal flow at every scale, by design.',
    seeAlso: ['PT-101', 'PDT-101', 'skid.press.Rdown_bar_per_mLs'],
  },

  'PDT-101': {
    term: 'PDT-101 — Column differential pressure (ΔP)',
    short: 'PT-101 minus PT-102: the pressure drop across the packed bed and its hardware alone.',
    why: 'The single best indicator of bed health. It rises with flow, with viscosity (cold buffer, high salt, ethanol) and with fouling, and it rises faster than linearly once the bed starts to compress. A ΔP that keeps climbing at constant flow and temperature is the signature of a fouling or collapsing bed.',
    typical: 'bar. Pilot 0.20 bar at 150 cm/h; warn 0.60, alarm 0.80, trip 1.00.',
    seeAlso: ['pressure-drop', 'blake-kozeny', 'bed-compression', 'bed-collapse', 'fouling'],
  },

  'UV-101': {
    term: 'UV-101 — UV absorbance monitor',
    short: 'Three-wavelength flow-cell photometer (280 / 260 / 300 nm) that sees protein passing the outlet.',
    why: 'Every pooling decision starts here. It is also the instrument most likely to lie to you: it saturates on concentrated product, drifts as the lamp warms, spikes on air bubbles, and sits a real hold-up volume upstream of the fraction valve. The 300 nm channel exists to stay on scale when 280 nm does not.',
    typical: 'mAU (or AU/cm once the pathlength is divided out). Over-range 2.00 AU, saturated 2.40 AU. Pilot mAb apex ~241 mAU at a 0.2 mm cell.',
    seeAlso: ['beer-lambert', 'pathlength', 'stray-light', 'autozero', 'uv-ratio', 'delay-volume'],
  },

  'CE-101': {
    term: 'CE-101 — Conductivity cell',
    short: 'Two- or four-electrode cell reading the ionic content of the stream, temperature-compensated to 25 °C.',
    why: 'It is the only direct view of the gradient actually reaching the column, and the standard way to confirm equilibration is complete. It reads nonsense when the cell has air in it, and its temperature compensation is deliberately imperfect — the meter corrects linearly while the physics is quadratic, so a cold stream reads high.',
    typical: 'mS/cm. Buffer A ~7.4, Buffer B ~44.5, 0.5 M NaOH ~100 mS/cm at 20 °C.',
    seeAlso: ['conductivity', 'temperature-compensation', 'modulator', 'TT-101', 'skid.cond.Kcell_cm1'],
  },

  'AE-101': {
    term: 'AE-101 — pH electrode',
    short: 'Glass combination electrode in a flow chamber downstream of the conductivity cell.',
    why: 'The slowest sensor on the skid and the only one that ages visibly. Its response time is seconds, it freezes entirely when air displaces the junction, and its slope degrades with every CIP cycle. A pH trace that no longer reaches the buffer pH is usually a dying electrode, not a dying buffer.',
    typical: 'pH units. Slope 92–100 % (below 92 % is degraded); response τ 3–15 s depending on scale.',
    seeAlso: ['ph', 'skid.ph.slopePct', 'davies', 'quality-flags', 'cip'],
  },

  'TT-101': {
    term: 'TT-101 — Temperature transmitter',
    short: 'Fluid temperature, plus the Pt1000 inside the conductivity cell that drives its compensation.',
    why: 'Temperature moves viscosity (and therefore pressure), diffusivity (and therefore peak width) and conductivity (about 2 % per °C). A cold-room run at 4 °C shows ~54 % more back-pressure than the same method at 20 °C, which is the most common cause of an unexpected over-pressure trip after a scale-up.',
    typical: '°C. Ambient 25; cold room 2–8; alarm outside 2–30, critical above 40.',
    seeAlso: ['viscosity', 'temperature-compensation', 'CE-101', 'skid.fluidTau_s'],
  },

  'P-101': {
    term: 'P-101 — System pump',
    short: 'Twin-piston reciprocating pump delivering the buffer blend to the column.',
    why: 'Two pistons out of phase mean the flow is not perfectly smooth: there is a residual ripple at twice the stroke frequency, visible on the pressure trace and invisible on UV because the detector filter removes it. Ramp rate matters — an instant flow change would shock the bed, so the pump is rate-limited.',
    typical: 'Stroke 0.10 / 5.0 / 60 mL by scale; ripple ±1.5 % on flow, ±3 % on pressure; ramp 5–20 % of Q_max per second.',
    seeAlso: ['ripple', 'skid.Vstroke_mL', 'skid.rampRate_mLs2', 'cavitation', 'dry-running'],
  },

  'P-102': {
    term: 'P-102 — Sample pump',
    short: 'Separate metering pump that draws feed from the sample tank during a LOAD block.',
    why: 'Loading through its own pump lets the load flow differ from the buffer flow, which is how load residence time is controlled independently. Its line hold-up is also why the last few mL of feed never reach the column unless a chase step is programmed.',
    typical: 'Same envelope as P-101. Sample line hold-up 1.8 / 45 / 750 mL by scale.',
    seeAlso: ['block.sample', 'load-challenge', 'holdup-volume', 'TK-FEED'],
  },

  'M-101': {
    term: 'M-101 — Inline mixer',
    short: 'A stirred or static chamber that averages the A/B blend before it reaches the column.',
    why: 'On a low-pressure gradient system the proportioning valve produces a square wave, and the mixer is the only thing turning it into a smooth gradient. Too small a mixer and the salt ripple shows up as a visible sawtooth on the conductivity trace; too large and the gradient is smeared and delayed.',
    typical: 'mL. Options 0.6/2/5 (lab), 50/100/250 (pilot), 600/1500/3000 (process). Residual ripple 0.4–5 %B.',
    seeAlso: ['lpgf', 'hpgf', 'proportioner', 'skid.mixerVolume_mL', 'skid.mixerN', 'tanks-in-series'],
  },

  'F-101': {
    term: 'F-101 — Inline filter',
    short: 'A guard filter between the mixer and the column that catches particulates before they reach the frit.',
    why: 'It protects the bed, and it fouls: its resistance grows with the mass of protein passed. A rising pre-column pressure with a flat column ΔP is the diagnostic signature of a fouled filter rather than a fouled bed — the two are routinely confused.',
    typical: 'Adds ~0.013 bar clean at nominal flow; roughly 1.55× that after a full load.',
    seeAlso: ['skid.filter.kFoul_per_mg', 'fouling', 'PT-101', 'PDT-101'],
  },

  'AT-101': {
    term: 'AT-101 — Air trap / bubble trap',
    short: 'A vessel with a gas headspace that catches bubbles before they reach the column or the detectors.',
    why: 'Air in a packed bed is very hard to remove and destroys the flow distribution. The trap buys time, but it fills: once its headspace is used up it passes gas downstream, which is why a "trap filling" warning is a call to purge, not a nuisance.',
    typical: 'mL. 0.20 / 50 / 800 by scale, or 0.05 mL when the trap is bypassed.',
    seeAlso: ['air-in-line', 'skid.bubbleSensorThreshold_frac', 'quality-flags'],
  },

  'IV-101': {
    term: 'IV-101 — Injection / sample valve',
    short: 'Six-port rotary valve selecting direct sample loading, loop filling, or loop injection.',
    why: 'Direct loading is how a capture step is run; a sample loop is how a reproducible small injection is made for a packing test or a SEC run. Loop volume sets the injection variance, which is part of the measured peak width and must be subtracted before quoting a plate count.',
    typical: 'Loop options 0.1–10 mL (lab), 10–200 mL (pilot), 250–5000 mL (process).',
    seeAlso: ['block.sample', 'packing-test', 'P-102', 'load-challenge'],
  },

  'CV-101': {
    term: 'CV-101 — Column valve',
    short: 'Five-position valve that routes flow down the column, up the column, past it, or isolates it entirely.',
    why: 'It is the only valve that can trap pressure in a packed bed, so it is interlocked: it will refuse to move above 10 % of maximum flow. Moving it under flow produces a real pressure transient and, on a real skid, can unpack a column.',
    typical: 'Positions BYPASS · DOWN · UP · ISOLATED · CIP_DETECTOR_BYPASS.',
    seeAlso: ['interlock', 'block.columnValve', 'skid.QswitchMax_frac', 'pressure-drop'],
  },

  'DV-101': {
    term: 'DV-101 — Outlet diverter / fraction valve',
    short: 'Rotary valve sending the outlet stream to waste or to one of the collection ports.',
    why: 'It sits downstream of all three detectors, which is the entire delay-volume problem: a decision made when the UV sees a peak, executed immediately at the valve, cuts every fraction too early by the UV-to-valve hold-up. Its actuation is not instantaneous either, so the volume delivered mid-switch is split between two fractions.',
    typical: 'Actuation 0.20 / 0.80 / 1.50 s by scale; 8 / 12 / 6 ports.',
    seeAlso: ['delay-volume', 'cross-fade', 'dead-leg', 'frac.delayCompensation', 'FC-101'],
  },

  'FC-101': {
    term: 'FC-101 — Fraction collector',
    short: 'The rack of vessels the outlet stream is directed into, one per fraction valve port.',
    why: 'Fractions are the unit of decision-making: you cannot pool finer than one fraction, so the fraction size sets how precisely yield can be traded against purity. Running out of ports mid-peak sends product to waste.',
    typical: 'Port capacity 50 mL (lab) / 500 mL (pilot) / 25 L (process). Fractions should last at least 10× the valve switch time.',
    seeAlso: ['fraction', 'pool', 'frac.minFractionVolume', 'frac.overflowTo', 'DV-101'],
  },

  'C-101': {
    term: 'C-101 — Chromatography column',
    short: 'The packed bed itself: a glass or steel tube of resin held between two frits.',
    why: 'Everything else on the skid exists to deliver a controlled stream to this one object. Its diameter sets the flow at a given linear velocity, its length sets the residence time and the plate count, and its packing quality sets whether the separation you designed is the separation you get.',
    typical: 'Pilot 10 cm ID × 20 cm bed = 1570.8 mL. Bed heights are almost always 10–25 cm regardless of scale.',
    seeAlso: ['cv', 'column.id_cm', 'column.L_cm', 'packing-test', 'hetp'],
  },

  'inlet-valve': {
    term: 'Inlet select valve (V1–V4)',
    short: 'A bank of on/off valves choosing which tank feeds the A, B or sample pump.',
    why: 'Only one valve per branch may be open: opening none deadheads the pump and opening two blends uncontrolled. Switching an inlet mid-run is legitimate and common, but the new buffer takes a full suction-plus-gradient hold-up to reach the column.',
    typical: 'Ports A1–A4, B1–B4, S1–S3. Suction hold-up per branch 1.55 / 37 / 600 mL.',
    seeAlso: ['block.inlets', 'holdup-volume', 'interlock', 'dry-running'],
  },

  /* ===========================================================================================
   * TANKS AND INVENTORY
   * =========================================================================================*/

  'TK-EQ': {
    term: 'TK-EQ — Equilibration / wash buffer',
    short: 'Buffer A: the low-salt background the column is conditioned in and washed with.',
    why: 'Nearly every millilitre of the method comes out of this tank, so it is the one that runs dry. Its composition defines the gradient start point, so a mis-made Buffer A moves every retention volume in the run.',
    typical: '50 mM acetate pH 5.00, total Na 50 mM, ~7.4 mS/cm. Roughly 40 CV per cycle.',
    seeAlso: ['buffer-capacity', 'TK-ELU', 'modulator', 'tank.startVolume_mL'],
  },

  'TK-WASH': {
    term: 'TK-WASH — Spare wash buffer',
    short: 'A second vessel of Buffer A on its own inlet port.',
    why: 'Real runs switch to a spare when the primary runs low rather than stopping to refill. Because both tanks hold the same buffer, the switch is invisible on the traces — which is exactly the point.',
    typical: 'Same composition as TK-EQ. Normally unused by the shipped method.',
    seeAlso: ['TK-EQ', 'inlet-valve'],
  },

  'TK-WFI': {
    term: 'TK-WFI — Water for injection',
    short: 'Clean water for flushing salt and base out of the flow path.',
    why: 'Water is what stands between a NaOH CIP and the next buffer; skipping the flush precipitates buffer salts in the line. It also gives a clean conductivity and UV zero for checking instrument health.',
    typical: 'No solutes. Conductivity below 0.01 mS/cm.',
    seeAlso: ['cip', 'autozero', 'conductivity'],
  },

  'TK-NAOH': {
    term: 'TK-NAOH — 0.5 M sodium hydroxide (CIP)',
    short: 'The cleaning-in-place solution: strong base that strips bound protein and sanitises the bed.',
    why: 'Caustic is what makes a resin reusable for a hundred cycles, and it is also what ages the pH electrode and fouls the UV cell a little more every time. Leaving the pH probe in line during a caustic step is a real and avoidable way to shorten its life.',
    typical: '0.5 M NaOH, true pH 13.70, reads ~12.90 because of the sodium error; ~100 mS/cm.',
    seeAlso: ['cip', 'ph', 'AE-101', 'fouling', 'resin.maxCycles'],
  },

  'TK-ELU': {
    term: 'TK-ELU — Elution buffer B',
    short: 'Buffer B: the high-salt end point of the gradient.',
    why: 'Together with Buffer A it defines the gradient span. Because both buffers carry the same acetate at the same pH, the only thing that changes along the gradient is the salt — which is what makes elution order interpretable.',
    typical: '50 mM acetate pH 5.00, total Na 500 mM, ~44.5 mS/cm. Roughly 8 CV per cycle.',
    seeAlso: ['TK-EQ', 'gradient-slope', 'modulator', 'pctB'],
  },

  'TK-STRIP': {
    term: 'TK-STRIP — Strip buffer',
    short: 'High-salt buffer run after the gradient to remove whatever is still bound.',
    why: 'The strip peak is a free assay: anything that appears there was too tightly bound to elute in the gradient, and its size over cycles tells you whether the CIP is keeping up.',
    typical: 'Same as Buffer B (or higher salt). 3 CV per cycle.',
    seeAlso: ['block.type', 'cip', 'TK-ELU'],
  },

  'TK-FEED': {
    term: 'TK-FEED — Clarified harvest (feed)',
    short: 'The material to be purified, drawn by the sample pump during the LOAD block.',
    why: 'It deliberately carries the same buffer as TK-EQ, so nothing binds or elutes because the buffer changed — only because the protein arrived. Its product titre, not its total protein titre, is the divisor that converts a load challenge into a feed volume.',
    typical: '5.00 g/L total protein: mAb 4.25, plus impurity, aggregate and charge variant. 3.53 CV per cycle.',
    seeAlso: ['load-challenge', 'titre', 'load.productTiter_gL', 'P-102'],
  },

  'tank.startVolume_mL': {
    term: 'Tank start volume',
    short: 'How much liquid is in the vessel when the run starts.',
    why: 'The pre-run check compares it against the method demand and blocks the start if a tank cannot see the run through. Refilling mid-run is legal and normal; discovering the shortfall mid-elution is not.',
    typical: 'mL. Sized at roughly 1.5× the method demand for the tank.',
    seeAlso: ['tank.emptyLevel_mL', 'tank.lowLevelPct', 'dry-running'],
  },

  'tank.emptyLevel_mL': {
    term: 'Tank empty level',
    short: 'The dip-tube dead volume: the level at which the pump starts drawing air instead of liquid.',
    why: 'It is never zero. Below this level the inlet stream cross-fades to gas over about two seconds — the characteristic dip-tube slurp — which is why the empty alarm and the air alarm fire at deliberately different times. That separation is a diagnostic cue, not a defect.',
    typical: 'mL. 20 / 500 / 10 000 by scale.',
    seeAlso: ['air-in-line', 'cavitation', 'dry-running', 'AT-101'],
  },

  'tank.lowLevelPct': {
    term: 'Tank low-level warning',
    short: 'Percentage of nominal capacity below which a low-level warning is raised.',
    why: 'An early, non-blocking prompt to refill while there is still time to do it without interrupting the run.',
    typical: 'percent. 10 % is standard.',
    seeAlso: ['tank.startVolume_mL', 'tank.emptyLevel_mL'],
  },

  'skid.wasteCapacity_mL': {
    term: 'Waste capacity',
    short: 'Total volume the waste vessel can take before it overflows.',
    why: 'Almost everything a chromatography step consumes ends up here, so it is the constraint people forget when they extend a wash or add a cycle. The pre-run check compares it against the method demand less whatever is planned for collection.',
    typical: 'mL. 10 000 / 200 000 / 3 000 000 by scale; a single pilot cycle produces ~73 000 mL.',
    seeAlso: ['tank.startVolume_mL', 'buffer-consumption'],
  },

  /* ===========================================================================================
   * COLUMN AND RESIN PARAMETERS
   * =========================================================================================*/

  'column.id_cm': {
    term: 'Column inner diameter',
    short: 'The internal bore of the column tube.',
    why: 'It sets the cross-sectional area, and therefore the flow needed for a given linear velocity. Scale-up is done by increasing diameter and holding bed height and linear velocity constant, which keeps residence time — and therefore the chromatography — unchanged.',
    typical: 'cm. 1.0–2.0 (lab), 10–20 (pilot), 45–60 (process).',
    seeAlso: ['column.L_cm', 'cv', 'linear-velocity', 'residence-time'],
  },

  'column.L_cm': {
    term: 'Bed height',
    short: 'The packed height of resin in the column.',
    why: 'Bed height buys plates and costs pressure, both linearly. It is deliberately NOT scaled up with diameter: a taller bed at process scale would over-pressure a soft agarose resin without improving the separation much.',
    typical: 'cm. Almost always 10–25 regardless of scale; 20 cm is the default here.',
    seeAlso: ['column.id_cm', 'hetp', 'plate-number', 'pressure-drop'],
  },

  'column.epsC': {
    term: 'Interstitial porosity (ε_c)',
    short: 'The fraction of the column occupied by liquid BETWEEN the beads.',
    why: 'This is the volume the mobile phase actually flows through, so it sets the interstitial velocity and the void volume. It is the single most-confused porosity in chromatography: getting it wrong shifts every retention volume and every capacity number.',
    typical: 'dimensionless. 0.35 for a well-packed spherical medium; 0.30–0.42 in practice.',
    seeAlso: ['column.epsP', 'column.epsT', 'void-volume', 'column.phi', 'bed-compression'],
  },

  'column.epsP': {
    term: 'Intraparticle porosity (ε_p)',
    short: 'The fraction of the bead volume that is pore liquid rather than solid polymer skeleton.',
    why: 'It is the nominal ceiling on how much of the bead any molecule can reach. What a given molecule ACTUALLY reaches is its own accessible porosity, which is smaller for anything large — that difference is exactly what size exclusion exploits.',
    typical: 'dimensionless. 0.85 for 6 % agarose; 0.95 for a SEC composite.',
    seeAlso: ['species.epsPi', 'column.epsT', 'kd-partition', 'sec'],
  },

  'column.epsT': {
    term: 'Total porosity (ε_t)',
    short: 'All the liquid in the column, between and inside the beads: ε_t = ε_c + (1 − ε_c)·ε_p.',
    why: 'It is the retention volume of a small molecule that goes everywhere and binds to nothing, expressed as a fraction of a column volume. Any unretained marker should come out here; if it does not, the porosities or the packing are wrong.',
    typical: 'dimensionless. 0.9025 with ε_c 0.35 and ε_p 0.85 — the value used everywhere in this simulator.',
    seeAlso: ['column.epsC', 'column.epsP', 'void-volume', 'tracer', 'packing-test'],
  },

  'column.phi': {
    term: 'Phase ratio (φ)',
    short: 'Particle volume divided by interstitial liquid volume: φ = (1 − ε_c)/ε_c.',
    why: 'It converts a partition coefficient into a retention factor. A larger φ means more stationary phase per unit of mobile phase, so everything is retained longer — which is why a well-packed bed retains more than a loose one.',
    typical: 'dimensionless. 1.857 at ε_c = 0.35.',
    seeAlso: ['column.epsC', 'k-prime', 'partition-coefficient', 'retardation-factor'],
  },

  'column.dp_cm': {
    term: 'Particle diameter (d_p)',
    short: 'The volume-surface mean diameter of the resin beads.',
    why: 'The central trade in preparative chromatography. Halving the bead diameter roughly quadruples the mass-transfer rate and sharpens every peak — and also quadruples the pressure drop. Big soft beads are what let a 20 cm process bed run at all.',
    typical: 'µm. 34 (SEC), 45 (small-bead IEX), 85–90 (standard preparative agarose).',
    seeAlso: ['mass-transfer-coefficient', 'pressure-drop', 'hetp', 'blake-kozeny'],
  },

  'column.rPore_cm': {
    term: 'Mean pore radius',
    short: 'The characteristic radius of the channels inside a bead.',
    why: 'Compared against a molecule\'s hydrodynamic radius it decides both how much of the bead that molecule can reach and how much its diffusion is hindered on the way in. A pore only a few times larger than the protein slows it dramatically.',
    typical: 'nm. 30 for standard agarose; 15 for a tight SEC medium; 40 for protein A.',
    seeAlso: ['hindrance', 'pore-diffusion', 'species.epsPi', 'sec'],
  },

  'column.Lambda_mM': {
    term: 'Ionic capacity (Λ)',
    short: 'The concentration of fixed charged ligands on the resin, expressed per unit of BEAD volume.',
    why: 'It is the ceiling on everything an ion exchanger can do: it sets the maximum binding capacity, the strength of the Donnan exclusion, and the salt concentration needed to elute. Vendors quote it per mL of packed bed; this simulator works per mL of bead, and the conversion is a factor of 1/(1 − ε_c).',
    typical: 'mM on the bead basis. 350 mM here = 0.2275 mmol per mL of packed bed.',
    seeAlso: ['sma', 'donnan', 'static-capacity', 'ionic-capacity'],
  },

  'column.isothermMode': {
    term: 'Isotherm model',
    short: 'Which equilibrium relationship links what is in the liquid to what is on the resin.',
    why: 'It is the choice of physics, not a display setting. Ion exchange needs a stoichiometric model where salt displaces protein; hydrophobic interaction needs a salt-dependent Langmuir; size exclusion needs no adsorption at all. Running the wrong one gives plausible-looking peaks in the wrong places.',
    typical: 'SMA · LANGMUIR · HIC · SEC · LINEAR · INERT.',
    seeAlso: ['sma', 'langmuir', 'hic-isotherm', 'sec', 'partition-coefficient'],
  },

  'column.resinChargeSign': {
    term: 'Resin charge sign',
    short: 'Whether the fixed ligands are negative (cation exchanger) or positive (anion exchanger).',
    why: 'It decides which mobile ion is the counter-ion drawn into the pores and which is the co-ion pushed out. Flipping it converts the whole model from CEX to AEX with no other change, which is why the sign is stored once on the resin rather than baked into each species.',
    typical: '−1 cation exchange · +1 anion exchange · 0 non-ionic.',
    seeAlso: ['donnan', 'counter-ion', 'co-ion', 'column.Lambda_mM'],
  },

  'column.modulatorIdx': {
    term: 'Modulator',
    short: 'The species whose concentration controls binding strength — the salt in the gradient.',
    why: 'Every isotherm here is written as a function of one modulator concentration. On a cation exchanger that is sodium; on HIC it is ammonium sulfate; on protein A there is none and pH does the work instead. Pointing it at the wrong species makes the gradient inert.',
    typical: 'A species id. Na for the shipped IEX presets.',
    seeAlso: ['modulator', 'gradient-slope', 'sma', 'pctB'],
  },

  'column.enableDonnan': {
    term: 'Donnan partitioning',
    short: 'Whether the fixed resin charge is allowed to concentrate counter-ions and exclude co-ions from the pores.',
    why: 'It is why the salt front does not travel at the same speed as an inert tracer on an ion exchanger, and why the pore is electroneutral rather than at bulk composition. Switching it off is only ever correct for a non-ionic resin.',
    typical: 'On for IEX; off for HIC, SEC and affinity.',
    seeAlso: ['donnan', 'counter-ion', 'co-ion', 'column.Lambda_mM'],
  },

  'column.kKozeny': {
    term: 'Kozeny constant (k_K)',
    short: 'The proportionality constant in the Blake–Kozeny pressure-drop law.',
    why: 'It bundles the tortuosity and shape of the flow channels into a single number. It is not universal: 150 is the textbook value for hard spheres, and 180 is the honest value for a compressible chromatography bed.',
    typical: 'dimensionless. 150–180.',
    seeAlso: ['blake-kozeny', 'pressure-drop', 'column.dp_cm'],
  },

  'column.lambdaPack': {
    term: 'Packing factor (λ)',
    short: 'The eddy-dispersion term of the van Deemter equation: A = 2·λ·d_p.',
    why: 'It is the only van Deemter term that reports packing QUALITY rather than physics. A well-packed bed has λ near 1; a bed with channels or voids has a much larger one, and that is what a packing test measures.',
    typical: 'dimensionless. ~1 for a good bed; above ~2 suspect the packing.',
    seeAlso: ['hetp', 'packing-test', 'axial-dispersion', 'column.channellingFactor'],
  },

  'column.gammaObstruction': {
    term: 'Obstruction factor (γ)',
    short: 'How much the packed bed slows molecular diffusion along the column axis: B = 2·γ·D_m.',
    why: 'It matters only at very low flow, where longitudinal diffusion has time to blur a band. At preparative velocities the mass-transfer term dominates by orders of magnitude.',
    typical: 'dimensionless. 0.6–0.8.',
    seeAlso: ['axial-dispersion', 'hetp'],
  },

  'column.compression': {
    term: 'Bed compression model',
    short: 'How the interstitial porosity shrinks as pressure squeezes the soft beads together.',
    why: 'It is why pressure rises faster than linearly with flow on an agarose bed: more flow means more pressure, which means less void, which means still more pressure. Push it far enough and the bed collapses and the run is over.',
    typical: 'ε_0 0.35 → ε_min 0.26 with a characteristic pressure of ~2 bar.',
    seeAlso: ['bed-compression', 'bed-collapse', 'pressure-drop', 'column.epsC'],
  },

  'column.hardwarePressureLimit_bar': {
    term: 'Column hardware pressure rating',
    short: 'The manufacturer\'s maximum working pressure for the column tube and end cells.',
    why: 'It is an equipment limit, not a process alarm. The pressure trip is clamped so it can never be set above it, and the bed drawing on the schematic uses it as the reference for how far the adapter has sunk.',
    typical: 'bar. 5.0 / 4.0 / 3.0 by scale — larger columns are rated lower.',
    seeAlso: ['PT-101', 'pressure-drop', 'bed-collapse'],
  },

  'column.rFrit_bar_per_cms': {
    term: 'Frit and distributor resistance',
    short: 'The pressure the column hardware itself costs, per unit of linear velocity.',
    why: 'On a clean column it is negligible next to the bed. It is the term that grows when the inlet frit blinds, which is why the fouling multiplier acts on it: a blinded frit raises pre-column pressure and ΔP together while the bed itself is untouched.',
    typical: 'bar per cm/s. ~0.001 clean, giving well under 0.1 mbar at nominal flow.',
    seeAlso: ['column.foulingFactor', 'fouling', 'PDT-101'],
  },

  'column.foulingFactor': {
    term: 'Fouling factor',
    short: 'A multiplier on the frit and distributor resistance representing accumulated blinding.',
    why: 'It is the scenario knob that turns a healthy column into one that trips the pressure ladder, without touching the chemistry. Peak shapes are unchanged, so the lesson — pressure is a hardware problem, not a separation problem — stays clean.',
    typical: 'dimensionless, 1 (clean) to 500 (badly blinded).',
    seeAlso: ['column.rFrit_bar_per_cms', 'fouling', 'flow-reduction'],
  },

  'column.channellingFactor': {
    term: 'Channelling',
    short: 'A visual indicator of flow maldistribution: liquid preferring one path through the bed.',
    why: 'A channelled bed shows a curved rather than flat band front, and its peaks tail badly for reasons no amount of method development will fix. Here it is an authored teaching knob — the model has no radial dimension, so nothing in the physics can generate it.',
    typical: 'dimensionless 0 (uniform) to 1 (severe).',
    seeAlso: ['packing-test', 'asymmetry', 'column.lambdaPack'],
  },

  'column.nz': {
    term: 'Axial grid cells (n_z)',
    short: 'How many slices the column is divided into for the numerical solution.',
    why: 'More cells mean less numerical smearing but a proportionally slower simulation. Too few and the model invents peak broadening that the physics never produced, so this is a fidelity setting rather than a performance one.',
    typical: '100–800; 400 is the default, reduced automatically on a slow machine.',
    seeAlso: ['courant-number', 'axial-dispersion', 'speed-deficit'],
  },

  'column.nuTarget': {
    term: 'Target Courant number',
    short: 'How far, as a fraction of one grid cell, the solver lets the fluid move in a single time step.',
    why: 'Counter-intuitively, a BIGGER column time step is more accurate here as well as cheaper: the numerical smearing of the convection scheme falls as the Courant number approaches one. Stepping the column every physics tick would inflate the salt front by about 30 %.',
    typical: 'dimensionless, just below 1. 0.95 here.',
    seeAlso: ['courant-number', 'column.nz', 'axial-dispersion'],
  },

  'column.enableProteinViscosity': {
    term: 'Protein viscosity contribution',
    short: 'Whether concentrated protein is allowed to raise the mobile-phase viscosity.',
    why: 'At the concentrations a capture elution reaches it is a real effect — a viscous plug of product raises the pressure as it moves through the bed — but it is off by default because it couples the pressure trace to the chemistry and makes a first run harder to reason about.',
    typical: 'Off by default. Worth a few percent on viscosity at 30 g/L.',
    seeAlso: ['viscosity', 'jones-dole', 'pressure-drop'],
  },

  'species.epsPi': {
    term: 'Accessible pore porosity (ε_πi)',
    short: 'The fraction of the bead volume a PARTICULAR molecule can actually get into.',
    why: 'It does double duty: it sets how much stationary phase the molecule sees, and it appears in the pore-diffusion term, so it moves both retention and peak width. Using the resin\'s nominal porosity instead of the species\' own value changes a monoclonal antibody\'s mass-transfer coefficient by about 20 % and an aggregate\'s by nearly 90 %.',
    typical: 'dimensionless, 0 to ε_p. Salt 0.85, IgG monomer 0.70, dimer 0.45.',
    seeAlso: ['column.epsP', 'kd-partition', 'pore-diffusion', 'sec'],
  },

  'kd-partition': {
    term: 'Distribution coefficient (K_D)',
    short: 'The fraction of the resin\'s pore volume that is accessible to a given molecule.',
    why: 'It is the conventional way to report size accessibility: 1 means the molecule goes everywhere the buffer goes, 0 means it is completely excluded. Here it is derived for display from the authored accessible porosity, never the other way round.',
    typical: 'dimensionless 0–1. IgG monomer ~0.82 on 30 nm pores.',
    seeAlso: ['species.epsPi', 'column.epsP', 'kav', 'sec'],
  },

  /* ===========================================================================================
   * SKID PARAMETERS
   * =========================================================================================*/

  'skid.gradientMode': {
    term: 'Gradient forming mode',
    short: 'Whether the blend is made by two metering pumps (high-pressure) or by one pump and a chopper valve (low-pressure).',
    why: 'High-pressure forming is accurate and needs almost no mixer; low-pressure forming needs only one pump — which is decisive at process scale — but produces a square wave that must be averaged out. That is why a big skid has a big mixing chamber and a small one does not.',
    typical: 'HPGF (lab) · LPGF (pilot and process).',
    seeAlso: ['hpgf', 'lpgf', 'M-101', 'proportioner', 'ripple'],
  },

  'skid.mixerVolume_mL': {
    term: 'Mixer volume',
    short: 'The hold-up of the mixing chamber that smooths the A/B blend.',
    why: 'Directly trades gradient smoothness against gradient sharpness. A bigger chamber kills the proportioning ripple but delays and blurs the gradient, so a step change in %B arrives at the column as a rounded ramp.',
    typical: 'mL. Roughly 5–10 % of a column volume.',
    seeAlso: ['M-101', 'skid.mixerN', 'lpgf', 'tanks-in-series'],
  },

  'skid.mixerN': {
    term: 'Mixer type',
    short: 'Whether the chamber behaves as one well-stirred tank or as a series of small ones.',
    why: 'A dynamic (stirred) mixer averages hard but smears the gradient; a static in-line mixer barely smears at all but is much worse at removing a low-frequency chopper ripple. This one number is the whole difference.',
    typical: '1 = dynamic (stirred) · 10 = static in-line.',
    seeAlso: ['skid.mixerVolume_mL', 'tanks-in-series', 'lpgf'],
  },

  'skid.chopPeriod_s': {
    term: 'Proportioning valve period',
    short: 'How long one open/closed cycle of the low-pressure gradient chopper valve lasts.',
    why: 'It sets both the ripple frequency and the %B resolution: with a minimum open time of 40 ms, a 1 s period resolves 4 %B and a 2 s period resolves 2 %B. Longer periods resolve finer but put more ripple energy where the mixer is least able to remove it.',
    typical: 's. 1.0 (lab) / 2.0 (pilot and process).',
    seeAlso: ['lpgf', 'proportioner', 'ripple', 'skid.mixerVolume_mL'],
  },

  'skid.Vstroke_mL': {
    term: 'Pump stroke volume',
    short: 'The displacement of one piston stroke.',
    why: 'It sets the ripple frequency: a twin-piston pump ripples at twice the stroke rate, so a small stroke at high flow produces a fast ripple that filters out easily, while a large stroke at low flow produces a slow one that does not.',
    typical: 'mL. 0.10 / 5.0 / 60 by scale, giving 0.3–7 Hz across the flow range.',
    seeAlso: ['P-101', 'ripple'],
  },

  'skid.Qmax_mLs': {
    term: 'Maximum flow',
    short: 'The pump\'s rated ceiling.',
    why: 'It caps what any method can ask for, and it is the reference for several interlocks — the column valve will not move above 10 % of it, and flow reduction will not back off below 5 % of it.',
    typical: 'mL/min. 20 / 1000 / 13 333 by scale, i.e. roughly 500–1500 cm/h on each scale\'s own column.',
    seeAlso: ['flow-rate', 'skid.QswitchMax_frac', 'flow-reduction', 'linear-velocity'],
  },

  'skid.rampRate_mLs2': {
    term: 'Flow ramp rate',
    short: 'How fast the pump is allowed to change flow.',
    why: 'An instantaneous flow change would shock a soft bed and spike the pressure. Ramping is also why the volume totalisers must integrate actual flow rather than setpoint — otherwise every block would come up short.',
    typical: 'Percent of maximum flow per second. 20 / 10 / 5 by scale.',
    seeAlso: ['P-101', 'flow-rate', 'FT-101'],
  },

  'skid.QswitchMax_frac': {
    term: 'Valve switch flow limit',
    short: 'The flow above which the column valve refuses to move.',
    why: 'Rotating a valve into a pressurised bed is how columns get unpacked. The interlock is not advisory: the request is rejected and an alarm is raised, and the operator is told why rather than being left with a silent refusal.',
    typical: 'Fraction of maximum flow. 0.10.',
    seeAlso: ['CV-101', 'interlock'],
  },

  'skid.uv.pathlength_cm': {
    term: 'UV flow-cell pathlength',
    short: 'The optical path the light takes through the stream.',
    why: 'The whole reason a preparative UV monitor does not read off-scale. A 10 mm analytical cell would read 35 AU on a concentrated capture elution; a 0.2 mm process cell reads 0.24 AU on the same peak. Because thresholds here are stored per centimetre, changing the cell cannot silently move a pool cut.',
    typical: 'mm. Selectable 0.2 / 0.5 / 1 / 2 / 5 / 10; 0.2 for concentrated IEX and HIC, 2 for dilute SEC.',
    seeAlso: ['beer-lambert', 'UV-101', 'pathlength', 'stray-light'],
  },

  'skid.uv.strayLight': {
    term: 'Stray light',
    short: 'The small fraction of light reaching the detector without passing through the sample.',
    why: 'It is the real physics of why a photometer rolls over instead of reading ever higher: at 0.3 % stray light no absorbance above about 2.5 AU can ever be measured, no matter how concentrated the sample. Clamping the reading instead would produce a flat top with a hard corner that no real detector shows.',
    typical: 'Fraction. 3.0e-3, giving a ceiling of 2.52 AU.',
    seeAlso: ['UV-101', 'beer-lambert', 'quality-flags'],
  },

  'skid.uv.tau_s': {
    term: 'UV filter time constant',
    short: 'The response time of the detector\'s output filter.',
    why: 'It trades noise against fidelity. A long filter gives a beautifully smooth baseline and rounds the front of a sharp peak; a short one shows every bubble and every pump stroke. It also adds directly to the apparent delay between the column and the pooling decision.',
    typical: 's. 0.5 / 2 / 4 by scale.',
    seeAlso: ['UV-101', 'delay-volume', 'ripple'],
  },

  'skid.cond.Kcell_cm1': {
    term: 'Conductivity cell constant',
    short: 'The electrode geometry factor relating measured conductance to conductivity.',
    why: 'It is what makes a reading in siemens per centimetre rather than siemens. It is fixed by the cell construction and calibrated at manufacture; a drifting cell constant means fouled or eroded electrodes.',
    typical: 'per cm. 1–10 depending on the cell.',
    seeAlso: ['CE-101', 'conductivity'],
  },

  'skid.ph.slopePct': {
    term: 'pH electrode slope',
    short: 'The measured response of the electrode as a percentage of the theoretical 59.16 mV per pH unit.',
    why: 'The standard health metric for a glass electrode. It falls with age and with every caustic exposure; below about 92 % the readings can no longer be trusted and the electrode should be replaced. The pre-run check flags it, and the run may proceed only with an explicit acknowledgement.',
    typical: 'percent. 100 new, 92 is the practical floor.',
    seeAlso: ['AE-101', 'ph', 'cip', 'quality-flags'],
  },

  'skid.press.Rdown_bar_per_mLs': {
    term: 'Downstream resistance',
    short: 'The lumped hydraulic resistance of everything after the column outlet.',
    why: 'It is what post-column pressure actually measures. A step increase in it — a kinked line, a partly closed valve, a plugged fraction port — raises the pre-column pressure too, and only comparing the two pressures separates that from a bed problem.',
    typical: 'bar per mL/s, chosen so post-column pressure is ~0.088 bar at nominal flow at every scale.',
    seeAlso: ['PT-102', 'pressure-drop', 'PDT-101'],
  },

  'skid.filter.kFoul_per_mg': {
    term: 'Filter fouling coefficient',
    short: 'How much the inline filter\'s resistance rises per milligram of protein passed.',
    why: 'It converts load into pressure. Because it acts before the column, a fouling filter raises the pre-column pressure and the apparent column ΔP together — the signature that distinguishes it from a fouling bed, where the pre-filter pressure stays put.',
    typical: 'per mg. Sized so a full load raises the filter resistance by about 55 %.',
    seeAlso: ['F-101', 'fouling', 'PT-101'],
  },

  'skid.fracValve.tSwitch_s': {
    term: 'Fraction valve switch time',
    short: 'How long the outlet valve takes to move from one port to the next.',
    why: 'During the move the flow is split between two ports, so the volume delivered in that window belongs partly to each fraction. It also sets a hard floor on useful fraction size: a fraction that lasts only a few switch times is mostly cross-over.',
    typical: 's. 0.20 / 0.80 / 1.50 by scale. Fractions must last at least ten switch times.',
    seeAlso: ['DV-101', 'cross-fade', 'frac.minFractionVolume'],
  },

  'skid.bubbleSensorThreshold_frac': {
    term: 'Bubble sensor threshold',
    short: 'The gas fraction at which the inline air sensor declares air in the line.',
    why: 'Set it too low and every micro-bubble stops the run; too high and a real slug reaches the column before anything reacts. It is the trip point that turns a tank running dry into an alarm before the gas reaches the bed.',
    typical: 'Volume fraction. 0.02.',
    seeAlso: ['air-in-line', 'AT-101', 'tank.emptyLevel_mL'],
  },

  'skid.fluidTau_s': {
    term: 'Fluid thermal time constant',
    short: 'How quickly the stream temperature relaxes toward the ambient temperature of the room.',
    why: 'Buffer taken from a cold room does not stay cold in a warm suite, and it does not warm instantly either. The transition shows up as a slow drift on the conductivity trace long after the composition has stopped changing, which is a classic false diagnosis.',
    typical: 's. 300 / 900 / 1800 by scale — bigger systems have more thermal mass.',
    seeAlso: ['TT-101', 'temperature-compensation', 'viscosity'],
  },

  'skid.holdup': {
    term: 'System hold-up volumes',
    short: 'The liquid volume in every stretch of tubing, valve and cell between two points on the skid.',
    why: 'Nothing on a skid happens where you observe it. The UV cell sees the column outlet one hold-up later, and the fraction valve acts one further hold-up after that. Every delay-related error in preparative chromatography comes from ignoring one of these numbers.',
    typical: 'mL. UV to fraction valve is 1.22 / 50.25 / 832.5 by scale — 15.5 %, 3.2 % and 2.6 % of a column volume.',
    seeAlso: ['delay-volume', 'holdup-volume', 'tanks-in-series', 'frac.delayCompensation'],
  },

  /* ===========================================================================================
   * METHOD AND BLOCK PARAMETERS
   * =========================================================================================*/

  'method.block': {
    term: 'Block (method step)',
    short: 'One step of the method: a buffer, a flow, a duration and an optional set of watches.',
    why: 'Blocks are how a chromatography method is actually written and how a batch record reads. Each has its own volume totaliser, so "5 CV of wash" means five column volumes of wash regardless of what the pressure did in the middle of it.',
    typical: 'A capture method is typically 6–9 blocks and 40–50 CV.',
    seeAlso: ['block.type', 'block.duration', 'watch.signal', 'cv'],
  },

  'block.type': {
    term: 'Block type',
    short: 'What kind of step this is: equilibration, load, wash, elution, strip, CIP and so on.',
    why: 'The type is not a label — it changes what the engine enforces. A LOAD block requires a sample mode and counts loaded mass; an ELUTION_LINEAR block ramps the blend; a CIP block increments the cycle counter and suppresses the UV over-range warning; a HOLD block never ends on its own.',
    typical: 'EQUILIBRATION · LOAD · WASH · ELUTION_ISOCRATIC · ELUTION_LINEAR · ELUTION_STEP · STRIP · CIP · RE_EQUILIBRATION · HOLD · COLUMN_BYPASS · PACKING_TEST.',
    seeAlso: ['method.block', 'cip', 'packing-test', 'block.sample'],
  },

  'block.duration': {
    term: 'Block duration',
    short: 'How long the step runs, expressed in column volumes, millilitres, minutes, or multiples of the sample volume.',
    why: 'Volume bases are the correct ones for chromatography, because the separation depends on how much buffer passed, not how long it took. A block specified in CV completes correctly even if the flow is reduced halfway through; a block specified in minutes does not.',
    typical: 'CV · mL · min · CV_OF_SAMPLE. Equilibration 5–6 CV, wash 3–5 CV, gradient 10–20 CV.',
    seeAlso: ['cv', 'duration.onTimeout', 'watch.signal'],
  },

  'duration.onTimeout': {
    term: 'On timeout',
    short: 'What to do when the duration runs out and no watch has ended the block first.',
    why: 'Duration is a safety net, not the normal exit, whenever a block carries watches. Choosing between advancing, holding and alarming is a real decision: advancing quietly can pool a peak that never came, while holding stops the run for an operator to look.',
    typical: 'NEXT · HOLD · ALARM · REPEAT.',
    seeAlso: ['block.duration', 'watch.signal', 'hold'],
  },

  'block.flow': {
    term: 'Block flow',
    short: 'The flow for this step, entered as volumetric flow, linear velocity, residence time or column volumes per hour.',
    why: 'All four are the same number wearing different clothes, and different people think in different ones: process development thinks in residence time, plant operations thinks in litres per hour, and the resin datasheet is written in cm/h. Entering any one derives the other three.',
    typical: 'cm/h is the scale-invariant one. 150 cm/h on a 20 cm bed is an 8 minute residence time.',
    seeAlso: ['flow-rate', 'linear-velocity', 'residence-time', 'FT-101'],
  },

  'block.inlets': {
    term: 'Block inlets',
    short: 'Which tank feeds the A branch, the B branch and the sample branch during this step.',
    why: 'Changing an inlet is instantaneous at the valve and anything but instantaneous at the column: the new liquid has to traverse the suction and gradient hold-up first. That lag is why an equilibration block that looks long on paper is often not long enough.',
    typical: 'A1–A4, B1–B4, S1–S3, or none.',
    seeAlso: ['inlet-valve', 'holdup-volume', 'pctB'],
  },

  'block.gradient': {
    term: 'Gradient',
    short: 'How the blend of buffer A and buffer B changes across the block.',
    why: 'Gradient shape is the main lever on selectivity. A shallow gradient separates more but dilutes more and takes longer; a step elutes fast and concentrated but co-elutes anything with similar binding strength.',
    typical: 'ISOCRATIC · LINEAR · STEP · CONVEX · CONCAVE · MULTI_SEGMENT.',
    seeAlso: ['gradient-slope', 'pctB', 'band-compression', 'gradient.lengthFraction'],
  },

  'gradient.lengthFraction': {
    term: 'Gradient length fraction',
    short: 'What proportion of the block the gradient occupies before it holds at the end value.',
    why: 'It lets a gradient be followed by a hold inside a single block — ramp to 50 %B over the first 80 %, then hold — which is how a real elution is often written when a late-eluting species needs a plateau to come off.',
    typical: 'Fraction 0–1. 1.0 means the gradient runs the whole block.',
    seeAlso: ['block.gradient', 'gradient-slope'],
  },

  'gradient.curvature': {
    term: 'Gradient curvature',
    short: 'How strongly a convex or concave gradient bends away from a straight line.',
    why: 'A concave start is gentle where the early impurities elute and steep later; a convex one does the opposite. It is a fine-tuning tool that matters when two species elute at very different salt concentrations.',
    typical: 'dimensionless −5 to +5, read only for convex and concave shapes.',
    seeAlso: ['block.gradient', 'gradient-slope'],
  },

  'block.columnValve': {
    term: 'Block column valve position',
    short: 'Where the column valve is set for this step.',
    why: 'Down-flow is normal. Up-flow is used for packing and for reverse-flow cleaning. Bypass lets buffer be changed or the skid equilibrated without pushing anything through the bed, and the detector-bypass position protects the pH probe during a caustic step.',
    typical: 'DOWN normally; BYPASS during buffer changeover; UP for reverse-flow CIP.',
    seeAlso: ['CV-101', 'interlock', 'cip'],
  },

  'block.outletDefault': {
    term: 'Default outlet',
    short: 'Where the outlet stream goes while this step is not actively collecting a fraction.',
    why: 'Everything not being collected is waste, and getting this wrong sends product to the drain. It is deliberately separate from the fractionation settings so that stopping fractionation always has a defined destination.',
    typical: 'WASTE for every block except an actively collecting elution.',
    seeAlso: ['DV-101', 'frac.mode', 'skid.wasteCapacity_mL'],
  },

  'block.sample': {
    term: 'Sample application mode',
    short: 'How feed is introduced: pumped directly, filled into a loop, or injected from a filled loop.',
    why: 'Direct loading is how a capture step runs — large volumes, no loop needed. Loop injection is how a small, precisely known volume is introduced, which is what a packing test or a SEC run requires. The chase volume decides whether the last of the feed in the line ever reaches the column.',
    typical: 'DIRECT · LOOP_FILL · LOOP_INJECT.',
    seeAlso: ['IV-101', 'P-102', 'load-challenge', 'packing-test'],
  },

  'block.autozero': {
    term: 'Autozero at block start',
    short: 'Reset the UV baseline to zero at the beginning of this step.',
    why: 'Standard practice at the end of equilibration, when the column is in a stable buffer and the true baseline is known. Zeroing on a moving baseline or with air in the cell bakes an offset into every subsequent reading, which is why the run flags it when you do.',
    typical: 'True on the last equilibration block; false everywhere else.',
    seeAlso: ['autozero', 'UV-101', 'quality-flags'],
  },

  'block.holdAtEnd': {
    term: 'Hold at end of block',
    short: 'Enter the held state instead of advancing when this step finishes.',
    why: 'The standard way to build an operator checkpoint into a method: pause for a sample to be taken or a decision to be made, with flow continuing so the column is never left static under pressure.',
    typical: 'Rarely used; a static CIP hold is the common case.',
    seeAlso: ['hold', 'run-state'],
  },

  /* ===========================================================================================
   * WATCHES
   * =========================================================================================*/

  'watch.signal': {
    term: 'Watch',
    short: 'A rule that ends a block, or performs an action, when a measured signal does something.',
    why: 'This is the difference between a recipe and a control strategy. "Wash until the UV baseline returns" adapts to the batch in front of you; "wash for 5 CV" does not. Watches are what let a method respond to what actually happened.',
    typical: 'Evaluated ten times a second on the filtered, delay-realistic sensor value.',
    seeAlso: ['watch.operator', 'watch.arm', 'watch.persistence_ticks', 'watch.action'],
  },

  'watch.operator': {
    term: 'Watch operator',
    short: 'The comparison the watch makes: crossing a threshold, sitting above it, changing at a rate, or holding steady.',
    why: 'Edge and level operators behave very differently. "Rises above" requires the signal to have been below first, so it cannot fire on a baseline that was already high; "above" fires immediately. Choosing the wrong one is the most common reason a watch fires at the wrong moment.',
    typical: 'RISES_ABOVE · FALLS_BELOW · ABOVE · BELOW · SLOPE_ABOVE · SLOPE_BELOW · ABS_SLOPE_BELOW · STABLE · REACHES · CHANGES_BY · PLATEAU.',
    seeAlso: ['watch.signal', 'watch.threshold', 'watch.slopeWindow'],
  },

  'watch.threshold': {
    term: 'Watch threshold',
    short: 'The value the signal is compared against.',
    why: 'UV thresholds are stored per centimetre of pathlength rather than in absorbance units, so swapping the flow cell cannot silently move a pool cut. The number you typed is preserved alongside it, so the editor can always show you what you actually wrote.',
    typical: 'In the signal\'s own units: mAU, mS/cm, bar, pH, %.',
    seeAlso: ['watch.operator', 'pathlength', 'frac.startThreshold'],
  },

  'watch.arm': {
    term: 'Arm delay',
    short: 'How far into the block the watch must be before it is allowed to fire.',
    why: 'Every block starts with a transient — a valve moved, a flow ramped, a buffer changed — and without a dead time the watch fires on that instead of on the thing you meant. Arming is measured on the block\'s own volume counter, so it scales with flow.',
    typical: 'CV, mL or minutes. 0.05 CV is the default; a stability watch may need several CV.',
    seeAlso: ['watch.signal', 'watch.persistence_ticks'],
  },

  'watch.persistence_ticks': {
    term: 'Persistence',
    short: 'How many consecutive control cycles the condition must hold before the watch fires.',
    why: 'Noise crosses a threshold constantly. Persistence is what turns "the signal touched 100 mAU" into "the signal is above 100 mAU". A single failing cycle resets the count to zero, so a spike can never accumulate its way to a trigger.',
    typical: 'Control cycles at 10 Hz. 5 ticks = 0.5 s is the default.',
    seeAlso: ['watch.signal', 'watch.arm'],
  },

  'watch.slopeWindow': {
    term: 'Slope window',
    short: 'The volume over which a rate of change or a stability test is measured.',
    why: 'Slope is meaningless without a window: too short and it is all noise, too long and it lags the event you are watching for. Because the window is a volume rather than a time, the same setting behaves identically at any flow.',
    typical: 'CV or mL. 0.05–0.5 CV. At least eight samples must fall inside it or the slope is undefined.',
    seeAlso: ['watch.operator', 'watch.stableTolerance'],
  },

  'watch.stableTolerance': {
    term: 'Stability tolerance',
    short: 'How much a signal may vary across the window and still count as stable.',
    why: 'Stability needs two tests, not one: the slope must be flat AND the total spread must be small. Slope alone passes on a noisy plateau whose mean is quietly wandering, which is how a re-equilibration block ends early on a column that is not equilibrated.',
    typical: 'In the signal\'s units. 0.2 mS/cm is a realistic conductivity criterion.',
    seeAlso: ['watch.operator', 'watch.slopeWindow'],
  },

  'watch.action': {
    term: 'Watch action',
    short: 'What happens when the watch fires.',
    why: 'Actions split into terminal ones that end the block and non-terminal ones that do something and let it continue. All the satisfied non-terminal actions run first, in the order they are written, and then the first terminal one ends evaluation — so the order you list them in is part of the logic.',
    typical: 'Terminal: END_BLOCK · GOTO_BLOCK · HOLD · PAUSE · RAISE_ALARM. Non-terminal: MARK · START_FRACTIONATION · STOP_FRACTIONATION · SET_PCTB · SET_FLOW · OUTLET_TO · EXTEND_BLOCK.',
    seeAlso: ['watch.signal', 'hold', 'frac.mode'],
  },

  'watch.oneShot': {
    term: 'One-shot',
    short: 'Whether the watch may fire only once per block or repeatedly.',
    why: 'A block-ending watch is naturally one-shot. A repeating watch is how a rule such as "advance the fraction every time the slope changes sign" is written, and leaving it one-shot silently disables everything after the first event.',
    typical: 'True for terminal actions; false for repeating fraction logic.',
    seeAlso: ['watch.action', 'watch.signal'],
  },

  'watch.useDelayCompensated': {
    term: 'Delay-compensated watch',
    short: 'Evaluate the watch against where the fluid IS rather than where the detector sees it.',
    why: 'Explicitly non-physical, and provided as a teaching aid. A real skid cannot know the future; turning this on shows what a decision would look like without the sensor delay, which makes the size of that delay immediately obvious.',
    typical: 'Off. Turn on only to demonstrate the effect.',
    seeAlso: ['delay-volume', 'frac.delayCompensation', 'skid.holdup'],
  },

  /* ===========================================================================================
   * FRACTIONATION AND POOLING
   * =========================================================================================*/

  'frac.mode': {
    term: 'Fractionation mode',
    short: 'How the outlet stream is divided into collected fractions.',
    why: 'Fixed-volume collection is simple and always works but cuts blindly through peaks. Peak-based collection tracks the actual chromatogram, at the cost of depending on the detector behaving. Most real methods use peak collection with a fixed-volume fallback.',
    typical: 'OFF · FIXED_VOLUME · FIXED_TIME · PEAK.',
    seeAlso: ['fraction', 'frac.startThreshold', 'DV-101', 'pool'],
  },

  'frac.startThreshold': {
    term: 'Fraction start threshold',
    short: 'The signal level, slope, or combination of both that begins collection.',
    why: 'This is the front cut, and it sets the yield/purity trade directly. A low threshold catches the leading edge and any impurity in it; a high one starts clean and loses product. It is expressed per centimetre of pathlength so that it means the same thing on any flow cell.',
    typical: 'Commonly 5–20 % of the expected apex. The shipped pilot method starts at 2.00 AU/cm, about 17 % of apex.',
    seeAlso: ['frac.stopThreshold', 'yield', 'purity', 'pool'],
  },

  'frac.stopThreshold': {
    term: 'Fraction stop threshold',
    short: 'The level, slope, or percentage of the observed peak maximum at which collection ends.',
    why: 'The back cut, and usually the more consequential one: the tail of a preparative peak is where the late-eluting impurities live. Cutting on a percentage of the observed maximum adapts to a batch that ran higher or lower than expected.',
    typical: 'Often symmetric with the start threshold, or 5–15 % of the peak maximum.',
    seeAlso: ['frac.startThreshold', 'purity', 'tailing-factor'],
  },

  'frac.minFractionVolume': {
    term: 'Minimum fraction volume',
    short: 'The smallest fraction the collector is allowed to make.',
    why: 'Without it, a noisy shoulder produces a train of useless few-millilitre fractions and exhausts the ports before the real peak arrives. It suppresses an advance that the peak logic would otherwise have made.',
    typical: 'CV or mL. 0.05 CV; must be at least ten valve switch times long.',
    seeAlso: ['frac.maxFractionVolume', 'skid.fracValve.tSwitch_s', 'fraction'],
  },

  'frac.maxFractionVolume': {
    term: 'Maximum fraction volume',
    short: 'The largest fraction allowed before the collector advances regardless of anything else.',
    why: 'The highest-priority rule in the fractionation logic. It guarantees that a broad peak is still split into pieces fine enough to pool selectively, and it prevents a stuck peak-stop condition from filling one vessel with the entire run.',
    typical: 'CV or mL. 0.25 CV.',
    seeAlso: ['frac.minFractionVolume', 'pool', 'fraction'],
  },

  'frac.peakMaxDetection': {
    term: 'Peak maximum detection',
    short: 'Flag the fraction that contains the apex of the peak.',
    why: 'The apex fraction is the most concentrated and the purest, so it is the natural centre of a pool. Marking it live also gives the operator the confirmation that the peak really has turned over rather than plateaued.',
    typical: 'On for peak collection. Prominence must exceed a set value to avoid marking noise.',
    seeAlso: ['peak-max', 'fraction', 'pool'],
  },

  'frac.delayCompensation': {
    term: 'Delay compensation',
    short: 'How the hold-up between the UV cell and the fraction valve is accounted for.',
    why: 'The classic preparative mistake. A decision taken when the UV sees the peak, executed immediately at the valve, cuts every fraction early by the whole UV-to-valve volume. Compensating on VOLUME rather than time is what stays correct through a flow ramp — the same 50 mL is 15 seconds at one flow and 8 at twice that.',
    typical: 'COMPENSATED · UNCOMPENSATED (to demonstrate the error) · FIXED_TIME (correct only at constant flow).',
    seeAlso: ['delay-volume', 'skid.holdup', 'DV-101', 'yield'],
  },

  'frac.deadLegPolicy': {
    term: 'Dead leg policy',
    short: 'What to do about the liquid trapped between the fraction valve and the collection vessel.',
    why: 'That volume is still full of the PREVIOUS stream when a new fraction starts, so the first millilitres of every fraction are carry-over. Reporting it makes it visible; diverting it to waste first costs a little product but gives a cleaner cut.',
    typical: 'REPORT · DIVERT · IGNORE. Dead leg 0.35 / 18 / 250 mL by scale.',
    seeAlso: ['dead-leg', 'DV-101', 'cross-fade', 'purity'],
  },

  'frac.overflowTo': {
    term: 'Overflow destination',
    short: 'Where the stream goes once every collection port has been used.',
    why: 'Running out of ports mid-peak is common on a long gradient. Without a defined overflow the run would have nowhere to put the stream; with one, the loss is at least logged and visible rather than silent.',
    typical: 'WASTE, with a warning raised when the last port is consumed.',
    seeAlso: ['FC-101', 'fraction', 'frac.maxFractionVolume'],
  },

  'fraction': {
    term: 'Fraction',
    short: 'One collected portion of the outlet stream, in one vessel, with its own volume and analytics.',
    why: 'It is the atom of preparative chromatography: the finest granularity at which product can be kept or discarded. Every yield-versus-purity decision is ultimately a choice of which fractions to combine.',
    typical: 'Typically 0.05–0.25 CV each; 8–24 across a peak.',
    seeAlso: ['pool', 'FC-101', 'frac.mode', 'yield', 'purity'],
  },

  'pool': {
    term: 'Pool',
    short: 'The set of fractions combined to make the product of the step.',
    why: 'Choosing the pool IS the separation, as far as the batch record is concerned. Widening it raises yield and lowers purity; narrowing it does the reverse, and the trade is rarely symmetric because impurities are not evenly distributed across a peak.',
    typical: 'A capture pool is usually 60–90 % of the peak by mass.',
    seeAlso: ['fraction', 'yield', 'purity', 'concentration-factor'],
  },

  /* ===========================================================================================
   * CORE CHROMATOGRAPHY CONCEPTS
   * =========================================================================================*/

  'cv': {
    term: 'Column volume (CV)',
    short: 'The geometric volume of the packed bed: cross-sectional area times bed height.',
    why: 'The universal currency of chromatography. Expressing every volume in CV is what makes a method transferable between a 40 mL laboratory column and a 30 L process column without changing a number.',
    typical: 'mL. 40.2 (lab, 1.6 × 20 cm), 1570.8 (pilot, 10 × 20 cm), 31 809 (process, 45 × 20 cm).',
    seeAlso: ['C-101', 'void-volume', 'column.id_cm', 'residence-time'],
  },

  'void-volume': {
    term: 'Void volume (V_0)',
    short: 'The liquid volume between the beads, where the mobile phase actually flows.',
    why: 'It is the earliest any molecule can possibly elute — the retention volume of something too large to enter a pore at all. Everything later is retention of some kind, whether by size or by binding.',
    typical: 'About 0.35 CV for a well-packed bed.',
    seeAlso: ['column.epsC', 'column.epsT', 'kav', 'retention-volume'],
  },

  'retention-volume': {
    term: 'Retention volume (V_R)',
    short: 'The volume of mobile phase that has passed when a species reaches its peak maximum.',
    why: 'The primary measurement of chromatography. It is set by how much of the stationary phase the molecule can reach and how strongly it interacts, so two species differ in retention volume exactly to the extent that they can be separated.',
    typical: 'mL or CV. Unretained 0.9 CV; a gradient-eluted protein 6–14 CV from the gradient start.',
    seeAlso: ['k-prime', 'partition-coefficient', 'resolution', 'void-volume'],
  },

  'k-prime': {
    term: 'Retention factor (k′)',
    short: 'How many times longer a species is retained than an unretained one: k′ = φ·K.',
    why: 'It is the dimensionless statement of retention, independent of column size. It also governs efficiency: peaks are broadest, relative to their retention, when k′ is around one, and mass-transfer broadening scales as k′/(1+k′)².',
    typical: 'dimensionless. 4–6 for the proteins at their own elution salt in the shipped preset.',
    seeAlso: ['retention-volume', 'partition-coefficient', 'column.phi', 'hetp'],
  },

  'partition-coefficient': {
    term: 'Partition coefficient (K)',
    short: 'The ratio of what is in the particle to what is in the surrounding liquid at equilibrium.',
    why: 'The single number that connects the isotherm to the retention volume. Because it includes both adsorbed material and pore liquid, it never falls below the accessible porosity even for a completely non-binding species.',
    typical: 'dimensionless. 0.85 unretained; 2–3 at the elution salt; thousands under load conditions.',
    seeAlso: ['k-prime', 'retardation-factor', 'sma', 'retention-volume'],
  },

  'retardation-factor': {
    term: 'Retardation factor (R)',
    short: 'How many times slower a species moves than the liquid carrying it: R = 1 + k′.',
    why: 'It is the direct statement of band velocity, and it is what the numerical solver actually integrates. A retardation factor of 6 means the band moves at one sixth of the interstitial velocity.',
    typical: 'dimensionless, always at least 1.',
    seeAlso: ['k-prime', 'linear-velocity', 'courant-number'],
  },

  'kav': {
    term: 'Available partition coefficient (K_av)',
    short: 'A size-exclusion species\' retention normalised between the void volume and the total column volume.',
    why: 'It is what a SEC calibration curve is plotted against. Because it is bounded between 0 (fully excluded) and 1, it strips out column geometry and makes selectivity comparable between columns and media.',
    typical: 'dimensionless 0–1. Plotted against log molecular weight it gives a straight line over the fractionation range.',
    seeAlso: ['sec', 'kd-partition', 'void-volume', 'retention-volume'],
  },

  'linear-velocity': {
    term: 'Linear velocity (u)',
    short: 'Flow divided by column cross-section: how fast the front moves down the bed.',
    why: 'The scale-invariant way to state flow. A resin datasheet is written in cm/h because 150 cm/h means the same thing on a 1 cm column and a 60 cm one, whereas 200 mL/min does not.',
    typical: 'cm/h. 100–300 for preparative agarose; 30 for SEC.',
    seeAlso: ['flow-rate', 'residence-time', 'column.id_cm', 'pressure-drop'],
  },

  'flow-rate': {
    term: 'Volumetric flow (Q)',
    short: 'The volume of liquid moving past a point per unit time.',
    why: 'What the pump is actually told to do, and what every totaliser integrates. It is the least transferable way to state flow — the same volumetric flow is a gentle trickle on one column and a bed-crushing torrent on another.',
    typical: 'mL/min. 196 mL/min is 150 cm/h on a 10 cm column.',
    seeAlso: ['linear-velocity', 'residence-time', 'FT-101', 'skid.Qmax_mLs'],
  },

  'residence-time': {
    term: 'Residence time',
    short: 'How long a given element of liquid spends in the column: column volume divided by flow.',
    why: 'The number that actually governs binding, because adsorption is rate-limited. It is the parameter held constant on scale-up: the same residence time on a bigger column gives the same breakthrough behaviour and the same peak shapes.',
    typical: 'min. 4–10 for capture; 8 min at 150 cm/h on a 20 cm bed.',
    seeAlso: ['linear-velocity', 'flow-rate', 'dbc', 'mass-transfer-coefficient'],
  },

  'pctB': {
    term: 'Percent B (%B)',
    short: 'The fraction of the stream coming from the B inlet rather than the A inlet.',
    why: 'The commanded value and the value at the column inlet are not the same thing: the blend has to traverse the mixer and the gradient hold-up first. The trace worth watching is the one derived from the salt actually arriving at the column.',
    typical: 'percent 0–100. Accuracy about ±1 %B in the 5–95 range.',
    seeAlso: ['proportioner', 'gradient-slope', 'M-101', 'modulator'],
  },

  'gradient-slope': {
    term: 'Gradient slope (g)',
    short: 'How fast the modulator concentration rises per unit of volume delivered.',
    why: 'The main lever on both resolution and dilution. Halving the slope moves every peak later and separates them further, at the cost of twice the buffer and a more dilute pool. A useful invariant: the slope times the adsorbent volume is constant across scales, so a gradient specified in CV transfers unchanged.',
    typical: 'mM per mL, or more usefully M per CV. 0.45 M over 20 CV = 0.0225 M/CV.',
    seeAlso: ['block.gradient', 'band-compression', 'modulator', 'resolution'],
  },

  'band-compression': {
    term: 'Band compression',
    short: 'The self-sharpening that a gradient produces: the front of a band sees weaker eluent and slows down while the tail catches up.',
    why: 'It is why gradient peaks are two to three times narrower than the same species run isocratically at its elution salt, and it is the reason gradient elution is worth its complexity. It comes free from the physics; nothing has to model it explicitly.',
    typical: 'Narrows a peak by a factor of roughly 2–3 relative to the isocratic estimate.',
    seeAlso: ['gradient-slope', 'peak-width-w50', 'resolution'],
  },

  'modulator': {
    term: 'Modulator',
    short: 'The species whose concentration controls how strongly everything else binds — usually salt.',
    why: 'The whole strategy of bind-and-elute chromatography is to change one variable that everything responds to differently. On ion exchange, raising salt weakens binding; on hydrophobic interaction, LOWERING it does. Getting the direction wrong reverses the whole method.',
    typical: 'Sodium 50 → 500 mM for the shipped CEX gradient; ammonium sulfate 1.2 → 0 M for HIC.',
    seeAlso: ['gradient-slope', 'sma', 'hic-isotherm', 'CE-101'],
  },

  'tracer': {
    term: 'Tracer',
    short: 'A small, non-binding, UV-visible molecule injected to characterise the column rather than to purify anything.',
    why: 'It is how a bed is measured. Because it binds to nothing and fits everywhere, its retention volume must equal the total liquid volume and its peak width reports the packing quality directly, with no chemistry in the way.',
    typical: 'Acetone or a salt pulse. Should elute at 0.9025 CV on this geometry.',
    seeAlso: ['packing-test', 'column.epsT', 'hetp', 'IV-101'],
  },

  /* ===========================================================================================
   * ISOTHERMS AND THERMODYNAMICS
   * =========================================================================================*/

  'sma': {
    term: 'Steric mass action (SMA)',
    short: 'The ion-exchange isotherm in which a bound protein displaces a fixed number of salt counter-ions and sterically shields more.',
    why: 'It is the model that gets ion exchange right, because it makes binding depend on salt through a physical mechanism rather than a fitted curve. The three parameters have direct meanings, and the salt dependence they predict is a power law that matches real gradient elution over orders of magnitude.',
    typical: 'Characteristic charge 3–10 for proteins; steric factor tens to thousands; equilibrium constant spanning several decades.',
    seeAlso: ['sma-nu', 'sma-sigma', 'sma-keq', 'ionic-capacity', 'column.isothermMode'],
  },

  'sma-nu': {
    term: 'Characteristic charge (ν)',
    short: 'How many resin charges one bound protein molecule occupies — the number of salt ions it displaces.',
    why: 'It controls how STEEPLY binding responds to salt: binding strength falls as salt to the power ν. A species with ν = 9 comes off much later and much more sharply than one with ν = 3.5, and the elution ORDER on a gradient is largely set by this number.',
    typical: 'dimensionless. 3.5–9 for the shipped proteins; over 20 for DNA.',
    seeAlso: ['sma', 'sma-sigma', 'gradient-slope', 'modulator'],
  },

  'sma-sigma': {
    term: 'Steric factor (σ)',
    short: 'How many extra resin charges a bound protein covers without actually using them.',
    why: 'It is what turns capacity from a charge count into a surface-area count. A large protein blocks far more ligands than it binds, so the saturation capacity is the ionic capacity divided by the sum of the characteristic charge and this — which is why an antibody has far less molar capacity than a small protein.',
    typical: 'dimensionless. 69 for a 25 kDa impurity, 575 for an IgG, 1473 for its dimer.',
    seeAlso: ['sma', 'sma-nu', 'static-capacity'],
  },

  'sma-keq': {
    term: 'Equilibrium constant (K_eq)',
    short: 'The intrinsic affinity of the protein for the resin, independent of how much salt is present.',
    why: 'It shifts the whole elution position without changing its salt sensitivity — a species with the same characteristic charge but a hundred-fold higher equilibrium constant simply elutes later. It is the parameter that separates two proteins of similar size and charge.',
    typical: 'dimensionless, spanning decades. 0.018 to 1.33 across the shipped species.',
    seeAlso: ['sma', 'sma-nu', 'retention-volume'],
  },

  'langmuir': {
    term: 'Langmuir isotherm',
    short: 'Binding to a finite number of independent sites: the classic saturating adsorption curve.',
    why: 'The workhorse model for affinity and hydrophobic media. It captures the one behaviour that matters most in preparative work — that capacity is finite, so overloading pushes material straight through the bed — with two parameters and no iteration.',
    typical: 'Saturation capacity in g/L of adsorbent; affinity in litres per mole.',
    seeAlso: ['hic-isotherm', 'static-capacity', 'dbc', 'column.isothermMode'],
  },

  'hic-isotherm': {
    term: 'Hydrophobic interaction isotherm',
    short: 'A Langmuir model whose affinity rises exponentially with salt concentration.',
    why: 'HIC runs backwards from ion exchange: high salt promotes binding and the gradient goes DOWN. The exponential salt dependence is why HIC selectivity is so sharp, and why a load conditioned to slightly the wrong salt breaks through immediately.',
    typical: 'Salting-out exponent around 8 L/mol; loads at 1.0–1.5 M ammonium sulfate.',
    seeAlso: ['langmuir', 'modulator', 'gradient-slope', 'column.isothermMode'],
  },

  'sec': {
    term: 'Size exclusion (SEC)',
    short: 'Separation by size alone: larger molecules reach less of the pore volume and elute earlier.',
    why: 'The only mode here with no adsorption at all, which makes it the gentlest and the least concentrating. Everything elutes within one column volume, so resolution has to come from a long bed and a slow flow — which is why prep SEC columns are tall and slow.',
    typical: 'Everything elutes between the void volume (0.35 CV) and the total liquid volume (0.9 CV).',
    seeAlso: ['kav', 'kd-partition', 'species.epsPi', 'column.rPore_cm'],
  },

  'donnan': {
    term: 'Donnan exclusion',
    short: 'The fixed charge on an ion exchanger pulls counter-ions into the pores and pushes co-ions out.',
    why: 'It is why the pore liquid of an ion exchanger is never at the same composition as the bulk, and why a salt front on an ion exchanger does not travel at the same speed as an inert tracer. Ignoring it puts the conductivity trace visibly in the wrong place.',
    typical: 'At 50 mM bulk salt on a 350 mM resin, pore sodium is ~355 mM and pore chloride ~5 mM.',
    seeAlso: ['counter-ion', 'co-ion', 'column.Lambda_mM', 'column.enableDonnan'],
  },

  'counter-ion': {
    term: 'Counter-ion',
    short: 'The mobile ion whose charge is OPPOSITE to the resin\'s fixed charge, so it is drawn into the pores.',
    why: 'It is the ion the protein has to displace in order to bind, which makes it the modulator. On a cation exchanger that is sodium; flip the resin to an anion exchanger and chloride takes the role, with no change to the underlying model.',
    typical: 'Sodium on a cation exchanger; chloride on an anion exchanger.',
    seeAlso: ['co-ion', 'donnan', 'modulator', 'column.resinChargeSign'],
  },

  'co-ion': {
    term: 'Co-ion',
    short: 'The mobile ion carrying the SAME sign as the resin, so it is largely excluded from the pores.',
    why: 'Its exclusion is what makes the pore electroneutral, and the difference between counter-ion and co-ion loading is exactly the fixed charge. Buffers count here too: at pH 5 most of an acetate buffer is ionised, and treating it as fully or not at all ionised throws the charge balance out by tens of percent.',
    typical: 'Chloride and ionised buffer anions on a cation exchanger.',
    seeAlso: ['counter-ion', 'donnan', 'pka', 'AcT'],
  },

  'ionic-capacity': {
    term: 'Ionic capacity',
    short: 'How many charged ligands a resin carries per unit volume.',
    why: 'The fundamental capability of an ion exchanger. Vendors quote it per millilitre of packed bed, while models work per millilitre of bead — a factor of about 1.5 between them, and the most common single unit error in ion-exchange modelling.',
    typical: 'mmol per mL of packed bed. 0.2–0.25 for agarose ion exchangers.',
    seeAlso: ['column.Lambda_mM', 'sma', 'static-capacity', 'donnan'],
  },

  'static-capacity': {
    term: 'Static binding capacity',
    short: 'The maximum a resin can hold at equilibrium, with unlimited time and unlimited protein.',
    why: 'The theoretical ceiling. It is always higher than what a column actually achieves, because a real load has a finite residence time, and the gap between the two is entirely a mass-transfer story.',
    typical: 'g/L of packed bed. ~58 g/L for an IgG on this SP resin.',
    seeAlso: ['dbc', 'sma-sigma', 'load-challenge', 'breakthrough'],
  },

  'dbc': {
    term: 'Dynamic binding capacity (DBC)',
    short: 'How much the column actually holds before product starts appearing in the flow-through.',
    why: 'The number that decides how much can be processed per cycle, and it depends on residence time: run the load faster and the DBC falls, because the protein has less time to diffuse into the beads. It is always quoted at a stated breakthrough percentage and residence time, or it means nothing.',
    typical: 'g/L of packed bed at 10 % breakthrough. Typically 50–80 % of the static capacity.',
    seeAlso: ['static-capacity', 'breakthrough', 'residence-time', 'load-challenge'],
  },

  'breakthrough': {
    term: 'Breakthrough',
    short: 'Product appearing in the column effluent during loading because the bed can no longer hold it.',
    why: 'The direct measurement of dynamic capacity, and the failure mode that costs yield silently — the flow-through goes to waste, so nobody sees it unless the UV is being watched during load. The sharpness of the front reports the mass-transfer rate.',
    typical: 'Reported at 1 %, 5 % or 10 % of the feed concentration.',
    seeAlso: ['dbc', 'load-challenge', 'mass-transfer-coefficient', 'yield'],
  },

  /* ===========================================================================================
   * MASS TRANSFER AND TRANSPORT
   * =========================================================================================*/

  'mass-transfer-coefficient': {
    term: 'Overall mass-transfer coefficient (k_ov)',
    short: 'How fast a molecule can get from the flowing liquid into the interior of a bead.',
    why: 'The dominant cause of peak broadening in preparative chromatography, and the reason large proteins give wide peaks on large beads. It combines a film resistance at the bead surface with a pore-diffusion resistance inside; for proteins on 90 µm beads the pore term is 30 to 120 times larger.',
    typical: 'per second. 0.008 (an aggregate) to 3 (a small tracer); antibodies around 0.03.',
    seeAlso: ['film-diffusion', 'pore-diffusion', 'hetp', 'column.dp_cm'],
  },

  'film-diffusion': {
    term: 'Film diffusion',
    short: 'The resistance of the stagnant liquid layer clinging to the outside of each bead.',
    why: 'It is the only part of mass transfer that flow can improve: faster flow thins the film. For proteins on preparative media it is a small fraction of the total, which is why running slower helps far more than running faster hurts.',
    typical: '1–35 % of the total resistance; about 3 % for an antibody on 90 µm beads.',
    seeAlso: ['mass-transfer-coefficient', 'pore-diffusion', 'linear-velocity'],
  },

  'pore-diffusion': {
    term: 'Pore diffusion',
    short: 'The resistance to moving through the tortuous, crowded channels inside a bead.',
    why: 'It dominates everything for proteins, and it scales with the SQUARE of the bead radius — which is the entire reason small beads give sharp peaks and large beads give broad ones. It is also why a molecule near the pore size moves far slower inside than it does in free solution.',
    typical: 'Pore diffusivity is typically 5–65 % of free-solution diffusivity.',
    seeAlso: ['mass-transfer-coefficient', 'hindrance', 'tortuosity', 'column.dp_cm'],
  },

  'hindrance': {
    term: 'Hindrance factor',
    short: 'How much a pore slows a molecule simply because the molecule is a significant fraction of the pore width.',
    why: 'It is pure geometry, and it is brutal: a molecule at half the pore radius barely moves. It is why pore size is chosen relative to the target, and why an aggregate — twice the size of the monomer — has a diffusivity many times lower inside the bead.',
    typical: 'dimensionless 0–1. About 0.76 for a small protein in 30 nm pores; near zero once the molecule approaches the pore size.',
    seeAlso: ['pore-diffusion', 'column.rPore_cm', 'species.epsPi', 'sec'],
  },

  'tortuosity': {
    term: 'Tortuosity',
    short: 'How much longer the winding path through a bead is than a straight line across it.',
    why: 'Together with hindrance it converts a free-solution diffusivity into a pore diffusivity. It rises sharply as porosity falls, so a denser bead is disproportionately slower, not just proportionally.',
    typical: 'dimensionless. About 1.8 at a porosity of 0.85.',
    seeAlso: ['pore-diffusion', 'column.epsP', 'hindrance'],
  },

  'axial-dispersion': {
    term: 'Axial dispersion',
    short: 'The spreading of a band along the column axis caused by the flow splitting and rejoining around beads.',
    why: 'One of the three terms of the van Deemter equation, and the one that reports packing quality. In a well-packed preparative bed it is much smaller than mass-transfer broadening; when it is not, the bed is the problem.',
    typical: 'Roughly half the particle diameter times the interstitial velocity.',
    seeAlso: ['hetp', 'column.lambdaPack', 'packing-test'],
  },

  'courant-number': {
    term: 'Courant number',
    short: 'How far the fluid moves in one solver time step, measured in grid cells.',
    why: 'The stability and accuracy criterion of the numerical scheme. Below one the solution is stable but artificially smeared; at exactly one the smearing vanishes; above one it is unstable. This is why the solver takes larger, less frequent column steps rather than small ones.',
    typical: 'dimensionless, targeted just below 1.',
    seeAlso: ['column.nuTarget', 'column.nz', 'axial-dispersion', 'speed-deficit'],
  },

  /* ===========================================================================================
   * HYDRAULICS
   * =========================================================================================*/

  'pressure-drop': {
    term: 'Pressure drop',
    short: 'The pressure needed to push liquid through a resistance — the bed, the frits, the filter or the tubing.',
    why: 'The constraint that limits preparative chromatography more often than chemistry does. It rises with flow, with viscosity and with the inverse square of bead size, and on a compressible medium it rises faster than linearly because the bed itself deforms.',
    typical: 'bar. ~0.2 bar across a pilot bed at 150 cm/h; alarms from 0.6 bar.',
    seeAlso: ['blake-kozeny', 'PDT-101', 'viscosity', 'bed-compression'],
  },

  'blake-kozeny': {
    term: 'Blake–Kozeny equation',
    short: 'The laminar-flow pressure-drop law for a packed bed.',
    why: 'It gives the four scalings that govern every practical decision: pressure is proportional to flow, to viscosity and to bed height, and inversely proportional to the square of bead diameter. It also depends very strongly on porosity, which is why bed compression matters so much.',
    typical: 'Valid while the particle Reynolds number stays below about 1 — true for every preparative condition here.',
    seeAlso: ['pressure-drop', 'column.kKozeny', 'column.dp_cm', 'bed-compression'],
  },

  'bed-compression': {
    term: 'Bed compression',
    short: 'Soft beads deforming under flow, squeezing the space between them.',
    why: 'The runaway that limits soft-gel chromatography: more flow gives more pressure, which gives less void, which gives still more pressure. It is why pressure versus flow curves upward on agarose, and why a resin has a maximum linear velocity that depends on bed height.',
    typical: 'Porosity falls from 0.35 toward a limit near 0.26 with a characteristic pressure around 2 bar.',
    seeAlso: ['bed-collapse', 'column.compression', 'pressure-drop', 'column.epsC'],
  },

  'bed-collapse': {
    term: 'Bed collapse',
    short: 'The point at which compression runs away and the bed loses its structure entirely.',
    why: 'The end of the column\'s useful life: flow drops to nearly nothing, pressure spikes, and the bed must be repacked. It is latched as a fault because there is no recovery from it within a run.',
    typical: 'Modelled above 20 bar of bed pressure — far beyond any legal operating point.',
    seeAlso: ['bed-compression', 'PDT-101', 'quality-flags'],
  },

  'viscosity': {
    term: 'Viscosity',
    short: 'The resistance of the liquid itself to flowing.',
    why: 'It multiplies pressure drop directly and divides diffusivity directly, so it moves both the pressure trace and the peak widths. Buffer at 4 °C is about 54 % more viscous than at 20 °C, and 20 % ethanol nearly doubles it — which is why cold rooms and storage solutions surprise people.',
    typical: 'cP. Water 1.002 at 20 °C, 0.890 at 25 °C, 1.547 at 4 °C.',
    seeAlso: ['jones-dole', 'pressure-drop', 'TT-101', 'mass-transfer-coefficient'],
  },

  'jones-dole': {
    term: 'Jones–Dole viscosity',
    short: 'How dissolved salts change the viscosity of water.',
    why: 'It is why the top of a salt gradient shows a slightly higher pressure than the bottom, at identical flow. Some ions structure water and thicken it, others break structure and thin it, so the effect is not always in the direction people expect.',
    typical: 'A few percent at half-molar salt; over 25 % at 1.2 M ammonium sulfate.',
    seeAlso: ['viscosity', 'pressure-drop', 'modulator'],
  },

  /* ===========================================================================================
   * SOLUTION CHEMISTRY
   * =========================================================================================*/

  'conductivity': {
    term: 'Conductivity',
    short: 'How well the solution carries electric current, which is a direct proxy for its ionic content.',
    why: 'The practical way to watch a salt gradient in real time. It is not linear in concentration — ion mobility falls as solutions get crowded — so a straight salt ramp shows as a slightly curved conductivity trace, which is correct and not an instrument fault.',
    typical: 'mS/cm. 1 M NaCl reads 85 mS/cm, not the 126 that a linear extrapolation from dilute would suggest.',
    seeAlso: ['CE-101', 'temperature-compensation', 'ionic-strength', 'modulator'],
  },

  'temperature-compensation': {
    term: 'Conductivity temperature compensation',
    short: 'Correcting a conductivity reading back to a reference temperature, normally 25 °C.',
    why: 'Conductivity rises about 2 % per degree, so an uncompensated reading tells you as much about the room as about the buffer. The correction is deliberately imperfect here: the meter compensates linearly while the physics is quadratic, so a 5 °C stream reads roughly 10 % HIGH. That is a real instrument artefact, not a bug.',
    typical: 'About 2.14 % per °C. Reliable between about 2 and 30 °C.',
    seeAlso: ['conductivity', 'CE-101', 'TT-101'],
  },

  'ph': {
    term: 'pH',
    short: 'The negative logarithm of the hydrogen ion concentration.',
    why: 'It sets the charge on every protein and therefore whether it binds at all. Half a pH unit can be the difference between a capture step and a flow-through step, which is why a mis-titrated buffer is one of the most damaging errors possible.',
    typical: 'pH units. 5.00 for the shipped CEX buffers; 13.7 true for 0.5 M NaOH.',
    seeAlso: ['AE-101', 'pka', 'davies', 'buffer-capacity'],
  },

  'pka': {
    term: 'pKa',
    short: 'The pH at which a titratable group is half ionised.',
    why: 'It decides where a buffer actually buffers, and how much of it carries charge at the working pH. It also moves: with ionic strength, through activity effects, and with temperature — a Tris buffer made at room temperature is a different buffer in a cold room.',
    typical: 'Acetate 4.76, phosphate 7.20, Tris 8.06 at 25 °C. Tris shifts −0.028 per °C.',
    seeAlso: ['buffer-capacity', 'davies', 'ph', 'co-ion'],
  },

  'buffer-capacity': {
    term: 'Buffer capacity',
    short: 'How much acid or base a buffer can absorb before its pH moves.',
    why: 'A buffer used more than about one pH unit from its pKa has almost no capacity and will not hold the column at the pH you intended. Choosing a buffer by its pKa rather than by habit is one of the highest-value decisions in method development.',
    typical: 'Useful within about ±1 pH unit of the pKa; 20–50 mM is typical.',
    seeAlso: ['pka', 'ph', 'TK-EQ'],
  },

  'ionic-strength': {
    term: 'Ionic strength',
    short: 'A charge-weighted measure of total ion content that determines how ions interact with each other.',
    why: 'It, not concentration, is what shifts pKa values and activity coefficients. A divalent ion contributes four times as much as a monovalent one at the same concentration, which is why a phosphate buffer behaves very differently from an acetate one at the same molarity.',
    typical: 'mol/L. Equal to the salt concentration for a 1:1 salt; 0.05–0.5 across the shipped gradient.',
    seeAlso: ['davies', 'conductivity', 'pka'],
  },

  'davies': {
    term: 'Davies activity correction',
    short: 'The correction for ions not behaving ideally once the solution is crowded.',
    why: 'It is why a buffer titrated by calculation and a buffer titrated at the bench do not agree: ignoring activity gets the required titrant wrong by several millimolar, which shifts the starting salt and therefore every retention volume. It is mandatory here for exactly that reason.',
    typical: 'Applied up to about 0.5 mol/L ionic strength; shifts the acetate pKa from 4.76 to about 4.59 at 0.05 M.',
    seeAlso: ['ionic-strength', 'pka', 'ph'],
  },

  /* ===========================================================================================
   * UV DETECTION
   * =========================================================================================*/

  'beer-lambert': {
    term: 'Beer–Lambert law',
    short: 'Absorbance equals extinction coefficient times concentration times pathlength.',
    why: 'The basis of every UV measurement, and the reason a preparative detector needs a very short pathlength: the same concentration that reads a comfortable 0.5 AU in a 1 mm analytical cell reads 35 AU in a 10 mm one. It also stops being linear once the detector runs out of dynamic range.',
    typical: 'Antibody extinction 1.42 L/g/cm at 280 nm; detectors are linear to about 2 AU.',
    seeAlso: ['extinction-coefficient', 'pathlength', 'stray-light', 'UV-101'],
  },

  'extinction-coefficient': {
    term: 'Extinction coefficient (ε)',
    short: 'How strongly a species absorbs light at a given wavelength, per gram per litre per centimetre.',
    why: 'It converts absorbance into concentration, and it differs between species — which is what makes multi-wavelength ratios diagnostic. Aggregates scatter as well as absorb, so they read disproportionately high at longer wavelengths, and that is a usable turbidity signal.',
    typical: 'L/g/cm at 280 nm. 1.42 for an IgG, 1.48 for its aggregate, 10 for DNA.',
    seeAlso: ['beer-lambert', 'uv-ratio', 'UV-101'],
  },

  'pathlength': {
    term: 'Flow-cell pathlength',
    short: 'The optical distance the beam travels through the sample.',
    why: 'The one parameter that decides whether a preparative peak fits on the detector\'s scale. Because it appears linearly in Beer–Lambert, changing the cell rescales every absorbance reading — which is exactly why every threshold in this program is stored per centimetre.',
    typical: 'mm. 0.2 for concentrated streams; 2–10 for analytical or dilute ones.',
    seeAlso: ['beer-lambert', 'skid.uv.pathlength_cm', 'watch.threshold'],
  },

  'stray-light': {
    term: 'Stray light',
    short: 'Light that reaches the detector without passing through the sample, setting a hard ceiling on measurable absorbance.',
    why: 'Real photometers roll over smoothly rather than clipping, and this is why. At 0.3 % stray light nothing above about 2.5 AU can be measured no matter how concentrated the sample, and readings become progressively too low well before that.',
    typical: 'Fraction. 3.0e-3, giving −5.6 % error at 2 AU and a 2.52 AU ceiling.',
    seeAlso: ['beer-lambert', 'UV-101', 'quality-flags'],
  },

  'autozero': {
    term: 'Autozero',
    short: 'Setting the current absorbance reading as the new zero.',
    why: 'It removes the lamp drift, the cell fouling and the buffer background that would otherwise sit under the whole run. It must be done on a genuinely stable baseline in a known buffer — zeroing during a gradient or with a bubble in the cell bakes a permanent offset into every subsequent reading.',
    typical: 'Once per run, at the end of equilibration.',
    seeAlso: ['UV-101', 'block.autozero', 'quality-flags'],
  },

  'uv-ratio': {
    term: 'A260/A280 ratio',
    short: 'The ratio of absorbance at two wavelengths, which reports what kind of material is passing.',
    why: 'A pure protein sits near 0.55; nucleic acid sits near 2.0. Watching the ratio across a peak is how DNA contamination or a shifting impurity profile is spotted without an offline assay. It is meaningless at low absorbance, where it is a ratio of two noise signals.',
    typical: 'dimensionless. Undefined below about 10 mAU.',
    seeAlso: ['extinction-coefficient', 'UV-101', 'purity'],
  },

  'ri-artifact': {
    term: 'Refractive index artefact',
    short: 'A transient wobble on the UV trace caused by a sharp change in solution composition, not by anything absorbing.',
    why: 'It is why a salt step produces a visible blip on a UV trace that should be blind to salt. Recognising it prevents a phantom peak from being pooled, and its size scales with how fast the conductivity is changing, not with how high it is.',
    typical: 'A few mAU on a steep step; proportional to the rate of conductivity change.',
    seeAlso: ['UV-101', 'conductivity', 'quality-flags'],
  },

  /* ===========================================================================================
   * FLOW-PATH DYNAMICS
   * =========================================================================================*/

  'delay-volume': {
    term: 'Delay volume',
    short: 'The liquid volume between where something happens and where it is observed or acted on.',
    why: 'The single most important non-obvious fact about a chromatography skid. The UV cell is a real distance downstream of the column, and the fraction valve is a further distance downstream of the UV cell. Every decision has to be scheduled on VOLUME, not time, because the same volume takes a different time at a different flow.',
    typical: 'UV to fraction valve: 15.5 % of a column volume at lab scale, 3.2 % at pilot, 2.6 % at process.',
    seeAlso: ['holdup-volume', 'frac.delayCompensation', 'skid.holdup', 'DV-101'],
  },

  'holdup-volume': {
    term: 'Hold-up volume',
    short: 'The liquid that a given section of the flow path contains.',
    why: 'Hold-up delays everything and blurs everything. It is why an inlet switch does not reach the column immediately, why the first fraction contains the previous stream, and why a small lab column can be dominated by the tubing around it.',
    typical: 'mL. Gradient path 3.8 / 245 / 3940 mL by scale.',
    seeAlso: ['delay-volume', 'tanks-in-series', 'skid.holdup', 'dead-leg'],
  },

  'tanks-in-series': {
    term: 'Tanks-in-series model',
    short: 'Representing a length of tubing or a mixer as a chain of small perfectly stirred vessels.',
    why: 'It is how a piece of hardware gets both its delay and its smearing from a single pair of numbers. One large tank smears heavily; many small ones behave almost like plug flow. It is what lets a mixer and a length of tubing be described by the same model.',
    typical: 'Plate counts of 1 (a stirred mixer) to 15 (a long thin line).',
    seeAlso: ['holdup-volume', 'M-101', 'skid.mixerN', 'delay-volume'],
  },

  'dead-leg': {
    term: 'Dead leg',
    short: 'Trapped volume between the fraction valve and the collection vessel that is not swept by the main flow.',
    why: 'It carries the previous stream into the start of every new fraction. On a small fraction it can be a significant proportion of the volume, so it directly degrades the purity of a narrow cut — and it is invisible unless it is modelled.',
    typical: 'mL. 0.35 / 18 / 250 by scale.',
    seeAlso: ['frac.deadLegPolicy', 'DV-101', 'purity', 'cross-fade'],
  },

  'cross-fade': {
    term: 'Valve cross-fade',
    short: 'The period during a valve movement when flow is split between the outgoing and incoming ports.',
    why: 'It is why fraction boundaries are not perfectly sharp. The volume delivered during the move is split between two vessels, and a fraction only a few switch times long is mostly cross-over rather than a clean cut.',
    typical: 'Lasts one valve switch time; the overlap volume is split evenly.',
    seeAlso: ['skid.fracValve.tSwitch_s', 'DV-101', 'frac.minFractionVolume'],
  },

  'hpgf': {
    term: 'High-pressure gradient forming',
    short: 'Two metering pumps, each on its own buffer, blending downstream of the pump heads.',
    why: 'Accurate and fast: the blend is set by two flow rates, so the gradient is as good as the pumps and almost no mixing volume is needed. It costs a second pump, which is why it is a laboratory-scale choice.',
    typical: 'Accuracy about ±1 %B; mixer needed only to smooth stroke ripple.',
    seeAlso: ['lpgf', 'skid.gradientMode', 'M-101', 'proportioner'],
  },

  'lpgf': {
    term: 'Low-pressure gradient forming',
    short: 'One pump drawing through a chopper valve that alternates between the buffers on the suction side.',
    why: 'The economical choice at scale, because one large pump is very much cheaper than two. The blend arrives as a square wave, so a mixing chamber is mandatory — and the residual ripple gets WORSE at high flow and with a small mixer, which is the opposite of most people\'s intuition.',
    typical: 'Residual ripple 0.4–5 %B depending on flow and mixer size.',
    seeAlso: ['hpgf', 'M-101', 'skid.chopPeriod_s', 'ripple', 'proportioner'],
  },

  'proportioner': {
    term: 'Gradient proportioner',
    short: 'Whatever mechanism sets the ratio of buffer A to buffer B.',
    why: 'It is never perfect. There is a fixed bias that differs run to run, a slow random walk on top of it, and on a chopper system a quantisation limit set by the minimum valve opening time. Those imperfections are why two runs of the same method are never bit-identical on a real skid.',
    typical: 'Bias about ±0.4 %B per run; quantisation 2–4 %B on a chopper valve.',
    seeAlso: ['pctB', 'hpgf', 'lpgf', 'ripple'],
  },

  'ripple': {
    term: 'Ripple',
    short: 'The periodic fluctuation in flow, pressure or composition left over from a pump stroke or a chopper valve.',
    why: 'It is real, it is visible on the pressure trace, and it is essentially absent from the UV and conductivity traces because their output filters remove it. That difference between traces is itself a useful clue about where a fluctuation is coming from.',
    typical: '±1.5 % on flow, ±3 % on pressure, at twice the stroke frequency (0.3–7 Hz).',
    seeAlso: ['P-101', 'skid.Vstroke_mL', 'lpgf', 'proportioner'],
  },

  /* ===========================================================================================
   * ANALYTICS AND RESULTS
   * =========================================================================================*/

  'hetp': {
    term: 'Plate height (HETP)',
    short: 'The length of column equivalent to one theoretical equilibration stage — bed height divided by plate count.',
    why: 'The standard measure of column efficiency, and the one number that summarises packing quality. Reduced against the particle diameter it becomes scale-free: a well-packed bed gives 2–3 particle diameters per plate, and anything above about 5 is a packing problem.',
    typical: 'cm, or reduced (dimensionless) as HETP divided by particle diameter. Reduced 2–3 is good.',
    seeAlso: ['plate-number', 'packing-test', 'axial-dispersion', 'mass-transfer-coefficient'],
  },

  'plate-number': {
    term: 'Plate number (N)',
    short: 'How many theoretical equilibration stages the column behaves as if it had.',
    why: 'The conventional efficiency number, usually quoted per metre so columns of different lengths can be compared. It must be measured with a small, unretained tracer, and it must be corrected for the tubing outside the column or a good bed will look bad.',
    typical: 'plates per metre. Above 10 000 is acceptable for preparative agarose; below 6 000 needs repacking.',
    seeAlso: ['hetp', 'packing-test', 'peak-width-w50', 'delay-volume'],
  },

  'peak-width-w50': {
    term: 'Peak width at half height (W50)',
    short: 'How wide the peak is halfway up.',
    why: 'The most robust width measurement available, because the half-height points are far from both the noisy baseline and the flat apex. Nearly every plate-count and resolution formula is built on it.',
    typical: 'mL or CV. 0.25–1.2 CV for the shipped proteins.',
    seeAlso: ['plate-number', 'resolution', 'asymmetry', 'band-compression'],
  },

  'resolution': {
    term: 'Resolution (Rs)',
    short: 'How well two adjacent peaks are separated: their spacing divided by their average width.',
    why: 'The single number that says whether a separation works. Below about 0.6 the peaks are one lump; 1.0 is a visible valley; 1.5 is baseline separation. Preparative aggregate removal often runs at 0.3–0.6, which is exactly why the pool cut is a genuine yield-versus-purity decision rather than an obvious one.',
    typical: 'dimensionless. 1.5 is baseline-resolved; 0.37 for monomer versus aggregate on the shipped capture step.',
    seeAlso: ['peak-width-w50', 'purity', 'pool', 'gradient-slope'],
  },

  'asymmetry': {
    term: 'Asymmetry (As)',
    short: 'The ratio of the back half of a peak to the front half, measured near the base.',
    why: 'It is the most sensitive early indicator of a bed problem. A tailing peak means channelling, a void at the top of the bed, or unwanted secondary interactions; a fronting peak usually means overload. A packing test that passes on plate count but fails on asymmetry has still failed.',
    typical: 'dimensionless. 0.8–1.8 acceptable; outside 0.7–2.0 requires repacking.',
    seeAlso: ['tailing-factor', 'packing-test', 'column.channellingFactor', 'peak-width-w50'],
  },

  'tailing-factor': {
    term: 'Tailing factor (Tf)',
    short: 'A close relative of asymmetry, measured at 5 % of peak height rather than 10 %.',
    why: 'It exists because different pharmacopoeias specify different measurements of the same idea. Quoting which one was used matters when a result is compared against a specification.',
    typical: 'dimensionless. 1.0 is symmetric; below 2.0 is normally acceptable.',
    seeAlso: ['asymmetry', 'peak-width-w50'],
  },

  'peak-max': {
    term: 'Peak maximum',
    short: 'The highest point of a peak, and the volume at which it occurs.',
    why: 'It is the concentration ceiling of the pool and the reference for any threshold expressed as a percentage of apex. It is also where a detector saturates first, so an apparently flat top is a warning that the height being reported is not the height that exists.',
    typical: 'The shipped capture elution peaks at about 8.5 g/L, reading 241 mAU at a 0.2 mm cell.',
    seeAlso: ['frac.peakMaxDetection', 'UV-101', 'stray-light', 'concentration-factor'],
  },

  'yield': {
    term: 'Step yield',
    short: 'The fraction of the loaded product that ends up in the pool.',
    why: 'Half of the fundamental trade. It is lost in four places — flow-through during load, the wash, the parts of the peak outside the cut, and the strip — and knowing which one is costing you is the whole point of watching the traces rather than only the result.',
    typical: 'percent. 85–95 % for a well-cut capture step.',
    seeAlso: ['purity', 'pool', 'mass-balance', 'breakthrough'],
  },

  'purity': {
    term: 'Purity',
    short: 'The proportion of the pooled material that is the product rather than something else.',
    why: 'The other half of the trade, and it always moves against yield. Because the real impurity profile is invisible on a UV trace, purity in the lab is inferred from peak shape and offline assays — which is precisely why a simulator that can show the true composition is a useful teaching tool.',
    typical: 'percent by mass or by area. 95–99 % after a capture step.',
    seeAlso: ['yield', 'pool', 'aggregate', 'resolution'],
  },

  'aggregate': {
    term: 'Aggregate',
    short: 'Product molecules associated into dimers and higher species.',
    why: 'The impurity that matters most for a biologic, because it drives immunogenicity. It usually elutes just after the monomer and is rarely baseline-resolved from it, so aggregate removal is almost always paid for in yield.',
    typical: 'percent of total product. 2–5 % in a harvest; specifications are typically below 1–2 %.',
    seeAlso: ['purity', 'resolution', 'pool', 'sec'],
  },

  'lrv': {
    term: 'Log reduction value (LRV)',
    short: 'How many orders of magnitude an impurity is reduced by the step.',
    why: 'The right unit for anything measured in parts per million rather than percent — DNA, host-cell protein, virus. Percent removal is useless once you are removing 99.99 %; four logs is a meaningful and comparable statement.',
    typical: 'log10 units. Above 4 is a strong clearance step.',
    seeAlso: ['purity', 'DNA', 'uv-ratio'],
  },

  'mass-balance': {
    term: 'Mass balance',
    short: 'Checking that everything that went into the column came out of it or is still inside it.',
    why: 'The audit that says whether any result can be trusted. A balance that does not close means product is being lost somewhere unaccounted for, or the model is wrong; either way, nothing downstream of it is meaningful.',
    typical: 'Should close to within one part in a million on a well-posed run.',
    seeAlso: ['yield', 'pool', 'breakthrough'],
  },

  'concentration-factor': {
    term: 'Concentration factor',
    short: 'How much more concentrated the pool is than the feed.',
    why: 'One of the main reasons to run a bind-and-elute step at all: loading dilute and eluting sharp concentrates the product, which shrinks every downstream vessel. A shallow gradient separates better but concentrates less, and that trade is often decided by the size of the next tank.',
    typical: 'dimensionless. 3–10 for a capture step; less than 1 for size exclusion.',
    seeAlso: ['pool', 'gradient-slope', 'yield', 'sec'],
  },

  'productivity': {
    term: 'Productivity',
    short: 'Grams of product per litre of resin per hour.',
    why: 'The number that decides how big a column has to be, and the one that matters commercially. It rewards short cycles and high loads, which is why capture steps are pushed toward their dynamic capacity rather than run conservatively.',
    typical: 'g/L/h. 5–30 for a capture step.',
    seeAlso: ['dbc', 'load-challenge', 'buffer-consumption', 'residence-time'],
  },

  'buffer-consumption': {
    term: 'Buffer consumption',
    short: 'Litres of buffer used per gram of product made.',
    why: 'Buffer preparation, storage and disposal are a substantial part of the cost and the footprint of a purification suite. A long wash that adds half a percent of purity may not be worth an extra ten CV of buffer at manufacturing scale.',
    typical: 'L/g. Driven by the equilibration and wash lengths more than by the gradient.',
    seeAlso: ['productivity', 'skid.wasteCapacity_mL', 'TK-EQ'],
  },

  'load-challenge': {
    term: 'Load challenge',
    short: 'How much product is applied per unit of resin volume.',
    why: 'The main productivity lever, limited by dynamic capacity. Loading above the dynamic capacity pushes product straight through into the waste; loading far below it wastes resin and time. It converts to a feed volume through the PRODUCT titre, never the total protein titre.',
    typical: 'g of product per L of packed bed. 15 g/L here, about 26 % of the static capacity.',
    seeAlso: ['dbc', 'titre', 'breakthrough', 'TK-FEED'],
  },

  'titre': {
    term: 'Titre',
    short: 'The concentration of product in the feed.',
    why: 'It converts a load challenge into a feed volume, and it must be the PRODUCT titre and not the total protein titre — using the total makes the loaded mass too low by whatever the impurity content is. Keeping the two as separate fields is what makes the divisor unambiguous.',
    typical: 'g/L. 4.25 g/L product in a 5.00 g/L total-protein harvest.',
    seeAlso: ['load-challenge', 'TK-FEED', 'load.productTiter_gL'],
  },

  'load.productTiter_gL': {
    term: 'Product titre',
    short: 'The concentration of the target molecule alone in the feed.',
    why: 'This is the divisor that turns a load challenge in grams into a feed volume in litres. The total protein titre is a different number with a different job — it sets the fouling load on the inline filter — and swapping them silently under-loads the column.',
    typical: 'g/L. 4.25 for the shipped harvest.',
    seeAlso: ['titre', 'load-challenge', 'skid.filter.kFoul_per_mg'],
  },

  'packing-test': {
    term: 'Packing test',
    short: 'A small tracer injection used to measure plate count and asymmetry before the column is trusted with product.',
    why: 'The routine qualification of a packed bed, and the correct place to catch a bad pack — after, not during, a production run. The extra-column tubing contributes real width, so a raw plate count from a small column can understate the truth by 40 %; both the raw and the corrected numbers should always be reported.',
    typical: 'Acceptable above 10 000 plates per metre with asymmetry between 0.8 and 1.8.',
    seeAlso: ['plate-number', 'hetp', 'asymmetry', 'tracer', 'delay-volume'],
  },

  'cip': {
    term: 'Cleaning in place (CIP)',
    short: 'Running caustic or another cleaning agent through the column to strip bound material and sanitise it.',
    why: 'What makes a resin economic: a hundred cycles instead of one. It also ages everything it touches — the pH electrode slope drops, the UV cell fouls slightly, and the resin\'s capacity declines — so cycle count is a tracked quantity, not an afterthought.',
    typical: '0.5 M NaOH, 3 CV, sometimes with a static hold. 80–200 validated cycles depending on the resin.',
    seeAlso: ['TK-NAOH', 'resin.maxCycles', 'AE-101', 'fouling'],
  },

  'resin.maxCycles': {
    term: 'Resin cycle life',
    short: 'The validated number of clean-and-reuse cycles the medium is qualified for.',
    why: 'It bounds the economics of the whole step, and it is a regulatory commitment as much as a technical one. Approaching it should trigger a performance review — plate count, asymmetry, dynamic capacity — rather than an automatic replacement.',
    typical: 'cycles. 80 for HIC phenyl media, 100 for agarose ion exchangers, 200 for protein A.',
    seeAlso: ['cip', 'packing-test', 'dbc', 'fouling'],
  },

  'fouling': {
    term: 'Fouling',
    short: 'Gradual accumulation of material that does not wash off, on the frit, the filter, the resin or the sensors.',
    why: 'It is slow, cumulative and easy to miss until something trips. Its signature is in WHICH pressure rises: pre-column pressure alone points at the filter or inlet frit, column differential pressure points at the bed itself.',
    typical: 'Shows as a few percent per cycle on pressure and a slow decline in capacity.',
    seeAlso: ['F-101', 'column.foulingFactor', 'PDT-101', 'cip'],
  },

  /* ===========================================================================================
   * RUN CONTROL, ALARMS AND DIAGNOSTICS
   * =========================================================================================*/

  'run-state': {
    term: 'Run state',
    short: 'What the system is doing right now, and what it will let you do next.',
    why: 'Not a label but an interlock table: each state defines what the pumps do, whether the clock advances, whether valves may move, and whether an acknowledgement is required. Some transitions are deliberately illegal — you never go straight from an alarm back to running.',
    typical: 'IDLE · READY · RUNNING · HELD · PAUSED · ALARM · ENDED · FAULT.',
    seeAlso: ['hold', 'alarm-state', 'fault', 'estop'],
  },

  'hold': {
    term: 'Hold',
    short: 'Freeze the method while keeping flow at its current setpoint.',
    why: 'The difference from a pause is the whole point: flow continues, so the column is never left static under pressure and the bed is not disturbed. The block clock and block volume freeze, while the total volume keeps counting — which is how the time spent held is later accounted for.',
    typical: 'Used at planned checkpoints and by watches that need an operator decision.',
    seeAlso: ['run-state', 'block.holdAtEnd', 'watch.action'],
  },

  'alarm-state': {
    term: 'Alarm',
    short: 'A monitored condition has been outside its limit for long enough to require a response.',
    why: 'Alarms have graded actions, not one action: warn, reduce flow, hold, pause or trip. Reducing flow when the pressure rises is the standard industrial response and keeps the run alive; tripping is reserved for conditions that threaten the equipment.',
    typical: 'Every alarm has a persistence time so that noise cannot trigger it.',
    seeAlso: ['run-state', 'flow-reduction', 'fault', 'quality-flags'],
  },

  'fault': {
    term: 'Fault',
    short: 'A condition the system cannot safely continue through.',
    why: 'Flow stops immediately, with no ramp, and the run cannot be resumed — only reset. Valve feedback mismatches and numerical failures land here, because both mean the system no longer knows its own state.',
    typical: 'Requires acknowledgement and a reset to idle.',
    seeAlso: ['run-state', 'estop', 'alarm-state'],
  },

  'estop': {
    term: 'Emergency stop',
    short: 'Immediate operator-commanded shutdown: pumps to zero, inlets closed, outlet to waste.',
    why: 'It exists to be pressed without thinking, so it has no confirmation and no undo. Recovery is a deliberate, explicit reset — which is the correct behaviour for a control that is meant to be used when something is going wrong.',
    typical: 'Ramps to zero over 0.1–1.0 s depending on scale.',
    seeAlso: ['fault', 'run-state', 'alarm-state'],
  },

  'flow-reduction': {
    term: 'Flow reduction',
    short: 'Automatically backing the flow off when pressure exceeds its alarm limit.',
    why: 'The standard industrial response to rising pressure, and much better than stopping: the run continues, takes longer in time but delivers exactly the same volume in column volumes, and the separation is preserved. Recovery is deliberately slow so the system does not oscillate.',
    typical: 'Backs off at about 50 % per second down to a 5 % floor; recovers at 5 % per second after 30 s below the warning level.',
    seeAlso: ['alarm-state', 'PDT-101', 'PT-101', 'quality-flags'],
  },

  'interlock': {
    term: 'Interlock',
    short: 'A rule that refuses an action which would damage the equipment or the column.',
    why: 'Interlocks are only useful if they explain themselves. A refusal here always comes with a reason — "no open inlet valve, deadhead protection" — because a silent refusal teaches nothing and gets worked around.',
    typical: 'Column valve movement under flow; inlet selection; pressure trip clamping.',
    seeAlso: ['CV-101', 'skid.QswitchMax_frac', 'manual-override'],
  },

  'manual-override': {
    term: 'Manual mode',
    short: 'Direct operator control of pumps, valves and the blend, outside the method.',
    why: 'Necessary for preparing, purging and troubleshooting, and available only when the method is not running. Interlocks still apply — manual mode removes the method, not the protections — and every manual action is logged.',
    typical: 'Available in idle, ready, held and paused only.',
    seeAlso: ['interlock', 'run-state', 'purge'],
  },

  'purge': {
    term: 'Purge',
    short: 'Pumping to waste with the column bypassed to clear air out of the flow path.',
    why: 'Air that has entered the lines stays there until it is deliberately removed; resuming a run without purging simply reproduces the same artefacts further downstream. Bypassing the column during a purge is what keeps the gas out of the bed.',
    typical: 'Run at high flow to waste until the air fraction returns to zero.',
    seeAlso: ['air-in-line', 'AT-101', 'manual-override'],
  },

  'air-in-line': {
    term: 'Air in the flow path',
    short: 'Gas drawn into the system, usually from a tank running dry.',
    why: 'Air destroys every measurement it touches — a large spurious UV spike, a conductivity dropout, a frozen pH reading — and it is very hard to get out of a packed bed. The alarms deliberately fire at different times as the slug travels, and that spacing is itself the diagnosis.',
    typical: 'Detected above 2 % gas fraction; the pH reading freezes above 30 %.',
    seeAlso: ['tank.emptyLevel_mL', 'AT-101', 'cavitation', 'purge', 'quality-flags'],
  },

  'cavitation': {
    term: 'Cavitation',
    short: 'The pump starving of liquid at high flow, drawing vapour or gas rather than a full charge.',
    why: 'It precedes running dry, which is exactly why it is a separate and earlier alarm: it is the warning, and dry running is the trip. It shows as erratic flow and pressure well before the tank is actually empty.',
    typical: 'Requires high flow, a low tank AND detectable gas at the inlet, all at once.',
    seeAlso: ['dry-running', 'P-101', 'tank.emptyLevel_mL', 'air-in-line'],
  },

  'dry-running': {
    term: 'Dry running',
    short: 'The pump operating with no liquid at all.',
    why: 'It damages seals and check valves within minutes, so it is a hard trip rather than a warning. It also fills the whole flow path with gas, which then has to be purged before anything can be restarted.',
    typical: 'Trips after 10 s of the condition.',
    seeAlso: ['cavitation', 'tank.emptyLevel_mL', 'purge', 'P-101'],
  },

  'quality-flags': {
    term: 'Data quality flags',
    short: 'A per-sample record of which measurements could be trusted at that moment.',
    why: 'It is what makes a result honest. A peak integrated across a period when the UV was saturated, the cell had air in it, or the detectors were bypassed is not a peak — and without a flag on the data nobody would ever know.',
    typical: 'Reported as OK, SUSPECT, INVALID or BYPASSED per sensor.',
    seeAlso: ['UV-101', 'air-in-line', 'autozero', 'stray-light'],
  },

  'speed-deficit': {
    term: 'Simulation speed limit',
    short: 'The gap between the simulation speed you asked for and the speed actually achieved.',
    why: 'The physics has a fixed cost per simulated second, so beyond some multiple the machine simply cannot keep up. Showing the achieved speed rather than silently missing the target is the honest behaviour, and it also reveals when a fine grid is the thing costing you.',
    typical: 'Shown as "1000× (limited to N×)" whenever the target is not being met.',
    seeAlso: ['column.nz', 'courant-number'],
  },
};

/**
 * Alternate ids that resolve to a canonical `GLOSSARY` key.
 *
 * Covers the P&ID's per-valve tags (which share one description), the several names each
 * instrument goes by on a real skid, and the shorthand a UI author is likely to reach for.
 * Every value here MUST be a key of `GLOSSARY`.
 *
 * @type {{[alias:string]: string}}
 */
const ALIASES = {
  // inlet valve bank — one description, four tags
  V1: 'inlet-valve', V2: 'inlet-valve', V3: 'inlet-valve', V4: 'inlet-valve',
  'XV-A': 'inlet-valve', 'XV-B': 'inlet-valve', 'XV-S': 'inlet-valve',
  'inlet.a': 'inlet-valve', 'inlet.b': 'inlet-valve', 'inlet.sample': 'inlet-valve',

  // instrument aliases
  'UV': 'UV-101', 'UV_280': 'UV-101', 'UV_260': 'UV-101', 'UV_300': 'UV-101',
  'COND': 'CE-101', 'COND_RAW': 'CE-101', 'COND_TEMP_COMP': 'CE-101',
  'PH': 'AE-101', 'FLOW': 'FT-101',
  'P1': 'PT-101', 'P2': 'PT-102', 'DP': 'PDT-101',
  'TEMP_FLUID': 'TT-101', 'TEMP_CELL': 'TT-101',
  'UV_RATIO_260_280': 'uv-ratio',
  'PCTB': 'pctB', 'AIR': 'air-in-line',
  'column-valve': 'CV-101', 'outlet-valve': 'DV-101', 'fraction-valve': 'DV-101',
  'pump': 'P-101', 'sample-pump': 'P-102', 'mixer': 'M-101',
  'filter': 'F-101', 'air-trap': 'AT-101', 'column': 'C-101',
  'collector': 'FC-101', 'injection-valve': 'IV-101',

  // concept shorthands
  'epsC': 'column.epsC', 'epsP': 'column.epsP', 'epsT': 'column.epsT',
  'phi': 'column.phi', 'phase-ratio': 'column.phi',
  'epsPi': 'species.epsPi', 'KD': 'kd-partition', 'Kav': 'kav',
  'lambda': 'column.Lambda_mM', 'Lambda': 'column.Lambda_mM',
  'nu': 'sma-nu', 'sigma': 'sma-sigma', 'Keq': 'sma-keq',
  'N': 'plate-number', 'H': 'hetp', 'Rs': 'resolution', 'As': 'asymmetry', 'Tf': 'tailing-factor',
  'W50': 'peak-width-w50', 'VR': 'retention-volume', 'V0': 'void-volume',
  'kprime': 'k-prime', "k'": 'k-prime',
  'kov': 'mass-transfer-coefficient', 'keff': 'mass-transfer-coefficient',
  'CV': 'cv', 'column-volume': 'cv',
  'dP': 'PDT-101', 'deltaP': 'PDT-101',
  'gradient': 'block.gradient', 'watch': 'watch.signal', 'fractionation': 'frac.mode',
  'load': 'load-challenge', 'feed': 'TK-FEED',
  'DNA': 'lrv', 'AcT': 'co-ion',
  'state': 'run-state', 'alarm': 'alarm-state', 'e-stop': 'estop',
};

/**
 * Case-insensitive index over `GLOSSARY` keys and `ALIASES` keys, built once at module load.
 * A plain `const` table, exactly like every other table in this file — no side effects.
 *
 * @type {Map<string, string>}
 */
const LOWER_INDEX = (() => {
  const m = new Map();
  for (const k of Object.keys(GLOSSARY)) m.set(k.toLowerCase(), k);
  for (const a of Object.keys(ALIASES)) {
    const lower = a.toLowerCase();
    if (!m.has(lower)) m.set(lower, ALIASES[a]);
  }
  return m;
})();

/**
 * Look up a glossary entry.
 *
 * Resolution order, first hit wins:
 *   1. Exact key in `GLOSSARY`.
 *   2. Exact key in `ALIASES` (e.g. `'P1'` → `'PT-101'`, `'V3'` → `'inlet-valve'`).
 *   3. Case-insensitive match against either table.
 *
 * @param {string} id  A P&ID tag (`'UV-101'`), a config path (`'column.epsC'`), a concept id
 *                     (`'hetp'`), or any alias of one of those. Any non-string is treated as a miss.
 * @returns {GlossaryEntry|null} The entry — `{ term, short, why, typical, seeAlso }`, all present
 *                     and non-empty — or `null` when nothing matches. The returned object is the
 *                     shared table entry, not a copy: never mutate it. A `null` means the UI must
 *                     NOT render an info affordance for that label (§6.22.1).
 */
export function glossaryFor(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  const direct = GLOSSARY[id];
  if (direct) return direct;
  const aliased = ALIASES[id];
  if (aliased && GLOSSARY[aliased]) return GLOSSARY[aliased];
  const key = LOWER_INDEX.get(id.toLowerCase());
  if (key && GLOSSARY[key]) return GLOSSARY[key];
  return null;
}
