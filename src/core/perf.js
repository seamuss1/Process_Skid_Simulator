/**
 * src/core/perf.js — the frame budget: what each stage of a frame costs, what gets dropped when
 * the frame runs out of room, how much quality the views may spend, and how far behind the
 * simulated clock has fallen.
 *
 * Layer L1: imports `core/util.js` and nothing else. No DOM, no `Date.now`, no `Math.random`.
 * Every function that needs a clock is handed one, so a frame trace can be replayed and will
 * produce the same decisions it produced live — which is the only way a performance report is
 * worth reading after the fact.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * A frame has to integrate the plant, scan the controller, run the ladder processor, step the
 * game session and repaint a view, and at 20x time compression the plant alone can want four
 * hundred integration ticks. Nothing arbitrated that. The failure mode is not a crash: it is a
 * frame that quietly takes 40 ms, a browser that quietly drops to 24 fps, an accumulator that
 * quietly discards the time it could not spend, and an operator who is told none of it while the
 * simulation he is being graded on runs slower than the clock on his screen.
 *
 * So: measure every stage, decide what to drop in an order somebody can defend, tell the status
 * bar what was dropped and why, and account for the simulated seconds that were never integrated
 * instead of dropping them on the floor.
 *
 * THE PRIORITY ORDER IS NOT NEGOTIABLE
 *
 * PHYSICS and CONTROL are marked essential and are never skipped, at any overrun, for any reason.
 * Skipping physics stops time — the plant simply does not evolve, and every number downstream is
 * a lie about a moment that never happened. Skipping the controller opens the loop: the final
 * element holds its last output while the process moves, which is a genuine plant upset injected
 * by the renderer. A frame that cannot afford them takes longer than 16 ms and SAYS SO. That is
 * the honest failure: a slow simulation an operator can see is recoverable, a fast one that has
 * silently stopped controlling is not.
 *
 * Everything above them is dropped in reverse order of consequence: decoration (nobody is graded
 * on particles), then analysis (a Bode plot one frame stale is the same Bode plot), then the
 * trend repaint, then the visible pane, then the game session, then the ladder — last, because
 * the ladder writes real outputs and a dropped scan is a dropped scan.
 *
 * THE STARVATION GUARD
 *
 * A stage that is over budget forever would otherwise be skipped forever, and a trend that has
 * not repainted in a minute is indistinguishable from a frozen application. So a stage that has
 * been skipped {@link PERF.MAX_SKIPS} frames running is forced back into the next frame even
 * though it will blow the budget. One long frame every half second beats a dead panel.
 *
 * A SLOW MACHINE AND A BACKGROUNDED TAB NEED OPPOSITE RESPONSES
 *
 * Both look identical from inside the frame callback: a long gap since the previous frame. They
 * are not the same event and must not get the same treatment.
 *
 *   A SLOW MACHINE spends the gap. The work we measured inside our own callback accounts for most
 *   of the interval, so the right response is to degrade quality and admit the deficit.
 *
 *   A BACKGROUNDED TAB spends nothing. `requestAnimationFrame` is simply not called, and when it
 *   resumes the gap is a second long while our measured work was two milliseconds. Degrading
 *   quality here is exactly wrong: the machine is fine, and one alt-tab would permanently drop
 *   the rig to minimal quality and report a deficit the operator never caused. The right response
 *   is to discard the wall time and count it as a stall, separately.
 *
 * {@link classifyFrame} separates them on that accounting test — how much of the gap we can show
 * a receipt for — with the page-visibility flag, when the caller has one, as corroboration rather
 * than as the only evidence.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from './util.js';

/** The stage ids. Callers name stages with these, never with bare strings. */
export const STAGE = Object.freeze({
  PHYSICS: 'physics',
  CONTROL: 'control',
  LADDER: 'ladder',
  GAME: 'game',
  VIEW: 'view',
  TREND: 'trend',
  ANALYSIS: 'analysis',
  DECORATION: 'decoration',
});

/**
 * Every stage of a frame, in order of consequence: index 0 is the one the simulator cannot do
 * without. `essential` stages are never skipped. `why` is shown to the operator when the stage is
 * dropped, so each one has to justify itself in a sentence.
 */
