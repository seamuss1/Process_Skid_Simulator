#!/usr/bin/env node
/**
 * tools/coverage.js — an instrumented run of the simulator, and a report of what it never
 * reached, ranked by RISK rather than by percentage.
 *
 *   node tools/coverage.js                 the ranked report
 *   node tools/coverage.js --all           every finding, not just the top of each band
 *   node tools/coverage.js --json out.json machine-readable, for a diff between two runs
 *   node tools/coverage.js --file sim.js   only findings in paths containing that substring
 *
 * ------------------------------------------------------------------------------------------
 * WHY NOT A PERCENTAGE
 *
 * A coverage percentage is the average of two populations that have nothing to do with each
 * other. An unreached guard clause — `if (!x) return fail('...')` — costs one wrong error
 * message. An unreached branch of the plant's steady-state solver costs a rig that silently
 * balances to the wrong answer under some fluid nobody tried. They are both "one uncovered
 * branch" and treating them as interchangeable is what produces suites with a proud number and
 * a hole in the middle.
 *
 * So every uncovered region is scored as CONSEQUENCE x EXPOSURE:
 *
 *   CONSEQUENCE  what sits behind it. A whole uncovered function is worse than one arm of an
 *                if. Arithmetic that produces a number the rest of the plant integrates is
 *                worse than a refusal that only produces a string. Size in lines is the proxy
 *                for the first, and a source-text classifier for the second.
 *   EXPOSURE     how reachable it is. An exported entry point that an operator, a script or a
 *                view can call is more exposed than an internal helper, and a module the whole
 *                rig is built on is more exposed than a leaf.
 *
 * The bands come out of the product. What the report is FOR is deciding what to write next, so
 * it prints the source line rather than only the offset: a finding you have to go and look up
 * is a finding that does not get fixed.
 *
 * ------------------------------------------------------------------------------------------
 * HOW THE COVERAGE IS COLLECTED
 *
 * Node ships V8's coverage two ways and both need no package. `NODE_V8_COVERAGE=dir` makes the
 * process dump a JSON per run, which is right for covering a test suite from outside. This tool
 * wants to DRIVE the run itself, so it uses the other one: the `node:inspector` session, which
 * is the same data through the same protocol without the process boundary or the temp files.
 *
 *   Profiler.startPreciseCoverage({ callCount: true, detailed: true })
 *
 * `detailed` is what makes this useful: without it V8 reports function granularity only and
 * every guard clause inside a function that was called once looks covered. With it, each
 * function carries a list of ranges and a range with `count: 0` is a block that never ran.
 *
 * Coverage begins BEFORE the modules are imported, because a script compiled before the
 * profiler started is not instrumented — which would silently report every module-level
 * constant as dead.
 * ------------------------------------------------------------------------------------------
 */

import { Session } from 'node:inspector';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative, sep } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Modules whose coverage is reported. `src/ui` is excluded because it needs a DOM and this run
 * is headless: reporting it would drown the real findings in a hundred unreachable paint calls.
 */
const INCLUDE = ['/src/core/', '/src/process/', '/src/control/', '/src/data/', '/src/io/'];

/**
 * Per-directory exposure weight. How much of the rig stands on this code, and how directly an
 * operator can reach it.
 */
const AREA_WEIGHT = Object.freeze({
  '/src/core/sim.js': 1.35,
  '/src/core/': 1.2,
  '/src/process/': 1.3,
  '/src/control/': 1.15,
  '/src/data/': 0.8,
  '/src/io/': 0.7,
});

/** Bands, by descending score threshold. */
const BANDS = Object.freeze([
  { name: 'CRITICAL', at: 26 },
  { name: 'HIGH', at: 13 },
  { name: 'MEDIUM', at: 6 },
  { name: 'LOW', at: 0 },
]);

// ==============================================================================================
// The instrumented run
// ==============================================================================================

/**
 * Exercise the simulator across a broad spread of configurations, modes, actions and
 * disturbances.
 *
 * This is deliberately the run a THOROUGH USER would produce, not the run that maximises the
 * number: it drives the rig the way the panel does — every loop mode, every final element, every
 * fluid, every staging criterion, every scripted test — and does NOT go hunting for refusal
 * paths. Whatever it misses is what the report is for.
 *
 * @returns {Promise<{scenes:number, ticks:number}>} what the run did
 */
