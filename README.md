# Process Skid Simulator

A web-based dynamic simulator for a preparative **chromatography column skid**. Everything you see
is solved from physics on your machine: the packed bed, the buffers, the sensors, the alarms and the
fraction collector. Nothing is scripted or pre-recorded, and nothing is connected to hardware.

Zero dependencies, zero build step, zero network requests.

```bash
npm start
```

Then open <http://localhost:8080>. (The app is *served* rather than opened from disk because ES
modules are CORS-blocked on the `file://` scheme.)

```bash
npm test
```

runs 246 physics and engineering assertions in about a minute.

---

## What it models

**The column** — a transport-dispersive model with linear-driving-force mass transfer, discretised
over 400 axial cells. Three isotherms are supported:

| Isotherm | Used for |
| --- | --- |
| Steric Mass Action (SMA) | ion exchange; binding is salt-dependent, so a gradient really is what elutes the protein |
| Competitive Langmuir | multi-component binding where species compete for the same sites |
| Linear | dilute/analytical conditions and size exclusion |

The SMA equilibrium is solved per cell per step by a log-space scalar root-find with a provable
bracket, so it cannot overflow when the steric factor is large. Mass balance closes **exactly** —
the clamp ledger reports zero events on the shipped method.

**The skid** — A/B gradient proportioning with a mixer, a sample pump with direct or loop injection,
inlet select valves, an inline filter, an air trap, a column valve (bypass / down-flow / up-flow),
and a fraction collector with twelve ports plus waste. Every segment carries a realistic hold-up
volume, which is why UV, conductivity and pH each lag the column outlet by a *different* amount —
the detail that makes a simulated trace look like a real one.

**The sensors** — Beer-Lambert UV at 280/260/300 nm with stray-light saturation, drift, pink noise
and a refractive-index artefact; conductivity with temperature compensation (1 M NaCl reads
85.04 mS/cm at 25 °C); a pH electrode with a response time constant and sodium error; and pre-column,
post-column and differential pressure transducers.

**The method engine** — ordered phase blocks (equilibration, load, wash, isocratic / linear-gradient
/ step elution, strip, CIP, re-equilibration, hold) with durations in CV, mL or minutes; watch
conditions that branch on UV level, UV slope or conductivity stability; and fractionation by fixed
volume or by peak, with detector-to-valve delay compensation.

**Alarms** — a 31-row declarative table with suppression rules and custom evaluators, driving a
run state machine (Idle / Ready / Running / Held / Paused / Alarm / Ended / Fault).

## What you see

A four-tab HMI in a dark industrial theme (with a light theme):

- **Run** — an animated P&ID with live tank levels, valve positions and flow-path highlighting,
  including an axial view of the packed bed where you can watch protein bands separate and migrate;
  a multi-axis canvas chromatogram (UV ×3, conductivity, pH, %B, pressure, flow) plotted against
  volume, time or CV; the phase rail; the fraction strip; and live tag values.
- **Method** — add, reorder, edit and disable blocks, with a live gradient preview and inline
  validation.
- **Results** — peak table, drag-to-pool selection, yield, purity, HETP, asymmetry, mass balance,
  and CSV / JSON export.
- **System** — column, resin, scale and chemistry configuration, the alarm limit table, and the
  event log.

Simulation speed runs from 1× to 1000×. When the physics cannot keep up, the app says so —
`1000× (limited to N×)` — rather than quietly lying about the speed.

## Presets and scenarios

Four presets ship: a CEX IgG1 capture at pilot scale (10 × 20 cm) and at lab scale (1.6 × 20 cm),
a HIC aggregate polish on a descending salt gradient, and an SEC polish.

Eight one-click teaching scenarios each load a complete method and a specific failure mode:
textbook-clean separation, overloaded column, gradient too steep, fouled column with high ΔP, air in
the line, wrong buffer pH, cold room, and uncompensated fractionation.

The default run separates four species — a weakly bound impurity, the mAb product, an aggregate and
a strongly bound impurity — at roughly 12.9 / 18.2 / 20.7 / 26.2 column volumes.

## Layout

```
index.html          the document shell
styles/             design tokens + layout (all colour lives in tokens.css)
src/core/           units, seeded RNG, ring buffers, event log, state, the simulation loop
src/physics/        isotherms, mass transfer, the column, the bed batcher, hydraulics
src/chem/           conductivity, ionic strength, Davies activity, pH
src/skid/           topology and hold-up, fluidics, sensors, method, engine, fractionator, alarms
src/analytics/      peak detection, moments, pooling, yield and purity
src/data/           resins, species, scales, presets, scenarios, glossary
src/io/             CSV and JSON export
src/ui/             chart, P&ID, the four views, overlays, formatting, the app shell
tests/              246 assertions, Node's built-in runner, no DOM
tools/serve.js      the zero-dependency static server
```

`src/core`, `src/physics`, `src/chem`, `src/skid`, `src/analytics`, `src/data` and `src/io` never
touch the DOM, so the whole simulation core is testable under `node --test`.

About 52,000 lines in total.

## Accuracy, and where it stops

The model is built for interactive speed — roughly 2.6 ms per simulated second — so it makes
deliberate trades. It is a transport-dispersive model, not a general rate model: intraparticle
concentration profiles are lumped into a single linear-driving-force coefficient. Axial dispersion
is carried by the cell discretisation rather than an explicit dispersion term (an explicit term is
available but off by default). pH is solved from a charge balance with a Davies activity correction
rather than full speciation. Radial effects, temperature gradients along the bed, and resin ageing
across cycles are not modelled.

Ten places where the original specification was wrong are documented with derivations in the test
suite — including a mass-balance residual whose printed sign made its own tolerance unreachable, and
a gradient pH drift asserted to be monotone when equal endpoints make monotonicity impossible by
construction.

## Licence

MIT
