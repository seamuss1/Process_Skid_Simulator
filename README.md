# Dual Pump PID Trainer

Two parallel VFD centrifugal pumps on a common header, under PID control, simulated from physics
in your browser. Everything you see — the pump curves, the check valves, the surge vessel, the
suction margin, the staging sequence, the transmitters and their noise — is solved on your machine
every 20 ms. Nothing is scripted, nothing is pre-recorded, nothing is connected to hardware.

Zero dependencies, zero build step, zero network requests.

```bash
npm start
```

Then open <http://localhost:8080>. (The app is *served* rather than opened from disk because ES
modules are CORS-blocked on the `file://` scheme.)

```bash
npm test
```

runs 106 physics and control assertions in about a second.

---

## The rig

```
   TK-101 ──┬──[ STR-101 ]──[ P-101 / VFD-101 ]──[ NRV-101 ]──┐
            │                                                 ├── HEADER ──[ FCV-101 ]──▶ process
            ├──[ STR-102 ]──[ P-102 / VFD-102 ]──[ NRV-102 ]──┤     │
            │                                                 │   PT-101
            └◀────────────── [ RO-101 min-flow ] ◀────────────┘   FT-101
```

Two identical 15 kW machines: 95 m shutoff, 45 m³/h and 72 m at best efficiency. Each has its own
strainer, its own non-return valve and its own drive. They feed a header with a 120 litre bladder
vessel on it, a demand valve to process, and a minimum-flow recirculation back to the suction tank.

**PIC-101** controls header pressure. **FIC-101** controls flow to process. One button switches
between them, and they are very different loops: the pressure loop's dominant lag is the surge
vessel, the flow loop's is the drive ramp.

---

## What it models

**The pumps.** A quadratic head-capacity curve referred to part speed by the affinity laws, in
homologous form — `H(Q, s) = s²·H₀ − s·a₁·Q − a₂·Q²`. That substitution is why a variable-speed
pump is a genuinely nonlinear final element: halving the speed does not halve the flow into a
system with static head, it stops the pump delivering at all once `s²·H₀` falls below the head the
discharge already sits at. Efficiency follows the affinity laws too, so a pump run slower stays on
its efficiency island. Power, motor current and the overload relay follow from there.

**The check valves.** A pump whose shutoff head is below the header pressure delivers *exactly
zero*, and that discontinuity is reproduced rather than smoothed. It is the single most important
nonlinearity in a parallel-pump system: when the lag machine starts, the drive ramps for a second
or two with nothing happening at all, and then a second pump arrives on a header that was already
satisfied.

**The header.** Not an algebraic junction — a capacitance. The whole plant reduces to one
differential equation in one state:

```
C(H) · dH/dt = Σ Qpump(H) − Qdemand(H) − Qbypass(H)
```

with `C = ρgV_gas/p_abs` from Boyle's law on the bladder gas. Every term is closed-form: each
pump's flow is the positive root of a quadratic, each outlet a square-root orifice. Because `g(H)`
is strictly decreasing there is exactly one equilibrium and it is stable — a property of the
topology, not of the numbers, which is why this simulator never needs a solver that can fail.
Integration is one linearly-implicit Euler step with an analytic Jacobian, so it is unconditionally
stable however hard you slam the demand valve.

**The suction.** NPSH available from barometric pressure, vapour pressure, static head and strainer
loss; NPSH required rising with the square of flow and scaling with speed squared. Below the curve
the pump loses head, on a lag, and the alarm says so. Cavitation is reachable three ways — hot
liquid above about 93 °C, a strainer blinded past 80%, or a low tank — and, as in a real plant,
most easily by a combination.

**The instruments.** Dead time, then pink noise, then a filter pole — the order a signal actually
meets them between the tapping point and the faceplate. The trend can show both the transmitter's
reading and the truth behind it.

**The controller.** ISA standard form, with everything a real one has: setpoint weighting on the
proportional and derivative terms, a filtered derivative, anti-windup by back-calculation, bumpless
auto/manual transfer, output rate limiting, an error deadband and a setpoint ramp. The scan period
is on the panel, because it is a real tuning parameter that most simulators hide.

