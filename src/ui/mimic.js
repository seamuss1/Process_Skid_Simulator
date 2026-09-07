/**
 * src/ui/mimic.js — the process schematic and the two machine cards under it.
 *
 * Layer L6: imports `ui/dom.js` and reads the sim context. Calls actions; writes no state.
 *
 * The schematic is drawn once as SVG and then only WRITTEN to: `update()` moves a level, changes a
 * lamp class, rewrites a number and advances a dash offset. No node is created or destroyed after
 * mount, which is what keeps a 60 fps redraw free.
 *
 * FLOW ANIMATION. Each pipe carries a dashed overlay whose offset advances by the actual flow
 * every frame, so the speed of the dashes IS the flow rate and a stopped line is visibly stopped.
 * It is the cheapest honest animation available: one attribute per pipe per frame, and it cannot
 * disagree with the physics because it is driven from the same number the readout shows.
 */

import { h, s, setText, setAttr, cls, num, readout } from './dom.js';
import { DRIVE } from '../process/motor.js';
import { HAND } from '../control/staging.js';

/** Geometry of the schematic, in viewBox units. Named so the paths below read as a drawing. */
const G = {
  tankX: 24, tankY: 44, tankW: 96, tankH: 164,
  sucX: 168,
  pumpAX: 300, pumpAY: 78,
  pumpBX: 300, pumpBY: 196,
  pumpR: 22,
  disX: 400,
  hdrY: 137,
  hdrEnd: 740,
  bypY: 236,
};

/**
 * An ISA instrument balloon with its tag on two lines.
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {string} letters the functional letters, e.g. 'PT'
 * @param {string} loop the loop number, e.g. '101'
 * @returns {SVGElement} the balloon group
 */
function balloon(cx, cy, letters, loop) {
  return s('g', { class: 'sym-balloon' },
    s('circle', { cx, cy, r: 16, class: 'balloon__body' }),
    s('line', { x1: cx - 16, y1: cy, x2: cx + 16, y2: cy, class: 'balloon__rule' }),
    s('text', { x: cx, y: cy - 3, class: 'balloon__txt', 'text-anchor': 'middle' }, letters),
    s('text', { x: cx, y: cy + 11, class: 'balloon__txt', 'text-anchor': 'middle' }, loop));
}

/**
 * A valve bowtie.
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {number} [w=13] half width
 * @param {number} [hh=11] half height
 * @param {string} [klass=''] extra class
 * @returns {SVGElement} the bowtie path
 */
function bowtie(cx, cy, w = 13, hh = 11, klass = '') {
  return s('path', {
    class: `sym-valve ${klass}`,
    d: `M${cx - w} ${cy - hh} L${cx - w} ${cy + hh} L${cx + w} ${cy - hh} L${cx + w} ${cy + hh} Z`,
  });
}

/**
 * Build the schematic.
 * @param {object} ctx the sim context
 * @returns {{el:SVGElement, refs:object}} the SVG and the nodes `update` writes to
 */
