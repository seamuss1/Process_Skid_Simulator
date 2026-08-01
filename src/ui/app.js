/**
 * @file src/ui/app.js — the composition root, the HMI-2012 shell, and the program's ONLY
 * `requestAnimationFrame` loop.
 *
 * THE SCREEN. An early-2010s industrial HMI — Wonderware InTouch 2012, FactoryTalk View SE 7,
 * Ignition 7.x — and the High-Performance HMI thinking that arrived with them: cool graphite
 * chrome, 1 px borders over a shallow vertical gradient, recessed fields with WHITE PV digits,
 * 2 px corners, and saturated colour reserved for state and alarms.
 *
 * FOUR bands. The fifth — the bottom value strip of FLOW %B P1 dP UV COND pH CV boxes — is gone.
 * Every number it carried already sits beside its own instrument on the P&ID and in the trend's
 * pen rail, so the band was duplication that cost the workspace 24 px; the workspace has that
 * height back.
 *
 * WHAT WINS THE PRIME REAL ESTATE. The centre of band 2 — the widest, most-looked-at strip on the
 * screen — carries PROCESS STATUS: the run-state chip, the data-quality chip and the alarm summary,
 * at 40 px instead of squeezed into a 26 px title strip, and the alarm tally is no longer parked in
 * the far-right corner. That space used to hold the seven simulation multipliers and the two run
 * actions an operator touches least. Nothing was removed: skip and reset are one press behind
 * [more], the multipliers one press behind [speed], and every keyboard shortcut they ever had still
 * works from anywhere. E-STOP keeps its exact position, its exact size and its exact treatment.
 *
 *   1. TITLE STRIP  26 px — identity and time: unit name (the SIMULATED honesty note lives behind
 *                           it), the block counter, and the sim clock with the method-progress bar.
 *   2. TOOLBAR      40 px — 34×34 gradient-and-border icon buttons in groups split by grooves:
 *                           [run][hold][continue][pause][stop][more] ‖ [estop] ‖
 *                           STATUS: run-state chip · data-quality chip · alarm summary ‖
 *                           [P&ID][TREND][METHOD][RESULTS][CONFIG] · · ·
 *                           [ack][manual][scenarios][help][theme] ‖ [speed] SPD + LIMITED lamp
 *   3. FIRST-OUT ALARM BANNER — present ONLY while an alarm is active or a shell error is showing,
 *                           and taking no height whatever when there is neither. It carries the
 *                           FIRST alarm of the current flurry with its priority word, its ISA tag,
 *                           its identifier and name, the condition AND the consequence in plain
 *                           language, the run-clock time it came in, its acknowledgement state, and
 *                           how many alarms stand behind it. Acknowledge, silence, step to the next
 *                           row and open the alarm list are all on the band. It is TINTED BY
 *                           SEVERITY through a `.banner--*` modifier, never flat, and it carries
 *                           the two `aria-live` regions.
 *   4. WORKSPACE          — everything below the banner, the 24 px the value strip used to hold
 *                           included. One `.view` per screen, stacked and shown one at a time. The
 *                           MAIN screen is `ui/view_run.js`, which holds the P&ID panel over the
 *                           trend panel with the draggable splitter between them: the P&ID and
 *                           TREND nav buttons therefore select the SAME screen and only hint which
 *                           pane to favour, because the co-visibility of schematic and trend is the
 *                           requirement and no navigation may take it away.
 *
 * FIRST OUT, NOT WORST NOW. The banner defaults to the EARLIEST alarm still standing, not the
 * highest-ranked one at this instant, because the first row is the one that says what actually
 * happened; a cascade ranked by severity puts the loudest symptom on the band and buries its cause.
 * `app.firstOut` records the arrival order and the run-clock time of every raised row — stamped
 * from the `ALARM_RAISED` events, so a row that arrived while the tab was hidden still sorts
 * correctly — and empties when the last row clears. That emptying is what makes it a FLURRY rather
 * than a session tally: the next alarm to arrive starts a new first-out story. The step control
 * walks the rest in arrival order and wraps back to the first-out.
 *
 * NO PROSE ON A NORMAL SCREEN. Every control is an icon with `title` + `aria-label`; every number
 * sits in a label box carrying its tag and its engineering unit. Sentences live in tooltips, in the
 * `data/glossary.js` popovers, in help, and on failure surfaces — nowhere else.
 *
 * RESPONSIBILITIES
 *   - Build the ONE `ctx = { config, run, bus, sim, fmt, overrides }`. `skid.createSkid` is
 *     REQUIRED after every `createRunState`, or `run.topo/bed/col` stay null and the first
 *     `physicsTick` throws.
 *   - Own the single rAF loop: `sim.advanceWall(ctx, wallDt_s)` once per frame, then `update()` on
 *     the VISIBLE screen only. A hidden screen costs nothing.
 *   - Own the persistent chrome and every global keyboard shortcut.
 *   - Route every `sim.*` action's `{ ok, reason }` to a toast when `ok` is false — never a silent
 *     refusal.
 *   - Surface `run.speedDeficit` honestly. Demoting the multipliers into a popover must NOT hide
 *     the deficit, so the LIMITED lamp and the SPD label box carrying the achieved multiplier stay
 *     on the toolbar beside the [speed] button, where they are visible without opening anything.
 *
 * THE UI IS READ-ONLY OVER `run` AND `config`. Nothing in this file assigns to either; every
 * mutation goes through `core/sim.js`.
 *
 * FRAME SAFETY. `sim.advanceWall` and every panel `update()` are guarded: a throwing panel is
 * reported in the alarm band and, after three consecutive failures, taken out of the loop — but the
 * loop itself never dies and the shell never freezes.
 *
 * DOM DISCIPLINE. `boot` empties `#app` and builds the shell once. After that this module writes
 * only text, classes and attributes onto cached node references: there is no `innerHTML` anywhere
 * in this file, and no layout read inside a frame.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * CSS CONTRACT — the class vocabulary this module emits. Everything in the FIRST list is styled by
 * `styles/app.css`, which this module does not own and does not touch:
 *   .shell (.is-manual .is-narrow) .skip-link .sr-only
 *   .titlebar .titlebar__brand .titlebar__name .titlebar__spacer .titlebar__meta .titlebar__sep
 *   .titlebar__runstate (.is-running .is-held .is-alarm .is-fault)
 *   .titlebar__quality (.is-suspect .is-invalid)
 *   .toolbar .toolbar__group (.toolbar__group--estop) .toolbar__sep .toolbar__spacer
 *   .iconbtn (.is-active .iconbtn--sm .btn--estop) .holdring .holdring__track .holdring__fill
 *   .segmented .speedchip (.is-active)
 *   .lamp .lamp--off|run|warn|alarm (.is-blink)
 *   .tagblk .tagblk__lbl .lbox (.lbox--narrow .is-alarm .is-warn .is-stale)
 *   .lbox__v .lbox__eu
 *   .progress .progress__fill
 *   .alarmbar (.banner--info|warn|alarm|critical|fault) .banner__bar
 *   .banner__sev .alarmbar__tag .banner__id .alarmbar__code .banner__detail .banner__actions
 *   .banner__count
 *   .workspace .view .view--main|method|results|config
 *   .perf .perf__row .perf__key .perf__value
 *
 * The SECOND list is the geometry the first-out banner and the demoted groups need and that
 * `styles/app.css` has no rule for. It ships with this module, in {@link SHELL_CSS}, injected once
 * as the LAST child of `<head>` — the same discipline `ui/hmi.js` uses for the widget kit. Every
 * value in it resolves through a `var(--token)` out of `styles/tokens.css`; there is not one colour
 * literal in this file:
 *   .alarmbar.fob .fob__body .fob__row .fob__gap .fob__rank (.is-first)
 *   .fob__meta .fob__ack (.is-acked .is-unacked)
 *   .toolbar__group--status .toolbar__group--sim .almsum
 *   .spdpanel .spdpanel__row .runacts .runacts__row .runacts__lbl
 *   .almlist .almlist__row .almlist__txt .almlist__nm .almlist__sub
 * Buttons and glyphs come from `ui/hmi.js` (`iconButton`, `icon`); the label boxes, lamps and bands
 * are built here against the classes above. Every icon name used is one of `hmi.ICON_NAMES`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Layer L10.
 */

import * as sim from '../core/sim.js';
import * as state from '../core/state.js';
import { createBus, QF } from '../core/log.js';
import * as skid from '../skid/skid.js';
import { blockProgress } from '../skid/engine.js';
import { methodDemand } from '../skid/method.js';
import { sensorQuality } from '../skid/sensors.js';
import * as column from '../physics/column.js';
import * as bed from '../physics/bed.js';
import * as presets from '../data/presets.js';
import { GLOSSARY, glossaryFor } from '../data/glossary.js';
import { exportMethodJSON, importMethodJSON, downloadText } from '../io/export.js';
import * as fmt from './format.js';
import * as hmi from './hmi.js';
import * as overlay from './overlay.js';
import * as onboarding from './onboarding.js';
import { createRunView } from './view_run.js';
import { createMethodView } from './view_method.js';
import { createResultsView } from './view_results.js';
import { createSystemView } from './view_system.js';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * CONSTANTS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** The preset the shell boots into. */
const DEFAULT_PRESET_ID = 'cex-capture-igg1-pilot';

/**
 * The four screens of the workspace, in DOM order. `main` is `ui/view_run.js`: the P&ID panel over
 * the trend panel, splitter between, both always visible.
 */
const SCREENS = [
  { id: 'main', create: createRunView },
  { id: 'method', create: createMethodView },
  { id: 'results', create: createResultsView },
  { id: 'config', create: createSystemView },
];

/**
 * The five navigation buttons. `pid` and `trend` select the SAME screen and differ only in the
 * `request-pane` hint they publish, because that screen shows both panes at once.
 */
const NAV = [
  { id: 'pid', screen: 'main', pane: 'pid', icon: 'pid', label: 'Process schematic (P&ID)', key: 'Alt+1' },
  { id: 'trend', screen: 'main', pane: 'trend', icon: 'trend', label: 'Trend', key: 'Alt+2' },
  { id: 'method', screen: 'method', pane: null, icon: 'method', label: 'Method editor', key: 'Alt+3' },
  { id: 'results', screen: 'results', pane: null, icon: 'results', label: 'Results', key: 'Alt+4' },
  { id: 'config', screen: 'config', pane: null, icon: 'config', label: 'Configuration', key: 'Alt+5' },
];

/** Legacy tab ids other modules still emit on `request-tab`, mapped onto the nav ids. */
const LEGACY_NAV = {
  run: 'pid', pid: 'pid', trend: 'trend', chart: 'trend',
  method: 'method', results: 'results', system: 'config', config: 'config',
};

/**
 * The `sensorQuality` channels the title strip's quality lamp rolls up, worst-wins: an INVALID on
 * any one of them makes the lamp red, any other non-OK verdict makes it amber.
 *
 * The lamp's popover lists these same four channels one per line, so the summary an operator sees
 * and the detail they press for can never disagree about which sensors were consulted.
 */
const QUALITY_SENSORS = ['UV', 'COND', 'PH', 'PRESS'];

/**
 * Run state → the `.titlebar__runstate` modifier that colours the WORD. The chip's lamp is driven
 * separately by {@link stateLamp}, so a state with no word colour of its own (IDLE, READY, ENDED)
 * still shows the right lamp: colour is never the only thing carrying the state anyway, because the
 * word itself is on the chip.
 */
const STATE_WORD = {
  IDLE: '', READY: '', RUNNING: 'is-running', HELD: 'is-held', PAUSED: 'is-held',
  ALARM: 'is-alarm', ENDED: '', FAULT: 'is-fault',
};

/** Every `.titlebar__runstate` modifier, so exactly one can be left standing. */
const STATE_WORD_CLASSES = ['is-running', 'is-held', 'is-warn', 'is-alarm', 'is-fault'];

/** Data-quality verdict → the short code the quality chip shows beside its lamp. */
const QUALITY_CODE = { OK: 'OK', SUSPECT: 'SUS', INVALID: 'INV', BYPASSED: 'BYP' };

/** Data-quality verdict → the `.titlebar__quality` modifier that colours the code. */
const QUALITY_WORD = { OK: '', SUSPECT: 'is-suspect', BYPASSED: 'is-suspect', INVALID: 'is-invalid' };

/** Every `.titlebar__quality` modifier, so exactly one can be left standing. */
const QUALITY_WORD_CLASSES = ['is-suspect', 'is-invalid'];

/** Allowed axial grid sizes for the startup benchmark. Downgrade only. */
const NZ_LADDER = [100, 200, 400, 800];

/**
 * Column-solver budget in milliseconds per SIMULATED second, used to pick `nz` at boot.
 * The reference machine measures ~5 ms/sim-s at `nz = 400`, so 8.0 keeps the shipped grid on a
 * reference-class machine and downgrades on one ~1.6× slower.
 */
const NZ_BUDGET_MS_PER_SIM_S = 8.0;

/** Simulated seconds the startup benchmark covers. */
const BENCH_SIM_SECONDS = 3.0;

/** Wall-clock clamp per frame, seconds — mirrors `sim.advanceWall`'s own clamp. */
const WALL_CLAMP_S = 0.25;

/** Press-and-hold duration for Skip Block, ms. */
const SKIP_HOLD_MS = 400;

/** Two `Shift+Esc` presses inside this window fire the emergency stop. */
const ESTOP_DOUBLE_MS = 1000;

/** Consecutive `update()` throws before a screen is taken out of the frame loop. */
const PANEL_FAIL_LIMIT = 3;

/** Radius of the Skip Block hold ring, SVG user units on a 24×24 viewBox. */
const RING_R = 10;

/** Severity ladder used to rank the alarm banner. */
const SEVERITY_RANK = { INFO: 0, WARN: 1, ALARM: 2, CRITICAL: 3, FAULT: 4 };

/**
 * The PRIORITY word the first-out banner shows. The band is a band now, not a 24 px rail, so the
 * priority is spelled out: an operator ranking a row at a glance should not have to expand `CRIT`,
 * and a screen reader should not have to pronounce it.
 */
const SEVERITY_WORD = {
  INFO: 'INFO', WARN: 'WARNING', ALARM: 'ALARM', CRITICAL: 'CRITICAL', FAULT: 'FAULT',
};

/** Lamp colour per severity. */
const SEVERITY_LAMP = { INFO: 'run', WARN: 'warn', ALARM: 'alarm', CRITICAL: 'alarm', FAULT: 'alarm' };

/**
 * Banner tint per severity. The band is never flat: `styles/app.css` washes it and its severity
 * rail with the matching state colour, so an ALARM row and a WARN row are distinguishable before a
 * single word is read.
 */
const SEVERITY_BAND = {
  INFO: 'info', WARN: 'warn', ALARM: 'alarm', CRITICAL: 'critical', FAULT: 'fault',
};

/** Every tint the alarm band can wear, so exactly one `.banner--*` can be left standing. */
const BAND_TONES = ['info', 'warn', 'alarm', 'critical', 'fault'];

/**
 * Comparison operators as words. `P1 > 1.60` is what the row is; "pre-column pressure above
 * 1.60 bar" is what happened, and only the second is readable at 03:00 by someone who did not
 * write the alarm table.
 */
const OP_WORD = {
  '>': 'above', '>=': 'at or above', '<': 'below', '<=': 'at or below',
  '==': 'at', '!=': 'away from',
};

/**
 * The `sensorSignal` names an alarm row may watch, as a plain noun plus the formatter that renders
 * its threshold in the operator's own display units. An unlisted signal falls back to its own name,
 * so a preset that adds a row still reads sensibly rather than throwing.
 * @type {{[signal:string]: {noun:string, fmt:function(number, object):string}}}
 */
const SIGNAL_TEXT = {
  P1: { noun: 'pre-column pressure', fmt: (v) => fmt.fmtPressure(v) },
  P2: { noun: 'post-column pressure', fmt: (v) => fmt.fmtPressure(v) },
  DP: { noun: 'column differential pressure', fmt: (v) => fmt.fmtPressure(v) },
  AIR: { noun: 'the air fraction after the column', fmt: (v) => fmt.fmtPct(v * 100) },
  TEMP_FLUID: { noun: 'fluid temperature', fmt: (v) => `${v} °C` },
  TEMP_CELL: { noun: 'conductivity-cell temperature', fmt: (v) => `${v} °C` },
  UV_280: { noun: 'UV absorbance at 280 nm', fmt: (v) => fmt.fmtAbs(v) },
  UV_260: { noun: 'UV absorbance at 260 nm', fmt: (v) => fmt.fmtAbs(v) },
  UV_300: { noun: 'UV absorbance at 300 nm', fmt: (v) => fmt.fmtAbs(v) },
  COND: { noun: 'conductivity', fmt: (v) => fmt.fmtCond(v) },
  COND_RAW: { noun: 'uncompensated conductivity', fmt: (v) => fmt.fmtCond(v) },
  PH: { noun: 'pH', fmt: (v) => fmt.fmtPH(v) },
  FLOW: { noun: 'flow', fmt: (v, cfg) => fmt.fmtFlow(v, cfg) },
  PCTB: { noun: 'the buffer-B fraction at the column inlet', fmt: (v) => fmt.fmtPct(v) },
  VOLUME_BLOCK: { noun: 'block volume', fmt: (v, cfg) => fmt.fmtVolume(v, cfg) },
  VOLUME_RUN: { noun: 'run volume', fmt: (v, cfg) => fmt.fmtVolume(v, cfg) },
  TIME_BLOCK: { noun: 'time in this block', fmt: (v) => fmt.fmtTime(v) },
  TIME_RUN: { noun: 'run time', fmt: (v) => fmt.fmtTime(v) },
};

/**
 * The custom alarm predicates of `skid/alarms.js`, each as the sentence the operator needs. A row
 * with `op: 'custom'` has no comparison to render, so without this table the banner can only repeat
 * the row's own name — which is exactly the "not a plain-language condition" the design is fixing.
 * @type {{[evalKey:string]: string}}
 */
const EVAL_PHRASE = {
  airInlet: 'Air is reaching the pump inlet',
  trapFill: 'The air trap is filling with gas',
  cavitation: 'The pump is cavitating',
  dryRun: 'The inlet is empty and the pump is running dry',
  flowDeviation: 'Measured flow has drifted off its setpoint',
  uvOverrange: 'The UV detector is over range',
  uvLampFault: 'The UV lamp has failed',
  azUnstable: 'Autozero was taken on a baseline that had not settled',
  tankLow: 'A buffer tank is running low',
  tankEmpty: 'A buffer tank is empty',
  wasteFull: 'The waste tank is full',
  wasteHigh: 'The waste tank is nearly full',
  tempRange: 'Fluid temperature is outside the 2 to 30 °C working band',
  colNotInLine: 'The column is not in line',
  cvMoveUnderFlow: 'A column valve moved while the skid was still flowing',
  cvMismatch: 'A column valve is not in the position it was commanded to',
  phRange: 'pH has drifted away from the buffer it should be following',
  phDegraded: 'The pH electrode has degraded',
  condRange: 'Conductivity has drifted away from the buffer it should be following',
  portsExhausted: 'The fraction collector has no ports left',
  methodTimeout: 'A method watch timed out',
  methodLoops: 'The method has looped back more times than it is allowed to',
  nanTripwire: 'The simulation watchdog found a non-finite number in the state',
};

