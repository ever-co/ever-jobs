# Ever Jobs MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets AI assistants like **ChatGPT**, **Claude**, **GitHub Copilot**, and others search for jobs across **65+ sources** — including LinkedIn, Indeed, Glassdoor, company career pages, and ATS platforms.

## Quick Start

### Install & Run

```bash
# From the ever-jobs monorepo root
cd apps/mcp
npm install
npm run build
npm start          # starts the MCP server in stdio mode
```

### Connect to Claude Desktop

Add to your Claude Desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ever-jobs": {
      "command": "node",
      "args": ["<path-to>/ever-jobs/apps/mcp/dist/index.js"],
      "env": {
        "EVER_JOBS_API_URL": "http://localhost:3001"
      }
    }
  }
}
```

### Connect to ChatGPT / Other Clients

Use any MCP-compatible client. The server communicates via **stdio** (standard input/output).

## Tools

### `search_jobs`

Search for jobs across all sources.

| Parameter     | Type    | Required | Description                                        |
| ------------- | ------- | -------- | -------------------------------------------------- |
| `query`       | string  | ✅       | Job search query (e.g. "software engineer")        |
| `location`    | string  | ❌       | Location filter (e.g. "San Francisco", "Remote")   |
| `source`      | string  | ❌       | Specific source id (use `list_sources` to see all) |
| `company`     | string  | ❌       | Company slug for ATS sources (e.g. "stripe")       |
| `limit`       | number  | ❌       | Max results (default: 20, max: 100)                |
| `remote_only` | boolean | ❌       | Filter to remote positions only                    |
| `locations`   | string[] | ❌      | Several locations in one call (schema limit 10 items; the server searches the first `EVER_JOBS_SEARCH_MAX_LOCATIONS`, default 10). Each source runs once per location; same-source duplicates are removed; `location`, when also set, is searched first |
| `exclude_title_terms` | string[] | ❌ | Drop jobs whose title contains any of these words or phrases (up to 50; literal, whole-word, trailing `*` = prefix, never a regex) |
| `exclude_keywords` | string[] | ❌ | Drop jobs whose title or description contains any of these words or phrases (up to 50; same rules) |
| `exclude_presets` | string[] | ❌ | Curated exclusion lists; `security_clearance` drops roles that require a security clearance or vetting |
| `crawl`       | object  | ❌       | Per-request crawl policy (Spec 1690), camelCase    |

`crawl` is forwarded to the API unchanged as the `crawl` field (same key in every
`EVER_JOBS_MCP_REQUEST_KEYS` style); see [`docs/CRAWL_POLICY.md`](../../docs/CRAWL_POLICY.md).

### `get_job_details`

Get the full details of a job that a recent search returned: the untruncated description
(`full_description`; search results cut `description` at 500 characters), salary and application link.

| Parameter | Type   | Required | Description                          |
| --------- | ------ | -------- | ------------------------------------ |
| `job_url` | string | ❌       | The job's `url` from a search result |
| `job_id`  | string | ❌       | The job's `id` from a search result  |

Give one of the two, or both from the same result: a few sources reuse an id across searches, and
with both the job that has both is returned. The API has no endpoint that returns a single job, so
`get_job_details` makes no API request: it answers from the last 1000 jobs that `search_jobs`,
`search_remote_jobs` and `get_salary_insights` received in this server process (the oldest are
dropped first; a search that returns more than 1000 jobs keeps its first 1000). Any other job gets
the error `job not found in recent search results; call search_jobs first`.

Details therefore work for jobs found by the same server process. The memory is lost when the
process restarts, and it is shared by every client of that process. In HTTP mode
(`MCP_TRANSPORT=http`) each replica keeps its own, so behind a load balancer a details call can
reach a replica that did not run the search and get that error.

### `list_sources`

List all available job sources.

| Parameter | Type   | Required | Description                                                          |
| --------- | ------ | -------- | -------------------------------------------------------------------- |
| `type`    | string | ❌       | Filter: `all`, `job_board`, `ats`, `company`, `remote`, `aggregator` |

### `search_remote_jobs`

Search for remote-only positions across every remote-first job board (the sources that `list_sources` reports with type `remote`).

Without `source`, or with a `source` that is not a remote board, every board that `list_sources` reports with type `remote` is searched, and `sources_searched` lists them. A remote `source` searches that board alone.

| Parameter | Type   | Required | Description                      |
| --------- | ------ | -------- | -------------------------------- |
| `query`   | string | ✅       | Job search query                 |
| `source`  | string | ❌       | Specific remote source to target |
| `limit`   | number | ❌       | Max results (default: 25)        |

### `get_salary_insights`

Aggregate salary data from job search results. Returns min, max, median, P25, and P75 salary statistics.

| Parameter  | Type   | Required | Description                            |
| ---------- | ------ | -------- | -------------------------------------- |
| `query`    | string | ✅       | Job title/role to research             |
| `location` | string | ❌       | Location to focus on                   |
| `limit`    | number | ❌       | Number of jobs to sample (default: 50) |

### `compare_sources`

Compare all available job sources by type. Returns a breakdown of sources grouped by category (job board, ATS, company, remote, aggregator) with counts.

_No parameters required._

## Resources

| URI                  | Description                        |
| -------------------- | ---------------------------------- |
| `everjobs://sources` | Complete list of available sources |
| `everjobs://guide`   | Search tips and usage guide        |