**The sequence.** Lead/lag staging with asymmetric thresholds and delays, a staging bias applied
through the controller's integral, minimum run and stop timers, duty rotation by runtime with a
make-before-break changeover, and promotion of the standby when the lead trips. This is the part
that makes a dual-pump set hard: a continuous loop wrapped in a discrete one, where the discrete
one can destabilise a loop that was perfectly tuned on its own.

---

## What you can do with it

**Tune it.** The rig ships deliberately detuned. There is a lot of room to improve on it, and a
scorecard that says whether you did.

**Autotune it.** A relay-feedback experiment (Åström–Hägglund) drives a bounded limit cycle at the
frequency where the process phase lag reaches 180°, and reads the ultimate gain and period straight
off it. Six published rule sets are then offered side by side — Ziegler–Nichols, Tyreus–Luyben,
Pessen, no-overshoot — each with a note on what it is *for*, so the difference between them can be
seen rather than asserted.

**Score it.** Five scripted tests apply the same disturbances from the same starting point, so two
tunings can actually be compared. IAE, ITAE, overshoot, settling time, output travel and pump
starts, with the reference values published and hard penalties for running the machinery outside
its envelope. Output travel is the column most tuning exercises are missing: a loop that holds
setpoint by hunting the drive all shift has a wonderful IAE and destroys the machine.

**Break it.** Sliders for demand, discharge back pressure, liquid temperature, strainer blinding,
recirculation and tank level; buttons to trip a machine, lock one out, or drive one by hand.

Some things worth trying:

| Try this | And watch |
| --- | --- |
| Push the demand valve past 70% | One pump saturates, the output pins at 100%, the sequence stages the second in — and the check valve dead time shows up as a flat spot before the surge |
| Set the staging bias to 1.0 and repeat | The surge the bias exists to prevent |
| Narrow the stage-down threshold to 60% | Short-cycling, and the alarm that catches it |
| Set derivative weight `c` to 1, then step the setpoint | The classic derivative kick, once, so you never do it again |
| Run the autotune, apply Ziegler–Nichols, then Tyreus–Luyben | Quarter-amplitude damping against something you would leave on a plant overnight |
| Raise the gain and add a PV filter | Output travel falling while IAE barely moves |
| Take the make-up controller to manual and let the tank drain | NPSH margin closing, then cavitation |
| Switch to FIC flow control | A much faster loop, where the drive ramp is what limits you |

---

## Architecture

Plain ES modules, strictly layered, no framework. Nothing in `src/ui/` writes simulation state:
every control calls an action in `src/core/sim.js`, which validates, can refuse, and returns the
reason — which is what the operator is then shown.

```
src/
  core/      util.js    units, maths, seeded RNG, the trend ring, the event bus
             sim.js     the wall-clock accumulator, the tick order, the action surface
  process/   fluid.js   water density and vapour pressure
             pump.js    the curve, affinity, efficiency, power, NPSH, the branch solve
             valve.js   trim characteristics and the head-basis Kv relation
             motor.js   the VFD state machine, ramp, current and overload
             plant.js   the network ODE, the vessels, the instruments
             alarms.js  the alarm list
  control/   pid.js     the controller
             staging.js lead/lag, rotation, anti-short-cycling
             autotune.js relay identification, tuning rules, FOPDT fit
             scenario.js scripted tests and the scorecard
  data/      config.js  the rig as built — every datasheet number, in one file
  ui/        dom.js mimic.js curves.js trend.js panels.js app.js
```

The tick order is fixed: the plant integrates on the **last** scan's outputs, then — on a scan
boundary — instruments, controller, sequence, alarms, scorecard. The controller therefore never
sees a measurement its own current output helped produce. Getting that backwards makes every tuning
look better than it is.

A run is reproducible from its seed, noise included. That is what makes two scores comparable.

---

## Keyboard

| Key | |
| --- | --- |
| `Space` | run / freeze |
| `1` `2` `3` | 1× / 5× / 20× time compression |
| `A` | acknowledge alarms |
| `P` | swap the schematic for the head-capacity chart |

---

## Licence

MIT.
