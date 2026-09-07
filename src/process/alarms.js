/**
 * src/process/alarms.js — the alarm list.
 *
 * Layer L3: imports `core/util.js` and the drive states' enum. No DOM.
 *
 * Conditions are evaluated fresh every scan and then MERGED against the previous list, so that an
 * alarm which stays true keeps the time it first came in and the acknowledgement it was given.
 * Rebuilding the list from scratch each scan would reset both, and an alarm that re-announces
 * itself twice a second is an alarm an operator learns to ignore.
 *
 * Severities are ISA-ish and deliberately few: an operator can act on three levels and cannot act
 * on seven.
 */

import { DRIVE } from './motor.js';

/** Alarm severities, worst first. */
export const SEV = Object.freeze({
  /** Protect the equipment now. */
  ALARM: 'ALARM',
  /** Something is outside its normal band and will become an alarm if ignored. */
  WARN: 'WARN',
  /** Worth knowing, needs no action. */
  INFO: 'INFO',
});

/** Rank for sorting; lower is more urgent. */
const RANK = { ALARM: 0, WARN: 1, INFO: 2 };

/**
 * Allocate alarm-list state.
 * @returns {{rows:Map<string,object>, cycleMarks:number[]}} the alarm state
 */
export function createAlarmState() {
  return { rows: new Map(), cycleMarks: [] };
}

/**
 * Evaluate every condition and merge into the persistent list.
 *
 * @param {object} config frozen config
 * @param {object} pl plant state
 * @param {object} ctx controller context
 * @param {number} ctx.sp working setpoint, engineering units
 * @param {number} ctx.pv measurement, engineering units
 * @param {string} ctx.mode loop mode, for the span the deviation is judged against
 * @param {object} as alarm state (mutated)
 * @param {number} t_s simulated time, s
 * @param {number} dt_s scan period, s
 * @returns {{list:object[], worst:string|null, newly:object[]}} the sorted list, the worst active
 *   severity, and any conditions that came in on this scan
 */