async function exercise() {
  const sim = await import(pathToFileURL(`${ROOT}src${sep}core${sep}sim.js`).href);
  const { LOOP } = await import(pathToFileURL(`${ROOT}src${sep}data${sep}config.js`).href);
  const { MODE, FORM, ALGO } = await import(pathToFileURL(`${ROOT}src${sep}control${sep}pid.js`).href);
  const { STRUCTURE } = await import(pathToFileURL(`${ROOT}src${sep}control${sep}strategy.js`).href);
  const { CRITERION, SHARE, ROTATE, HAND } = await import(
    pathToFileURL(`${ROOT}src${sep}control${sep}staging.js`).href);
  const { SCENARIOS } = await import(pathToFileURL(`${ROOT}src${sep}control${sep}scenario.js`).href);
  const { LESSONS } = await import(pathToFileURL(`${ROOT}src${sep}control${sep}lessons.js`).href);
  const { FLUIDS } = await import(pathToFileURL(`${ROOT}src${sep}process${sep}fluid.js`).href);
  const { RECIRC, FINAL, characteristicCurves } = await import(
    pathToFileURL(`${ROOT}src${sep}process${sep}plant.js`).href);
  const { trendToCsv, scorecardToCsv, sessionSnapshot, TREND_UNITS } = {
    ...await import(pathToFileURL(`${ROOT}src${sep}io${sep}export.js`).href),
    TREND_UNITS: sim.TREND_UNITS,
  };

  let ticks = 0;
  let scenes = 0;

  /**
   * Advance a sim by simulated seconds at the fixed tick.
   * @param {object} ctx the sim context
   * @param {number} seconds simulated seconds
   * @returns {void}
   */
  const run = (ctx, seconds) => {
    const n = Math.round(seconds / ctx.config.dt_s);
    for (let i = 0; i < n; i += 1) { sim.advance(ctx, ctx.config.dt_s); ticks += 1; }
  };

  /**
   * Run one named scene, isolating a failure so the rest of the sweep still reports.
   * @param {string} name what the scene does
   * @param {() => void} body the scene
   * @returns {void}
   */
  const scene = (name, body) => {
    scenes += 1;
    try {
      body();
    } catch (err) {
      process.stderr.write(`  scene "${name}" threw: ${err && err.message}\n`);
    }
  };

  // --- the plain rig, left alone ---------------------------------------------------------------
  scene('idle', () => {
    const ctx = sim.createSim();
    run(ctx, 400);
    sim.summary(ctx);
    sim.loopEU(ctx);
    sim.clearTrend(ctx);
    sim.resetEnergy(ctx);
    sim.togglePause(ctx);
    sim.advance(ctx, 0.02);
    sim.togglePause(ctx);
    sim.setSpeed(ctx, 10);
    sim.advance(ctx, 0.02);
  });

  // --- every loop mode, on both final elements -------------------------------------------------
  for (const mode of Object.values(LOOP)) {
    for (const element of Object.values(FINAL)) {
      scene(`${mode} on ${element}`, () => {
        const ctx = sim.createSim();
        run(ctx, 40);
        sim.setLoopMode(ctx, mode);
        sim.setDisturbance(ctx, { finalElement: element, fixedSpeed_pct: 80 });
        run(ctx, 200);
        sim.setDisturbance(ctx, { demandTarget: 0.7 });
        run(ctx, 200);
        sim.setDisturbance(ctx, { demandTarget: 0.3 });
        run(ctx, 200);
      });
    }
  }

  // --- the controller's own options --------------------------------------------------------
  scene('forms, algorithms and options', () => {
    const ctx = sim.createSim();
    run(ctx, 30);
    for (const f of Object.values(FORM)) sim.setTuningForm(ctx, f);
    for (const a of Object.values(ALGO)) {
      sim.setAlgorithm(ctx, a);
      run(ctx, 60);
    }
    sim.setTuning(ctx, { Td: 1.5, b: 0.5, c: 0.3, pvFilter_s: 1, deadband: 0.01, spRate: 0.05, outRate: 5 });
    run(ctx, 120);
    sim.setTuning(ctx, { smith: { enabled: true, K: 0.05, tau: 3, theta: 1 } });
    run(ctx, 120);
    sim.setControllerMode(ctx, MODE.MAN);
    sim.setManualOutput(ctx, 70);
    run(ctx, 60);
    sim.setControllerMode(ctx, MODE.AUTO);
    run(ctx, 60);
    sim.setScan(ctx, 1);
    run(ctx, 120);
  });

  // --- identification, all three experiments ---------------------------------------------------
  scene('relay autotune and the tuning table', () => {
    const ctx = sim.createSim();
    run(ctx, 60);
    sim.beginAutotune(ctx, { d: 12 });
    sim.setSpeed(ctx, 20);
    run(ctx, 900);
    const cands = sim.tuningCandidates(ctx);
    if (cands.rules.length) sim.applyTuningRule(ctx, cands.rules[0].id);
    run(ctx, 120);
  });
  scene('open-loop step test', () => {
    const ctx = sim.createSim();
    run(ctx, 60);
    sim.beginStepTest(ctx, { du: 10 });
    run(ctx, 700);
    sim.tuningCandidates(ctx);
    sim.refreshAnalysis(ctx);
  });
  scene('frequency sweep', () => {
    const ctx = sim.createSim();
    run(ctx, 60);
    sim.beginSweep(ctx, { amp: 6, n: 4 });
    run(ctx, 1400);
    sim.cancelSweep(ctx);
  });
  scene('a model entered by hand', () => {
    const ctx = sim.createSim();
    run(ctx, 20);
    sim.setModel(ctx, { K: 0.05, tau: 8, theta: 1.5 });
    sim.tuningCandidates(ctx);
    run(ctx, 60);
  });

  // --- every structure ---------------------------------------------------------------------
  scene('cascade', () => {
    const ctx = sim.createSim();
    run(ctx, 40);
    sim.setStrategy(ctx, { structure: STRUCTURE.CASCADE });
    run(ctx, 200);
    sim.setDisturbance(ctx, { demandTarget: 0.75 });
    run(ctx, 200);
    sim.setStrategy(ctx, { structure: STRUCTURE.SINGLE });
    run(ctx, 100);
  });
  scene('feedforward, scheduling and setpoint reset', () => {
    const ctx = sim.createSim();
    run(ctx, 40);
    sim.setStrategy(ctx, { ff: { enabled: true, gain: 0.85, lead_s: 2, lag_s: 3 } });
    sim.setStrategy(ctx, { sched: { enabled: true } });
    run(ctx, 200);
    sim.setDisturbance(ctx, { demandTarget: 0.8 });
    run(ctx, 200);
    sim.setStrategy(ctx, { reset: { enabled: true } });
    run(ctx, 300);
  });
  scene('every override', () => {
    const ctx = sim.createSim();
    run(ctx, 40);
    sim.setStrategy(ctx, {
      override: {
        current: { enabled: true, limit_pct: 70 },
        minFlow: { enabled: true, limit_m3h: 30 },
        maxPressure: { enabled: true, limit_bar: 3.0 },
      },
    });
    run(ctx, 400);
    sim.setDisturbance(ctx, { demandTarget: 0.9 });
    run(ctx, 300);
  });

  // --- the sequence, on every criterion ------------------------------------------------------
  for (const criterion of Object.values(CRITERION)) {
    scene(`staging on ${criterion}`, () => {
      const ctx = sim.createSim();
      run(ctx, 40);
      sim.setStaging(ctx, { criterion, stageUpDelay_s: 4, stageDownDelay_s: 6, minRun_s: 5, minStop_s: 5 });
      sim.setDisturbance(ctx, { demandTarget: 0.9 });
      run(ctx, 400);
      sim.setDisturbance(ctx, { demandTarget: 0.2 });
      run(ctx, 400);
    });
  }
  scene('sharing, rotation and sleep', () => {
    const ctx = sim.createSim();
    run(ctx, 40);
    sim.setStaging(ctx, { share: SHARE.BASE_TRIM, rotate: ROTATE.ON_STAGE_DOWN });
    sim.setDisturbance(ctx, { demandTarget: 0.9 });
    run(ctx, 300);
    sim.setStaging(ctx, { rotate: ROTATE.RUNTIME, rotateAfter_h: 0.001, overlap_s: 5, minRun_s: 2 });
    sim.setDisturbance(ctx, { demandTarget: 0.4 });
    run(ctx, 400);
    sim.setStaging(ctx, { sleepEnabled: true, sleepDelay_s: 20, sleepFlow_m3h: 8, wakeDroop: 0.06 });
    sim.setDisturbance(ctx, { demandTarget: 0 });
    sim.setSpeed(ctx, 20);
    run(ctx, 900);
    sim.setDisturbance(ctx, { demandTarget: 0.5 });
    run(ctx, 400);
  });
  scene('hand, off, trip and reset', () => {
    const ctx = sim.createSim();
    run(ctx, 40);
    sim.startPump(ctx, 1);
    run(ctx, 120);
    sim.stopPump(ctx, 1);
    run(ctx, 60);
    sim.autoPump(ctx, 1);
    sim.forceTrip(ctx, 0);
    run(ctx, 200);
    sim.setSpeed(ctx, 30);
    run(ctx, 600);
    sim.resetPump(ctx, 0);
    run(ctx, 120);
    sim.ackAlarms(ctx);
  });

  // --- the process, pushed about -------------------------------------------------------------
  for (const fluid of FLUIDS) {
    scene(`fluid ${fluid.id}`, () => {
      const ctx = sim.createSim();
      run(ctx, 40);
      sim.setDisturbance(ctx, { fluidId: fluid.id });
      run(ctx, 300);
      sim.setDisturbance(ctx, { demandTarget: 0.8, T_tank_C: 60 });
      run(ctx, 200);
    });
  }
  for (const recirc of Object.values(RECIRC)) {
    scene(`recirculation ${recirc}`, () => {
      const ctx = sim.createSim();
      run(ctx, 40);
      sim.setDisturbance(ctx, { recircMode: recirc, demandTarget: 0.05 });
      sim.setSpeed(ctx, 20);
      run(ctx, 600);
    });
  }
  scene('suction lost, hot and fouled', () => {
    const ctx = sim.createSim();
    run(ctx, 40);
    sim.setDisturbance(ctx, { makeupAuto: false, Tsupply_C: 92, foul: 0.8, demandTarget: 0.7 });
    sim.setSpeed(ctx, 30);
    run(ctx, 1200);
    sim.setDisturbance(ctx, { makeupAuto: true, foul: 0, Tsupply_C: 20, level_m: 2.5 });
    run(ctx, 400);
  });
  scene('wear, trim, stiction and altitude', () => {
    const ctx = sim.createSim({ site: { elevation_m: 1800 } });
    run(ctx, 40);
    sim.setDisturbance(ctx, {
      wear: [0.6, 0.3],
      trim: [0.85, 0.95],
      hDischarge_m: 40,
      bypass: 0.3,
      pAtm_bar: 0.82,
      valveOverride: { fcv: { stickband: 0.03, slipJump: 0.015, strokeTime_s: 2 } },
    });
    run(ctx, 400);
    characteristicCurves(ctx.config, ctx.plant, 0);
  });

  // --- every scripted test ---------------------------------------------------------------------
  for (const def of SCENARIOS) {
    scene(`scenario ${def.id}`, () => {
      const ctx = sim.createSim();
      run(ctx, 30);
      sim.beginScenario(ctx, def.id);
      sim.setSpeed(ctx, 40);
      run(ctx, def.duration_s + 20);
    });
  }
  scene('graded by hand and cleared', () => {
    const ctx = sim.createSim();
    run(ctx, 120);
    const graded = sim.gradeNow(ctx);
    sim.clearScore(ctx);
    trendToCsv(ctx.trend, TREND_UNITS);
    if (ctx.scenario.last) scorecardToCsv(ctx.scenario.last);
    sessionSnapshot(ctx);
    if (!graded.ok) process.stderr.write(`  gradeNow refused: ${graded.reason}\n`);
  });

  // --- every lesson, started and left ----------------------------------------------------------
  for (const def of LESSONS) {
    scene(`lesson ${def.id}`, () => {
      const ctx = sim.createSim();
      run(ctx, 20);
      sim.beginLesson(ctx, def.id);
      sim.setSpeed(ctx, 20);
      run(ctx, 200);
      sim.lessonStatus(ctx);
      sim.endLesson(ctx);
    });
  }

  return { scenes, ticks };
}

