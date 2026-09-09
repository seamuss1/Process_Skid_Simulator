/**
 * src/ui/hud.js — the in-play head-up display: the strip above the trend, and the paint the trend
 * calls back for once it has drawn its pens.
 *
 * Layer L6. Imports `ui/dom.js`, `game/replay.js` for the ghost, and `process/plant.js` for the
 * measurement. It reads the sim context and the game's view snapshot; it writes nothing.
 *
 * ------------------------------------------------------------------------------------------
 * TWO HALVES, BECAUSE THE PLAYER IS LOOKING AT THE TRACE
 *
 * Everything that has to be read WHILE the loop is moving belongs on the trace itself — the
 * tolerance band, the ghost of the best run, the flag for the upset that is about to land, the
 * points as they are scored. Those are the canvas half. Anything drawn anywhere else costs a
 * glance away from the pen, and a glance away is a second of the shift the player did not watch.
 *
 * The DOM half is the strip: score, multiplier, hold, clock, ticker. It exists because those five
 * numbers have to survive being read out of the corner of an eye, and canvas text at 11px in a
 * scaled buffer does not. It is deliberately one row high.
 *
 * WHY THE TELEGRAPH IS A FUSE AND NOT A MARKER AT ITS OWN TIME
 *
 * The trend's right-hand edge IS now — `map.t1_s` is the newest sample — so an upset eight
 * seconds in the future has no x of its own to sit at: it is off the end of the plot. Drawing it
 * clamped at the edge with no other cue would tell the player THAT something is coming and
 * nothing about WHEN. So the flag is pinned at the edge and a fuse is drawn back from it into the
 * visible window, exactly as long as the stretch of trace the countdown covers at the current
 * sweep. The fuse burns down to the edge, and its length is readable in the same seconds-per-pixel
 * the player is already using to read the trace.
 * ------------------------------------------------------------------------------------------
 */

import { h, setText, cls } from './dom.js';
import { ghostAt } from '../game/replay.js';
import { measuredPV } from '../process/plant.js';

/**
 * Geometry, timing and animation constants.
 *
 * The three that are worth arguing with:
 *   · `NEAR_S` / `NOW_S` are the amber and red thresholds on the countdown. Five seconds is about
 *     the shortest warning on this rig that still leaves room to stage a pump (the drive's start
 *     delay alone is 1.5 s); two is the point past which nothing the player does will land before
 *     the upset does, so the colour stops being advice and becomes a brace.
 *   · `FUSE_MAX_FRAC` caps the fuse at a third of the plot. On the 30-minute window a 20 s
 *     telegraph is four pixels long and on the 1-minute window it is a third of the screen; the
 *     cap keeps the longest telegraphs from painting over the whole trace.
 *   · `POP_LIFE_S` is wall-clock, not simulated. A pop is feedback to a person, and a person reads
 *     it in the same 1.4 s whether the rig is running at 1x or 20x.
 */
export const HUD = Object.freeze({
  MAX_TICKETS: 3,
  NEAR_S: 5,
  NOW_S: 2,
  FUSE_MAX_FRAC: 0.34,
  TICKET_TOP_PX: 10,
  TICKET_ROW_PX: 13,
  BAND_MIN_PX: 3,
  POP_LIFE_S: 1.4,
  POP_HOLD_S: 0.55,
  POP_RISE_PX: 30,
  POP_SPREAD_PX: 9,
  POP_MAX: 24,
  ROLL_TAU_S: 0.18,
  ROLL_SNAP: 0.5,
  DIGITS: 6,
  GHOST_STEP_PX: 3,
  MULT_STEP_S: 8,
});

/** The fallback ink when no stylesheet has resolved yet — the same one `ui/trend.js` uses. */
const NO_STYLE = '#888';

/** Phases in which the play furniture (score, ticker, band) means anything. */
const LIVE_PHASES = new Set(['COUNTDOWN', 'PLAY', 'DIAGNOSE']);

/** Phases that begin a new run, and so must forget the previous run's pops and score roll. */
const RESET_PHASES = new Set(['IDLE', 'BRIEF', 'COUNTDOWN']);