/**
 * What the skid DOES about an alarm, per `AlarmDef.action`. This is the consequence half of the
 * banner: an operator has to know whether the skid has already acted before they decide what to do
 * next. The wording tracks `skid/engine.js::applyAlarmDemand`, which is the code that acts.
 * @type {{[action:string]: string}}
 */
const ACTION_CONSEQUENCE = {
  NONE: 'Logged only — the skid takes no action of its own.',
  WARN: 'Logged only — the method keeps running and nothing is stopped.',
  REDUCE_FLOW: 'The skid is cutting flow back on its own to stay under the limit.',
  HOLD: 'The skid is HELD: the block clock and block volume freeze, flow stays at setpoint.',
  PAUSE: 'The skid is PAUSED: flow ramps to zero and the clock freezes.',
  STOP: 'The skid is PAUSED: flow ramps to zero and the clock freezes.',
};

/** Event types that change list content and therefore demand a `structural` frame. */
const STRUCTURAL_EVENT_TYPES = {
  BLOCK_START: 1, BLOCK_END: 1, FRACTION_START: 1, FRACTION_END: 1,
  ALARM_RAISED: 1, ALARM_CLEARED: 1, ALARM_ACK: 1, RUN_START: 1, RUN_END: 1,
  STATE_CHANGE: 1, PACKING_TEST_RESULT: 1, SCENARIO_APPLIED: 1,
};

/** Human names for the `run.qualityFlags` bits, for the quality lamp's tooltip and popover. */
const QF_LABELS = [
  [QF.UV_OVERRANGE, 'UV over-range'],
  [QF.UV_SATURATED, 'UV saturated'],
  [QF.UV_LAMP_FAULT, 'UV lamp fault'],
  [QF.UV_AUTOZERO_UNSTABLE, 'Autozero unstable'],
  [QF.COND_DRY, 'Conductivity cell dry'],
  [QF.COND_TEMP_RANGE, 'Cell temperature out of range'],
  [QF.PH_FROZEN_AIR, 'pH frozen by air'],
  [QF.PH_ELECTRODE_DEGRADED, 'pH electrode degraded'],
  [QF.PRESS_SUSPECT, 'Pressure suspect'],
  [QF.DETECTORS_BYPASSED, 'Detectors bypassed'],
  [QF.AIR_IN_PATH, 'Air in the flow path'],
  [QF.FLOW_REDUCED, 'Flow reduced automatically'],
  [QF.MANUAL_OVERRIDE, 'Manual control'],
  [QF.SOLVER_FROZEN, 'Isotherm solver frozen'],
  [QF.SPEED_LIMITED, 'Simulation speed limited'],
  [QF.BED_COLLAPSED, 'Bed collapsed'],
];

/** The inline reset an interactive label box needs, since `.tagblk` is not a button class. */
const BARE_BUTTON = { appearance: 'none', background: 'none', border: '0', padding: '0', cursor: 'pointer' };

/**
 * The inline reset a CHIP that is also a button needs. Deliberately smaller than
 * {@link BARE_BUTTON}: the chip's own class supplies the background, border, padding, colour and
 * font, and an inline value would beat the stylesheet and undo the skin.
 */
const CHIP_BUTTON = { appearance: 'none', cursor: 'pointer' };

/**
 * The geometry `styles/app.css` has no rule for: the first-out banner's band, the two toolbar
 * groups that changed job, and the three low-frequency surfaces the demoted controls moved into.
 *
 * It ships here rather than in the stylesheet for the same reason `ui/hmi.js` ships its own kit CSS
 * — the markup and the rules that make it legible are one unit and must not be able to drift apart
 * — and it is injected as the LAST child of `<head>`, after `styles/app.css` is linked, so a
 * two-class selector like `.alarmbar.fob` can restate the band's height without `!important`.
 *
 * EVERY colour in here is a `var(--token)` out of `styles/tokens.css`. There is not one literal,
 * so both themes fall out of the same rules exactly as the rest of the chrome does.
 */
const SHELL_CSS = `
/* -- band 3: the first-out alarm banner ------------------------------------------------------
   .alarmbar fixes a 24px rail; a band carrying priority, tag, condition, consequence, time,
   acknowledgement and a count is not a rail. The two-class selector restates the height and lets
   every .banner--* tint, the severity rail and the action row keep working unchanged. */
.alarmbar.fob{
  --h-fob:46px;
  height:auto;min-height:var(--h-fob);flex-basis:auto;
  align-items:stretch;gap:var(--sp-5);padding:var(--sp-4) var(--sp-6);
}
.fob__body{
  display:flex;flex-direction:column;justify-content:center;gap:var(--sp-3);
  flex:1 1 auto;min-width:0;
}
.fob__row{display:flex;align-items:center;gap:var(--sp-5);min-width:0;}
.fob__gap{flex:1 1 auto;min-width:var(--sp-4);}
.fob .banner__sev{
  font:600 var(--fs-12)/1 var(--font-ui);letter-spacing:var(--ls-caps);color:var(--ink);
}
.fob__rank,.fob__meta,.fob__ack{
  display:inline-flex;align-items:center;flex:0 0 auto;height:var(--ctl-sm);
  padding:0 var(--sp-4);background:var(--panel-lo);border:var(--border-soft);
  border-radius:var(--r-2);color:var(--ink-2);
  font:600 var(--fs-10)/1 var(--font-ui);letter-spacing:var(--ls-caps);white-space:nowrap;
}
.fob__meta{
  font-family:var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  letter-spacing:var(--ls-num);
}
.fob__rank.is-first{color:var(--ink);border-color:var(--edge);}
.fob__ack.is-unacked{color:var(--fld-sp);border-color:var(--fld-sp);}
.fob__ack.is-acked{color:var(--ok-ink);}
.fob .banner__detail{
  font:400 var(--fs-11)/1.25 var(--font-ui);
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fob .banner__actions{align-self:center;}

/* -- band 2: what the demoted controls handed over ------------------------------------------- */
.toolbar__group--status{
  gap:var(--sp-5);padding:0 var(--sp-5);height:var(--ctl-estop);
  background:var(--panel-lo);border:var(--border-soft);border-radius:var(--r-2);
  box-shadow:var(--elev-sunken);
}
.toolbar__group--status .titlebar__runstate,
.toolbar__group--status .titlebar__quality{
  height:var(--ctl-md);padding:0 var(--sp-5);background:var(--fld-bg);
  border-color:var(--fld-edge);font-size:var(--fs-11);
}
.toolbar__group--status .tagblk{flex-direction:row;align-items:center;gap:var(--sp-4);}
.almsum{display:inline-flex;align-items:center;gap:var(--sp-4);}
/* .toolbar scrolls horizontally on a narrow screen, and this group sits at its far end — which
   would put the LIMITED lamp and the achieved-speed box off the edge exactly when a slow machine
   makes them matter. Sticky to the right pins them in view; the background is the toolbar's own, so
   what scrolls under them simply disappears. */
.toolbar__group--sim{
  gap:var(--sp-4);position:sticky;right:0;
  padding-left:var(--sp-5);background:var(--panel);
}

/* -- the low-frequency surfaces the demoted controls moved into ------------------------------ */
.spdpanel,.runacts{display:flex;flex-direction:column;gap:var(--sp-5);min-width:0;}
.spdpanel__row,.runacts__row{display:flex;align-items:center;gap:var(--sp-5);flex-wrap:wrap;}
.runacts__lbl{
  font:600 var(--fs-10)/1.2 var(--font-ui);text-transform:uppercase;
  letter-spacing:var(--ls-caps);color:var(--ink-2);
}

/* -- the alarm list ------------------------------------------------------------------------- */
.almlist{display:flex;flex-direction:column;gap:var(--sp-4);min-width:0;}
.almlist__row{
  display:flex;align-items:center;gap:var(--sp-5);padding:var(--sp-4) var(--sp-5);
  background:var(--panel-lo);border:var(--border-soft);border-radius:var(--r-2);
}
.almlist__txt{display:flex;flex-direction:column;gap:var(--sp-2);min-width:0;flex:1 1 auto;}
.almlist__nm{font:600 var(--fs-11)/1.25 var(--font-ui);color:var(--ink);}
.almlist__sub{font:400 var(--fs-10)/1.35 var(--font-ui);color:var(--ink-2);}
`;

/** True once {@link SHELL_CSS} is in the document, so a second `boot()` cannot inject it twice. */
let shellStylesInstalled = false;

/**
 * Inject {@link SHELL_CSS} once, as the LAST child of `<head>`.
 *
 * Last, not first: `styles/app.css` is linked from `index.html` and must keep winning every tie it
 * already wins, so this sheet only ever adds rules for classes that stylesheet has none for, plus
 * the one two-class selector (`.alarmbar.fob`) that deliberately outranks a single-class rule.
 *
 * @returns {void}
 */
function ensureShellStyles() {
  if (shellStylesInstalled || typeof document === 'undefined' || !document.head) return;
  shellStylesInstalled = true;
  if (document.getElementById('app-shell-styles')) return;
  const style = document.createElement('style');
  style.id = 'app-shell-styles';
  style.textContent = SHELL_CSS;
  document.head.appendChild(style);
}

/**
 * The global keyboard registry.
 *
 * Keys are normalised combos (`normaliseCombo`): modifiers in the fixed order `Ctrl+Alt+Shift+`,
 * then the key name with single characters upper-cased. `Shift` is dropped for punctuation so `?`,
 * `+` and `-` are reachable on every layout.
 *
 * Shell-scoped actions execute here. Panel-scoped actions (trend, legend, pooling) are emitted on
 * `ctx.bus` as `('key-action', { action, combo, event })`, so whichever panel owns them reacts
 * without a second document-level key listener existing anywhere in the program.
 *
 * @type {{[combo:string]: {action:string, label:string, group:string}}}
 */
export const KEYMAP = {
  'Space': { action: 'start-hold-toggle', label: 'Start / Hold toggle', group: 'Run control' },
  'Ctrl+Enter': { action: 'start-run', label: 'Start the run', group: 'Run control' },
  'H': { action: 'hold', label: 'Hold — flow continues, the clock freezes', group: 'Run control' },
  'C': { action: 'continue', label: 'Continue', group: 'Run control' },
  'N': { action: 'skip-block', label: 'Skip the current block (confirm)', group: 'Run control' },
  'E': { action: 'end-run', label: 'End the run (confirm)', group: 'Run control' },
  // Skip and reset moved off the first toolbar row and behind [more]. They keep a shortcut each, so
  // demoting them cost an operator a click and never a keyboard path.
  'Shift+R': { action: 'reset', label: 'Reset — return to IDLE and rebuild the fluid path', group: 'Run control' },
  'Shift+Escape': { action: 'estop', label: 'Emergency stop — press twice within 1 s', group: 'Run control' },
  'Shift+A': { action: 'alarm-list', label: 'The alarm list, first out at the top', group: 'Alarms' },
  'Shift+K': { action: 'ack-banner', label: 'Acknowledge the alarm the banner is showing', group: 'Alarms' },
  'Shift+ArrowDown': { action: 'alarm-next', label: 'Step the banner to the next alarm', group: 'Alarms' },
  '1': { action: 'speed:0', label: 'Sim speed preset 1', group: 'Simulation speed' },
  '2': { action: 'speed:1', label: 'Sim speed preset 2', group: 'Simulation speed' },
  '3': { action: 'speed:2', label: 'Sim speed preset 3', group: 'Simulation speed' },
  '4': { action: 'speed:3', label: 'Sim speed preset 4', group: 'Simulation speed' },
  '5': { action: 'speed:4', label: 'Sim speed preset 5', group: 'Simulation speed' },
  '6': { action: 'speed:5', label: 'Sim speed preset 6', group: 'Simulation speed' },
  '7': { action: 'speed:6', label: 'Sim speed preset 7', group: 'Simulation speed' },
  'P': { action: 'pause-toggle', label: 'Pause / resume the simulation', group: 'Simulation speed' },
  '[': { action: 'speed-down', label: 'Sim speed down one step', group: 'Simulation speed' },
  ']': { action: 'speed-up', label: 'Sim speed up one step', group: 'Simulation speed' },
  'Alt+1': { action: 'nav:pid', label: 'Main screen, favour the P&ID pane', group: 'Navigation' },
  'Alt+2': { action: 'nav:trend', label: 'Main screen, favour the trend pane', group: 'Navigation' },
  'Alt+3': { action: 'nav:method', label: 'Method screen', group: 'Navigation' },
  'Alt+4': { action: 'nav:results', label: 'Results screen', group: 'Navigation' },
  'Alt+5': { action: 'nav:config', label: 'Configuration screen', group: 'Navigation' },
  'X': { action: 'x-axis-cycle', label: 'Cycle the x axis: volume / CV / time', group: 'Trend' },
  'A': { action: 'autoscale', label: 'Autoscale — fit all', group: 'Trend' },
  'F': { action: 'follow-toggle', label: 'Toggle follow-live', group: 'Trend' },
  '+': { action: 'zoom-in', label: 'Zoom in about the cursor', group: 'Trend' },
  '-': { action: 'zoom-out', label: 'Zoom out about the cursor', group: 'Trend' },
  'ArrowLeft': { action: 'pan-left', label: 'Pan left', group: 'Trend' },
  'ArrowRight': { action: 'pan-right', label: 'Pan right', group: 'Trend' },
  'Shift+ArrowLeft': { action: 'pan-left-fast', label: 'Pan left, 5×', group: 'Trend' },
  'Shift+ArrowRight': { action: 'pan-right-fast', label: 'Pan right, 5×', group: 'Trend' },
  'L': { action: 'legend-focus', label: 'Pen rail focus mode', group: 'Trend' },
  'M': { action: 'mark-fraction', label: 'Mark a fraction manually', group: 'Fractions' },
  'Shift+P': { action: 'pool-selection', label: 'Pool the selected fraction range', group: 'Fractions' },
  '?': { action: 'cheat-sheet', label: 'This shortcut list', group: 'General' },
  'Ctrl+S': { action: 'export-method', label: 'Export the method as JSON', group: 'General' },
  'Ctrl+O': { action: 'import-method', label: 'Import a method from JSON', group: 'General' },
  'Ctrl+Alt+P': { action: 'perf-overlay', label: 'Performance overlay', group: 'General' },
  'Escape': { action: 'dismiss', label: 'Close a popover or dialog, cancel a drag', group: 'General' },
};

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * MODULE SINGLETON
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The one live application instance. `boot` creates it; the exported `frame` reads it.
 * @type {object|null}
 */
let app = null;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * WIDGETS — icon buttons and glyphs come from ui/hmi.js; label boxes, chips and lamps are built
 * here against the HMI-2012 classes styles/app.css defines.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Build an element through `ui/format.js::h`, the app's only element factory.
 * @param {string} tag element tag name
 * @param {object} attrs attribute bag (see `format.h`)
 * @param {...(Node|string)} children child nodes or text
 * @returns {Element} the new element
 */
function h(tag, attrs, ...children) {
  return fmt.h(tag, attrs, ...children);
}

/**
 * Create a `<button>` with a click handler already attached. Used for the few text controls the
 * design allows — the speed numerals — and for the buttons inside modals.
 * @param {string} className the full class attribute
 * @param {string} label visible text
 * @param {function(MouseEvent):void} onClick click handler
 * @param {object} [attrs] extra attributes (title, aria-*, data-*)
 * @returns {HTMLButtonElement} the button
 */
function button(className, label, onClick, attrs) {
  const a = Object.assign({ class: className, type: 'button' }, attrs || {});
  const el = /** @type {HTMLButtonElement} */ (h('button', a, label));
  el.addEventListener('click', onClick);
  return el;
}

/**
 * Build one 34×34 icon button through `hmi.iconButton`, carrying the shell's own `.iconbtn` class
 * so `styles/app.css` and the kit's own rules agree on its geometry.
 *
 * The face never carries a word: the meaning is in `title` (hover) and `aria-label` (assistive
 * technology), exactly as an HMI-2012 toolbar does it.
 *
 * @param {{icon:string, label:string, title?:string, cls?:string, danger?:boolean, sm?:boolean,
 *          pressed?:boolean, onClick?:function(MouseEvent):void}} spec the button
 * @returns {HTMLButtonElement} the button
 */
function iconButton(spec) {
  const size = spec.sm ? 26 : 34;
  const btn = hmi.iconButton(spec.icon, {
    title: spec.title || spec.label,
    ariaLabel: spec.label,
    onClick: spec.onClick,
    className: `iconbtn${spec.sm ? ' iconbtn--sm' : ''}${spec.cls ? ` ${spec.cls}` : ''}`,
    size,
    iconSize: spec.sm ? 14 : 20,
    danger: !!spec.danger,
    pressed: spec.pressed,
  });
  return btn;
}

/**
 * Build a round status lamp. Colour alone never carries meaning: every lamp has an accessible name
 * and a tooltip that states the condition it is showing.
 * @param {string} label the initial accessible name
 * @returns {HTMLElement} the lamp
 */
function lamp(label) {
  return /** @type {HTMLElement} */ (h('span', {
    class: 'lamp lamp--off', role: 'img', 'aria-label': label, title: label,
  }));
}

/**
 * Drive a lamp built by {@link lamp}.
 * @param {Element} el the lamp
 * @param {'off'|'run'|'warn'|'alarm'} tone the lamp colour
 * @param {string} label the accessible name, which must state the current condition
 * @param {boolean} [blink] true to blink (CSS stands this down under `prefers-reduced-motion`)
 * @returns {void}
 */
function setLamp(el, tone, label, blink) {
  if (!el) return;
  fmt.cls(el, 'lamp--off', tone === 'off');
  fmt.cls(el, 'lamp--run', tone === 'run');
  fmt.cls(el, 'lamp--warn', tone === 'warn');
  fmt.cls(el, 'lamp--alarm', tone === 'alarm');
  fmt.cls(el, 'is-blink', !!blink);
  fmt.setAttr(el, 'aria-label', label);
  fmt.setAttr(el, 'title', label);
}

/**
 * Build a label box: a 10 px uppercase tag beside a recessed field holding right-aligned tabular
 * digits in white and a smaller, dimmer engineering unit. This is the workhorse of the design —
 * every number in the chrome lives in one.
 *
 * The box becomes a real button when there is something behind it (a glossary entry, or an explicit
 * handler), so the explanation is reachable from the keyboard. A box with nothing behind it stays a
 * span: a dead button is worse than a label.
 *
 * @param {{tag:string, eu?:string, title?:string, narrow?:boolean, gloss?:string,
 *          onClick?:function(MouseEvent):void}} spec the box
 * @returns {{el:HTMLElement, val:Element, eu:Element, box:Element}} the box and its live nodes
 */
