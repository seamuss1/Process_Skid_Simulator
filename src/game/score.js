/**
 * src/game/score.js — the live scoring engine: what the player earns for holding the loop in the
 * band, what it costs to leave it, and the scorecard shown when the shift ends.
 *
 * Layer L4 (game): imports `core/util.js` and nothing else. It is PURE — no clock, no storage, no
 * randomness, no DOM. Time arrives as `dt_s` and every number it produces is a function of the
 * samples it was handed, so a replayed run scores identically to the run it was recorded from.
 * That is not tidiness: a leaderboard whose entries were scored by a different arithmetic than the
 * one the player watched is worthless, and so is a daily seed that grades differently on a slow
 * machine.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THE BAND, AND WHY THE GRACE WINDOW
 *
 * The scoring model is a tolerance band around the setpoint, because that is the only quality
 * measure an operator can read off a trend at a glance. Integrated error is the honest metric and
 * `control/scenario.js` already grades on it, but nobody can see IAE accumulating; everybody can
 * see the trace sitting between two lines.
 *
 * A band has one failure mode and it is severe. A well-tuned loop on a noisy transmitter sits ON
 * the band edge and crosses it dozens of times a minute at the noise amplitude. Score that
 * literally and the best loop on the rig is punished hardest, and the player learns to detune —
 * exactly the wrong lesson. So the multiplier — the thing worth protecting — survives a crossing
 * that lasts less than {@link SCORE.GRACE_S}, and only dies once the measurement has been
 * continuously outside for a full second. One second is well past any plausible noise excursion on
 * this rig and well short of a real upset: an actual disturbance takes the PV out and keeps it
 * out. The per-second deviation penalty has NO grace, because a genuine offset should cost from
 * the moment it appears — it is the combo, not the arithmetic, that gets the benefit of the doubt.
 *
 * WHY THE PARTS MUST ADD UP
 *
 * `finishScore` returns a breakdown that is shown to the player, and the fastest way to lose a
 * player's trust is a scorecard whose lines do not sum to the total. So the total is DEFINED as
 * the sum of the rounded lines rather than computed alongside them. Rounding a total that was
 * summed from unrounded parts is how that bug is normally introduced.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/**
 * The scoring constants from the design. Every one of these is a number a player will eventually
 * argue about, so each says where it came from.
 */
export const SCORE = Object.freeze({
  /** Points per second while the measurement is inside the band, before the multiplier. */
  IN_BAND_RATE: 10,
  /**
   * Seconds of unbroken in-band time that buy one more multiplier step. Eight seconds is roughly
   * two dominant time constants on this rig, so a step is won by settling a disturbance, not by
   * waiting.
   */
  MULT_STEP_S: 8,
  /** Ceiling on the multiplier. Four caps a perfect quiet shift at 40 points/s. */
  MAX_MULT: 4,
  /** Seconds continuously outside the band before the multiplier is lost. See the header. */
  GRACE_S: 1.0,
  /** Points per second per band-width of error, while outside the band. */
  OUT_RATE: 2,
  /**
   * Ceiling on the deviation penalty, points per second. Reached at fifteen band-widths of error,
   * by which point the loop is not being controlled at all and charging more only makes a bad
   * shift unrecoverable instead of merely lost.
   */
  OUT_RATE_MAX: 30,
  /**
   * Points per percent of controller-output travel. A well-behaved loop moves its output about
   * ten percent a minute at steady state (the reference `control/scenario.js` grades against), so
   * this costs a calm loop half a point a minute and an oscillating one tens of points.
   */
  THRASH_PER_PCT: 0.05,
  /** Charged once when an alarm is raised — not per second, or one latched alarm ends the run. */
  ALARM_PENALTY: 150,
  /** Points per second while cavitating or running below minimum flow. Damage, not a trade-off. */
  HAZARD_RATE: 40,
  /** Scale of the end-of-shift energy award: full marks at half the par energy. */
  ENERGY_BONUS: 500,
  /** Clamp on the energy award, both directions. */
  ENERGY_BONUS_MAX: 500,
  /** Band half-width used when a mission forgets to state one, in the loop's engineering units. */
  DEFAULT_BAND: 0.15,
  /** Unit label used when a mission forgets to state one. */
  DEFAULT_BAND_EU: 'bar',
  /**
   * How many undrained pops are kept. A headless run, or one whose HUD is hidden, never calls
   * `takePops`, and an uncapped queue would grow for the whole shift.
   */
  MAX_POPS: 64,
});

