/**
 * src/core/sim.js — the wall-clock accumulator loop AND the complete UI mutation surface.
 *
 * Contract: architecture-v2 §3.1–§3.2 (ownership and the fixed-step accumulator), §2.4 (the
 * rebuild protocol and the one `ctx` shape), §5.5/§5.5.1 (the state machine and the READY gate),
 * §6.4 (this module).
 *
 * This is the ONLY module that increments `run.t_s` / `run.tick` — it does so through
 * `skid.physicsTick`, which owns step 0 of §3.3 — and the only writer of `run.speedDeficit`,
 * `run.speed`, `run.wallAccum_s`, `run.manualOverride`, `run.endAfterBlockIndex` and
 * `run.diag.ms*`. The UI writes nothing; it calls the actions below, every one of which
 * validates, logs an `OPERATOR_ACTION` event and returns `{ ok:boolean, reason?:string }`.
 *
 * `ctx = { config, run, bus, sim, fmt, overrides }` (§2.4) — ONE shape everywhere. This module
 * reads only `config`, `run`, `bus` and `overrides`.
 *
 * Determinism (T29): nothing here reads a wall clock inside the tick loop. `advanceWall` samples
 * `performance.now()` once before and once after the whole batch, purely to write
 * `run.diag.msPerSimSecond` / `run.diag.msLastTick`, which never feed back into physics (§3.1).
 *
 * Layer L9. Imports L8 `core/state.js`, L0 `core/util.js` + `core/log.js`, and the skid/data
 * layers below it. Nothing imports this except `src/ui/*`.
 */

import * as state from './state.js';
import { deepMerge } from './util.js';
import { logEvent } from './log.js';
import * as skid from '../skid/skid.js';
import * as engine from '../skid/engine.js';
import * as fluidics from '../skid/fluidics.js';
import * as alarms from '../skid/alarms.js';
import * as sensors from '../skid/sensors.js';
import * as fractionator from '../skid/fractionator.js';
import * as presets from '../data/presets.js';

/** Wall-clock clamp for a tab-switch stall, seconds (§3.2). */
const WALL_CLAMP_S = 0.25;

/** @returns {{ok:true}} the success result of an action */
function ok() {
  return { ok: true };
}

/**
 * @param {string} reason human-readable refusal, shown verbatim in the UI toast (§9.4.4)
 * @returns {{ok:false, reason:string}} the failure result of an action
 */
function fail(reason) {
  return { ok: false, reason };
}

/**
 * @param {object} config frozen config
 * @param {object} run run state
 * @returns {string|null} the current block id, or null when the method has no such block
 */
function blockIdOf(config, run) {
  const blocks = config.method && config.method.blocks;
  if (!blocks || run.blockIndex < 0 || run.blockIndex >= blocks.length) return null;
  return blocks[run.blockIndex].id;
}

/**
 * Log an `OPERATOR_ACTION` event for an action that has already been validated.
 * @param {object} config frozen config
 * @param {object} run run state
 * @param {string} message one-line description of what the operator did
 * @param {object|null} detail structured payload, or null
 * @param {'OPERATOR'|'MANUAL'|'SYSTEM'} [source='OPERATOR'] event source (§5.10)
 * @returns {void}
 */
function logAction(config, run, message, detail, source) {
  logEvent(config, run, {
    type: 'OPERATOR_ACTION',
    severity: 'INFO',
    source: source || 'OPERATOR',
    blockId: blockIdOf(config, run),
    message,
    detail: detail || null,
  });
}

/**
 * @param {Array<{code:string, message:string}>} failures pre-run check failures (§5.5.1)
 * @returns {string} the first failure rendered as `CODE: message`, or a generic refusal
 */
function firstFailureMessage(failures) {
  if (!failures || failures.length === 0) return 'pre-run checks failed';
  return `${failures[0].code}: ${failures[0].message}`;
}

/**
 * Wall-clock read, used ONLY for `run.diag.ms*` (§3.1). Returns 0 where no timer exists so the
 * module stays importable with no globals of any kind.
 * @returns {number} milliseconds from an arbitrary origin, or 0
 */
function nowMs() {
  const g = /** @type {any} */ (globalThis);
  return g.performance && typeof g.performance.now === 'function' ? g.performance.now() : 0;
}

/**
 * Emit a bus event when a bus is present. Tests construct a `ctx` with no bus.
 * @param {object} ctx the §2.4 context
 * @param {string} name event name
 * @param {*} payload payload passed to every subscriber
 * @returns {void}
 */
