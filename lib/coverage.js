/**
 * What a week of training actually hits.
 *
 * The rules are his: four lifting days, every muscle group at least twice a week,
 * glutes three times. Those are checkable, and a program that quietly breaks one
 * looks perfectly reasonable — you find out months later from a muscle that never
 * grew.
 *
 * It is a function rather than something somebody eyeballed once because the
 * coach is about to propose swaps and deloads on a fortnightly cadence. A
 * proposal that removes the only horizontal pull of the week has to be refused
 * **before** it is applied, and nothing can refuse it without being able to state
 * the rule.
 *
 * **Secondary muscles count.** Counting only the primary mover undercounts a
 * full-body day badly: the RDL trains glutes, the close-grip bench trains
 * triceps. A glute-focused program read on primaries alone reports two sessions
 * where the honest answer is four — and would then be "fixed" by adding glute
 * work it does not need.
 */

import { MUSCLE_GROUPS, normaliseMuscleGroup } from './exercises.js';

/**
 * The rule he asked for, written down once.
 *
 * As data rather than as code, so the program builder and the coach's swap
 * proposals check the same thing. Two places implementing "twice a week" is two
 * places to disagree.
 */
export const GLUTE_FOCUS = {
  minDays: 2,
  focus: { glutes: 3 },
  // Trained by every pull and by nothing directly in a sane program for someone
  // starting out. Excused explicitly, because a silent omission from a rule is
  // indistinguishable from the rule being broken.
  excused: ['forearms'],

  /**
   * "Almost full body" — the part of the brief nothing was checking.
   *
   * The first version of her program met every weekly number and was still the
   * wrong shape: a lower / upper / lower / full-body split. Read over a week it
   * was flawless; read a day at a time, three of the four days were half a body.
   * He had to point that out, which means the rule was in his head and not in
   * the code — so here it is.
   *
   * A day qualifies by **what it covers, not by its name**: a lower-body lift, an
   * upper push, an upper pull, and at least six of the ten muscle groups. Pillars
   * matter beyond the group count because six groups can all be legs.
   */
  perDay: { minGroups: 6, pillars: ['lower', 'push', 'pull'] },
};

/**
 * The same rule with nobody's emphasis on it.
 *
 * `GLUTE_FOCUS` is **hers**. It was also the default argument of every function
 * in this file and the only rule `clientview` ever passed, so every member the
 * admin opened was measured against "glutes three times a week" — including
 * members training for something else entirely, who were then shown a gap that
 * was never part of their program.
 *
 * A focus is a property of a program, not of whoever is reading it. So the
 * baseline carries no focus and `rulesFor` reads the emphasis off the program.
 */
export const BALANCED = {
  minDays: GLUTE_FOCUS.minDays,
  focus: {},
  excused: GLUTE_FOCUS.excused,
  perDay: GLUTE_FOCUS.perDay,
};

/**
 * The rule a given program should be held to.
 *
 * Declared on the program as `focus: { glutes: 3 }` — which is where her brief
 * actually lives, and means a second member with a different goal needs no code
 * change and no branch on who they are.
 */
export function rulesFor(program) {
  const focus = program?.focus;
  if (!focus || typeof focus !== 'object') return BALANCED;
  return { ...BALANCED, focus };
}

/**
 * The three things a day has to contain to be a whole session.
 *
 * Derived from muscle groups rather than from names, so it reads the same data
 * everything else here does — a new lift is classified by what it trains, with
 * nothing to add anywhere.
 */
export const PILLARS = {
  lower: ['quads', 'hamstrings', 'glutes', 'calves'],
  push: ['chest', 'shoulders', 'triceps'],
  pull: ['back', 'biceps'],
};

/**
 * Every muscle a lift trains, primary first.
 *
 * The **recorded** group always leads: he may deliberately file a lift somewhere
 * unexpected, and nothing here may overrule him.
 *
 * ## This read the wrong table for a long time
 *
 * It called `plausibleGroups(exercise.name)`, which is a 31-row table about
 * which group a movement could plausibly be filed under **as its primary** — the
 * table's own comment says "more than one group means the movement genuinely has
 * more than one primary, not a hedge". Using it as a secondary-muscle list is a
 * category error, and the consequence was measurable: **71 of the 93 seeded
 * lifts read as training exactly one muscle.** A bench press returned
 * `["chest"]` with no triceps; every row returned `["back"]` with no biceps.
 *
 * Which made the coverage card wrong in a specific and expensive direction.
 * Biceps and triceps are trained by every pull and every press and by nothing
 * else in a well-built program, so they were the two groups most likely to be
 * reported as a gap that was not one — under a line of copy reading "secondary
 * muscles included". `README.md` and `CONTEXT.md` both promised the same thing.
 *
 * So secondaries are now **stored on the lift**, like the primary, and this
 * function reads them. No name parsing: renaming a lift cannot change what it
 * trains, and a lift whose name says nothing still trains what it trains.
 *
 * `plausibleGroups` keeps its real job — finding a lift filed under a group its
 * movement cannot justify — in `groupSuspects`, where it flags and never fixes.
 */
