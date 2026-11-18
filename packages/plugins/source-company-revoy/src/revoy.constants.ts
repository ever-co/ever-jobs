export const REVOY_COMPANY_NAME = 'Revoy';
export const REVOY_ORIGIN = 'https://www.revoy.com';
export const REVOY_CAREERS_URL = `${REVOY_ORIGIN}/join-the-team`;
export const REVOY_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Hosts the careers index may be fetched from — mirrors `companyDomains`
 * (Spec 1689). A caller-supplied `companyUrl` elsewhere is ignored in favour
 * of {@link REVOY_CAREERS_URL}, and every redirect hop is pinned to them.
 */
export const REVOY_ALLOWED_HOSTS: readonly string[] = ['revoy.com'];
/**
 * Host a role link on the index must point at to be followed. The doc id is
 * read only from such a link, and only on the pinned index page.
 */
export const REVOY_DOC_LINK_HOSTS: readonly string[] = ['docs.google.com'];
/**
 * Redirect pin for the txt export: docs.google.com answers the export with
 * a redirect to a `*.googleusercontent.com` download host, which
 * `pinUrlToHosts` accepts as a subdomain of `googleusercontent.com`.
 */
export const REVOY_DOC_ALLOWED_HOSTS: readonly string[] = ['docs.google.com', 'googleusercontent.com'];
/** Most role docs fetched per scrape; the live page lists a handful. */
export const REVOY_MAX_DOCS = 50;
/** Longest doc text parsed (and kept as description), in characters. */
export const REVOY_MAX_DOC_CHARS = 64 * 1024;
/** Largest txt export downloaded, in bytes; a bigger one degrades to link-only fields. */
export const REVOY_MAX_DOC_BYTES = 2 * 1024 * 1024;

/** Role rows: `<a class="link-12" href="…/document/d/{id}/edit">{title}</a> — {place}`. */
export const REVOY_LINK_SELECTOR = 'a[href*="/document/d/"]';
export const REVOY_DOC_ID_RE = /\/document\/d\/([A-Za-z0-9_-]+)/;
export const REVOY_DOC_EXPORT = (docId: string): string =>
  `https://docs.google.com/document/d/${docId}/export?format=txt`;

/** ` — City, ST` trailing the link in the row's parent text. */
export const REVOY_ROW_LOCATION_RE = /\s[—–-]\s+(.+)$/;

/*
 * Doc headers. Google's txt export uses CRLF. Doc 2 has labeled lines
 * (`Location: Troutdale, OR (on-site)`); doc 1 has caps blocks with the
 * value on the next line (`\tLOCATION\r\nPortland, OR\r\n`) or after a tab.
 *
 * Every pattern is linear (Spec 1689). The fork's `^\s*` (with /m) re-scanned
 * a whole run of blank lines from every line start, and `(.+?)\s*$` /
 * `[^\n]+?\s*(?:\n|\t|$)` re-scanned trailing whitespace at every lazy step,
 * so a doc of blank lines or of one padded line took tens of seconds on the
 * API event loop. Here leading whitespace is `[ \t]*` (one line only), a
 * label may be followed by whole blank lines `(?:[ \t]*\r?\n)*` (each
 * iteration ends at a newline, so a run splits one way only), and the value
 * is captured greedily to the end of its line (`[^\r\n]*`, or `[^\n\t]*` for
 * the blocks) and trimmed in code — nothing after the capture can fail.
 */
/** `Location: <value>` (the value may sit on a later line). Trim group 1. */
export const REVOY_DOC_LOCATION_RE =
  /^[ \t]*(?:Location|LOCATION)[ \t]*:(?:[ \t]*\r?\n)*[ \t]*([^\r\n]*)/m;
/** `LOCATION<tab or newline>Portland, OR` — value up to a tab or newline. Trim group 1. */
export const REVOY_DOC_LOCATION_BLOCK_RE =
  /LOCATION(?:(?:[ \t]*\r?\n)+[ \t]*|[ \t]+)([A-Z][^\n\t]*)/;
/** `Department: <value>` / `FUNCTION: <value>`. Trim group 1. */
export const REVOY_DOC_DEPARTMENT_RE =
  /^[ \t]*(?:Department|FUNCTION)[ \t]*:(?:[ \t]*\r?\n)*[ \t]*([^\r\n]*)/m;
/** `FUNCTION<tab or newline>Finance` — value up to a tab or newline. Trim group 1. */
export const REVOY_DOC_DEPARTMENT_BLOCK_RE = /FUNCTION(?:(?:[ \t]*\r?\n)+[ \t]*|[ \t]+)([^\n\t]*)/;
/** `Type: <value>`. Trim group 1. */
export const REVOY_DOC_TYPE_RE = /^[ \t]*Type[ \t]*:(?:[ \t]*\r?\n)*[ \t]*([^\r\n]*)/m;

export const REVOY_ONSITE_RE = /\(\s*(?:on[-\s]?site|onsite)\s*\)/i;
export const REVOY_REMOTE_RE = /\(\s*remote\s*\)/i;
export const REVOY_HYBRID_RE = /\(\s*hybrid\s*\)/i;
