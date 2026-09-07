/**
 * src/ui/trend.js — the three-lane strip chart.
 *
 * Layer L6: imports `ui/dom.js` and reads the sim context and its trend ring.
 *
 * THREE LANES, BECAUSE TUNING IS A THREE-VARIABLE ARGUMENT. The measurement against its setpoint
 * says whether the loop is holding. The output says what it cost. The machine flows say which
 * pump did it. Stacking them on a shared time axis is the whole diagnostic: an overshoot in lane
 * one that lines up with a saturation in lane two and a check valve opening in lane three is a
 * story, and three separate charts is not.
 *
 * The chart reads the ring in place — no copying — and decimates to one min/max pair per pixel
 * column, so the cost of a frame is set by the width of the canvas rather than by the length of
 * the history. Fifty minutes of five-hertz data redraws in the same time as five.
 */

import { h, setText, cls, num } from './dom.js';

/** Selectable history windows, seconds. */
export const WINDOWS = Object.freeze([60, 120, 300, 600, 1800]);

/**
 * The pens. `lane` indexes the stacked plots; `ch` names a channel of the trend ring.
 * @param {object} eu the loop's engineering-unit record
 * @returns {Array<object>} the pen definitions
 */
function pens(eu) {
  return [
    { id: 'sp', lane: 0, label: 'SP', ch: 'sp', color: '--pen-sp', dash: [7, 4], unit: eu.unit, dp: eu.dp, width: 1.5 },
    { id: 'pv', lane: 0, label: `PV · ${eu.pv}`, ch: 'pv', color: '--pen-pv', unit: eu.unit, dp: eu.dp, width: 1.75 },
    { id: 'pvTrue', lane: 0, label: 'PV actual', ch: 'pvTrue', color: '--pen-true', dash: [2, 3], unit: eu.unit, dp: eu.dp, width: 1, off: true },
    { id: 'co', lane: 1, label: 'CO', ch: 'co', color: '--pen-co', unit: '%', dp: 1, width: 1.75 },
    { id: 'n1', lane: 1, label: 'P-101 speed', ch: 'n1', color: '--pen-p1', unit: '%', dp: 0, width: 1.25 },
    { id: 'n2', lane: 1, label: 'P-102 speed', ch: 'n2', color: '--pen-p2', unit: '%', dp: 0, width: 1.25 },
    { id: 'qdem', lane: 2, label: 'FT-101 to process', ch: 'qdem', color: '--pen-q', unit: 'm³/h', dp: 1, width: 1.75 },
    { id: 'q1', lane: 2, label: 'P-101 flow', ch: 'q1', color: '--pen-p1', unit: 'm³/h', dp: 1, width: 1.25 },
    { id: 'q2', lane: 2, label: 'P-102 flow', ch: 'q2', color: '--pen-p2', unit: 'm³/h', dp: 1, width: 1.25 },
  ];
}

/** Relative heights of the three lanes. */
const LANE_SHARE = [0.42, 0.31, 0.27];

/**
 * Choose a round tick interval covering a span in about `want` steps.
 * @param {number} span the axis span
 * @param {number} want approximate tick count
 * @returns {number} the interval
 */
function niceStep(span, want) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, want);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1.5 ? 1 : n <= 3 ? 2 : n <= 7 ? 5 : 10) * mag;
}

/**
 * Build the trend view.
 * @param {object} ctx the sim context
 * @returns {{el:HTMLElement, update:Function, mark:Function}} the view
 */