function emit(ctx, name, payload) {
  if (ctx.bus && typeof ctx.bus.emit === 'function') ctx.bus.emit(name, payload);
}

/**
 * Advance the simulation by a wall-clock interval, in fixed 0.05 s physics ticks (§3.2).
 *
 * The accumulator banks `wallDt_s * run.speed` (with `wallDt_s` clamped to 0.25 s so a hidden tab
 * cannot fast-forward), then runs whole ticks until it is exhausted or `maxTicksPerFrame` (150)
 * is reached. Leftover debt is DROPPED, never banked, and reported through `run.speedDeficit`.
 *
 * `run.speedDeficit` has exactly one writer — this function. `skid.physicsTick` RETURNS the
 * column's substep-limiter deficit; the two are combined with `max` (§3.2, §11 C-17).
 *
 * @param {{config:object, run:object, bus?:object, sim?:object, fmt?:object, overrides?:object}} ctx
 *   the §2.4 context; only `config`, `run` and `bus` are read
 * @param {number} wallDt_s real elapsed time since the previous frame, seconds
 * @returns {number} the number of physics ticks executed this call (0 when not RUNNING)
 */
export function advanceWall(ctx, wallDt_s) {
  const config = ctx.config;
  const run = ctx.run;
  const DT_PHYS = config.sim.dtPhys_s;

  // §3.2 is literal here: only RUNNING advances the clock. (§5.5's "HELD keeps counting" cannot be
  // honoured without contradicting this block, and §3.2 is the normative body for this function.)
  if (run.state !== 'RUNNING') {
    run.speedDeficit = 1.0;
    return 0;
  }

  run.wallAccum_s += Math.min(wallDt_s, WALL_CLAMP_S) * run.speed;

  let n = 0;
  let colDeficit = 1.0;
  let stopped = false;      // the run left RUNNING part-way through this frame
  let endedHere = false;    // the deferred end fired on one of this frame's ticks
  const maxTicks = config.sim.maxTicksPerFrame;
  const t0_ms = nowMs();
  while (run.wallAccum_s >= DT_PHYS && n < maxTicks) {
    const d = skid.physicsTick(config, run);
    if (d > colDeficit) colDeficit = d;
    run.wallAccum_s -= DT_PHYS;
    n++;
    // Deferred end armed by end(ctx,'AFTER_BLOCK'). Checked per TICK, not per frame, so it fires
    // on the same tick at 1x and at 1000x (DoD 6).
    if (run.endAfterBlockIndex >= 0 && run.blockIndex !== run.endAfterBlockIndex) {
      run.endAfterBlockIndex = -1;
      finishRun(config, run, 'OPERATOR_END_AFTER_BLOCK');
      endedHere = true;
    }
    // The engine (or an alarm trip) may leave RUNNING mid-frame; ticking on would advance a run
    // that has already ended.
    if (run.state !== 'RUNNING') { stopped = true; break; }
  }
  const t1_ms = nowMs();

  let frameDeficit = 1.0;
  if (stopped) {
    run.wallAccum_s = 0;                     // not a performance deficit — drop it silently
  } else if (run.wallAccum_s >= DT_PHYS) {   // could not keep up
    frameDeficit = 1 + run.wallAccum_s / Math.max(n, 1) / DT_PHYS;
    run.wallAccum_s = 0;                     // DROP the debt, never bank it
  }
  run.speedDeficit = Math.max(frameDeficit, colDeficit);

  if (n > 0 && t1_ms > t0_ms) {
    const elapsed_ms = t1_ms - t0_ms;
    run.diag.msLastTick = elapsed_ms / n;
    run.diag.msPerSimSecond = elapsed_ms / (n * DT_PHYS);
  }

  if (endedHere) emit(ctx, 'run-ended', ctx);

  return n;
}

/**
 * Transition to ENDED and log `RUN_END`. Shared by `end(ctx,'NOW')` and the deferred
 * `end(ctx,'AFTER_BLOCK')` path.
 * @param {object} config frozen config
 * @param {object} run run state
 * @param {string} reason transition reason, recorded on the STATE_CHANGE event
 * @returns {{ok:boolean, reason?:string}} the transition result
 */