function labelBox(spec) {
  const val = h('span', { class: 'lbox__v' }, fmt.NO_VALUE);
  const eu = h('span', { class: 'lbox__eu' }, spec.eu || '');
  const box = h('span', { class: `lbox${spec.narrow ? ' lbox--narrow' : ''}` }, val, eu);
  const tag = h('span', { class: 'tagblk__lbl' }, spec.tag);

  const entry = spec.gloss ? glossaryFor(spec.gloss) : null;
  const interactive = !!(spec.onClick || entry);
  const el = /** @type {HTMLElement} */ (h(interactive ? 'button' : 'span', {
    class: 'tagblk',
    type: interactive ? 'button' : null,
    style: interactive ? BARE_BUTTON : null,
    title: spec.title || spec.tag,
    'data-tag': spec.tag,
  }, tag, box));
  if (interactive) {
    el.addEventListener('click', (ev) => {
      if (spec.onClick) spec.onClick(ev);
      else if (app) showGlossary(app, el, spec.gloss);
    });
  }
  return { el, val, eu, box };
}

/**
 * Write a value into a label box, skipping unchanged text.
 * @param {{val:Element, eu:Element}} rec a {@link labelBox} record
 * @param {string} text the formatted value
 * @param {string} [euText] the engineering unit
 * @returns {void}
 */
function setBox(rec, text, euText) {
  if (!rec) return;
  fmt.setText(rec.val, text);
  if (euText !== undefined) fmt.setText(rec.eu, euText);
}

/**
 * Colour a label box's digits: alarm red beats stale grey beats the normal white PV.
 * @param {{box:Element}} rec a {@link labelBox} record
 * @param {boolean} inAlarm true when the tag is in alarm
 * @param {boolean} stale true when the sensor quality is SUSPECT, INVALID or BYPASSED
 * @returns {void}
 */
function setBoxState(rec, inAlarm, stale) {
  if (!rec) return;
  fmt.cls(rec.box, 'is-alarm', inAlarm);
  fmt.cls(rec.box, 'is-stale', !inAlarm && stale);
}

/**
 * Set `disabled` plus a `title` that explains WHY when the control is unavailable.
 * @param {HTMLButtonElement} el the control
 * @param {boolean} enabled true to enable
 * @param {string} whyDisabled the tooltip shown while disabled
 * @param {string} whenEnabled the tooltip shown while enabled
 * @returns {void}
 */
function setEnabled(el, enabled, whyDisabled, whenEnabled) {
  if (!el) return;
  if (el.disabled !== !enabled) el.disabled = !enabled;
  fmt.setAttr(el, 'title', enabled ? whenEnabled : whyDisabled);
}

/** @returns {Element} a groove between two toolbar groups */
function toolbarSep() {
  return h('span', {
    class: 'toolbar__sep', role: 'separator', 'aria-orientation': 'vertical',
  });
}

/**
 * Tint the alarm band. Exactly one `.banner--*` modifier is ever set, so the band is washed with
 * the colour of the severity it is carrying rather than staying a flat grey rail that an operator
 * has to read before they know how bad it is.
 * @param {Element} el the alarm band
 * @param {string} tone one of {@link BAND_TONES}, or `''` for no tint
 * @returns {void}
 */
function setBandTone(el, tone) {
  if (!el) return;
  for (const t of BAND_TONES) fmt.cls(el, `banner--${t}`, t === tone);
}

/**
 * Leave exactly one modifier standing on a chip, from a closed vocabulary.
 * @param {Element} el the chip
 * @param {string[]} all every modifier the chip may wear
 * @param {string} want the one it should wear now, or `''` for none
 * @returns {void}
 */
function setModifier(el, all, want) {
  if (!el) return;
  for (const c of all) fmt.cls(el, c, c === want);
}

/**
 * True when a text-entry element has focus, in which case bare keys are the user's typing.
 * @returns {boolean} whether keyboard shortcuts must stand down
 */
function typingInField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!(/** @type {HTMLElement} */ (el).isContentEditable);
}

/**
 * Normalise a keyboard event to a `KEYMAP` combo string.
 *
 * Modifier order is fixed (`Ctrl+Alt+Shift+`); `Meta` folds into `Ctrl` so macOS `⌘S` works.
 * `Shift` is dropped for non-letter single characters, because `?`, `+`, `[` and `]` require it on
 * many layouts and would otherwise be unreachable.
 *
 * @param {KeyboardEvent} e the event
 * @returns {string} the combo, e.g. `'Ctrl+Alt+P'`, `'Shift+Escape'`, `'?'`
 */
function normaliseCombo(e) {
  let key = e.key;
  if (key === ' ' || key === 'Spacebar') key = 'Space';
  const single = key.length === 1;
  const isLetter = single && key.toUpperCase() !== key.toLowerCase();
  if (single) key = key.toUpperCase();
  let combo = '';
  if (e.ctrlKey || e.metaKey) combo += 'Ctrl+';
  if (e.altKey) combo += 'Alt+';
  if (e.shiftKey && (!single || isLetter)) combo += 'Shift+';
  return combo + key;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * BOOT
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Build the whole application inside `rootEl` and start the frame loop.
 *
 * Boot order:
 *   1. warm both theme-token maps, adopt the theme `index.html` stamped, build the shell chrome;
 *   2. build `ctx` (`normalizePreset` → `createRunState` → **`createSkid`**, which is required);
 *   3. benchmark a throwaway column, pick `nz` (downgrade only), `sim.rebuild(ctx, {column:{nz}})`;
 *   4. mount the four screens, only the visible one updating;
 *   4a. mount `ui/onboarding.js` — after the screens, because its coach marks measure them, and
 *       before the loop, because its tour may auto-load a scenario;
 *   5. start the single `requestAnimationFrame` loop.
 *
 * @param {Element} rootEl `#app` from `index.html`; its placeholder content is removed
 * @returns {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}}
 *   the one long-lived `ctx`
 */
export function boot(rootEl) {
  if (app && app.rafId) cancelAnimationFrame(app.rafId);
  // createOverlayHost appends a fresh .ov-root to <body> every call, so a second boot() in the same
  // document would leave the first host's layer, Esc handler and focus trap behind. Tear it down on
  // the same re-entry path that already cancels the previous rAF loop.
  if (app && app.overlayHost) {
    try { overlay.destroyOverlayHost(app.overlayHost); } catch (err) { /* never block a re-boot */ }
  }

  const presetId = presets.PRESETS[DEFAULT_PRESET_ID]
    ? DEFAULT_PRESET_ID
    : Object.keys(presets.PRESETS)[0];

  const config = presets.normalizePreset(presetId, {});
  const run = state.createRunState(config);
  skid.createSkid(config, run);                       // REQUIRED: builds run.topo / bed / col

  /** @type {any} */
  const ctx = { config, run, bus: createBus(), sim, fmt, overrides: {} };

  app = {
    ctx,
    root: rootEl,
    el: {},                       // cached shell nodes
    screens: new Map(),           // screenId -> { panel, host, failCount, disabled }
    activeScreen: 'main',
    activeNav: 'pid',
    overlayHost: null,
    glossaryHandle: null,         // the ONE open glossary popover, or null — see showGlossary
    onboarding: null,
    // HMI-2012 is a graphite design; index.html stamps dark before first paint.
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    rafId: 0,
    tPrev: 0,
    structural: true,
    frameInfo: { now_ms: 0, dt_ms: 16.7, tick: 0, structural: true },
    lastEventCount: 0,
    demandCache: null,            // { config, total_mL, startById }
    progressPct: -1,
    // `null`, never `''`: an EMPTY alarm set has the signature `''`, so a `''` sentinel would make
    // "some alarms" -> "no alarms" compare equal and leave the banner on screen forever.
    alarmSig: null,
    alarm: {
      active: [], order: [], all: [],
      signals: new Set(), evals: new Set(), raised: new Set(), acked: new Set(),
      count: 0, crit: 0, alarms: 0, warns: 0, worst: '', ackable: null,
    },
    // THE FLURRY. `at` maps an alarm id to the order and the run-clock time it arrived; `seq` is
    // the counter behind that order. Both are emptied the moment the last raised row clears, which
    // is what makes the next arrival a NEW first-out rather than the tail of the old story.
    firstOut: { seq: 0, at: new Map() },
    // The id of the alarm the BANNER is showing — written by refreshAlarmBar, read by every
    // control on the band. It is NOT `a.alarm.ackable`: that one ranks over silenced rows too,
    // and acting on it from a band labelled for a different row acknowledges an alarm the
    // operator cannot see.
    bannerAlarmId: null,
    // Set only while the operator has STEPPED off the first-out row; null means "show first out".
    // Storing the id rather than an index means a row clearing under the operator's feet drops the
    // banner back to the first-out instead of silently sliding a different alarm under the ACK.
    bannerPinId: null,
    silenced: new Set(),          // alarm ids the operator muted for this session
    liveAlarmId: null,
    faceplateFail: '',            // last faceplate failure reported, so a repeat is not re-reported
    shellError: null,             // { source, message, detail } — the failure surface of the band
    skipHold: { active: false, start_ms: 0 },
    estopArm_ms: 0,
    perfOn: false,
    perf: { frame_ms: 16.7, sim_ms: 0, render_ms: 0, ticks: 0, tps: 0, tAcc: 0, nAcc: 0 },
    perfRows: null,
    simFailed: false,
    fileInput: null,
    benchmark: null,
  };

  try {
    // ---- 1. theme tokens + shell chrome ------------------------------------------------------
    warmThemeTokens();
    ensureShellStyles();
    buildShell(app);
    applyTheme(app, app.theme, false);

    // ---- 3. startup grid benchmark -----------------------------------------------------------
    runStartupBenchmark(app);

    // ---- 4. the four screens -----------------------------------------------------------------
    mountScreens(app);

    // ---- 4a. onboarding ----------------------------------------------------------------------
    try {
      app.onboarding = onboarding.createOnboarding(app.el.shell, ctx, app.overlayHost);
      if (app.onboarding && typeof app.onboarding.mount === 'function') app.onboarding.mount();
    } catch (err) {
      app.onboarding = null;
      reportError(app, 'onboarding', err);
    }

    // ---- input wiring ------------------------------------------------------------------------
    wireBus(app);
    wireKeyboard(app);
    wireResponsive(app);
    document.addEventListener('visibilitychange', () => { app.tPrev = 0; });

    refreshNav(app);
    refreshShell(app, true);
  } catch (err) {
    showBootError(err);
    throw err;
  }

  // ---- 5. the one rAF loop -------------------------------------------------------------------
  app.rafId = requestAnimationFrame(frame);
  return ctx;
}

/**
 * Reveal `index.html`'s `#boot-error` panel with a real message. A blank page is the worst possible
 * failure mode for a teaching tool, so a boot that throws says what threw.
 * @param {*} err the thrown value
 * @returns {void}
 */
function showBootError(err) {
  const panel = document.getElementById('boot-error');
  if (!panel) return;
  const slot = panel.querySelector('[data-slot="detail"]');
  if (slot) fmt.setText(slot, `${errText(err)}\n${(err && err.stack) || ''}`);
  panel.hidden = false;
}

/**
 * Warm both theme-token maps once at boot. `readThemeTokens` owns the hidden probes and the cache;
 * calling it here pays that cost before the first paint instead of inside a frame.
 * @returns {void}
 */
function warmThemeTokens() {
  try {
    fmt.readThemeTokens('light');
    fmt.readThemeTokens('dark');
  } catch (err) {
    // A missing token map degrades exported-PNG colour fidelity; it must never block boot.
    console.warn('readThemeTokens failed at boot:', err);
  }
}

/**
 * Time a throwaway column and pick the axial grid size, downgrading only.
 *
 * Cost scales close to `nz²` — the cell count rises linearly and the Courant-limited substep count
 * rises with it — so one measurement at the preset's own `nz` predicts every rung of the ladder.
 *
 * @param {object} a the application instance
 * @returns {void}
 */
function runStartupBenchmark(a) {
  const cfg = a.ctx.config;
  try {
    const demand = methodDemand(cfg, cfg.method);
    const flow_mLs = (demand && demand.totalTime_s > 0)
      ? demand.totalVolume_mL / demand.totalTime_s
      : cfg.column.A_cm2 * 150 / 3600;
    const bench = column.benchmarkColumn(bed.buildColumnCfg(cfg), {
      simSeconds: BENCH_SIM_SECONDS,
      flow_mLs: Math.max(flow_mLs, 1e-3),
    });
    a.benchmark = bench;

    const nz0 = bench.nz || cfg.column.nz;
    const cost0 = bench.msPerSimSecond;
    let pick = NZ_LADDER[0];
    if (Number.isFinite(cost0) && cost0 > 0) {
      for (const nz of NZ_LADDER) {
        if (nz > cfg.column.nz) break;                     // downgrade only, never upgrade
        const predicted = cost0 * (nz / nz0) * (nz / nz0);
        if (predicted <= NZ_BUDGET_MS_PER_SIM_S) pick = nz;
      }
    } else {
      pick = Math.min(cfg.column.nz, NZ_LADDER[NZ_LADDER.length - 1]);
    }
    if (pick !== cfg.column.nz) sim.rebuild(a.ctx, { column: { nz: pick } });
  } catch (err) {
    // A failed benchmark leaves the preset's own nz in place. That is the safe direction.
    console.warn('startup grid benchmark failed, keeping the preset nz:', err);
  }
}

/**
 * Construct the four screens into their hosts and hide all but the active one. A screen that throws
 * at construction is reported in the alarm band instead of taking the shell down.
 * @param {object} a the application instance
 * @returns {void}
 */
