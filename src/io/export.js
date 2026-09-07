/**
 * src/io/export.js — getting data out of the rig and settings back into it: CSV of the trend,
 * a saved session, and a library of graded runs to compare against each other.
 *
 * Layer L4: imports `core/util.js` and reads the sim context. The only DOM it touches is the
 * anchor-and-Blob dance that makes a browser save a file, which is isolated in {@link download}
 * so everything else in this module is testable under Node.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS AT ALL
 *
 * A tuning exercise that ends when you close the tab has taught you something for about a day.
 * The three things that make it stick are all export problems:
 *
 *   1. THE DATA. Real loop analysis happens in a spreadsheet or a notebook, not in the trend
 *      window of the DCS. Being able to take the actual samples away and plot them yourself is
 *      the difference between a demonstration and an experiment.
 *   2. THE SETTINGS. "The tuning I had on Tuesday" is a real thing to want back, and retyping
 *      eleven numbers from a screenshot is how transcription errors get into plants.
 *   3. THE COMPARISON. One tuning is a data point. Two tunings graded against the same scripted
 *      disturbance is an argument, and an argument is what changes anyone's mind — including
 *      your own, when the tuning you were sure about scores worse than the boring one.
 * ------------------------------------------------------------------------------------------
 */

/** Session-file format version. Bumped when a field's meaning changes, not when one is added. */
export const SESSION_VERSION = 2;

/**
 * Turn a ring buffer into comma-separated values, oldest sample first.
 *
 * Every column carries its unit in the header, because a CSV whose columns are named `p` and `q`
 * is a CSV somebody will misread within the week.
 *
 * @param {object} ring the trend ring from `core/util.js`
 * @param {Record<string,string>} units channel name to unit label
 * @param {object} [opts] options
 * @param {number} [opts.decimals=4] significant decimals per value
 * @param {string[]} [opts.channels] which channels to include, defaulting to all of them
 * @returns {string} the CSV text, with a trailing newline
 */