export const STAGES = Object.freeze([
  Object.freeze({
    id: STAGE.PHYSICS,
    label: 'physics',
    essential: true,
    why: 'the plant integration — skipping it stops time',
  }),
  Object.freeze({
    id: STAGE.CONTROL,
    label: 'controller',
    essential: true,
    why: 'the controller scan — skipping it opens the loop',
  }),
  Object.freeze({
    id: STAGE.LADDER,
    label: 'ladder',
    essential: false,
    why: 'the ladder processor — a dropped scan is a dropped scan, so it goes last',
  }),
  Object.freeze({
    id: STAGE.GAME,
    label: 'session',
    essential: false,
    why: 'scoring, missions and the director — one frame of credit',
  }),
  Object.freeze({
    id: STAGE.VIEW,
    label: 'view',
    essential: false,
    why: 'the visible pane repaint — the screen holds its last frame',
  }),
  Object.freeze({
    id: STAGE.TREND,
    label: 'trend',
    essential: false,
    why: 'the trend repaint — the samples are still logged, only the drawing waits',
  }),
  Object.freeze({
    id: STAGE.ANALYSIS,
    label: 'analysis',
    essential: false,
    why: 'Bode, Nyquist and loop diagnostics — a frame-old curve is the same curve',
  }),
  Object.freeze({
    id: STAGE.DECORATION,
    label: 'decoration',
    essential: false,
    why: 'particles, glow and animated flow — cosmetic, and first to go',
  }),
]);

/** Stage records by id, for O(1) lookup without rebuilding a map per frame. */
const STAGE_BY_ID = Object.freeze(Object.fromEntries(STAGES.map((s) => [s.id, s])));

/**
 * The order stages are evicted in: the reverse of {@link STAGES}, so the least consequential goes
 * first. Precomputed and frozen because the eviction loop runs every frame and must not sort.
 */
export const EVICTION_ORDER = Object.freeze(
  STAGES.filter((s) => !s.essential).map((s) => s.id).reverse(),
);

/** Adaptive quality levels, best first. */
export const QUALITY = Object.freeze({
  FULL: 'full',
  REDUCED: 'reduced',
  MINIMAL: 'minimal',
});

/** The levels in descending order of cost, so stepping is index arithmetic. */
export const QUALITY_ORDER = Object.freeze([QUALITY.FULL, QUALITY.REDUCED, QUALITY.MINIMAL]);

/**
 * What each quality level asks the views to do. These are HINTS: a view reads the fields it
 * understands and ignores the rest, so a new view cannot break the budget manager and the budget
 * manager cannot break a view that has never heard of particles.
 *
 * `gaugeSmoothing` is the first-order lag coefficient a needle should use, in the sense of
 * `util.lag`: at minimal quality it is zero, meaning the needle snaps to the value instead of
 * being animated toward it over several frames that we cannot afford to draw.
 */
export const QUALITY_HINTS = Object.freeze({
  [QUALITY.FULL]: Object.freeze({
    level: QUALITY.FULL,
    particles: 240,
    trendDecimation: 1,
    gaugeSmoothing: 0.85,
    gradients: true,
    animate: true,
    maxSeriesPoints: 2000,
  }),
  [QUALITY.REDUCED]: Object.freeze({
    level: QUALITY.REDUCED,
    particles: 64,
    trendDecimation: 3,
    gaugeSmoothing: 0.55,
    gradients: false,
    animate: true,
    maxSeriesPoints: 800,
  }),
  [QUALITY.MINIMAL]: Object.freeze({
    level: QUALITY.MINIMAL,
    particles: 0,
    trendDecimation: 8,
    gaugeSmoothing: 0,
    gradients: false,
    animate: false,
    maxSeriesPoints: 300,
  }),
});

/** How a frame's inter-frame gap was explained. */
export const FRAME = Object.freeze({
  /** The gap is a normal frame interval. */
  OK: 'ok',
  /** The gap is long and we can account for it: the machine is slow. Degrade. */
  SLOW: 'slow',
  /** The gap is long and unaccounted for: the tab was not being run. Discard, do not degrade. */
  STALL: 'stall',
});

/**
 * The tuning constants. Every one of these is a number somebody will eventually want to argue
 * with, so each says where it came from.
 */
