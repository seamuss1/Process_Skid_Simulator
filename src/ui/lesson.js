/**
 * src/ui/lesson.js — the curriculum: pick an exercise, read the brief, watch the objectives tick
 * over, and get the debrief when it is done.
 *
 * Layer L6. Reads `ctx.lessons` and starts and ends lessons through the bound actions.
 *
 * ------------------------------------------------------------------------------------------
 * The design rule for this page is that it never says "well done" without saying what for. Every
 * objective is a measurable condition on the running plant, it is shown with the number it is
 * being judged against, and when it is not met there is a hint that names the knob rather than
 * the concept. A trainer that congratulates you for something it cannot describe teaches nothing.
 * ------------------------------------------------------------------------------------------
 */

import { h, setText, cls, num, dur } from './dom.js';
import { LESSONS, OBJ } from '../control/lessons.js';

/**
 * Build the lesson view.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {{el:HTMLElement, update:Function}} the view
 */
export function createLesson(ctx, A) {
  const list = h('div', { class: 'lessons__list' });
  const detail = h('div', { class: 'lessons__detail' });
  const el = h('div', { class: 'lessons' }, list, detail);

  const cards = LESSONS.map((def, i) => {
    const badge = h('span', { class: 'lesson__badge', text: String(i + 1) });
    const check = h('span', { class: 'lesson__check', text: '' });
    const card = h('button', {
      class: 'lesson', type: 'button', title: def.blurb,
      onClick: () => A.beginLesson(def.id),
    },
    h('div', { class: 'lesson__top' }, badge, h('b', { class: 'lesson__title', text: def.title }), check),
    h('div', { class: 'lesson__blurb', text: def.blurb }),
    h('div', { class: 'lesson__meta', text: `${def.minutes} min · ${def.objectives.filter((o) => o.mode !== OBJ.NEVER).length} objectives` }));
    return { def, card, check };
  });
  list.append(...cards.map((c) => c.card));

  let shownId = null;
  const title = h('h2', { class: 'brief__title' });
  const brief = h('div', { class: 'brief__body' });
  const objs = h('div', { class: 'brief__objs' });
  const debrief = h('div', { class: 'brief__debrief', hidden: true });
  const bar = h('div', { class: 'brief__bar' }, h('i', { class: 'brief__fill' }));
  const btnEnd = h('button', { class: 'btn', type: 'button', text: 'Leave lesson', onClick: () => A.endLesson() });
  const idle = h('div', { class: 'brief__idle' },
    h('h2', { class: 'brief__title', text: 'Guided exercises' }),
    h('p', { class: 'brief__body', text:
      'Fourteen exercises, in order. Each one arranges the rig so that a particular thing goes '
      + 'wrong, says what "fixed" means in numbers, and watches until it is. Several of them '
      + 'cannot be passed by tuning at all — recognising those is most of the job.' }),
    h('p', { class: 'brief__body', text:
      'Starting a lesson resets the tuning, the sequence and the plant disturbances to their '
      + 'defaults first, so nothing you did earlier is holding the answer. Leaving one puts them '
      + 'back again.' }));
  const running = h('div', { class: 'brief' }, title, bar, brief, objs, debrief, btnEnd);
  detail.append(idle, running);

  /**
   * Repaint.
   * @returns {void}
   */
  function update() {
    const ls = ctx.lessons;
    for (const c of cards) {
      cls(c.card, 'is-on', ls.def === c.def);
      const done = ls.completed.has(c.def.id);
      setText(c.check, done ? '✓' : '');
      cls(c.card, 'is-done', done);
    }
    idle.hidden = !!ls.def;
    running.hidden = !ls.def;
    if (!ls.def) { shownId = null; return; }

    if (shownId !== ls.def.id) {
      shownId = ls.def.id;
      setText(title, ls.def.title);
      brief.textContent = '';
      for (const para of ls.def.brief) brief.append(h('p', { class: 'brief__p', text: para }));
      objs.textContent = '';
      for (const o of ls.def.objectives) {
        const mark = h('i', { class: 'obj__mark' });
        const text = h('span', { class: 'obj__text', text: o.text });
        const hint = h('span', { class: 'obj__hint', text: o.hint || '' });
        const row = h('div', { class: `obj ${o.mode === OBJ.NEVER ? 'obj--trap' : ''}` },
          mark, h('div', { class: 'obj__body' }, text, hint));
        row.mark = mark;
        row.hint = hint;
        row.obj = o;
        objs.append(row);
      }
      setText(debrief, ls.def.debrief);
    }

    let met = 0;
    let total = 0;
    for (const row of objs.children) {
      const o = row.obj;
      const p = ls.progress[o.id];
      if (o.mode === OBJ.NEVER) {
        const tripped = ls.failed === o.text;
        setText(row.mark, tripped ? '✕' : '!');
        cls(row, 'is-failed', tripped);
        continue;
      }
      total += 1;
      if (p && p.met) {
        met += 1;
        setText(row.mark, '✓');
        cls(row, 'is-met', true);
        setText(row.hint, `met at ${dur(p.at_s)}`);
      } else {
        cls(row, 'is-met', false);
        if (o.mode === OBJ.HOLD && p && p.held_s > 0) {
          setText(row.mark, '◔');
          setText(row.hint, `holding — ${num(p.held_s, 0)} of ${o.hold_s} s`);
        } else {
          setText(row.mark, '○');
          setText(row.hint, o.hint || '');
        }
      }
    }
    bar.firstChild.style.width = `${total ? (met / total) * 100 : 0}%`;
    cls(bar, 'is-done', ls.complete);
    debrief.hidden = !ls.complete;
    setText(title, `${ls.def.title}${ls.complete ? ' — complete' : ''}`);
    cls(title, 'is-good', ls.complete);
  }

  return { el, update };
}
