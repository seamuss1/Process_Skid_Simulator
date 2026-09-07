/**
 * src/process/alarms.js — the alarm list.
 *
 * Layer L3: imports `core/util.js` and the process enums. No DOM.
 *
 * Conditions are evaluated fresh every scan and then MERGED against the previous list, so that an
 * alarm which stays true keeps the time it first came in and the acknowledgement it was given.
 * Rebuilding the list from scratch each scan would reset both, and an alarm that re-announces
 * itself twice a second is an alarm an operator learns to ignore.
 *
 * A cleared alarm does NOT leave the list until it has been acknowledged. That is standard
 * practice and it is the only way the one upset that mattered — the one that came and went while
 * nobody was looking — ever gets seen.
 *
 * EVERY ALARM CARRIES ITS CONSEQUENCE. "P-101 vibration 5.2 mm/s" tells an operator a number.
 * "P-101 vibration 5.2 mm/s — ISO zone C, running 41% off best-efficiency flow" tells them what
 * to do about it. The second one takes one more line of code and is the difference between an
 * alarm system and a list of numbers.
 */

import { DRIVE } from './motor.js';
import { RECIRC } from './plant.js';
import { vibrationZone } from './pump.js';

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
 * Alarm groups, so the summary can say WHERE the trouble is rather than only how much of it there
 * is. An operator scanning a banner is answering "process, machine, or control?" first.
 */
export const GROUP = Object.freeze({
  PROCESS: 'PROCESS',
  MACHINE: 'MACHINE',
  ELECTRICAL: 'ELECTRICAL',
  CONTROL: 'CONTROL',
});

/**
 * Allocate alarm-list state.
 * @returns {object} the alarm state
 */
