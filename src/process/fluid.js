/**
 * src/process/fluid.js — the pumped liquid: density, vapour pressure, viscosity and specific
 * heat, for a small library of real fluids over their usable temperature range.
 *
 * Layer L1: imports nothing. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY FOUR PROPERTIES AND NOT ONE
 *
 * A pump simulator that only knows density is a pump simulator that can only pump cold water,
 * and every interesting thing about pumping is a property effect:
 *
 *   DENSITY          turns head into pressure. A pump makes metres, not bar, and the same
 *                    machine on the same duty reads a different transmitter on hot water.
 *   VAPOUR PRESSURE  decides whether the liquid boils at the impeller eye. It is the whole of
 *                    NPSH available, and it is why a duty that is safe at 20 C cavitates at 95.
 *   VISCOSITY        derates the pump — head, flow and efficiency all fall, by the Hydraulic
 *                    Institute correction in `pump.js`. It is why an oil pump is not a water
 *                    pump with a different label, and why nobody sizes one off a water curve.
 *   SPECIFIC HEAT    sets how fast the liquid heats up when the pump is churning it instead of
 *                    moving it. That is the physical basis of minimum continuous flow, and
 *                    without it the min-flow line is an arbitrary rule instead of a consequence.
 *
 * CORRELATIONS, NOT CONSTANTS. Each fluid carries published correlations over its range rather
 * than a single room-temperature number, because the temperature slider is one of the main ways
 * to get this rig into trouble and a linear guess would put the cliff in the wrong place.
 * ------------------------------------------------------------------------------------------
 */

/**
 * Clamp a temperature into a fluid's valid range before evaluating a correlation outside the
 * data it was fitted to.
 * @param {number} T_C temperature, C
 * @param {number} lo lower bound of the correlation
 * @param {number} hi upper bound
 * @returns {number} the clamped temperature
 */
function inRange(T_C, lo, hi) {
  return T_C < lo ? lo : (T_C > hi ? hi : T_C);
}

// ---------------------------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------------------------

/**
 * Density of liquid water, kg/m3, from the Kell correlation as usually abridged for 0..100 C at
 * atmospheric pressure. Reproduces the 3.98 C maximum and reads 998.2 kg/m3 at 20 C.
 * @param {number} T_C temperature, C
 * @returns {number} density, kg/m3
 */
export function waterDensity_kgm3(T_C) {
  const T = inRange(T_C, 0, 100);
  const num = (T + 288.9414) * (T - 3.9863) * (T - 3.9863);
  const den = 508929.2 * (T + 68.12963);
  return 1000 * (1 - num / den);
}

/**
 * Vapour pressure of water, bar absolute, from the Antoine equation with the 1..100 C constant
 * set (A = 8.07131, B = 1730.63, C = 233.426, pressure in mmHg).
 *
 * This is the number that decides where cavitation starts. At 20 C it is 0.0234 bar and costs a
 * pump almost nothing; at 80 C it is 0.474 bar and has eaten four and a half metres of the
 * suction margin before the strainer or the tank level get a say.
 *
 * @param {number} T_C temperature, C
 * @returns {number} vapour pressure, bar absolute
 */
export function waterVapourPressure_bar(T_C) {
  const T = inRange(T_C, 1, 100);
  return Math.pow(10, 8.07131 - 1730.63 / (233.426 + T)) / 750.0617;
}

/**
 * Dynamic viscosity of water, Pa s, from the Vogel-type correlation
 * `mu = 2.414e-5 * 10^(247.8/(T_K - 140))`. Reads 1.002 mPa s at 20 C and 0.354 at 80 C.
 * @param {number} T_C temperature, C
 * @returns {number} dynamic viscosity, Pa s
 */
export function waterViscosity_Pas(T_C) {
  const T = inRange(T_C, 0, 100) + 273.15;
  return 2.414e-5 * Math.pow(10, 247.8 / (T - 140));
}

// ---------------------------------------------------------------------------------------------
// Viscosity-temperature for everything that is not water
// ---------------------------------------------------------------------------------------------