export const PERF = Object.freeze({
  /** One frame at 60 Hz, ms. The whole budget, not a share of it. */
  BUDGET_MS: 16.7,
  /**
   * Weight of a new sample in each stage's exponentially weighted average. A quarter gives a
   * time constant of about four frames — fast enough to notice a view that just got expensive,
   * slow enough that one garbage collection does not empty the screen.
   */
  ALPHA: 0.25,
  /** Per-frame decay of the remembered worst cost, so an old spike fades out of the report. */
  PEAK_DECAY: 0.97,
  /** Frames kept for the rolling worst-frame figure. Two seconds at 60 Hz. */
  WINDOW: 120,
  /**
   * Inter-frame gap, ms, beyond which a frame needs explaining. 250 ms is fifteen frames: far
   * longer than any hardware that can render at all takes, and far shorter than the one-second
   * timer clamp a hidden tab gets.
   */
  STALL_GAP_MS: 250,
  /**
   * Fraction of a long gap we must be able to account for as our own measured work before the
   * gap is blamed on the machine rather than on the tab not being scheduled. Half is generous to
   * the machine on purpose: calling a slow machine a stall would stop it degrading, and that is
   * the failure that ends in a slideshow.
   */
  ACCOUNTED_FRAC: 0.5,
  /** Multiple of the budget a short gap may reach before the frame counts as slow. */
  SLOW_FACTOR: 1.5,
  /** Consecutive over-budget frames before quality steps down. Three rides out one hiccup. */
  DEGRADE_FRAMES: 3,
  /**
   * Consecutive comfortable frames before quality steps back up. A second and a half at 60 Hz:
   * recovery is deliberately far slower than degradation, because a display that flips between
   * quality levels twice a second is worse than one that stays at the lower level.
   */
  RECOVER_FRAMES: 90,
  /** Demand, as a fraction of budget, above which a frame counts as over budget. */
  DEGRADE_LOAD: 1.0,
  /** Demand, as a fraction of budget, below which a frame counts as comfortable. */
  RECOVER_LOAD: 0.6,
  /** Frames a stage may be skipped in a row before it is forced back in. See the header. */
  MAX_SKIPS: 30,
  /** Simulated seconds below which a shortfall is float noise rather than a deficit. */
  DEFICIT_EPS_S: 1e-6,
  /** Consecutive on-time frames that close a deficit episode. Half a second at 60 Hz. */
  CLEAR_FRAMES: 30,
});

/**
 * Read a finite number from an options bag, falling back to a default.
 * @param {*} x the candidate
 * @param {number} dflt the fallback
 * @returns {number} `x` if it is a finite number, else `dflt`
 */
function numOr(x, dflt) {
  return (typeof x === 'number' && Number.isFinite(x)) ? x : dflt;
}

/**
 * Fold one sample into an exponentially weighted average.
 *
 * The first sample SEEDS the average rather than being blended with a zero, because a stage's
 * first measured cost is the best estimate available and blending it toward zero would let the
 * scheduler believe, for the first several frames, that a 30 ms view costs 7 ms.
 *
 * @param {{ewma:number, samples:number}} acc the accumulator, mutated
 * @param {number} x the new sample
 * @param {number} alpha the weight of the new sample, 0..1
 * @returns {number} the updated average
 */
function ewmaPush(acc, x, alpha) {
  if (acc.samples === 0) acc.ewma = x;
  else acc.ewma += alpha * (x - acc.ewma);
  acc.samples += 1;
  return acc.ewma;
}

/**
 * Create the frame-budget manager.
 *
 * @param {object} [opts] overrides
 * @param {number} [opts.budgetMs] frame budget, ms
 * @param {number} [opts.alpha] weight of a new cost sample, 0..1
 * @param {number} [opts.stallGapMs] gap beyond which a frame must be explained, ms
 * @param {number} [opts.maxSkips] frames a stage may be skipped in a row
 * @returns {object} the perf state, owned by the caller and mutated in place
 */