// ==============================================================================================
// Collection
// ==============================================================================================

/**
 * Run `body` with V8 precise coverage on, and return the raw per-script result.
 * @param {() => Promise<any>} body the instrumented work
 * @returns {Promise<{result:object[], value:any}>} the coverage and whatever `body` returned
 */
async function collect(body) {
  const session = new Session();
  session.connect();
  /**
   * Promise wrapper for the callback-style inspector post.
   * @param {string} method the protocol method
   * @param {object} [params] the parameters
   * @returns {Promise<object>} the reply
   */
  const post = (method, params) => new Promise((resolve, reject) => {
    session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
  });

  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  const value = await body();
  const { result } = await post('Profiler.takePreciseCoverage');
  await post('Profiler.stopPreciseCoverage');
  session.disconnect();
  return { result, value };
}

// ==============================================================================================
// Analysis
// ==============================================================================================

/**
 * Byte-offset-to-line index for one source file.
 * @param {string} src the file's text
 * @returns {{lineOf:(off:number)=>number, lines:string[], starts:number[]}} the index
 */
function indexLines(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1);
  const lines = src.split('\n');
  return {
    lines,
    starts,
    /**
     * @param {number} off a character offset
     * @returns {number} the 1-based line it falls on
     */
    lineOf(off) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= off) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

