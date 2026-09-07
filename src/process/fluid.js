/**
 * src/process/fluid.js — properties of the pumped liquid as a function of temperature.
 *
 * Layer L1: imports nothing. No DOM.
 *
 * Only two properties matter to a pump: density, because it turns head into pressure, and vapour
 * pressure, because it decides whether the liquid boils at the impeller eye. Both are given here
 * for water over 0..100 C from published correlations rather than from a single room-temperature
 * constant, because the temperature slider is one of the three ways an operator can make this rig
 * cavitate, and a linear guess would put the cliff in the wrong place.
 */

/**
 * Density of liquid water, kg/m3, from the Kell correlation as usually abridged for 0..100 C at
 * atmospheric pressure. Reproduces the 3.98 C maximum and reads 998.2 kg/m3 at 20 C.
 * @param {number} T_C temperature, degrees Celsius
 * @returns {number} density, kg/m3
 */
export function waterDensity_kgm3(T_C) {
  const T = T_C < 0 ? 0 : (T_C > 100 ? 100 : T_C);
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
 * @param {number} T_C temperature, degrees Celsius
 * @returns {number} vapour pressure, bar absolute
 */
export function waterVapourPressure_bar(T_C) {
  const T = T_C < 1 ? 1 : (T_C > 100 ? 100 : T_C);
  const mmHg = Math.pow(10, 8.07131 - 1730.63 / (233.426 + T));
  return mmHg / 750.0617;
}

/**
 * Both properties at once, as a fresh object. Called once per tick, not per pump.
 * @param {number} T_C temperature, degrees Celsius
 * @returns {{T_C:number, rho_kgm3:number, pVap_bar:number, sg:number}} the property set
 */
export function fluidAt(T_C) {
  const rho = waterDensity_kgm3(T_C);
  return { T_C, rho_kgm3: rho, pVap_bar: waterVapourPressure_bar(T_C), sg: rho / 1000 };
}