function buildSvg(ctx) {
  const refs = {};
  const cfg = ctx.config;

  /**
   * A pipe run: a static casing plus a dashed overlay that carries the flow animation.
   * @param {string} d the path data
   * @param {string} key name under which the overlay is stored in `refs.flow`
   * @returns {SVGElement[]} the two paths
   */
  const pipe = (d, key) => {
    const over = s('path', { class: 'pipe__flow', d });
    refs.flow[key] = over;
    return [s('path', { class: 'pipe', d }), over];
  };
  refs.flow = {};

  const pumpSym = (cx, cy, idx) => {
    const g = s('g', { class: 'sym-pump', dataset: { pump: idx } });
    g.appendChild(s('path', {
      class: 'pump__base',
      d: `M${cx - 24} ${cy + 22} L${cx + 24} ${cy + 22} L${cx + 20} ${cy + 30} L${cx - 20} ${cy + 30} Z`,
    }));
    g.appendChild(s('circle', { cx, cy, r: G.pumpR, class: 'pump__body' }));
    g.appendChild(s('path', {
      class: 'pump__vane',
      d: `M${cx - 9} ${cy - 11} L${cx + 12} ${cy} L${cx - 9} ${cy + 11} Z`,
    }));
    refs[`pumpBody${idx}`] = g;
    return g;
  };

  const svg = s('svg', {
    class: 'mimic__svg', viewBox: '0 0 800 268', preserveAspectRatio: 'xMidYMid meet',
    role: 'img', 'aria-label': 'Dual pump skid process schematic',
  },
    // Equipment bodies take a real SVG gradient: `fill` cannot use the CSS linear-gradient()
    // that --surface-equip carries, and an invalid paint silently renders black.
    s('defs', null,
      s('linearGradient', { id: 'equipGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
        s('stop', { offset: '0', 'stop-color': 'var(--equip-top)' }),
        s('stop', { offset: '1', 'stop-color': 'var(--equip-bot)' }))),

    // ---- pipework, drawn first so every symbol sits on top of it -----------------------------
    pipe(`M${G.tankX + G.tankW} 196 H${G.sucX} V${G.pumpAY} H${G.pumpAX - G.pumpR}`, 'sucA'),
    pipe(`M${G.sucX} 196 H${G.pumpBX - G.pumpR}`, 'sucB'),
    pipe(`M${G.pumpAX + G.pumpR} ${G.pumpAY} H${G.disX}`, 'disA'),
    pipe(`M${G.pumpBX + G.pumpR} ${G.pumpBY} H${G.disX}`, 'disB'),
    pipe(`M${G.disX} ${G.pumpAY} V${G.pumpBY}`, 'manifold'),
    pipe(`M${G.disX} ${G.hdrY} H${G.hdrEnd}`, 'header'),
    pipe(`M430 ${G.hdrY} V${G.bypY} H72 V${G.tankY + G.tankH}`, 'bypass'),
    s('path', { class: 'pipe pipe--stub', d: `M500 90 V${G.hdrY}` }),

    // ---- tank -----------------------------------------------------------------------------
    s('g', { class: 'sym-tank' },
      s('rect', {
        x: G.tankX, y: G.tankY, width: G.tankW, height: G.tankH, rx: 4, class: 'tank__body',
      }),
      s('rect', { x: G.tankX + 2, y: G.tankY + 2, width: 8, height: G.tankH - 4, class: 'tank__spec' }),
      (refs.tankFill = s('rect', {
        x: G.tankX + 1, y: G.tankY + 1, width: G.tankW - 2, height: 1, class: 'tank__fill',
      })),
      (refs.tankLoLo = s('line', {
        x1: G.tankX, x2: G.tankX + G.tankW, y1: 0, y2: 0, class: 'tank__mark tank__mark--ll',
      })),
      (refs.tankLo = s('line', {
        x1: G.tankX, x2: G.tankX + G.tankW, y1: 0, y2: 0, class: 'tank__mark',
      })),
      s('rect', {
        x: G.tankX, y: G.tankY, width: G.tankW, height: G.tankH, rx: 4, class: 'tank__glass',
      }),
      s('text', { x: G.tankX + G.tankW / 2, y: G.tankY - 10, class: 'tag', 'text-anchor': 'middle' },
        cfg.tank.tag)),
    s('line', { x1: G.tankX + G.tankW, y1: 62, x2: 134, y2: 62, class: 'lead' }),
    balloon(150, 62, 'LT', '101'),

    // ---- strainers ------------------------------------------------------------------------
    s('g', { class: 'sym-strainer' },
      s('path', { class: 'strainer', d: 'M212 66 h26 v24 h-26 z' }),
      s('path', { class: 'strainer__mesh', d: 'M214 90 L238 66 M218 90 L238 70 M214 86 L234 66' }),
      s('text', { x: 225, y: 58, class: 'tag tag--sm', 'text-anchor': 'middle' }, 'STR-101')),
    s('g', { class: 'sym-strainer' },
      s('path', { class: 'strainer', d: 'M212 184 h26 v24 h-26 z' }),
      s('path', { class: 'strainer__mesh', d: 'M214 208 L238 184 M218 208 L238 188 M214 204 L234 184' }),
      s('text', { x: 225, y: 176, class: 'tag tag--sm', 'text-anchor': 'middle' }, 'STR-102')),
    (refs.foulBadge = s('text', { x: 225, y: 224, class: 'badge badge--warn', 'text-anchor': 'middle' }, '')),

    // ---- pumps ----------------------------------------------------------------------------
    pumpSym(G.pumpAX, G.pumpAY, 0),
    pumpSym(G.pumpBX, G.pumpBY, 1),
    s('text', { x: G.pumpAX, y: G.pumpAY - 32, class: 'tag', 'text-anchor': 'middle' }, cfg.pumps[0].tag),
    s('text', { x: G.pumpBX, y: G.pumpBY + 46, class: 'tag', 'text-anchor': 'middle' }, cfg.pumps[1].tag),
    (refs.lamp0 = s('circle', { cx: G.pumpAX + 26, cy: G.pumpAY - 20, r: 6, class: 'lamp' })),
    (refs.lamp1 = s('circle', { cx: G.pumpBX + 26, cy: G.pumpBY + 20, r: 6, class: 'lamp' })),

    // ---- non-return valves ------------------------------------------------------------------
    s('g', null, bowtie(356, G.pumpAY),
      (refs.nrv0 = s('path', { class: 'nrv__flap', d: 'M356 67 L364 78 L356 89' })),
      s('text', { x: 356, y: G.pumpAY - 20, class: 'tag tag--sm', 'text-anchor': 'middle' }, 'NRV-101')),
    s('g', null, bowtie(356, G.pumpBY),
      (refs.nrv1 = s('path', { class: 'nrv__flap', d: 'M356 185 L364 196 L356 207' })),
      s('text', { x: 356, y: G.pumpBY + 30, class: 'tag tag--sm', 'text-anchor': 'middle' }, 'NRV-102')),

    // ---- surge vessel -----------------------------------------------------------------------
    s('g', { class: 'sym-vessel' },
      s('rect', { x: 474, y: 22, width: 52, height: 68, rx: 22, class: 'vessel__body' }),
      (refs.vesselGas = s('path', { class: 'vessel__gas', d: 'M476 46 q26 -14 48 0 v-2 q0 -22 -24 -22 q-24 0 -24 22 z' })),
      s('rect', { x: 474, y: 22, width: 52, height: 68, rx: 22, class: 'vessel__glass' }),
      s('text', { x: 500, y: 14, class: 'tag', 'text-anchor': 'middle' }, cfg.header.tag)),

    // ---- instruments on the header ------------------------------------------------------------
    s('line', { x1: 560, y1: 82, x2: 560, y2: G.hdrY, class: 'lead' }),
    balloon(560, 66, 'PT', '101'),
    s('line', { x1: 634, y1: 82, x2: 634, y2: G.hdrY, class: 'lead' }),
    balloon(634, 66, 'FT', '101'),

    // ---- demand valve and the process ----------------------------------------------------------
    s('g', { class: 'sym-cv' },
      s('line', { x1: 694, y1: 112, x2: 694, y2: 126, class: 'lead' }),
      s('path', { class: 'actuator', d: 'M680 100 h28 a6 6 0 0 1 6 6 v6 h-40 v-6 a6 6 0 0 1 6 -6 z' }),
      bowtie(694, G.hdrY),
      s('text', { x: 694, y: 92, class: 'tag tag--sm', 'text-anchor': 'middle' }, cfg.demandSpec.tag)),
    s('path', { class: 'arrow', d: `M${G.hdrEnd} ${G.hdrY} l0 -7 l18 7 l-18 7 z` }),
    s('text', { x: 762, y: G.hdrY - 12, class: 'tag tag--sm', 'text-anchor': 'middle' }, 'PROCESS'),

    // ---- minimum-flow recirculation --------------------------------------------------------------
    s('g', null, bowtie(250, G.bypY, 11, 9),
      s('text', { x: 250, y: G.bypY + 24, class: 'tag tag--sm', 'text-anchor': 'middle' }, cfg.bypassSpec.tag)),
    s('path', { class: 'arrow arrow--sm', d: `M150 ${G.bypY} l7 0 l-7 -6 l0 12 z` }),
    s('text', { x: 330, y: G.bypY + 24, class: 'tag tag--sm tag--dim', 'text-anchor': 'start' },
      'minimum flow'),

    // ---- live values --------------------------------------------------------------------------
    (refs.txtLevel = s('text', { x: G.tankX + G.tankW / 2, y: 232, class: 'val', 'text-anchor': 'middle' }, '')),
    (refs.txtPT = s('text', { x: 560, y: 36, class: 'val val--pv', 'text-anchor': 'middle' }, '')),
    (refs.txtFT = s('text', { x: 634, y: 36, class: 'val val--pv', 'text-anchor': 'middle' }, '')),
    (refs.txtFCV = s('text', { x: 694, y: 166, class: 'val', 'text-anchor': 'middle' }, '')),
    (refs.txtByp = s('text', { x: 250, y: G.bypY - 16, class: 'val val--sm', 'text-anchor': 'middle' }, '')),
    (refs.txtHdr = s('text', { x: 452, y: 122, class: 'val val--sm', 'text-anchor': 'middle' }, '')));

  return { el: svg, refs };
}

/**
 * Build one machine card: the detail that will not fit on the schematic, plus its hand switch.
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @param {object} actions the action surface
 * @returns {HTMLElement} the card, with `.update(ctx)` exposed
 */
function machineCard(ctx, i, actions) {
  const pump = ctx.config.pumps[i];
  const lamp = h('span', { class: 'lamp lamp--sm' });
  const state = h('span', { class: 'mc__state', text: 'STOPPED' });
  const lead = h('span', { class: 'mc__lead', text: '' });

  const bar = (label, hint) => {
    const fill = h('i', { class: 'bar__fill' });
    const val = h('span', { class: 'bar__val', text: '—' });
    const el = h('div', { class: 'bar', title: hint },
      h('span', { class: 'bar__label', text: label }),
      h('span', { class: 'bar__track' }, fill),
      val);
    el.set = (frac, text, mod) => {
      fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      setText(val, text);
      cls(fill, 'is-warn', mod === 'warn');
      cls(fill, 'is-alarm', mod === 'alarm');
    };
    return el;
  };

  const speed = bar('SPEED', 'Shaft speed as a percentage of rated. The drive maps 0..100% '
    + 'controller output onto its minimum and maximum frequency, so this is not the same number '
    + 'as CO.');
  const flow = bar('FLOW', 'Flow through this machine. Zero while its non-return valve is held '
    + 'shut by the header.');
  const amps = bar('CURRENT', 'Motor current as a percentage of full-load amps. The overload '
    + 'starts timing above the pickup.');
  const npsh = bar('NPSH MARGIN', 'NPSH available less NPSH required. Below zero the pump is '
    + 'cavitating and losing head.');

  const head = readout('HEAD', 'm', 'Head this machine is developing, after any cavitation loss.');
  const kw = readout('POWER', 'kW', 'Shaft power. A deadheaded pump still draws its windage.');
  const eta = readout('EFF', '%', 'Hydraulic efficiency. It peaks at the best-efficiency flow and '
    + 'falls away either side, which is why the operating point matters.');
  const rt = readout('RUN', 'h', 'Energised hours. Duty rotation levels this between the machines.');
  const grid = h('div', { class: 'mc__grid' }, head, kw, eta, rt);

  const seg = h('div', { class: 'seg seg--sm' },
    h('button', { class: 'seg__btn', type: 'button', text: 'HAND', title: 'Force this machine to run',
      onClick: () => actions.startPump(i) }),
    h('button', { class: 'seg__btn', type: 'button', text: 'AUTO', title: 'Give it back to the sequence',
      onClick: () => actions.autoPump(i) }),
    h('button', { class: 'seg__btn', type: 'button', text: 'OFF', title: 'Lock it out; the sequence stages around it',
      onClick: () => actions.stopPump(i) }));
  const btnReset = h('button', {
    class: 'btn btn--sm', type: 'button', text: 'RESET', hidden: true,
    title: 'Clear the overload lockout',
    onClick: () => actions.resetPump(i),
  });
  const btnTrip = h('button', {
    class: 'btn btn--sm btn--ghost', type: 'button', text: 'TRIP',
    title: 'Inject a fault, to watch the sequence lose a machine',
    onClick: () => actions.forceTrip(i),
  });

  const card = h('div', { class: 'mc' },
    h('div', { class: 'mc__head' },
      lamp, h('b', { class: 'mc__tag', text: pump.tag }), state, lead,
      h('span', { class: 'mc__spacer' }), btnReset, btnTrip),
    speed, flow, amps, npsh, grid,
    h('div', { class: 'mc__foot' }, seg));

  card.update = () => {
    const d = ctx.plant.drv[i];
    const running = d.state === DRIVE.RUNNING;
    const p = ctx.plant;
    cls(lamp, 'is-run', running && d.n_pct > 1);
    cls(lamp, 'is-warn', d.state === DRIVE.STARTING || d.state === DRIVE.STOPPING);
    cls(lamp, 'is-alarm', d.state === DRIVE.TRIPPED);
    setText(state, d.state === DRIVE.TRIPPED ? 'TRIPPED' : d.state);
    cls(state, 'is-alarm', d.state === DRIVE.TRIPPED);
    setText(lead, ctx.staging.lead === i ? 'LEAD' : (running ? 'LAG' : ''));
    btnReset.hidden = d.state !== DRIVE.TRIPPED;
    btnTrip.hidden = d.state === DRIVE.TRIPPED;

    // A machine at rest has no duty, and a card that keeps drawing one invites an operator to
    // read a healthy suction margin off a pump that is not turning. Everything the shaft has to
    // be moving for reads as absent instead.
    const turning = d.n_pct > 1;
    speed.set(d.n_pct / 100, `${num(d.n_pct, 1)}%`);
    flow.set(turning ? p.Q_m3h[i] / (pump.Qbep_m3h * 1.6) : 0,
      turning ? `${num(p.Q_m3h[i], 1)} m³/h` : '—',
      turning && p.Q_m3h[i] < pump.minFlow_m3h ? 'warn' : '');
    const iPct = d.i_pct;
    amps.set(iPct / 130, iPct > 0.5 ? `${num(iPct, 0)}%` : '—',
      iPct > ctx.config.drives[i].tripCurrent_pct ? 'alarm' : (iPct > 100 ? 'warn' : ''));
    const m = p.npsha_m[i] - p.npshr_m[i];
    npsh.set(turning ? m / 12 : 0, turning ? `${num(m, 2)} m` : '—',
      turning ? (m < 0 ? 'alarm' : (m < ctx.config.alarms.npshMargin_m ? 'warn' : '')) : '');

    head.set(turning ? num(p.Hp_m[i], 1) : '—', turning ? '' : 'off');
    kw.set(turning ? num(p.P_kW[i], 2) : '—', turning ? '' : 'off');
    eta.set(turning && p.Q_m3h[i] > 0 ? num(p.eta[i] * 100, 0) : '—', turning ? '' : 'off');
    rt.set(num(d.runtime_h, 2));

    const hand = ctx.staging.hand[i];
    const btns = seg.querySelectorAll('.seg__btn');
    cls(btns[0], 'is-on', hand === HAND.HAND);
    cls(btns[1], 'is-on', hand === HAND.AUTO);
    cls(btns[2], 'is-on', hand === HAND.OFF);
  };
  return card;
}

/**
 * Build the mimic panel: the schematic over the two machine cards.
 * @param {object} ctx the sim context
 * @param {object} actions the action surface
 * @returns {{el:HTMLElement, update:Function}} the view
 */
export function createMimic(ctx, actions) {
  const { el: svg, refs } = buildSvg(ctx);
  const cards = [machineCard(ctx, 0, actions), machineCard(ctx, 1, actions)];
  const el = h('div', { class: 'mimic' },
    h('div', { class: 'mimic__stage' }, svg),
    h('div', { class: 'mimic__cards' }, cards));

  // Dash offsets accumulate across frames, so the animation is continuous rather than restarting.
  const off = { sucA: 0, sucB: 0, disA: 0, disB: 0, manifold: 0, header: 0, bypass: 0 };
  let lastT = ctx.run.t_s;

  const setFlow = (key, Q_m3h, dt) => {
    const node = refs.flow[key];
    if (!node) return;
    const moving = Math.abs(Q_m3h) > 0.05;
    cls(node, 'is-moving', moving);
    if (!moving) return;
    // 1 m3/h advances the dash pattern by 0.9 viewBox units per simulated second: fast enough to
    // read as motion at 20 m3/h, slow enough not to strobe at 140.
    off[key] -= Q_m3h * 0.9 * dt;
    setAttr(node, 'stroke-dashoffset', off[key].toFixed(1));
  };

  /**
   * Write the current state onto the schematic.
   * @returns {void}
   */
  function update() {
    const p = ctx.plant;
    const cfg = ctx.config;
    const dt = Math.max(0, Math.min(ctx.run.t_s - lastT, 1));
    lastT = ctx.run.t_s;

    // --- tank -------------------------------------------------------------------------------
    const frac = Math.max(0, Math.min(1, p.level_m / cfg.tank.height_m));
    const fh = Math.max(1, frac * (G.tankH - 2));
    setAttr(refs.tankFill, 'y', (G.tankY + 1 + (G.tankH - 2 - fh)).toFixed(1));
    setAttr(refs.tankFill, 'height', fh.toFixed(1));
    cls(refs.tankFill, 'is-low', p.level_m <= cfg.alarms.ltLO);
    cls(refs.tankFill, 'is-alarm', p.level_m <= cfg.alarms.ltLL);
    const markY = (lvl) => G.tankY + 1 + (G.tankH - 2) * (1 - lvl / cfg.tank.height_m);
    setAttr(refs.tankLo, 'y1', markY(cfg.alarms.ltLO).toFixed(1));
    setAttr(refs.tankLo, 'y2', markY(cfg.alarms.ltLO).toFixed(1));
    setAttr(refs.tankLoLo, 'y1', markY(cfg.alarms.ltLL).toFixed(1));
    setAttr(refs.tankLoLo, 'y2', markY(cfg.alarms.ltLL).toFixed(1));
    setText(refs.txtLevel, `${num(p.level_m, 2)} m   ${num(p.T_C, 0)} °C`);

    // --- pumps and their check valves ------------------------------------------------------
    for (let i = 0; i < 2; i += 1) {
      const d = p.drv[i];
      const spinning = d.n_pct > 1;
      cls(refs[`pumpBody${i}`], 'is-run', spinning);
      cls(refs[`pumpBody${i}`], 'is-cav', spinning && p.cav[i] < 0.999);
      cls(refs[`pumpBody${i}`], 'is-trip', d.state === DRIVE.TRIPPED);
      const lamp = refs[`lamp${i}`];
      cls(lamp, 'is-run', d.state === DRIVE.RUNNING && spinning);
      cls(lamp, 'is-warn', d.state === DRIVE.STARTING || d.state === DRIVE.STOPPING);
      cls(lamp, 'is-alarm', d.state === DRIVE.TRIPPED);
      cls(refs[`nrv${i}`], 'is-shut', !!p.checkShut[i]);
    }

    // --- flows -------------------------------------------------------------------------------
    setFlow('sucA', p.Q_m3h[0], dt);
    setFlow('sucB', p.Q_m3h[1], dt);
    setFlow('disA', p.Q_m3h[0], dt);
    setFlow('disB', p.Q_m3h[1], dt);
    setFlow('manifold', p.Q_m3h[1], dt);
    setFlow('header', p.Qdemand_m3h, dt);
    setFlow('bypass', p.Qbypass_m3h, dt);

    // --- readouts ----------------------------------------------------------------------------
    setText(refs.txtPT, `${num(p.pt_bar, 2)} bar`);
    setText(refs.txtFT, `${num(p.ft_m3h, 1)} m³/h`);
    setText(refs.txtFCV, `FCV ${num(p.fcv * 100, 0)}%`);
    setText(refs.txtByp, `${num(p.Qbypass_m3h, 1)} m³/h`);
    setText(refs.txtHdr, `${num(p.H_m, 1)} m head`);
    setText(refs.foulBadge, p.foul > 0.02 ? `${num(p.foul * 100, 0)}% blinded` : '');

    // The bladder's gas volume shrinks as the header rises. Boyle's law, drawn.
    const pAbs = p.pt_bar + 1.013;
    const gasFrac = Math.max(0.22, Math.min(1, 1.6 / pAbs));
    setAttr(refs.vesselGas, 'transform', `translate(500 22) scale(1 ${gasFrac.toFixed(3)}) translate(-500 -22)`);

    for (const c of cards) c.update();
  }

  return { el, update };
}