/** Medal names, weakest first. Exported so the UI does not have to spell them. */
export const MEDALS = Object.freeze(['none', 'bronze', 'silver', 'gold']);

/**
 * Read a finite number or fall back.
 * @param {*} x candidate
 * @param {number} fallback value used when `x` is not a finite number
 * @returns {number} the number to use
 */
function num(x, fallback) {
  return Number.isFinite(x) ? x : fallback;
}

/**
 * Fill in a partial rules record from {@link SCORE}.
 *
 * Missions state only what they care about — usually just the band — so every other number has to
 * survive being absent. A NaN band arriving from a half-built mission would otherwise make every
 * comparison below false and silently score the whole shift as in-band.
 *
 * @param {object} [rules] partial rules: {band, bandEU, inBandRate, thrashPenalty, alarmPenalty,
 *   cavPenalty, maxMult} plus the optional overrides {outRate, outRateMax, grace_s, multStep_s}.
 *   Penalties are given as POSITIVE magnitudes; the engine applies the sign.
 * @returns {object} a complete rules record
 */
function resolveRules(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  const band = Number.isFinite(r.band) && r.band > 0 ? r.band : SCORE.DEFAULT_BAND;
  return {
    band,
    bandEU: typeof r.bandEU === 'string' ? r.bandEU : SCORE.DEFAULT_BAND_EU,
    inBandRate: num(r.inBandRate, SCORE.IN_BAND_RATE),
    thrashPenalty: Math.abs(num(r.thrashPenalty, SCORE.THRASH_PER_PCT)),
    alarmPenalty: Math.abs(num(r.alarmPenalty, SCORE.ALARM_PENALTY)),
    cavPenalty: Math.abs(num(r.cavPenalty, SCORE.HAZARD_RATE)),
    maxMult: Math.max(1, Math.floor(num(r.maxMult, SCORE.MAX_MULT))),
    outRate: Math.abs(num(r.outRate, SCORE.OUT_RATE)),
    outRateMax: Math.abs(num(r.outRateMax, SCORE.OUT_RATE_MAX)),
    grace_s: Math.max(0, num(r.grace_s, SCORE.GRACE_S)),
    multStep_s: Math.max(0.001, num(r.multStep_s, SCORE.MULT_STEP_S)),
  };
}

/**
 * Allocate the mutable scoring state for one shift.
 *
 * Every accumulator lives here and nothing is captured in a closure, so a session can be
 * serialised, and a test can reach in and assert on the raw arithmetic before it is rounded for
 * display.
 *
 * @returns {object} a fresh scoring state
 */
export function createScoreState() {
  return {
    /** Marks the object as one of ours, so a public entry point can refuse a stray argument. */
    isScoreState: true,

    /** Live total, unrounded. The authoritative player-facing number comes from `finishScore`. */
    score: 0,
    /** Current multiplier, 1..maxMult. */
    mult: 1,
    /** Highest multiplier reached this shift, for badges. */
    peakMult: 1,
    /** Seconds of unbroken in-band time backing the current multiplier. */
    holdTime_s: 0,
    /** Seconds continuously outside the band. The grace timer. */
    outTime_s: 0,
    /** Longest unbroken in-band hold this shift, s. */
    bestHold_s: 0,
    /** Whether the last accepted sample was inside the band. */
    inBand: true,

    /** Simulated seconds accepted. */
    elapsed_s: 0,
    /** Samples accepted. */
    samples: 0,
    /** Seconds spent inside the band. */
    inBandTime_s: 0,
    /** Seconds spent outside it. */
    outBandTime_s: 0,
    /** Integrated absolute error, EU-s. The honest quality metric, kept for the scorecard. */
    iae: 0,
    /** Largest absolute deviation seen, EU. */
    maxAbsErr: 0,
    /** Total controller-output travel, percent. */
    coTravel_pct: 0,
    /** Last output seen, so travel can be derived when the caller does not supply `dCo`. */
    lastCo: NaN,
    /** Seconds cavitating. */
    cavTime_s: 0,
    /** Seconds below minimum flow. */
    minFlowTime_s: 0,
    /** Seconds in either hazard — what is actually charged, since the two overlap. */
    hazardTime_s: 0,
    /** Alarm ids currently standing, so an alarm is charged on its rising edge only. */
    activeAlarms: [],
    /** How many alarms were raised. */
    alarmCount: 0,
    /** Whether a trip ended the shift. */
    tripped: false,
    /** Whether the shift is over and lost. */
    failed: false,
    /** Why it is over, for the scorecard. */
    failReason: '',

    /**
     * The scoring buckets. `score` is always their sum, and `finishScore` turns them into the
     * breakdown, so the parts cannot drift away from the total.
     */
    earned: {
      inBand: 0,
      outBand: 0,
      thrash: 0,
      alarm: 0,
      hazard: 0,
      events: 0,
    },
    /** One-off awards and penalties, grouped by label when the breakdown is built. */
    eventLog: [],
    /** Queued floating numbers for the HUD, drained by {@link takePops}. */
    pops: [],
    /** Monotonic pop id. Not random — a replay must produce the same ids. */
    popSeq: 0,
    /** Set once `finishScore` has run, so a late scan cannot change a published result. */
    finished: false,
  };
}

