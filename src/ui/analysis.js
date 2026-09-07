/**
 * src/ui/analysis.js — the frequency-domain view: Bode, Nyquist, and the closed-loop step this
 * tuning is predicted to give.
 *
 * Layer L6. Draws from `ctx.margins`, `ctx.model` and `ctx.prediction`, which `core/sim.js`
 * recomputes whenever the tuning or the model changes. Writes nothing.
 *
 * ------------------------------------------------------------------------------------------
 * WHY LOOK AT A LOOP THIS WAY AT ALL
 *
 * A trend tells you what happened to the one disturbance you happened to get. A frequency
 * response tells you what would happen to any of them, and it does it in a form where the two
 * questions that actually matter — how fast, and how much margin — are two numbers you can read
 * off the chart.
 *
 * The three curves are chosen so that between them they answer everything:
 *
 *   |L|, the OPEN LOOP. Where it crosses 1 is the loop's bandwidth: disturbances slower than that
 *        get rejected, faster ones do not. How much phase is left at that point is the phase
 *        margin, and how much gain is left where the phase reaches -180 is the gain margin.
 *   |S|, the SENSITIVITY. Its peak is Ms, and 1/Ms is the shortest distance from the Nyquist
 *        curve to the point where the loop would be unstable — the single best one-number summary
 *        of robustness there is. Below 1 the loop is REDUCING a disturbance; above 1, and every
 *        loop has such a band, it is making it worse.
 *   |T|, the COMPLEMENTARY SENSITIVITY. What the measurement does with the setpoint, and equally
 *        what it does with measurement noise. S + T = 1 exactly, everywhere, always: you cannot
 *        make a loop both insensitive to disturbances and deaf to noise at the same frequency,
 *        and that is not an engineering limitation but an algebraic identity.
 * ------------------------------------------------------------------------------------------
 */

import { h, setText, num, cls } from './dom.js';

/**
 * Build the analysis view.
 * @param {object} ctx the sim context
 * @returns {{el:HTMLElement, update:Function}} the view
 */
export function createAnalysis(ctx) {
  const canvas = h('canvas', { class: 'plot plot--bode' });
  const caption = h('div', { class: 'plot__caption' });
  const el = h('div', { class: 'analysis' }, canvas, caption);
  let mode = 'BODE';

  /**
   * Switch between the Bode and Nyquist presentations.
   * @param {string} m 'BODE' or 'NYQUIST'
   * @returns {void}
   */
  el.setMode = (m) => { mode = m; };

  /**
   * Repaint.
   * @returns {void}
   */
  function update() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const cw = Math.max(80, Math.round(rect.width));
    const ch = Math.max(80, Math.round(rect.height));
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
    g.font = '10px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
    g.textBaseline = 'middle';

    if (!ctx.margins || !ctx.margins._response) {
      g.fillStyle = C('--plot-axis');
      g.textAlign = 'center';
      g.fillText('No process model yet.', cw / 2, ch / 2 - 10);
      g.fillText('Run a step test or a frequency sweep from the TUNE tab.', cw / 2, ch / 2 + 6);
      setText(caption, 'Every number on this page comes from a model of the process. Identify one '
        + 'first — the step test is the quickest, the sweep is the most honest.');
      return;
    }

    if (mode === 'NYQUIST') drawNyquist(g, cw, ch, C, ctx);
    else drawBode(g, cw, ch, C, ctx);

    const m = ctx.margins;
    const p = ctx.prediction;
    setText(caption,
      `GM ${num(m.gm_dB, 1)} dB · PM ${num(m.pm_deg, 0)}° · Ms ${num(m.ms, 2)} · `
      + `bandwidth ${num(m.wgc, 3)} rad/s · delay margin ${num(m.delayMargin_s, 2)} s   —   ${m.verdict}`
      + (p ? `.  Predicted on this model: ${num(p.overshootPct, 0)}% overshoot, settles in `
        + `${num(p.settle_s, 0)} s, ${num(p.travel, 0)}% of output travel.` : ''));
    cls(caption, 'is-alarm', !m.stable);
    cls(caption, 'is-warn', m.stable && m.ms > 2.0);
  }

  return { el, update };
}

/**
 * Draw the Bode magnitude and phase, with the predicted step response beneath.
 * @param {CanvasRenderingContext2D} g the context
 * @param {number} cw canvas width, CSS px
 * @param {number} ch canvas height, CSS px
 * @param {(n:string)=>string} C palette lookup
 * @param {object} ctx the sim context
 * @returns {void}
 */
