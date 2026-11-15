/**
 * Strict parsing and bounds for the numeric flags shared by the `search` and
 * `compare` commands (`--results`, `--offset`, `--hours-old`, `--distance`,
 * `--timeout`, `--rate-delay-min`, `--rate-delay-max`, `--linkedin-company-ids`).
 *
 * Before this module the flags went through `parseInt` / `parseFloat`, which
 * (a) turned `--results abc` into `NaN` — `NaN ?? 15` is `NaN`, so the search ran
 * with `resultsWanted: NaN` and nothing said why it came back empty — and
 * (b) accepted `5x`, `1e3` and `20.7` as `5`, `1` and `20`. They also had no
 * upper bound, so a typo such as `-n 100000000` was passed on as written.
 *
 * Same stance as the crawl flags (`crawl-options.ts`): the parser returns `NaN`
 * for text that is not a plain number (commander hands it the raw string), and
 * `applyNumericCliOptions` drops every invalid or out-of-range value with a
 * warning on stderr, so the built-in default applies.
 */

/** Plain decimal digits only: no sign, no exponent, no suffix. */
const INTEGER_RE = /^\d+$/;
/** Plain decimal number: `5`, `0.5`, `.5`, `2.` — no sign, no exponent. */
const DECIMAL_RE = /^(?:\d+\.?\d*|\.\d+)$/;

/** Parse a whole number; `NaN` for anything else (incl. `-1`, `5x`, `1e3`, `1.5`, ``). */
export function parseCliInteger(val: string): number {
  const text = String(val).trim();
  return INTEGER_RE.test(text) ? Number(text) : Number.NaN;
}

/** Parse a non-negative decimal (seconds); `NaN` for anything else. */
export function parseCliDecimal(val: string): number {
  const text = String(val).trim();
  return DECIMAL_RE.test(text) ? Number(text) : Number.NaN;
}

interface NumericFlagSpec {
  readonly key: string;
  readonly flag: string;
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

/**
 * Accepted range per flag (both ends inclusive). The upper bounds are far above
 * any real use and only stop typos; the server applies its own, tighter
 * `EVER_JOBS_MAX_RESULTS_WANTED` clamp on top.
 */
export const NUMERIC_FLAGS: readonly NumericFlagSpec[] = [
  { key: 'results', flag: '--results', min: 1, max: 100_000, integer: true },
  { key: 'offset', flag: '--offset', min: 0, max: 100_000, integer: true },
  { key: 'hoursOld', flag: '--hours-old', min: 0, max: 87_600, integer: true }, // 10 years
  { key: 'distance', flag: '--distance', min: 0, max: 25_000, integer: true },
  { key: 'timeout', flag: '--timeout', min: 1, max: 3_600, integer: true },
  { key: 'rateDelayMin', flag: '--rate-delay-min', min: 0, max: 3_600, integer: false },
  { key: 'rateDelayMax', flag: '--rate-delay-max', min: 0, max: 3_600, integer: false },
];

const LINKEDIN_COMPANY_IDS_FLAG = '--linkedin-company-ids';

function rangeWarning(spec: NumericFlagSpec): string {
  const kind = spec.integer ? 'a whole number' : 'a number';
  return `${spec.flag} must be ${kind} from ${spec.min} to ${spec.max}; ignoring it`;
}

/**
 * Return a copy of `options` with every invalid numeric flag removed, plus one
 * warning per removed flag. Options that were not given, and valid values, are
 * returned unchanged.
 */
export function sanitizeNumericOptions<T extends object>(
  options: T,
): { options: T; warnings: string[] } {
  const warnings: string[] = [];
  const clean: Record<string, unknown> = { ...options };

  for (const spec of NUMERIC_FLAGS) {
    const value = clean[spec.key];
    if (value === undefined) continue;
    const ok =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= spec.min &&
      value <= spec.max &&
      (!spec.integer || Number.isInteger(value));
    if (!ok) {
      warnings.push(rangeWarning(spec));
      delete clean[spec.key];
    }
  }

  const ids = clean.linkedinCompanyIds;
  if (Array.isArray(ids)) {
    const valid = ids.filter((id) => Number.isSafeInteger(id) && id >= 1);
    if (valid.length !== ids.length) {
      warnings.push(`${LINKEDIN_COMPANY_IDS_FLAG} takes whole numbers of 1 or more; ignoring the invalid ones`);
    }
    if (valid.length > 0) clean.linkedinCompanyIds = valid;
    else delete clean.linkedinCompanyIds;
  }

  return { options: clean as T, warnings };
}

/** `sanitizeNumericOptions`, printing the warnings to stderr like the other CLI diagnostics. */
export function applyNumericCliOptions<T extends object>(options: T): T {
  const { options: clean, warnings } = sanitizeNumericOptions(options);
  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }
  return clean;
}