function finishRun(config, run, reason) {
  const t = engine.setRunState(config, run, 'ENDED', reason);
  if (!t || t.ok === false) return fail((t && t.reason) || 'transition rejected');
  logEvent(config, run, {
    type: 'RUN_END',
    severity: 'INFO',
    source: 'OPERATOR',
    blockId: blockIdOf(config, run),
    message: 'Run ended',
    detail: { reason, t_s: run.t_s, V_mL: run.V_tot_mL },
  });
  return ok();
}

/**
 * Rebuild `config` and `run` from the preset plus accumulated overrides, and swap both through
 * `ctx` (§2.4). Overrides ACCUMULATE: `ctx.overrides = deepMerge(ctx.overrides, overrides)`, so
 * the boot benchmark's `nz` downgrade survives every later scenario load (§11 C-82).
 *
 * Nothing is ever mutated in place — `config` is frozen and stays frozen.
 *
 * @param {object} ctx the §2.4 context; `ctx.config`, `ctx.run` and `ctx.overrides` are replaced
 * @param {object} overrides partial config patch in AUTHORED (preset) form, merged leaf-wise
 * @returns {object} the same `ctx`, with the new `config`/`run` installed
 */
export function rebuild(ctx, overrides) {
  const merged = deepMerge(ctx.overrides || {}, overrides || {});
  ctx.overrides = merged;
  const cfg = presets.normalizePreset(ctx.config.presetId, merged);
  const rn = state.createRunState(cfg);
  skid.createSkid(cfg, rn);
  ctx.config = cfg;
  ctx.run = rn;
  emit(ctx, 'config-replaced', ctx);
  return ctx;
}

/**
 * Load a different preset. THE ONLY action that resets `ctx.overrides` to `{}` (§2.4).
 * `ui/app.js` re-runs the startup grid benchmark on the `preset-loaded` bus event.
 *
 * @param {object} ctx the §2.4 context
 * @param {string} presetId a key of `data/presets.js::PRESETS`
 * @returns {{ok:boolean, reason?:string}}
 */
export function loadPreset(ctx, presetId) {
  if (typeof presetId !== 'string' || !presets.PRESETS[presetId]) {
    return fail(`unknown preset '${presetId}'`);
  }
  ctx.overrides = {};
  const cfg = presets.normalizePreset(presetId, {});
  const rn = state.createRunState(cfg);
  skid.createSkid(cfg, rn);
  ctx.config = cfg;
  ctx.run = rn;
  logAction(cfg, rn, `Preset loaded: ${cfg.name}`, { presetId });
  emit(ctx, 'config-replaced', ctx);
  emit(ctx, 'preset-loaded', ctx);   // ui/app.js re-runs the startup benchmark on this
  return ok();
}

/**
 * Load one of the mandatory teaching scenarios (§6.22): rebuild with its overrides, apply its
 * `runMutator` (which may touch `run` only), then apply its speed and optional auto-start.
 *
 * @param {object} ctx the §2.4 context
 * @param {string} scenarioId one of the eight ids of §6.22
 * @returns {{ok:boolean, reason?:string}} `reason` is set on partial success (auto-start blocked)
 */
export function loadScenario(ctx, scenarioId) {
  const list = presets.SCENARIOS || [];
  let sc = null;
  for (const s of list) if (s.id === scenarioId) sc = s;
  if (!sc) return fail(`unknown scenario '${scenarioId}'`);

  rebuild(ctx, sc.overrides || {});
  if (typeof sc.runMutator === 'function') sc.runMutator(ctx.config, ctx.run);

  logEvent(ctx.config, ctx.run, {
    type: 'SCENARIO_APPLIED',
    severity: 'INFO',
    source: 'OPERATOR',
    blockId: null,
    message: `Scenario applied: ${sc.name}`,
    detail: { scenarioId: sc.id, expectedOutcome: sc.expectedOutcome || null },
  });
  emit(ctx, 'scenario-applied', ctx);

  if (typeof sc.speed === 'number') setSpeed(ctx, sc.speed);
  if (sc.autoStart) {
    const started = start(ctx);
    if (!started.ok) return { ok: true, reason: `scenario loaded, auto-start blocked: ${started.reason}` };
  }
  return ok();
}

/**
 * Install a method. `config` is immutable, so this goes through the §2.4 rebuild protocol with
 * `{ method }` as the override — `deepMerge` replaces arrays wholesale, so `method.blocks` is
 * substituted, not merged element-wise. `normalizePreset` re-runs `normalizeMethod`, which is the
 * method ingest boundary (§5.4.6) and the only place authored thresholds are converted.
 *
 * Legal in IDLE / READY / ENDED only: installing a method rebuilds the run.
 *
 * @param {object} ctx the §2.4 context
 * @param {object} methodObj a method object (§5.4.1), authored or previously normalised
 * @returns {{ok:boolean, reason?:string}}
 */