export function musclesOf(exercise) {
  if (!exercise) return [];

  const primary = normaliseMuscleGroup(exercise.muscleGroup);

  const also = [];
  for (const raw of exercise.secondary ?? []) {
    const group = normaliseMuscleGroup(raw);
    // A group nobody recognises contributes nothing and looks exactly like a
    // gap, so it is dropped here rather than carried into a count.
    if (!group || !MUSCLE_GROUPS.includes(group)) continue;
    if (group === primary || also.includes(group)) continue;
    also.push(group);
  }

  return primary ? [primary, ...also] : also;
}

/**
 * Per muscle group: how many days train it, which ones, and how many slots.
 *
 * **Days, not slots, is the number the rule is about.** Two glute lifts in one
 * session is one session of glutes; counting slots would let a single day satisfy
 * "three times a week", which is the opposite of what the rule is for. Slots are
 * reported alongside because they are what says whether a day is *focused* on
 * something rather than merely touching it.
 *
 * Every group appears, including the ones nothing trains. Leaving a zero out
 * would make every caller remember eleven names to notice a gap, which is exactly
 * how a gap goes unnoticed.
 */
export function weeklyCoverage(program, exercises = []) {
  const byId = new Map((exercises ?? []).map((e) => [e.id, e]));

  const coverage = {};
  for (const group of MUSCLE_GROUPS) {
    coverage[group] = { days: 0, slots: 0, dayNames: [] };
  }

  for (const day of program?.days ?? []) {
    const onThisDay = new Set();

    for (const slot of day?.exercises ?? []) {
      const exercise = byId.get(slot?.exerciseId);
      for (const group of musclesOf(exercise)) {
        if (!coverage[group]) coverage[group] = { days: 0, slots: 0, dayNames: [] };
        coverage[group].slots += 1;
        onThisDay.add(group);
      }
    }

    for (const group of onThisDay) {
      coverage[group].days += 1;
      coverage[group].dayNames.push(String(day?.name ?? day?.id ?? ''));
    }
  }

  return coverage;
}

/**
 * What one day covers: its muscle groups, and which pillars it contains.
 *
 * `missing` is the answer the caller actually wants — "this day has no upper
 * pull" is actionable where "pillars: ['lower', 'push']" has to be diffed first.
 */
export function dayBalance(day, exercises = [], rules = GLUTE_FOCUS) {
  const byId = new Map((exercises ?? []).map((e) => [e.id, e]));

  const groups = new Set();
  for (const slot of day?.exercises ?? []) {
    for (const group of musclesOf(byId.get(slot?.exerciseId))) groups.add(group);
  }

  const wanted = rules?.perDay?.pillars ?? Object.keys(PILLARS);
  const has = wanted.filter((name) => (PILLARS[name] ?? []).some((g) => groups.has(g)));

  return {
    name: String(day?.name ?? day?.id ?? ''),
    groups: [...groups],
    pillars: has,
    missing: wanted.filter((name) => !has.includes(name)),
  };
}

/**
 * Is every day of this program a whole session?
 *
 * Separate from `checkCoverage` because they answer different questions and a
 * program can pass one while failing the other — which is exactly what happened.
 * Weekly totals say whether everything gets trained; this says whether any single
 * day is half a body.
 */
export function checkDays(program, exercises = [], rules = GLUTE_FOCUS) {
  const minGroups = rules?.perDay?.minGroups ?? 0;
  const problems = [];

  for (const day of program?.days ?? []) {
    const balance = dayBalance(day, exercises, rules);

    if (balance.missing.length) {
      problems.push({ day: balance.name, missing: balance.missing, groups: balance.groups.length });
    } else if (balance.groups.length < minGroups) {
      problems.push({ day: balance.name, missing: [], groups: balance.groups.length, wanted: minGroups });
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Does this program meet the rule?
 *
 * Problems name the group, what was wanted and what was found, so a warning can
 * say where the gap is instead of only that there is one. A focus target
 * overrides the general minimum in one direction only: glutes needing three is
 * not satisfied by the general two, and a group with a focus *lower* than the
 * minimum still has to meet the minimum.
 */
export function checkCoverage(program, exercises = [], rules = GLUTE_FOCUS) {
  const coverage = weeklyCoverage(program, exercises);
  const excused = rules?.excused ?? [];
  const problems = [];

  for (const group of Object.keys(coverage)) {
    if (excused.includes(group)) continue;

    const wanted = Math.max(rules?.minDays ?? 0, rules?.focus?.[group] ?? 0);
    const got = coverage[group].days;

    if (got < wanted) {
      problems.push({ muscleGroup: group, wanted, got, short: wanted - got });
    }
  }

  return {
    ok: problems.length === 0,
    problems: problems.sort((a, b) => b.short - a.short || a.muscleGroup.localeCompare(b.muscleGroup)),
    coverage,
    excused,
  };
}