/**
 * Fit the Walther equation (ASTM D341) through two kinematic-viscosity points.
 *
 *     log10(log10(nu + 0.7)) = A - B * log10(T_K)
 *
 * This is the correlation every lubricant datasheet is built on, and it is the reason an oil is
 * quoted at 40 C and 100 C rather than at one temperature: two points fix the whole curve, and
 * the curve is very steep. An ISO VG 150 oil is ten times thinner at 100 C than at 40 C, which is
 * the difference between a pump that is badly derated and one that is barely derated at all.
 *
 * @param {number} nu1_cSt kinematic viscosity at `T1_C`, mm2/s
 * @param {number} T1_C first temperature, C
 * @param {number} nu2_cSt kinematic viscosity at `T2_C`, mm2/s
 * @param {number} T2_C second temperature, C
 * @returns {(T_C:number)=>number} kinematic viscosity in mm2/s at any temperature
 */
export function waltherFit(nu1_cSt, T1_C, nu2_cSt, T2_C) {
  const z = (nu) => Math.log10(Math.log10(nu + 0.7));
  const x1 = Math.log10(T1_C + 273.15);
  const x2 = Math.log10(T2_C + 273.15);
  const B = (z(nu1_cSt) - z(nu2_cSt)) / (x2 - x1);
  const A = z(nu1_cSt) + B * x1;
  return (T_C) => {
    const zz = A - B * Math.log10(inRange(T_C, -40, 250) + 273.15);
    return Math.max(0.3, Math.pow(10, Math.pow(10, zz)) - 0.7);
  };
}

/**
 * A simple Clausius-Clapeyron vapour pressure through one reference point.
 *
 * Adequate for the hydrocarbons and glycol mixtures here, whose vapour pressures are small enough
 * that the suction margin barely notices them until they are very hot — which is itself the point
 * worth making: an oil pump does not cavitate the way a hot-water pump does.
 *
 * @param {number} pRef_bar vapour pressure at the reference temperature, bar absolute
 * @param {number} TRef_C reference temperature, C
 * @param {number} dHvap_JmolK enthalpy of vaporisation, J/mol
 * @returns {(T_C:number)=>number} vapour pressure in bar absolute
 */
export function clausius(pRef_bar, TRef_C, dHvap_JmolK) {
  const R = 8.314462618;
  const T0 = TRef_C + 273.15;
  return (T_C) => {
    const T = inRange(T_C, -40, 300) + 273.15;
    return pRef_bar * Math.exp((-dHvap_JmolK / R) * (1 / T - 1 / T0));
  };
}

// ---------------------------------------------------------------------------------------------
// The fluid library
// ---------------------------------------------------------------------------------------------

const oilVG32 = waltherFit(32, 40, 5.4, 100);
const oilVG150 = waltherFit(150, 40, 14.5, 100);
const diesel = waltherFit(4.0, 20, 2.4, 40);
const eg30 = waltherFit(2.45, 20, 1.05, 60);
const eg50 = waltherFit(4.75, 20, 1.75, 60);

/**
 * The fluids the rig can be filled with.
 *
 * Each entry is a complete property set over a stated range. The order is deliberate: it runs
 * from the liquid that is easiest to pump and most eager to cavitate, to the one that cavitates
 * with great reluctance and derates the machine severely. Working down the list with the same
 * duty point is the fastest way to see what viscosity actually costs.
 */