export function loadMethod(ctx, methodObj) {
  const run = ctx.run;
  if (run.state !== 'IDLE' && run.state !== 'READY' && run.state !== 'ENDED') {
    return fail(`the method cannot be changed while the run is ${run.state}`);
  }
  if (!methodObj || typeof methodObj !== 'object' || Array.isArray(methodObj)) {
    return fail('method must be an object');
  }
  if (!Array.isArray(methodObj.blocks) || methodObj.blocks.length === 0) {
    return fail('method has no blocks');
  }
  try {
    rebuild(ctx, { method: methodObj });
  } catch (err) {
    return fail(`method rejected at ingest: ${(err && err.message) || String(err)}`);
  }
  logAction(ctx.config, ctx.run, `Method loaded: ${ctx.config.method.name || methodObj.name || ''}`, {
    blocks: methodObj.blocks.length,
  });
  return ok();
}

/**
 * Run the twelve pre-run checks (§5.5.1) and arm the run when they pass.
 *
 * All failures are reported at once; `ok` is true iff every non-acknowledgeable failure is absent.
 * On success from IDLE the state moves to READY.
 *
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, failures:Array<{code:string, message:string, acknowledgeable:boolean}>}}
 */
export function validateAndReady(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  if (run.state === 'RUNNING' || run.state === 'HELD' || run.state === 'PAUSED' || run.state === 'ALARM') {
    return { ok: false, failures: [{ code: 'PRC-00', message: 'A run is already in progress', acknowledgeable: false }] };
  }
  if (run.state === 'ENDED' || run.state === 'FAULT') {
    return { ok: false, failures: [{ code: 'PRC-00', message: 'Reset before arming a new run', acknowledgeable: false }] };
  }
  const res = engine.preRunChecks(config, run);
  const failures = res && Array.isArray(res.failures) ? res.failures : [];
  const passed = !!(res && res.ok);
  if (passed && run.state === 'IDLE') engine.setRunState(config, run, 'READY', 'PRE_RUN_CHECKS_PASSED');
  return { ok: passed, failures };
}

/**
 * Start (or continue) the run. From IDLE it runs the pre-run checks first; from HELD or PAUSED it
 * is `resume`; from READY it transitions to RUNNING.
 *
 * The READY -> RUNNING transition itself logs `RUN_START` and starts the first ENABLED block —
 * that is `engine.setRunState`'s job, not this one's (§5.5, §6.16). This action's own logging
 * duty is the `OPERATOR_ACTION` event that §6.4 requires of every action. Logging `RUN_START`
 * and calling `startBlock` here as well produced a doubled block entry (two `RUN_START`, two
 * `BLOCK_START`, two `AUTOZERO`, a double `initWatchStates`) and hardcoded index 0, which is the
 * wrong block whenever block 0 is disabled.
 *
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function start(ctx) {
  const config = ctx.config;
  const run = ctx.run;

  if (run.state === 'HELD' || run.state === 'PAUSED') return resume(ctx);
  if (run.state === 'IDLE') {
    const v = validateAndReady(ctx);
    if (!v.ok) return fail(firstFailureMessage(v.failures));
  }
  if (run.state !== 'READY') return fail(`cannot start from ${run.state}`);

  run.manualOverride = false;          // §5.5: force-cleared on any transition into RUNNING
  run.endAfterBlockIndex = -1;
  const t = engine.setRunState(config, run, 'RUNNING', 'OPERATOR_START');
  if (!t || t.ok === false) return fail((t && t.reason) || 'transition rejected');

  logAction(config, run, 'Start', {
    presetId: config.presetId, seed: config.seed,
    method: config.method ? config.method.name : null,
  });
  emit(ctx, 'run-started', ctx);
  return ok();
}

/**
 * Hold: flow stays at the current setpoint, the block clock freezes (§5.5).
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function hold(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  if (!engine.canTransition(run.state, 'HELD')) return fail(`cannot hold from ${run.state}`);
  const t = engine.setRunState(config, run, 'HELD', 'OPERATOR_HOLD');
  if (!t || t.ok === false) return fail((t && t.reason) || 'transition rejected');
  logAction(config, run, 'Hold', null);
  return ok();
}

/**
 * Pause: flow ramps to zero, the clock freezes (§5.5).
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function pause(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  if (!engine.canTransition(run.state, 'PAUSED')) return fail(`cannot pause from ${run.state}`);
  const t = engine.setRunState(config, run, 'PAUSED', 'OPERATOR_PAUSE');
  if (!t || t.ok === false) return fail((t && t.reason) || 'transition rejected');
  logAction(config, run, 'Pause', null);
  return ok();
}

/**
 * Resume from HELD or PAUSED back into RUNNING. Manual override is force-cleared (§5.5).
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function resume(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  if (!engine.canTransition(run.state, 'RUNNING')) return fail(`cannot continue from ${run.state}`);
  run.manualOverride = false;
  const t = engine.setRunState(config, run, 'RUNNING', 'OPERATOR_CONTINUE');
  if (!t || t.ok === false) return fail((t && t.reason) || 'transition rejected');
  logAction(config, run, 'Continue', null);
  return ok();
}

/**
 * End the run, now or at the end of the current block.
 *
 * `'AFTER_BLOCK'` arms `run.endAfterBlockIndex`; `advanceWall` completes the end on the first
 * frame after the block index changes. `'NOW'` transitions straight to ENDED — it does NOT call
 * `engine.endBlock`, which is the block-sequencing path and would start the next block.
 * A caller that needs a flushed column for a mass audit calls `bed.forceFlush` itself (§3.4).
 *
 * @param {object} ctx the §2.4 context
 * @param {'NOW'|'AFTER_BLOCK'} mode when to stop
 * @returns {{ok:boolean, reason?:string}}
 */
