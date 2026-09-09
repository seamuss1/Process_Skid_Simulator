/**
 * src/ui/tour.js — the guided tours: spotlight a control, say what it is for, and then WAIT until
 * the user actually does the thing before moving on.
 *
 * Layer L6. Imports `./dom.js` only. Everything above the `createTour` line is pure — no DOM, no
 * clock, no storage — which is what `tests/tour.test.js` exercises; the browser is touched only
 * inside `createTour`, and only when it is called.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS IS NOT A CAROUSEL OF TOOLTIPS
 *
 * The ordinary product tour shows five cards with a Next button, the user clicks Next five times
 * to make it go away, and nothing is learned. That failure is structural: clicking Next is not the
 * skill, so a tour that measures Next-clicks measures nothing.
 *
 * Every step here declares what would COUNT as having done it — an action on the bound surface, a
 * view change, an event off the bus — and the tour will not move until that arrives.
 * `advanceTour` refuses on a step whose condition has not been met. The step still carries a Skip,
 * always, because a tour that cannot be escaped is worse than no tour at all; but skipping is a
 * deliberate act that the tour records, rather than the path of least resistance.
 *
 * FOUR RULES THIS MODULE IS BUILT AROUND, each of them the fix for a specific way tours go wrong:
 *
 *   IT NEVER BLOCKS.       The overlay takes no pointer events and no focus. The plant keeps
 *                          running, every control stays live, and the user can ignore the card
 *                          entirely. A tour that disables the application while teaching the
 *                          application is a contradiction.
 *
 *   IT IS INTERRUPTIBLE.   Escape pauses. The paused state carries the tour and the step, is
 *                          written to the injected storage, and comes back — clamped, if the tour
 *                          has since lost steps — the next time the user asks for it. Half a tour
 *                          finished on Tuesday is not lost on Wednesday.
 *
 *   IT SURVIVES A MISSING  A target that is scrolled away, hidden behind another view, or simply
 *   TARGET.                not built yet (the ladder editor and the shift layer are separate
 *                          modules) does not produce a card pinned to 0,0. `placeCard` says so,
 *                          and the card centres itself and reads as plain prose.
 *
 *   IT DEGRADES.           Under `prefers-reduced-motion` there is no travelling spotlight and no
 *                          pulse: the ring is drawn where it belongs and the text carries the
 *                          tour. `stepText` produces the same content as one paragraph, which is
 *                          also what a screen reader is given.
 * ------------------------------------------------------------------------------------------
 */

import { h, setText, cls } from './dom.js';

// =============================================================================================
// 1. THE TOURS
// =============================================================================================

/** How a step decides it is finished. */
export const ADVANCE = Object.freeze({
  /** The user read it and pressed Next. For steps that point at something rather than ask for it. */
  ACK: 'ack',
  /** A named action was called on the bound surface `A`. */
  ACTION: 'action',
  /** Any one of several actions was called. */
  ANY: 'any',
  /** The stage was switched to a named view. */
  VIEW: 'view',
  /** A message arrived on a named bus topic. */
  EVENT: 'event',
});

/** Where the tour log lives in the injected storage. */
export const TOUR_STORAGE_KEY = 'skid.ui.tours';

/** Bumped when the persisted shape changes in a way `loadTourLog` cannot absorb silently. */
export const TOUR_LOG_VERSION = 1;

/**
 * Every tour, in the order the picker lists them.
 *
 * `target` is a LIST of selectors, tried in order. The first entry is always a `data-tour` hook,
 * which is the contract other views can opt into; the rest are the class names the shell happens
 * to emit today. A step whose targets all miss is not an error — it centres and reads as prose —
 * which is what lets the ladder and shift tours ship before the modules they describe are wired.
 */