export function createPerf(opts = {}) {
  const o = opts || {};
  /** @type {object} */
  const perf = {
    budgetMs: clamp(numOr(o.budgetMs, PERF.BUDGET_MS), 1, 10000),
    alpha: clamp(numOr(o.alpha, PERF.ALPHA), 0.001, 1),
    stallGapMs: clamp(numOr(o.stallGapMs, PERF.STALL_GAP_MS), 20, 60000),
    maxSkips: Math.max(1, Math.round(numOr(o.maxSkips, PERF.MAX_SKIPS))),

    /** Operator-pinned quality level, or null while quality is adaptive. */
    pinned: null,
    /** The level in force this frame. */
    quality: QUALITY.FULL,

    /** Per-stage cost records, keyed by stage id. */
    stages: {},

    /** The frame in progress. */
    frame: {
      index: -1,
      beginMs: 0,
      endMs: 0,
      /** Sum of the stages measured this frame, ms. */
      workMs: 0,
      /** Wall time from `beginFrame` to `endFrame`, ms — includes work nobody timed. */
      totalMs: 0,
      /** Interval since the previous frame began, ms. */
      gapMs: 0,
      /** One of {@link FRAME}. */
      kind: FRAME.OK,
      /** Whether the caller told us the page was hidden. */
      hidden: false,
      /** Whether `endFrame` has closed this frame. */
      closed: true,
    },
    /** What the previous frame cost, kept for the stall/slow discrimination. */
    prev: { beginMs: 0, totalMs: 0, workMs: 0, started: false },

    /** Rolling averages. */
    frameMs: { ewma: 0, samples: 0 },
    gapMs: { ewma: 0, samples: 0 },

    /** Ring of recent frame durations, for the rolling worst figure. */
    window: new Float64Array(PERF.WINDOW),
    windowI: 0,
    windowN: 0,

    /** Consecutive over-budget and comfortable frames, for the quality hysteresis. */
    hot: 0,
    cool: 0,
    /** Frames classified slow and stalled since the last reset. */
    slowFrames: 0,
    stallFrames: 0,

    /**
     * The current plan. This is the SAME OBJECT every frame — read it, do not keep it. A frame
     * loop that allocated a plan, a skip list and a hints object sixty times a second would be
     * feeding the garbage collector the very jitter this module exists to remove.
     */
    plan: {
      index: -1,
      budgetMs: 0,
      /** What every stage would cost if none were skipped, ms. */
      demandMs: 0,
      /** What the surviving stages are expected to cost, ms. */
      projectedMs: 0,
      /** How far the survivors are still expected to exceed the budget, ms. */
      overMs: 0,
      /** True when anything was skipped this frame. */
      degraded: false,
      /** Quality level in force. */
      quality: QUALITY.FULL,
      /** Stage ids skipped this frame, in the order they were evicted. */
      skipped: [],
      /** Stage id -> whether it may run this frame. */
      runs: {},
      /** Stage id -> why it was skipped, for the status bar. */
      reasons: {},
    },

    /**
     * Simulated time the wall clock outran. `dropped_s` is time the plant was asked for and never
     * integrated; it is NOT banked, because catching up produces a transient the operator did not
     * cause — but it is counted and reported, which is the part that was missing.
     */
    deficit: {
      behind: false,
      dropped_s: 0,
      requested_s: 0,
      sinceMs: 0,
      forMs: 0,
      episodes: 0,
      totalDropped_s: 0,
      worstRatio: 0,
      clearFrames: 0,
    },

    /** Simulated time discarded because the tab was not running. Deliberately not a deficit. */
    stall: { count: 0, dropped_s: 0, lastGapMs: 0, totalGapMs: 0 },
  };

  for (const s of STAGES) {
    perf.stages[s.id] = {
      id: s.id,
      /** Exponentially weighted cost, ms. */
      ewma: 0,
      /** Samples folded in, so the first one can seed rather than blend. */
      samples: 0,
      /** Cost measured on the last frame that ran it, ms. */
      lastMs: 0,
      /** Decaying worst cost, ms. */
      peakMs: 0,
      /** `stageStart` timestamp while the stage is being timed, else -1. */
      startMs: -1,
      /** Consecutive frames this stage has been skipped, for the starvation guard. */
      consecutiveSkips: 0,
      /** Skips since the last reset, for the report. */
      totalSkips: 0,
    };
    perf.plan.runs[s.id] = true;
    perf.plan.reasons[s.id] = '';
  }

  return perf;
}

/**
 * Change the budget or the smoothing at runtime — the settings view offers both, because a
 * 144 Hz panel and a 30 Hz laptop want different budgets and neither is wrong.
 *
 * @param {object} perf the perf state
 * @param {object} patch fields to change: `budgetMs`, `alpha`, `stallGapMs`, `maxSkips`
 * @returns {{ok:boolean, reason?:string}} refusal carries the reason verbatim
 */
export function configure(perf, patch) {
  if (!perf || !perf.stages) return { ok: false, reason: 'no performance state' };
  if (!patch || typeof patch !== 'object') return { ok: false, reason: 'nothing to change' };

  if ('budgetMs' in patch) {
    const v = patch.budgetMs;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 10000) {
      return { ok: false, reason: 'the frame budget must be between 1 and 10000 ms' };
    }
    perf.budgetMs = v;
  }
  if ('alpha' in patch) {
    const v = patch.alpha;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) {
      return { ok: false, reason: 'the smoothing weight must be above 0 and at most 1' };
    }
    perf.alpha = v;
  }
  if ('stallGapMs' in patch) {
    const v = patch.stallGapMs;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 20) {
      return { ok: false, reason: 'the stall threshold must be at least 20 ms, or every frame is a stall' };
    }
    perf.stallGapMs = v;
  }
  if ('maxSkips' in patch) {
    const v = patch.maxSkips;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
      return { ok: false, reason: 'a stage must be allowed back in after at least one frame' };
    }
    perf.maxSkips = Math.round(v);
  }
  return { ok: true };
}

/**
 * Pin the quality level, or hand it back to the adaptive rule.
 *
 * Offered because an operator recording a video wants full quality whatever it costs, and one on
 * a projector wants minimal whatever the frame time says.
 *
 * @param {object} perf the perf state
 * @param {?string} level one of {@link QUALITY}, or null to resume adapting
 * @returns {{ok:boolean, reason?:string}} refusal carries the reason verbatim
 */
export function setQuality(perf, level) {
  if (!perf || !perf.stages) return { ok: false, reason: 'no performance state' };
  if (level === null || level === undefined) {
    perf.pinned = null;
    return { ok: true };
  }
  if (!QUALITY_ORDER.includes(level)) {
    return { ok: false, reason: `unknown quality level '${level}' — expected one of ${QUALITY_ORDER.join(', ')}` };
  }
  perf.pinned = level;
  perf.quality = level;
  return { ok: true };
}