export function end(ctx, mode) {
  const config = ctx.config;
  const run = ctx.run;
  const m = mode === 'AFTER_BLOCK' ? 'AFTER_BLOCK' : 'NOW';

  if (m === 'AFTER_BLOCK') {
    if (run.state !== 'RUNNING' && run.state !== 'HELD') {
      return fail(`cannot schedule an end from ${run.state}`);
    }
    run.endAfterBlockIndex = run.blockIndex;
    logAction(config, run, 'End after current block', { blockIndex: run.blockIndex });
    return ok();
  }

  if (!engine.canTransition(run.state, 'ENDED')) return fail(`cannot end from ${run.state}`);
  run.endAfterBlockIndex = -1;
  logAction(config, run, 'End now', null);
  const r = finishRun(config, run, 'OPERATOR_END_NOW');
  if (r.ok) emit(ctx, 'run-ended', ctx);
  return r;
}

/**
 * Reset the run back to IDLE: zero the run state in place, then rebuild the fluid network and the
 * bed from the (unchanged) config. Legal from IDLE, READY, ENDED and FAULT (§5.5).
 *
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function reset(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  if (run.state !== 'IDLE' && !engine.canTransition(run.state, 'IDLE')) {
    return fail(`cannot reset from ${run.state}`);
  }
  if (run.state !== 'IDLE') {
    const t = engine.setRunState(config, run, 'IDLE', 'OPERATOR_RESET');
    if (!t || t.ok === false) return fail((t && t.reason) || 'transition rejected');
  }
  state.resetRunState(config, run);
  skid.createSkid(config, run);      // re-seeds the cascade and creates a fresh bed
  logAction(config, run, 'Reset', null);
  emit(ctx, 'run-reset', ctx);
  return ok();
}

/**
 * Emergency stop: command zero flow, divert the outlet to waste and drop into FAULT, from which
 * only an explicit Reset recovers (§9.4.3). No undo.
 *
 * The pump command is zeroed here (`Q_set_mLs` and `Q_limit_mLs`); the FAULT row of STATE_TABLE
 * is `pumps:'ZERO_NOW'`, which is what actually collapses the flow — `config.skid.estopRamp_s`
 * is recorded on the event for the UI's benefit.
 *
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function estop(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  run.Q_set_mLs = 0;
  run.Q_limit_mLs = 0;
  run.endAfterBlockIndex = -1;
  fluidics.requestOutlet(config, run, 'WASTE');
  logAction(config, run, 'EMERGENCY STOP', { estopRamp_s: config.skid.estopRamp_s }, 'OPERATOR');
  if (engine.canTransition(run.state, 'FAULT')) {
    const t = engine.setRunState(config, run, 'FAULT', 'OPERATOR_ESTOP');
    if (!t || t.ok === false) return fail((t && t.reason) || 'transition rejected');
  }
  emit(ctx, 'estop', ctx);
  return ok();
}

/**
 * Acknowledge a latched alarm.
 * @param {object} ctx the §2.4 context
 * @param {string} alarmId an `ALARM_TABLE` id, e.g. `'ALM-DP-03'`
 * @returns {{ok:boolean, reason?:string}}
 */