/**
 * Queue a floating number for the HUD.
 * @param {object} st scoring state (mutated)
 * @param {string} kind a class for the HUD to style on: 'award', 'penalty', 'combo', 'alarm',
 *   'hazard' or 'fail'
 * @param {number} amount points, signed; zero for a status pop that carries only a label
 * @param {string} label what to show
 * @returns {void}
 */
function pop(st, kind, amount, label) {
  st.popSeq += 1;
  st.pops.push({ amount, label, kind, id: st.popSeq });
  // Drop the oldest rather than the newest: the most recent pop is the one the player is looking
  // for an explanation of.
  while (st.pops.length > SCORE.MAX_POPS) st.pops.shift();
}

/**
 * Recompute the live total from the buckets.
 *
 * Deliberately a recomputation rather than an increment. Two of the buckets are themselves derived
 * from running totals (travel, hazard seconds), and adding their per-scan slice to a separate
 * total would accumulate a different rounding error than the bucket does — the parts would stop
 * summing to the whole after a few thousand scans, which is precisely the defect this module is
 * not allowed to have.
 *
 * @param {object} st scoring state (mutated)
 * @returns {void}
 */
function retotal(st) {
  const e = st.earned;
  st.score = e.inBand + e.outBand + e.thrash + e.alarm + e.hazard + e.events;
}

/**
 * Normalise the alarm list to plain ids. The alarm layer hands out records; a HUD replaying a
 * ghost hands out strings.
 * @param {*} alarms whatever the caller passed as `sample.alarms`
 * @returns {string[]} the ids
 */
function alarmIds(alarms) {
  if (!Array.isArray(alarms)) return [];
  const out = [];
  for (const a of alarms) {
    if (typeof a === 'string') out.push(a);
    else if (a && typeof a === 'object' && typeof a.id === 'string') out.push(a.id);
  }
  return out;
}

/**
 * Advance the score by one controller scan.
 *
 * @param {object} st scoring state from {@link createScoreState} (mutated)
 * @param {object} rules band and penalty rates; see {@link resolveRules} for what may be omitted
 * @param {object} sample what the loop looked like this scan
 * @param {number} sample.pv the measurement, engineering units
 * @param {number} sample.sp the setpoint, engineering units
 * @param {number} [sample.co] controller output, percent — used for travel when `dCo` is absent
 * @param {number} [sample.dCo] output travel this scan, percent; the caller usually knows it
 *   exactly and the sign is ignored
 * @param {Array<string|{id:string}>} [sample.alarms] alarms standing this scan
 * @param {boolean} [sample.cavitating] true while any pump is cavitating
 * @param {boolean} [sample.minFlow] true while any running pump is below its minimum flow
 * @param {boolean} [sample.tripped] true on the scan a pump trips — ends the shift
 * @param {number} dt_s scan period, s
 * @returns {undefined|{ok:false, reason:string}} nothing on success; a refusal when the sample or
 *   the state is unusable, so a broken caller loses one scan rather than poisoning the total with
 *   a NaN that would make every later comparison false
 */