/**
 * Decide what a long gap between frames means.
 *
 * Pure, and exported on its own so the discrimination can be tested and argued about without
 * building a frame loop. See the module header for why the two cases must not be conflated.
 *
 * @param {number} gapMs interval since the previous frame began, ms
 * @param {number} workMs wall time the previous frame actually spent inside the callback, ms
 * @param {number} budgetMs the frame budget, ms
 * @param {number} stallGapMs the gap beyond which a frame needs explaining, ms
 * @param {boolean} [hidden] the caller's page-visibility flag, when it has one
 * @returns {string} one of {@link FRAME}
 */
export function classifyFrame(gapMs, workMs, budgetMs, stallGapMs, hidden) {
  // A page that says it is hidden is hidden. No amount of timing arithmetic beats being told.
  if (hidden === true) return FRAME.STALL;
  if (!Number.isFinite(gapMs) || gapMs <= 0) return FRAME.OK;
  if (gapMs < stallGapMs) return gapMs > budgetMs * PERF.SLOW_FACTOR ? FRAME.SLOW : FRAME.OK;
  // Long gap. We spent it, or something else did. A receipt for half of it is enough to own it.
  const accounted = Number.isFinite(workMs) ? workMs : 0;
  return accounted >= gapMs * PERF.ACCOUNTED_FRAC ? FRAME.SLOW : FRAME.STALL;
}

/**
 * Move the quality level one step, with hysteresis, from this frame's demand.
 *
 * Stalled frames move nothing: a backgrounded tab is not evidence about the machine, and letting
 * one alt-tab drop the rig to minimal quality is the exact bug this discrimination prevents.
 *
 * @param {object} perf the perf state
 * @param {number} demandMs what all stages would have cost this frame, ms
 * @param {string} kind the frame classification
 * @returns {string} the level now in force
 */
function stepQuality(perf, demandMs, kind) {
  if (perf.pinned) {
    perf.quality = perf.pinned;
    return perf.quality;
  }
  if (kind === FRAME.STALL) return perf.quality;

  // Three bands, not two. The gap between RECOVER_LOAD and DEGRADE_LOAD is the hysteresis: a
  // frame landing in it is evidence for neither direction and resets both counters, so a rig
  // sitting at eighty percent of budget holds its level instead of flapping across a threshold.
  const load = demandMs / perf.budgetMs;
  if (load > PERF.DEGRADE_LOAD) {
    perf.hot += 1;
    perf.cool = 0;
  } else if (load < PERF.RECOVER_LOAD) {
    perf.cool += 1;
    perf.hot = 0;
  } else {
    perf.hot = 0;
    perf.cool = 0;
  }

  const i = QUALITY_ORDER.indexOf(perf.quality);
  if (perf.hot >= PERF.DEGRADE_FRAMES && i < QUALITY_ORDER.length - 1) {
    perf.quality = QUALITY_ORDER[i + 1];
    perf.hot = 0;
  } else if (perf.cool >= PERF.RECOVER_FRAMES && i > 0) {
    perf.quality = QUALITY_ORDER[i - 1];
    perf.cool = 0;
  }
  return perf.quality;
}

/**
 * Build this frame's plan: what may run, what is dropped, and how far over we still are.
 *
 * Evicts in {@link EVICTION_ORDER} until the projection fits, and stops there — dropping a stage
 * that was not needed to make room is a stage nobody saw for no reason.
 *
 * @param {object} perf the perf state
 * @returns {object} `perf.plan`, mutated in place
 */
function buildPlan(perf) {
  const plan = perf.plan;
  plan.index = perf.frame.index;
  plan.budgetMs = perf.budgetMs;
  plan.skipped.length = 0;

  let demand = 0;
  for (const s of STAGES) {
    const rec = perf.stages[s.id];
    plan.runs[s.id] = true;
    plan.reasons[s.id] = '';
    demand += rec.ewma;
  }
  plan.demandMs = demand;

  let projected = demand;
  for (const id of EVICTION_ORDER) {
    if (projected <= perf.budgetMs) break;
    const rec = perf.stages[id];
    // A stage that has never cost anything cannot buy anything back, and naming it in the skip
    // list would tell the operator we dropped something we in fact never ran.
    if (rec.ewma <= 0) continue;
    // The starvation guard. See the module header: one long frame beats a dead panel.
    if (rec.consecutiveSkips >= perf.maxSkips) continue;
    plan.runs[id] = false;
    plan.reasons[id] = STAGE_BY_ID[id].why;
    plan.skipped.push(id);
    projected -= rec.ewma;
  }

  for (const s of STAGES) {
    const rec = perf.stages[s.id];
    if (plan.runs[s.id]) rec.consecutiveSkips = 0;
    else { rec.consecutiveSkips += 1; rec.totalSkips += 1; }
  }

  plan.projectedMs = projected;
  // Physics and controller are in this number and are never taken out of it. When the essentials
  // alone exceed the budget, `overMs` is how much the frame is going to overrun, stated plainly,
  // because the alternative is a simulator that lies about the time.
  plan.overMs = Math.max(0, projected - perf.budgetMs);
  plan.degraded = plan.skipped.length > 0;
  plan.quality = perf.quality;
  return plan;
}