function mountScreens(a) {
  for (const scr of SCREENS) {
    const host = h('section', {
      class: `view view--${scr.id}`, id: `screen-${scr.id}`, 'data-screen': scr.id, tabindex: '0',
    });
    if (scr.id !== a.activeScreen) host.hidden = true;
    a.el.workspace.appendChild(host);

    let panel = null;
    try {
      panel = scr.create(host, a.ctx);
      if (panel && typeof panel.mount === 'function') panel.mount();
    } catch (err) {
      panel = null;
      reportError(a, `${scr.id} screen`, err);
    }
    a.screens.set(scr.id, { panel, host, failCount: 0, disabled: !panel });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SHELL CONSTRUCTION — the four HMI-2012 bands, built once
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Empty `#app` and build the shell: title strip 26 px, toolbar 40 px, alarm banner 24 px and the
 * workspace — plus the out-of-flow skip link and perf overlay.
 *
 * The workspace is the LAST band, and the only one that grows: there is no bottom value strip to
 * take a fixed 24 px off it.
 *
 * @param {object} a the application instance
 * @returns {void}
 */
function buildShell(a) {
  while (a.root.firstChild) a.root.removeChild(a.root.firstChild);

  const shell = h('div', { class: 'shell' });
  a.el.shell = shell;

  shell.appendChild(h('a', { class: 'skip-link', href: '#toolbar' }, 'Skip to the run controls'));
  shell.appendChild(buildTitleBar(a));
  shell.appendChild(buildToolbar(a));
  shell.appendChild(buildAlarmBar(a));

  const workspace = h('main', { class: 'workspace' });
  a.el.workspace = workspace;
  shell.appendChild(workspace);

  const perf = h('div', { class: 'perf', role: 'status', 'aria-label': 'Performance' });
  perf.hidden = true;
  a.el.perf = perf;
  shell.appendChild(perf);

  a.root.appendChild(shell);

  // One host for the whole app. It is handed the mount root, because that is the subtree it marks
  // `inert` + `aria-hidden` while a modal is up; its own layer goes on <body>.
  a.overlayHost = overlay.createOverlayHost(a.root);

  // Publish it on ctx BEFORE mountScreens() runs. Every panel resolves its host as
  // `ctx.overlayHost || ctx.overlay || createOverlayHost(...)`, so without this line each panel
  // builds a host of its own — competing Esc handlers and focus traps over one modal stack.
  a.ctx.overlayHost = a.overlayHost;
}

/**
 * Band 1 — the 26 px title strip: unit name (the honesty note is behind it), the block counter, and
 * the sim clock with the method-progress bar. Identity and time, and nothing else.
 *
 * The run-state chip, the data-quality chip and the alarm summary used to be crammed in here beside
 * them, with the alarm tally pushed into the far-right corner where it read as a decoration rather
 * than an indication. All three are now in band 2, at the centre of the widest strip on the screen
 * and at 40 px instead of 18; they are BUILT here, next to the code that refreshes them, and
 * {@link buildToolbar} appends them where they belong.
 *
 * @param {object} a the application instance
 * @returns {Element} the title strip
 */
function buildTitleBar(a) {
  const bar = h('header', { class: 'titlebar' });

  const brand = h('div', { class: 'titlebar__brand' });
  const unit = button('titlebar__name', '', (e) => {
    overlay.showPopover(a.overlayHost, {
      anchorEl: /** @type {Element} */ (e.currentTarget),
      content: honestyContent(a),
      placement: 'bottom',
      maxWidth: 360,
    });
  }, {
    style: BARE_BUTTON,
    title: 'SIMULATED — what this model does, and what it deliberately does not',
    'aria-label': 'This is a simulation. Press for what the model does and does not do.',
  });
  a.el.unitName = unit;
  brand.appendChild(unit);
  a.el.blkBox = labelBox({ tag: 'BLK', gloss: 'block.type', title: 'Method block', narrow: true });
  brand.appendChild(a.el.blkBox.el);
  bar.appendChild(brand);

  bar.appendChild(h('span', { class: 'titlebar__spacer' }));

  const meta = h('div', { class: 'titlebar__meta' });
  a.el.clkBox = labelBox({ tag: 'CLK', gloss: 'run-state', title: 'Simulated run clock' });
  meta.appendChild(a.el.clkBox.el);
  const track = h('div', {
    class: 'progress', role: 'progressbar',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
    'aria-label': 'Method progress',
  });
  const fill = h('span', { class: 'progress__fill' });
  track.appendChild(fill);
  a.el.progressTrack = track;
  a.el.progressFill = fill;
  meta.appendChild(track);
  bar.appendChild(meta);

  buildStatusIndication(a);
  return bar;
}

/**
 * Build the three PROCESS STATUS indications the toolbar's prime slot carries. They are built here,
 * beside the title strip they used to live in and beside {@link refreshStatusIndication}, and hung
 * on `a.el` for {@link buildToolbar} to place.
 *
 * Each of the first two is a lamp plus one WORD: the word is the information, the lamp is the
 * pre-attentive cue, and the words live in text NODES so writing them cannot remove the lamp.
 *
 * @param {object} a the application instance
 * @returns {void}
 */
function buildStatusIndication(a) {
  a.el.stateLamp = lamp('Run state: IDLE');
  a.el.stateWord = document.createTextNode('IDLE');
  a.el.stateChip = h('span', {
    class: 'titlebar__runstate', title: `Run state: IDLE — ${stateExplanation('IDLE')}`,
  }, a.el.stateLamp, a.el.stateWord);

  // The quality chip is a real button, so the per-sensor verdicts the QUAL box used to open stay
  // one press away. Everything visual comes from `.titlebar__quality`, so the inline reset is only
  // what a `<button>` needs to stop looking like one.
  a.el.qualLamp = lamp('Data quality: OK');
  a.el.qualWord = document.createTextNode(QUALITY_CODE.OK);
  a.el.qualBtn = button('titlebar__quality', '', () => showQualityPopover(a, a.el.qualBtn), {
    style: CHIP_BUTTON,
    'aria-label': 'Data quality: OK — press for the per-sensor verdicts',
  });
  a.el.qualBtn.appendChild(a.el.qualLamp);
  a.el.qualBtn.appendChild(a.el.qualWord);

  // The summary: three lamps and a count, no longer a number in a corner. The count is a button
  // that opens the alarm list, because a tally an operator cannot press is a decoration.
  a.el.lampCrit = lamp('Critical alarms: none');
  a.el.lampAlarm = lamp('Alarms: none');
  a.el.lampWarn = lamp('Warnings: none');
  a.el.almBox = labelBox({
    tag: 'ALM', title: 'Active alarms — press for the alarm list', narrow: true,
    onClick: () => showAlarmList(a),
  });
  fmt.setAttr(a.el.almBox.el, 'aria-haspopup', 'dialog');
  a.el.almSum = h('div', { class: 'almsum' },
    a.el.lampCrit, a.el.lampAlarm, a.el.lampWarn, a.el.almBox.el);
}

/**
 * Band 2 — the 40 px icon toolbar. Six groups split by grooves: transport, emergency stop, PROCESS
 * STATUS, screen navigation, system, and — last, at the quiet end of the row — simulation speed.
 * Every control is icon-only, and the active navigation button wears `.is-active`, which
 * `styles/app.css` paints with `--accent`.
 *
 * The ORDER is the point. Reading left to right an operator meets what they touch every minute
 * (transport), what they must never hunt for (E-STOP), and then what the screen is actually telling
 * them (status) — before anything low-frequency. Skip and reset are behind [more]; the seven
 * simulation multipliers are behind [speed], at the far right, past the theme button.
 *
 * @param {object} a the application instance
 * @returns {Element} the toolbar
 */
function buildToolbar(a) {
  const bar = h('div', {
    class: 'toolbar', id: 'toolbar', role: 'toolbar', 'aria-label': 'Run controls', tabindex: '-1',
  });

  /* -- 1. transport --------------------------------------------------------------------------
     Pause is a PROCESS act — it ramps flow to zero — not a simulation-speed act, so it belongs
     here with the rest of the transport and not in the group that carries the multipliers. */
  const g1 = h('div', { class: 'toolbar__group', 'data-tour': 'run-controls' });
  a.el.runBtn = iconButton({ icon: 'run', label: 'Start the run', onClick: () => doStartOrContinue(a) });
  a.el.holdBtn = iconButton({ icon: 'hold', label: 'Hold', onClick: () => act(a, () => sim.hold(a.ctx)) });
  a.el.contBtn = iconButton({
    icon: 'continue', label: 'Continue', onClick: () => act(a, () => sim.resume(a.ctx)),
  });
  a.el.pauseBtn = iconButton({
    icon: 'pause', label: 'Pause the simulation', pressed: false, onClick: () => togglePause(a),
  });
  a.el.stopBtn = iconButton({
    icon: 'stop', label: 'End the run',
    onClick: (e) => openEndPopover(a, /** @type {Element} */ (e.currentTarget)),
  });
  fmt.setAttr(a.el.stopBtn, 'aria-haspopup', 'dialog');
  a.el.moreBtn = iconButton({
    icon: 'dots', label: 'Skip block and reset',
    title: 'Skip block and reset — the two run actions you touch least (N, Shift+R)',
    onClick: (e) => openRunActions(a, /** @type {Element} */ (e.currentTarget)),
  });
  fmt.setAttr(a.el.moreBtn, 'aria-haspopup', 'dialog');
  for (const b of [a.el.runBtn, a.el.holdBtn, a.el.contBtn, a.el.pauseBtn, a.el.stopBtn, a.el.moreBtn]) {
    g1.appendChild(b);
  }
  // Skip and reset are BUILT here, beside the transport they belong to, and MOUNTED in the [more]
  // popover by openRunActions. They are the same real, focusable buttons they always were, and
  // refreshToolbar keeps enabling and disabling them whether or not the popover is open.
  a.el.skipBtn = buildSkipButton(a);
  a.el.resetBtn = iconButton({
    icon: 'reset', label: 'Reset', title: 'Return to IDLE and rebuild the fluid path (Shift+R)',
    onClick: () => act(a, () => sim.reset(a.ctx)),
  });
  bar.appendChild(g1);
  bar.appendChild(toolbarSep());

  /* -- 2. emergency stop, alone behind its own groove ---------------------------------------- */
  const g2 = h('div', { class: 'toolbar__group toolbar__group--estop' });
  a.el.estopBtn = iconButton({
    icon: 'estop', label: 'Emergency stop', cls: 'btn--estop', danger: true,
    title: 'Emergency stop — acts immediately, no undo (Shift+Esc twice within 1 s)',
    onClick: () => act(a, () => sim.estop(a.ctx)),
  });
  g2.appendChild(a.el.estopBtn);
  bar.appendChild(g2);
  bar.appendChild(toolbarSep());

  /* -- 3. PROCESS STATUS — the prime slot the multipliers used to hold ------------------------ */
  const g3 = h('div', {
    class: 'toolbar__group toolbar__group--status', 'data-tour': 'status',
    role: 'group', 'aria-label': 'Process status',
  });
  g3.appendChild(a.el.stateChip);
  g3.appendChild(a.el.qualBtn);
  g3.appendChild(a.el.almSum);
  bar.appendChild(g3);
  bar.appendChild(toolbarSep());

  /* -- 4. screen navigation ------------------------------------------------------------------- */
  const g4 = h('div', { class: 'toolbar__group' });
  a.el.navBtns = new Map();
  for (const nav of NAV) {
    const btn = iconButton({
      icon: nav.icon, label: nav.label, title: `${nav.label} (${nav.key})`, pressed: false,
      onClick: () => selectNav(a, nav.id),
    });
    if (nav.id === 'method') fmt.setAttr(btn, 'data-tour', 'tab-method');
    a.el.navBtns.set(nav.id, btn);
    g4.appendChild(btn);
  }
  bar.appendChild(g4);
  bar.appendChild(h('span', { class: 'toolbar__spacer' }));

  /* -- 5. system ------------------------------------------------------------------------------ */
  const g5 = h('div', { class: 'toolbar__group' });
  a.el.ackBtn = iconButton({
    icon: 'ack', label: 'Acknowledge the highest alarm', onClick: () => ackTopAlarm(a),
  });
  a.el.manualBtn = iconButton({
    icon: 'wrench', label: 'Manual control', pressed: false, onClick: () => toggleManual(a),
    title: 'METHOD: the engine drives the skid. MANUAL: you do — in IDLE, READY, HELD and PAUSED.',
  });
  const scenBtn = iconButton({
    icon: 'flask', label: 'Teaching scenarios',
    title: 'Load one of the teaching scenarios — each starts in one click',
    onClick: () => showScenarios(a),
  });
  const helpBtn = iconButton({
    icon: 'help', label: 'Help, glossary and keyboard shortcuts',
    title: 'Help, the glossary and the shortcut list (?)',
    onClick: () => showHelp(a),
  });
  a.el.themeBtn = iconButton({
    icon: 'theme', label: 'Toggle the light and dark theme', pressed: false,
    onClick: () => toggleTheme(a),
  });
  for (const b of [a.el.ackBtn, a.el.manualBtn, scenBtn, helpBtn, a.el.themeBtn]) g5.appendChild(b);
  bar.appendChild(g5);
  bar.appendChild(toolbarSep());

  /* -- 6. simulation speed, demoted to the quiet end -------------------------------------------
     The chips themselves are behind the button. The LIMITED lamp and the SPD box are NOT: the
     achieved multiplier is an honesty obligation, and an honesty obligation that only shows up
     when you open a popover is not one. */
  const g6 = h('div', {
    class: 'toolbar__group toolbar__group--sim', 'data-tour': 'speed',
    role: 'group', 'aria-label': 'Simulation speed',
  });
  a.el.speedSeg = h('div', {
    class: 'segmented', role: 'radiogroup', 'aria-label': 'Simulation speed multiplier',
  });
  a.el.speedChips = [];
  buildSpeedChips(a);
  a.el.speedPanel = h('div', { class: 'spdpanel' },
    h('span', { class: 'runacts__lbl' }, 'SIMULATION SPEED'),
    h('div', { class: 'spdpanel__row' }, a.el.speedSeg));
  a.el.speedBtn = iconButton({
    icon: 'speed', label: 'Simulation speed', pressed: false,
    title: 'Simulation speed — the multipliers (1 … 7, [ and ])',
    onClick: (e) => openSpeedPanel(a, /** @type {Element} */ (e.currentTarget)),
  });
  fmt.setAttr(a.el.speedBtn, 'aria-haspopup', 'dialog');
  a.el.speedLamp = lamp('Speed limited: no');
  a.el.spdBox = labelBox({ tag: 'SPD', eu: '×', title: 'Achieved simulation speed', narrow: true });
  g6.appendChild(a.el.speedBtn);
  g6.appendChild(a.el.speedLamp);
  g6.appendChild(a.el.spdBox.el);
  bar.appendChild(g6);

  return bar;
}

/**
 * The [more] popover: the two run actions that do not deserve a permanent slot on the first row.
 *
 * Skip keeps its 400 ms press-and-hold ring, so demoting it did not also make it easier to fire by
 * accident, and the hold is cancelled if the popover closes underneath a finger that is still down.
 *
 * @param {object} a the application instance
 * @param {Element} anchorEl the [more] button
 * @returns {void}
 */
function openRunActions(a, anchorEl) {
  if (!a.el.runActions) {
    a.el.runActions = h('div', { class: 'runacts' },
      h('span', { class: 'runacts__lbl' }, 'RUN ACTIONS'),
      h('div', { class: 'runacts__row' }, a.el.skipBtn,
        h('span', { class: 'runacts__lbl' }, 'Skip block (N)')),
      h('div', { class: 'runacts__row' }, a.el.resetBtn,
        h('span', { class: 'runacts__lbl' }, 'Reset (Shift+R)')));
  }
  overlay.showPopover(a.overlayHost, {
    anchorEl,
    content: a.el.runActions,
    placement: 'bottom',
    maxWidth: 240,
    onDismiss: () => { if (a.el.skipCancel) a.el.skipCancel(); },
  });
}

/**
 * The [speed] popover: the seven simulation multipliers. The keyboard reaches them without ever
 * opening this — `1`…`7`, `[` and `]` are global — so the popover is the pointer path only.
 * @param {object} a the application instance
 * @param {Element} anchorEl the [speed] button
 * @returns {void}
 */
function openSpeedPanel(a, anchorEl) {
  overlay.showPopover(a.overlayHost, {
    anchorEl, content: a.el.speedPanel, placement: 'bottom', maxWidth: 320,
  });
}

/**
 * (Re)build the speed chips from `config.sim.speedOptions`, which a different preset may change.
 * These are the one place a numeral is allowed on the face of a control.
 * @param {object} a the application instance
 * @returns {void}
 */
function buildSpeedChips(a) {
  const seg = a.el.speedSeg;
  while (seg.firstChild) seg.removeChild(seg.firstChild);
  a.el.speedChips = [];
  for (const s of a.ctx.config.sim.speedOptions) {
    const chip = button('speedchip', `${s}×`, () => act(a, () => sim.setSpeed(a.ctx, s)), {
      role: 'radio',
      'aria-checked': 'false',
      'aria-label': `Simulation speed ${s} times real time`,
      title: `Run the simulation at ${s}× real time`,
    });
    chip.dataset.speed = String(s);
    a.el.speedChips.push(chip);
    seg.appendChild(chip);
  }
}

/**
 * The Skip Block control: a 400 ms press-and-hold with a filling ring drawn over the glyph, so a
 * fat-fingered click cannot throw away the rest of a block. The ring is advanced by the shell's own
 * frame pass — no panel starts a second rAF loop.
 * @param {object} a the application instance
 * @returns {HTMLButtonElement} the skip button
 */
function buildSkipButton(a) {
  const btn = iconButton({
    icon: 'skip', label: 'Skip the current block', cls: 'btn--hold-to-act',
    title: 'Skip the current block — press and hold for 400 ms (N)',
  });

  const circumference = 2 * Math.PI * RING_R;
  const arc = fmt.hSvg('circle', {
    class: 'holdring__fill', cx: '12', cy: '12', r: String(RING_R), fill: 'none',
    transform: 'rotate(-90 12 12)',
    'stroke-dasharray': String(circumference),
    'stroke-dashoffset': String(circumference),
  });
  btn.appendChild(fmt.hSvg('svg', {
    class: 'holdring', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
  },
  fmt.hSvg('circle', { class: 'holdring__track', cx: '12', cy: '12', r: String(RING_R), fill: 'none' }),
  arc));
  a.el.skipArc = arc;
  a.el.skipArcLength = circumference;

  const start = (ev) => {
    if (btn.disabled) return;
    ev.preventDefault();
    a.skipHold.active = true;
    a.skipHold.start_ms = performance.now();
    if (btn.setPointerCapture && ev.pointerId !== undefined) {
      try { btn.setPointerCapture(ev.pointerId); } catch (_e) { /* not capturable */ }
    }
  };
  const cancel = () => {
    if (!a.skipHold.active) return;
    a.skipHold.active = false;
    fmt.setAttr(a.el.skipArc, 'stroke-dashoffset', String(a.el.skipArcLength));
  };
  // The button lives in a popover now, and a popover can be dismissed out from under a finger that
  // is still down — an outside click, Esc, a focus move. Without this hook the hold would keep
  // filling against an invisible ring and fire a block skip nobody could see coming.
  a.el.skipCancel = cancel;
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('pointerleave', cancel);
  // Keyboard path: a held key has no reliable "still held" signal across layouts, so the keyboard
  // gets the same confirm dialog the `N` shortcut opens. Neither path is a single unguarded click.
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmSkip(a); }
  });
  return btn;
}

/**
 * Band 3 — the FIRST-OUT ALARM BANNER, and the two screen-reader live regions.
 *
 * A band, not a rail. It carries, in one glance and in this order: the severity rail, the blinking
 * lamp, the PRIORITY word, whether this row is the first out (and if not, where it sits in the
 * flurry), the ISA tag, the row's identifier and name, the run-clock time it came in, its
 * ACKNOWLEDGEMENT state, and how many alarms stand behind it — with the condition AND the
 * consequence spelled out in plain language on the second line.
 *
 * One band serves two jobs. An active alarm owns it; when there is none, a caught shell error takes
 * the same slots, so a failure is always visible without a fifth band ever existing.
 *
 * The band is tinted by what it is carrying — `setBandTone` writes one `.banner--*` modifier —
 * because a flat grey rail makes an operator read before they can rank. It is `hidden` when there
 * is nothing to say, and `[hidden]{display:none}` means that costs the workspace nothing at all.
 *
 * @param {object} a the application instance
 * @returns {Element} the alarm band
 */