export function stepScore(st, rules, sample, dt_s) {
  if (!st || st.isScoreState !== true) {
    return { ok: false, reason: 'no scoring state was supplied to score this scan against.' };
  }
  if (st.finished) {
    return { ok: false, reason: 'this shift has already been scored and cannot be added to.' };
  }
  if (st.failed) {
    return { ok: false, reason: `the shift ended: ${st.failReason}` };
  }
  if (!sample || typeof sample !== 'object') {
    return { ok: false, reason: 'no sample was supplied to score this scan against.' };
  }
  if (!Number.isFinite(dt_s) || dt_s < 0) {
    return { ok: false, reason: 'the scan period is not a positive number of seconds.' };
  }
  // A dt of exactly zero is legal and common — a paused simulator still ticks the UI — and it
  // means nothing happened. Accruing a rising edge or a travel charge for no elapsed time would
  // let a paused game be farmed by whoever noticed.
  if (dt_s === 0) return undefined;

  const { pv, sp } = sample;
  if (!Number.isFinite(pv) || !Number.isFinite(sp)) {
    return { ok: false, reason: 'the measurement or the setpoint is not a number this scan.' };
  }

  const r = resolveRules(rules);
  const err = pv - sp;
  const absErr = Math.abs(err);

  st.elapsed_s += dt_s;
  st.samples += 1;
  st.iae += absErr * dt_s;
  if (absErr > st.maxAbsErr) st.maxAbsErr = absErr;

  // --- the band ------------------------------------------------------------------------------
  // Inclusive at the edge: a measurement sitting exactly on the line is inside it. An exclusive
  // test would make a perfectly held loop flicker on the rounding of the last bit.
  const inBand = absErr <= r.band;
  st.inBand = inBand;

  if (inBand) {
    st.inBandTime_s += dt_s;
    st.outTime_s = 0;
    // Accrue at the multiplier the player currently holds, THEN advance the hold. Otherwise the
    // scan that crosses the eight-second mark is paid twice for the same second.
    st.earned.inBand += r.inBandRate * st.mult * dt_s;
    st.holdTime_s += dt_s;
    if (st.holdTime_s > st.bestHold_s) st.bestHold_s = st.holdTime_s;
    const next = Math.min(r.maxMult, 1 + Math.floor(st.holdTime_s / r.multStep_s));
    if (next > st.mult) {
      st.mult = next;
      if (next > st.peakMult) st.peakMult = next;
      pop(st, 'combo', 0, `x${next}`);
    }
  } else {
    st.outBandTime_s += dt_s;
    st.outTime_s += dt_s;
    // Charged from the first scan outside, with no grace. The grace protects the multiplier, not
    // the arithmetic: an offset that is real should cost from the moment it appears.
    const rate = Math.min(r.outRateMax, r.outRate * (absErr / r.band));
    st.earned.outBand -= rate * dt_s;
    if (st.mult > 1 && st.outTime_s >= r.grace_s) {
      pop(st, 'penalty', 0, `x${st.mult} LOST`);
      st.mult = 1;
    }
    // The hold restarts once the grace is spent, whether or not a multiplier was standing.
    if (st.outTime_s >= r.grace_s) st.holdTime_s = 0;
  }

  // --- output travel -------------------------------------------------------------------------
  let travel = 0;
  if (Number.isFinite(sample.dCo)) {
    travel = Math.abs(sample.dCo);
  } else if (Number.isFinite(sample.co) && Number.isFinite(st.lastCo)) {
    travel = Math.abs(sample.co - st.lastCo);
  }
  if (Number.isFinite(sample.co)) st.lastCo = sample.co;
  st.coTravel_pct += travel;
  st.earned.thrash = -(st.coTravel_pct * r.thrashPenalty);

  // --- alarms, on the rising edge only -------------------------------------------------------
  const ids = alarmIds(sample.alarms);
  for (const id of ids) {
    if (!st.activeAlarms.includes(id)) {
      st.alarmCount += 1;
      pop(st, 'alarm', -r.alarmPenalty, id);
    }
  }
  // Replace rather than merge: an alarm that clears and comes back is a second failure and is
  // charged again, which is the behaviour an operator would expect from a shift report.
  st.activeAlarms = ids;
  st.earned.alarm = -(st.alarmCount * r.alarmPenalty);

  // --- damage ---------------------------------------------------------------------------------
  if (sample.cavitating) st.cavTime_s += dt_s;
  if (sample.minFlow) st.minFlowTime_s += dt_s;
  // One rate for both. Cavitation and minimum-flow recirculation usually arrive together on this
  // rig, and charging them twice for one hydraulic condition would make a single bad minute
  // unrecoverable.
  if (sample.cavitating || sample.minFlow) st.hazardTime_s += dt_s;
  st.earned.hazard = -(st.hazardTime_s * r.cavPenalty);

  retotal(st);

  // --- the trip ends the shift ----------------------------------------------------------------
  // Checked last, so the scan that caused the trip is still charged for the deviation and the
  // damage that led to it.
  if (sample.tripped) {
    st.tripped = true;
    st.failed = true;
    st.failReason = 'a pump tripped.';
    pop(st, 'fail', 0, 'TRIP — SHIFT FAILED');
  }

  return undefined;
}

