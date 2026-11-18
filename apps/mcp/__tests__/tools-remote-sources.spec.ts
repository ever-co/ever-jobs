import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { Site } from '@ever-jobs/models';
import { compareSources, listSources, MCP_REQUEST_KEYS_ENV_VAR, searchRemoteJobs } from '../src/tools';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

/**
 * T-2635 — the MCP catalogue must mark every remote-first board as `remote`.
 *
 * `packages/plugins/source-4dayweek` declares `category: 'remote'`, but the
 * MCP catalogue listed `fourdayweek` as a `job_board`. `searchRemoteJobs`
 * builds its board list from the catalogue's `remote` entries, so a search
 * without `source` left 4 Day Week out, and `source: 'fourdayweek'` was
 * treated as "not a remote board": the tool searched every other remote board
 * and never 4 Day Week. `list_sources` and `compare_sources` with type
 * `remote` missed it too, and the `search_remote_jobs` description named only
 * six of the boards.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'packages', 'plugins');

const createMock = axios.create as unknown as jest.Mock;

function mockClient() {
  const client = {
    post: jest.fn().mockResolvedValue({ data: { jobs: [] } }),
    get: jest.fn().mockResolvedValue({ data: {} }),
  };
  createMock.mockReturnValue(client);
  return client;
}

function remoteIds(): string[] {
  return listSources('remote').sources.map((s) => s.id);
}

/**
 * The `Site` value of every plugin whose `@SourcePlugin({ ... })` metadata
 * declares `category: 'remote'`, read from the plugins' `src/*.service.ts`
 * files (the file that carries the decorator, `AGENTS.md` §5).
 */
function pluginRemoteSites(): string[] {
  const siteValues = Site as unknown as Record<string, string>;
  const found: string[] = [];
  for (const pkg of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = path.join(PLUGINS_DIR, pkg.name, 'src');
    let files: string[];
    try {
      files = fs.readdirSync(srcDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.service.ts')) continue;
      const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
      const start = source.indexOf('@SourcePlugin(');
      if (start === -1) continue;
      // The metadata object runs from the decorator to the class it decorates.
      const end = source.slice(start).search(/\n\s*(?:@Injectable|export\s+class)\b/);
      const metadata = end === -1 ? source.slice(start) : source.slice(start, start + end);
      if (!/\bcategory\s*:\s*['"]remote['"]/.test(metadata)) continue;
      const site = metadata.match(/\bsite\s*:\s*Site\.(\w+)/);
      if (!site) throw new Error(`${pkg.name}/src/${file}: remote plugin with no 'site: Site.<KEY>'`);
      const value = siteValues[site[1]];
      if (value === undefined) throw new Error(`${pkg.name}/src/${file}: Site.${site[1]} is not a Site value`);
      found.push(value);
    }
  }
  return found.sort();
}

// The request-body tests read the default camelCase keys (`siteType`);
// `EVER_JOBS_MCP_REQUEST_KEYS=snake` would send `site_type`, so it is cleared
// per test and restored afterwards, as the neighbouring MCP suites do.
let savedRequestKeys: string | undefined;

beforeEach(() => {
  createMock.mockReset();
  savedRequestKeys = process.env[MCP_REQUEST_KEYS_ENV_VAR];
  delete process.env[MCP_REQUEST_KEYS_ENV_VAR];
});

afterEach(() => {
  if (savedRequestKeys === undefined) delete process.env[MCP_REQUEST_KEYS_ENV_VAR];
  else process.env[MCP_REQUEST_KEYS_ENV_VAR] = savedRequestKeys;
});

describe('MCP catalogue — remote boards (T-2635)', () => {
  it('lists 4 Day Week as a remote board', () => {
    expect(remoteIds()).toContain('fourdayweek');
    expect(listSources('job_board').sources.map((s) => s.id)).not.toContain('fourdayweek');
  });

  it('compare_sources counts 4 Day Week among the remote boards', () => {
    const remote = compareSources().types.find((t) => t.type === 'remote');
    expect(remote).toBeDefined();
    expect(remote!.sources).toContain('4 Day Week');
    expect(remote!.count).toBe(remoteIds().length);
  });

  // Guard: the catalogue's remote boards are exactly the plugins that declare
  // `category: 'remote'`, so a remote plugin cannot be filed under another
  // type (or a catalogue entry marked remote without a remote plugin) again.
  // The scan reads ~2 000 plugin service files: a few seconds on a busy PC.
  it('marks as remote exactly the plugins that declare category "remote"', () => {
    const plugins = pluginRemoteSites();
    expect(plugins.length).toBeGreaterThan(0);
    expect([...remoteIds()].sort()).toEqual(plugins);
  }, 60_000);
});

describe('searchRemoteJobs — 4 Day Week (T-2635)', () => {
  it('posts only fourdayweek when source is "fourdayweek"', async () => {
    const client = mockClient();
    const result = await searchRemoteJobs({ query: 'designer', source: 'fourdayweek' });

    expect(client.post).toHaveBeenCalledTimes(1);
    const [apiPath, body] = client.post.mock.calls[0];
    expect(apiPath).toBe('/api/jobs/search');
    expect(body.siteType).toEqual(['fourdayweek']);
    expect(body).toMatchObject({ searchTerm: 'designer', location: 'Remote' });
    expect(result.sources_searched).toEqual(['fourdayweek']);
  });

  it('includes fourdayweek when no source is given', async () => {
    const client = mockClient();
    const result = await searchRemoteJobs({ query: 'designer' });

    const body = client.post.mock.calls[0][1];
    expect(body.siteType).toContain('fourdayweek');
    expect(result.sources_searched).toContain('fourdayweek');
  });
});

/**
 * The tool descriptions MCP clients read must not name a stale subset of the
 * remote boards: they name every remote board, or none.
 */
describe('search_remote_jobs description — no stale subset of boards (T-2635)', () => {
  const remote = listSources('remote').sources;

  function namedBoards(text: string): string[] {
    return remote.filter((s) => text.includes(s.name)).map((s) => s.name);
  }

  function section(text: string, from: string, to: string): string {
    const start = text.indexOf(from);
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf(to, start + from.length);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  it('in apps/mcp/src/index.ts names every remote board or none', () => {
    const index = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'mcp', 'src', 'index.ts'), 'utf8');
    const description = section(index, "name: 'search_remote_jobs'", 'inputSchema');
    expect([0, remote.length]).toContain(namedBoards(description).length);
  });

  it('in apps/mcp/README.md names every remote board or none', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'mcp', 'README.md'), 'utf8');
    const description = section(readme, '### `search_remote_jobs`', '| Parameter');
    expect([0, remote.length]).toContain(namedBoards(description).length);
  });

  it('the search guide lists exactly the remote boards under "Remote Boards"', () => {
    const index = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'mcp', 'src', 'index.ts'), 'utf8');
    const line = index.split('\n').find((l) => l.startsWith('- **Remote Boards**:'));
    expect(line).toBeDefined();
    const ids = line!.replace('- **Remote Boards**:', '').split(',').map((id) => id.trim()).filter(Boolean);
    expect([...ids].sort()).toEqual([...remoteIds()].sort());
  });
});
