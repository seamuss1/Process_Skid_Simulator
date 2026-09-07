/**
 * src/ui/curves.js — the head-capacity chart: pump curves, the system curve, and the point where
 * they cross.
 *
 * Layer L6: imports `ui/dom.js` and the plant's own curve sampler.
 *
 * WHY THIS CHART EARNS ITS SPACE. Everything else on the screen is a time series, and a time
 * series cannot show you WHY the loop behaves differently at 20 m3/h than at 60. This can. The
 * operating point is the intersection of what the machines can make and what the system will
 * swallow; move the demand valve and the system curve rotates about its static head; change the
 * speed and the pump curve slides down by the square of it. Watching those two lines chase each
 * other while the loop works is the fastest way to understand a variable-speed pump, and it costs
 * one small canvas.
 *
 * The curves are sampled by `process/plant.js::characteristicCurves`, which evaluates the same
 * functions the tick does — so the chart cannot drift away from the simulation it is drawing.
 */

import { h, setText, num } from './dom.js';
import { characteristicCurves } from '../process/plant.js';

/**
 * Build the curve chart.
 * @param {object} ctx the sim context
 * @returns {{el:HTMLElement, update:Function}} the view
 */
export function createCurves(ctx) {
  const canvas = h('canvas', { class: 'curves__canvas' });
  const caption = h('p', { class: 'curves__caption' });
  const el = h('div', { class: 'curves' },
    h('div', { class: 'curves__plot' }, canvas),
    h('div', { class: 'curves__legend' },
      h('span', { class: 'lg' }, h('i', { class: 'lg__line lg__line--p1' }), 'running pump(s), at speed'),
      h('span', { class: 'lg' }, h('i', { class: 'lg__line lg__line--ref' }), 'one pump / two pumps at 100%'),
      h('span', { class: 'lg' }, h('i', { class: 'lg__line lg__line--sys' }), 'system curve, at the current demand'),
      h('span', { class: 'lg' }, h('i', { class: 'lg__dot' }), 'operating point'),
      h('span', { class: 'lg' }, h('i', { class: 'lg__band' }), 'preferred operating region')),
    caption);

  const N = 140;

  /**
   * Redraw the chart.
   * @returns {void}
   */
  function update() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth;
    const chh = canvas.clientHeight;
    if (cw < 20 || chh < 20) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(chh * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const C = (n) => css.getPropertyValue(n).trim() || '#888';

    const cfg = ctx.config;
    const p = ctx.plant;
    const pump = cfg.pumps[0];
    const cur = characteristicCurves(cfg, p, N);

    const padL = 42;
    const padR = 10;
    const padT = 10;
    const padB = 26;
    const W = cw - padL - padR;
    const H = chh - padT - padB;
    if (W < 20 || H < 20) return;

    const Qmax = pump.Qmax_m3h * 2;
    const Hmax = pump.H0_m * 1.12;
    const X = (q) => padL + (q / Qmax) * W;
    const Y = (m) => padT + H - (m / Hmax) * H;

    g.clearRect(0, 0, cw, chh);
    g.fillStyle = C('--plot-bg');
    g.fillRect(0, 0, cw, chh);
    g.font = '10px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
    g.textBaseline = 'middle';

    // --- preferred operating region: 70% to 120% of best efficiency flow ----------------------
    g.fillStyle = C('--curve-band');
    const nRun = Math.max(1, (p.drv[0].n_pct > 1 ? 1 : 0) + (p.drv[1].n_pct > 1 ? 1 : 0));
    g.fillRect(X(0.7 * pump.Qbep_m3h * nRun), padT,
      X(1.2 * pump.Qbep_m3h * nRun) - X(0.7 * pump.Qbep_m3h * nRun), H);

    // --- grid --------------------------------------------------------------------------------
    g.strokeStyle = C('--plot-grid');
    g.fillStyle = C('--plot-axis');
    g.lineWidth = 1;
    g.textAlign = 'right';
    for (let m = 0; m <= Hmax; m += 20) {
      const yy = Math.round(Y(m)) + 0.5;
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(padL + W, yy); g.stroke();
      g.fillText(String(m), padL - 5, yy);
    }
    g.textAlign = 'center';
    for (let q = 0; q <= Qmax; q += 25) {
      const xx = Math.round(X(q)) + 0.5;
      g.beginPath(); g.moveTo(xx, padT); g.lineTo(xx, padT + H); g.stroke();
      g.fillText(String(q), xx, chh - padB / 2 - 2);
    }
    g.strokeStyle = C('--plot-frame');
    g.strokeRect(padL + 0.5, padT + 0.5, W - 1, H - 1);
    g.fillStyle = C('--plot-axis');
    g.textAlign = 'left';
    g.fillText('head, m', 4, padT + 6);
    g.textAlign = 'right';
    g.fillText('flow, m³/h', padL + W, chh - padB / 2 - 2);

    /**
     * Stroke a sampled curve, skipping non-finite and sub-zero-head samples.
     * @param {(j:number)=>number} qf flow at sample j
     * @param {(j:number)=>number} hf head at sample j
     * @param {string} colour CSS custom property name
     * @param {number} width line width
     * @param {number[]} dash dash pattern
     * @returns {void}
     */
    function stroke(qf, hf, colour, width, dash) {
      g.save();
      g.beginPath();
      g.rect(padL, padT, W, H);
      g.clip();
      g.strokeStyle = C(colour);
      g.lineWidth = width;
      g.setLineDash(dash);
      g.beginPath();
      let started = false;
      for (let j = 0; j < N; j += 1) {
        const m = hf(j);
        if (!Number.isFinite(m) || m < -2) { started = false; continue; }
        const x = X(qf(j));
        const y = Y(m);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
      g.restore();
    }

    // --- reference envelope: the same machines at full speed on clean cold water ---------------
    // Sampled by the plant rather than recomputed here, so the dashed line and the solid one can
    // never drift apart when the branch loss model changes. The gap between them is exactly what
    // the fluid, the fouling and the wear are costing.
    stroke((j) => cur.Q[j], (j) => cur.Href[j], '--curve-ref', 1, [3, 3]);

    // --- the live curves ---------------------------------------------------------------------
    stroke((j) => cur.Q[j], (j) => cur.Hsys[j], '--curve-sys', 1.75, [6, 4]);
    stroke((j) => cur.Q[j], (j) => cur.Hpump[j], '--curve-pump', 2, []);

    // --- best efficiency point ---------------------------------------------------------------
    const qBep = pump.Qbep_m3h * nRun;
    g.strokeStyle = C('--curve-bep');
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(Math.round(X(qBep)) + 0.5, padT);
    g.lineTo(Math.round(X(qBep)) + 0.5, padT + H);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = C('--curve-bep');
    g.textAlign = 'center';
    g.fillText('BEP', X(qBep), padT + 7);

    // --- the operating point ------------------------------------------------------------------
    const qOp = p.Qtotal_m3h;
    const hOp = p.H_m;
    if (qOp > 0.05) {
      const x = X(qOp);
      const y = Y(hOp);
      g.strokeStyle = C('--plot-cursor');
      g.lineWidth = 1;
      g.setLineDash([2, 2]);
      g.beginPath();
      g.moveTo(padL, y); g.lineTo(x, y);
      g.moveTo(x, padT + H); g.lineTo(x, y);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = C('--pen-pv');
      g.beginPath();
      g.arc(x, y, 4.5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = C('--plot-bg');
      g.lineWidth = 1.5;
      g.stroke();
    }

    const share = nRun > 0 ? qOp / nRun : 0;
    const pctBep = (share / pump.Qbep_m3h) * 100;
    setText(caption,
      `${nRun} pump${nRun === 1 ? '' : 's'} at ${num(p.drv[ctx.staging.lead].n_pct, 0)}% speed · `
      + `${num(qOp, 1)} m³/h against ${num(hOp, 1)} m · `
      + `each machine at ${num(pctBep, 0)}% of best-efficiency flow`
      + (pctBep < 70 ? ' — left of the preferred region, recirculating internally'
        : pctBep > 120 ? ' — right of the preferred region, high NPSH demand' : ''));
  }

  return { el, update };
}
