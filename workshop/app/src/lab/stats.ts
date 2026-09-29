/**
 * How much a share of dialogues can be trusted, and whether a change between versions is real or noise.
 * On 30–50 dialogues a share moves by ±10–15 points by chance alone, so the screens never paint noise red or green.
 */

const Z = 1.96;

/** 95% Wilson interval of k successes out of n, as fractions. Behaves near 0 and 1, where the naive interval does not. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const p = k / n;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** 95% interval of the difference of two independent shares (Newcombe's hybrid score method), as fractions. */
export function newcombe(k1: number, n1: number, k2: number, n2: number): [number, number] | null {
  const a = wilson(k1, n1), b = wilson(k2, n2);
  if (!a || !b) return null;
  const p1 = k1 / n1, p2 = k2 / n2, d = p1 - p2;
  return [d - Math.sqrt((p1 - a[0]) ** 2 + (b[1] - p2) ** 2), d + Math.sqrt((a[1] - p1) ** 2 + (p2 - b[0]) ** 2)];
}

/** Two-sided exact sign test on the dialogues that changed their outcome: `up` failed before and pass now, `down` the reverse. */
export function signTest(up: number, down: number): number {
  const n = up + down;
  if (!n) return 1;
  const k = Math.min(up, down);
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

export type Outcome = { key: string; pass: boolean };

/**
 * «better» and «worse» only when the change is unlikely to be chance; «likely-*» when the share moved by 5 points or more
 * but the dialogues are too few to be sure; «same» otherwise. When the same scenarios were played in both versions,
 * the dialogues are compared pairwise (the stronger test); otherwise the two shares are compared as independent samples.
 */
export type Direction = "better" | "likely-better" | "same" | "likely-worse" | "worse";

export type Change = {
  direction: Direction;
  /** Points of the share, current minus previous. */
  delta: number;
  /** Dialogues played in both versions (paired), or 0. */
  paired: number;
  /** Among the paired: failed before and pass now, and the reverse. */
  fixed: number; broke: number;
  p: number;
};

export function compareOutcomes(current: Outcome[], previous: Outcome[]): Change | null {
  if (!current.length || !previous.length) return null;
  const share = (xs: Outcome[]) => xs.filter(x => x.pass).length / xs.length;
  const delta = Math.round(100 * (share(current) - share(previous)));
  const before = new Map(previous.map(x => [x.key, x.pass]));
  const pairs = current.filter(x => before.has(x.key));
  const fixed = pairs.filter(x => x.pass && !before.get(x.key)).length;
  const broke = pairs.filter(x => !x.pass && before.get(x.key)).length;
  let p: number;
  if (pairs.length >= Math.min(current.length, previous.length) * 0.6) {
    p = signTest(fixed, broke);
  } else {
    const k1 = current.filter(x => x.pass).length, k2 = previous.filter(x => x.pass).length;
    const ci = newcombe(k1, current.length, k2, previous.length);
    p = ci && (ci[0] > 0 || ci[1] < 0) ? 0.01 : 1;
  }
  const up = delta > 0;
  const direction: Direction = p < 0.05 && delta !== 0 ? (up ? "better" : "worse") : Math.abs(delta) >= 5 ? (up ? "likely-better" : "likely-worse") : "same";
  return { direction, delta, paired: pairs.length, fixed, broke, p };
}

/** Hue of a change: colour only when the change is real. */
export const directionHue = (d: Direction) => (d === "better" ? "ok" : d === "worse" ? "bad" : "mute") as "ok" | "bad" | "mute";