export const TOURS = Object.freeze([
  Object.freeze({
    id: 'first-run',
    title: 'The rig in five minutes',
    blurb: 'What is on the screen, what is running, and how to make it do something.',
    minutes: 5,
    steps: Object.freeze([
      {
        id: 'process',
        target: ['[data-tour="process"]', '.panel--stage', '.mimic'],
        title: 'Two pumps, one header',
        body: 'P-101 and P-102 draw from the suction tank and discharge into a common header. '
          + 'Everything else on this screen is about one number: the pressure in that header.',
        advance: { on: ADVANCE.ACK },
        placement: ['right', 'bottom'],
      },
      {
        id: 'faceplate',
        target: ['[data-tour="faceplate"]', '.fp', '.col--rail'],
        title: 'The controller',
        body: 'White digits are the measurement, amber is the setpoint. The bar underneath is the '
          + 'output the controller is asking the drives for.',
        advance: { on: ADVANCE.ACK },
        placement: ['left', 'bottom'],
      },
      {
        id: 'setpoint',
        target: ['[data-tour="setpoint"]', '.fp__sp'],
        title: 'Move the setpoint',
        body: 'Type a new setpoint — try half a bar above where it sits — and watch the drives '
          + 'answer. Nothing here is destructive; the rig cannot be broken from the keyboard.',
        wait: 'Waiting for a new setpoint.',
        advance: { on: ADVANCE.ACTION, action: 'setSetpoint' },
        placement: ['left', 'top'],
      },
      {
        id: 'trend',
        target: ['[data-tour="trend"]', '.panel--trend'],
        title: 'The trend is the evidence',
        body: 'The step you just made is on the chart. Overshoot, settling and the shape of the '
          + 'approach are the only honest way to judge a tuning — a single number never is.',
        advance: { on: ADVANCE.ACK },
        placement: ['top', 'right'],
      },
      {
        id: 'freeze',
        target: ['[data-tour="run"]', '.toolbar .iconbtn', '.toolbar'],
        title: 'Freeze whenever you like',
        body: 'Space freezes the plant and Space starts it again. Frozen is not reset: the clock '
          + 'stops, nothing is lost, and you can read the screen at your own pace.',
        wait: 'Press Space, or click the transport button.',
        advance: { on: ADVANCE.ACTION, action: 'togglePause' },
        placement: ['bottom', 'right'],
      },
      {
        id: 'alarms',
        target: ['[data-tour="alarms"]', '.tb__alarms'],
        title: 'Alarms stay until acknowledged',
        body: 'A condition that came and went while you were looking elsewhere is still on the '
          + 'list. A tells the rig you have seen it.',
        advance: { on: ADVANCE.ACK },
        placement: ['bottom', 'left'],
      },
      {
        id: 'palette',
        target: ['[data-tour="palette"]', '.titlebar'],
        title: 'Everything else is behind Ctrl-K',
        body: 'The command palette lists every action in the application and runs it. Press ? at '
          + 'any time for the keyboard card, which is generated from the same table.',
        advance: { on: ADVANCE.ACK },
        placement: ['bottom'],
      },
    ]),
  }),
  Object.freeze({
    id: 'tuning',
    title: 'Tuning a loop',
    blurb: 'Identify the process, apply a published rule, then judge the result on the trend.',
    minutes: 8,
    steps: Object.freeze([
      {
        id: 'manual',
        target: ['[data-tour="mode"]', '.fp__mode'],
        title: 'Start in manual',
        body: 'A step test is an OPEN-LOOP experiment: the controller must not be allowed to '
          + 'correct the very response you are trying to measure. Put it in MAN.',
        wait: 'Waiting for the controller to go to MAN.',
        advance: { on: ADVANCE.ACTION, action: 'setControllerMode' },
        placement: ['left', 'bottom'],
      },
      {
        id: 'step',
        target: ['[data-tour="steptest"]', '.rail__tests', '.col--rail'],
        title: 'Bump the output',
        body: 'The step test moves the output a few percent and fits a first-order-plus-dead-time '
          + 'model to what comes back: a gain, a time constant and a dead time.',
        wait: 'Waiting for a step test to start.',
        advance: { on: ADVANCE.ANY, actions: ['beginStepTest', 'beginAutotune'] },
        placement: ['left', 'top'],
      },
      {
        id: 'rules',
        target: ['[data-tour="rules"]', '.rules'],
        title: 'The rules disagree, and that is the lesson',
        body: 'Ziegler-Nichols is fast and rings. Lambda and SIMC are slower and hold their '
          + 'margin. The ranking column is the sensitivity peak Ms each one would leave you with.',
        wait: 'Waiting for a tuning rule to be applied.',
        advance: { on: ADVANCE.ACTION, action: 'applyTuningRule' },
        placement: ['left', 'top'],
      },
      {
        id: 'judge',
        target: ['[data-tour="trend"]', '.panel--trend'],
        title: 'Now argue with it',
        body: 'Step the setpoint again and watch. If it overshoots and rings, the gain is high or '
          + 'the reset is fast for this process — not for processes in general.',
        advance: { on: ADVANCE.ACK },
        placement: ['top'],
      },
    ]),
  }),
  Object.freeze({
    id: 'bode',
    title: 'Reading a Bode plot',
    blurb: 'Where the margins are read off, and what Ms is telling you that they are not.',
    minutes: 6,
    steps: Object.freeze([
      {
        id: 'open',
        target: ['[data-tour="view-bode"]', '.toolbar'],
        title: 'Open the Bode page',
        body: 'Press g then b, or pick BODE on the toolbar.',
        wait: 'Waiting for the Bode view.',
        advance: { on: ADVANCE.VIEW, view: 'bode' },
        placement: ['bottom'],
      },
      {
        id: 'crossover',
        target: ['[data-tour="bode-gain"]', '.analysis__gain', '.panel--stage'],
        title: 'Gain crossover',
        body: 'Where the open-loop gain passes 1 (0 dB) is the frequency the loop works at. Read '
          + 'the phase there: 180 degrees minus that lag is the PHASE MARGIN.',
        advance: { on: ADVANCE.ACK },
        placement: ['right', 'bottom'],
      },
      {
        id: 'delay',
        target: ['[data-tour="bode-phase"]', '.analysis__phase', '.panel--stage'],
        title: 'Turn it into seconds',
        body: 'Phase margin divided by the crossover frequency is a DELAY MARGIN: how much extra '
          + 'dead time this loop tolerates before it oscillates. That is a number a plant can be '
          + 'checked against.',
        advance: { on: ADVANCE.ACK },
        placement: ['right', 'top'],
      },
      {
        id: 'ms',
        target: ['[data-tour="margins"]', '.analysis__margins', '.panel--stage'],
        title: 'Ms bounds both',
        body: 'The peak of the sensitivity function is the single best robustness number: under '
          + '1.4 is conservative, 1.4 to 2.0 is normal, above 2.0 rings. Tune to Ms, then check '
          + 'the margins agree.',
        advance: { on: ADVANCE.ACK },
        placement: ['right', 'top'],
      },
    ]),
  }),
  Object.freeze({
    id: 'rung',
    title: 'Your first rung',
    blurb: 'Ladder logic: contacts, a coil, and why the scan order is the whole story.',
    minutes: 7,
    steps: Object.freeze([
      {
        id: 'editor',
        target: ['[data-tour="plc"]', '.plc', '.panel--stage'],
        title: 'The ladder is a scan, not a circuit',
        body: 'Every rung is solved left to right, top to bottom, once per scan, on a snapshot of '
          + 'the inputs. It looks like a wiring diagram and behaves like a program.',
        advance: { on: ADVANCE.ACK },
        placement: ['right', 'bottom'],
      },
      {
        id: 'contact',
        target: ['[data-tour="plc-contact"]', '.plc__palette'],
        title: 'Place a contact',
        body: 'A normally-open contact passes power when its tag is true. Put one on the rung and '
          + 'point it at a start pushbutton.',
        wait: 'Waiting for a contact on the rung.',
        advance: { on: ADVANCE.EVENT, topic: 'plc' },
        placement: ['right', 'top'],
      },
      {
        id: 'coil',
        target: ['[data-tour="plc-coil"]', '.plc__palette'],
        title: 'And a coil to energise',
        body: 'The coil at the right end takes whatever reaches it. Seal it in with a parallel '
          + 'contact off its own tag, or it drops out the moment the button is released.',
        advance: { on: ADVANCE.ACK },
        placement: ['right', 'top'],
      },
      {
        id: 'scan',
        target: ['[data-tour="plc-scan"]', '.plc__scan', '.plc'],
        title: 'Watch it solve',
        body: 'Step one scan at a time and watch power flow. A rung that works when solved by eye '
          + 'and fails on the rig is almost always a rung that reads a tag written later.',
        advance: { on: ADVANCE.ACK },
        placement: ['top'],
      },
    ]),
  }),
  Object.freeze({
    id: 'shift',
    title: 'Running a shift',
    blurb: 'Missions, faults arriving unannounced, and what the scorecard is actually measuring.',
    minutes: 6,
    steps: Object.freeze([
      {
        id: 'brief',
        target: ['[data-tour="mission"]', '.mission', '.panel--stage'],
        title: 'The brief states the target',
        body: 'Every shift names the variable, the band it must stay in, and the energy you are '
          + 'allowed to spend holding it there. All three are scored.',
        advance: { on: ADVANCE.ACK },
        placement: ['right', 'bottom'],
      },
      {
        id: 'faults',
        target: ['[data-tour="alarms"]', '.alarmbar', '.tb__alarms'],
        title: 'Things will go wrong on their own',
        body: 'A strainer fouls, a transmitter drifts, a machine trips. The scorecard cares how '
          + 'quickly you noticed and what you did, not whether it happened.',
        advance: { on: ADVANCE.ACK },
        placement: ['bottom'],
      },
      {
        id: 'score',
        target: ['[data-tour="score"]', '.health__score', '.panel--stage'],
        title: 'Grade the run',
        body: 'Integrated error, worst excursion, output travel and specific energy. Output travel '
          + 'is the one people ignore, and it is the one the valve and the drive feel.',
        wait: 'Waiting for the run to be graded.',
        advance: { on: ADVANCE.ACTION, action: 'gradeNow' },
        placement: ['right', 'top'],
      },
    ]),
  }),
]);

