export const WERCOMFG_COMPANY_NAME = 'Werco Manufacturing';
export const WERCOMFG_ORIGIN = 'https://www.wercomfg.com';
export const WERCOMFG_CAREERS_URL = `${WERCOMFG_ORIGIN}/careers`;
export const WERCOMFG_DEFAULT_TIMEOUT_SECONDS = 30;
/**
 * Hosts this plugin may fetch — mirrors `companyDomains` (Spec 1689). A
 * caller-supplied `companyUrl` elsewhere is ignored in favour of
 * {@link WERCOMFG_CAREERS_URL}, detail links elsewhere are dropped, and every
 * redirect hop is pinned to them.
 */
export const WERCOMFG_ALLOWED_HOSTS: readonly string[] = ['wercomfg.com'];
/**
 * Most detail pages fetched per scrape. The live board lists about a dozen
 * roles; the cap keeps a hostile or broken index from fanning out into
 * thousands of requests.
 */
export const WERCOMFG_MAX_DETAIL_LINKS = 50;
/** Detail links look like `/careers/{slug}` on the index page. */
export const WERCOMFG_DETAIL_LINK_RE = /^\/careers\/[^/?#]+\/?$/;
/** Only apply target published on the site — a shared mailbox. */
export const WERCOMFG_APPLY_MAILTO = 'mailto:info@wercomfg.com';
