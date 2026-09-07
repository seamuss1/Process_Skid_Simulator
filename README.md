# Dual Pump PID Trainer

Two parallel VFD centrifugal pumps on a common header, under PID control, simulated from physics
in your browser. Everything you see — the pump curves, the check valves, the surge vessel, the
suction margin, the motor torque, the staging sequence, the transmitters and their noise — is
solved on your machine every 20 ms. Nothing is scripted, nothing is pre-recorded, nothing is
connected to hardware.

Zero dependencies, zero build step, zero network requests.

```bash
npm start
```

Then open <http://localhost:8080>. (The app is *served* rather than opened from disk because ES
modules are CORS-blocked on the `file://` scheme.)

```bash
npm test
```

runs 174 physics and control assertions in about eight seconds.

---

## The rig

```
   TK-101 ──┬──[ STR-101 ]──[ P-101 / VFD-101 ]──[ NRV-101 ]──┐
            │                                                 ├─ HEADER ─[PCV-101]─[FCV-101]─▶
            ├──[ STR-102 ]──[ P-102 / VFD-102 ]──[ NRV-102 ]──┤    │                     process
            │                                                 │  PT / FT / TT
            └◀───────────── [ RO-101 / ARV min-flow ] ◀───────┘
```

Two identical 15 kW machines: 95 m shutoff, 45 m³/h and 72 m at best efficiency. Each has its own
strainer, non-return valve and drive. They feed a header with a bladder vessel on it, a throttle
valve, a demand valve to process, and an automatic recirculation back to the suction tank.

**PIC-101** controls header pressure. **FIC-101** controls flow to process. They are very
different loops: the pressure loop's dominant lag is the surge vessel, the flow loop's is the
drive ramp.

The controller can drive either the **VFD speed** or the **PCV throttle valve** — which is the
same duty held two ways, at two very different costs, and the whole argument for a variable-speed
drive in one switch.

---

## What it models

**The pumps.** A quadratic head-capacity curve referred to part speed by the affinity laws, in
homologous form — `H(Q, s) = s²·H₀ − s·a₁·Q − a₂·Q²`. That substitution is why a variable-speed
pump is a genuinely nonlinear final element: halving the speed does not halve the flow into a
system with static head, it stops the pump delivering at all once `s²·H₀` falls below the head the
header already stands at. Efficiency is *derived* rather than stated: the power curve is the
input, and η = P_hydraulic / P_shaft falls out of it, which is why a deadheaded pump reads zero
efficiency and still draws 45% of its best-efficiency power.

**Impeller trim, wear and viscosity** all enter the same way, as a derated machine. Trim scales
the curve like speed does (`H₀' = d²H₀`); wear opens the running clearances; viscosity is the
Hydraulic Institute 9.6.7 correction, with its own `B` parameter, and the rig will tell you when a
liquid is outside the standard's scope. Fill it with ISO VG 150 gear oil and watch head, flow and
efficiency derate together while nothing in the control system changes.

**The network.** The header holds gas, so it is a capacitance; the discharge line holds a moving
column of liquid, so it is an inertance. That makes the plant genuinely second-order in two
states, integrated with one linearly-implicit Euler step on the 2×2 system with an analytic
Jacobian. It is unconditionally stable at any step size — slam the demand valve as hard as you
like — and it means a fast closure produces a real pressure transient, because the column has to
be decelerated and pressure is the only thing available to do it with.

**The pipework.** Darcy-Weisbach with a Swamee-Jain friction factor, laminar below Re 2300 and a
blended critical zone between, so the system curve is not a parabola through the origin and the
process gain is not what a textbook says it is.

**NPSH and cavitation.** Available margin from tank pressure, static head, friction and vapour
pressure; required margin from the pump's own curve, referred by speed squared. Below the curve,
head breaks down — and the impeller eye sees the *casing* temperature rather than the tank's, so a
pump that has been running at low flow can cavitate on liquid the tank thinks is cold.

**The motors.** J·dω/dt = T_motor − T_load with a PI speed regulator, a torque limit, and an I²t
thermal overload that tolerates a large current briefly and a small overcurrent not at all. The
regulator is sub-stepped so the model is correct at any simulation step, not merely at the one it
ships with.

**Condition.** Casing temperature from a real thermal balance — which is where minimum continuous
flow comes from — vibration on the ISO 10816-3 zones, and wear that accumulates faster off-BEP and
much faster while cavitating. It only ever goes up.

**The instruments.** Dead time, first-order filtering and pink noise on every transmitter, and the
controller sees the measurement, never the truth. The trend draws both so you can see the
difference.

