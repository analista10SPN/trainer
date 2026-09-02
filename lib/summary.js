/**
 * The written summary: the one part of the coach that is not deterministic.
 *
 * Everything else in `analysis.js` and `progress.js` is arithmetic and a lookup
 * table, and stays that way — it has to work in a basement with no signal, and
 * its verdicts have to be testable. What arithmetic cannot do is connect the
 * findings to each other: that the three lifts going backwards are all pulls,
 * all at the gym that changed, in the week sleep fell off.
 *
 * So this module builds a prompt *from the already-computed findings* and reads
 * the reply. It never sees the raw log, and it never decides anything: if it is
 * slow, broken, unconfigured or unpaid, the rest of the tab is unchanged.
 */

/** Compact one lift's verdict into a line the model can reason across. */
function liftLine(f) {
  const rate = `${f.percentPerSession > 0 ? '+' : ''}${f.percentPerSession}%/session`;
  const bits = [`${f.name}: ${f.status}, ${rate}`];
  if (f.flags?.length) bits.push(`flags: ${f.flags.join(', ')}`);
  if (f.machine) bits.push(`machine: ${f.machine}`);
  if (f.muscleGroup) bits.push(f.muscleGroup);
  return `- ${bits.join(' · ')}`;
}

/**
 * One session's check-in as a line.
 *
 * The written note comes last and unedited. It is the only place in the whole
 * app where he says *why* — "ran short of time", "started to feel hungry at the
 * last exercise" — and it explains a session in a way that five numbers
 * averaged over a fortnight never can. Averaging these away was throwing out
 * the most useful thing in the payload.
 */
function checkinLine(c) {
  if (!c || typeof c !== 'object') return null;

  const scores = ['energy', 'sleep', 'hunger', 'stress', 'soreness']
    .filter((k) => Number.isFinite(Number(c[k])))
    .map((k) => `${k} ${c[k]}`)
    .join(', ');

  const note = typeof c.note === 'string' ? c.note.trim() : '';
  if (!scores && !note) return null;

  const when = c.date ? `${c.date}${c.day ? ` (${c.day})` : ''}: ` : '';
  return `- ${when}${scores || 'not scored'}${note ? ` — "${note}"` : ''}`;
}

export function buildSummaryPrompt(findings) {
  const f = findings ?? {};
  const lifts = (f.lifts ?? []).map(liftLine).join('\n') || '- (no lift has enough sessions yet)';

  const context = [];
  if (f.overall) context.push(`Overall: ${f.overall.status}, ${f.overall.rate}% per session.`);
  if (f.recovery?.sleepAvg) context.push(`Sleep averaging ${f.recovery.sleepAvg} h.`);
  if (f.recovery?.stepsAvg) context.push(`Steps averaging ${Math.round(f.recovery.stepsAvg)} a day.`);
  if (f.checkin) {
    const parts = Object.entries(f.checkin).map(([k, v]) => `${k} ${v}/5`);
    if (parts.length) context.push(`Check-ins averaging ${parts.join(', ')}.`);
  }
  if (f.gyms?.length) context.push(`Training across: ${f.gyms.join(', ')}.`);

  const checkins = (Array.isArray(f.checkins) ? f.checkins : []).map(checkinLine).filter(Boolean);

  const feel = checkins.length
    ? [
        'How each session felt, scored 1-5 right after the workout:',
        'For energy, sleep and hunger, higher is better. For stress and soreness, higher is WORSE.',
        'The quoted text is what he typed himself. Weight it heavily — it is the only place in',
        'this data where he says why, and it will often explain a number the trend cannot.',
        'If the same complaint appears in several notes, that repetition IS the finding, and it',
        'outranks anything you infer from the averages. Say it plainly and say which sessions.',
        ...checkins,
      ].join('\n')
    : 'He has not scored how any session felt yet.';

  return [
    'You are reading the output of a lifting log\'s trend analysis for one person.',
    'Every number below has ALREADY been computed from their logged sets. Do not recompute,',
    'restate, or list them back — they are on the screen directly underneath your answer.',
    '',
    'Per-lift verdicts:',
    lifts,
    '',
    context.length ? `Context:\n${context.join('\n')}` : 'No watch or overall data yet.',
    '',
    feel,
    '',
    'Your job is the one thing none of the individual readouts can do: say what it all means',
    'TOGETHER. Connect it. Look for a pattern across muscle groups, movement patterns, gyms,',
    'machines, recovery, and how the sessions felt — including what he wrote about them.',
    'Name the single most useful thing to do next.',
    '',
    'The lift trends and the session notes are two separate sources, and either one alone can',
    'carry the answer. If the lifts are too new to trend but the notes keep saying the same',
    'thing, the notes ARE the answer — report that rather than concluding there is nothing',
    'to say. Only say there is nothing yet when both sources are genuinely empty.',
    '',
    'Rules:',
    '- Three sentences to five. Plain language. No headings, no bullet points, no preamble.',
    '- Address them directly as "you".',
    '- If the lifts genuinely have nothing in common, say that plainly rather than inventing a link.',
    '- You cannot see their form, their technique, or their video. Never claim to.',
    '- Do not give medical advice.',
  ].join('\n');
}

/** Pull the text out of a Messages API response, or null if it is not there. */
export function parseSummaryResponse(body) {
  const blocks = body?.content;
  if (!Array.isArray(blocks)) return null;

  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');

  return text || null;
}

/**
 * A key that changes exactly when the findings do.
 *
 * Opening the Coach tab four times must not be four requests — the answer can
 * only change when the numbers underneath it change, which is when a workout is
 * logged. Cheap and stable rather than cryptographic; it guards a cache, not a
 * secret.
 */
export function summaryCacheKey(findings) {
  const f = findings ?? {};
  const shape = JSON.stringify({
    o: f.overall?.status ?? null,
    r: f.overall?.rate ?? null,
    l: (f.lifts ?? []).map((x) => [x.name, x.status, x.percentPerSession, x.machine ?? null]),
    s: f.recovery?.sleepAvg ?? null,
    c: f.checkin ?? null,
    // A newly logged check-in has to invalidate the cache, or the card keeps
    // showing a summary written before he said what happened.
    k: (Array.isArray(f.checkins) ? f.checkins : []).map((x) => [x?.date ?? null, x?.note ?? null]),
  });

  let hash = 0;
  for (let i = 0; i < shape.length; i++) {
    hash = (hash * 31 + shape.charCodeAt(i)) | 0;
  }
  return `sum-${(hash >>> 0).toString(36)}`;
}