function buildAlarmBar(a) {
  const bar = h('div', {
    class: 'alarmbar fob', role: 'region', 'aria-label': 'First-out alarm',
  });
  bar.hidden = true;

  a.el.alarmAssertive = h('div', {
    class: 'sr-only', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true',
  });
  a.el.alarmPolite = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  bar.appendChild(a.el.alarmAssertive);
  bar.appendChild(a.el.alarmPolite);

  // A 3 px rail down the leading edge, coloured by `.banner--*` — the tint an operator reads from
  // the corner of the eye before the words resolve.
  bar.appendChild(h('span', { class: 'banner__bar', 'aria-hidden': 'true' }));

  a.el.alarmLamp = lamp('Alarm');
  a.el.alarmSev = h('span', { class: 'banner__sev' }, '');
  a.el.alarmRank = h('span', { class: 'fob__rank' }, '');
  a.el.alarmTag = h('span', { class: 'alarmbar__tag banner__id' }, '');
  a.el.alarmCode = h('span', { class: 'alarmbar__code' }, '');
  a.el.alarmTime = h('span', { class: 'fob__meta' }, '');
  a.el.alarmAckState = h('span', { class: 'fob__ack' }, '');
  a.el.alarmCount = h('span', { class: 'banner__count' }, '');
  a.el.alarmCond = h('span', { class: 'banner__detail' }, '');
  for (const el of [a.el.alarmRank, a.el.alarmTime, a.el.alarmAckState, a.el.alarmCount]) {
    el.hidden = true;
  }

  const top = h('div', { class: 'fob__row' },
    a.el.alarmLamp, a.el.alarmSev, a.el.alarmRank, a.el.alarmTag, a.el.alarmCode,
    h('span', { class: 'fob__gap' }),
    a.el.alarmTime, a.el.alarmAckState, a.el.alarmCount);
  bar.appendChild(h('div', { class: 'fob__body' }, top, a.el.alarmCond));

  const actions = h('div', { class: 'banner__actions' });

  // EVERY control here acts on the row the banner is DISPLAYING, which is not always the row
  // `ackTopAlarm` would pick: the banner holds the FIRST-OUT row, `a.alarm.ackable` the
  // highest-ranked one, and the operator may have stepped to a third. The toolbar's ACK button is
  // the global control and keeps `ackTopAlarm`; these are bound to what the operator can see.
  a.el.alarmAckBtn = iconButton({
    icon: 'ack', label: 'Acknowledge this alarm', sm: true, onClick: () => ackBannerAlarm(a),
  });
  a.el.alarmStepBtn = iconButton({
    icon: 'chevronRight', label: 'Step to the next alarm', sm: true,
    title: 'Step to the next alarm in this flurry, in arrival order (Shift+Down)',
    onClick: () => stepBanner(a),
  });
  a.el.alarmSilenceBtn = iconButton({
    icon: 'cross', label: 'Silence this banner', sm: true,
    title: 'Hide this banner for the session. The alarm stays active and stays logged.',
    onClick: () => silenceBannerAlarm(a),
  });
  a.el.alarmMoreBtn = iconButton({
    icon: 'bell', label: 'Open the alarm list', sm: true,
    title: 'Every alarm standing right now, first out at the top (Shift+A)',
    onClick: () => showAlarmList(a),
  });
  fmt.setAttr(a.el.alarmMoreBtn, 'aria-haspopup', 'dialog');
  a.el.errCopyBtn = iconButton({
    icon: 'copy', label: 'Copy the error detail', sm: true, onClick: () => copyShellError(a),
  });
  a.el.errClearBtn = iconButton({
    icon: 'cross', label: 'Dismiss this error', sm: true, onClick: () => clearShellError(a),
  });
  for (const b of [a.el.alarmAckBtn, a.el.alarmStepBtn, a.el.alarmSilenceBtn, a.el.alarmMoreBtn,
    a.el.errCopyBtn, a.el.errClearBtn]) {
    b.hidden = true;
    actions.appendChild(b);
  }
  bar.appendChild(actions);

  a.el.alarmBar = bar;
  return bar;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ACTIONS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Run a `core/sim.js` action and surface its refusal. Every action returns `{ ok, reason? }`, and a
 * refusal is ALWAYS shown: a silent refusal teaches nothing and gets worked around.
 * @param {object} a the application instance
 * @param {function():{ok:boolean, reason?:string}} fn the action thunk
 * @returns {{ok:boolean, reason?:string}} the action's own result
 */
function act(a, fn) {
  let r;
  try {
    r = fn();
  } catch (err) {
    reportError(a, 'action', err);
    return { ok: false, reason: errText(err) };
  }
  a.structural = true;
  if (!r || typeof r !== 'object') return { ok: true };
  if (!overlay.reportResult(a.overlayHost, r, 'The skid refused that action.')) return r;
  if (r.reason) toast(a, r.reason, 'warn');       // ok:true WITH a reason = partial success
  return r;
}

/**
 * Show a transient message through the overlay host.
 * @param {object} a the application instance
 * @param {string} message the text
 * @param {'info'|'warn'|'blocked'} kind severity of the toast
 * @returns {void}
 */
function toast(a, message, kind) {
  try {
    overlay.showToast(a.overlayHost, { message, kind: kind || 'info' });
  } catch (err) {
    console.warn('toast failed:', message, err);
  }
}

/**
 * Start, or continue from HELD/PAUSED. A pre-run-check refusal opens the full failure list rather
 * than a one-line toast, because all the checks report at once.
 * @param {object} a the application instance
 * @returns {void}
 */
function doStartOrContinue(a) {
  const st = a.ctx.run.state;
  if (st === 'HELD' || st === 'PAUSED') { act(a, () => sim.resume(a.ctx)); return; }
  if (st === 'IDLE') {
    const v = sim.validateAndReady(a.ctx);
    if (!v.ok) { showPreRunFailures(a, v.failures); return; }
  }
  act(a, () => sim.start(a.ctx));
}

/**
 * Render the pre-run check failures as a modal list, blocking failures first. A failure surface, so
 * it is allowed to use words.
 * @param {object} a the application instance
 * @param {Array<{code:string, message:string, acknowledgeable:boolean}>} failures the failures
 * @returns {void}
 */
function showPreRunFailures(a, failures) {
  const blocking = failures.filter((f) => !f.acknowledgeable);
  const advisory = failures.filter((f) => f.acknowledgeable);
  const body = h('div', {},
    h('p', {}, blocking.length > 0
      ? 'The run cannot start until these are fixed:'
      : 'Only advisory checks failed. You may acknowledge them and start anyway.'));
  const ul = h('ul', {});
  for (const f of blocking.concat(advisory)) {
    ul.appendChild(h('li', {}, `${f.code} — ${f.message}${f.acknowledgeable ? ' (advisory)' : ''}`));
  }
  body.appendChild(ul);

  // `showModal` closes nothing by itself: every handler is handed the handle and dismisses it.
  const actions = [{ label: 'Close', variant: 'ghost', onClick: (hd) => overlay.dismiss(hd) }];
  if (blocking.length === 0) {
    actions.unshift({
      label: 'Acknowledge and start',
      variant: 'primary',
      onClick: (hd) => { overlay.dismiss(hd); act(a, () => sim.start(a.ctx)); },
    });
  }
  overlay.showModal(a.overlayHost, {
    title: 'Pre-run checks', content: body, actions, dismissible: true,
  });
}

/**
 * The End confirm popover: end after the current block, or end now. Two icon buttons — the words
 * are in their tooltips.
 * @param {object} a the application instance
 * @param {Element} anchorEl the stop button
 * @returns {void}
 */
function openEndPopover(a, anchorEl) {
  let handle = null;
  const after = iconButton({
    icon: 'clock', label: 'End after the current block',
    title: 'End after the current block — the block finishes and is logged normally',
    onClick: () => { overlay.dismiss(handle); act(a, () => sim.end(a.ctx, 'AFTER_BLOCK')); },
  });
  const now = iconButton({
    icon: 'stop', label: 'End now', danger: true,
    title: 'End now — the current block is cut short at this volume',
    onClick: () => { overlay.dismiss(handle); act(a, () => sim.end(a.ctx, 'NOW')); },
  });
  handle = overlay.showPopover(a.overlayHost, {
    anchorEl, content: h('div', { class: 'btn-row' }, after, now), placement: 'bottom', maxWidth: 200,
  });
}

/**
 * The keyboard path to Skip Block: a confirm dialog where `Enter` confirms.
 * @param {object} a the application instance
 * @returns {void}
 */
function confirmSkip(a) {
  const run = a.ctx.run;
  if (run.state !== 'RUNNING' && run.state !== 'HELD') {
    toast(a, `Blocked: a block can only be skipped while RUNNING or HELD (state is ${run.state}).`, 'blocked');
    return;
  }
  const blocks = a.ctx.config.method ? a.ctx.config.method.blocks : null;
  const b = blocks && blocks[run.blockIndex];
  const body = h('div', {},
    h('p', {}, `Skip ${b ? `${b.id} · ${b.name}` : `block ${run.blockIndex + 1}`} and move on?`),
    h('p', {}, 'The block boundary is flushed and logged exactly as a normal block end is.'));

  let handle = null;
  let settled = false;                 // Enter reaches both the capture listener and the button
  const confirm = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.dismiss(handle);
    act(a, () => sim.skipBlock(a.ctx));
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.dismiss(handle);
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    else if (e.key === 'Escape') cancel();
  };

  handle = overlay.showModal(a.overlayHost, {
    title: 'Skip block',
    content: body,
    actions: [
      { label: 'Skip block (Enter)', variant: 'primary', onClick: confirm },
      { label: 'Cancel', variant: 'ghost', onClick: cancel },
    ],
    dismissible: true,
    onDismiss: cancel,          // the X, the dim and Esc all land here, so the listener never leaks
  });
  document.addEventListener('keydown', onKey, true);
}

/**
 * Pause / resume the process. `Pause` ramps flow to zero; resuming returns to RUNNING.
 * @param {object} a the application instance
 * @returns {void}
 */
function togglePause(a) {
  const st = a.ctx.run.state;
  if (st === 'PAUSED' || st === 'HELD') act(a, () => sim.resume(a.ctx));
  else act(a, () => sim.pause(a.ctx));
}

/**
 * Toggle manual control. Interlocks and the legal-state rule live in `sim`; a refusal is explained
 * by the toast.
 * @param {object} a the application instance
 * @returns {void}
 */
function toggleManual(a) {
  act(a, () => sim.setManualOverride(a.ctx, !a.ctx.run.manualOverride));
}

/**
 * The alarm row the banner is DISPLAYING, resolved from the id `refreshAlarmBar` recorded when it
 * last painted the band. One expression serves the banner's label, its title and its two controls,
 * so what an operator reads and what a press acts on cannot drift apart.
 *
 * Resolving through the live `active` list also means a row that cleared, or was silenced, between
 * the paint and the press is gone by the time the press lands: the press then does nothing rather
 * than acting on a row that is no longer on the band.
 *
 * @param {object} a the application instance
 * @returns {object|null} the displayed `AlarmDef`, or null when the band shows an error or nothing
 */
function bannerAlarm(a) {
  const id = a.bannerAlarmId;
  if (!id) return null;
  const rows = a.alarm.active;
  for (let i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
  return null;
}

/**
 * Acknowledge one alarm row. The single path to `sim.acknowledgeAlarm`, so every caller gets the
 * same refusal handling and the same banner invalidation.
 * @param {object} a the application instance
 * @param {object|null} def the `AlarmDef` to acknowledge
 * @returns {void}
 */
function ackAlarm(a, def) {
  if (!def) return;
  act(a, () => sim.acknowledgeAlarm(a.ctx, def.id));
  a.alarmSig = null;
}

/**
 * Acknowledge the highest-ranked alarm that is waiting for it, silenced or not. This is the TOOLBAR
 * button: it is labelled for the whole alarm set, not for one banner row.
 * @param {object} a the application instance
 * @returns {void}
 */
function ackTopAlarm(a) {
  ackAlarm(a, a.alarm.ackable);
}

/**
 * Acknowledge the alarm the banner is showing — never the highest-ranked one, which may be a row
 * the operator silenced and can no longer see.
 * @param {object} a the application instance
 * @returns {void}
 */
function ackBannerAlarm(a) {
  ackAlarm(a, bannerAlarm(a));
}

/**
 * Hide the banner's own alarm for the session. The alarm stays active and stays logged: silencing
 * changes the screen, never the skid.
 * @param {object} a the application instance
 * @returns {void}
 */
function silenceBannerAlarm(a) {
  const def = bannerAlarm(a);
  if (!def) return;
  a.silenced.add(def.id);
  if (a.bannerPinId === def.id) a.bannerPinId = null;
  a.alarmSig = null;
  toast(a, `${def.id} hidden from the banner. It is still active and still in the event log.`, 'info');
}

/**
 * Put a silenced row back on the banner.
 * @param {object} a the application instance
 * @param {string} id the alarm id
 * @returns {void}
 */
function unsilenceAlarm(a, id) {
  if (!a.silenced.delete(id)) return;
  a.alarmSig = null;
  a.structural = true;
}

/**
 * Where the banner is sitting in the flurry: the index into `a.alarm.order` of the row it should
 * show. Zero — the FIRST OUT — unless the operator stepped off it and the row they stepped to is
 * still standing.
 *
 * Resolving the pin by ID rather than by index every frame is what stops a row clearing underneath
 * the operator from sliding a different alarm under a band they have already read.
 *
 * @param {object} a the application instance
 * @param {Array<object>} rows `a.alarm.order`, arrival-ordered
 * @returns {number} the index to display, always valid for a non-empty `rows`
 */
function bannerIndex(a, rows) {
  if (rows.length === 0) { a.bannerPinId = null; return 0; }
  if (a.bannerPinId) {
    for (let i = 0; i < rows.length; i++) if (rows[i].id === a.bannerPinId) return i;
    a.bannerPinId = null;                     // the pinned row cleared: fall back to the first out
  }
  return 0;
}

/**
 * Step the banner to the next alarm of the flurry, in ARRIVAL order, wrapping back to the first-out
 * row. Arrival order, not severity order, because the sequence is the story: this is what came
 * next after the thing that started it.
 * @param {object} a the application instance
 * @returns {void}
 */
function stepBanner(a) {
  const rows = a.alarm.order;
  if (rows.length < 2) return;
  const next = (bannerIndex(a, rows) + 1) % rows.length;
  a.bannerPinId = next === 0 ? null : rows[next].id;
  a.alarmSig = null;
}

/**
 * The ALARM LIST: every row standing right now, first out at the top, each with its priority, its
 * tag, the condition and the consequence in plain language, the run-clock time it arrived and its
 * acknowledgement state — and an ACK on each row.
 *
 * Silenced rows are listed too, greyed by their SILENCED marker and with the control that puts them
 * back on the band. A list that hid them would let an operator lose an alarm by pressing a button
 * labelled "silence the banner", which is the one thing silencing must never be able to do.
 *
 * @param {object} a the application instance
 * @returns {void}
 */
function showAlarmList(a) {
  const list = h('div', { class: 'almlist' });
  const config = a.ctx.config;

  const render = () => {
    while (list.firstChild) list.removeChild(list.firstChild);
    const rows = a.alarm.all;
    if (rows.length === 0) {
      list.appendChild(h('p', {}, 'No alarm is active or latched. The banner is empty because '
        + 'there is nothing to put on it.'));
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const def = rows[i];
      const acked = a.alarm.acked.has(def.id);
      const silenced = a.silenced.has(def.id);
      const arrival = a.firstOut.at.get(def.id);
      const marks = [
        i === 0 ? 'FIRST OUT' : `#${i + 1}`,
        arrival ? `raised ${fmt.fmtClock(arrival.t_s)}` : 'raised time unknown',
        acked ? 'acknowledged' : 'NOT acknowledged',
      ];
      if (silenced) marks.push('silenced on the banner');

      const row = h('div', { class: 'almlist__row' });
      const lmp = lamp(`${def.severity}: ${def.name}`);
      setLamp(lmp, SEVERITY_LAMP[def.severity] || 'warn', `${def.severity}: ${def.name}`, false);
      row.appendChild(lmp);
      row.appendChild(h('div', { class: 'almlist__txt' },
        h('span', { class: 'almlist__nm' },
          `${SEVERITY_WORD[def.severity] || def.severity} · ${alarmTag(def)} · ${def.id} — ${def.name}`),
        h('span', { class: 'almlist__sub' },
          `${alarmSentence(def, config)}. ${alarmConsequence(def)}`),
        h('span', { class: 'almlist__sub' }, marks.join(' · '))));
      row.appendChild(button('btn btn--ghost btn--sm', acked ? 'Acknowledged' : 'Acknowledge',
        () => { ackAlarm(a, def); refreshShellSafely(a); render(); },
        {
          disabled: acked ? 'disabled' : null,
          title: acked
            ? 'Already acknowledged — it no longer demands its state change.'
            : `Acknowledge ${def.id} — ${def.name}`,
        }));
      if (silenced) {
        row.appendChild(button('btn btn--ghost btn--sm', 'Show on the banner',
          () => { unsilenceAlarm(a, def.id); refreshShellSafely(a); render(); },
          { title: `Put ${def.id} back on the first-out banner` }));
      }
      list.appendChild(row);
    }
  };
  render();

  const entry = glossaryFor('alarm-state');
  const body = h('div', {}, list);
  if (entry) body.appendChild(h('p', { class: 'glossary__typical' }, entry.why));

  overlay.showModal(a.overlayHost, {
    title: 'Alarm list',
    content: body,
    dismissible: true,
    actions: [
      {
        label: 'Alarm table and limits',
        variant: 'ghost',
        onClick: (hd) => { overlay.dismiss(hd); selectNav(a, 'config'); },
      },
      { label: 'Close', variant: 'primary', onClick: (hd) => overlay.dismiss(hd) },
    ],
  });
}

/**
 * Re-derive the alarm picture immediately, outside the frame loop, so a dialog that acted on an
 * alarm can re-render from fresh state instead of showing what was true one frame ago.
 * @param {object} a the application instance
 * @returns {void}
 */
function refreshShellSafely(a) {
  try {
    refreshShell(a, true);
  } catch (err) {
    reportError(a, 'shell', err);
  }
}

/**
 * Step the simulation speed one rung along `config.sim.speedOptions`.
 * @param {object} a the application instance
 * @param {number} dir `+1` for faster, `-1` for slower
 * @returns {void}
 */
function stepSpeed(a, dir) {
  const opts = a.ctx.config.sim.speedOptions;
  const i = opts.indexOf(a.ctx.run.speed);
  const j = Math.max(0, Math.min(opts.length - 1, (i < 0 ? 0 : i) + dir));
  act(a, () => sim.setSpeed(a.ctx, opts[j]));
}

/**
 * Export the loaded method as JSON (`Ctrl+S`). The run's data exports live on the Results screen,
 * which owns the analytics they carry; the method is shell-scoped because it is editable on the
 * Method screen and worth saving from anywhere.
 * @param {object} a the application instance
 * @returns {void}
 */
function exportMethod(a) {
  try {
    const payload = exportMethodJSON(a.ctx.config);
    downloadText(`${a.ctx.config.presetId}_method.json`, JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8');
  } catch (err) {
    toast(a, `Export failed: ${errText(err)}`, 'blocked');
  }
}

/**
 * Open a file picker and install the chosen method JSON through `sim.loadMethod` (`Ctrl+O`).
 * The shell owns this shortcut rather than the Method screen so it works from anywhere.
 * @param {object} a the application instance
 * @returns {void}
 */
function importMethodFile(a) {
  if (!a.fileInput) {
    const input = /** @type {HTMLInputElement} */ (h('input', {
      type: 'file', accept: '.json,application/json', class: 'sr-only',
    }));
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onerror = () => toast(a, 'Could not read that file.', 'blocked');
      reader.onload = () => {
        let parsed = null;
        try {
          parsed = JSON.parse(String(reader.result));
        } catch (err) {
          toast(a, `Not valid JSON: ${errText(err)}`, 'blocked');
          return;
        }
        const res = importMethodJSON(a.ctx.config, parsed);
        if (!res.ok) { toast(a, `Method rejected: ${res.errors.join('; ')}`, 'blocked'); return; }
        const loaded = act(a, () => sim.loadMethod(a.ctx, res.method));
        if (loaded.ok) toast(a, `Method loaded: ${a.ctx.config.method.name || file.name}`, 'info');
      };
      reader.readAsText(file);
      input.value = '';
    });
    a.el.shell.appendChild(input);
    a.fileInput = input;
  }
  a.fileInput.click();
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SCREENS, THEME, HELP
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Act on one of the five navigation buttons. `P&ID` and `TREND` both select the main screen, where
 * the schematic and the trend are co-visible, and publish which pane the operator asked for so the
 * screen can favour it; neither ever hides the other.
 * @param {object} a the application instance
 * @param {string} navId a {@link NAV} id
 * @returns {void}
 */
function selectNav(a, navId) {
  const nav = NAV.find((n) => n.id === navId);
  if (!nav) return;
  a.activeNav = navId;
  setScreen(a, nav.screen);
  if (nav.pane) a.ctx.bus.emit('request-pane', nav.pane);
  refreshNav(a);
}

/**
 * Show one screen. Only the visible screen's `update()` runs, so a hidden one costs nothing.
 * @param {object} a the application instance
 * @param {string} screenId one of the {@link SCREENS} ids
 * @returns {void}
 */
function setScreen(a, screenId) {
  if (!a.screens.has(screenId) || a.activeScreen === screenId) return;
  // The popover is anchored to an element on the screen we are leaving; hiding that host would
  // strand it over the new screen, pointing at nothing.
  closeGlossary(a);
  a.activeScreen = screenId;
  for (const [id, entry] of a.screens) entry.host.hidden = id !== screenId;
  // A newly revealed screen has missed every frame since it was hidden: give it a structural pass.
  a.structural = true;
  a.ctx.bus.emit('screen-changed', screenId);
  a.ctx.bus.emit('tab-changed', screenId);
}

/**
 * Mark the navigation button that is currently showing.
 * @param {object} a the application instance
 * @returns {void}
 */
function refreshNav(a) {
  for (const nav of NAV) {
    const btn = a.el.navBtns.get(nav.id);
    if (!btn) continue;
    const on = nav.screen === a.activeScreen && (!nav.pane || a.activeNav === nav.id);
    fmt.cls(btn, 'is-active', on);
    fmt.setAttr(btn, 'aria-pressed', on ? 'true' : 'false');
  }
}

/**
 * Flip between the graphite panel and the light one, and tell every canvas painter to re-read its
 * tokens. `index.html` stamps an explicit `data-theme` before first paint, so there is no third
 * state to carry here; reading CSS custom properties per frame is a layout-thrash trap.
 * @param {object} a the application instance
 * @returns {void}
 */
function toggleTheme(a) {
  applyTheme(a, a.theme === 'dark' ? 'light' : 'dark', true);
}

/**
 * Apply a theme to the document root and announce it.
 * @param {object} a the application instance
 * @param {'dark'|'light'} theme the chosen theme
 * @param {boolean} announce true to emit `theme-changed` on the bus
 * @returns {void}
 */
function applyTheme(a, theme, announce) {
  a.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', a.theme);
  if (a.el.themeBtn) {
    fmt.setAttr(a.el.themeBtn, 'aria-pressed', a.theme === 'dark' ? 'true' : 'false');
    fmt.setAttr(a.el.themeBtn, 'title', a.theme === 'dark'
      ? 'Graphite panel — switch to the light panel'
      : 'Light panel — switch to graphite');
    fmt.cls(a.el.themeBtn, 'is-active', a.theme === 'dark');
  }
  try {
    fmt.invalidateThemeTokens();
  } catch (_err) { /* the token cache is an optimisation; failing to clear it is not fatal */ }
  if (announce) a.ctx.bus.emit('theme-changed', a.theme);
}

/**
 * Open the glossary popover for a tag or parameter id. A missing entry renders NO info affordance —
 * `glossaryFor` returning null is a contract, not an error.
 * @param {object} a the application instance
 * @param {Element} anchorEl the element the popover points at
 * @param {string} id a P&ID tag, config path, concept id or alias
 * @returns {void}
 */
function showGlossary(a, anchorEl, id) {
  const entry = glossaryFor(id);
  if (!entry) return;
  // ONE glossary popover at a time. The handle used to be discarded, so every tag you touched left
  // its popover pinned to the screen — observed live as a 213 px paragraph stranded over the trend.
  // On an HMI whose whole premise is "almost no text", a leaked block of prose is a real defect.
  closeGlossary(a);
  a.glossaryHandle = overlay.showGlossaryPopover(a.overlayHost, {
    anchorEl,
    entry,
    placement: 'top',
    onSeeAlso: (nextId) => showGlossary(a, anchorEl, nextId),
    onDismiss: () => { a.glossaryHandle = null; },
  });
}

/**
 * Dismiss the open glossary popover, if any. Idempotent, and safe to call when the overlay layer
 * has already torn the popover down on its own (Esc, outside click, host destroy).
 * @param {object} a the application instance
 * @returns {void}
 */
function closeGlossary(a) {
  if (!a.glossaryHandle) return;
  const handle = a.glossaryHandle;
  a.glossaryHandle = null;
  try { overlay.dismiss(handle); } catch (_err) { /* already gone; nothing to do */ }
}

/**
 * The quality lamp's popover: every `run.qualityFlags` bit currently set, and the per-sensor verdict
 * behind them. This is where the verdict the lamp summarises in one colour is spelled out in words.
 * @param {object} a the application instance
 * @param {Element} anchorEl the lamp's button
 * @returns {void}
 */
function showQualityPopover(a, anchorEl) {
  const run = a.ctx.run;
  const body = h('div', { class: 'glossary' }, h('strong', {}, 'Data quality'));
  const ul = h('ul', {});
  for (const sensor of QUALITY_SENSORS) {
    ul.appendChild(h('li', {}, `${sensor}: ${sensorQuality(run, sensor)}`));
  }
  body.appendChild(ul);

  const set = QF_LABELS.filter(([bit]) => (run.qualityFlags & bit) !== 0);
  if (set.length === 0) {
    body.appendChild(h('p', {}, 'No quality flags are set: every sensor is reporting normally.'));
  } else {
    const flags = h('ul', {});
    for (const [, label] of set) flags.appendChild(h('li', {}, label));
    body.appendChild(flags);
  }
  const g = glossaryFor('quality-flags');
  if (g) body.appendChild(h('p', { class: 'glossary__typical' }, g.why));
  overlay.showPopover(a.overlayHost, { anchorEl, content: body, placement: 'top', maxWidth: 340 });
}

/**
 * The unit name's popover: what the model does, and what it deliberately does not.
 * @param {object} a the application instance
 * @returns {Element} the popover body
 */
function honestyContent(a) {
  const cfg = a.ctx.config;
  return h('div', { class: 'glossary' },
    h('strong', {}, 'This is a simulation, not an instrument'),
    h('p', {}, 'A one-dimensional packed bed with axial dispersion, film and pore mass transfer and '
      + `a ${cfg.column.isothermMode} isotherm. The sensors carry real noise, drift, filtering and `
      + 'delay volumes, so they lie in the ways real sensors lie.'),
    h('p', {}, 'Deliberately absent: radial gradients, per-cell protein charge, replay and '
      + 'scrubbing, and any network or cloud component. The numbers are physically consistent; they '
      + 'are not a substitute for a qualified run.'),
    h('p', { class: 'glossary__typical' },
      `${cfg.presetId} · ${cfg.scale} · seed ${cfg.seed} · grid nz=${cfg.column.nz}`
      + `${a.benchmark ? ` · ${a.benchmark.msPerSimSecond.toFixed(2)} ms per simulated second` : ''}`));
}

/**
 * Open the teaching-scenario picker.
 * @param {object} a the application instance
 * @returns {void}
 */
function showScenarios(a) {
  if (a.onboarding) { onboarding.showScenarioPicker(a.onboarding); return; }

  const rows = presets.SCENARIOS || {};
  const ids = Object.keys(rows);
  const list = h('div', { class: 'btn-row' });
  let handle = null;
  for (const id of ids) {
    const s = rows[id];
    list.appendChild(button('btn btn--ghost btn--sm', (s && s.name) || id, () => {
      overlay.dismiss(handle);
      act(a, () => sim.loadScenario(a.ctx, id));
    }, { title: (s && s.teaches) || id }));
  }
  handle = overlay.showModal(a.overlayHost, {
    title: 'Teaching scenarios',
    content: ids.length ? list : h('p', {}, 'This preset library declares no scenarios.'),
    dismissible: true,
    actions: [{ label: 'Close', variant: 'primary', onClick: (hd) => overlay.dismiss(hd) }],
  });
}

/**
 * The Help modal: the ways into the app, and a searchable index of the whole glossary.
 * Every word of definition comes from `data/glossary.js`; this function contributes the search box
 * and the layout only.
 * @param {object} a the application instance
 * @returns {void}
 */
function showHelp(a) {
  const ids = Object.keys(GLOSSARY);
  const list = h('div', { class: 'btn-row' });
  const detail = h('div', { class: 'glossary' });

  const showEntry = (id) => {
    const entry = GLOSSARY[id];
    while (detail.firstChild) detail.removeChild(detail.firstChild);
    if (!entry) return;
    detail.appendChild(h('strong', {}, entry.term));
    detail.appendChild(h('p', {}, entry.short));
    detail.appendChild(h('p', {}, entry.why));
    detail.appendChild(h('p', { class: 'glossary__typical' }, entry.typical));
  };

  const render = (needle) => {
    const q = needle.trim().toLowerCase();
    const hits = [];
    for (const id of ids) {
      const e = GLOSSARY[id];
      if (q === '' || id.toLowerCase().indexOf(q) >= 0
        || e.term.toLowerCase().indexOf(q) >= 0 || e.short.toLowerCase().indexOf(q) >= 0) {
        hits.push(id);
      }
      if (hits.length >= 30) break;
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const id of hits) {
      list.appendChild(button('btn btn--ghost btn--sm', GLOSSARY[id].term, () => showEntry(id)));
    }
    if (hits.length === 0) list.appendChild(h('p', { class: 'field__hint' }, 'No matches.'));
  };

  const search = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text', class: 'numfield__input', placeholder: 'Search the glossary…',
    'aria-label': 'Search the glossary',
  }));
  search.addEventListener('input', () => render(search.value));

  const body = h('div', {},
    h('p', {}, `${ids.length} entries cover every instrument tag, every configurable parameter and `
      + 'every concept the simulator models. The same text is behind every label box on screen.'),
    h('div', { class: 'numfield' }, search),
    list,
    detail);
  render('');

  const actions = [];
  if (a.onboarding) {
    actions.push({
      label: 'Take the tour',
      variant: 'ghost',
      onClick: (hd) => { overlay.dismiss(hd); onboarding.startTour(a.onboarding); },
    });
  }
  actions.push({
    label: 'Keyboard shortcuts',
    variant: 'ghost',
    onClick: (hd) => { overlay.dismiss(hd); overlay.showCheatSheet(a.overlayHost, KEYMAP); },
  });
  if (a.onboarding) {
    actions.push({
      label: hintsOn(a) ? 'Turn coach hints off' : 'Turn coach hints on',
      variant: 'ghost',
      onClick: (hd) => {
        overlay.dismiss(hd);
        if (!a.onboarding) return;
        a.onboarding.hintsEnabled = !a.onboarding.hintsEnabled;
        toast(a, a.onboarding.hintsEnabled
          ? 'Coach hints on — at most one card every 20 seconds, never blocking.'
          : 'Coach hints off for this session.', 'info');
      },
    });
  }
  actions.push({ label: 'Close', variant: 'primary', onClick: (hd) => overlay.dismiss(hd) });

  overlay.showModal(a.overlayHost, {
    title: 'Help and glossary', content: body, dismissible: true, actions,
  });
}

