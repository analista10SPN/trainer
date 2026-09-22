/**
 * The coach report as a declared shape rather than a paragraph.
 *
 * Prose was the wrong container. It renders as a wall of text, it cannot be
 * compared between weeks, and — the reason it changed — an answer that runs
 * long gets cut off, or never begins, because the model spent its budget
 * reasoning before writing a word. Asking for a bounded structure fixes all
 * three: the output is small, parseable, and renderable as the card it is.
 *
 * Every function here assumes the model will sometimes not comply. A reply that
 * cannot be parsed degrades to showing what came back, never to showing
 * nothing — a coach that silently disappears is worse than a scruffy one.
 */

import { numeric } from './strength.js';

export const REPORT_KEYS = ['score', 'status', 'headline', 'findings', 'recommendations', 'caveats'];

const STATUSES = ['progressing', 'holding', 'mixed', 'regressing'];
const SEVERITIES = ['high', 'medium', 'low'];

/** Enough to be useful, few enough to read on a phone between sets. */
const MAX_ITEMS = 8;

const str = (value, max = 400) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** Find the JSON object in a reply that may be fenced or wrapped in chatter. */
function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanFinding(f) {
  const title = str(f?.title, 120);
  if (!title) return null;
  return {
    title,
    detail: str(f?.detail, 400) ?? '',
    severity: SEVERITIES.includes(String(f?.severity).toLowerCase())
      ? String(f.severity).toLowerCase()
      : 'medium',
  };
}

function cleanRecommendation(r) {
  const action = str(r?.action, 160);
  if (!action) return null;
  return { action, why: str(r?.why, 400) ?? '' };
}

/**
 * Turn a reply into something the card can render, or null if there is nothing.
 *
 * Null means "the request failed" and the card says so. An empty-but-valid
 * report would instead render as a confident assessment of nothing, which is
 * the worse failure of the two.
 */
export function parseReport(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return null;

  const parsed = extractJSON(raw);

  // Not JSON at all: keep the words. A scruffy answer beats an empty card.
  if (!parsed) {
    return {
      score: null,
      status: 'mixed',
      headline: raw.slice(0, 1200),
      findings: [],
      recommendations: [],
      caveats: [],
      degraded: true,
    };
  }

  // numeric(), not Number(): a null score would otherwise become a confident 0,
  // which reads as "everything is terrible" rather than "it did not say".
  const score = numeric(parsed.score);
  const status = String(parsed.status ?? '').toLowerCase();

  return {
    score: score !== null && score >= 0 && score <= 100 ? Math.round(score) : null,
    status: STATUSES.includes(status) ? status : 'mixed',
    headline: str(parsed.headline, 400) ?? '',
    findings: (Array.isArray(parsed.findings) ? parsed.findings : [])
      .map(cleanFinding).filter(Boolean).slice(0, MAX_ITEMS),
    recommendations: (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])
      .map(cleanRecommendation).filter(Boolean).slice(0, MAX_ITEMS),
    caveats: (Array.isArray(parsed.caveats) ? parsed.caveats : [])
      .map((c) => str(c, 300)).filter(Boolean).slice(0, MAX_ITEMS),
    degraded: false,
  };
}

/** What to ask for. Kept next to the parser so the two cannot drift apart. */
export function reportInstructions() {
  return [
    'Answer with a single JSON object and nothing else. No prose before or after it,',
    'no code fence, no explanation. These fields exactly:',
    '',
    '  "score": 0-100. How training is going overall, as one number. 50 is holding',
    '           steady. Weigh the lifts that matter over the ones that are noise, and',
    '           read it against his goal and his calorie intake if those are given.',
    '  "status": one of "progressing", "holding", "mixed", "regressing".',
    '  "headline": one sentence. The single most important thing. No preamble.',
    '  "findings": 2-5 objects of {"title", "detail", "severity"} where severity is',
    '              "high", "medium" or "low". Each is something TRUE ACROSS several',
    '              readouts — a pattern, not a restatement of one lift\'s percentage.',
    '  "recommendations": 1-4 objects of {"action", "why"}. Specific and doable this',
    '                     week. Name the lift or the number. "Train harder" is not one.',
    '  "caveats": 0-3 strings. Where this data is weak or could mislead. Say so plainly',
    '             rather than hedging every finding.',
    '',
    'Keep every string short enough to read on a phone. Address him as "you".',
  ].join('\n');
}
