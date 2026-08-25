/**
 * Charts, as inline SVG strings.
 *
 * The app renders by replacing innerHTML, so a chart has to be a string. No
 * library: one accent series per chart, drawn into a viewBox that scales to
 * whatever width the phone gives it.
 *
 * Single-series by design. Two measures on one pair of axes is the most common
 * way a chart lies, so volume and strength are two charts, never two y-scales.
 *
 * Direction is never colour alone — an arrow and a word travel with it, because
 * the green and red used for rising and falling are 4.7 ΔE apart under
 * deuteranopia and indistinguishable to a good number of people.
 */

import { numeric } from './strength.js';

const PAD = { top: 14, right: 14, bottom: 22, left: 34 };
const W = 320;
const H = 150;

const round = (n, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Round ticks a person would choose, covering the data with a little air. */
export function niceScale(min, max, ticks = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }

  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;

  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;

  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(round(v, 4));
  return { min: lo, max: hi, step, ticks: out };
}

/** Where a value sits, vertically, inside the plot. */
function projector(scale) {
  const span = scale.max - scale.min || 1;
  return (value) => PAD.top + (1 - (value - scale.min) / span) * (H - PAD.top - PAD.bottom);
}

function xPositions(count) {
  const left = PAD.left;
  const right = W - PAD.right;
  if (count <= 1) return [(left + right) / 2];
  return Array.from({ length: count }, (_, i) => left + (i / (count - 1)) * (right - left));
}

function grid(scale, y) {
  return scale.ticks
    .map(
      (t) =>
        `<line class="c-grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${round(y(t))}" y2="${round(y(t))}"/>` +
        `<text class="c-tick" x="${PAD.left - 6}" y="${round(y(t) + 3)}" text-anchor="end">${round(t, 0)}</text>`,
    )
    .join('');
}

/**
 * Change over time.
 *
 * @param points [{ label, value, detail }] oldest first
 */
export function lineChart(points = [], { unit = '', title = '' } = {}) {
  const usable = points.filter((p) => numeric(p.value) !== null);
  if (usable.length < 2) {
    return `<div class="c-empty">Not enough sessions to draw a line yet.</div>`;
  }

  const values = usable.map((p) => Number(p.value));
  const scale = niceScale(Math.min(...values), Math.max(...values));
  const y = projector(scale);
  const xs = xPositions(usable.length);

  const path = usable.map((p, i) => `${i ? 'L' : 'M'}${round(xs[i])},${round(y(Number(p.value)))}`).join('');
  const area = `${path}L${round(xs.at(-1))},${H - PAD.bottom}L${round(xs[0])},${H - PAD.bottom}Z`;

  const last = usable.at(-1);
  const lastX = xs.at(-1);
  const lastY = y(Number(last.value));

  // Hit targets are far wider than the dots, because this is used with a thumb.
  const hits = usable
    .map((p, i) => {
      const half = (W - PAD.left - PAD.right) / Math.max(1, usable.length - 1) / 2;
      return `<rect class="c-hit" x="${round(xs[i] - half)}" y="${PAD.top}" width="${round(half * 2)}" height="${H - PAD.top - PAD.bottom}"
        data-i="${i}" data-label="${esc(p.label)}" data-value="${esc(round(Number(p.value), 1))}${esc(unit)}" data-detail="${esc(p.detail ?? '')}"/>`;
    })
    .join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}">
      ${grid(scale, y)}
      <path class="c-area" d="${area}"/>
      <path class="c-line" d="${path}"/>
      ${usable.map((p, i) => `<circle class="c-dot" cx="${round(xs[i])}" cy="${round(y(Number(p.value)))}" r="3"/>`).join('')}
      <circle class="c-dot c-dot-last" cx="${round(lastX)}" cy="${round(lastY)}" r="4.5"/>
      <text class="c-label" x="${round(lastX)}" y="${round(lastY - 9)}" text-anchor="end">${round(Number(last.value), 0)}${esc(unit)}</text>
      <text class="c-tick" x="${PAD.left}" y="${H - 6}">${esc(usable[0].label)}</text>
      <text class="c-tick" x="${W - PAD.right}" y="${H - 6}" text-anchor="end">${esc(last.label)}</text>
      ${hits}
    </svg>`;
}

/**
 * Magnitude over time.
 *
 * Bars are anchored to the baseline with rounded tops, and separated by a gap so
 * two adjacent sessions never read as one block.
 */
export function barChart(bars = [], { unit = '', title = '' } = {}) {
  const usable = bars.filter((b) => numeric(b.value) !== null);
  if (!usable.length) return `<div class="c-empty">Nothing logged yet.</div>`;

  const values = usable.map((b) => Number(b.value));
  const scale = niceScale(Math.min(0, ...values), Math.max(...values));
  const y = projector(scale);

  const span = W - PAD.left - PAD.right;
  const slot = span / usable.length;
  const width = Math.max(4, Math.min(26, slot - 4)); // the 4 is the surface gap
  const base = y(Math.max(0, scale.min));

  const marks = usable
    .map((b, i) => {
      const x = PAD.left + slot * i + (slot - width) / 2;
      const top = y(Number(b.value));
      const height = Math.max(2, base - top);
      return `<rect class="c-bar" x="${round(x)}" y="${round(top)}" width="${round(width)}" height="${round(height)}" rx="4"
        data-i="${i}" data-label="${esc(b.label)}" data-value="${esc(Math.round(Number(b.value)).toLocaleString())}${esc(unit)}" data-detail="${esc(b.detail ?? '')}"/>`;
    })
    .join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}">
      ${grid(scale, y)}
      ${marks}
      <text class="c-tick" x="${PAD.left}" y="${H - 6}">${esc(usable[0].label)}</text>
      ${usable.length > 1 ? `<text class="c-tick" x="${W - PAD.right}" y="${H - 6}" text-anchor="end">${esc(usable.at(-1).label)}</text>` : ''}
    </svg>`;
}

/**
 * A direction, said in three ways at once: an arrow, a word, and a colour.
 *
 * Green and red sit 4.7 ΔE apart under deuteranopia, so colour on its own is
 * not a signal — it is decoration on top of one.
 */
export function trendBadge(percent, { unit = '%/session' } = {}) {
  if (numeric(percent) === null) {
    return `<span class="pill">not enough data</span>`;
  }

  const value = Number(percent);
  const [tone, arrow, word] =
    value >= 1 ? ['pill-good', '▲', 'up'] : value <= -1 ? ['pill-bad', '▼', 'down'] : ['', '—', 'flat'];

  return `<span class="pill ${tone}"><span aria-hidden="true">${arrow}</span> ${word} ${value > 0 ? '+' : ''}${round(value, 1)}${esc(unit)}</span>`;
}