export function evaluateAlarms(config, pl, ctx, as, t_s, dt_s) {
  const A = config.alarms;
  /** @type {Array<{id:string,tag:string,sev:string,message:string}>} */
  const hits = [];

  /**
   * Record a condition as present.
   * @param {string} id stable identity, so the merge can find it again
   * @param {string} tag the instrument or equipment it belongs to
   * @param {string} sev one of {@link SEV}
   * @param {string} message what an operator needs to read
   * @returns {void}
   */
  const raise = (id, tag, sev, message) => { hits.push({ id, tag, sev, message }); };

  // --- header pressure -----------------------------------------------------------------------
  const p = pl.pt_bar;
  if (p >= A.ptHH) raise('PT_HH', 'PT-101', SEV.ALARM, `header ${p.toFixed(2)} bar — HIGH HIGH (${A.ptHH})`);
  else if (p >= A.ptHI) raise('PT_HI', 'PT-101', SEV.WARN, `header ${p.toFixed(2)} bar — high (${A.ptHI})`);
  else if (p <= A.ptLL) raise('PT_LL', 'PT-101', SEV.ALARM, `header ${p.toFixed(2)} bar — LOW LOW (${A.ptLL})`);
  else if (p <= A.ptLO) raise('PT_LO', 'PT-101', SEV.WARN, `header ${p.toFixed(2)} bar — low (${A.ptLO})`);

  // --- suction tank --------------------------------------------------------------------------
  if (pl.lt_m <= A.ltLL) {
    raise('LT_LL', 'LT-101', SEV.ALARM, `TK-101 ${pl.lt_m.toFixed(2)} m — LOW LOW, pumps at risk`);
  } else if (pl.lt_m <= A.ltLO) {
    raise('LT_LO', 'LT-101', SEV.WARN, `TK-101 ${pl.lt_m.toFixed(2)} m — low`);
  }

  // --- per machine ---------------------------------------------------------------------------
  for (let i = 0; i < config.pumps.length; i += 1) {
    const pump = config.pumps[i];
    const d = pl.drv[i];
    const turning = d.n_pct > 5;

    if (d.state === DRIVE.TRIPPED) {
      raise(`TRIP_${i}`, pump.tag, SEV.ALARM, `${pump.tag} tripped — ${d.trip || 'lockout'}`);
    }
    if (turning) {
      const margin = pl.npsha_m[i] - pl.npshr_m[i];
      if (margin < 0) {
        raise(`CAV_${i}`, pump.tag, SEV.ALARM,
          `${pump.tag} CAVITATING — NPSHa ${pl.npsha_m[i].toFixed(1)} m against `
          + `${pl.npshr_m[i].toFixed(1)} m required, head down to `
          + `${(pl.cav[i] * 100).toFixed(0)}%`);
      } else if (margin < A.npshMargin_m) {
        raise(`NPSH_${i}`, pump.tag, SEV.WARN,
          `${pump.tag} suction margin ${margin.toFixed(2)} m — below the ${A.npshMargin_m} m minimum`);
      }
      if (pl.Q_m3h[i] < pump.minFlow_m3h) {
        raise(`MINQ_${i}`, pump.tag, SEV.WARN,
          pl.checkShut[i]
            ? `${pump.tag} running against a shut check valve — no flow, no cooling`
            : `${pump.tag} ${pl.Q_m3h[i].toFixed(1)} m3/h — below the `
              + `${pump.minFlow_m3h.toFixed(1)} m3/h minimum continuous flow`);
      }
      if (d.i_pct > config.drives[i].tripCurrent_pct) {
        raise(`OL_${i}`, pump.tag, SEV.WARN,
          `${pump.tag} ${d.i_pct.toFixed(0)}% FLA — overload timing out`);
      }
    }
  }

  // --- the loop itself -----------------------------------------------------------------------
  const eu = ctx.mode === 'FLOW' ? config.instruments.ft.hi_m3h : config.instruments.pt.hi_bar;
  const dev = Math.abs(ctx.sp - ctx.pv);
  const devRow = as.rows.get('DEV');
  if (dev > A.devFrac * eu) {
    const held = (devRow && devRow.pending ? devRow.pending : 0) + dt_s;
    if (held >= A.devDelay_s) {
      raise('DEV', ctx.mode === 'FLOW' ? 'FIC-101' : 'PIC-101', SEV.WARN,
        `off setpoint by ${dev.toPrecision(2)} for ${A.devDelay_s} s — the loop is not holding`);
    }
    as._devPending = held;
  } else {
    as._devPending = 0;
  }

  // --- short cycling -------------------------------------------------------------------------
  while (as.cycleMarks.length && t_s - as.cycleMarks[0] > A.cycleWindow_s) as.cycleMarks.shift();
  if (as.cycleMarks.length >= A.cycleCount) {
    raise('CYCLE', 'SEQ-101', SEV.ALARM,
      `${as.cycleMarks.length} pump starts and stops in `
      + `${Math.round(A.cycleWindow_s / 60)} min — the sequence is short-cycling`);
  }

  // --- merge -----------------------------------------------------------------------------------
  const seen = new Set();
  const newly = [];
  for (const hit of hits) {
    seen.add(hit.id);
    const prev = as.rows.get(hit.id);
    if (prev) {
      prev.sev = hit.sev;
      prev.message = hit.message;
      prev.active = true;
    } else {
      const row = { ...hit, active: true, since_s: t_s, ack: false, pending: 0 };
      as.rows.set(hit.id, row);
      newly.push(row);
    }
  }
  for (const [id, row] of as.rows) {
    if (!seen.has(id)) {
      // An unacknowledged alarm that clears itself still has to be seen, so it stays on the list
      // until it is acknowledged. An acknowledged one that clears simply goes.
      if (row.ack) as.rows.delete(id);
      else { row.active = false; row.cleared_s = row.cleared_s === undefined ? t_s : row.cleared_s; }
    } else {
      row.cleared_s = undefined;
    }
  }
  const devRow2 = as.rows.get('DEV');
  if (devRow2) devRow2.pending = as._devPending || 0;

  const list = Array.from(as.rows.values()).sort((a, b) => (
    RANK[a.sev] - RANK[b.sev] || (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.since_s - b.since_s
  ));
  let worst = null;
  for (const r of list) {
    if (!r.active) continue;
    if (worst === null || RANK[r.sev] < RANK[worst]) worst = r.sev;
  }
  return { list, worst, newly };
}

/**
 * Acknowledge every alarm currently on the list.
 * @param {object} as alarm state (mutated)
 * @returns {number} how many rows were acknowledged
 */
export function acknowledgeAll(as) {
  let n = 0;
  for (const [id, row] of as.rows) {
    if (!row.ack) { row.ack = true; n += 1; }
    if (!row.active) as.rows.delete(id);
  }
  return n;
}

/**
 * Record a pump start or stop, for the short-cycling detector.
 * @param {object} as alarm state (mutated)
 * @param {number} t_s simulated time, s
 * @returns {void}
 */
export function noteTransition(as, t_s) {
  as.cycleMarks.push(t_s);
}
