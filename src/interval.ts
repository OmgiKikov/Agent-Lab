/*
 * The one interval every rate on a result screen is read with — the accuracy of the headline and the agreement
 * of the synthetic customers with production — so the two never disagree about what «мало данных» means.
 */

/** Below this many decided situations a rate is a rough estimate: the line under it says so. */
export const SMALL_SAMPLE = 20;
const Z = 1.959963984540054;

/** 95% Wilson score interval for passed/decided; null when nothing was decided. */
export function wilson(passed: number, decided: number): [number, number] | null {
  if (decided <= 0) return null;
  const p = passed / decided, d = 1 + Z * Z / decided;
  const centre = (p + Z * Z / (2 * decided)) / d;
  const half = Z * Math.sqrt(p * (1 - p) / decided + Z * Z / (4 * decided * decided)) / d;
  return [Math.min(1, Math.max(0, centre - half)), Math.min(1, Math.max(0, centre + half))];
}