export function trendToCsv(ring, units, opts = {}) {
  const dp = opts.decimals === undefined ? 4 : opts.decimals;
  const names = opts.channels || ring.names;
  const header = names.map((n) => (units[n] ? `${n} (${units[n]})` : n)).join(',');
  const lines = [header];
  const start = (ring.head - ring.len + ring.cap) % ring.cap;
  const cols = names.map((n) => ring.data[n]);
  const row = new Array(names.length);
  for (let i = 0; i < ring.len; i += 1) {
    const k = (start + i) % ring.cap;
    for (let c = 0; c < cols.length; c += 1) {
      const v = cols[c][k];
      row[c] = Number.isFinite(v) ? trimNumber(v, dp) : '';
    }
    lines.push(row.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Format a number to at most `dp` decimals with no trailing zeros, so the file stays readable
 * and small. `0.5000` is noise; `0.5` is the number.
 * @param {number} v the value
 * @param {number} dp maximum decimals
 * @returns {string} the formatted number
 */
function trimNumber(v, dp) {
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(dp);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * Render a graded result as a small CSV: one section of headline numbers, one row per analysed
 * step, one row per grade component.
 *
 * @param {object} result a scorecard result from `control/scenario.js`
 * @returns {string} the CSV text
 */
export function scorecardToCsv(result) {
  const rows = [];
  rows.push('section,name,value,unit');
  const head = [
    ['scenario', result.scenario, ''],
    ['duration', result.t_s.toFixed(1), 's'],
    ['score', result.score.toFixed(1), '/100'],
    ['IAE', result.iae.toPrecision(5), 'EU.s'],
    ['ITAE', result.itae.toPrecision(5), 'EU.s2'],
    ['peak error', result.peakErr.toPrecision(4), 'EU'],
    ['output travel', result.coTravel.toFixed(1), '%'],
    ['pump starts', String(result.starts), ''],
    ['energy', result.energy_kWh.toPrecision(4), 'kWh'],
    ['volume', result.volume_m3.toPrecision(4), 'm3'],
    ['specific energy', Number.isFinite(result.specific_kWh_m3) ? result.specific_kWh_m3.toPrecision(4) : '', 'kWh/m3'],
    ['saturated', result.satTime_s.toFixed(1), 's'],
    ['below min flow', result.minFlowTime_s.toFixed(1), 's'],
    ['cavitating', result.cavTime_s.toFixed(1), 's'],
  ];
  for (const [k, v, u] of head) rows.push(`summary,${csvCell(k)},${csvCell(v)},${u}`);

  rows.push('');
  rows.push('step,kind,at (s),overshoot (%),rise (s),settle (s),peak deviation (EU),IAE (EU.s)');
  for (const s of result.steps) {
    rows.push([
      csvCell(s.label), s.kind, s.at_s.toFixed(1),
      Number.isFinite(s.overshootPct) ? s.overshootPct.toFixed(1) : '',
      Number.isFinite(s.rise_s) ? s.rise_s.toFixed(1) : '',
      s.settle_s.toFixed(1), s.peakDev.toPrecision(4), s.iae.toPrecision(4),
    ].join(','));
  }

  rows.push('');
  rows.push('grade component,weight,ratio to reference,reference,points earned');
  for (const p of result.parts) {
    rows.push([
      csvCell(p.label), p.weight,
      Number.isFinite(p.ratio) ? p.ratio.toPrecision(3) : 'n/a',
      csvCell(p.ref),
      Number.isFinite(p.earned) ? p.earned.toFixed(1) : 'n/a',
    ].join(','));
  }
  rows.push(`penalty,cavitation,,,${(-result.penalties.cavitation).toFixed(1)}`);
  rows.push(`penalty,minimum flow,,,${(-result.penalties.minFlow).toFixed(1)}`);
  return `${rows.join('\n')}\n`;
}

/**
 * Quote a CSV cell if it needs it.
 * @param {string|number} v the value
 * @returns {string} the cell
 */
function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Capture everything about a session that is worth getting back: the tuning, the strategy, the
 * sequence settings and the state of the plant's disturbances.
 *
 * Deliberately NOT captured: the integrator, the trend history, the alarm log, the elapsed time.
 * A session file is a set of SETTINGS, not a checkpoint of a running plant — restoring it into a
 * plant that is somewhere else should put your knobs back and leave the process where it is,
 * which is what an engineer means when they say "load my settings".
 *
 * @param {object} ctx the sim context
 * @returns {object} a JSON-serialisable snapshot
 */
export function sessionSnapshot(ctx) {
  const p = ctx.plant;
  return {
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    loopMode: ctx.run.mode,
    scan_s: ctx.config.scan_s,
    setpoint: ctx.pid.spTarget,
    controllerMode: ctx.pid.mode,
    tuning: {
      Kc: ctx.pidCfg.Kc,
      Ti: ctx.pidCfg.Ti,
      Td: ctx.pidCfg.Td,
      N: ctx.pidCfg.N,
      b: ctx.pidCfg.b,
      c: ctx.pidCfg.c,
      Tt: ctx.pidCfg.Tt,
      action: ctx.pidCfg.action,
      form: ctx.pidCfg.form,
      algorithm: ctx.pidCfg.algorithm,
      pvFilter_s: ctx.pidCfg.pvFilter_s,
      deadband: ctx.pidCfg.deadband,
      spRate: ctx.pidCfg.spRate,
      outLo: ctx.pidCfg.outLo,
      outHi: ctx.pidCfg.outHi,
      outRate: ctx.pidCfg.outRate,
      smith: { ...ctx.pidCfg.smith },
    },
    staging: { ...ctx.stagingCfg },
    strategy: JSON.parse(JSON.stringify(ctx.stratCfg)),
    process: {
      fluidId: p.fluidId,
      demandTarget: p.demandTarget,
      hDischarge_m: p.hDischarge_m,
      foul: p.foul,
      Tsupply_C: p.Tsupply_C,
      makeupAuto: p.makeupAuto,
      recircMode: p.recircMode,
      finalElement: p.finalElement,
      fixedSpeed_pct: p.fixedSpeed_pct,
      pAtm_bar: p.pAtm_bar,
      trim: Array.from(p.trim),
      wear: Array.from(p.wear),
      valveOverride: JSON.parse(JSON.stringify(p.valveOverride)),
    },
    model: ctx.model ? { ...ctx.model } : null,
  };
}

/**
 * Restore a session snapshot through the sim's own action functions, so every value is validated
 * exactly as if it had been typed into the panel.
 *
 * A file that has been hand-edited into nonsense is therefore rejected field by field with the
 * same messages the UI gives, rather than corrupting the running rig. Failures are collected and
 * returned rather than thrown, because a snapshot that is 90% valid is worth applying.
 *
 * @param {object} ctx the sim context
 * @param {object} snap a snapshot from {@link sessionSnapshot}
 * @param {object} actions the sim's action functions
 * @returns {{ok:boolean, applied:number, problems:string[]}} what happened
 */
export function applySession(ctx, snap, actions) {
  const problems = [];
  let applied = 0;

  if (!snap || typeof snap !== 'object') {
    return { ok: false, applied: 0, problems: ['that file is not a session snapshot'] };
  }
  if (snap.version !== SESSION_VERSION) {
    problems.push(`session file is version ${snap.version}, this rig writes version `
      + `${SESSION_VERSION} — anything it does not recognise has been skipped`);
  }

  /**
   * Apply one action and record the outcome.
   * @param {string} what a description for the problem list
   * @param {() => {ok:boolean, reason?:string}} fn the action
   * @returns {void}
   */
  const step = (what, fn) => {
    try {
      const r = fn();
      if (r && r.ok === false) problems.push(`${what}: ${r.reason}`);
      else applied += 1;
    } catch (e) {
      problems.push(`${what}: ${e.message}`);
    }
  };

  if (snap.loopMode) step('loop mode', () => actions.setLoopMode(ctx, snap.loopMode));
  if (Number.isFinite(snap.scan_s)) step('scan period', () => actions.setScan(ctx, snap.scan_s));
  if (snap.tuning) step('tuning', () => actions.setTuning(ctx, snap.tuning));
  if (Number.isFinite(snap.setpoint)) step('setpoint', () => actions.setSetpoint(ctx, snap.setpoint));
  if (snap.staging) step('staging', () => actions.setStaging(ctx, snap.staging));
  if (snap.strategy) step('strategy', () => actions.setStrategy(ctx, snap.strategy));
  if (snap.process) step('process', () => actions.setDisturbance(ctx, snap.process));
  if (snap.controllerMode) {
    step('controller mode', () => actions.setControllerMode(ctx, snap.controllerMode));
  }
  if (snap.model && actions.setModel) step('process model', () => actions.setModel(ctx, snap.model));

  return { ok: problems.length === 0, applied, problems };
}

/* ============================================================================================
 * THE RUN LIBRARY
 * ============================================================================================ */

/**
 * Allocate the run library.
 * @returns {object} the library
 */
export function createRunLibrary() {
  return { runs: [], nextId: 1 };
}

/**
 * File a completed run, with the tuning that produced it.
 *
 * The tuning is copied in rather than referenced, because the whole value of the library is that
 * it remembers what the settings WERE. A library holding live references to the current tuning
 * would show you six identical rows.
 *
 * @param {object} lib the library (mutated)
 * @param {object} result a scorecard result
 * @param {object} ctx the sim context, for the settings that produced it
 * @param {string} [label] an operator label
 * @returns {object} the filed record
 */
export function saveRun(lib, result, ctx, label) {
  const rec = {
    id: lib.nextId,
    label: label || `${result.scenario} #${lib.nextId}`,
    at: new Date().toISOString(),
    scenario: result.scenario,
    tuning: {
      Kc: ctx.pidCfg.Kc, Ti: ctx.pidCfg.Ti, Td: ctx.pidCfg.Td, N: ctx.pidCfg.N,
      b: ctx.pidCfg.b, form: ctx.pidCfg.form,
    },
    structure: ctx.stratCfg.structure,
    ff: ctx.stratCfg.ff.enabled,
    finalElement: ctx.plant.finalElement,
    criterion: ctx.stagingCfg.criterion,
    result,
  };
  lib.nextId += 1;
  lib.runs.push(rec);
  return rec;
}

/**
 * Remove a run.
 * @param {object} lib the library (mutated)
 * @param {number} id the run id
 * @returns {boolean} whether anything was removed
 */
export function deleteRun(lib, id) {
  const i = lib.runs.findIndex((r) => r.id === id);
  if (i < 0) return false;
  lib.runs.splice(i, 1);
  return true;
}

/**
 * Compare a set of runs on the metrics that mean something, and say which is best on each.
 *
 * Runs of DIFFERENT scenarios are still listed, but flagged: an IAE from a four-minute setpoint
 * test and one from a twelve-minute duty cycle are not comparable numbers, and quietly ranking
 * them against each other is how a comparison table lies.
 *
 * @param {object} lib the library
 * @param {number[]} [ids] which runs, defaulting to all of them
 * @returns {{rows:object[], metrics:object[], comparable:boolean, scenarios:string[]}} the table
 */
export function compareRuns(lib, ids) {
  const rows = (ids ? lib.runs.filter((r) => ids.includes(r.id)) : lib.runs.slice());
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  const metrics = [
    { key: 'score', label: 'Score', unit: '/100', better: 'high', get: (r) => r.result.score },
    { key: 'iae', label: 'IAE', unit: 'EU.s', better: 'low', get: (r) => r.result.iae },
    { key: 'itae', label: 'ITAE', unit: 'EU.s2', better: 'low', get: (r) => r.result.itae },
    { key: 'overshoot', label: 'Overshoot', unit: '%', better: 'low', get: (r) => r.result.overshootPct },
    { key: 'settle', label: 'Settling', unit: 's', better: 'low', get: (r) => r.result.settle_s },
    { key: 'peak', label: 'Peak error', unit: 'EU', better: 'low', get: (r) => r.result.peakErr },
    { key: 'travel', label: 'Output travel', unit: '%', better: 'low', get: (r) => r.result.coTravel },
    { key: 'starts', label: 'Pump starts', unit: '', better: 'low', get: (r) => r.result.starts },
    { key: 'specific', label: 'Specific energy', unit: 'kWh/m3', better: 'low', get: (r) => r.result.specific_kWh_m3 },
    { key: 'cav', label: 'Cavitating', unit: 's', better: 'low', get: (r) => r.result.cavTime_s },
  ];

  for (const m of metrics) {
    const vals = rows.map((r) => m.get(r)).filter((v) => Number.isFinite(v));
    m.best = vals.length ? (m.better === 'high' ? Math.max(...vals) : Math.min(...vals)) : NaN;
    m.worst = vals.length ? (m.better === 'high' ? Math.min(...vals) : Math.max(...vals)) : NaN;
  }
  return { rows, metrics, comparable: scenarios.length === 1, scenarios };
}

/**
 * Render the comparison as CSV.
 * @param {object} table the result of {@link compareRuns}
 * @returns {string} the CSV text
 */
export function comparisonToCsv(table) {
  const head = ['metric', 'unit', ...table.rows.map((r) => csvCell(r.label))];
  const lines = [head.join(',')];
  for (const m of table.metrics) {
    lines.push([
      csvCell(m.label), m.unit,
      ...table.rows.map((r) => {
        const v = m.get(r);
        return Number.isFinite(v) ? trimNumber(v, 4) : '';
      }),
    ].join(','));
  }
  lines.push('');
  lines.push(['setting', '', ...table.rows.map((r) => csvCell(r.label))].join(','));
  const settings = [
    ['Kc', (r) => r.tuning.Kc.toPrecision(4)],
    ['Ti (s)', (r) => (Number.isFinite(r.tuning.Ti) ? r.tuning.Ti.toPrecision(4) : 'off')],
    ['Td (s)', (r) => r.tuning.Td.toPrecision(3)],
    ['structure', (r) => r.structure],
    ['feedforward', (r) => (r.ff ? 'on' : 'off')],
    ['final element', (r) => r.finalElement],
    ['staging criterion', (r) => r.criterion],
  ];
  for (const [label, get] of settings) {
    lines.push([csvCell(label), '', ...table.rows.map((r) => csvCell(get(r)))].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/* ============================================================================================
 * THE ONLY PART THAT TOUCHES THE DOM
 * ============================================================================================ */

/**
 * Hand a string to the browser as a file to save.
 *
 * @param {string} filename the suggested name
 * @param {string} text the contents
 * @param {string} [mime='text/csv;charset=utf-8'] the media type
 * @returns {boolean} whether the browser could be asked
 */
export function download(filename, text, mime = 'text/csv;charset=utf-8') {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Revoking immediately races the click in some browsers; a frame is plenty.
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  return true;
}

/**
 * A filename stem with a sortable timestamp, so a folder of exports is in the right order.
 * @param {string} stem the descriptive part
 * @param {string} ext the extension, without the dot
 * @returns {string} the filename
 */
export function timestampedName(stem, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${stem}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/**
 * Read a File the operator picked, and parse it as a session snapshot.
 * @param {File} file the picked file
 * @returns {Promise<object>} the parsed snapshot
 */
export async function readSessionFile(file) {
  const text = await file.text();
  return JSON.parse(text);
}
