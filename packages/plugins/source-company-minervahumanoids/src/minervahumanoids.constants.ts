export const MINERVAHUMANOIDS_COMPANY_NAME = 'Minerva Humanoids';
export const MINERVAHUMANOIDS_ORIGIN = 'https://www.minervahumanoids.com';
export const MINERVAHUMANOIDS_DEFAULT_TIMEOUT_SECONDS = 30;
/**
 * Hosts this plugin may fetch — mirrors `companyDomains` (Spec 1689). A
 * caller-supplied `companyUrl` elsewhere is ignored in favour of
 * {@link MINERVAHUMANOIDS_ORIGIN}, and every redirect hop is pinned to them.
 */
export const MINERVAHUMANOIDS_ALLOWED_HOSTS: readonly string[] = ['minervahumanoids.com'];
/** Hand-rolled static CMS data file the careers page renders from. */
export const MINERVAHUMANOIDS_PUBLISHED_PATH = '/content/published.js';
/** The page's apply-form anchors (regular roles vs talent program). */
export const MINERVAHUMANOIDS_APPLY_ANCHOR = '#apply';
export const MINERVAHUMANOIDS_TALENT_APPLY_ANCHOR = '#talent-apply';