function drawBode(g, cw, ch, C, ctx) {
  const r = ctx.margins._response;
  const m = ctx.margins;
  const padL = 46;
  const padR = 12;
  const gap = 30;
  const usable = ch - 40 - gap;
  const magH = Math.round(usable * 0.58);
  const phH = usable - magH;
  const W = cw - padL - padR;

  const wLo = r.w[0];
  const wHi = r.w[r.w.length - 1];
  const lx = (w) => padL + ((Math.log10(w) - Math.log10(wLo)) / (Math.log10(wHi) - Math.log10(wLo))) * W;

  // ---- magnitude -----------------------------------------------------------------------------
  const dbLo = -40;
  const dbHi = 40;
  const my = (db) => 14 + magH - ((db - dbLo) / (dbHi - dbLo)) * magH;
  frame(g, C, padL, 14, W, magH);
  g.strokeStyle = C('--plot-grid');
  g.fillStyle = C('--plot-axis');
  g.textAlign = 'right';
  for (let db = dbLo; db <= dbHi; db += 20) {
    const y = Math.round(my(db)) + 0.5;
    line(g, padL, y, padL + W, y);
    g.fillText(`${db}`, padL - 5, y);
  }
  decades(g, C, lx, wLo, wHi, 14, magH);
  // 0 dB is the line that matters: where |L| crosses it is the loop's bandwidth.
  g.strokeStyle = C('--plot-cursor');
  g.setLineDash([3, 3]);
  line(g, padL, Math.round(my(0)) + 0.5, padL + W, Math.round(my(0)) + 0.5);
  g.setLineDash([]);

  curve(g, r.w, r.magL, lx, (v) => my(20 * Math.log10(Math.max(v, 1e-9))), C('--pen-pv'), 2);
  curve(g, r.w, r.magS, lx, (v) => my(20 * Math.log10(Math.max(v, 1e-9))), C('--pen-sp'), 1.3);
  curve(g, r.w, r.magT, lx, (v) => my(20 * Math.log10(Math.max(v, 1e-9))), C('--pen-co'), 1.3);

  g.textAlign = 'left';
  g.fillStyle = C('--pen-pv');
  g.fillText('|L| open loop', padL + 6, 24);
  g.fillStyle = C('--pen-sp');
  g.fillText('|S| sensitivity', padL + 6, 36);
  g.fillStyle = C('--pen-co');
  g.fillText('|T| noise path', padL + 6, 48);

  // Measured sweep points, when one has been run: the model is a fit, and this is what it fitted.
  if (ctx.sweep.points.length) {
    g.fillStyle = C('--curve-bep');
    for (const pt of ctx.sweep.points) {
      if (pt.w < wLo || pt.w > wHi) continue;
      // The sweep measures the PROCESS, so multiply by the controller to compare against |L|.
      const x = lx(pt.w);
      const y = my(20 * Math.log10(Math.max(pt.mag, 1e-9)));
      g.beginPath();
      g.arc(x, y, 2.5, 0, Math.PI * 2);
      g.fill();
    }
  }

  // ---- phase ---------------------------------------------------------------------------------
  const pTop = 14 + magH + gap;
  const py = (d) => pTop + phH - ((d + 360) / 360) * phH;
  frame(g, C, padL, pTop, W, phH);
  g.strokeStyle = C('--plot-grid');
  g.fillStyle = C('--plot-axis');
  g.textAlign = 'right';
  for (let d = -360; d <= 0; d += 90) {
    const y = Math.round(py(d)) + 0.5;
    line(g, padL, y, padL + W, y);
    g.fillText(`${d}`, padL - 5, y);
  }
  decades(g, C, lx, wLo, wHi, pTop, phH);
  g.strokeStyle = C('--pen-alarm');
  g.setLineDash([3, 3]);
  line(g, padL, Math.round(py(-180)) + 0.5, padL + W, Math.round(py(-180)) + 0.5);
  g.setLineDash([]);
  curve(g, r.w, r.phaseL, lx, py, C('--pen-pv'), 2);

  // ---- the margins, marked where they are read ------------------------------------------------
  if (Number.isFinite(m.wgc)) {
    const x = Math.round(lx(m.wgc)) + 0.5;
    g.strokeStyle = C('--curve-bep');
    g.setLineDash([2, 3]);
    line(g, x, 14, x, pTop + phH);
    g.setLineDash([]);
    g.fillStyle = C('--curve-bep');
    g.textAlign = 'left';
    g.fillText(`PM ${num(m.pm_deg, 0)}°`, x + 4, py(-180) - 8);
  }
  if (Number.isFinite(m.wpc)) {
    const x = Math.round(lx(m.wpc)) + 0.5;
    g.strokeStyle = C('--pen-alarm');
    g.setLineDash([2, 3]);
    line(g, x, 14, x, pTop + phH);
    g.setLineDash([]);
    g.fillStyle = C('--pen-alarm');
    g.textAlign = 'left';
    g.fillText(`GM ${num(m.gm_dB, 1)} dB`, x + 4, my(0) + 12);
  }

  // ---- predicted step response ------------------------------------------------------------------
  g.fillStyle = C('--plot-axis');
  g.textAlign = 'center';
  g.fillText('frequency, rad/s (log)', padL + W / 2, pTop + phH + 24);
}