// ==============================================================================================
// Pure helpers. Every one of these is arithmetic that is visibly wrong when it is wrong, so every
// one of them is exported and tested directly rather than through a canvas.
// ==============================================================================================

/**
 * Clamp with a guard, because a NaN reaching a canvas coordinate silently drops the whole path.
 * @param {number} v the value
 * @param {number} lo lower bound
 * @param {number} hi upper bound
 * @returns {number} the clamped value, or `lo` when `v` is not a number at all
 */
function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Whether a coordinate map from `ui/trend.js` can be drawn into.
 *
 * A zero-width rect is not an error — it is what the trend hands out on the frame after the panel
 * is collapsed to nothing — so it is refused rather than drawn into, and nothing throws.
 *
 * @param {*} map the candidate map
 * @returns {boolean} true when `xForT`, `yForV` and a positive rect are all present
 */
export function usableMap(map) {
  if (!map || typeof map !== 'object') return false;
  if (typeof map.xForT !== 'function' || typeof map.yForV !== 'function') return false;
  const r = map.rect;
  if (!r || typeof r !== 'object') return false;
  return Number.isFinite(r.x) && Number.isFinite(r.y)
    && Number.isFinite(r.w) && Number.isFinite(r.h) && r.w > 0 && r.h > 0;
}

/**
 * The vertical bounds the band, the ghost and the pops are confined to: the measurement lane when
 * the trend published one, the whole plot when it did not.
 * @param {object} map the coordinate map
 * @returns {{y0:number, y1:number}} the bounds, top first
 */
function laneOf(map) {
  const L = map.lane;
  if (L && Number.isFinite(L.y0) && Number.isFinite(L.y1) && L.y1 > L.y0) return { y0: L.y0, y1: L.y1 };
  return { y0: map.rect.y, y1: map.rect.y + map.rect.h };
}

/**
 * The pixel rectangle of the tolerance band around the setpoint.
 *
 * The minimum thickness is not cosmetic: a mission whose band is a tenth of what the lane's
 * autoscale is showing draws as a hairline, and a hairline reads as "no band", which leaves the
 * player with no target at all. Below {@link HUD.BAND_MIN_PX} the band is opened out about the
 * setpoint so it stays a region rather than a line.
 *
 * @param {object} map the trend's coordinate map
 * @param {number} sp the setpoint, engineering units
 * @param {number} band the half-width of the tolerance band, engineering units
 * @returns {?{x:number, y:number, w:number, h:number, ySp:number}} the rectangle and the setpoint's
 *   own y, or null when there is nothing drawable — a bad map, a nonsense band, or a setpoint so
 *   far off the lane's current scale that no part of the band is on screen
 */
export function bandGeometry(map, sp, band) {
  if (!usableMap(map)) return null;
  if (!Number.isFinite(sp) || !Number.isFinite(band) || band <= 0) return null;
  const yHi = map.yForV(sp + band);
  const yLo = map.yForV(sp - band);
  const ySp = map.yForV(sp);
  if (!Number.isFinite(yHi) || !Number.isFinite(yLo) || !Number.isFinite(ySp)) return null;

  let top = Math.min(yHi, yLo);
  let bot = Math.max(yHi, yLo);
  if (bot - top < HUD.BAND_MIN_PX) {
    top = ySp - HUD.BAND_MIN_PX / 2;
    bot = ySp + HUD.BAND_MIN_PX / 2;
  }
  const lane = laneOf(map);
  const y = Math.max(top, lane.y0);
  const h = Math.min(bot, lane.y1) - y;
  if (!(h > 0)) return null;
  return { x: map.rect.x, y, w: map.rect.w, h, ySp };
}

/**
 * How urgent a countdown is, as a class name the CSS and the canvas both key off.
 * @param {number} in_s seconds until the upset lands
 * @returns {string} 'now', 'near' or 'far'
 */
export function urgencyOf(in_s) {
  if (!Number.isFinite(in_s)) return 'far';
  if (in_s <= HUD.NOW_S) return 'now';
  if (in_s <= HUD.NEAR_S) return 'near';
  return 'far';
}

