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

  return [
    'You are reading the output of a lifting log\'s trend analysis for one person.',
    'Every number below has ALREADY been computed from their logged sets. Do not recompute,',
    'restate, or list them back — they are on the screen directly underneath your answer.',
    '',
    'Per-lift verdicts:',
    lifts,
    '',
    context.length ? `Context:\n${context.join('\n')}` : 'No recovery or check-in data yet.',
    '',
    'Your job is the one thing the per-lift verdicts cannot do: say what they mean TOGETHER.',
    'Connect them. Look for a pattern across muscle groups, movement patterns, gyms, machines,',
    'recovery and how the sessions felt. Name the single most useful thing to do next.',
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
  });

  let hash = 0;
  for (let i = 0; i < shape.length; i++) {
    hash = (hash * 31 + shape.charCodeAt(i)) | 0;
  }
  return `sum-${(hash >>> 0).toString(36)}`;
}
