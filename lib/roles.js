/**
 * Who may do what.
 *
 * There were two kinds of person — `admin` and `member` — and the question
 * "may this person do this?" was answered at each call site by reading
 * `user.role === 'admin'`. Eight places in `worker/api.js` did exactly that,
 * each one a separate chance to get it wrong, and none of them testable
 * without standing a server up.
 *
 * A third kind of person made that untenable, so the rules live here as a
 * table: capabilities on one side, grants on the other, and one resolver.
 * Adding a capability is a line; adding a *kind* of grant is a line and a
 * predicate. Neither is an edit to a conditional somebody else is relying on.
 *
 * ## Gym admin is a relationship, not a role
 *
 * The load-bearing decision, and this codebase already made the same one once.
 * Of coaching, CONTEXT.md says: "a third `role` value was the obvious shape and
 * is wrong: role is global, and [the question] is about a pair."
 *
 * It is true again. "Is this person an admin?" is global and a column can hold
 * it. "Is this person an admin *of this gym*?" is about a pair, and a column
 * cannot. A global `gym-admin` role would have made every gym admin an admin
 * of every gym — which is not a rule anybody would write down, but is exactly
 * what the obvious shape produces.
 *
 * So `role` stays two-valued, and the gym relationship is an edge the actor
 * carries as `gymAdminOf`.
 *
 * ## The super admin's stored role is still `admin`
 *
 * Also deliberate. `u-admin` is created on first use from the `AUTH_TOKEN`
 * secret and is the default owner of every pre-release row across seven
 * tables. Renaming that value in a live database is a lockout risk for the one
 * account that would have to fix it afterwards. "Super admin" is what it is
 * *called*; `admin` is what it *is*, and `roleLabel` is the only place the two
 * meet.
 */

/**
 * What a grant means, as a predicate over (actor, subject).
 *
 * Separated from the capability table so that the table reads as policy —
 * which is the part that gets argued about — and these read as mechanism.
 */
export const GRANTS = {
  /** The one account that can do everything. */
  super: (actor) => actor.role === 'admin',

  /** Runs *this* gym. The pair question, and the reason for the edge. */
  'gym-admin-of': (actor, subject) =>
    Boolean(subject?.id) && actor.gymAdminOf.includes(subject.id),

  /**
   * Created the thing and it has not become everybody's yet.
   *
   * Scoped to `pending` and `personal` on purpose: once a gym is public it is a
   * shared record, and the person who happened to type the name first does not
   * get to keep renaming a building other people are training at.
   */
  owner: (actor, subject) => subject?.createdBy === actor.id
    && (subject?.visibility ?? 'pending') !== 'public',

  /** Anybody at all, as long as they are signed in. */
  signed_in: () => true,
};

/**
 * What each capability requires. Any one grant is enough.
 *
 * `super` is on every line, and that is the only way it stays true that the
 * super admin can do everything — there is no special case in `can()` for it.
 * A capability added without `super` is one he cannot use on his own app, and
 * a test asserts that none exists.
 */
export const CAPABILITIES = {
  /**
   * Naming a gym is how a workout starts somewhere new, and the gym question is
   * the one screen in this app that cannot be skipped. Gating it on anything at
   * all would mean somebody standing in a new gym cannot log.
   */
  'gym:create': ['signed_in', 'super'],

  'gym:rename': ['gym-admin-of', 'owner', 'super'],
  'gym:set-position': ['gym-admin-of', 'owner', 'super'],

  /**
   * The shared machine inventory — what this building actually has. Distinct
   * from the per-person machine tally, which is a habit and stays private.
   */
  'gym:set-machines': ['gym-admin-of', 'super'],

  /** Deciding a gym reaches everybody's picker is an app-wide decision. */
  'gym:approve': ['super'],
  'gym:retire': ['super'],

  /**
   * The three that would let somebody widen their own authority. A gym admin
   * runs a building; running the app is a different job.
   */
  'gym:appoint-admin': ['super'],
  'user:invite': ['super'],
  'user:set-role': ['super'],
};

/**
 * Normalise whatever the server or IndexedDB handed over into an actor.
 *
 * Both sources have held older shapes, and the failure this prevents is not
 * subtle: `undefined.includes(id)` throws inside a render, which takes the
 * whole screen out rather than hiding one button.
 *
 * An unrecognised role is normalised to `member`, so a future role value that
 * this build has never heard of cannot be read as more authority than the
 * least. Failing closed is the only safe direction for a permission default.
 */
export function actorFrom(account) {
  if (!account?.id) return null;

  return {
    id: account.id,
    role: account.role === 'admin' ? 'admin' : 'member',
    gymAdminOf: Array.isArray(account.gymAdminOf) ? account.gymAdminOf.filter(Boolean) : [],
  };
}

/**
 * May this actor do this, to this?
 *
 * @param actor      `{ id, role, gymAdminOf }`, or null when signed out.
 * @param capability a key of `CAPABILITIES`. An unknown one is denied.
 * @param subject    the thing being acted on — a gym, usually. May be null for
 *                   capabilities that are not about a particular thing.
 */
export function can(actor, capability, subject = null) {
  return why(actor, capability, subject).allowed;
}

/**
 * The same question, with its reasoning.
 *
 * A bare boolean is enough for the server and not enough for anything else: it
 * cannot tell the user why a control is missing, and it cannot tell an audit
 * log whether a rename came from the gym's admin or from the person who first
 * typed its name. Both of those are questions somebody asks eventually.
 */
export function why(actor, capability, subject = null) {
  const needed = CAPABILITIES[capability];

  // Unknown capability: denied, and *said* to be unknown. A renamed capability
  // with one call site left behind is a bug, and silently denying it looks
  // exactly like policy.
  if (!needed) return { allowed: false, unknown: true, needed: [], via: null };

  const normalised = actorFrom(actor);
  if (!normalised) return { allowed: false, unknown: false, needed, via: null };

  for (const grant of needed) {
    const test = GRANTS[grant];
    // A typo in the table denies rather than throws, so the resolver cannot
    // take a screen down — but a test asserts every named grant exists, which
    // is where a typo is supposed to be caught instead.
    if (test && test(normalised, subject)) {
      return { allowed: true, unknown: false, needed, via: grant };
    }
  }

  return { allowed: false, unknown: false, needed, via: null };
}

/**
 * What to call this person on screen.
 *
 * The label follows the *authority*, not the column: somebody who can set up a
 * building's machine list is not "a member" to the person reading the screen,
 * whatever `role` says.
 */
export function roleLabel(actor) {
  const normalised = actorFrom(actor);
  if (!normalised) return 'Signed out';
  if (normalised.role === 'admin') return 'Super admin';
  return normalised.gymAdminOf.length ? 'Gym admin' : 'Member';
}