**The valves.** Kv on a head basis, equal-percentage or linear trim with rangeability and seat
leakage, a positioner with a stroke time, and Karnopp friction — a stickband and a slip jump — on
the final element, so a sticking valve behaves like a sticking valve rather than like a slow one.

---

## What you can do to it

### Control structures

A single PID is the start, not the end.

| | |
|---|---|
| **Cascade** | Pressure master over a flow slave. Transfers bumplessly in both directions, and the master is tracked while the slave is limited. |
| **Feedforward** | From the measured demand-valve position, through a lead-lag block, at a gain you choose. Open loop, so a wrong model is not detected — always used *with* feedback. |
| **Gain scheduling** | Interpolated against flow, output or machine count. The honest answer to a process whose gain is not constant. |
| **Setpoint reset** | Lower the demanded pressure as the flow falls, on the square law that pipe friction actually follows. The largest single saving on a variable-flow header. |
| **Override selection** | Motor current and maximum pressure on a low select, minimum flow on a high select, with integral tracking on every loser so taking over is bumpless. |

The controller itself is an ISA standard-form PID with setpoint weighting, a filtered derivative,
back-calculation anti-windup, a velocity form, a Smith predictor, and the ability to *show* its
tuning in parallel or series form — with the conversion done properly, including refusing the
series form when the standard-form tuning has complex zeros and no series equivalent exists.

### Identification

Three experiments, and the difference between what they can tell you is a lesson in itself.

- **Relay autotune** (Åström–Hägglund). Safe, quick, closed-loop, bounded by construction. Gives
  you `Ku` and `Tu` and nothing else.
- **Open-loop step test.** Disruptive and slow. Gives you a first-order-plus-dead-time model, and
  therefore a Bode plot, a predicted step response, and lambda or SIMC tuning.
- **Frequency sweep.** A lock-in amplifier: sine injection correlated over whole cycles, so it
  measures the response at frequencies where the injected signal is invisible on the trend.

Whatever you run, the published rules — Ziegler-Nichols, Tyreus-Luyben, Pessen, lambda, SIMC — are
then **simulated on the model and ranked**, with the gain and phase margin, the peak sensitivity,
the predicted overshoot and the predicted settling time for each. Every rule was derived for some
particular idea of "good", and those ideas disagree; this replaces an argument about pedigree with
a comparison.

### Analysis

Bode magnitude and phase for |L|, |S| and |T|, with the gain and phase margins marked where they
are read off. A Nyquist plot with the Ms circle, because 1/Ms is the shortest distance from the
response to the point where the loop would be unstable and that is the honest picture of
robustness. The predicted closed-loop step beside it.

### Loop health

The rig watches the loop the way a monitoring package would, and answers three questions:

- **Is it cycling, and at what period?** From the autocorrelation of the error, which sees through
  noise that zero-crossing counting cannot.
- **How close is it to the best any controller could do?** The **Harris index** — the minimum-
  variance benchmark — from routine operating data, no test and no upset. Near 1 means retuning
  cannot help; below 0.3 means a great deal is being left on the table.
- **If it is cycling, whose fault is it?** A cycle from too much gain is near-sinusoidal, because
  a linear system cannot manufacture harmonics. A cycle from a sticking valve is not: the stem
  moves in jumps, and a great deal of the power lands in the odd harmonics. The rig measures that,
  estimates the stickband directly from the output travel lost while the measurement is stalled,
  and tells you which it is — **or tells you honestly that on this loop the two are not separable
  from the data, and names the test that would settle it.**

Telling a sticking valve from a hot tuning is the single most valuable thing loop monitoring does.
Detuning a sticking valve is the commonest wrong answer in process control, and it is wrong in a
way that hides itself.

### Sequencing

Lead/lag staging on controller output, total flow, or **predicted energy** — solve the plant both
ways and stage wherever the kilowatts actually cross over, which habitually runs more pumps at
lower speed than an operator expects. Duty rotation on runtime with a make-before-break
changeover. Minimum run and stop timers. A staging bias that preloads the controller's integral at
the moment a machine joins, which is feedforward applied to a discrete event. And a **sleep mode**
that stops the set on no demand and lets the gas cushion hold the header — the largest energy
saving available on a set like this, and the easiest way to make one short-cycle.

### Disturbances

The demand valve, the discharge static head, the make-up temperature, the strainer, the tank
level, the liquid itself, the recirculation mode, the fixed speed, impeller trim, accumulated
wear, and friction in the final element. Trip a motor. Blind a strainer. Run the tank down while
warming it up.

---

## The curriculum