/**
 * Open a frame: classify the gap since the last one, adapt the quality level, and plan.
 *
 * @param {object} perf the perf state
 * @param {number} nowMs the frame timestamp, ms, from the caller's clock
 * @param {boolean} [hidden] the page-visibility flag, if the caller has one
 * @returns {object} the live plan — read it this frame, do not retain it
 */
export function beginFrame(perf, nowMs, hidden) {
  const f = perf.frame;

  // Classify from the PREVIOUS frame: the gap that reveals a backgrounded tab is the interval
  // between frame starts, and the work that explains it happened inside that interval.
  const gapMs = perf.prev.started ? nowMs - perf.prev.beginMs : 0;
  const spentMs = Math.max(perf.prev.totalMs, perf.prev.workMs);
  const kind = perf.prev.started
    ? classifyFrame(gapMs, spentMs, perf.budgetMs, perf.stallGapMs, hidden)
    : FRAME.OK;

  if (kind === FRAME.SLOW) perf.slowFrames += 1;
  if (kind === FRAME.STALL) {
    perf.stallFrames += 1;
    perf.stall.count += 1;
    perf.stall.lastGapMs = gapMs;
    perf.stall.totalGapMs += gapMs;
  }
  // A stall's gap is not a frame interval, so folding it into the fps average would report two
  // frames a second for the next half minute over an event that lasted one frame.
  if (kind !== FRAME.STALL && gapMs > 0) ewmaPush(perf.gapMs, gapMs, perf.alpha);

  f.index += 1;
  f.beginMs = nowMs;
  f.endMs = nowMs;
  f.workMs = 0;
  f.totalMs = 0;
  f.gapMs = gapMs;
  f.kind = kind;
  f.hidden = hidden === true;
  f.closed = false;

  for (const s of STAGES) perf.stages[s.id].startMs = -1;

  // Quality reacts to DEMAND, not to the frame time we achieved by skipping. Reacting to the
  // achieved time would let the scheduler skip its way to a comfortable frame and never lower
  // quality — trading a permanently dead trend for a full-quality one that is never drawn.
  let demand = 0;
  for (const s of STAGES) demand += perf.stages[s.id].ewma;
  stepQuality(perf, demand, kind);

  return buildPlan(perf);
}

/**
 * Ask whether a stage may run this frame.
 *
 * An unknown id answers yes: a stage this manager has never heard of is not something it may
 * silently disable.
 *
 * @param {object} perf the perf state
 * @param {string} id the stage id
 * @returns {boolean} true when the stage should run
 */
export function shouldRun(perf, id) {
  return perf.plan.runs[id] !== false;
}

/**
 * Start timing a stage.
 *
 * Hot path: this is void and tolerant rather than returning a refusal object, because allocating
 * a result object eight times a frame is precisely the cost this module exists to account for.
 * A bad id is ignored.
 *
 * @param {object} perf the perf state
 * @param {string} id the stage id
 * @param {number} nowMs the caller's clock, ms
 * @returns {void}
 */
export function stageStart(perf, id, nowMs) {
  const rec = perf.stages[id];
  if (rec) rec.startMs = nowMs;
}

/**
 * Stop timing a stage and fold its cost into the average.
 *
 * @param {object} perf the perf state
 * @param {string} id the stage id
 * @param {number} nowMs the caller's clock, ms
 * @returns {void}
 */
export function stageEnd(perf, id, nowMs) {
  const rec = perf.stages[id];
  if (!rec || rec.startMs < 0) return;
  const ms = Math.max(0, nowMs - rec.startMs);
  rec.startMs = -1;
  noteStage(perf, id, ms);
}

/**
 * Fold a stage cost measured by the caller straight into the average.
 *
 * Offered because `sim.advance` already times itself and a second pair of `performance.now`
 * calls around the same code would measure the measurement.
 *
 * @param {object} perf the perf state
 * @param {string} id the stage id
 * @param {number} ms the cost, ms
 * @returns {void}
 */
export function noteStage(perf, id, ms) {
  const rec = perf.stages[id];
  if (!rec || !Number.isFinite(ms) || ms < 0) return;
  rec.lastMs = ms;
  rec.peakMs = Math.max(ms, rec.peakMs * PERF.PEAK_DECAY);
  ewmaPush(rec, ms, perf.alpha);
  perf.frame.workMs += ms;
}