/**
 * Award or charge a one-off, from outside the per-scan arithmetic: a diagnosis called correctly, a
 * telegraphed upset ridden out, a supervisor's setpoint change hit on time.
 *
 * @param {object} st scoring state (mutated)
 * @param {string} kind a class for the HUD to style on, e.g. 'award' or 'penalty'
 * @param {number} amount points, signed — negative for a charge
 * @param {string} label what to show, and how the line is grouped in the breakdown
 * @returns {undefined|{ok:false, reason:string}} nothing on success, a refusal otherwise
 */
export function scoreEvent(st, kind, amount, label) {
  if (!st || st.isScoreState !== true) {
    return { ok: false, reason: 'no scoring state was supplied to award against.' };
  }
  if (st.finished) {
    return { ok: false, reason: 'this shift has already been scored and cannot be added to.' };
  }
  if (!Number.isFinite(amount)) {
    return { ok: false, reason: 'an award has to be a number of points.' };
  }
  const text = typeof label === 'string' && label ? label : 'bonus';
  st.eventLog.push({ kind: typeof kind === 'string' ? kind : 'event', amount, label: text });
  st.earned.events += amount;
  retotal(st);
  pop(st, typeof kind === 'string' ? kind : 'event', amount, text);
  return undefined;
}

/**
 * Take the queued pops and empty the queue.
 * @param {object} st scoring state (mutated)
 * @returns {Array<{amount:number,label:string,kind:string,id:number}>} the pops, oldest first
 */
export function takePops(st) {
  if (!st || st.isScoreState !== true || st.pops.length === 0) return [];
  const out = st.pops;
  st.pops = [];
  return out;
}

/**
 * The best medal a score reaches.
 * @param {number} score the final score
 * @param {{bronze:number,silver:number,gold:number}} [thresholds] per-mission thresholds
 * @returns {'none'|'bronze'|'silver'|'gold'} the medal
 */
export function medalFor(score, thresholds) {
  if (!Number.isFinite(score) || !thresholds || typeof thresholds !== 'object') return 'none';
  const { bronze, silver, gold } = thresholds;
  if (Number.isFinite(gold) && score >= gold) return 'gold';
  if (Number.isFinite(silver) && score >= silver) return 'silver';
  if (Number.isFinite(bronze) && score >= bronze) return 'bronze';
  return 'none';
}

/**
 * Group the one-off events into breakdown lines, one per label.
 *
 * Twenty separate "+25 upset ridden out" lines are a wall of text; one line reading
 * "Upset ridden out x20" is a scorecard.
 *
 * @param {object[]} log the event log
 * @returns {Array<{label:string, points:number}>} the lines, in first-award order
 */
function groupEvents(log) {
  const order = [];
  const byLabel = new Map();
  for (const e of log) {
    if (!byLabel.has(e.label)) { byLabel.set(e.label, { points: 0, n: 0 }); order.push(e.label); }
    const g = byLabel.get(e.label);
    g.points += e.amount;
    g.n += 1;
  }
  return order.map((label) => {
    const g = byLabel.get(label);
    return { label: g.n > 1 ? `${label} x${g.n}` : label, points: g.points };
  });
}

