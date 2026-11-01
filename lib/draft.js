/**
 * The working copy the program editor edits.
 *
 * Edits happen on a clone, so backing out of the editor leaves the real
 * template untouched. Saving calls `upsertDayIn`, which replaces the stored day
 * **wholesale** — so whatever the clone does not carry is not merged back in,
 * it is gone.
 *
 * That is why this copies the slot and overrides what needs a default, rather
 * than listing the fields it wants. The previous version listed five of the
 * nine a slot can hold, and the four it forgot — `deloadPct`, `customScheme`,
 * `equipment`, `muscleGroup` — were erased from every exercise in a day the
 * moment somebody renamed it. A whitelist missing an entry looks exactly like a
 * complete one, so nothing said anything.
 */

import { numeric } from './strength.js';

/**
 * Copy a day for editing.
 *
 * @param day                 the stored day slot
 * @param defaultRestSeconds  what a slot with no rest of its own gets
 */
export function cloneDay(day, { defaultRestSeconds = 180 } = {}) {
  return {
    ...day,
    position: day.position ?? 0,
    exercises: (day.exercises ?? []).map((e) => ({
      ...e,
      schemeId: e.schemeId ?? 'rp-2',
      /*
       * `numeric()`, not `??` on the raw value and not `||`.
       *
       * A superset rests only after the round, so `restSeconds: 0` is a real
       * answer — and `0 || 180` is 180. That family of mistake has cost this
       * project six bugs, which is why there is a guard for it rather than a
       * convention.
       */
      restSeconds: numeric(e.restSeconds) ?? defaultRestSeconds,
    })),
  };
}