export function acknowledgeAlarm(ctx, alarmId) {
  const config = ctx.config;
  const run = ctx.run;
  const r = alarms.acknowledgeAlarm(config, run, alarmId);
  if (!r || r.ok === false) return fail((r && r.reason) ? String(r.reason) : `alarm '${alarmId}' cannot be acknowledged`);
  logAction(config, run, `Alarm acknowledged: ${alarmId}`, { alarmId });
  return ok();
}

/**
 * Set the simulation speed multiplier. The effective speed the operator sees is
 * `run.speed / run.speedDeficit` (§2.1.1, §9.4.3).
 * @param {object} ctx the §2.4 context
 * @param {number} speed one of `config.sim.speedOptions`
 * @returns {{ok:boolean, reason?:string}}
 */
export function setSpeed(ctx, speed) {
  const config = ctx.config;
  const run = ctx.run;
  const options = config.sim.speedOptions;
  if (typeof speed !== 'number' || options.indexOf(speed) < 0) {
    return fail(`speed must be one of ${options.join(', ')}`);
  }
  run.speed = speed;
  logAction(config, run, `Speed ${speed}x`, { speed });
  return ok();
}

/**
 * Skip the current block. Delegates to the block-sequencing path so the boundary is flushed and
 * logged exactly as a normal block end is (§6.16).
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function skipBlock(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  if (run.state !== 'RUNNING' && run.state !== 'HELD') return fail(`cannot skip a block from ${run.state}`);
  const id = blockIdOf(config, run);
  logAction(config, run, `Skip block ${id || run.blockIndex}`, { blockIndex: run.blockIndex, blockId: id });
  engine.endBlock(config, run, 'OPERATOR');
  return ok();
}

/**
 * Autozero the UV detector.
 * @param {object} ctx the §2.4 context
 * @param {280|260|300|'all'} channel wavelength in nm, or `'all'`
 * @returns {{ok:boolean, reason?:string}}
 */
export function autozero(ctx, channel) {
  const config = ctx.config;
  const run = ctx.run;
  const r = sensors.autozeroUV(config, run, channel);
  if (!r || r.ok === false) return fail((r && r.reason) ? String(r.reason) : 'autozero rejected');
  logAction(config, run, `Autozero ${channel}`, { channel });
  return ok();
}

/**
 * Refill a source tank.
 * @param {object} ctx the §2.4 context
 * @param {string} tankId a `config.tanks[].id`, e.g. `'TK-EQ'`
 * @param {number} volume_mL volume to add, mL (the tank clamps at its nominal volume)
 * @returns {{ok:boolean, reason?:string}}
 */
export function refillTank(ctx, tankId, volume_mL) {
  const config = ctx.config;
  const run = ctx.run;
  if (typeof volume_mL !== 'number' || !(volume_mL > 0)) return fail('refill volume must be > 0 mL');
  const r = fluidics.refillTank(config, run, tankId, volume_mL);
  if (!r || r.ok === false) return fail((r && r.reason) ? String(r.reason) : `tank '${tankId}' cannot be refilled`);
  logEvent(config, run, {
    type: 'TANK_REFILL',
    severity: 'INFO',
    source: 'OPERATOR',
    blockId: blockIdOf(config, run),
    message: `Tank refilled: ${tankId}`,
    detail: { tankId, volume_mL },
  });
  return ok();
}

/**
 * Turn manual mode on or off. Manual is a modifier, not a state, and is legal only in
 * IDLE / READY / HELD / PAUSED (§5.5).
 * @param {object} ctx the §2.4 context
 * @param {boolean} on true to take manual control
 * @returns {{ok:boolean, reason?:string}}
 */
export function setManualOverride(ctx, on) {
  const config = ctx.config;
  const run = ctx.run;
  const want = !!on;
  if (want && run.state !== 'IDLE' && run.state !== 'READY' && run.state !== 'HELD' && run.state !== 'PAUSED') {
    return fail(`manual control is not available in ${run.state}`);
  }
  run.manualOverride = want;
  logAction(config, run, want ? 'Manual control ON' : 'Manual control OFF', { manualOverride: want }, 'MANUAL');
  return ok();
}