/**
 * The exposure weight for a path — how much of the rig stands on it.
 * @param {string} url the file url of the script
 * @returns {number} the weight
 */
function areaWeight(url) {
  for (const [frag, w] of Object.entries(AREA_WEIGHT)) if (url.includes(frag)) return w;
  return 1;
}

/**
 * Classify an uncovered region from its own source text, and say what it would cost.
 *
 * The distinction the whole report turns on is between code that REFUSES and code that
 * COMPUTES. A refusal that is never exercised costs a wrong message and an operator who is
 * confused for a minute. An unexercised computation is a number nobody has ever checked, and it
 * reaches the trend, the alarm list and the grade before anyone notices.
 *
 * @param {string} text the uncovered source
 * @returns {{kind:string, factor:number}} a label and the consequence multiplier
 */
function classify(text) {
  const t = text.trim();
  const lines = t.split('\n').filter((l) => l.trim()).length;

  // A refusal: it returns a failure result or throws, and does nothing else.
  if (/^(return\s+)?(fail\(|\{\s*ok:\s*false)/.test(t) || /^throw\s/.test(t)) {
    return { kind: 'refusal', factor: 0.4 };
  }
  if (lines <= 2 && /\breturn\s+(fail\(|null|NaN|false|-1|\{\s*ok:\s*false)/.test(t)) {
    return { kind: 'guard', factor: 0.45 };
  }
  // A numerical path: iteration or real arithmetic, which is where a silent wrong answer lives.
  if (/\b(while|for)\s*\(/.test(t) || /Math\.(sqrt|pow|log|exp|atan|abs|sign)/.test(t)
      || /[+\-*/]=\s*[^=]/.test(t)) {
    return { kind: 'computation', factor: 1.6 };
  }
  // A state transition: something is being started, stopped, latched or handed over.
  if (/\b(start|stop|trip|reset|preload|setMode|resetPid|note|raise)\w*\s*\(/.test(t)) {
    return { kind: 'transition', factor: 1.4 };
  }
  if (/\breturn\b/.test(t) && lines <= 2) return { kind: 'early-return', factor: 0.7 };
  return { kind: 'branch', factor: 1 };
}

/**
 * Turn the raw V8 result into scored findings.
 * @param {object[]} scripts the `Profiler.takePreciseCoverage` result
 * @returns {{findings:object[], files:object[]}} the findings and a per-file roll-up
 */
function analyse(scripts) {
  const findings = [];
  const files = [];

  for (const script of scripts) {
    const url = script.url.replace(/\\/g, '/');
    if (!url.startsWith('file:')) continue;
    if (!INCLUDE.some((frag) => url.includes(frag))) continue;

    let src;
    try {
      src = readFileSync(fileURLToPath(script.url), 'utf8');
    } catch {
      continue;
    }
    const idx = indexLines(src);
    const rel = relative(ROOT, fileURLToPath(script.url)).replace(/\\/g, '/');
    const weight = areaWeight(url);
    let total = 0;
    let missed = 0;

    for (const fn of script.functions) {
      const [root, ...blocks] = fn.ranges;
      total += fn.ranges.length;

      // A function whose own range never ran: everything inside it is dead, so it is reported
      // once rather than as one finding per block.
      if (root.count === 0) {
        missed += fn.ranges.length;
        const text = src.slice(root.startOffset, root.endOffset);
        const lines = text.split('\n').length;
        const isExport = /^\s*export\b/m.test(
          src.slice(Math.max(0, root.startOffset - 200), root.startOffset + 40),
        );
        // A whole unreached function is the worst kind of gap, because nothing inside it has
        // ever been executed even once — not even its own guards.
        const size = Math.min(3, 1 + Math.log10(Math.max(lines, 1)) * 2);
        const cls = classify(text);
        findings.push({
          file: rel,
          line: idx.lineOf(root.startOffset),
          kind: isExport ? 'never-called export' : 'never-called function',
          name: fn.functionName || '(anonymous)',
          lines,
          detail: cls.kind,
          score: 9 * size * weight * (isExport ? 1.5 : 1) * Math.max(cls.factor, 0.8),
          snippet: firstLine(text),
        });
        continue;
      }

      for (const r of blocks) {
        if (r.count !== 0) continue;
        missed += 1;
        const text = src.slice(r.startOffset, r.endOffset);
        const lines = text.split('\n').length;
        const cls = classify(text);
        const size = Math.min(2.6, 1 + Math.log10(Math.max(lines, 1)) * 1.6);
        findings.push({
          file: rel,
          line: idx.lineOf(r.startOffset),
          kind: 'unreached branch',
          name: fn.functionName || '(top level)',
          lines,
          detail: cls.kind,
          score: 6 * size * weight * cls.factor,
          snippet: firstLine(text),
        });
      }
    }
    files.push({ file: rel, total, missed, pct: total ? (1 - missed / total) * 100 : 100 });
  }

  findings.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  files.sort((a, b) => a.pct - b.pct);
  return { findings, files };
}

/**
 * The first meaningful line of a source region, trimmed for the report.
 * @param {string} text the region
 * @returns {string} one line
 */
function firstLine(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && l !== '{') || text.trim();
  return line.length > 96 ? `${line.slice(0, 93)}...` : line;
}

/**
 * The band a score falls in.
 * @param {number} score the risk score
 * @returns {string} the band name
 */
function bandOf(score) {
  for (const b of BANDS) if (score >= b.at) return b.name;
  return 'LOW';
}

// ==============================================================================================
// Report
// ==============================================================================================

/**
 * Print the ranked report.
 * @param {object[]} findings scored findings, already sorted
 * @param {object[]} files the per-file roll-up
 * @param {object} stats what the run did
 * @param {object} opts command-line options
 * @returns {void}
 */
function report(findings, files, stats, opts) {
  const out = [];
  out.push('');
  out.push('  COVERAGE BY RISK — dual-pump PID trainer');
  out.push(`  ${stats.scenes} scenes, ${stats.ticks.toLocaleString('en-US')} physics ticks, `
    + `${files.length} modules instrumented`);
  out.push('');

  const shown = opts.file ? findings.filter((f) => f.file.includes(opts.file)) : findings;
  for (const band of BANDS) {
    const rows = shown.filter((f) => bandOf(f.score) === band.name);
    if (!rows.length) continue;
    const cap = opts.all ? rows.length : Math.min(rows.length, band.name === 'LOW' ? 8 : 24);
    out.push(`  ${band.name}  (${rows.length})`);
    out.push('  ' + '-'.repeat(94));
    for (const f of rows.slice(0, cap)) {
      out.push(`  ${f.score.toFixed(0).padStart(3)}  ${`${f.file}:${f.line}`.padEnd(34)} `
        + `${f.kind.padEnd(22)} ${f.detail.padEnd(12)} ${f.lines}L`);
      out.push(`       ${f.snippet}`);
    }
    if (cap < rows.length) out.push(`       ... and ${rows.length - cap} more (--all to list)`);
    out.push('');
  }

  out.push('  BY MODULE — block ranges reached, worst first');
  out.push('  ' + '-'.repeat(94));
  for (const f of files) {
    const bar = '#'.repeat(Math.round(f.pct / 4)).padEnd(25, '.');
    out.push(`  ${bar} ${f.pct.toFixed(1).padStart(5)}%  ${f.file}  (${f.missed}/${f.total} unreached)`);
  }
  out.push('');
  process.stdout.write(`${out.join('\n')}\n`);
}

/**
 * Parse the command line.
 * @param {string[]} argv the arguments after the script name
 * @returns {{all:boolean, json:string|null, file:string|null}} the options
 */
function parseArgs(argv) {
  const opts = { all: false, json: null, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--all') opts.all = true;
    else if (argv[i] === '--json') { i += 1; opts.json = argv[i]; }
    else if (argv[i] === '--file') { i += 1; opts.file = argv[i]; }
  }
  return opts;
}

/**
 * Entry point. Guarded like every other one in this repo: it reports rather than throws.
 * @returns {Promise<void>} when the report has been written
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { result, value } = await collect(exercise);
  const { findings, files } = analyse(result);
  report(findings, files, value, opts);
  if (opts.json) {
    writeFileSync(opts.json, `${JSON.stringify({ stats: value, files, findings }, null, 2)}\n`);
    process.stdout.write(`  written to ${opts.json}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`coverage run failed: ${err && err.stack}\n`);
  process.exitCode = 1;
});
