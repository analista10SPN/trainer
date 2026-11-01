/**
 * Pounds and kilograms, without rewriting a single logged number.
 *
 * ## The rule that does not get reopened
 *
 * `set.weight` is the total load moved, in **pounds**, always.
 *
 * Not because pounds are better. Every slope in this app divides by its own mean
 * and is unit-free, so `percentSlope`, every verdict, every rollup and every
 * median would read the same in either unit — that is the single best property
 * the codebase has here, and it means the choice is not an analytical one. It is
 * pounds because the ~1000 rows already logged are pounds, the cloud holds the
 * only copy of them that is not on his phone, and a migration that touches those
 * rows is the highest-stakes write in the project. Nothing moves.
 *
 * Adding kg is the *second* chance to make the dumbbell mistake — storing what
 * was typed and remembering what it meant, which puts a branch in every consumer
 * and lets two phones disagree about the unit of one row with no tiebreaker. So:
 * one canonical unit, display conversion, and the typed value kept only as
 * provenance that no analysis reads.
 *
 * ## The one hard problem
 *
 * 180 lb is 81.6466 kg. The screen cannot show that: 81.6466 is not a weight
 * anybody loads, and showing it invites editing it. So it shows **81.75 kg**, the
 * nearest load the plates can make.
 *
 * And then the trap. If the user looks at `81.75 kg` and saves without touching
 * it, that converts back to 180.22 lb, which snaps to 180.5. *The lift gained
 * half a pound by being looked at.* Weekly, that is a slope nobody lifted.
 *
 * Which is not a rounding problem — it is a **write** problem. The app was
 * rewriting a value nobody changed. So the canonical number is the field's
 * identity, and `commitWeight` compares the submitted value against what was
 * *shown*: equal means no edit, and no edit means the stored number is returned
 * untouched, bit for bit, through any number of unit flips.
 *
 * That is the same rule two other decisions here already follow: `render`
 * refuses to repaint identical markup, and the swing card explains a number and
 * never corrects one.
 *
 * The lb-only app already drifts this way, which is how the rule was found:
 * `totalToEntered(70.5)` is `35.25`, and storing that back gave 71.
 */

import { numeric } from './strength.js';

export const UNITS = ['lb', 'kg'];

/** Exact by definition since 1959. An approximation is a slow drift. */
export const KG_PER_LB = 0.45359237;

export const isUnit = (unit) => UNITS.includes(unit);

/** Fall back rather than print a unit nobody recognises. */
const safe = (unit) => (isUnit(unit) ? unit : 'lb');

/**
 * The smallest load the gym can make, in the display unit.
 *
 * Half a pound in pounds, which is the grid `plates.js` already works in: it
 * computes in half-pound integers throughout.
 *
 * A quarter kilo in kilos, because the lightest kg plate is 1.25 and it also
 * goes on in pairs. **Kg plates are not half-pound integers** — 20 kg is
 * 44.0925 lb — so a kg load snapped on the pound grid is a load that does not
 * exist. This is why the two grids are separate numbers rather than one
 * converted.
 */
export function displayStep(unit) {
  return safe(unit) === 'kg' ? 0.25 : 0.5;
}

/** Canonical pounds in the display unit, unrounded. Null stays null. */
export function toUnit(lb, unit) {
  const n = numeric(lb);
  if (n === null) return null;
  return safe(unit) === 'kg' ? n * KG_PER_LB : n;
}

/** A display-unit number back to canonical pounds. Null stays null. */
export function fromUnit(value, unit) {
  const n = numeric(value);
  if (n === null) return null;
  return safe(unit) === 'kg' ? n / KG_PER_LB : n;
}

const snap = (n, step) => Math.round(n / step) * step;

/**
 * What the screen shows: a load that exists.
 *
 * Snapped to the display unit's own grid, so the number on screen is always one
 * the user could load, and editing it can never produce a weight that is not a
 * weight.
 */
export function showWeight(lb, unit) {
  const n = toUnit(lb, unit);
  if (n === null || !Number.isFinite(n)) return null;

  const step = displayStep(unit);
  // Rounded to four places after snapping, because `Math.round(x/0.25)*0.25`
  // reintroduces float dust that then renders as 81.75000000000001.
  return Math.round(snap(n, step) * 10000) / 10000;
}

/**
 * What to store, given what was submitted.
 *
 * **An unedited field is never written back.** If the submitted value is exactly
 * what `showWeight` produced from the stored number, the stored number is
 * returned unchanged — not reconverted, not re-snapped. That is what makes the
 * round trip lossless, and it is the whole reason this function exists rather
 * than callers simply calling `fromUnit`.
 */
export function commitWeight(submitted, unit, currentLb = null) {
  const typed = numeric(submitted);
  if (typed === null || !Number.isFinite(typed)) return numeric(currentLb);

  const current = numeric(currentLb);
  if (current !== null && showWeight(current, unit) === typed) return current;

  const lb = fromUnit(typed, unit);
  if (lb === null || !Number.isFinite(lb)) return current;

  // Pounds are stored as typed. Kilos are snapped to the pound grid on the way
  // in, because the canonical column has always held half-pound figures and a
  // converted kilo would put six decimal places into it.
  return safe(unit) === 'kg' ? Math.round(lb * 2) / 2 : lb;
}

/**
 * A weight with its unit, for the screen.
 *
 * Never a bare number: in a mixed-unit app a bare number is the dumbbell bug
 * wearing a new hat, and that bug cost months precisely because the figure was
 * *consistent* and so nothing looked wrong.
 */
/**
 * A bodyweight reading, converted but not snapped.
 *
 * `formatWeight` rounds to the smallest load the plates can make, which is right
 * for a weight you put on a bar and wrong for one a scale reads. 132.4 lb is
 * what the scale said; printing 132.5 is the app correcting a measurement it did
 * not take — and the half pound it invents is the same order of magnitude as the
 * weekly change the entire energy model exists to detect.
 *
 * One decimal place, because that is what a bathroom scale knows.
 */
export function formatBodyweight(lb, unit) {
  const n = toUnit(lb, unit);
  if (n === null || !Number.isFinite(n)) return '—';
  return `${Number(n.toFixed(1))} ${safe(unit)}`;
}

export function formatWeight(lb, unit) {
  const shown = showWeight(lb, unit);
  if (shown === null) return '—';

  // No trailing zeroes: "100 lb", not "100.0 lb".
  const text = Number.isInteger(shown) ? String(shown) : String(Number(shown.toFixed(2)));
  return `${text} ${safe(unit)}`;
}