/**
 * Close the frame and fold its duration into the rolling window.
 *
 * @param {object} perf the perf state
 * @param {number} nowMs the caller's clock, ms
 * @returns {object} the frame record — the same object every frame, do not retain it
 */
export function endFrame(perf, nowMs) {
  const f = perf.frame;
  f.endMs = nowMs;
  f.totalMs = Math.max(0, nowMs - f.beginMs);
  f.closed = true;

  ewmaPush(perf.frameMs, f.totalMs, perf.alpha);
  perf.window[perf.windowI] = f.totalMs;
  perf.windowI = (perf.windowI + 1) % perf.window.length;
  if (perf.windowN < perf.window.length) perf.windowN += 1;

  perf.prev.beginMs = f.beginMs;
  perf.prev.totalMs = f.totalMs;
  perf.prev.workMs = f.workMs;
  perf.prev.started = true;
  return f;
}

/**
 * Account for the simulated time the frame was asked for against the time it actually integrated.
 *
 * Call once per frame, after the physics stage, inside the frame. The shortfall is not banked —
 * `core/sim.js` drops it deliberately, because a simulator that sprints to catch up injects a
 * transient the operator did not cause — but from here on it is COUNTED: by how much, for how
 * long, and how often.
 *
 * A shortfall on a stalled frame is not a deficit. The tab was not running; the wall clock moved
 * and the plant did not, exactly as intended. It is tallied under {@link createPerf}'s `stall`
 * instead, so a tab switch does not read as a machine that cannot keep up.
 *
 * @param {object} perf the perf state
 * @param {number} requested_s simulated seconds the frame asked for (wall dt x speed, clamped)
 * @param {number} integrated_s simulated seconds actually integrated
 * @returns {object} the deficit record, mutated in place
 */
export function accountTime(perf, requested_s, integrated_s) {
  const d = perf.deficit;
  const want = Number.isFinite(requested_s) ? Math.max(0, requested_s) : 0;
  const got = Number.isFinite(integrated_s) ? Math.max(0, integrated_s) : 0;
  const short = want - got;

  if (perf.frame.kind === FRAME.STALL) {
    if (short > PERF.DEFICIT_EPS_S) perf.stall.dropped_s += short;
    return d;
  }

  if (short > PERF.DEFICIT_EPS_S) {
    if (!d.behind) {
      d.behind = true;
      d.sinceMs = perf.frame.beginMs;
      d.dropped_s = 0;
      d.requested_s = 0;
      d.episodes += 1;
    }
    d.clearFrames = 0;
    d.dropped_s += short;
    d.requested_s += want;
    d.totalDropped_s += short;
    d.forMs = Math.max(0, perf.frame.beginMs - d.sinceMs);
    if (want > 0) d.worstRatio = Math.max(d.worstRatio, short / want);
  } else if (d.behind) {
    d.requested_s += want;
    d.forMs = Math.max(0, perf.frame.beginMs - d.sinceMs);
    d.clearFrames += 1;
    // One on-time frame is not recovery — a loop that alternates catching up and falling behind
    // would otherwise open a new episode every other frame and report hundreds of them.
    if (d.clearFrames >= PERF.CLEAR_FRAMES) {
      d.behind = false;
      d.clearFrames = 0;
    }
  }
  return d;
}

/**
 * The quality hints the views should honour this frame.
 * @param {object} perf the perf state
 * @returns {object} the frozen hint table for the level in force
 */
export function qualityHints(perf) {
  return QUALITY_HINTS[perf.quality] || QUALITY_HINTS[QUALITY.FULL];
}

/**
 * The worst frame in the rolling window, ms.
 * @param {object} perf the perf state
 * @returns {number} the worst duration seen in the window, or 0 when nothing has been recorded
 */
export function worstFrameMs(perf) {
  let worst = 0;
  for (let i = 0; i < perf.windowN; i += 1) {
    if (perf.window[i] > worst) worst = perf.window[i];
  }
  return worst;
}

/**
 * One sentence about the deficit, or that there is not one.
 * @param {object} perf the perf state
 * @returns {string} the sentence
 */
export function deficitNote(perf) {
  const d = perf.deficit;
  if (!d.behind) {
    return d.episodes > 0
      ? `on time — ${d.totalDropped_s.toFixed(1)} s lost over ${d.episodes} earlier ${d.episodes === 1 ? 'spell' : 'spells'}`
      : 'on time';
  }
  const pct = d.requested_s > 0 ? Math.round((d.dropped_s / d.requested_s) * 100) : 0;
  return `behind by ${d.dropped_s.toFixed(1)} s of simulation over ${(d.forMs / 1000).toFixed(1)} s of wall clock (${pct}% of what was asked for)`;
}

