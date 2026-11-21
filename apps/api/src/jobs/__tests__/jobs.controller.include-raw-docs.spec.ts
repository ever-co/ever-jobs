import 'reflect-metadata';
import { JobsController } from '../jobs.controller';

/** `@nestjs/swagger` metadata keys (`DECORATORS.API_RESPONSE` / `API_PARAMETERS`; the package does not export them). */
const API_RESPONSE = 'swagger/apiResponse';
const API_PARAMETERS = 'swagger/apiParameters';

/**
 * Fork-sync hardening, round 3: the OpenAPI text for `include_raw` must match
 * what the running app answers. With API key auth on, the global ApiKeyGuard
 * refuses a missing or unknown key with 403 before the handler runs, so no
 * 401 can reach a caller; and both "why is the body missing" flags are
 * documented (`bodies_withheld` from capture, `body_withheld` from the API).
 */
describe('POST /api/jobs/search include_raw OpenAPI text', () => {
  const handler = JobsController.prototype.searchJobs;
  const responses = Reflect.getMetadata(API_RESPONSE, handler) as Record<string, { description?: string }>;
  const parameters = Reflect.getMetadata(API_PARAMETERS, handler) as Array<{
    name?: string;
    description?: string;
  }>;
  const includeRaw = parameters.find((p) => p.name === 'include_raw');

  it('documents no 401, and 403 for a missing or unknown key', () => {
    expect(Object.keys(responses)).not.toContain('401');
    expect(responses['403'].description).toMatch(/missing or unknown API key/);
    expect(responses['503'].description).toMatch(/API key auth is off/);
    expect(includeRaw?.description).not.toMatch(/401/);
    expect(includeRaw?.description).toMatch(/missing or unknown key gets 403/);
  });

  it('documents both withheld flags', () => {
    expect(includeRaw?.description).toContain('bodies_withheld: "opt_out" | "auth_endpoint"');
    expect(includeRaw?.description).toContain('body_withheld: "caller_supplied_url"');
  });
});
