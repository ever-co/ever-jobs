# Architecture Overview

## Data Flow

```
Client Request
    │
    ▼
┌──────────────────────┐
│   NestJS Application │
│                      │
│  ┌────────────────┐  │
│  │  API Key Guard │  │   ← validates x-api-key header
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Throttler Guard│  │   ← rate limit per key/IP
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Logging        │  │   ← request ID, timing
│  │ Interceptor    │  │
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Cache Service  │──┼── ← Redis or in-memory TTL cache
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Jobs Service   │  │   ← orchestrate searching
│  │  (allSettled)  │  │
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Source Modules │  │   ← LinkedIn, Indeed, Glassdoor, etc.
│  │ (160 sources)  │  │   ← search (107) + ATS (38) + company (15) + analytics
│  └────────────────┘  │
└──────────────────────┘
           │
           ▼
    External Job APIs
```

## Key Components

| Component             | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `AppConfigModule`     | Loads `.env` and provides typed config         |
| `ApiKeyGuard`         | Header-based API key auth (REST and GraphQL)   |
| `GqlThrottlerGuard`   | Configurable rate limiting (REST and GraphQL); per valid API key, else per client IP (`TRUST_PROXY`) |
| `LoggingInterceptor`  | Request logging with IDs and timing            |
| `HttpExceptionFilter` | Structured JSON error responses                |
| `CacheService`        | TTL cache backed by Redis or in-memory         |
| `HealthController`    | `/health` and `/ping` endpoints                |
| `JobsService`         | Orchestrates concurrent multi-source searching |
| `JobsController`      | `POST /api/jobs/search` and `/analyze`         |
| `JobsResolver`        | GraphQL API at `/graphql` (Apollo)             |
| Source Modules (×160) | Search (×107) + ATS (×38) + Company (×15)      |
| `AnalyticsModule`     | Job data analysis and aggregation              |

## Project Structure

```
ever-jobs/
├── apps/
│   ├── api/src/             # NestJS API server
│   │   ├── auth/            #   API key guard
│   │   ├── cache/           #   In-memory cache
│   │   ├── config/          #   Configuration module
│   │   ├── filters/         #   Exception filters
│   │   ├── health/          #   Health endpoints
│   │   ├── interceptors/    #   Logging interceptor
│   │   └── jobs/            #   Job controllers & service
│   └── cli/                 # CLI application (nest-commander)
├── packages/
│   ├── analytics/           # Job data analytics
│   ├── common/              # Shared HTTP client, utilities
│   ├── models/              # TypeScript interfaces & DTOs
│   ├── source-*/            # Search source modules (×105)
│   ├── source-ats-*/        # ATS source modules (×38)
│   └── source-company-*/    # Company-specific source modules (×15)
├── Dockerfile               # Multi-stage Docker build
├── docker-compose.yml       # Production deployment
├── docker-compose.dev.yml   # Development with hot-reload
└── Makefile                 # Dev & Docker shortcuts
```