/**
 * Find a tour by id.
 * @param {string} id the tour id
 * @param {Array<object>} [defs=TOURS] the table to search
 * @returns {object|null} the tour, or null
 */
export function tourById(id, defs = TOURS) {
  return (defs || []).find((t) => t.id === id) || null;
}

// =============================================================================================
// 2. WHAT HAS BEEN COMPLETED — persisted through injected storage
// =============================================================================================

/**
 * Read the tour log.
 *
 * Storage is whatever the browser handed the UI, so all of these are ordinary rather than
 * exceptional: absent entirely (Node, a test, a locked-down embed), a `getItem` that throws
 * (some privacy modes do), and a value written by another build or edited by hand. Nothing here
 * throws, and anything unrecognised is dropped rather than believed.
 * @param {object|null} storage a `localStorage`-shaped object, or null
 * @returns {{version:number, completed:object, resume:object|null}} the log
 */
export function loadTourLog(storage) {
  const empty = { version: TOUR_LOG_VERSION, completed: {}, resume: null };
  if (!storage || typeof storage.getItem !== 'function') return empty;
  let raw = null;
  try { raw = storage.getItem(TOUR_STORAGE_KEY); } catch { return empty; }
  if (!raw) return empty;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  if (!parsed || typeof parsed !== 'object') return empty;
  const completed = {};
  const src = parsed.completed && typeof parsed.completed === 'object' ? parsed.completed : {};
  for (const key of Object.keys(src)) if (src[key]) completed[key] = true;
  let resume = null;
  const r = parsed.resume;
  if (r && typeof r === 'object' && typeof r.tourId === 'string' && Number.isFinite(r.index)) {
    resume = { tourId: r.tourId, index: Math.max(0, Math.floor(r.index)) };
  }
  return { version: TOUR_LOG_VERSION, completed, resume };
}

/**
 * Write the tour log.
 *
 * A `setItem` that throws — Safari in private browsing, any browser at quota — must not take the
 * running tour down with it. The user finished the step either way.
 * @param {object|null} storage a `localStorage`-shaped object, or null
 * @param {object} log the log
 * @returns {boolean} whether it was actually persisted
 */