/**
 * Place the telegraph flags for the armed upsets on the time axis.
 *
 * See the file header for why the flag is pinned to the right-hand edge and the countdown is
 * expressed as the length of a fuse running back into the visible window.
 *
 * @param {object} map the trend's coordinate map
 * @param {number} tNow_s the current simulated time, seconds
 * @param {Array<object>} upcoming tickets from `game/director.js::upcoming`
 * @param {number} [limit=HUD.MAX_TICKETS] how many to place; the rest are dropped, soonest kept
 * @returns {Array<{id:string, glyph:string, label:string, in_s:number, x:number, tailX:number,
 *   y:number, urgency:string}>} one record per drawable flag, soonest first; empty on a bad map
 */
export function telegraphMarks(map, tNow_s, upcoming, limit = HUD.MAX_TICKETS) {
  if (!usableMap(map) || !Array.isArray(upcoming) || upcoming.length === 0) return [];
  const rect = map.rect;
  const span_s = Number.isFinite(map.t1_s) && Number.isFinite(map.t0_s) ? map.t1_s - map.t0_s : NaN;
  // Pixels per second of the current sweep. Without a window the fuse has no scale to be drawn
  // at, so it collapses to the flag and the countdown is left to the ticker's own text.
  const pxPerS = span_s > 0 ? rect.w / span_s : 0;
  const lane = laneOf(map);
  const n = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : HUD.MAX_TICKETS));

  const live = upcoming
    .filter((u) => u && Number.isFinite(u.in_s))
    .slice()
    .sort((a, b) => a.in_s - b.in_s)
    .slice(0, n);

  const out = [];
  for (let i = 0; i < live.length; i += 1) {
    const u = live[i];
    const in_s = Math.max(0, u.in_s);
    const x = clamp(map.xForT(tNow_s + in_s), rect.x, rect.x + rect.w);
    const fuse = Math.min(pxPerS * in_s, rect.w * HUD.FUSE_MAX_FRAC);
    out.push({
      id: String(u.id || ''),
      glyph: String(u.glyph || ''),
      label: String(u.label || ''),
      in_s,
      x,
      tailX: Math.max(rect.x, x - Math.max(0, fuse)),
      y: Math.min(lane.y0 + HUD.TICKET_TOP_PX + i * HUD.TICKET_ROW_PX, lane.y1 - 2),
      urgency: urgencyOf(in_s),
    });
  }
  return out;
}

/**
 * Where a floating score number is on screen, and how solid it still is.
 *
 * The pop is anchored to the MOMENT it was scored, not to the edge of the plot: it is stamped with
 * the simulated time and the measurement at the scan that produced it, so it drifts left with the
 * trace it belongs to. A pop that stayed at the right-hand edge would say a number was won; a pop
 * that walks away with the trace says WHERE it was won, which is the only version worth drawing.
 *
 * @param {object} pop a live pop, as stamped by the HUD
 * @param {object} map the trend's coordinate map
 * @param {number} now_s the wall clock, seconds
 * @returns {?{x:number, y:number, alpha:number, age_s:number}} the placement, or null when the pop
 *   has expired or cannot be placed
 */
export function popPlacement(pop, map, now_s) {
  if (!pop || !usableMap(map) || !Number.isFinite(now_s)) return null;
  const age = now_s - pop.born_s;
  if (!Number.isFinite(age) || age < 0 || age >= HUD.POP_LIFE_S) return null;
  const rect = map.rect;
  const lane = laneOf(map);
  const rise = HUD.POP_RISE_PX * (age / HUD.POP_LIFE_S);
  const x = clamp(map.xForT(pop.at_s), rect.x + 4, rect.x + rect.w - 4);
  const y = clamp(map.yForV(pop.v) - rise + pop.dy, lane.y0 + 6, lane.y1 - 4);
  const fade = age <= HUD.POP_HOLD_S
    ? 1
    : 1 - (age - HUD.POP_HOLD_S) / Math.max(1e-6, HUD.POP_LIFE_S - HUD.POP_HOLD_S);
  return { x, y, alpha: clamp(fade, 0, 1), age_s: age };
}

