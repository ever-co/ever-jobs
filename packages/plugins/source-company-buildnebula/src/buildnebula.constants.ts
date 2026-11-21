export const BUILDNEBULA_COMPANY_NAME = 'Nebula';
export const BUILDNEBULA_ORIGIN = 'https://buildnebula.com';
export const BUILDNEBULA_DEFAULT_TIMEOUT_SECONDS = 30;
/**
 * Hosts this plugin may fetch — mirrors `companyDomains` (Spec 1689). A
 * caller-supplied `companyUrl` elsewhere is ignored in favour of
 * {@link BUILDNEBULA_ORIGIN}, and every redirect hop is pinned to them.
 */
export const BUILDNEBULA_ALLOWED_HOSTS: readonly string[] = ['buildnebula.com'];
/** First-party board API the careers SPA reads. */
export const BUILDNEBULA_LISTINGS_PATH = '/api/careers/listings';
/**
 * `job.team` tokens → the display labels the site's own careers page uses.
 */
export const BUILDNEBULA_TEAM_LABELS: Record<string, string> = {
  materials: 'Materials',
  cybernetics: 'Cybernetics',
  production: 'Production',
  business_operations: 'Business & Operations',
};