/**
 * Draw the Nyquist plot with the Ms circle.
 * @param {CanvasRenderingContext2D} g the context
 * @param {number} cw canvas width
 * @param {number} ch canvas height
 * @param {(n:string)=>string} C palette lookup
 * @param {object} ctx the sim context
 * @returns {void}
 */
function drawNyquist(g, cw, ch, C, ctx) {
  const r = ctx.margins._response;
  const m = ctx.margins;
  const pad = 22;
  const foot = 16;
  // The locus has to be SQUARE: the Ms circle is a circle, and a circle drawn as an ellipse
  // says nothing about distance. So it takes a square of whatever height is left after the
  // footnote, and the predicted step takes the width beside it.
  const size = Math.max(60, Math.min(ch - pad * 2 - foot, (cw - pad * 3) * 0.55));
  const cx = pad + size / 2;
  const cy = pad + size / 2;
  const span = 3;
  const sx = (v) => cx + (v / span) * (size / 2);
  const sy = (v) => cy - (v / span) * (size / 2);

  g.strokeStyle = C('--plot-grid');
  for (let v = -3; v <= 3; v += 1) {
    line(g, sx(v), sy(-span), sx(v), sy(span));
    line(g, sx(-span), sy(v), sx(span), sy(v));
  }
  g.strokeStyle = C('--plot-axis');
  line(g, sx(-span), sy(0), sx(span), sy(0));
  line(g, sx(0), sy(-span), sx(0), sy(span));
  g.strokeRect(Math.round(sx(-span)) + 0.5, Math.round(sy(span)) + 0.5,
    Math.round(size), Math.round(size));

  // The unit circle, and the Ms circle centred on -1. The closest approach of the response to
  // -1 IS 1/Ms, which is why that circle is the honest picture of robustness.
  g.strokeStyle = C('--plot-grid');
  g.setLineDash([2, 3]);
  circle(g, sx(0), sy(0), (size / 2) / span);
  g.setLineDash([]);
  if (Number.isFinite(m.ms) && m.ms > 0) {
    g.strokeStyle = C('--pen-alarm');
    g.setLineDash([4, 3]);
    circle(g, sx(-1), sy(0), ((1 / m.ms) / span) * (size / 2));
    g.setLineDash([]);
  }

  g.save();
  g.beginPath();
  g.rect(sx(-span), sy(span), size, size);
  g.clip();
  g.strokeStyle = C('--pen-pv');
  g.lineWidth = 2;
  g.beginPath();
  let started = false;
  for (let i = 0; i < r.w.length; i += 1) {
    const x = sx(r.reL[i]);
    const y = sy(r.imL[i]);
    if (Math.abs(r.reL[i]) > span * 4 || Math.abs(r.imL[i]) > span * 4) { started = false; continue; }
    if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
  }
  g.stroke();
  g.lineWidth = 1;
  g.restore();

  g.fillStyle = C('--pen-alarm');
  g.beginPath();
  g.arc(sx(-1), sy(0), 3.5, 0, Math.PI * 2);
  g.fill();
  g.textAlign = 'left';
  g.fillText('\u22121', sx(-1) + 6, sy(0) - 9);

  g.fillStyle = C('--plot-axis');
  g.fillText(`Nyquist \u00b7 1/Ms = ${num(1 / m.ms, 2)} is the shortest distance to \u22121`,
    pad, pad + size + 9);

  // The predicted step beside it, answering the same question in the time domain.
  const sx0 = pad * 2 + size;
  const sw = cw - sx0 - pad;
  if (sw > 130) drawStep(g, C, ctx, sx0, pad, sw, size);
}