/**
 * Sample a ghost into a polyline in plot coordinates.
 *
 * Sampled per {@link HUD.GHOST_STEP_PX} pixels rather than per stored sample, so a 40-minute ghost
 * on a 1-minute window costs the same as a 1-minute one: the cost of the line is the width of the
 * canvas, which is the same bargain `ui/trend.js` makes for its pens.
 *
 * @param {object} ghost a ghost from `game/replay.js`
 * @param {object} map the trend's coordinate map
 * @param {number} tStart_s the simulated time the recording began at, so a ghost recorded from
 *   zero can be laid over a run that started at an arbitrary point on the sim clock
 * @returns {Array<{x:number, y:number}>} the points, left to right; empty when nothing overlaps
 */
export function ghostPolyline(ghost, map, tStart_s) {
  if (!usableMap(map) || !ghost || !Number.isFinite(tStart_s)) return [];
  const rect = map.rect;
  const span_s = Number.isFinite(map.t1_s) && Number.isFinite(map.t0_s) ? map.t1_s - map.t0_s : NaN;
  if (!(span_s > 0)) return [];
  const pts = [];
  const step = Math.max(1, HUD.GHOST_STEP_PX);
  for (let px = 0; px <= rect.w; px += step) {
    const t = map.t0_s + (px / rect.w) * span_s;
    const s = ghostAt(ghost, t - tStart_s);
    if (!s || !Number.isFinite(s.pv)) continue;
    const y = map.yForV(s.pv);
    if (!Number.isFinite(y)) continue;
    pts.push({ x: rect.x + px, y });
  }
  return pts;
}

/**
 * Ease a displayed number towards a target so the score reads as counting rather than jumping.
 *
 * The snap matters more than the ease: an exponential approach never actually arrives, and a
 * scoreboard that sits at 4999.7 while the run is over is a bug the player can see. Inside
 * {@link HUD.ROLL_SNAP} the display takes the target exactly.
 *
 * @param {number} shown what is on screen now
 * @param {number} target the true value
 * @param {number} dt_s wall seconds since the last frame
 * @returns {number} the value to show this frame
 */
export function rollTowards(shown, target, dt_s) {
  if (!Number.isFinite(target)) return Number.isFinite(shown) ? shown : 0;
  if (!Number.isFinite(shown)) return target;
  if (!Number.isFinite(dt_s) || dt_s <= 0) return shown;
  const k = 1 - Math.exp(-dt_s / HUD.ROLL_TAU_S);
  const next = shown + (target - shown) * k;
  return Math.abs(target - next) < HUD.ROLL_SNAP ? target : next;
}

/**
 * Split a score into fixed digit cells, right-aligned and blank-padded.
 *
 * Fixed cells, because a score whose width changes as it grows drags the multiplier chip and the
 * clock sideways under the player's eye. Blanks rather than leading zeros, because this is an HMI
 * and 004350 is a tag number, not a score.
 *
 * @param {number} value the score
 * @param {number} [count=HUD.DIGITS] how many cells
 * @returns {string[]} one character per cell, left to right
 */
export function digitCells(value, count = HUD.DIGITS) {
  const n = Math.max(1, Math.floor(Number.isFinite(count) ? count : HUD.DIGITS));
  const cells = new Array(n).fill(' ');
  if (!Number.isFinite(value)) return cells;
  const neg = value < 0;
  const room = neg ? n - 1 : n;
  const cap = room > 0 ? 10 ** room - 1 : 0;
  const mag = Math.min(Math.abs(Math.round(value)), cap);
  const text = (neg ? '-' : '') + String(mag);
  const start = n - text.length;
  for (let i = 0; i < text.length && start + i < n; i += 1) cells[start + i] = text[i];
  return cells;
}

/**
 * A countdown or a remaining time as `m:ss`.
 * @param {number} t_s seconds
 * @returns {string} the clock, or an em dash when there is no time to show
 */
