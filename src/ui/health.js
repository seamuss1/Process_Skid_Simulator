/**
 * src/ui/health.js — the reports page: loop health, the event log, and the run comparison.
 *
 * Layer L6. Reads `ctx.diag.report`, `ctx.run.events`, `ctx.alarms.log` and `ctx.runs`; writes
 * nothing except through the bound actions.
 *
 * ------------------------------------------------------------------------------------------
 * These three belong on the same page because they answer the same question at three timescales.
 * The loop-health report says what the loop is doing NOW and whether it is worth anyone's
 * attention. The event log says what happened while you were not looking. The run comparison says
 * whether the change you made last was actually an improvement — which is the one question a
 * trend can never answer, because a trend only ever shows you one run.
 * ------------------------------------------------------------------------------------------
 */

import { h, setText, cls, num, dur, clock } from './dom.js';
import { compareRuns } from '../io/export.js';

/**
 * Build the reports view.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {{el:HTMLElement, update:Function}} the view
 */
export function createHealth(ctx, A) {
  // ---- loop health ---------------------------------------------------------------------------
  const verdict = h('div', { class: 'health__verdict', text: 'gathering data' });
  const advice = h('div', { class: 'health__advice' });
  const stats = h('div', { class: 'health__stats' });
  const bars = h('div', { class: 'health__bars' });

  const harrisBar = meter('Harris index', 'How much of the achievable performance this loop is '
    + 'delivering. It compares the actual error variance against the least any controller could '
    + 'leave given the dead time. Near 1 means retuning cannot help; below 0.3 means there is a '
    + 'great deal being left on the table.');
  const shapeBar = meter('Waveform', 'The fundamental\'s share of the harmonic power in the '
    + 'measurement while it is cycling. A sine scores 1.00; a square wave — which is what a '
    + 'sticking stem produces — scores about 0.87. This is what separates a tuning problem from '
    + 'a maintenance one.');
  const stickBar = meter('Stickband', 'Output travel lost while the measurement is not moving. '
    + 'A direct measurement of stem friction, taken from the trend with nobody going outside.');
  bars.append(harrisBar.el, shapeBar.el, stickBar.el);

  const healthCard = h('section', { class: 'card' },
    h('header', { class: 'card__head' }, h('b', { text: 'LOOP HEALTH' }),
      h('span', { class: 'card__note', text: 'PIC-101' })),
    verdict, advice, stats, bars);

  // ---- events --------------------------------------------------------------------------------
  const eventList = h('div', { class: 'events' });
  const btnAck = h('button', { class: 'btn btn--sm', type: 'button', text: 'Acknowledge all', onClick: () => A.ackAlarms() });
  const eventsCard = h('section', { class: 'card' },
    h('header', { class: 'card__head' }, h('b', { text: 'EVENTS' }), btnAck),
    eventList);
  let lastEventCount = -1;

  // ---- runs ----------------------------------------------------------------------------------
  const runTable = h('div', { class: 'runs' });
  const runsCard = h('section', { class: 'card' },
    h('header', { class: 'card__head' }, h('b', { text: 'RUN COMPARISON' }),
      h('span', { class: 'card__note', text: 'every graded test, with the settings that produced it' })),
    runTable);
  let lastRunKey = '';

  const el = h('div', { class: 'reports' }, healthCard, eventsCard, runsCard);

  /**
   * Repaint.
   * @returns {void}
   */
  function update() {
    // ---- health ------------------------------------------------------------------------------
    const d = ctx.diag.report;
    if (d) {
      setText(verdict, d.verdict);
      cls(verdict, 'is-alarm', d.verdict === 'sticking final element' || d.verdict === 'oscillating');
      cls(verdict, 'is-warn', d.verdict === 'sluggish' || d.verdict === 'excessive output activity');
      cls(verdict, 'is-good', d.verdict === 'satisfactory' || d.verdict === 'near the achievable limit');
      setText(advice, d.advice);
      setText(stats,
        `${num(d.window_min, 1)} min of history · error σ ${num(d.sdPct, 2)}% of span · `
        + `bias ${num(d.bias, 4)} · ${num(d.reversalsPerMin, 0)} output reversals/min · `
        + `${num(d.travel, 0)}% total travel`
        + (d.oscillating ? ` · CYCLING at ${dur(d.period_s)}` : ''));
      harrisBar.set(d.harris, Number.isFinite(d.harris) ? num(d.harris, 2) : '—',
        d.harris > 0.6 ? 'good' : d.harris > 0.3 ? 'warn' : 'alarm');
      shapeBar.set(d.sinusoidality, Number.isFinite(d.sinusoidality) ? num(d.sinusoidality, 2) : 'not cycling',
        !Number.isFinite(d.sinusoidality) ? 'dim' : d.sinusoidality > 0.93 ? 'warn' : 'alarm');
      stickBar.set(Math.min(1, (d.stiction.stickband_pct || 0) / 10),
        d.stiction.ok ? `${num(d.stiction.stickband_pct, 2)}%` : 'not measurable',
        !d.stiction.ok ? 'dim' : d.stiction.stickband_pct > 1 ? 'alarm' : 'good');
    } else {
      setText(verdict, 'gathering data');
      setText(advice, `${num((ctx.diag.n * ctx.diag.period_s) / 60, 1)} minutes of history so far. `
        + 'The metrics need a few minutes of ordinary running before they mean anything.');
    }

    // ---- events ------------------------------------------------------------------------------
    const evs = ctx.run.events;
    if (evs.length !== lastEventCount) {
      lastEventCount = evs.length;
      eventList.textContent = '';
      for (const e of evs.slice(0, 120)) {
        eventList.append(h('div', { class: `event event--${e.kind}` },
          h('span', { class: 'event__t', text: clock(e.t_s) }),
          h('span', { class: 'event__kind', text: e.kind }),
          h('span', { class: 'event__text', text: e.text })));
      }
      if (!evs.length) {
        eventList.append(h('div', { class: 'note note--sm', text: 'Nothing has happened yet. Sequence actions, alarms, test steps, tuning results and objectives met all land here.' }));
      }
    }

    // ---- runs --------------------------------------------------------------------------------
    const key = `${ctx.runs.runs.length}:${ctx.runs.runs.map((r) => r.id).join()}`;
    if (key !== lastRunKey) {
      lastRunKey = key;
      runTable.textContent = '';
      const table = compareRuns(ctx.runs);
      if (!table.rows.length) {
        runTable.append(h('div', { class: 'note note--sm', text: 'No runs yet. Every scripted test files one automatically when it finishes, and "Grade now" files one from whatever has accumulated.' }));
        return;
      }
      if (!table.comparable) {
        runTable.append(h('div', { class: 'note note--warn', text:
          `These runs are from ${table.scenarios.length} different tests (${table.scenarios.join(', ')}). `
          + 'Numbers from different disturbances over different durations are not comparable — '
          + 'compare within one test.' }));
      }
      const head = h('div', { class: 'runs__row runs__row--head' },
        h('span', { class: 'runs__cell runs__cell--label', text: 'metric' }),
        table.rows.map((r) => h('span', { class: 'runs__cell', title: r.at },
          h('b', { text: r.label }),
          h('button', {
            class: 'runs__del', type: 'button', text: '×', title: 'Remove this run',
            onClick: () => { A.deleteRun(r.id); lastRunKey = ''; },
          }))));
      runTable.append(head);
      for (const m of table.metrics) {
        runTable.append(h('div', { class: 'runs__row' },
          h('span', { class: 'runs__cell runs__cell--label', text: `${m.label}${m.unit ? ` (${m.unit})` : ''}` }),
          table.rows.map((r) => {
            const v = m.get(r);
            const best = Number.isFinite(v) && Number.isFinite(m.best) && Math.abs(v - m.best) < 1e-9;
            return h('span', { class: `runs__cell ${best && table.comparable ? 'is-best' : ''}`,
              text: Number.isFinite(v) ? num(v, m.key === 'specific' ? 4 : 2) : '—' });
          })));
      }
      runTable.append(h('div', { class: 'runs__row runs__row--sep' }));
      const settings = [
        ['Kc', (r) => num(r.tuning.Kc, 2)],
        ['Ti (s)', (r) => (Number.isFinite(r.tuning.Ti) ? num(r.tuning.Ti, 2) : 'off')],
        ['Td (s)', (r) => num(r.tuning.Td, 2)],
        ['structure', (r) => r.structure],
        ['feedforward', (r) => (r.ff ? 'on' : 'off')],
        ['final element', (r) => r.finalElement],
        ['staging', (r) => r.criterion],
      ];
      for (const [label, get] of settings) {
        runTable.append(h('div', { class: 'runs__row' },
          h('span', { class: 'runs__cell runs__cell--label', text: label }),
          table.rows.map((r) => h('span', { class: 'runs__cell', text: get(r) }))));
      }
    }
  }

  return { el, update };
}

/**
 * A labelled 0..1 meter.
 * @param {string} label the name
 * @param {string} hint title text
 * @returns {{el:HTMLElement, set:Function}} the meter
 */
function meter(label, hint) {
  const fill = h('i', { class: 'meter__fill' });
  const val = h('b', { class: 'meter__val', text: '—' });
  const el = h('div', { class: 'meter', title: hint },
    h('div', { class: 'meter__top' }, h('span', { text: label }), val),
    h('div', { class: 'meter__bar' }, fill));
  return {
    el,
    set(frac, text, mood) {
      fill.style.width = `${Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * 100}%`;
      setText(val, text);
      for (const m of ['good', 'warn', 'alarm', 'dim']) cls(el, `is-${m}`, mood === m);
    },
  };
}