/**
 * Draw the predicted closed-loop step response.
 * @param {CanvasRenderingContext2D} g the context
 * @param {(n:string)=>string} C palette lookup
 * @param {object} ctx the sim context
 * @param {number} x left edge
 * @param {number} y top edge
 * @param {number} w width
 * @param {number} hgt height
 * @returns {void}
 */
function drawStep(g, C, ctx, x, y, w, hgt) {
  const p = ctx.prediction;
  frame(g, C, x, y, w, hgt);
  if (!p) return;
  const n = p.t.length;
  const tMax = p.t[n - 1];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < n; i += 1) { lo = Math.min(lo, p.y[i]); hi = Math.max(hi, p.y[i]); }
  const pad = 0.12 * (hi - lo || 1);
  lo -= pad;
  hi += pad;
  const px = (t) => x + (t / tMax) * w;
  const py = (v) => y + hgt - ((v - lo) / (hi - lo)) * hgt;

  g.strokeStyle = C('--pen-sp');
  g.setLineDash([3, 3]);
  line(g, x, Math.round(py(1)) + 0.5, x + w, Math.round(py(1)) + 0.5);
  g.setLineDash([]);

  g.strokeStyle = C('--pen-pv');
  g.lineWidth = 1.6;
  g.beginPath();
  for (let i = 0; i < n; i += 1) {
    const xx = px(p.t[i]);
    const yy = py(p.y[i]);
    if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
  }
  g.stroke();
  g.lineWidth = 1;
  g.fillStyle = C('--plot-axis');
  g.textAlign = 'left';
  g.fillText(`predicted unit step — ${num(p.overshootPct, 0)}% overshoot, settles ${num(p.settle_s, 0)} s`,
    x + 6, y + 10);
}

/**
 * Stroke a curve over a frequency axis.
 * @param {CanvasRenderingContext2D} g the context
 * @param {Float64Array} w the frequencies
 * @param {Float64Array} v the values
 * @param {(x:number)=>number} fx x mapping
 * @param {(y:number)=>number} fy y mapping
 * @param {string} colour stroke colour
 * @param {number} width line width
 * @returns {void}
 */
function curve(g, w, v, fx, fy, colour, width) {
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  for (let i = 0; i < w.length; i += 1) {
    const x = fx(w[i]);
    const y = fy(v[i]);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.lineWidth = 1;
}

/**
 * Draw decade gridlines and their labels.
 * @param {CanvasRenderingContext2D} g the context
 * @param {(n:string)=>string} C palette lookup
 * @param {(w:number)=>number} lx the log x mapping
 * @param {number} wLo lowest frequency
 * @param {number} wHi highest frequency
 * @param {number} top top edge
 * @param {number} hgt height
 * @returns {void}
 */
function decades(g, C, lx, wLo, wHi, top, hgt) {
  g.strokeStyle = C('--plot-grid');
  g.fillStyle = C('--plot-axis');
  g.textAlign = 'center';
  for (let e = Math.floor(Math.log10(wLo)); e <= Math.ceil(Math.log10(wHi)); e += 1) {
    for (const mlt of [1, 2, 5]) {
      const w = mlt * 10 ** e;
      if (w < wLo || w > wHi) continue;
      const xx = Math.round(lx(w)) + 0.5;
      g.strokeStyle = mlt === 1 ? C('--plot-axis') : C('--plot-grid');
      line(g, xx, top, xx, top + hgt);
      if (mlt === 1) g.fillText(String(w), xx, top + hgt + 9);
    }
  }
}

/**
 * Stroke a straight line.
 * @param {CanvasRenderingContext2D} g the context
 * @param {number} x1 start x
 * @param {number} y1 start y
 * @param {number} x2 end x
 * @param {number} y2 end y
 * @returns {void}
 */
function line(g, x1, y1, x2, y2) {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}

/**
 * Stroke a circle.
 * @param {CanvasRenderingContext2D} g the context
 * @param {number} x centre x
 * @param {number} y centre y
 * @param {number} r radius
 * @returns {void}
 */
function circle(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
}

/**
 * Outline a plot area.
 * @param {CanvasRenderingContext2D} g the context
 * @param {(n:string)=>string} C palette lookup
 * @param {number} x left
 * @param {number} y top
 * @param {number} w width
 * @param {number} hgt height
 * @returns {void}
 */
function frame(g, C, x, y, w, hgt) {
  g.strokeStyle = C('--plot-axis');
  g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(hgt));
}