/**
 * The rolling report the status bar shows.
 *
 * Allocates — it is meant to be called a few times a second at most, not every frame. The frame
 * loop reads `perf.plan` and `qualityHints` instead, both of which allocate nothing.
 *
 * @param {object} perf the perf state
 * @returns {object} `{fps, frameMs, worstMs, budgetMs, demandMs, overMs, quality, hints, skipped,
 *   stalls, slowFrames, deficit, line}`
 */
export function report(perf) {
  const fps = perf.gapMs.ewma > 0 ? 1000 / perf.gapMs.ewma : 0;
  const skipped = perf.plan.skipped.map((id) => ({
    id,
    label: STAGE_BY_ID[id].label,
    why: STAGE_BY_ID[id].why,
    costMs: perf.stages[id].ewma,
  }));
  const d = perf.deficit;

  const parts = [
    `${Math.round(fps)} fps`,
    `${perf.frameMs.ewma.toFixed(1)} ms/frame`,
    `${perf.quality} quality${perf.pinned ? ' (pinned)' : ''}`,
  ];
  if (skipped.length) parts.push(`skipping ${skipped.map((s) => s.label).join(', ')}`);
  if (perf.plan.overMs > 0.05) parts.push(`${perf.plan.overMs.toFixed(1)} ms over budget`);
  if (perf.stall.count > 0) parts.push(`${perf.stall.count} stall${perf.stall.count === 1 ? '' : 's'}`);
  parts.push(deficitNote(perf));

  return {
    fps,
    frameMs: perf.frameMs.ewma,
    worstMs: worstFrameMs(perf),
    budgetMs: perf.budgetMs,
    demandMs: perf.plan.demandMs,
    overMs: perf.plan.overMs,
    quality: perf.quality,
    pinned: perf.pinned,
    hints: qualityHints(perf),
    skipped,
    stages: STAGES.map((s) => ({
      id: s.id,
      label: s.label,
      essential: s.essential,
      ewmaMs: perf.stages[s.id].ewma,
      peakMs: perf.stages[s.id].peakMs,
      skips: perf.stages[s.id].totalSkips,
    })),
    stalls: perf.stall.count,
    stalledDropped_s: perf.stall.dropped_s,
    slowFrames: perf.slowFrames,
    deficit: {
      behind: d.behind,
      dropped_s: d.dropped_s,
      forMs: d.forMs,
      ratio: d.requested_s > 0 ? d.dropped_s / d.requested_s : 0,
      episodes: d.episodes,
      worstRatio: d.worstRatio,
      total_s: d.totalDropped_s,
    },
    line: parts.join(' · '),
  };
}

/**
 * Forget every measurement, keeping the configuration and any pinned quality level.
 *
 * Used when the rig is reset or the operator changes time compression: costs measured at 1x are
 * not evidence about a frame at 20x, and carrying them over makes the first second after the
 * change skip stages it did not need to.
 *
 * @param {object} perf the perf state
 * @returns {{ok:boolean, reason?:string}} refusal carries the reason verbatim
 */
export function resetPerf(perf) {
  if (!perf || !perf.stages) return { ok: false, reason: 'no performance state' };
  for (const s of STAGES) {
    const rec = perf.stages[s.id];
    rec.ewma = 0;
    rec.samples = 0;
    rec.lastMs = 0;
    rec.peakMs = 0;
    rec.startMs = -1;
    rec.consecutiveSkips = 0;
    rec.totalSkips = 0;
    perf.plan.runs[s.id] = true;
    perf.plan.reasons[s.id] = '';
  }
  perf.plan.skipped.length = 0;
  perf.plan.demandMs = 0;
  perf.plan.projectedMs = 0;
  perf.plan.overMs = 0;
  perf.plan.degraded = false;
  perf.frameMs.ewma = 0;
  perf.frameMs.samples = 0;
  perf.gapMs.ewma = 0;
  perf.gapMs.samples = 0;
  perf.window.fill(0);
  perf.windowI = 0;
  perf.windowN = 0;
  perf.hot = 0;
  perf.cool = 0;
  perf.slowFrames = 0;
  perf.stallFrames = 0;
  perf.prev.started = false;
  perf.prev.beginMs = 0;
  perf.prev.totalMs = 0;
  perf.prev.workMs = 0;
  perf.frame.index = -1;
  perf.frame.kind = FRAME.OK;
  perf.frame.closed = true;
  perf.quality = perf.pinned || QUALITY.FULL;
  perf.plan.quality = perf.quality;
  Object.assign(perf.deficit, {
    behind: false,
    dropped_s: 0,
    requested_s: 0,
    sinceMs: 0,
    forMs: 0,
    episodes: 0,
    totalDropped_s: 0,
    worstRatio: 0,
    clearFrames: 0,
  });
  Object.assign(perf.stall, { count: 0, dropped_s: 0, lastGapMs: 0, totalGapMs: 0 });
  return { ok: true };
}