## Environment Variables

| Variable                        | Default                 | Description                                                                                                                                                                  |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVER_JOBS_API_URL`             | `http://localhost:3001` | Ever Jobs API endpoint                                                                                                                                                       |
| `EVER_JOBS_MCP_LOCATION_FORMAT` | `full`                  | How a job's `location` string is rendered: `full` = `city, state, country` (falling back to the site name, then its label text); `city` = the legacy city-only string        |
| `EVER_JOBS_MCP_REQUEST_KEYS`    | `camel`                 | Search request key style sent to the API: `camel` (what `ScraperInputDto` accepts), `snake` (the legacy wire shape), `both`                                                  |
| `EVER_JOBS_API_KEY`             | _(unset)_               | API key sent with every request when the API has `ENABLE_API_KEY_AUTH` on (one of its `API_KEYS`). No key header is sent when unset                                          |
| `EVER_JOBS_API_KEY_HEADER`      | `x-api-key`             | Header name used for `EVER_JOBS_API_KEY`; set it to match the API's `API_KEY_HEADER_NAME`                                                                                    |

If the API cannot be reached (connection refused), `search_jobs`, `search_remote_jobs` and
`get_salary_insights` return an error naming `EVER_JOBS_API_URL` (without any `user:password@`
part) rather than an empty result. `get_job_details` makes no API request (see above).

Remote-only jobs: whether their `location` reads `Remote` depends on the API's
`EVER_JOBS_LOCATION_REMOTE_CITY` (default `false` — a bare `Remote` label gives
`null` and `Remote - US` gives `United States`, with `is_remote` carrying the
signal; `true` restores `Remote` / `Remote, United States`). See `.env.example`.

Posting time: every job from `search_jobs`, `search_remote_jobs` and `get_job_details` carries
`date_posted` (a `YYYY-MM-DD` date). When the source gives more (Spec 1696), three keys follow it:
`date_posted_at` (ISO-8601 UTC instant; precision `exact`, `minute` or `hour` only),
`date_posted_precision` (`exact | minute | hour | day | week | month | year`) and
`date_posted_basis` (`timestamp | date | relative`, where `relative` means estimated from an age
label such as "3 hours ago" at fetch time). A job without that detail has none of the three keys.

## Source Coverage

- **21** Job Boards (LinkedIn, Indeed, Glassdoor, Dice, Monster, Upwork, Exa, BuiltIn, Snagajob, Dribbble, ...)
- **13** Remote Job Boards (RemoteOK, Remotive, We Work Remotely, Jobicy, Himalayas, Arbeitnow, 4 Day Week, ...)
- **4** Aggregator APIs (Adzuna, Reed, Jooble, CareerJet)
- **22** ATS Platforms (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Rippling, Workday, ...)
- **12** Company Career Pages (Google, Meta, Netflix, Stripe, OpenAI, Amazon, Apple, Microsoft, NVIDIA, TikTok, Uber, Cursor)

**Total: 65 sources**