/**
 * Apply one or more manual setpoints. Requires manual mode. Every interlock still applies and is
 * explained: the first refusal stops the command and its reason is returned verbatim (§9.4.4).
 *
 * Fields are applied in a fixed order — inlets, column valve, outlet, %B, flow — so that a flow
 * command is validated against the inlet selection made in the same call.
 *
 * @param {object} ctx the §2.4 context
 * @param {{flow_mLs?:number, pctB?:number, inletA?:string, inletB?:string, inletS?:string,
 *          columnValve?:string, outletValve?:string}} cmd manual setpoints; `flow_mLs` is mL/s
 *          and `pctB` is percent 0–100
 * @returns {{ok:boolean, reason?:string}}
 */
export function manualSet(ctx, cmd) {
  const config = ctx.config;
  const run = ctx.run;
  if (!run.manualOverride) return fail('Blocked: manual control is off');
  if (!cmd || typeof cmd !== 'object') return fail('no command given');

  if (cmd.inletA !== undefined) {
    const r = fluidics.switchInlet(config, run, 'A', cmd.inletA);
    if (!r || r.ok === false) return fail((r && r.reason) ? String(r.reason) : 'inlet A rejected');
  }
  if (cmd.inletB !== undefined) {
    const r = fluidics.switchInlet(config, run, 'B', cmd.inletB);
    if (!r || r.ok === false) return fail((r && r.reason) ? String(r.reason) : 'inlet B rejected');
  }
  if (cmd.inletS !== undefined) {
    const r = fluidics.switchInlet(config, run, 'S', cmd.inletS);
    if (!r || r.ok === false) return fail((r && r.reason) ? String(r.reason) : 'sample inlet rejected');
  }
  if (cmd.columnValve !== undefined) {
    if (fluidics.COLUMN_POSITIONS.indexOf(cmd.columnValve) < 0) {
      return fail(`Blocked: '${cmd.columnValve}' is not a column-valve position`);
    }
    const r = fluidics.requestColumnValve(config, run, cmd.columnValve);
    // requestColumnValve returns a module-level singleton: read `reason` immediately (§13).
    if (!r || r.ok === false) return fail((r && r.reason) ? String(r.reason) : 'column valve move rejected');
  }
  if (cmd.outletValve !== undefined) {
    const r = fluidics.requestOutlet(config, run, cmd.outletValve);
    if (!r || r.ok === false) return fail((r && r.reason) ? String(r.reason) : 'outlet move rejected');
  }
  if (cmd.pctB !== undefined) {
    if (typeof cmd.pctB !== 'number' || !(cmd.pctB >= 0 && cmd.pctB <= 100)) {
      return fail('Blocked: %B must be between 0 and 100');
    }
    run.pctB_set = cmd.pctB;
  }
  if (cmd.flow_mLs !== undefined) {
    const q = cmd.flow_mLs;
    if (typeof q !== 'number' || !Number.isFinite(q) || q < 0) return fail('Blocked: flow must be >= 0 mL/s');
    if (q > config.skid.Qmax_mLs) {
      return fail(`Blocked: flow above the pump ceiling (${config.skid.Qmax_mLs.toFixed(3)} mL/s)`);
    }
    if (q > 0 && q < config.skid.QminAbs_mLs) {
      return fail(`Blocked: flow below the pump's minimum (${config.skid.QminAbs_mLs.toFixed(4)} mL/s)`);
    }
    if (q > 0 && !run.valves.inletA && !run.valves.inletB && !run.valves.inletS) {
      return fail('Blocked: no open inlet valve (deadhead protection)');
    }
    run.Q_set_mLs = q;
  }

  logAction(config, run, 'Manual setpoint', {
    flow_mLs: cmd.flow_mLs, pctB: cmd.pctB,
    inletA: cmd.inletA, inletB: cmd.inletB, inletS: cmd.inletS,
    columnValve: cmd.columnValve, outletValve: cmd.outletValve,
  }, 'MANUAL');
  return ok();
}

/**
 * Replace one block's fractionation settings (§5.4.5).
 *
 * `config` is immutable, so this goes through the §2.4 rebuild protocol: the current method is
 * cloned to plain data, the named block's `fractionation` is replaced, and the whole method is
 * passed back through `normalizePreset`. Because the rebuild replaces `run`, this is legal only
 * before a run starts — IDLE or READY.
 *
 * @param {object} ctx the §2.4 context
 * @param {string} blockId the `block.id` to edit, e.g. `'B04'`
 * @param {object} fractionationObj a fractionation object (§5.4.5); merged over the block's own
 * @returns {{ok:boolean, reason?:string}}
 */
