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
import { plausibleGroups } from './audit.js';

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
};

/**
 * Every muscle a lift trains, primary first.
 *
 * The **recorded** group always leads, even where the name table would disagree:
 * he may deliberately file a lift somewhere unexpected, and the table exists to
 * find what is missing, never to overrule him. What the table adds is the rest —
 * the muscles a lift trains that no single field could hold.
 */
export function musclesOf(exercise) {
  if (!exercise) return [];

  const primary = normaliseMuscleGroup(exercise.muscleGroup);
  const also = plausibleGroups(exercise.name).filter((g) => g !== primary);

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