export const FLUIDS = Object.freeze([
  {
    id: 'WATER',
    name: 'Water',
    note: 'The reference. Low viscosity, so no correction at all; high vapour pressure, so it '
      + 'will cavitate on temperature alone above about 93 C.',
    Tmin_C: 4,
    Tmax_C: 98,
    rho: waterDensity_kgm3,
    pVap: waterVapourPressure_bar,
    /** @param {number} T_C temperature @returns {number} kinematic viscosity, mm2/s */
    nu: (T_C) => (waterViscosity_Pas(T_C) / waterDensity_kgm3(T_C)) * 1e6,
    cp: () => 4182,
  },
  {
    id: 'SEAWATER',
    name: 'Seawater, 3.5% salinity',
    note: 'Denser than fresh water, so the same head reads a higher pressure and the motor works '
      + 'harder for the same duty.',
    Tmin_C: 4,
    Tmax_C: 60,
    rho: (T_C) => waterDensity_kgm3(T_C) + 26.5 - 0.05 * (T_C - 20),
    pVap: (T_C) => waterVapourPressure_bar(T_C) * 0.98,
    nu: (T_C) => (waterViscosity_Pas(T_C) * 1.07 / (waterDensity_kgm3(T_C) + 26.5)) * 1e6,
    cp: () => 3993,
  },
  {
    id: 'EG30',
    name: '30% ethylene glycol',
    note: 'A heat-transfer mixture. Twice the viscosity of water and a fifth less specific heat, '
      + 'so it heats up noticeably faster when a pump is churning it.',
    Tmin_C: -12,
    Tmax_C: 95,
    rho: (T_C) => 1048 - 0.55 * (inRange(T_C, -12, 95) - 20),
    pVap: (T_C) => waterVapourPressure_bar(T_C) * 0.86,
    nu: eg30,
    cp: () => 3570,
  },
  {
    id: 'EG50',
    name: '50% ethylene glycol',
    note: 'Freeze protection to -35 C, bought with four times the viscosity of water and a '
      + 'measurable derate on the pump curve.',
    Tmin_C: -30,
    Tmax_C: 95,
    rho: (T_C) => 1082 - 0.62 * (inRange(T_C, -30, 95) - 20),
    pVap: (T_C) => waterVapourPressure_bar(T_C) * 0.72,
    nu: eg50,
    cp: () => 3280,
  },
  {
    id: 'DIESEL',
    name: 'Diesel / light fuel oil',
    note: 'Light, and almost inert as far as NPSH is concerned: its vapour pressure is so low '
      + 'that suction margin stays generous even hot.',
    Tmin_C: -10,
    Tmax_C: 90,
    rho: (T_C) => 845 - 0.72 * (inRange(T_C, -10, 90) - 15),
    pVap: clausius(0.004, 40, 38000),
    nu: diesel,
    cp: () => 2050,
  },
  {
    id: 'VG32',
    name: 'ISO VG 32 hydraulic oil',
    note: 'The first fluid where the viscosity correction really bites: about 32 cSt at 40 C, so '
      + 'head, flow and efficiency are all measurably below the water curve.',
    Tmin_C: 10,
    Tmax_C: 90,
    rho: (T_C) => 872 - 0.65 * (inRange(T_C, 10, 90) - 15),
    pVap: clausius(1e-5, 40, 52000),
    nu: oilVG32,
    cp: () => 1900,
  },
  {
    id: 'VG150',
    name: 'ISO VG 150 gear oil',
    note: 'Severely derating: 150 cSt at 40 C costs this pump a large fraction of its head and '
      + 'most of its efficiency. Warm it up and watch the correction retreat.',
    Tmin_C: 20,
    Tmax_C: 95,
    rho: (T_C) => 890 - 0.63 * (inRange(T_C, 20, 95) - 15),
    pVap: clausius(1e-6, 40, 60000),
    nu: oilVG150,
    cp: () => 1880,
  },
]);

/** Fluids indexed by id. */
export const FLUID_BY_ID = Object.freeze(
  Object.fromEntries(FLUIDS.map((f) => [f.id, f])),
);

/**
 * Evaluate the complete property set of a fluid at a temperature.
 *
 * Returns a fresh object; called once per tick, not per pump, so the allocation is not worth
 * avoiding and the immutability is worth having.
 *
 * @param {string} id one of the {@link FLUIDS} ids
 * @param {number} T_C temperature, C
 * @returns {{id:string, name:string, T_C:number, rho_kgm3:number, pVap_bar:number,
 *   nu_cSt:number, mu_Pas:number, cp_JkgK:number, sg:number}} the property set
 */
export function fluidAt(id, T_C) {
  const f = FLUID_BY_ID[id] || FLUID_BY_ID.WATER;
  const T = inRange(T_C, f.Tmin_C, f.Tmax_C);
  const rho = f.rho(T);
  const nu = f.nu(T);
  return {
    id: f.id,
    name: f.name,
    T_C: T,
    rho_kgm3: rho,
    pVap_bar: f.pVap(T),
    nu_cSt: nu,
    mu_Pas: (nu * 1e-6) * rho,
    cp_JkgK: f.cp(T),
    sg: rho / 1000,
  };
}