/**
 * Close the shift and produce the scorecard.
 *
 * The returned `score` is the sum of the rounded breakdown lines, not a separately computed total
 * that the lines are then expected to match. Both numbers are shown to the player and they must
 * agree exactly; defining one as the other is the only way to guarantee that.
 *
 * @param {object} st scoring state (mutated — the shift is marked finished)
 * @param {object} rules the same rules the shift was scored under, for the band in the stats
 * @param {object} [tail] end-of-shift facts
 * @param {number} [tail.energy_kWh] energy actually used
 * @param {number} [tail.parEnergy_kWh] what the mission budgeted
 * @param {number} [tail.duration_s] the shift's nominal length, if different from the time scored
 * @param {{bronze:number,silver:number,gold:number}} [tail.thresholds] medal thresholds
 * @returns {object|{ok:false, reason:string}} the frozen result {score, medal, breakdown, stats,
 *   failed}, or a refusal
 */
export function finishScore(st, rules, tail) {
  if (!st || st.isScoreState !== true) {
    return { ok: false, reason: 'no scoring state was supplied to grade.' };
  }
  const r = resolveRules(rules);
  const t = tail && typeof tail === 'object' ? tail : {};
  st.finished = true;

  // --- energy ---------------------------------------------------------------------------------
  const used_kWh = Number.isFinite(t.energy_kWh) ? t.energy_kWh : NaN;
  const par_kWh = Number.isFinite(t.parEnergy_kWh) ? t.parEnergy_kWh : NaN;
  const haveEnergy = used_kWh > 0 && par_kWh > 0;
  const energyRatio = haveEnergy ? par_kWh / used_kWh : NaN;
  // A failed shift gets no energy award. There is no credit for having been efficient right up to
  // the moment the machine tripped, and a run that ends after ten seconds would otherwise show a
  // spectacular kWh-per-shift ratio.
  const energyBonus = (haveEnergy && !st.failed)
    ? clamp(SCORE.ENERGY_BONUS * (energyRatio - 1), -SCORE.ENERGY_BONUS_MAX, SCORE.ENERGY_BONUS_MAX)
    : 0;

  // --- the breakdown --------------------------------------------------------------------------
  const lines = [
    { label: 'Time in band', points: st.earned.inBand },
    { label: 'Deviation outside band', points: st.earned.outBand },
    { label: 'Output travel', points: st.earned.thrash },
    {
      label: st.alarmCount === 1 ? 'Alarm raised' : `Alarms raised x${st.alarmCount}`,
      points: st.earned.alarm,
    },
    { label: 'Cavitation / minimum flow', points: st.earned.hazard },
    ...groupEvents(st.eventLog),
    { label: 'Energy against par', points: energyBonus },
  ];

  // Drop the lines that say nothing, but never drop the first: an empty scorecard reads as a bug,
  // and a zero-length shift is a legitimate thing to grade.
  const kept = lines.filter((l, i) => i === 0 || Math.round(l.points) !== 0);
  const breakdown = kept.map((l) => Object.freeze({ label: l.label, points: Math.round(l.points) }));
  if (st.failed) breakdown.push(Object.freeze({ label: `FAILED — ${st.failReason}`, points: 0 }));

  let score = 0;
  for (const l of breakdown) score += l.points;

  const duration_s = Number.isFinite(t.duration_s) && t.duration_s > 0
    ? t.duration_s : st.elapsed_s;
  const medal = st.failed ? 'none' : medalFor(score, t.thresholds);

  return Object.freeze({
    score,
    medal,
    failed: st.failed,
    breakdown: Object.freeze(breakdown),
    stats: Object.freeze({
      duration_s,
      scored_s: st.elapsed_s,
      samples: st.samples,
      band: r.band,
      bandEU: r.bandEU,
      inBandTime_s: st.inBandTime_s,
      outBandTime_s: st.outBandTime_s,
      /** Fraction of the shift held inside the band — the headline quality number. */
      inBandFraction: st.elapsed_s > 0 ? st.inBandTime_s / st.elapsed_s : 0,
      bestHold_s: st.bestHold_s,
      peakMult: st.peakMult,
      finalMult: st.mult,
      iae: st.iae,
      maxAbsErr: st.maxAbsErr,
      coTravel_pct: st.coTravel_pct,
      alarmCount: st.alarmCount,
      cavTime_s: st.cavTime_s,
      minFlowTime_s: st.minFlowTime_s,
      hazardTime_s: st.hazardTime_s,
      tripped: st.tripped,
      energy_kWh: used_kWh,
      parEnergy_kWh: par_kWh,
      /** Par over actual: above 1 beat the budget, below 1 overspent it. */
      energyRatio,
      energyBonus,
      failReason: st.failReason,
    }),
  });
}