export function createTrend(ctx) {
  const canvas = h('canvas', { class: 'trend__canvas' });
  const rail = h('div', { class: 'trend__rail' });
  const winBtns = h('div', { class: 'seg seg--sm trend__win' });
  const el = h('div', { class: 'trend' },
    h('div', { class: 'trend__plot' }, canvas),
    h('div', { class: 'trend__side' }, winBtns, rail));

  let window_s = 300;
  let pen = pens({ unit: 'bar', pv: 'PT-101', dp: 2 });
  let hoverX = -1;
  /** @type {Array<{t_s:number, kind:string, label:string}>} */
  const marks = [];

  const btns = new Map();
  for (const w of WINDOWS) {
    const b = h('button', {
      class: 'seg__btn', type: 'button', text: w < 3600 ? `${w / 60}m` : `${w / 3600}h`,
      title: `Show the last ${w / 60} minutes`,
      onClick: () => { window_s = w; for (const [k, x] of btns) cls(x, 'is-on', k === w); },
    });
    btns.set(w, b);
    winBtns.appendChild(b);
  }
  cls(btns.get(window_s), 'is-on', true);

  /** Pen rail rows, rebuilt only when the loop mode changes the engineering units. */
  const rows = new Map();
  const hidden = new Set(['pvTrue']);

  /**
   * (Re)build the pen rail for the current engineering units.
   * @param {object} eu the loop's EU record
   * @returns {void}
   */
  function buildRail(eu) {
    pen = pens(eu);
    rail.textContent = '';
    rows.clear();
    let lane = -1;
    for (const p of pen) {
      if (p.lane !== lane) {
        lane = p.lane;
        rail.appendChild(h('div', {
          class: 'rail__lane',
          text: ['MEASUREMENT', 'OUTPUT & SPEED', 'FLOW'][lane],
        }));
      }
      const val = h('span', { class: 'rail__val', text: '—' });
      const row = h('button', {
        class: 'rail__row', type: 'button', title: `Show or hide ${p.label}`,
        onClick: () => {
          if (hidden.has(p.id)) hidden.delete(p.id); else hidden.add(p.id);
          cls(row, 'is-off', hidden.has(p.id));
        },
      },
        h('i', { class: 'rail__swatch', style: { background: `var(${p.color})` } }),
        h('span', { class: 'rail__label', text: p.label }),
        val);
      cls(row, 'is-off', hidden.has(p.id));
      rows.set(p.id, { row, val });
      rail.appendChild(row);
    }
  }
  buildRail({ unit: 'bar', pv: 'PT-101', dp: 2 });
  let railUnit = 'bar';

  canvas.addEventListener('pointermove', (ev) => {
    const r = canvas.getBoundingClientRect();
    hoverX = ev.clientX - r.left;
  });
  canvas.addEventListener('pointerleave', () => { hoverX = -1; });

  /**
   * Record an event marker on the time axis.
   * @param {string} kind 'stage', 'alarm' or 'test'
   * @param {string} label one line
   * @returns {void}
   */
  function mark(kind, label) {
    marks.push({ t_s: ctx.run.t_s, kind, label });
    if (marks.length > 240) marks.shift();
  }

  /**
   * Redraw. Called once per animation frame.
   * @returns {void}
   */
  function update() {
    const eu = { unit: ctx.run.mode === 'FLOW' ? 'm³/h' : 'bar', pv: ctx.run.mode === 'FLOW' ? 'FT-101' : 'PT-101', dp: ctx.run.mode === 'FLOW' ? 1 : 2 };
    if (eu.unit !== railUnit) { buildRail(eu); railUnit = eu.unit; }

    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw < 8 || ch < 8) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const C = (n) => css.getPropertyValue(n).trim() || '#888';

    g.clearRect(0, 0, cw, ch);
    g.fillStyle = C('--plot-bg');
    g.fillRect(0, 0, cw, ch);

    const padL = 52;
    const padR = 8;
    const padT = 6;
    const padB = 20;
    const plotW = cw - padL - padR;
    const plotH = ch - padT - padB;
    if (plotW < 20 || plotH < 40) return;

    // --- window --------------------------------------------------------------------------
    const ring = ctx.trend;
    const period = ctx.config.trendPeriod_s;
    const nWant = Math.max(2, Math.round(window_s / period));
    const n = Math.min(ring.len, nWant);
    const start = (ring.head - n + ring.cap * 2) % ring.cap;
    const at = (name, i) => ring.data[name][(start + i) % ring.cap];
    const tEnd = n > 0 ? at('t_s', n - 1) : ctx.run.t_s;
    const tStart = tEnd - window_s;
    const xOf = (t) => padL + ((t - tStart) / window_s) * plotW;

    // --- lane geometry ---------------------------------------------------------------------
    const lanes = [];
    let y = padT;
    for (let i = 0; i < 3; i += 1) {
      const hh = plotH * LANE_SHARE[i] - (i < 2 ? 6 : 0);
      lanes.push({ y0: y, y1: y + hh });
      y += hh + 6;
    }

    // --- lane scales -------------------------------------------------------------------------
    const spanOf = (chs, floor, pad) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of chs) {
        for (let i = 0; i < n; i += 1) {
          const v = at(c, i);
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!Number.isFinite(lo)) return [0, floor];
      if (hi - lo < floor) { const m = (lo + hi) / 2; lo = m - floor / 2; hi = m + floor / 2; }
      const p = (hi - lo) * pad;
      return [lo - p, hi + p];
    };
    const isFlow = ctx.run.mode === 'FLOW';
    const laneScale = [
      spanOf(['pv', 'sp'], isFlow ? 8 : 0.4, 0.14),
      [0, 100],
      spanOf(['qdem', 'q1', 'q2'], 10, 0.1),
    ];
    laneScale[0][0] = Math.max(0, laneScale[0][0]);
    laneScale[2][0] = Math.max(0, laneScale[2][0]);
    const yOf = (lane, v) => {
      const [lo, hi] = laneScale[lane];
      const L = lanes[lane];
      return L.y1 - ((v - lo) / Math.max(hi - lo, 1e-9)) * (L.y1 - L.y0);
    };

    // --- grid and axes -------------------------------------------------------------------------
    g.font = '10px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    for (let li = 0; li < 3; li += 1) {
      const L = lanes[li];
      g.fillStyle = C('--plot-lane');
      g.fillRect(padL, L.y0, plotW, L.y1 - L.y0);
      const [lo, hi] = laneScale[li];
      const step = niceStep(hi - lo, li === 1 ? 4 : 4);
      g.strokeStyle = C('--plot-grid');
      g.lineWidth = 1;
      g.fillStyle = C('--plot-axis');
      g.textAlign = 'right';
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
        const yy = Math.round(yOf(li, v)) + 0.5;
        if (yy < L.y0 - 1 || yy > L.y1 + 1) continue;
        g.beginPath();
        g.moveTo(padL, yy);
        g.lineTo(padL + plotW, yy);
        g.stroke();
        g.fillText(num(v, step < 1 ? (step < 0.1 ? 2 : 1) : 0), padL - 6, yy);
      }
      g.strokeStyle = C('--plot-frame');
      g.strokeRect(padL + 0.5, L.y0 + 0.5, plotW - 1, L.y1 - L.y0 - 1);
    }

    // vertical time grid
    const tStep = niceStep(window_s, 6);
    g.strokeStyle = C('--plot-grid');
    g.fillStyle = C('--plot-axis');
    g.textAlign = 'center';
    // Start at zero, never at the negative times a fresh run's window reaches back into: a tick
    // labelled -1:-40 is worse than no tick at all.
    for (let t = Math.max(0, Math.ceil(tStart / tStep) * tStep); t <= tEnd; t += tStep) {
      const xx = Math.round(xOf(t)) + 0.5;
      if (xx < padL) continue;
      g.beginPath();
      g.moveTo(xx, padT);
      g.lineTo(xx, padT + plotH);
      g.stroke();
      const mm = Math.floor(t / 60);
      const ss = Math.round(t % 60);
      g.fillText(`${mm}:${String(ss).padStart(2, '0')}`, xx, ch - padB / 2 - 1);
    }

    // --- alarm limits on the measurement lane ---------------------------------------------------
    if (!isFlow) {
      const A = ctx.config.alarms;
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      for (const [v, colour] of [[A.ptHI, '--warn'], [A.ptLO, '--warn'], [A.ptHH, '--alarm'], [A.ptLL, '--alarm']]) {
        const yy = yOf(0, v);
        if (yy < lanes[0].y0 || yy > lanes[0].y1) continue;
        g.strokeStyle = C(colour);
        g.globalAlpha = 0.6;
        g.beginPath();
        g.moveTo(padL, yy);
        g.lineTo(padL + plotW, yy);
        g.stroke();
        g.globalAlpha = 1;
      }
      g.setLineDash([]);
    }

    // --- event markers -----------------------------------------------------------------------
    for (const mk of marks) {
      if (mk.t_s < tStart || mk.t_s > tEnd) continue;
      const xx = Math.round(xOf(mk.t_s)) + 0.5;
      g.strokeStyle = C(mk.kind === 'alarm' ? '--alarm' : (mk.kind === 'test' ? '--info' : '--accent'));
      g.globalAlpha = 0.55;
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(xx, padT);
      g.lineTo(xx, padT + plotH);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }

    // --- pens ----------------------------------------------------------------------------------
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const cols = Math.max(1, Math.round(plotW));
    for (const p of pen) {
      if (hidden.has(p.id)) continue;
      const L = lanes[p.lane];
      g.save();
      g.beginPath();
      g.rect(padL, L.y0, plotW, L.y1 - L.y0);
      g.clip();
      g.strokeStyle = C(p.color);
      g.lineWidth = p.width;
      g.setLineDash(p.dash || []);
      g.beginPath();
      // One min/max pair per pixel column: the shape of a fast transient survives decimation.
      let started = false;
      for (let px = 0; px < cols; px += 1) {
        const i0 = Math.floor((px * n) / cols);
        const i1 = Math.max(i0 + 1, Math.floor(((px + 1) * n) / cols));
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = i0; i < i1 && i < n; i += 1) {
          const v = at(p.ch, i);
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (!Number.isFinite(lo)) continue;
        const x = padL + px + 0.5;
        const yLo = yOf(p.lane, lo);
        const yHi = yOf(p.lane, hi);
        if (!started) { g.moveTo(x, yHi); started = true; }
        g.lineTo(x, yHi);
        if (yLo !== yHi) g.lineTo(x, yLo);
      }
      g.stroke();
      g.setLineDash([]);
      g.restore();
    }

    // --- hover cursor --------------------------------------------------------------------------
    let readIdx = n - 1;
    if (hoverX > padL && hoverX < padL + plotW && n > 1) {
      readIdx = Math.max(0, Math.min(n - 1, Math.round(((hoverX - padL) / plotW) * (n - 1))));
      const xx = Math.round(padL + (readIdx / (n - 1)) * plotW) + 0.5;
      g.strokeStyle = C('--plot-cursor');
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(xx, padT);
      g.lineTo(xx, padT + plotH);
      g.stroke();
      g.fillStyle = C('--plot-axis');
      g.textAlign = 'left';
      const tt = at('t_s', readIdx);
      g.fillText(`${Math.floor(tt / 60)}:${String(Math.round(tt % 60)).padStart(2, '0')}`,
        Math.min(xx + 4, padL + plotW - 40), padT + 8);
    }

    // --- pen rail values ---------------------------------------------------------------------
    for (const p of pen) {
      const r = rows.get(p.id);
      if (!r) continue;
      const v = n > 0 ? at(p.ch, readIdx) : NaN;
      setText(r.val, `${num(v, p.dp)} ${p.unit}`);
    }
  }

  return { el, update, mark };
}