export function createAlarmState() {
  return {
    /** @type {Map<string, object>} live rows, keyed by a stable condition id */
    rows: new Map(),
    /** Simulated times of recent pump transitions, for the short-cycling detector. */
    cycleMarks: [],
    /** Chronological record of everything that came in, for the event log. */
    log: [],
    /**
     * Previous header pressure, for the surge rate detector. NaN until the first evaluation, so
     * the rig coming up from zero is not reported as a pressure transient — an alarm on the very
     * first scan of every session is how operators learn to ignore the alarm list.
     */
    lastP_bar: NaN,
    /** Seconds the deviation has been outside its band. */
    devPending_s: 0,
    /**
     * Seconds each pump has been below its minimum flow.
     *
     * Every start begins with the check valve shut and no flow at all, for as long as the drive
     * takes to make the header pressure. Alarming on that instant would put a warning on the
     * screen at every single start and every stage transition, which is the fastest way to teach
     * an operator to ignore the alarm list. The condition has to persist.
     */
    minQPending_s: [],
  };
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
 * @returns {{list:object[], worst:string|null, newly:object[], counts:object}} the sorted list,
 *   the worst active severity, conditions that came in on this scan, and per-severity counts
 */
export function evaluateAlarms(config, pl, ctx, as, t_s, dt_s) {
  const A = config.alarms;
  /** @type {Array<object>} */
  const hits = [];

  /**
   * Record a condition as present.
   * @param {string} id stable identity, so the merge can find it again
   * @param {string} tag the instrument or equipment it belongs to
   * @param {string} sev one of {@link SEV}
   * @param {string} group one of {@link GROUP}
   * @param {string} message what an operator needs to read, INCLUDING the consequence
   * @returns {void}
   */
  const raise = (id, tag, sev, group, message) => { hits.push({ id, tag, sev, group, message }); };

  // --- header pressure -----------------------------------------------------------------------
  const p = pl.pt_bar;
  if (p >= A.ptHH) {
    raise('PT_HH', 'PT-101', SEV.ALARM, GROUP.PROCESS,
      `header ${p.toFixed(2)} bar — HIGH HIGH (${A.ptHH}), relief protection is the only thing left`);
  } else if (p >= A.ptHI) {
    raise('PT_HI', 'PT-101', SEV.WARN, GROUP.PROCESS, `header ${p.toFixed(2)} bar — high (${A.ptHI})`);
  } else if (p <= A.ptLL) {
    raise('PT_LL', 'PT-101', SEV.ALARM, GROUP.PROCESS,
      `header ${p.toFixed(2)} bar — LOW LOW (${A.ptLL}), the process is not being supplied`);
  } else if (p <= A.ptLO) {
    raise('PT_LO', 'PT-101', SEV.WARN, GROUP.PROCESS, `header ${p.toFixed(2)} bar — low (${A.ptLO})`);
  }

  // --- surge ----------------------------------------------------------------------------------
  const rate = dt_s > 0 && Number.isFinite(as.lastP_bar) ? (pl.p_bar - as.lastP_bar) / dt_s : 0;
  as.lastP_bar = pl.p_bar;
  if (Math.abs(rate) > A.surgeRate_barps) {
    raise('SURGE', 'HDR-101', SEV.ALARM, GROUP.PROCESS,
      `pressure transient ${rate > 0 ? '+' : ''}${rate.toFixed(1)} bar/s — the discharge column is `
      + `being stopped by pressure. Stroke FCV-101 more slowly.`);
  }

  // --- suction tank ---------------------------------------------------------------------------
  const running = pl.drv.filter((d) => d.n_pct > 5).length;
  if (pl.lt_m <= A.ltLL) {
    raise('LT_LL', 'LT-101', SEV.ALARM, GROUP.PROCESS,
      running > 0
        ? `TK-101 ${pl.lt_m.toFixed(2)} m — LOW LOW with ${running} pump(s) running. Dry-run risk.`
        : `TK-101 ${pl.lt_m.toFixed(2)} m — LOW LOW`);
  } else if (pl.lt_m <= A.ltLO) {
    raise('LT_LO', 'LT-101', SEV.WARN, GROUP.PROCESS, `TK-101 ${pl.lt_m.toFixed(2)} m — low`);
  }

  // --- fluid ----------------------------------------------------------------------------------
  if (pl.visc.beyondScope) {
    raise('VISC_SCOPE', 'PROCESS', SEV.WARN, GROUP.PROCESS,
      `viscosity parameter B = ${pl.visc.B.toFixed(1)} is beyond the Hydraulic Institute `
      + 'correction range — the derating shown is an extrapolation');
  } else if (pl.visc.applies && pl.visc.CH < 0.9) {
    raise('VISC', 'PROCESS', SEV.INFO, GROUP.PROCESS,
      `viscous derating in force — head ${(pl.visc.CH * 100).toFixed(0)}%, `
      + `efficiency ${(pl.visc.CE * 100).toFixed(0)}% of the water curve at `
      + `${pl.fluid.nu_cSt.toFixed(1)} cSt`);
  }

  // --- per machine ----------------------------------------------------------------------------
  for (let i = 0; i < config.pumps.length; i += 1) {
    const pump = config.pumps[i];
    const eff = pl.eff[i] || pump;
    const d = pl.drv[i];
    const turning = d.n_pct > 5;
    const n = i + 1;

    if (d.state === DRIVE.TRIPPED) {
      raise(`TRIP_${i}`, pump.tag, SEV.ALARM, GROUP.ELECTRICAL,
        `${pump.tag} tripped — ${d.trip || 'lockout'}`);
    }
    if (d.thermal_pct > A.thermalWarn_pct && d.state !== DRIVE.TRIPPED) {
      raise(`THERM_${i}`, pump.tag, SEV.WARN, GROUP.ELECTRICAL,
        `${pump.tag} motor ${d.thermal_pct.toFixed(0)}% thermal capacity used — the overload will `
        + `lock out at ${config.drives[i].thermalTripPct}%`);
    }
    if (d.torqueLimited && turning) {
      raise(`TQ_${i}`, pump.tag, SEV.WARN, GROUP.ELECTRICAL,
        `VFD-10${n} on its torque limit — the acceleration ramp is a request, not a promise`);
    }

    if (turning) {
      const margin = pl.npsha_m[i] - pl.npshr_m[i];
      if (margin < 0) {
        raise(`CAV_${i}`, pump.tag, SEV.ALARM, GROUP.MACHINE,
          `${pump.tag} CAVITATING — NPSHa ${pl.npsha_m[i].toFixed(1)} m against `
          + `${pl.npshr_m[i].toFixed(1)} m required. Head down to `
          + `${(pl.cav[i] * 100).toFixed(0)}%, and the impeller is being eroded now.`);
      } else if (margin < A.npshMargin_m) {
        raise(`NPSH_${i}`, pump.tag, SEV.WARN, GROUP.MACHINE,
          `${pump.tag} suction margin ${margin.toFixed(2)} m — below the ${A.npshMargin_m} m `
          + 'minimum. Lower the temperature, clean the strainer, or raise the tank.');
      }

      const minQ = eff.minFlow_m3h * (d.n_pct / 100);
      if (as.minQPending_s[i] === undefined) as.minQPending_s[i] = 0;
      as.minQPending_s[i] = pl.Q_m3h[i] < minQ
        ? as.minQPending_s[i] + dt_s : 0;
      if (pl.Q_m3h[i] < minQ && as.minQPending_s[i] >= A.minFlowDelay_s) {
        raise(`MINQ_${i}`, pump.tag, SEV.WARN, GROUP.MACHINE,
          pl.checkShut[i]
            ? `${pump.tag} running against a shut check valve — no flow, no cooling, and every `
              + 'watt it draws is going into the casing'
            : `${pump.tag} ${pl.Q_m3h[i].toFixed(1)} m³/h — below the ${minQ.toFixed(1)} m³/h `
              + 'minimum continuous flow. Open RO-101.');
      }

      const rise = pl.Tcasing_C[i] - pl.T_tank_C;
      if (pl.Tcasing_C[i] > A.casingHigh_C) {
        raise(`TCAS_${i}`, pump.tag, SEV.ALARM, GROUP.MACHINE,
          `${pump.tag} casing ${pl.Tcasing_C[i].toFixed(0)} °C — the liquid in it is close to `
          + 'flashing. Stop the machine or restore flow through it.');
      } else if (rise > A.casingRise_K) {
        raise(`TRISE_${i}`, pump.tag, SEV.WARN, GROUP.MACHINE,
          `${pump.tag} casing ${rise.toFixed(0)} K above suction — it is heating the liquid it is `
          + 'churning rather than moving it');
      }

      const v = pl.vib_mms[i];
      const bepFrac = eff.Qbep_m3h > 0
        ? (pl.Q_m3h[i] / (d.n_pct / 100)) / eff.Qbep_m3h : 1;
      if (v > A.vibAlarm_mms) {
        raise(`VIB_${i}`, pump.tag, SEV.ALARM, GROUP.MACHINE,
          `${pump.tag} vibration ${v.toFixed(1)} mm/s — ISO zone ${vibrationZone(v)}, `
          + `running at ${(bepFrac * 100).toFixed(0)}% of best-efficiency flow`);
      } else if (v > A.vibWarn_mms) {
        raise(`VIBW_${i}`, pump.tag, SEV.WARN, GROUP.MACHINE,
          `${pump.tag} vibration ${v.toFixed(1)} mm/s — ISO zone ${vibrationZone(v)}, `
          + `running at ${(bepFrac * 100).toFixed(0)}% of best-efficiency flow`);
      }
    }

    if (pl.wear[i] > A.wearAlarm) {
      raise(`WEAR_${i}`, pump.tag, SEV.ALARM, GROUP.MACHINE,
        `${pump.tag} wear ${(pl.wear[i] * 100).toFixed(0)}% — head down `
        + `${(18 * pl.wear[i]).toFixed(0)}% and efficiency down `
        + `${(35 * pl.wear[i]).toFixed(0)}%. Overhaul.`);
    } else if (pl.wear[i] > A.wearWarn) {
      raise(`WEARW_${i}`, pump.tag, SEV.WARN, GROUP.MACHINE,
        `${pump.tag} wear ${(pl.wear[i] * 100).toFixed(0)}% — schedule an overhaul`);
    }
  }

  // --- protection defeated ---------------------------------------------------------------------
  if (pl.recircMode === RECIRC.CLOSED && running > 0) {
    raise('ARV_SHUT', 'RO-101', SEV.WARN, GROUP.MACHINE,
      'minimum-flow recirculation is shut with pumps running — the only thing protecting them '
      + 'from a low-flow excursion is the demand valve staying where it is');
  }

  // --- the loop itself -------------------------------------------------------------------------
  const eu = ctx.mode === 'FLOW' ? config.instruments.ft.hi_m3h
    : (ctx.mode === 'LEVEL' ? config.tank.height_m : config.instruments.pt.hi_bar);
  const dev = Math.abs(ctx.sp - ctx.pv);
  if (dev > A.devFrac * eu) {
    as.devPending_s += dt_s;
    if (as.devPending_s >= A.devDelay_s) {
      raise('DEV', ctx.tag || 'PIC-101', SEV.WARN, GROUP.CONTROL,
        `off setpoint by ${dev.toPrecision(2)} for ${A.devDelay_s} s — the loop is not holding`);
    }
  } else {
    as.devPending_s = 0;
  }

  // --- short cycling ----------------------------------------------------------------------------
  while (as.cycleMarks.length && t_s - as.cycleMarks[0] > A.cycleWindow_s) as.cycleMarks.shift();
  if (as.cycleMarks.length >= A.cycleCount) {
    raise('CYCLE', 'SEQ-101', SEV.ALARM, GROUP.CONTROL,
      `${as.cycleMarks.length} pump starts and stops in ${Math.round(A.cycleWindow_s / 60)} min — `
      + 'the sequence is short-cycling. Widen the hysteresis band or lengthen the timers.');
  }

  // --- merge -------------------------------------------------------------------------------------
  const seen = new Set();
  const newly = [];
  for (const hit of hits) {
    seen.add(hit.id);
    const prev = as.rows.get(hit.id);
    if (prev) {
      prev.sev = hit.sev;
      prev.message = hit.message;
      prev.active = true;
      prev.cleared_s = undefined;
    } else {
      const row = { ...hit, active: true, since_s: t_s, ack: false, cleared_s: undefined };
      as.rows.set(hit.id, row);
      as.log.push({ t_s, kind: 'IN', ...hit });
      newly.push(row);
    }
  }
  for (const [id, row] of as.rows) {
    if (seen.has(id)) continue;
    if (row.active) {
      row.active = false;
      row.cleared_s = t_s;
      as.log.push({ t_s, kind: 'OUT', id, tag: row.tag, sev: row.sev, group: row.group, message: row.message });
    }
    if (row.ack) as.rows.delete(id);
  }
  while (as.log.length > 500) as.log.shift();

  const list = Array.from(as.rows.values()).sort((a, b) => (
    RANK[a.sev] - RANK[b.sev] || (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.since_s - a.since_s
  ));
  const counts = { ALARM: 0, WARN: 0, INFO: 0, unacked: 0 };
  let worst = null;
  for (const r of list) {
    if (r.active) {
      counts[r.sev] += 1;
      if (worst === null || RANK[r.sev] < RANK[worst]) worst = r.sev;
    }
    if (!r.ack) counts.unacked += 1;
  }
  return { list, worst, newly, counts };
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
 * Acknowledge one row.
 * @param {object} as alarm state (mutated)
 * @param {string} id the row's condition id
 * @returns {boolean} whether anything changed
 */
export function acknowledge(as, id) {
  const row = as.rows.get(id);
  if (!row || row.ack) return false;
  row.ack = true;
  if (!row.active) as.rows.delete(id);
  return true;
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