export function setFractionation(ctx, blockId, fractionationObj) {
  const run = ctx.run;
  if (run.state !== 'IDLE' && run.state !== 'READY') {
    return fail(`fractionation can only be edited before the run starts (state is ${run.state})`);
  }
  if (!fractionationObj || typeof fractionationObj !== 'object') {
    return fail('fractionation must be an object');
  }
  const method = ctx.config.method;
  if (!method || !Array.isArray(method.blocks)) return fail('no method loaded');

  let found = false;
  const blocks = method.blocks.map((b) => {
    if (b.id !== blockId) return b;
    found = true;
    return Object.assign({}, b, {
      fractionation: deepMerge(b.fractionation || {}, fractionationObj),
    });
  });
  if (!found) return fail(`unknown block '${blockId}'`);

  try {
    rebuild(ctx, { method: Object.assign({}, method, { blocks }) });
  } catch (err) {
    return fail(`fractionation rejected at ingest: ${(err && err.message) || String(err)}`);
  }
  logAction(ctx.config, ctx.run, `Fractionation set on ${blockId}`, { blockId });
  return ok();
}

/**
 * The operator's manual fraction mark — the `M` key of §9.5. Closes the open fraction with
 * trigger `'OPERATOR'` and opens the next port. An ACTION, not the deferred MANUAL fractionation
 * MODE (§12 D19).
 *
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function markFraction(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  if (run.state !== 'RUNNING' && run.state !== 'HELD') {
    return fail(`fractions can only be marked while running or held (state is ${run.state})`);
  }
  if (run.frac.mode === 'OFF') return fail('fractionation is off for this block');

  const ports = config.skid.fracValve.ports;
  const idx = run.frac.nextPortIdx;
  const port = idx >= 0 && idx < ports.length ? ports[idx] : config.skid.fracValve.overflowTo;

  fractionator.closeFraction(config, run, 'OPERATOR');
  fractionator.openFraction(config, run, port);
  logAction(config, run, `Fraction marked -> ${port}`, { port });
  return ok();
}

/**
 * Purge the flow path: divert the outlet to waste and take the column out of line, so the lines
 * can be flushed without pushing anything through the bed. Legal only outside a running method.
 *
 * The setpoints take effect on the next tick; nothing moves while the clock is stopped.
 *
 * @param {object} ctx the §2.4 context
 * @returns {{ok:boolean, reason?:string}}
 */
export function purge(ctx) {
  const config = ctx.config;
  const run = ctx.run;
  if (run.state === 'RUNNING') return fail('cannot purge while the method is running — hold first');
  if (run.state === 'ENDED' || run.state === 'FAULT') return fail(`cannot purge from ${run.state}`);

  const outlet = fluidics.requestOutlet(config, run, 'WASTE');
  if (!outlet || outlet.ok === false) {
    return fail((outlet && outlet.reason) ? String(outlet.reason) : 'outlet move rejected');
  }
  const valve = fluidics.requestColumnValve(config, run, 'BYPASS');
  if (!valve || valve.ok === false) {
    return fail((valve && valve.reason) ? String(valve.reason) : 'column valve move rejected');
  }
  logAction(config, run, 'Purge to waste (column bypassed)', null);
  return ok();
}

/**
 * Reconfigure the column geometry or numerics. Legal in IDLE / READY only; goes through the §2.4
 * rebuild protocol, so the run is replaced and `ctx.overrides` accumulates the patch.
 *
 * @param {object} ctx the §2.4 context
 * @param {object} partialColumnConfig a partial `config.column` patch in authored units
 * @returns {{ok:boolean, reason?:string}}
 */
export function reconfigureColumn(ctx, partialColumnConfig) {
  const run = ctx.run;
  if (run.state !== 'IDLE' && run.state !== 'READY') {
    return fail(`the column can only be reconfigured in IDLE or READY (state is ${run.state})`);
  }
  if (!partialColumnConfig || typeof partialColumnConfig !== 'object' || Array.isArray(partialColumnConfig)) {
    return fail('column configuration must be an object');
  }
  try {
    rebuild(ctx, { column: partialColumnConfig });
  } catch (err) {
    return fail(`column configuration rejected: ${(err && err.message) || String(err)}`);
  }
  logAction(ctx.config, ctx.run, 'Column reconfigured', partialColumnConfig);
  return ok();
}