/**
 * @param {object} a the application instance
 * @returns {boolean} whether the coach-hint scheduler is currently armed
 */
function hintsOn(a) {
  return !!(a.onboarding && a.onboarding.hintsEnabled);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * BUS, KEYBOARD, RESPONSIVE
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Subscribe the shell to the bus. Every derived value keyed on `config` is dropped on
 * `config-replaced`, and the startup benchmark is re-run on `preset-loaded`.
 * @param {object} a the application instance
 * @returns {void}
 */
function wireBus(a) {
  const bus = a.ctx.bus;
  const invalidate = () => {
    a.demandCache = null;
    a.progressPct = -1;
    a.alarmSig = null;
    a.liveAlarmId = null;
    a.silenced.clear();
    // A new run is a new flurry: the first alarm of it must be the first-out, never a survivor of
    // the ordering the previous run left behind.
    a.firstOut.at.clear();
    a.firstOut.seq = 0;
    a.bannerPinId = null;
    a.lastEventCount = a.ctx.run.events ? a.ctx.run.events.length : 0;
    a.simFailed = false;
    a.structural = true;
    if (a.el.speedChips.length !== a.ctx.config.sim.speedOptions.length) buildSpeedChips(a);
  };
  bus.on('config-replaced', invalidate);
  bus.on('run-reset', invalidate);
  bus.on('preset-loaded', () => {
    invalidate();
    runStartupBenchmark(a);
    invalidate();
  });
  bus.on('scenario-applied', () => selectNav(a, 'pid'));
  bus.on('run-ended', () => { a.structural = true; });
  bus.on('request-tab', (tabId) => {
    const navId = LEGACY_NAV[String(tabId)];
    if (navId) selectNav(a, navId);
  });
  bus.on('show-glossary', (payload) => {
    if (payload && payload.anchorEl && payload.id) showGlossary(a, payload.anchorEl, payload.id);
  });
  // The shell carries no engineering-unit suffix of its own any more — the value strip that did is
  // gone — so a unit change only has to force the panels a structural frame.
  bus.on('display-units-changed', () => { a.structural = true; });
}

/**
 * Install the one document-level key handler. Shell actions execute here; panel actions go out on
 * the bus as `('key-action', { action, combo, event })`, so no second listener is ever needed.
 * @param {object} a the application instance
 * @returns {void}
 */
function wireKeyboard(a) {
  document.addEventListener('keydown', (e) => {
    // A control that already consumed the key (a splitter's arrows, a numfield's stepper, an open
    // dialog) wins: the global registry never double-handles.
    if (e.defaultPrevented) return;
    const combo = normaliseCombo(e);
    const entry = KEYMAP[combo];
    if (!entry) return;
    if (typingInField() && combo !== 'Escape') return;
    if (handleKeyAction(a, entry.action, e, combo)) e.preventDefault();
  });
}

/**
 * Execute one keymap action.
 * @param {object} a the application instance
 * @param {string} action the action id from `KEYMAP`
 * @param {KeyboardEvent} e the originating event
 * @param {string} combo the normalised combo, forwarded to the panels
 * @returns {boolean} true when the event was consumed and should be prevented
 */
function handleKeyAction(a, action, e, combo) {
  const run = a.ctx.run;
  if (action.startsWith('nav:')) { selectNav(a, action.slice(4)); return true; }
  if (action.startsWith('speed:')) {
    const opts = a.ctx.config.sim.speedOptions;
    const i = Number(action.slice(6));
    if (i >= 0 && i < opts.length) act(a, () => sim.setSpeed(a.ctx, opts[i]));
    return true;
  }
  switch (action) {
    case 'start-hold-toggle':
      if (run.state === 'RUNNING') act(a, () => sim.hold(a.ctx));
      else doStartOrContinue(a);
      return true;
    case 'start-run': doStartOrContinue(a); return true;
    case 'hold': act(a, () => sim.hold(a.ctx)); return true;
    case 'continue': act(a, () => sim.resume(a.ctx)); return true;
    // Skip and reset sit behind [more] on the toolbar. Both keep a shortcut that reaches the action
    // itself, not the menu, so demoting them cost a pointer user one click and a keyboard user
    // nothing at all.
    case 'skip-block': confirmSkip(a); return true;
    case 'reset': act(a, () => sim.reset(a.ctx)); return true;
    case 'end-run': openEndPopover(a, a.el.stopBtn); return true;
    case 'pause-toggle': togglePause(a); return true;
    case 'alarm-list': showAlarmList(a); return true;
    case 'ack-banner': ackBannerAlarm(a); return true;
    case 'alarm-next': stepBanner(a); return true;
    case 'estop': {
      const now = performance.now();
      if (a.estopArm_ms > 0 && now - a.estopArm_ms < ESTOP_DOUBLE_MS) {
        a.estopArm_ms = 0;
        act(a, () => sim.estop(a.ctx));
      } else {
        a.estopArm_ms = now;
        toast(a, 'Press Shift+Esc again within 1 second to trigger the emergency stop.', 'warn');
      }
      return true;
    }
    case 'speed-up': stepSpeed(a, +1); return true;
    case 'speed-down': stepSpeed(a, -1); return true;
    case 'mark-fraction': act(a, () => sim.markFraction(a.ctx)); return true;
    case 'cheat-sheet': overlay.showCheatSheet(a.overlayHost, KEYMAP); return true;
    case 'export-method': exportMethod(a); return true;
    case 'import-method': importMethodFile(a); return true;
    case 'perf-overlay':
      a.perfOn = !a.perfOn;
      a.el.perf.hidden = !a.perfOn;
      a.perfRows = null;
      return true;
    case 'dismiss':
      a.ctx.bus.emit('key-action', { action, combo, event: e });
      return false;                     // the overlay host's own capture-phase Esc handling runs too
    default:
      // The trend, its pen rail and the pooling tools live in the panels; they own these.
      a.ctx.bus.emit('key-action', { action, combo, event: e });
      return true;
  }
}

/**
 * Flag a narrow viewport on the shell so `styles/app.css` can reflow the bands, without ever
 * reading layout in a frame.
 * @param {object} a the application instance
 * @returns {void}
 */
function wireResponsive(a) {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(max-width: 899.98px)');
  const apply = () => fmt.cls(a.el.shell, 'is-narrow', mq.matches);
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else if (mq.addListener) mq.addListener(apply);
  apply();
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FRAME LOOP — the ONLY requestAnimationFrame in the program
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * One animation frame: advance the physics by the real elapsed time, then render the visible screen.
 *
 * Rendering is decoupled from the fixed-timestep sim: `sim.advanceWall` runs whole 0.05 s ticks and
 * drops any debt it cannot pay, reporting the shortfall through `run.speedDeficit`. Both halves are
 * guarded — a throwing panel is reported and, after three consecutive failures, taken out of the
 * loop, but the loop itself never stops.
 *
 * A visible frame repaints the shell, the ACTIVE screen and EVERY open faceplate. Faceplates are
 * modeless windows that outlive a screen change, so they are driven from here rather than from the
 * panel that opened them.
 *
 * `document.hidden` pauses RENDERING only; the simulation keeps running, and the 0.25 s wall clamp
 * inside `advanceWall` stops a backgrounded tab from fast-forwarding.
 *
 * @param {number} now_ms the `requestAnimationFrame` timestamp, milliseconds
 * @returns {void}
 */
export function frame(now_ms) {
  const a = app;
  if (!a) return;
  a.rafId = requestAnimationFrame(frame);

  const dt_ms = a.tPrev === 0 ? 16.7 : Math.max(0, now_ms - a.tPrev);
  a.tPrev = now_ms;
  const wallDt_s = Math.min(dt_ms / 1000, WALL_CLAMP_S);

  // ---- physics -------------------------------------------------------------------------------
  let ticks = 0;
  const tSim0 = performance.now();
  if (!a.simFailed) {
    try {
      ticks = sim.advanceWall(a.ctx, wallDt_s);
    } catch (err) {
      a.simFailed = true;
      reportError(a, 'simulation', err);
    }
  }
  const tSim1 = performance.now();

  // ---- events: one central drain feeds onboarding and the structural flag ---------------------
  drainEvents(a);

  // ---- render --------------------------------------------------------------------------------
  const info = a.frameInfo;
  info.now_ms = now_ms;
  info.dt_ms = dt_ms;
  info.tick = a.ctx.run.tick;
  info.structural = a.structural;

  const tR0 = performance.now();
  if (document.visibilityState !== 'hidden') {
    try {
      refreshShell(a, info.structural);
    } catch (err) {
      reportError(a, 'shell', err);
    }
    const entry = a.screens.get(a.activeScreen);
    if (entry && entry.panel && !entry.disabled) {
      try {
        entry.panel.update(info);
        entry.failCount = 0;
      } catch (err) {
        entry.failCount++;
        reportError(a, `${a.activeScreen} screen`, err);
        if (entry.failCount >= PANEL_FAIL_LIMIT) {
          entry.disabled = true;
          toast(a, `The ${a.activeScreen} screen was disabled after ${PANEL_FAIL_LIMIT} errors. `
            + 'Switch screens and back to retry.', 'blocked');
        }
      }
    }
    // Faceplates are MODELESS: one opened from the P&ID stays up while the operator changes
    // screens, so it is repainted from the loop and never from the panel that opened it — gating
    // this on `a.activeScreen` would freeze PV, SP, mode and quality the moment the operator
    // navigated away. `overlay.updateFaceplates` already guards each faceplate's own `read()`;
    // this catch takes a spec that breaks outside it, and reports one distinct failure at most so
    // a faceplate that throws every frame cannot flood the band or the console.
    try {
      overlay.updateFaceplates(a.overlayHost, a.ctx.config, a.ctx.run);
      a.faceplateFail = '';
    } catch (err) {
      const msg = errText(err);
      if (msg !== a.faceplateFail) {
        a.faceplateFail = msg;
        reportError(a, 'faceplate', err);
      }
    }
    if (a.onboarding && typeof a.onboarding.update === 'function') {
      try {
        a.onboarding.update(info);
      } catch (err) {
        reportError(a, 'onboarding', err);
      }
    }
    // Cleared only when a render actually happened: a structural change that lands while the tab is
    // backgrounded must still reach the panels on the first visible frame.
    a.structural = false;
  }
  const tR1 = performance.now();

  // ---- perf accounting -----------------------------------------------------------------------
  const p = a.perf;
  p.frame_ms += (dt_ms - p.frame_ms) * 0.1;
  p.sim_ms += ((tSim1 - tSim0) - p.sim_ms) * 0.1;
  p.render_ms += ((tR1 - tR0) - p.render_ms) * 0.1;
  p.ticks = ticks;
  p.tAcc += dt_ms;
  p.nAcc += ticks;
  if (p.tAcc >= 500) { p.tps = p.nAcc * 1000 / p.tAcc; p.tAcc = 0; p.nAcc = 0; }
  if (a.perfOn && document.visibilityState !== 'hidden') renderPerf(a);
}

/**
 * Consume every event appended to `run.events` since the last frame: stamp the arrival of any alarm
 * that was raised, feed the coach-hint scheduler, and raise the `structural` flag when list content
 * changed.
 *
 * The alarm stamp is taken HERE and not in `collectAlarms` because this drain runs on every frame
 * while the render does not: a tab in the background still advances the simulation, and an alarm
 * that arrived there must carry the run-clock time it actually arrived, not the time of the first
 * frame that happened to look.
 *
 * @param {object} a the application instance
 * @returns {void}
 */
function drainEvents(a) {
  const events = a.ctx.run.events;
  if (!events) { a.lastEventCount = 0; return; }
  const n = events.length;
  if (n < a.lastEventCount) a.lastEventCount = 0;      // the run was replaced
  for (let i = a.lastEventCount; i < n; i++) {
    const ev = events[i];
    if (STRUCTURAL_EVENT_TYPES[ev.type]) a.structural = true;
    if (ev.type === 'ALARM_RAISED') noteAlarmArrival(a, alarmIdOfEvent(ev), ev.t_s);
    if (a.onboarding) {
      try {
        onboarding.noteEvent(a.onboarding, ev);
      } catch (err) {
        reportError(a, 'onboarding', err);
      }
    }
  }
  a.lastEventCount = n;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SHELL RENDER — text, classes and attributes onto cached nodes; no innerHTML, no layout reads
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Repaint the persistent chrome from the current `run`. Called once per visible frame.
 * @param {object} a the application instance
 * @param {boolean} structural true when list content may have changed
 * @returns {void}
 */
function refreshShell(a, structural) {
  const { config, run } = a.ctx;
  if (structural) a.alarmSig = null;
  collectAlarms(a, config, run);
  refreshTitleBar(a, config, run);
  refreshToolbar(a, config, run);
  refreshAlarmBar(a);
  if (a.skipHold.active) advanceSkipHold(a);
}

/**
 * Record the moment an alarm joined the current flurry. Idempotent: the FIRST stamp wins, which is
 * the whole point — a row that keeps re-evaluating must not keep resetting its own arrival.
 * @param {object} a the application instance
 * @param {string} id the alarm id
 * @param {number} t_s the run clock at arrival, seconds
 * @returns {void}
 */
function noteAlarmArrival(a, id, t_s) {
  if (!id || a.firstOut.at.has(id)) return;
  a.firstOut.seq += 1;
  a.firstOut.at.set(id, { seq: a.firstOut.seq, t_s, wall_ms: Date.now() });
}

/**
 * The arrival order of a row, or a value that sorts last for a row with no stamp.
 * @param {object} a the application instance
 * @param {string} id the alarm id
 * @returns {number} the arrival sequence number
 */
function arrivalSeq(a, id) {
  const rec = a.firstOut.at.get(id);
  return rec ? rec.seq : Number.MAX_SAFE_INTEGER;
}

/**
 * The alarm id an `ALARM_RAISED` event names. `skid/alarms.js` logs `` `${def.id} ${def.name}` ``
 * and no id contains a space, so the first token is the id.
 * @param {{message?:string}} ev the event record
 * @returns {string} the id, or `''`
 */
function alarmIdOfEvent(ev) {
  const m = String((ev && ev.message) || '');
  const sp = m.indexOf(' ');
  return sp > 0 ? m.slice(0, sp) : m;
}

/**
 * Fill `a.alarm` with this frame's alarm picture: the count and the per-severity tallies over EVERY
 * raised row, the signal names in alarm (which redden the status boxes), which rows are already
 * acknowledged, the first row waiting to be acknowledged, and TWO lists — `active`, ranked by
 * severity, and `order`, the same rows in the order they ARRIVED, which is what the first-out
 * banner walks.
 *
 * It also maintains the flurry itself. A raised row with no arrival stamp gets one here — that
 * covers a row raised while the tab was backgrounded and a run rehydrated from a snapshot — and a
 * row that has stopped being raised loses its stamp. When the last stamp goes, the sequence resets:
 * the next alarm to arrive starts a NEW first-out story instead of inheriting the last one's.
 *
 * Silencing is a SCREEN act, never a process act: a silenced row is kept out of `active`/`order` —
 * the banner — but stays in `all`, still counts, still lights its summary lamp and can still be
 * acknowledged, so nothing an operator does to the banner can hide the fact that it is standing.
 *
 * Buffers are reused, so a frame allocates nothing here beyond a stamp for a genuinely new row.
 *
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function collectAlarms(a, config, run) {
  const defs = config.alarms || [];
  const out = a.alarm;
  out.active.length = 0;
  out.order.length = 0;
  out.all.length = 0;
  out.signals.clear();
  out.evals.clear();
  out.raised.clear();
  out.acked.clear();
  out.count = 0;
  out.crit = 0;
  out.alarms = 0;
  out.warns = 0;
  out.worst = '';
  out.ackable = null;

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const raised = run.alarmActive[i] === 1
      || (run.alarmLatched[i] === 1 && run.alarmAcked[i] !== 1);
    if (!raised) continue;
    const rank = SEVERITY_RANK[def.severity] || 0;
    out.count++;
    out.raised.add(def.id);
    if (run.alarmAcked[i] === 1) out.acked.add(def.id);
    if (rank >= SEVERITY_RANK.CRITICAL) out.crit++;
    else if (rank === SEVERITY_RANK.ALARM) out.alarms++;
    else out.warns++;
    if (def.signal) out.signals.add(def.signal);
    if (def.evalKey) out.evals.add(def.evalKey);
    if (!out.worst || rank > (SEVERITY_RANK[out.worst] || 0)) out.worst = def.severity;
    if ((def.ackRequired || def.latching)
      && (!out.ackable || rank > (SEVERITY_RANK[out.ackable.severity] || 0))) out.ackable = def;
    noteAlarmArrival(a, def.id, run.t_s);
    out.all.push(def);
    if (!a.silenced.has(def.id)) { out.active.push(def); out.order.push(def); }
  }

  // The flurry is only the rows standing NOW. Deleting during iteration is defined for a Map.
  const at = a.firstOut.at;
  for (const id of at.keys()) if (!out.raised.has(id)) at.delete(id);
  if (at.size === 0) a.firstOut.seq = 0;

  out.active.sort((x, y) => (SEVERITY_RANK[y.severity] || 0) - (SEVERITY_RANK[x.severity] || 0));
  out.order.sort((x, y) => arrivalSeq(a, x.id) - arrivalSeq(a, y.id));
  out.all.sort((x, y) => arrivalSeq(a, x.id) - arrivalSeq(a, y.id));
}

/**
 * Repaint the title strip — unit, block counter, clock, progress — and the three PROCESS STATUS
 * indications the toolbar now carries. One function, because the strip and the status group are one
 * derivation of one `run` and splitting them would let them disagree by a frame.
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshTitleBar(a, config, run) {
  const el = a.el;
  fmt.setText(el.unitName, String(config.name || config.presetId).toUpperCase());

  const blocks = config.method ? config.method.blocks : null;
  if (blocks && blocks.length > 0) {
    const i = Math.max(0, Math.min(blocks.length - 1, run.blockIndex));
    const b = blocks[i];
    const prog = blockProgress(config, run);
    const pct = Number.isFinite(prog.fraction) ? Math.round(prog.fraction * 100) : 0;
    setBox(el.blkBox, `${i + 1}/${blocks.length}`, '');
    fmt.setAttr(el.blkBox.el, 'title', `${b.id} · ${b.name || b.type} — ${pct} % delivered, `
      + `${fmt.fmtVolume(prog.remaining_mL, config)} remaining`);
  } else {
    setBox(el.blkBox, fmt.NO_VALUE, '');
    fmt.setAttr(el.blkBox.el, 'title', 'No method is loaded');
  }

  setBox(el.clkBox, fmt.fmtClock(run.t_s), '');

  const pct = Math.round(methodFraction(a, config, run) * 100);
  if (a.progressPct !== pct) {                 // a style write per frame is a style invalidation
    a.progressPct = pct;
    el.progressFill.style.width = `${pct}%`;
    fmt.setAttr(el.progressTrack, 'aria-valuenow', String(pct));
    fmt.setAttr(el.progressTrack, 'aria-valuetext',
      `${pct} % of the method, ${(run.V_tot_mL / config.column.V_mL).toFixed(2)} column volumes delivered`);
  }

  refreshStatusIndication(a, run);

  // Counted over every raised row, silenced ones included: a summary lamp that a silenced banner
  // could switch off would be a lie.
  const { crit, alarms, warns } = a.alarm;
  setLamp(el.lampCrit, crit > 0 ? 'alarm' : 'off',
    crit > 0 ? `Critical alarms: ${crit}` : 'Critical alarms: none', crit > 0);
  setLamp(el.lampAlarm, alarms > 0 ? 'alarm' : 'off',
    alarms > 0 ? `Alarms: ${alarms}` : 'Alarms: none', false);
  setLamp(el.lampWarn, warns > 0 ? 'warn' : 'off',
    warns > 0 ? `Warnings: ${warns}` : 'Warnings: none', false);
  setBox(el.almBox, String(a.alarm.count), '');
  setBoxState(el.almBox, a.alarm.count > 0, false);
  // Named explicitly, for the same reason the quality chip is: name-from-content over a box whose
  // only text is `ALM` and a numeral announces "ALM 3", which is not what an operator needs to hear.
  // ONE string, so the hover text and the screen-reader text cannot disagree.
  const almText = `${a.alarm.count === 0
    ? 'No alarm is active'
    : `${a.alarm.count} alarm${a.alarm.count === 1 ? '' : 's'} active, worst ${a.alarm.worst}`
  }. Press for the alarm list (Shift+A).`;
  fmt.setAttr(el.almBox.el, 'title', almText);
  fmt.setAttr(el.almBox.el, 'aria-label', almText);
}

/**
 * Repaint the toolbar: transport availability, the speed chips, the honest speed readout, the
 * manual-mode toggle and the acknowledge button.
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshToolbar(a, config, run) {
  const el = a.el;
  const st = run.state;
  const held = st === 'HELD' || st === 'PAUSED';

  setEnabled(el.runBtn, st === 'IDLE' || st === 'READY',
    held ? 'Already started — use Continue.' : `Cannot start from ${st}.`,
    'Run the pre-run checks and start (Space)');
  setEnabled(el.holdBtn, st === 'RUNNING',
    `Hold is only available while RUNNING (state is ${st}).`,
    'Freeze the method; flow stays at setpoint (H)');
  setEnabled(el.contBtn, held,
    `Continue is only available from HELD or PAUSED (state is ${st}).`,
    'Return to RUNNING (C)');
  const skippable = st === 'RUNNING' || st === 'HELD';
  setEnabled(el.skipBtn, skippable,
    `A block can only be skipped while RUNNING or HELD (state is ${st}).`,
    'Skip the current block — press and hold for 400 ms (N)');
  setEnabled(el.stopBtn, st === 'RUNNING' || st === 'HELD' || st === 'PAUSED' || st === 'ALARM',
    `Cannot end from ${st}.`, 'End now, or after the current block (E)');
  // At run end the transport collapses to Reset: replay and scrubbing do not exist, so there is no
  // post-run cursor. The Results screen is the only post-run surface.
  const resettable = st === 'ENDED' || st === 'FAULT' || st === 'READY';
  setEnabled(el.resetBtn, resettable,
    `Reset is available from READY, ENDED and FAULT (state is ${st}).`,
    'Return to IDLE and rebuild the fluid path (Shift+R)');

  for (const chip of el.speedChips) {
    const on = Number(chip.dataset.speed) === run.speed;
    fmt.cls(chip, 'is-active', on);
    fmt.setAttr(chip, 'aria-checked', on ? 'true' : 'false');
  }

  const paused = st === 'PAUSED' || st === 'HELD';
  fmt.setAttr(el.pauseBtn, 'aria-pressed', paused ? 'true' : 'false');
  fmt.setAttr(el.pauseBtn, 'aria-label', paused ? 'Resume the simulation' : 'Pause the simulation');
  fmt.cls(el.pauseBtn, 'is-active', paused);
  setEnabled(el.pauseBtn, st === 'RUNNING' || paused,
    `Nothing is running to pause (state is ${st}).`,
    paused ? 'Return to RUNNING (P)' : 'Ramp flow to zero and freeze the clock (P)');

  // The [more] button is enabled whenever either action behind it is: a menu that opens onto two
  // dead controls is worse than a disabled menu, and one that refuses while an action is legal is
  // worse still.
  setEnabled(el.moreBtn, resettable || skippable,
    `Neither skip nor reset is available from ${st}.`,
    'Skip block and reset (N, Shift+R)');

  // The honesty readout — never claim a speed the machine is not delivering. It stays on the
  // toolbar even though the multipliers moved into the popover, because a deficit an operator has
  // to open a popover to discover is a deficit they will not discover.
  const limited = run.speedDeficit > 1.01 && st === 'RUNNING';
  const achieved = limited ? run.speed / run.speedDeficit : run.speed;
  setBox(el.spdBox, formatSpeed(achieved), '×');
  setBoxState(el.spdBox, false, limited);
  setLamp(el.speedLamp, limited ? 'warn' : 'off',
    limited
      ? `Speed limited: asking for ${run.speed}×, achieving ${formatSpeed(achieved)}×`
      : 'Speed limited: no', false);
  fmt.setAttr(el.spdBox.el, 'title', limited
    ? 'This machine cannot keep up with the requested speed. Effective speed is '
      + 'run.speed / run.speedDeficit; a coarser column grid buys it back.'
    : 'Simulated seconds per real second');

  // The [speed] button carries the requested multiplier in its accessible name and wears
  // `.is-active` whenever the simulation is NOT at real time, so a screen running at 1000× says so
  // without the chips being on the row.
  const offRealTime = run.speed !== 1;
  fmt.cls(el.speedBtn, 'is-active', offRealTime);
  fmt.setAttr(el.speedBtn, 'aria-pressed', offRealTime ? 'true' : 'false');
  fmt.setAttr(el.speedBtn, 'aria-label', `Simulation speed, ${run.speed} times real time`);
  fmt.setAttr(el.speedBtn, 'title', limited
    ? `Simulation speed: ${run.speed}× requested, ${formatSpeed(achieved)}× achieved. `
      + 'Press for the multipliers (1 … 7, [ and ]).'
    : `Simulation speed: ${run.speed}× real time. Press for the multipliers (1 … 7, [ and ]).`);

  const manual = !!run.manualOverride;
  fmt.cls(el.manualBtn, 'is-active', manual);
  fmt.setAttr(el.manualBtn, 'aria-pressed', manual ? 'true' : 'false');
  fmt.setAttr(el.manualBtn, 'aria-label', manual ? 'Manual control is ON' : 'Manual control is OFF');
  fmt.cls(el.shell, 'is-manual', manual);

  const ackable = a.alarm.ackable;
  setEnabled(el.ackBtn, !!ackable,
    'No alarm is waiting to be acknowledged.',
    ackable ? `Acknowledge ${ackable.id} — ${ackable.name}` : 'Acknowledge the highest alarm');
}

/**
 * Advance the Skip Block hold ring and fire the skip once the 400 ms threshold is crossed.
 * @param {object} a the application instance
 * @returns {void}
 */
function advanceSkipHold(a) {
  const p = Math.min(1, (performance.now() - a.skipHold.start_ms) / SKIP_HOLD_MS);
  fmt.setAttr(a.el.skipArc, 'stroke-dashoffset', String(a.el.skipArcLength * (1 - p)));
  if (p >= 1) {
    a.skipHold.active = false;
    fmt.setAttr(a.el.skipArc, 'stroke-dashoffset', String(a.el.skipArcLength));
    act(a, () => sim.skipBlock(a.ctx));
  }
}

/**
 * Overall method progress as a fraction, weighted by block VOLUME so the title strip's bar agrees
 * with the phase rail. `methodDemand` is cached per `config` and dropped on `config-replaced`.
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {number} 0..1
 */
function methodFraction(a, config, run) {
  if (!config.method || !Array.isArray(config.method.blocks)) return 0;
  if (!a.demandCache || a.demandCache.config !== config) {
    let total = 0;
    const startById = Object.create(null);
    try {
      const d = methodDemand(config, config.method);
      for (const b of d.perBlock) { startById[b.id] = total; total += b.volume_mL; }
    } catch (_err) {
      total = 0;
    }
    a.demandCache = { config, total_mL: total, startById };
  }
  const total = a.demandCache.total_mL;
  if (!(total > 0)) return 0;
  const blocks = config.method.blocks;
  const b = blocks[Math.max(0, Math.min(blocks.length - 1, run.blockIndex))];
  const start = b ? (a.demandCache.startById[b.id] || 0) : 0;
  return Math.max(0, Math.min(1, (start + Math.max(0, run.V_block_mL)) / total));
}

/**
 * Repaint the title strip's two status indications: the run-state chip and the data-quality chip.
 *
 * These are the whole of what the deleted bottom strip contributed that was not already on the
 * P&ID or in the pen rail, so they are the whole of what moved up here. Each is a lamp beside a
 * WORD — `RUNNING`, `HELD`, `OK`, `SUS` — so neither is ever colour alone, and each carries the
 * long form in its tooltip and accessible name.
 *
 * @param {object} a the application instance
 * @param {object} run the run state
 * @returns {void}
 */
function refreshStatusIndication(a, run) {
  const st = run.state;
  // Blink only while an acknowledgement is genuinely outstanding — ISA-18.2's meaning for a
  // flashing indication — not merely because the state word says ALARM.
  const unacked = (st === 'ALARM' || st === 'FAULT') && !!a.alarm.ackable;
  const stateText = `Run state: ${st} — ${stateExplanation(st)}`;
  setModifier(a.el.stateChip, STATE_WORD_CLASSES, STATE_WORD[st] || '');
  fmt.setText(a.el.stateWord, st);
  fmt.setAttr(a.el.stateChip, 'title', stateText);
  setLamp(a.el.stateLamp, stateLamp(st), stateText, unacked);

  let worst = 'OK';
  for (const sensor of QUALITY_SENSORS) {
    const q = sensorQuality(run, sensor);
    if (q === 'INVALID') worst = 'INVALID';
    else if (q !== 'OK' && worst === 'OK') worst = q;
  }

  let nFlags = 0;
  const names = [];
  for (const [bit, label] of QF_LABELS) {
    if ((run.qualityFlags & bit) === 0) continue;
    nFlags++;
    names.push(label);
  }
  const tone = worst === 'INVALID' ? 'alarm' : (worst === 'OK' ? 'run' : 'warn');
  const qualText = nFlags === 0
    ? 'Data quality: OK — press for the per-sensor verdicts'
    : `Data quality: ${worst}, ${nFlags} flag${nFlags === 1 ? '' : 's'}: ${names.join(' · ')}`;
  setLamp(a.el.qualLamp, tone, qualText, false);
  setModifier(a.el.qualBtn, QUALITY_WORD_CLASSES, QUALITY_WORD[worst] || '');
  fmt.setText(a.el.qualWord, QUALITY_CODE[worst] || worst);
  // The button is named explicitly rather than from its contents: name-from-content over a lamp
  // whose only text is its own `aria-label` came back EMPTY in the accessibility tree, which would
  // have left the quality indication unreachable by name. One string, so the two cannot disagree.
  fmt.setAttr(a.el.qualBtn, 'aria-label', qualText);
  fmt.setAttr(a.el.qualBtn, 'title', qualText);
}

/**
 * The signature of everything the banner shows, so the band is rewritten when — and only when —
 * something on it changed. It covers the displayed index, the total, and every visible row's id and
 * acknowledgement mark, so acknowledging a row or stepping to the next one repaints, and a frame in
 * which nothing changed costs one string compare.
 * @param {object} a the application instance
 * @param {Array<object>} rows `a.alarm.order`
 * @param {number} idx the index being displayed
 * @returns {string} the signature
 */
function bannerSignature(a, rows, idx) {
  let s = `A${idx}/${rows.length}#${a.alarm.count}:`;
  for (let i = 0; i < rows.length; i++) {
    s += rows[i].id + (a.alarm.acked.has(rows[i].id) ? '+' : '-');
  }
  return s;
}

/**
 * Repaint the FIRST-OUT alarm banner when anything on it changes, and keep the two live regions
 * honest.
 *
 * WHAT THE BAND SHOWS. The FIRST alarm of the current flurry that the operator has not silenced —
 * `a.alarm.order[0]`, arrival-ordered — or, when they have stepped, the row they stepped to. Not
 * the highest-ranked row: in a cascade the highest-ranked row is usually a consequence, and the
 * operator needs the cause. The rank chip says which of the two they are looking at, and the count
 * chip says how many stand behind it.
 *
 * When there is no alarm the band shows the last caught shell error; when there is neither it is
 * `hidden` and takes no height at all. It is tinted by the displayed row's severity.
 *
 * WHAT THE CONTROLS ACT ON. The displayed row is recorded in `a.bannerAlarmId` on every call, and
 * every control on the band resolves that id when it is pressed. The row the band is labelled for
 * is therefore the row it acts on: an operator can never acknowledge an alarm the band is not
 * showing, whether it is hidden behind a silence, behind a step, or behind the severity ranking.
 *
 * WHAT THE LIVE REGIONS ANNOUNCE. The NEWEST arrival, not the displayed row — every alarm
 * annunciates once when it arrives, which is what ISA-18.2 means by annunciation, and stepping the
 * banner around afterwards is an operator action and must stay silent. The announcement carries the
 * priority, the row, the plain-language condition and consequence, and names the first-out row when
 * it is not the one that just arrived.
 *
 * @param {object} a the application instance
 * @returns {void}
 */
function refreshAlarmBar(a) {
  const el = a.el;
  const config = a.ctx.config;
  const rows = a.alarm.order;
  const idx = bannerIndex(a, rows);
  const shown = rows[idx] || null;
  const err = a.shellError;
  a.bannerAlarmId = shown ? shown.id : null;
  const sig = shown ? bannerSignature(a, rows, idx) : (err ? `E:${err.source}:${err.message}` : '');
  if (sig === a.alarmSig) return;
  a.alarmSig = sig;

  if (shown) {
    const sev = shown.severity || 'WARN';
    const named = `${shown.id} — ${shown.name}`;
    // Ranked against EVERY raised row, not just the visible ones. A silenced first-out is still the
    // first-out, so the row behind it must not be allowed to wear the chip and claim to be the
    // cause. `all` is arrival-ordered, so its index IS the arrival rank.
    const all = a.alarm.all;
    const allIdx = all.indexOf(shown);
    const first = allIdx === 0;
    const acked = a.alarm.acked.has(shown.id);
    const needsAck = !!(shown.ackRequired || shown.latching);
    const behind = a.alarm.count - 1;
    const arrival = a.firstOut.at.get(shown.id) || null;
    const stamp = arrival ? fmt.fmtClock(arrival.t_s) : fmt.NO_VALUE;
    const sentence = `${alarmSentence(shown, config)}. ${alarmConsequence(shown)}`;

    setBandTone(el.alarmBar, SEVERITY_BAND[sev] || 'warn');
    // Blink is ISA-18.2's "acknowledgement outstanding", not "this is red": an acknowledged row
    // stops flashing even while it is still standing.
    setLamp(el.alarmLamp, SEVERITY_LAMP[sev] || 'warn', `${sev}: ${shown.name}`,
      !acked && (SEVERITY_RANK[sev] || 0) >= SEVERITY_RANK.ALARM);
    fmt.setText(el.alarmSev, SEVERITY_WORD[sev] || sev);

    const firstOut = all[0] || shown;
    el.alarmRank.hidden = false;
    fmt.setText(el.alarmRank, first ? 'FIRST OUT' : `#${allIdx + 1} OF ${all.length}`);
    fmt.cls(el.alarmRank, 'is-first', first);
    fmt.setAttr(el.alarmRank, 'title', first
      ? 'FIRST OUT — the earliest alarm still standing in this flurry, and so the one that most '
        + 'likely caused the rest.'
      : `Alarm ${allIdx + 1} of ${all.length} in this flurry, in the order they arrived. First out `
        + `was ${firstOut.id} — ${firstOut.name}`
        + `${a.silenced.has(firstOut.id) ? ', which you silenced on the banner.' : '.'}`);

    fmt.setText(el.alarmTag, alarmTag(shown));
    fmt.setText(el.alarmCode, named);
    fmt.setText(el.alarmCond, sentence);
    fmt.setAttr(el.alarmCond, 'title', `${sentence} Trip condition: ${alarmCondition(shown)}.`);

    el.alarmTime.hidden = false;
    fmt.setText(el.alarmTime, stamp);
    fmt.setAttr(el.alarmTime, 'title', arrival
      ? `Raised at ${stamp} on the run clock (${new Date(arrival.wall_ms).toLocaleTimeString()} `
        + 'by the wall clock).'
      : 'This row was already standing when the screen picked it up, so its arrival time is not '
        + 'known. The event log has the raise.');

    el.alarmAckState.hidden = false;
    fmt.setText(el.alarmAckState, acked ? 'ACK' : 'UNACK');
    fmt.cls(el.alarmAckState, 'is-acked', acked);
    fmt.cls(el.alarmAckState, 'is-unacked', !acked);
    fmt.setAttr(el.alarmAckState, 'title', acked
      ? 'Acknowledged. The alarm is still standing, but it no longer demands its state change.'
      : (needsAck
        ? 'NOT acknowledged. This row latches and demands acknowledgement before the run can leave '
          + 'the state it forced.'
        : 'NOT acknowledged. This row does not require it; acknowledging it stops it demanding '
          + 'its action.'));

    fmt.setText(el.alarmCount, `+${behind}`);
    el.alarmCount.hidden = behind < 1;
    fmt.setAttr(el.alarmCount, 'title', behind < 1 ? ''
      : `${behind} more alarm${behind === 1 ? '' : 's'} standing behind this one. `
        + `Worst of the set is ${a.alarm.worst}.`);

    fmt.setAttr(el.alarmBar, 'title', `${SEVERITY_WORD[sev] || sev} · ${named}. ${sentence}`);

    // Name the row in BOTH the accessible name and the tooltip: the press acts on this row, so the
    // hover text and the screen-reader text must say which row that is.
    el.alarmAckBtn.hidden = false;
    setEnabled(el.alarmAckBtn, !acked,
      `${named} is already acknowledged.`, `Acknowledge ${named} (Shift+K)`);
    fmt.setAttr(el.alarmAckBtn, 'aria-label', `Acknowledge ${named}`);

    el.alarmStepBtn.hidden = rows.length < 2;
    fmt.setAttr(el.alarmStepBtn, 'aria-label',
      `Step to alarm ${(idx + 2 > rows.length ? 1 : idx + 2)} of ${rows.length}`);
    fmt.setAttr(el.alarmStepBtn, 'title', rows.length < 2 ? 'No other alarm to step to'
      : `Showing ${idx + 1} of ${rows.length}. Step to the next in arrival order; it wraps back to `
        + 'the first out (Shift+Down).');

    el.alarmSilenceBtn.hidden = false;
    fmt.setAttr(el.alarmSilenceBtn, 'aria-label', `Silence the banner for ${named}`);
    fmt.setAttr(el.alarmSilenceBtn, 'title', `Hide ${named} from the banner for the session. `
      + 'It stays active, stays counted and stays logged.');

    el.alarmMoreBtn.hidden = false;
    fmt.setAttr(el.alarmMoreBtn, 'title',
      `All ${a.alarm.count} standing alarm${a.alarm.count === 1 ? '' : 's'}, first out at the top `
      + '(Shift+A)');

    el.errCopyBtn.hidden = true;
    el.errClearBtn.hidden = true;
  } else if (err) {
    // A caught shell error borrows the ALARM tint: it is a failure, and there is no sixth
    // severity to invent for it.
    setBandTone(el.alarmBar, 'alarm');
    setLamp(el.alarmLamp, 'alarm', `Shell error in ${err.source}`, false);
    fmt.setText(el.alarmSev, 'ERROR');
    fmt.setText(el.alarmTag, err.source.toUpperCase());
    fmt.setText(el.alarmCode, err.message);
    fmt.setText(el.alarmCond, 'The screen caught this and kept running. Copy it, then dismiss it.');
    fmt.setAttr(el.alarmCond, 'title', err.detail);
    fmt.setAttr(el.alarmBar, 'title', `${err.source}: ${err.message}`);
    el.alarmRank.hidden = true;
    el.alarmTime.hidden = true;
    el.alarmAckState.hidden = true;
    el.alarmCount.hidden = true;
    el.alarmAckBtn.hidden = true;
    el.alarmStepBtn.hidden = true;
    el.alarmSilenceBtn.hidden = true;
    el.alarmMoreBtn.hidden = true;
    el.errCopyBtn.hidden = false;
    el.errClearBtn.hidden = false;
  } else {
    // Nothing to show. Drop the tint too, so the band cannot reappear wearing the colour of the
    // alarm that cleared before its text has been rewritten.
    setBandTone(el.alarmBar, '');
  }
  el.alarmBar.hidden = !(shown || err);

  // The NEWEST row, which `order` puts last because it is sorted by arrival.
  const newest = rows.length > 0 ? rows[rows.length - 1] : null;
  const newestId = newest ? newest.id : '';
  if (newestId !== a.liveAlarmId) {
    a.liveAlarmId = newestId;
    let text = '';
    if (newest) {
      text = `${SEVERITY_WORD[newest.severity] || newest.severity} alarm. ${newest.id}, `
        + `${newest.name}. ${alarmSentence(newest, config)}. ${alarmConsequence(newest)}`;
      const head = a.alarm.all[0];
      if (a.alarm.count > 1 && head && head.id !== newest.id) {
        text += ` ${a.alarm.count} alarms standing; first out is ${head.id}, ${head.name}.`;
      }
    }
    const rank = newest ? (SEVERITY_RANK[newest.severity] || 0) : 0;
    const worst = SEVERITY_RANK[a.alarm.worst] || 0;
    // Assertive when anything standing is CRITICAL or worse — a critical row already on the band
    // must not be demoted to a polite announcement by a warning arriving after it.
    const urgent = Math.max(rank, worst) >= SEVERITY_RANK.CRITICAL;
    fmt.setText(el.alarmAssertive, urgent ? text : '');
    fmt.setText(el.alarmPolite, !urgent && rank > 0 ? text : '');
  }
}

/**
 * The ISA tag an alarm watches, for the banner's tag slot.
 * @param {object} def the `AlarmDef` row
 * @returns {string} the tag, or the alarm's own family prefix when it watches no single instrument
 */
function alarmTag(def) {
  const entry = def.signal ? glossaryFor(def.signal) : null;
  if (entry && entry.term) {
    const m = /([A-Z]{2,4}-\d{3})/.exec(entry.term);
    if (m) return m[1];
  }
  if (def.signal) return def.signal;
  return def.id.split('-').slice(0, 2).join('-');
}

/**
 * The trip condition as the alarm table states it — `P1 > 1.60` — for the tooltip and the engineer
 * who wants the row, not the sentence.
 * @param {object} def the `AlarmDef` row
 * @returns {string} the condition
 */
function alarmCondition(def) {
  if (def.signal && def.op && typeof def.threshold === 'number') {
    return `${def.signal} ${def.op} ${def.threshold}`;
  }
  if (def.evalKey) return def.evalKey;
  return def.action || '';
}

/**
 * The trip condition in PLAIN LANGUAGE, in the operator's own display units — "Pre-column pressure
 * above 2.20 bar", not "P1 > 1.60". This is the sentence the operator actually reads at 03:00, and
 * it is the half of the banner that says WHAT HAPPENED.
 *
 * A comparison row renders from {@link SIGNAL_TEXT} and {@link OP_WORD}; a custom predicate from
 * {@link EVAL_PHRASE}; anything the tables do not know falls back to the row's own name, which is
 * already written in English, so a preset that adds an alarm still reads.
 *
 * @param {object} def the `AlarmDef` row
 * @param {object} config the frozen config, for the unit-aware formatters
 * @returns {string} the condition, capitalised, with no trailing stop
 */
function alarmSentence(def, config) {
  if (def.signal && def.op && OP_WORD[def.op] && typeof def.threshold === 'number') {
    const s = SIGNAL_TEXT[def.signal];
    const noun = s ? s.noun : def.signal;
    let value = String(def.threshold);
    if (s) {
      try {
        value = s.fmt(def.threshold, config);
      } catch (_err) {
        value = String(def.threshold);          // a formatter must never take the banner down
      }
    }
    return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${OP_WORD[def.op]} ${value}`;
  }
  if (def.evalKey && EVAL_PHRASE[def.evalKey]) return EVAL_PHRASE[def.evalKey];
  return def.name || def.id;
}

/**
 * What the SKID does about this row, in plain language — the half of the banner that says what has
 * already happened to the process while the operator was reading the first half. The wording tracks
 * `skid/engine.js::applyAlarmDemand`, which is the code that acts.
 * @param {object} def the `AlarmDef` row
 * @returns {string} one sentence, ending in a stop
 */
function alarmConsequence(def) {
  if (def.action === 'TRIP') {
    return def.severity === 'FAULT'
      ? 'The skid TRIPS to FAULT: flow stops without a ramp and only Reset recovers.'
      : 'The skid TRIPS to ALARM: the outlet is diverted to waste until this is acknowledged.';
  }
  return ACTION_CONSEQUENCE[def.action]
    || 'Logged for the operator; the skid takes no action of its own.';
}

/**
 * Repaint the `Ctrl+Alt+P` performance overlay. Rows are created once and then written to, so the
 * overlay costs a handful of text assignments per frame.
 * @param {object} a the application instance
 * @returns {void}
 */
function renderPerf(a) {
  const run = a.ctx.run;
  const p = a.perf;
  const rows = [
    ['FRAME', `${p.frame_ms.toFixed(1)} ms · ${(1000 / Math.max(p.frame_ms, 0.001)).toFixed(0)} fps`],
    ['SIM', `${p.sim_ms.toFixed(2)} ms`],
    ['RENDER', `${p.render_ms.toFixed(2)} ms`],
    ['TICK/FR', String(p.ticks)],
    ['TICK/S', p.tps.toFixed(0)],
    ['SPEED', `${run.speed}× → ${formatSpeed(run.speed / Math.max(run.speedDeficit, 1e-9))}×`],
    ['DEFICIT', run.speedDeficit.toFixed(3)],
    ['MS/SIM-S', run.diag.msPerSimSecond.toFixed(3)],
    ['MS/TICK', run.diag.msLastTick.toFixed(3)],
    ['NSUB', String(run.diag.nSubLast)],
    ['COURANT', run.diag.courant.toFixed(3)],
    ['CELLS', String(run.diag.activeCells)],
    ['NZ', String(a.ctx.config.column.nz)],
    ['BENCH', a.benchmark ? `${a.benchmark.msPerSimSecond.toFixed(2)} ms/sim-s` : 'not run'],
    ['LOG', String(run.log ? run.log.n : 0)],
  ];

  if (!a.perfRows || a.perfRows.length !== rows.length) {
    while (a.el.perf.firstChild) a.el.perf.removeChild(a.el.perf.firstChild);
    a.perfRows = rows.map(([k]) => {
      const value = h('span', { class: 'perf__value' }, '');
      a.el.perf.appendChild(h('div', { class: 'perf__row' },
        h('span', { class: 'perf__key' }, k), value));
      return value;
    });
  }
  for (let i = 0; i < rows.length; i++) fmt.setText(a.perfRows[i], rows[i][1]);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ERRORS — the alarm band doubles as the shell's failure surface
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * @param {*} err anything thrown
 * @returns {string} a one-line message
 */
function errText(err) {
  if (!err) return 'unknown error';
  return (err && err.message) ? String(err.message) : String(err);
}

/**
 * Surface a caught error in the alarm band instead of freezing. One error is held at a time, so a
 * fault that repeats every frame never grows the DOM. An active alarm always outranks it.
 * @param {object} a the application instance
 * @param {string} source where it came from, e.g. `'main screen'`
 * @param {*} err the thrown value
 * @returns {void}
 */
function reportError(a, source, err) {
  console.error(`[app] ${source} failed:`, err);
  if (!a || !a.el || !a.el.alarmBar) return;
  a.shellError = {
    source,
    message: errText(err),
    detail: `${source}: ${errText(err)}\n${(err && err.stack) || ''}`,
  };
  a.alarmSig = null;
}

/**
 * Copy the held error, stack and all, to the clipboard — the one thing a user can usefully do with
 * a stack trace.
 * @param {object} a the application instance
 * @returns {void}
 */
function copyShellError(a) {
  if (!a.shellError) return;
  const text = a.shellError.detail;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  else console.log(text);
}

/**
 * Dismiss the held error and let the band close.
 * @param {object} a the application instance
 * @returns {void}
 */
function clearShellError(a) {
  a.shellError = null;
  a.alarmSig = null;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SMALL FORMATTERS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * @param {string} st a `run.state` value
 * @returns {'off'|'run'|'warn'|'alarm'} the lamp colour for the run-state chip
 */
function stateLamp(st) {
  switch (st) {
    case 'RUNNING': return 'run';
    case 'READY': return 'run';
    case 'ENDED': return 'run';
    case 'HELD': return 'warn';
    case 'PAUSED': return 'warn';
    case 'ALARM': return 'alarm';
    case 'FAULT': return 'alarm';
    default: return 'off';
  }
}

/**
 * One sentence explaining what a run state permits — the state chip's tooltip.
 * @param {string} st a `run.state` value
 * @returns {string} the explanation
 */
function stateExplanation(st) {
  switch (st) {
    case 'IDLE': return 'Idle — pumps at zero. Start runs the pre-run checks first.';
    case 'READY': return 'Ready — the pre-run checks passed. Start begins the method.';
    case 'RUNNING': return 'Running — the method engine is driving the skid.';
    case 'HELD': return 'Held — flow continues at setpoint; the block clock and block volume are frozen.';
    case 'PAUSED': return 'Paused — flow has ramped to zero and the clock is frozen.';
    case 'ALARM': return 'Alarm — the outlet is diverted to waste. Acknowledge, then Hold or Pause.';
    case 'ENDED': return 'Ended — the Results screen has the analysis. Reset to arm another run.';
    case 'FAULT': return 'Fault — flow stopped without a ramp. Only Reset recovers.';
    default: return 'Run state';
  }
}

/**
 * Round an effective speed to something an operator can read without it flickering.
 * @param {number} x speed multiplier
 * @returns {string} the rounded speed
 */
function formatSpeed(x) {
  if (!Number.isFinite(x)) return '0';
  if (x >= 100) return String(Math.round(x / 10) * 10);
  if (x >= 10) return String(Math.round(x));
  return x.toFixed(1);
}