function mmss(t_s) {
  if (!Number.isFinite(t_s)) return '—';
  const t = Math.max(0, Math.round(t_s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * The signed text of a points award.
 * @param {number} amount the points
 * @returns {string} e.g. `+120` or `−150`
 */
function popText(amount) {
  if (!Number.isFinite(amount)) return '';
  const v = Math.round(amount);
  return v >= 0 ? `+${v}` : `−${Math.abs(v)}`;
}

/**
 * The default wall clock. Wall time, not simulated time: everything it drives — the digit roll,
 * the pop rise, the chip pulse — is feedback to a person and must read the same at 1x and 20x.
 * @returns {number} seconds, from an arbitrary origin
 */
function wallClock() {
  const p = globalThis.performance;
  return p && typeof p.now === 'function' ? p.now() / 1000 : 0;
}

// ==============================================================================================
// The view
// ==============================================================================================

/**
 * Build the in-play HUD.
 *
 * @param {object} ctx the sim context
 * @param {object} A the bound action surface; the HUD reads no actions today, but takes it so the
 *   signature matches every other view and a later control can be wired without a signature change
 * @param {object} [opts] options
 * @param {function():number} [opts.now] the wall clock, seconds — injected so the animation can be
 *   driven deterministically by a test
 * @returns {{el:HTMLElement, update:Function, overlay:Function, setVisible:Function}} the view
 */
export function createHud(ctx, A, opts) {
  const now = opts && typeof opts.now === 'function' ? opts.now : wallClock;

  // ---- the strip ------------------------------------------------------------------------------
  const title = h('b', { class: 'hud__title', text: 'SANDBOX' });
  const message = h('span', { class: 'hud__msg' });

  const cells = [];
  const digits = h('span', { class: 'hud__digits' });
  for (let i = 0; i < HUD.DIGITS; i += 1) {
    const c = h('i', { class: 'hud__digit', text: ' ' });
    cells.push({ el: c, ch: ' ', flip: false });
    digits.appendChild(c);
  }
  const mult = h('b', { class: 'hud__mult', text: '×1' });
  const holdFill = h('i', { class: 'hud__hold-fill' });
  const hold = h('span', { class: 'hud__hold', title: 'Time held inside the band. Every eight seconds is another multiplier, to four.' }, holdFill);
  const left = h('b', { class: 'hud__left', text: '—' });

  const ticker = h('div', { class: 'hud__ticker' });
  /** @type {Map<string, object>} live ticker rows, keyed by upset id, reused between frames. */
  const rows = new Map();

  const el = h('div', { class: 'hud', hidden: true },
    h('div', { class: 'hud__mission' }, title, message),
    h('div', { class: 'hud__score' }, digits, mult),
    hold,
    left,
    ticker);

  // ---- animation state ------------------------------------------------------------------------
  /** @type {Array<object>} live pops: the score events still floating off the trace. */
  const pops = [];
  let shown = 0;
  let lastMult = 1;
  let lastFrame_s = NaN;
  let lastPopId = -1;
  let runKey = '';
  let visible = false;
  /** The simulated time this run's ghost was recorded from, so the ghost lands under the trace. */
  let tStart_s = 0;
  /** @type {?object} the last view handed in, which is what `overlay` paints from. */
  let view = null;

  /**
   * Forget the previous run's animation. Pop ids restart at zero with each new score state, so
   * without this the first pops of a new mission would be filtered out as already seen.
   * @returns {void}
   */
  function resetRun() {
    pops.length = 0;
    lastPopId = -1;
    shown = 0;
    lastMult = 1;
  }

  /**
   * Take the pops the game has queued and stamp each with where on the trace it was won.
   * @param {Array<object>} queue the view's pop queue
   * @param {number} at_s the simulated time of this frame
   * @param {number} v the measurement this frame, engineering units
   * @param {number} t the wall clock
   * @returns {void}
   */
  function acceptPops(queue, at_s, v, t) {
    if (!Array.isArray(queue)) return;
    for (const p of queue) {
      if (!p || !Number.isFinite(p.amount)) continue;
      // `gameView` may hand back the same array twice in one frame, and a pop drawn twice is a
      // number that looks like it was scored twice.
      const id = Number.isFinite(p.id) ? p.id : lastPopId + 1;
      if (id <= lastPopId) continue;
      lastPopId = id;
      pops.push({
        text: popText(p.amount),
        kind: p.kind === 'penalty' || p.amount < 0 ? 'penalty' : 'award',
        at_s,
        v,
        born_s: t,
        // Deterministic lateral scatter from the pop's own id: two awards in the same scan must
        // not land on top of each other, and nothing in this repo may reach for Math.random.
        dy: ((id % 3) - 1) * HUD.POP_SPREAD_PX,
      });
    }
    while (pops.length > HUD.POP_MAX) pops.shift();
  }

  /**
   * Rebuild or update one ticker row.
   * @param {object} t a ticket from `telegraphMarks`
   * @returns {HTMLElement} the row
   */
  function tickerRow(t) {
    let row = rows.get(t.id);
    if (!row) {
      const glyph = h('i', { class: 'tick__glyph' });
      const label = h('span', { class: 'tick__label' });
      const count = h('b', { class: 'tick__count' });
      const fuse = h('i', { class: 'tick__fuse-fill' });
      row = {
        el: h('div', { class: 'tick' }, glyph, label, count, h('i', { class: 'tick__fuse' }, fuse)),
        glyph, label, count, fuse,
      };
      rows.set(t.id, row);
    }
    setText(row.glyph, t.glyph);
    setText(row.label, t.label);
    setText(row.count, t.in_s <= 0.5 ? 'NOW' : `T-${Math.ceil(t.in_s)}s`);
    for (const u of ['far', 'near', 'now']) cls(row.el, `is-${u}`, t.urgency === u);
    return row;
  }

  /**
   * Repaint the strip from a game view snapshot.
   * @param {object} v the snapshot from `game/session.js::gameView`
   * @returns {void|{ok:boolean, reason:string}} a refusal when handed something that is not a view
   */
  function update(v) {
    if (!v || typeof v !== 'object') {
      return { ok: false, reason: 'The HUD was handed no game view, so the strip was left as it was.' };
    }
    const t = now();
    const dt = Number.isFinite(lastFrame_s) ? t - lastFrame_s : 0;
    lastFrame_s = t;

    const phase = String(v.phase || 'IDLE');
    const mission = v.mission && typeof v.mission === 'object' ? v.mission : null;
    const key = `${v.mode || ''}:${mission ? mission.id : (v.mission || '')}:${v.wave || 0}`;
    if (key !== runKey || RESET_PHASES.has(phase)) {
      if (key !== runKey) { runKey = key; resetRun(); }
      else if (RESET_PHASES.has(phase) && pops.length) resetRun();
    }
    view = v;

    // The ghost is recorded from zero while the sim clock keeps counting from wherever the shift
    // was started, so the two have to be pegged together every frame — `t_s` is the run's own
    // elapsed time and the difference is where the recording began.
    const simT = ctx && ctx.run && Number.isFinite(ctx.run.t_s) ? ctx.run.t_s : 0;
    tStart_s = Number.isFinite(v.t_s) ? simT - v.t_s : 0;

    let pv = NaN;
    if (ctx && ctx.plant && ctx.run) pv = measuredPV(ctx.plant, ctx.run.mode);
    if (!Number.isFinite(pv)) pv = Number.isFinite(v.sp) ? v.sp : NaN;
    if (Number.isFinite(pv)) acceptPops(v.pops, simT, pv, t);

    // ---- mission and message ------------------------------------------------------------------
    setText(title, mission ? String(mission.title || mission.id) : String(v.mode || 'SANDBOX'));
    setText(message, String(v.message || ''));
    for (const p of ['idle', 'brief', 'countdown', 'play', 'diagnose', 'result', 'failed']) {
      cls(el, `hud--${p}`, phase.toLowerCase() === p);
    }

    // ---- score --------------------------------------------------------------------------------
    shown = rollTowards(shown, Number.isFinite(v.score) ? v.score : 0, dt);
    const want = digitCells(shown);
    for (let i = 0; i < cells.length; i += 1) {
      const c = cells[i];
      if (c.ch === want[i]) continue;
      c.ch = want[i];
      setText(c.el, want[i]);
      // Two alternating classes, so the keyframe restarts on a digit that changes twice in a row
      // without a forced reflow in the middle of the frame.
      c.flip = !c.flip;
      cls(c.el, 'is-roll-a', c.flip);
      cls(c.el, 'is-roll-b', !c.flip);
    }

    // ---- multiplier ---------------------------------------------------------------------------
    const m = Number.isFinite(v.mult) && v.mult >= 1 ? Math.floor(v.mult) : 1;
    setText(mult, `×${m}`);
    cls(mult, 'is-hot', m > 1);
    if (m > lastMult) {
      // Same alternating-class trick: the chip must pulse on every step, including 2 -> 3 -> 4 in
      // quick succession.
      cls(mult, 'is-pulse-a', !mult.classList.contains('is-pulse-a'));
      cls(mult, 'is-pulse-b', !mult.classList.contains('is-pulse-a'));
    }
    lastMult = m;

    // ---- hold meter ---------------------------------------------------------------------------
    const holdT = Number.isFinite(v.holdTime_s) ? Math.max(0, v.holdTime_s) : 0;
    const capped = m >= 4;
    const frac = capped ? 1 : (holdT % HUD.MULT_STEP_S) / HUD.MULT_STEP_S;
    holdFill.style.width = `${Math.round(frac * 100)}%`;
    cls(hold, 'is-in', !!v.inBand);
    cls(hold, 'is-capped', capped);

    // ---- clock --------------------------------------------------------------------------------
    setText(left, Number.isFinite(v.left_s) ? mmss(v.left_s) : '—');
    cls(left, 'is-warn', Number.isFinite(v.left_s) && v.left_s <= 10);

    // ---- ticker -------------------------------------------------------------------------------
    const tickets = Array.isArray(v.upcoming)
      ? v.upcoming.filter((u) => u && Number.isFinite(u.in_s)).sort((a, b) => a.in_s - b.in_s)
        .slice(0, HUD.MAX_TICKETS)
      : [];
    const live = new Set();
    for (const u of tickets) {
      const id = String(u.id || '');
      live.add(id);
      const row = tickerRow({
        id,
        glyph: String(u.glyph || ''),
        label: String(u.label || ''),
        in_s: Math.max(0, u.in_s),
        urgency: urgencyOf(u.in_s),
      });
      const tele = Number.isFinite(u.telegraph_s) && u.telegraph_s > 0 ? u.telegraph_s : HUD.NEAR_S;
      row.fuse.style.width = `${Math.round(clamp(u.in_s / tele, 0, 1) * 100)}%`;
      ticker.appendChild(row.el);
    }
    for (const [id, row] of rows) {
      if (live.has(id)) continue;
      if (row.el.parentNode) row.el.parentNode.removeChild(row.el);
      rows.delete(id);
    }
    cls(el, 'hud--armed', tickets.length > 0);
    return undefined;
  }

  /**
   * Paint the play field: the band, the ghost, the telegraph flags and the pops.
   *
   * Called by `ui/trend.js` after the pens, with the trend's own mapping. It is not clipped by the
   * caller, so it clips itself where it must and is free to put a flag in the margin.
   *
   * @param {CanvasRenderingContext2D} g the trend's context, already scaled to CSS pixels
   * @param {object} map the trend's coordinate map
   * @returns {void|{ok:boolean, reason:string}} a refusal when there is nothing drawable
   */
  function overlay(g, map) {
    if (!g || typeof g.fillRect !== 'function') {
      return { ok: false, reason: 'The HUD was handed no drawing context, so nothing was painted over the trend.' };
    }
    if (!usableMap(map)) {
      return { ok: false, reason: 'The trend did not hand the HUD a usable coordinate map, so the band was not drawn.' };
    }
    if (!visible || !view || !LIVE_PHASES.has(String(view.phase || ''))) return undefined;

    const css = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    /**
     * Resolve one design token to a paintable colour.
     * @param {string} name the custom property
     * @returns {string} the colour
     */
    const C = (name) => {
      if (!css) return NO_STYLE;
      const val = css.getPropertyValue(name);
      return (val && val.trim()) || NO_STYLE;
    };
    const lane = laneOf(map);
    const t = now();
    const simT = ctx && ctx.run && Number.isFinite(ctx.run.t_s) ? ctx.run.t_s : 0;

    // ---- band and ghost, clipped to the measurement lane --------------------------------------
    g.save();
    g.beginPath();
    g.rect(map.rect.x, lane.y0, map.rect.w, lane.y1 - lane.y0);
    g.clip();

    const band = bandGeometry(map, view.sp, view.band);
    if (band) {
      g.fillStyle = view.inBand ? C('--ok-soft') : C('--alarm-soft');
      g.fillRect(band.x, band.y, band.w, band.h);
      g.strokeStyle = view.inBand ? C('--ok-ink') : C('--alarm-ink');
      g.lineWidth = 1;
      g.setLineDash([5, 4]);
      g.globalAlpha = 0.55;
      for (const y of [band.y, band.y + band.h]) {
        g.beginPath();
        g.moveTo(band.x, Math.round(y) + 0.5);
        g.lineTo(band.x + band.w, Math.round(y) + 0.5);
        g.stroke();
      }
      g.globalAlpha = 1;
      g.setLineDash([]);
    }

    const gp = ghostPolyline(view.ghost, map, tStart_s);
    if (gp.length > 1) {
      g.strokeStyle = C('--ink-3');
      g.lineWidth = 1.25;
      g.setLineDash([3, 4]);
      g.globalAlpha = 0.7;
      g.beginPath();
      g.moveTo(gp[0].x, gp[0].y);
      for (let i = 1; i < gp.length; i += 1) g.lineTo(gp[i].x, gp[i].y);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
    g.restore();

    // ---- telegraph flags ----------------------------------------------------------------------
    const marks = telegraphMarks(map, simT, view.upcoming);
    if (marks.length) {
      g.font = '10px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
      g.textBaseline = 'middle';
    }
    for (const mk of marks) {
      const ink = C(mk.urgency === 'now' ? '--alarm-ink' : (mk.urgency === 'near' ? '--warn-ink' : '--info-ink'));
      g.strokeStyle = ink;
      g.fillStyle = ink;
      g.lineWidth = mk.urgency === 'now' ? 2 : 1;
      g.globalAlpha = 0.85;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(mk.tailX, mk.y);
      g.lineTo(mk.x, mk.y);
      g.stroke();
      g.setLineDash([]);
      // The flag itself: a full-height rule at the edge, so the eye lands on the moment rather
      // than on the label.
      g.beginPath();
      g.moveTo(Math.round(mk.x) + 0.5, lane.y0);
      g.lineTo(Math.round(mk.x) + 0.5, lane.y1);
      g.stroke();
      g.textAlign = 'right';
      const secs = mk.in_s <= 0.5 ? 'NOW' : `T-${Math.ceil(mk.in_s)}s`;
      g.fillText(`${mk.glyph} ${mk.label} ${secs}`.trim(), mk.x - 4, mk.y);
      g.globalAlpha = 1;
    }

    // ---- score pops ---------------------------------------------------------------------------
    if (pops.length) {
      g.font = 'bold 12px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
    }
    for (let i = pops.length - 1; i >= 0; i -= 1) {
      const p = pops[i];
      const at = popPlacement(p, map, t);
      if (!at) { pops.splice(i, 1); continue; }
      g.globalAlpha = at.alpha;
      g.fillStyle = C(p.kind === 'penalty' ? '--alarm-ink' : '--ok-ink');
      g.fillText(p.text, at.x, at.y);
      g.globalAlpha = 1;
    }
    return undefined;
  }

  /**
   * Show or hide the strip and the overlay together.
   *
   * Hiding drops the live pops: coming back to a hidden HUD to find four seconds of stale numbers
   * floating over the trace would say points were just scored when they were not.
   *
   * @param {boolean} on whether the game is in play
   * @returns {void}
   */
  function setVisible(on) {
    visible = !!on;
    el.hidden = !visible;
    if (!visible) { pops.length = 0; lastFrame_s = NaN; }
  }

  return { el, update, overlay, setVisible };
}