Fourteen guided exercises, in order, each of which arranges the rig so that a particular thing
goes wrong, states what "fixed" means in numbers, and watches until it is.

1. **Feel the process** — measure the gain and the time constant before tuning anything.
2. **Proportional only** — why every industrial controller has an integral term.
3. **Adding reset** — and what it costs you in stability.
4. **Identify the process** — relay against step test, and what each one buys.
5. **Reset windup** — and why back-calculation is the same mechanism as bumpless transfer.
6. **Derivative and noise** — why fewer than one loop in ten uses rate action.
7. **Make the set short-cycle, then stop it** — the continuous loop against the discrete sequence.
8. **Losing suction** — the failure that is not a control problem and cannot be tuned away.
9. **Minimum continuous flow** — where the datasheet number comes from, and what it protects.
10. **Cascade control** — and the factor of three that makes it work or fight.
11. **Feedforward** — and why the lead-lag matters more than the gain.
12. **Diagnose the cycle** — a valve problem that no tuning will fix.
13. **Throttle against speed** — the entire business case for a drive, in kWh/m³.
14. **Tune it for a plant that changes** — the final exam: Ms, settling and a full shift duty cycle.

Several of them cannot be passed by tuning at all, because the answer is a different control
structure or a maintenance ticket. Learning to recognise those is most of the job.

Starting a lesson resets the tuning, the sequence and the disturbances first, so nothing you did
earlier is holding the answer; leaving one puts them back.

---

## Scripted tests and the scorecard

Thirteen scripted disturbances — setpoint step, load step, staging, a shift duty cycle, a suction
upset, a deadhead, a valve slam, the wrong liquid, losing suction, a motor trip, a sticking valve,
throttle against speed, and an overnight — each graded on IAE, ITAE, overshoot, settling time,
output travel, pump starts and specific energy, with hard penalties for cavitating or running a
machine below its minimum flow. The grade breakdown is published so a disagreement about the score
is a disagreement about numbers rather than about taste.

Every completed test is filed with the settings that produced it, and the **run comparison** puts
them side by side — which is the one question a trend can never answer, because a trend only ever
shows you one run.

Everything exports: the trend as CSV, the scorecard as CSV, the comparison as CSV, and the whole
set of settings as a session file you can load back.

---

## Layout

```
index.html            the shell; boots src/ui/app.js and nothing else
styles/               tokens.css (one graphite palette) and app.css
src/
  core/util.js        maths, seeded noise, ring buffers, the event bus
  core/sim.js         the tick order, the clocks, and every action an operator may take
  data/config.js      the plant as a frozen record: what was bought and how it was ranged
  process/            fluid, pump, pipe, valve, motor, plant, alarms — physics, no control
  control/            pid, strategy, staging, autotune, analysis, diagnostics, scenario, lessons
  io/export.js        CSV, session files, the run library
  ui/                 dom, mimic, curves, trend, analysis, health, lesson, panels, app
tools/serve.js        a zero-dependency static server
tests/                174 assertions across nine suites
```

The layering is strict and one-directional: `process/` never imports `control/`, `control/` never
imports `ui/`, and nothing outside `ui/` touches the DOM. Every module states what it is for and
why it is built the way it is, at the top, in prose.

**Nothing in `src/ui` writes state.** Every control calls an action in `core/sim.js`, which
validates and may refuse with a sentence — which is what lets the rig say *"a series controller
cannot express Ti 6 s with Td 2 s"* instead of quietly accepting a tuning it will then not
implement.

---

## The tick order, and why it matters

```
1. the plant integrates on the LAST scan's outputs        (50 Hz)
2. on a scan boundary                                     (5 Hz, adjustable)
     read instruments
     → setpoint reset and gain scheduling
     → the primary controller
     → feedforward
     → the cascade slave
     → the override selector
     → the sequence starts and stops machines
     → the final element is written
     → alarms, diagnostics, scorecard, lesson
3. log the trend
```

The controller never sees a measurement that its own current output helped produce. Getting that
backwards makes every tuning look better than it is.

The scan period is on the panel because it is a real commissioning decision that almost every
simulator hides. Every scan is half a scan of pure dead time; slow it to 1 s and watch a tuning
that looked fine at 0.1 s come apart.

---

## Determinism

Every stochastic source is a seeded PRNG on its own stream. Two runs from the same seed are
bit-identical, including the transmitter noise — which is what makes "did that change help?" a
question with an answer.

---

## Keyboard

| key | |
|---|---|
| `Space` | run / freeze |
| `A` | acknowledge alarms |
| `1` `2` `3` | time compression |
| `P` | cycle the view |

---

MIT.
