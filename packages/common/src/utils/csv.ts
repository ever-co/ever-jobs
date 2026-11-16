/**
 * CSV cell helper shared by the API and the CLI exports.
 *
 * Job fields are scraped from third-party boards, so they are untrusted. A
 * text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is
 * run as a formula by spreadsheet apps (CSV injection). Such cells get a
 * leading single quote, which spreadsheets show as plain text.
 */

/** First characters that make a spreadsheet read a text cell as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Characters that force a cell to be quoted. */
const NEEDS_QUOTING = /[",\n\r]/;

/**
 * Render one value as a CSV cell.
 *
 * - `null` / `undefined` become an empty cell.
 * - Finite numbers, bigints and booleans are written as-is, so `-5` stays `-5`.
 * - Strings that start with a formula character are prefixed with `'`.
 * - Cells holding `,` `"` `\n` or `\r` are quoted and inner quotes are doubled.
 * - Other objects are written as JSON.
 */
export function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text: string;
  let isText = true;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    text = String(value);
    // A non-finite number is not a real numeric cell; treat it as text.
    isText = typeof value === 'number' && !Number.isFinite(value);
  } else if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  } else {
    text = JSON.stringify(value) ?? '';
  }

  if (isText && FORMULA_LEAD.test(text)) text = `'${text}`;
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