export function saveTourLog(storage, log) {
  if (!storage || typeof storage.setItem !== 'function' || !log) return false;
  try {
    storage.setItem(TOUR_STORAGE_KEY, JSON.stringify({
      version: TOUR_LOG_VERSION,
      completed: log.completed || {},
      resume: log.resume || null,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark a tour complete, returning a new log.
 * @param {object} log the log
 * @param {string} tourId the tour
 * @returns {object} the new log, with any resume token for that tour cleared
 */
export function markCompleted(log, tourId) {
  const base = log || { version: TOUR_LOG_VERSION, completed: {}, resume: null };
  const completed = { ...base.completed, [tourId]: true };
  const resume = base.resume && base.resume.tourId === tourId ? null : base.resume;
  return { version: TOUR_LOG_VERSION, completed, resume };
}

/**
 * Whether a tour has been finished before.
 * @param {object} log the log
 * @param {string} tourId the tour
 * @returns {boolean} whether it is complete
 */
export function isCompleted(log, tourId) {
  return !!(log && log.completed && log.completed[tourId]);
}

// =============================================================================================
// 3. THE STEP STATE MACHINE
// =============================================================================================

/** A tour that is not running. */
export const IDLE = Object.freeze({ tourId: '', index: 0, total: 0, status: 'idle', satisfied: false, skipped: Object.freeze([]), reason: '' });

/**
 * Begin a tour.
 * @param {object} def a tour definition
 * @param {object} [opts] options
 * @param {number} [opts.index=0] start at this step, clamped into range
 * @returns {object} the tour state, or {@link IDLE} when the definition is unusable
 */
export function startTour(def, opts = {}) {
  if (!def || !Array.isArray(def.steps) || !def.steps.length) return IDLE;
  const index = clampIndex(opts.index || 0, def.steps.length);
  return {
    tourId: def.id,
    index,
    total: def.steps.length,
    status: 'running',
    satisfied: isAckStep(def.steps[index]),
    skipped: [],
    reason: '',
  };
}

/**
 * Clamp a step index into a tour's range.
 * @param {number} i the index
 * @param {number} total how many steps there are
 * @returns {number} an index that exists
 */
function clampIndex(i, total) {
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(Math.floor(i), Math.max(0, total - 1)));
}

/**
 * Whether a step is finished by reading it rather than by doing something.
 * @param {object} step a step
 * @returns {boolean} whether Next is live the moment the step opens
 */
function isAckStep(step) {
  return !step || !step.advance || step.advance.on === ADVANCE.ACK;
}

/**
 * The step a state is on.
 * @param {object} state the tour state
 * @param {object} def the tour definition
 * @returns {object|null} the step, or null when the tour is not running
 */
export function currentStep(state, def) {
  if (!state || !def || !Array.isArray(def.steps)) return null;
  if (state.status === 'idle' || state.status === 'done') return null;
  return def.steps[state.index] || null;
}

/**
 * Progress, for the card's counter and bar.
 * @param {object} state the tour state
 * @returns {{index:number, total:number, done:number, pct:number}} the progress
 */
export function tourProgress(state) {
  const total = state && state.total ? state.total : 0;
  const done = state && state.status === 'done' ? total : (state ? state.index : 0);
  return { index: state ? state.index : 0, total, done, pct: total ? (done / total) * 100 : 0 };
}

/**
 * Whether a signal satisfies a step.
 *
 * Pure and exported because this predicate is the whole difference between a tour that teaches and
 * a carousel of tooltips, and it deserves to be tested directly rather than through the machine.
 * @param {object} step the step
 * @param {object} signal `{type:'ack'}`, `{type:'action', name, args}`, `{type:'view', view}` or
 *   `{type:'event', topic}`
 * @returns {boolean} whether the step is finished
 */
export function stepSatisfied(step, signal) {
  if (!step || !signal) return false;
  const adv = step.advance || { on: ADVANCE.ACK };
  switch (adv.on) {
    case ADVANCE.ACK:
      return signal.type === 'ack';
    case ADVANCE.ACTION:
      return signal.type === 'action' && signal.name === adv.action
        && (typeof adv.where !== 'function' || adv.where(signal.args || []));
    case ADVANCE.ANY:
      return signal.type === 'action' && Array.isArray(adv.actions) && adv.actions.includes(signal.name);
    case ADVANCE.VIEW:
      return signal.type === 'view' && signal.view === adv.view;
    case ADVANCE.EVENT:
      return signal.type === 'event' && signal.topic === adv.topic;
    default:
      return false;
  }
}

/**
 * Move to the next step, or finish.
 * @param {object} state the tour state
 * @param {object} def the tour definition
 * @param {object} [extra] fields to merge into the new state
 * @returns {object} the new state
 */
function stepForward(state, def, extra) {
  const next = state.index + 1;
  if (next >= def.steps.length) {
    return { ...state, ...extra, index: def.steps.length - 1, status: 'done', satisfied: true };
  }
  return { ...state, ...extra, index: next, satisfied: isAckStep(def.steps[next]), reason: '' };
}

/**
 * Feed a signal to a running tour.
 *
 * A paused tour ignores everything. That is deliberate: the user pressed Escape because they
 * wanted the rig to themselves for a minute, and a tour that carried on counting their actions
 * would jump three steps forward the moment they resumed it.
 * @param {object} state the tour state
 * @param {object} def the tour definition
 * @param {object} signal the signal, as {@link stepSatisfied}
 * @returns {object} the new state, or the same object when nothing changed
 */
export function signalTour(state, def, signal) {
  if (!state || state.status !== 'running' || !def) return state;
  const step = currentStep(state, def);
  if (!step) return state;
  if (!stepSatisfied(step, signal)) return state;
  return stepForward(state, def);
}

/**
 * Whether the Next button is live.
 * @param {object} state the tour state
 * @param {object} def the tour definition
 * @returns {boolean} whether {@link advanceTour} would move
 */
export function canAdvance(state, def) {
  if (!state || state.status !== 'running') return false;
  return isAckStep(currentStep(state, def));
}

/**
 * The Next button.
 *
 * Refuses on a step that asked the user to do something they have not done, because the entire
 * value of the tour is in that refusal. {@link skipStep} is the escape hatch, and it is always
 * available.
 * @param {object} state the tour state
 * @param {object} def the tour definition
 * @returns {object} the new state, or the same object when the step is not finished
 */
export function advanceTour(state, def) {
  if (!canAdvance(state, def)) return state;
  return stepForward(state, def);
}

/**
 * Go back one step. Always allowed — re-reading is not cheating.
 * @param {object} state the tour state
 * @param {object} def the tour definition
 * @returns {object} the new state
 */
export function backTour(state, def) {
  if (!state || !def || state.status === 'idle') return state;
  const index = clampIndex(state.index - 1, def.steps.length);
  if (index === state.index && state.status !== 'done') return state;
  return { ...state, index, status: 'running', satisfied: isAckStep(def.steps[index]), reason: '' };
}

/**
 * Skip the step the user does not want to do.
 * @param {object} state the tour state
 * @param {object} def the tour definition
 * @returns {object} the new state, with the step's id recorded
 */
export function skipStep(state, def) {
  if (!state || state.status !== 'running' || !def) return state;
  const step = currentStep(state, def);
  const skipped = step ? state.skipped.concat([step.id]) : state.skipped;
  return stepForward(state, def, { skipped });
}

/**
 * Pause the tour, keeping the place.
 * @param {object} state the tour state
 * @param {string} [reason] what interrupted it, shown when it is offered back
 * @returns {object} the new state
 */
export function interruptTour(state, reason = '') {
  if (!state || state.status !== 'running') return state;
  return { ...state, status: 'paused', reason };
}

/**
 * Resume a paused tour on the step it was paused on.
 * @param {object} state the tour state
 * @param {object} def the tour definition
 * @returns {object} the new state
 */
export function resumeTour(state, def) {
  if (!state || state.status !== 'paused' || !def) return state;
  const index = clampIndex(state.index, def.steps.length);
  return { ...state, index, status: 'running', satisfied: isAckStep(def.steps[index]), reason: '' };
}

/**
 * End the tour without finishing it.
 * @param {object} state the tour state
 * @returns {object} {@link IDLE}
 */
export function endTour(state) {
  return state && state.status === 'done' ? state : IDLE;
}

/**
 * What to persist so a paused tour can be offered back in a later session.
 * @param {object} state the tour state
 * @returns {{tourId:string, index:number}|null} the token, or null when there is nothing to resume
 */
export function resumeTokenOf(state) {
  if (!state || (state.status !== 'paused' && state.status !== 'running')) return null;
  return { tourId: state.tourId, index: state.index };
}

/**
 * Rebuild a paused tour from a persisted token.
 *
 * The index is clamped against the CURRENT definition, because a tour that lost a step between
 * builds would otherwise resume onto nothing and show an empty card — which is the failure people
 * report as "the tour is broken" and nobody can reproduce.
 * @param {object|null} token a `{tourId, index}` token, usually `log.resume`
 * @param {Array<object>} [defs=TOURS] the tour table
 * @returns {{state:object, def:object}|null} the paused state and its definition, or null
 */
export function restoreTour(token, defs = TOURS) {
  if (!token || typeof token.tourId !== 'string') return null;
  const def = tourById(token.tourId, defs);
  if (!def || !Array.isArray(def.steps) || !def.steps.length) return null;
  const index = clampIndex(token.index, def.steps.length);
  return {
    def,
    state: {
      tourId: def.id,
      index,
      total: def.steps.length,
      status: 'paused',
      satisfied: isAckStep(def.steps[index]),
      skipped: [],
      reason: 'resumed',
    },
  };
}

/**
 * A step as one paragraph of plain text.
 *
 * This is the reduced-motion and screen-reader form, and it is deliberately the SAME content
 * rather than a shortened version: a user who has turned animation off has not asked to be taught
 * less.
 * @param {object} step the step
 * @param {object} [state] the tour state, for the "step 3 of 7" prefix
 * @returns {string} the paragraph
 */
export function stepText(step, state) {
  if (!step) return '';
  const where = state && state.total
    ? `Step ${Math.min(state.index + 1, state.total)} of ${state.total}. `
    : '';
  const wait = step.advance && step.advance.on !== ADVANCE.ACK
    ? ` ${step.wait || 'The tour continues once you have done this.'}`
    : '';
  return `${where}${step.title}. ${step.body}${wait}`;
}

// =============================================================================================
// 4. PLACEMENT ARITHMETIC
// =============================================================================================

/** Placement constants. Exported because the stylesheet and the tests both depend on them. */
export const PLACE = Object.freeze({
  /** Distance between the spotlight ring and the card. */
  GAP: 12,
  /** How close the card may come to the edge of the window. */
  MARGIN: 12,
  /** How far the arrow stays from the card's own corners. */
  ARROW_INSET: 18,
  /** How far the ring is drawn outside the target. */
  PAD: 6,
  /** Preference order when a step does not state one. */
  ORDER: Object.freeze(['bottom', 'top', 'right', 'left']),
});

/**
 * Clamp a number into a range, tolerating an inverted range.
 * @param {number} x the value
 * @param {number} lo the lower bound
 * @param {number} hi the upper bound
 * @returns {number} the clamped value
 */
function clamp2(x, lo, hi) {
  if (hi < lo) return lo;
  return x < lo ? lo : (x > hi ? hi : x);
}

/**
 * The ring drawn around a target.
 * @param {object|null} target a viewport-space rect `{x, y, w, h}`
 * @param {{w:number, h:number}} viewport the window
 * @param {number} [pad=PLACE.PAD] how far outside the target the ring sits
 * @returns {{x:number, y:number, w:number, h:number, visible:boolean, clipped:boolean}} the ring
 */
export function spotlightRect(target, viewport, pad = PLACE.PAD) {
  const vw = viewport && viewport.w ? viewport.w : 0;
  const vh = viewport && viewport.h ? viewport.h : 0;
  if (!target || !(target.w > 0) || !(target.h > 0)) {
    return { x: 0, y: 0, w: 0, h: 0, visible: false, clipped: false };
  }
  const x0 = target.x - pad;
  const y0 = target.y - pad;
  const x1 = target.x + target.w + pad;
  const y1 = target.y + target.h + pad;
  const cx0 = clamp2(x0, 0, vw);
  const cy0 = clamp2(y0, 0, vh);
  const cx1 = clamp2(x1, 0, vw);
  const cy1 = clamp2(y1, 0, vh);
  const w = Math.max(0, cx1 - cx0);
  const hgt = Math.max(0, cy1 - cy0);
  return {
    x: cx0,
    y: cy0,
    w,
    hgt: undefined,
    h: hgt,
    // A target scrolled off the top of a list has a rect — it is simply not on screen, and the ring
    // must not be drawn as a zero-height line at the edge of the window.
    visible: w > 1 && hgt > 1,
    clipped: cx0 !== x0 || cy0 !== y0 || cx1 !== x1 || cy1 !== y1,
  };
}

/**
 * Room available on each side of a target.
 * @param {object} t the target rect
 * @param {{w:number, h:number}} v the viewport
 * @param {number} gap the gap between ring and card
 * @param {number} margin the window margin
 * @returns {{top:number, bottom:number, left:number, right:number}} usable pixels per side
 */
function roomAround(t, v, gap, margin) {
  return {
    top: t.y - gap - margin,
    bottom: v.h - (t.y + t.h) - gap - margin,
    left: t.x - gap - margin,
    right: v.w - (t.x + t.w) - gap - margin,
  };
}

/**
 * Position the card against a target.
 *
 * Four things have to come out right, and each of them is a bug somebody has shipped:
 *
 *   the card must not cover the thing it is pointing at   — hence the side choice;
 *   it must stay wholly on screen                          — hence the clamp, which is what a
 *                                                             naive `left = centre - w/2` gets
 *                                                             wrong on a target near the edge;
 *   the arrow must stay ON the card after that clamp       — hence ARROW_INSET, which is what
 *                                                             makes an arrow appear detached from
 *                                                             its own card in the corner case;
 *   a target that is not on screen must be SAID to be      — hence `mode: 'centered'`, rather than
 *                                                             a card pinned to the origin pointing
 *                                                             at nothing.
 * @param {object|null} target the target rect `{x, y, w, h}` in viewport space
 * @param {{w:number, h:number}} card the card's measured size
 * @param {{w:number, h:number}} viewport the window
 * @param {object} [opts] options
 * @param {Array<string>} [opts.prefer=PLACE.ORDER] side preference for this step
 * @param {number} [opts.gap=PLACE.GAP] gap between ring and card
 * @param {number} [opts.margin=PLACE.MARGIN] window margin
 * @param {number} [opts.pad=PLACE.PAD] ring padding, so the card clears the ring and not the target
 * @returns {object} `{mode, side, left, top, arrow, offscreen, clipped, reason}`
 */
export function placeCard(target, card, viewport, opts = {}) {
  const gap = Number.isFinite(opts.gap) ? opts.gap : PLACE.GAP;
  const margin = Number.isFinite(opts.margin) ? opts.margin : PLACE.MARGIN;
  const pad = Number.isFinite(opts.pad) ? opts.pad : PLACE.PAD;
  const prefer = (opts.prefer && opts.prefer.length ? opts.prefer : PLACE.ORDER)
    .filter((s) => PLACE.ORDER.includes(s));
  const v = { w: (viewport && viewport.w) || 0, h: (viewport && viewport.h) || 0 };
  const c = { w: (card && card.w) || 0, h: (card && card.h) || 0 };

  const centred = (reason) => ({
    mode: 'centered',
    side: 'center',
    left: Math.max(margin, Math.round((v.w - c.w) / 2)),
    top: Math.max(margin, Math.round((v.h - c.h) / 2)),
    arrow: null,
    offscreen: true,
    clipped: c.w > v.w - 2 * margin || c.h > v.h - 2 * margin,
    reason,
  });

  if (!target || !(target.w > 0) || !(target.h > 0)) return centred('no target on this step');
  // Intersect with the window before believing the rect: an element inside a scrolled panel, or on
  // a view that is not showing, reports a perfectly good rect that is nowhere near the screen.
  const visW = Math.min(target.x + target.w, v.w) - Math.max(target.x, 0);
  const visH = Math.min(target.y + target.h, v.h) - Math.max(target.y, 0);
  if (visW <= 1 || visH <= 1) return centred('the target is not on screen');

  const t = { x: target.x - pad, y: target.y - pad, w: target.w + 2 * pad, h: target.h + 2 * pad };
  const room = roomAround(t, v, gap, margin);
  const needs = { top: c.h, bottom: c.h, left: c.w, right: c.w };

  let side = prefer.find((s) => room[s] >= needs[s]) || '';
  let clipped = false;
  if (!side) {
    // Nothing fits. Take the roomiest side and clamp: an overlapping card the user can read beats
    // a correctly-placed card three quarters off the screen.
    side = PLACE.ORDER.slice().sort((a, b) => (room[b] - room[a])
      || (PLACE.ORDER.indexOf(a) - PLACE.ORDER.indexOf(b)))[0];
    clipped = true;
  }

  let left;
  let top;
  if (side === 'bottom' || side === 'top') {
    left = Math.round(t.x + t.w / 2 - c.w / 2);
    top = side === 'bottom' ? Math.round(t.y + t.h + gap) : Math.round(t.y - gap - c.h);
  } else {
    left = side === 'right' ? Math.round(t.x + t.w + gap) : Math.round(t.x - gap - c.w);
    top = Math.round(t.y + t.h / 2 - c.h / 2);
  }

  const maxLeft = v.w - margin - c.w;
  const maxTop = v.h - margin - c.h;
  const cl = clamp2(left, margin, maxLeft);
  const ct = clamp2(top, margin, maxTop);
  if (cl !== left || ct !== top) clipped = true;
  left = cl;
  top = ct;

  const tipX = clamp2(t.x + t.w / 2, left + PLACE.ARROW_INSET, left + c.w - PLACE.ARROW_INSET);
  const tipY = clamp2(t.y + t.h / 2, top + PLACE.ARROW_INSET, top + c.h - PLACE.ARROW_INSET);
  const arrow = (side === 'bottom' || side === 'top')
    ? { x: Math.round(tipX), y: side === 'bottom' ? top : top + c.h, side }
    : { x: side === 'right' ? left : left + c.w, y: Math.round(tipY), side };

  return { mode: 'anchored', side, left, top, arrow, offscreen: false, clipped, reason: '' };
}

// =============================================================================================
// 5. THE DOM LAYER — nothing below here runs until it is called
// =============================================================================================

/**
 * Resolve a step's target to an element.
 * @param {object} step the step
 * @param {object} root a `document`-shaped object
 * @returns {Element|null} the first selector that matches, or null
 */
export function findTarget(step, root) {
  if (!step || !root || typeof root.querySelector !== 'function') return null;
  const list = Array.isArray(step.target) ? step.target : (step.target ? [step.target] : []);
  for (const sel of list) {
    let el = null;
    try { el = root.querySelector(sel); } catch { el = null; }
    if (el && (!el.hidden || el.offsetParent)) return el;
  }
  return null;
}

/**
 * Build the tour layer.
 *
 * The returned object follows the same shape every view in `src/ui` uses: an element to mount and
 * an `update()` the frame loop calls. `update()` is the only thing that measures the page, which
 * is what keeps the card attached to a target that moves when a panel is resized or a splitter is
 * dragged.
 * @param {object} [opts] the environment
 * @param {object} [opts.storage] a `localStorage`-shaped object for the completion log
 * @param {object} [opts.root] the document, defaulting to the global one
 * @param {object} [opts.win] the window, for its size and its reduced-motion setting
 * @param {(msg:string, kind?:string)=>void} [opts.toast] where a completion message goes
 * @param {Array<object>} [opts.tours=TOURS] the tour table
 * @returns {object} the tour layer
 */
export function createTour(opts = {}) {
  const root = opts.root || (typeof document !== 'undefined' ? document : null);
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const tours = opts.tours || TOURS;
  let log = loadTourLog(opts.storage || null);

  let def = null;
  let state = IDLE;
  let lastKey = '';

  // Motion is asked for once and remembered: a media query evaluated every frame is a layout read
  // in the middle of the frame loop.
  let reduced = false;
  try {
    reduced = !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch { reduced = false; }

  const ring = h('div', { class: 'tour__ring' });
  const arrowEl = h('i', { class: 'tour__arrow' });
  const titleEl = h('b', { class: 'tour__title' });
  const bodyEl = h('p', { class: 'tour__body' });
  const waitEl = h('div', { class: 'tour__wait' });
  const countEl = h('span', { class: 'tour__count' });
  const barEl = h('i', { class: 'tour__fill' });

  const btnBack = h('button', { class: 'tour__btn', type: 'button', text: 'Back', onClick: () => { state = backTour(state, def); paint(); } });
  const btnSkip = h('button', { class: 'tour__btn', type: 'button', text: 'Skip', title: 'Move on without doing this step', onClick: () => { state = skipStep(state, def); paint(); } });
  const btnNext = h('button', { class: 'tour__btn tour__btn--go', type: 'button', text: 'Next', onClick: () => { state = advanceTour(state, def); paint(); } });
  const btnEnd = h('button', { class: 'tour__btn tour__btn--quiet', type: 'button', text: 'End tour', onClick: () => stop() });

  const card = h('div', {
    class: 'tour__card',
    // Not a dialog and not modal: the card is a running commentary on an application that stays
    // live behind it, and `aria-modal` would tell a screen reader the opposite.
    role: 'group',
    'aria-label': 'Guided tour',
  },
  arrowEl,
  h('div', { class: 'tour__head' }, titleEl, countEl),
  h('div', { class: 'tour__bar' }, barEl),
  bodyEl,
  waitEl,
  h('div', { class: 'tour__acts' }, btnBack, btnSkip, h('span', { class: 'tour__gap' }), btnEnd, btnNext));

  /* The live region carries the same words as the card, so the tour is followable without seeing
     the spotlight at all. */
  const say = h('p', { class: 'tour__sr', role: 'status', 'aria-live': 'polite' });

  const el = h('div', { class: `tour${reduced ? ' is-plain' : ''}`, hidden: true }, ring, card, say);

  /**
   * Persist the completion log and the resume token, tolerating a storage that refuses.
   * @returns {void}
   */
  function persist() {
    log = { ...log, resume: state.status === 'paused' ? resumeTokenOf(state) : (log.resume || null) };
    saveTourLog(opts.storage || null, log);
  }

  /**
   * Repaint the card and reposition it. Cheap enough to call every frame: the text writes are
   * change-guarded and the geometry is two rect reads.
   * @returns {void}
   */
  function paint() {
    const step = currentStep(state, def);
    const running = state.status === 'running' && !!step;
    el.hidden = !running;
    if (!running) {
      if (state.status === 'done' && def && !isCompleted(log, def.id)) {
        log = markCompleted(log, def.id);
        persist();
        if (opts.toast) opts.toast(`Tour complete: ${def.title}`);
        def = null;
        state = IDLE;
      }
      return;
    }

    const key = `${state.tourId}:${state.index}`;
    if (key !== lastKey) {
      lastKey = key;
      setText(titleEl, step.title);
      setText(bodyEl, step.body);
      setText(say, stepText(step, state));
    }
    const p = tourProgress(state);
    setText(countEl, `${p.index + 1} / ${p.total}`);
    barEl.style.width = `${((p.index) / Math.max(1, p.total)) * 100}%`;
    const waiting = !canAdvance(state, def);
    setText(waitEl, waiting ? (step.wait || 'Do it on the rig — the tour is watching for it.') : '');
    waitEl.hidden = !waiting;
    btnNext.disabled = waiting;
    btnNext.title = waiting ? 'This step is finished by doing it, not by clicking Next' : '';
    btnBack.disabled = state.index === 0;

    place(step);
  }

  /**
   * Measure and position, using the pure arithmetic above.
   * @param {object} step the current step
   * @returns {void}
   */
  function place(step) {
    if (!win || !card.getBoundingClientRect) return;
    const viewport = { w: win.innerWidth || 0, h: win.innerHeight || 0 };
    const targetEl = findTarget(step, root);
    const r = targetEl && targetEl.getBoundingClientRect ? targetEl.getBoundingClientRect() : null;
    const target = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    const cr = card.getBoundingClientRect();
    const size = { w: cr.width || 320, h: cr.height || 180 };

    const spot = spotlightRect(target, viewport);
    ring.hidden = !spot.visible;
    if (spot.visible) {
      ring.style.left = `${spot.x}px`;
      ring.style.top = `${spot.y}px`;
      ring.style.width = `${spot.w}px`;
      ring.style.height = `${spot.h}px`;
    }

    const pos = placeCard(target, size, viewport, { prefer: step.placement });
    card.style.left = `${pos.left}px`;
    card.style.top = `${pos.top}px`;
    cls(card, 'is-centered', pos.mode === 'centered');
    for (const s of ['top', 'bottom', 'left', 'right']) cls(card, `is-${s}`, pos.side === s);
    arrowEl.hidden = !pos.arrow;
    if (pos.arrow) {
      arrowEl.style.left = `${pos.arrow.x - pos.left}px`;
      arrowEl.style.top = `${pos.arrow.y - pos.top}px`;
    }
    // Said out loud rather than silently swallowed: the user is being told about something they
    // cannot see, and the honest thing is to admit it.
    cls(card, 'is-lost', pos.offscreen);
  }

  /**
   * Start or resume a tour.
   * @param {string} id the tour id
   * @param {object} [startOpts] options passed to {@link startTour}
   * @returns {{ok:boolean, reason?:string}} whether it started
   */
  function start(id, startOpts) {
    const found = tourById(id, tours);
    if (!found) return { ok: false, reason: `there is no tour called "${id}"` };
    if (def && def.id === id && state.status === 'paused') {
      state = resumeTour(state, def);
      paint();
      return { ok: true };
    }
    def = found;
    state = startTour(found, startOpts);
    lastKey = '';
    paint();
    return { ok: true };
  }

  /**
   * Stop the tour without finishing it.
   * @returns {void}
   */
  function stop() {
    state = endTour(state);
    def = null;
    el.hidden = true;
  }

  /**
   * Pause, keeping the place for later.
   * @param {string} [reason] what interrupted it
   * @returns {void}
   */
  function interrupt(reason) {
    state = interruptTour(state, reason || 'paused');
    persist();
    el.hidden = true;
  }

  /**
   * Feed the tour a signal.
   * @param {object} signal as {@link stepSatisfied}
   * @returns {void}
   */
  function signal(signal0) {
    if (!def || state.status !== 'running') return;
    const before = state;
    state = signalTour(state, def, signal0);
    if (state !== before) paint();
  }

  /**
   * Wrap a bound action surface so that doing the thing advances the tour.
   *
   * This is how the tour observes the user without `ui/app.js` having to know it exists: the shell
   * hands its `A` through here once and passes the result to the views. Every property is copied,
   * so an action added later still arrives — it simply reports itself as well as running.
   * @param {object} A the bound actions
   * @returns {object} a surface that behaves identically and emits action signals
   */
  function observe(A) {
    if (!A || typeof A !== 'object') return A;
    const out = {};
    for (const name of Object.keys(A)) {
      const v = A[name];
      if (typeof v !== 'function' || name === 'raw') { out[name] = v; continue; }
      out[name] = (...args) => {
        const res = v(...args);
        // A refused action is not a completed step: the rig said no, so the user has not yet done
        // the thing the step asked for.
        if (!res || res.ok !== false) signal({ type: 'action', name, args });
        return res;
      };
    }
    return out;
  }

  return {
    el,
    /** @returns {void} reposition against the live page */
    update() { if (state.status === 'running') paint(); },
    start,
    stop,
    interrupt,
    signal,
    observe,
    /**
     * Tell the tour the stage changed view.
     * @param {string} view the view id
     * @returns {void}
     */
    setView(view) { signal({ type: 'view', view }); },
    /**
     * Tell the tour something happened on the bus.
     * @param {string} topic the bus topic
     * @param {*} message the message
     * @returns {void}
     */
    event(topic, message) { signal({ type: 'event', topic, message }); },
    /**
     * The picker's contents: every tour, whether it is finished, and which one can be resumed.
     * @returns {Array<object>} one row per tour
     */
    list() {
      return tours.map((t) => ({
        id: t.id,
        title: t.title,
        blurb: t.blurb,
        minutes: t.minutes,
        steps: t.steps.length,
        completed: isCompleted(log, t.id),
        resumable: !!(log.resume && log.resume.tourId === t.id)
          || (def === t && state.status === 'paused'),
      }));
    },
    /** @returns {object} the current state, for the console and the tests */
    status() { return { ...state, def: def ? def.id : '' }; },
    /**
     * The tour that was interrupted in an earlier session, if any.
     * @returns {{state:object, def:object}|null} the restored pair
     */
    pending() { return restoreTour(log.resume, tours); },
  };
}
