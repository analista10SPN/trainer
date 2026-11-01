/**
 * Saying it in Spanish, and the two things that are not string lookup.
 *
 * The app is used in the Dominican Republic by three people, two of whom speak
 * Spanish first. The count is measured rather than guessed: **~618 user-facing
 * strings in `app.js`** and **~151 in `public/lib`** — because translating this
 * app means translating the coach's verdicts, not just its buttons.
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is the mechanism, plus the two parts a message catalog cannot solve:
 *
 * 1. **Plurals are not `n === 1 ? '' : 's'`.** That shape appears twenty-odd
 *    times in `app.js`, is right in English by luck, is wrong in most languages,
 *    and is already wrong *in English* in one place — the program header renders
 *    "4 day". `Intl.PluralRules` knows the categories; a ternary does not.
 * 2. **Eight `toLocale*` calls pass `undefined`**, so they follow the *device*
 *    locale rather than the app's. Spanish prose around English dates reads
 *    worse than either one on its own.
 *
 * It is **not** the extraction of the view layer, and that is a sequencing
 * decision rather than an unfinished job. 364 of those `app.js` strings sit
 * inside multi-line template literals interleaved with markup and values, so
 * they cannot be lifted key-by-key without touching nearly every view function —
 * and `app.js` is still due to be split (`logging.js` and `syncProtocol.js` are
 * the open tails of that work). Extracting strings out of a file that is about
 * to be cut up means doing it twice, and the second pass would be the one that
 * introduces the mistakes.
 *
 * ## The fallback rule
 *
 * A missing Spanish string falls back to English rather than rendering its key.
 * A key on screen is a bug the user has to report; English prose in a Spanish
 * app is a gap they can live with.
 *
 * Which is exactly what makes `missingKeys` load-bearing. Without a test over
 * it, a half-written catalog is indistinguishable from a finished one, because
 * every gap renders as perfectly good English — the same failure shape as the
 * written coach going two months without being told about sleep.
 */

export const LOCALES = ['en', 'es'];
export const DEFAULT_LOCALE = 'en';

/**
 * The best supported language for a list of preferences.
 *
 * Takes `navigator.languages`, which is ordered by preference and full of region
 * tags — `es-DO` is Spanish, and a phone set to French with Spanish second
 * should get Spanish rather than falling through to English.
 */
export function resolveLocale(preferred) {
  const asked = Array.isArray(preferred) ? preferred : [];

  for (const tag of asked) {
    const language = String(tag ?? '').trim().toLowerCase().split('-')[0];
    if (LOCALES.includes(language)) return language;
  }
  return DEFAULT_LOCALE;
}

/** `{name}` placeholders. A key nobody filled is left visible, not printed as undefined. */
function fill(text, vars) {
  const values = vars ?? {};
  return String(text).replace(/\{(\w+)\}/g, (whole, name) => (
    // `in`, not a truthiness check: a real 0 is a value, and treating it as
    // absent is the `Number(null) === 0` mistake running the other way.
    name in values && values[name] !== undefined && values[name] !== null
      ? String(values[name])
      : whole
  ));
}

const rules = new Map();

function categoryFor(locale, n) {
  const key = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  if (!rules.has(key)) rules.set(key, new Intl.PluralRules(key));

  const count = Number(n);
  if (!Number.isFinite(count)) return 'other';
  return rules.get(key).select(count);
}

/**
 * One of a set of plural forms, with the count interpolated.
 *
 * `forms` is keyed by CLDR category — `one`, `other`, and whatever else a
 * language needs. A category the language asks for and nobody wrote falls back
 * to `other`, which is wrong-but-readable rather than blank.
 */
export function countOf(locale, n, forms) {
  const set = forms ?? {};
  const text = set[categoryFor(locale, n)] ?? set.other ?? '';
  return fill(text, { n: Number.isFinite(Number(n)) ? Number(n) : n });
}

/**
 * A lookup function for one locale.
 *
 * `catalogs` is keyed by locale; `fallbacks` is the same shape and is consulted
 * when the first has nothing. Both are arguments rather than imports so this
 * module stays pure and a test can hand it two small objects.
 */
export function translator(locale, catalogs, fallbacks) {
  const wanted = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const primary = catalogs?.[wanted] ?? {};
  const backup = fallbacks?.[DEFAULT_LOCALE] ?? {};

  return function t(key, vars) {
    const id = String(key ?? '');
    if (!id) return '';

    const found = primary[id] ?? backup[id];
    if (found === undefined) return id;

    // A plural entry is an object of forms, so it needs the count to resolve.
    if (found !== null && typeof found === 'object') {
      return countOf(wanted, vars?.n, found);
    }
    return fill(found, vars);
  };
}

/**
 * Keys in `source` that `target` has no entry for.
 *
 * The honest half of the fallback rule: a gap renders as good English, so the
 * only way to know a catalog is incomplete is to ask.
 */
export function missingKeys(source, target) {
  const have = new Set(Object.keys(target ?? {}));
  return Object.keys(source ?? {}).filter((key) => !have.has(key)).sort();
}
