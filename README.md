<div align="center">
  <h1>@cyanheads/seerr-mcp-server</h1>
  <p><b>Search Jellyseerr/Overseerr, check availability, and create guarded media requests via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/seerr-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/seerr-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/seerr-mcp-server/releases/latest/download/seerr-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=seerr-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc2VlcnItbWNwLXNlcnZlciJdLCJlbnYiOnsiU0VFUlJfQkFTRV9VUkwiOiJodHRwOi8vbG9jYWxob3N0OjUwNTUiLCJTRUVSUl9BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22seerr-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fseerr-mcp-server%22%5D%2C%22env%22%3A%7B%22SEERR_BASE_URL%22%3A%22http%3A%2F%2Flocalhost%3A5055%22%2C%22SEERR_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Jellyseerr and Overseerr media-request workflow: search TMDB-backed titles, confirm the exact match, check availability and request state, and create a guarded request that Radarr/Sonarr act on. Jellyseerr owns permissions, quotas, routing, and status — this server never calls Radarr/Sonarr directly. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `seerr_search_media` | Search movies and TV by title; returns ranked matches with TMDB ID, year, overview, and decoded availability when Jellyseerr already tracks the title. The required first step before requesting. |
| `seerr_get_media` | Fetch exact movie/show details by TMDB ID + media type to confirm the title before a write; for TV, a per-season summary or one season's episode list. |
| `seerr_list_requests` | List recent requests with status/type/requester filters; echoes the applied filters and decodes every numeric status. Titles are opt-in via `includeTitles`. |
| `seerr_request_media` | **Guarded write.** Previews the request payload by default (`mode: preview`); creates the request only on `mode: request`, and only after an accepted confirmation. |
| `seerr_request_status` | Fetch one request by ID — title, decoded request + media availability (incl. 4K), requester, routing summary, and a state-tuned next-step hint. |
| `seerr_service_options` | Summarize configured Radarr/Sonarr services, default quality profiles, and instance capability flags (4K, partial requests, specials, media server). Filesystem paths redacted unless `includePaths`. |

### Resources

| Resource | Description |
|:---|:---|
| `seerr://request/{requestId}` | Read-once summary of one request — decoded status, media availability, requester, and routing. Mirrors `seerr_request_status`. |

All request data is also reachable via tools — request enumeration is the job of `seerr_list_requests` (the tool-only access path).

## Capability reference

### `seerr_search_media` <sub>tool</sub>

- Search titles with `mediaType: movie | tv | all`; people are excluded. `page` is 1–1000; `limit` is 1–20, default 10.
- Returns TMDB matches and decoded `status` / `status4k` for tracked titles. Empty results return `[]` with a guidance notice.
- Optional ISO 639-1 `language` selects localized titles and overviews.

---

### `seerr_get_media` <sub>tool</sub>

- Availability plus any existing open request for the title (avoids duplicate requests)
- TV: omit `seasonNumber` for a per-season summary, or pass one to fetch that season's episode list (season 0 is Specials)
- A TMDB ID that doesn't resolve surfaces as a typed `media_not_found` with a search-recovery hint (Jellyseerr's raw HTTP 500 is classified in the service layer)

---

### `seerr_list_requests` <sub>tool</sub>

- Filter by lifecycle `filter`, `mediaType`, and `requestedById`; sort by `added` or `modified`, ascending or descending. `take` is 1–100, default 20; `skip` selects the offset.
- Returns decoded statuses, requester `{ id, displayName }`, and an enrichment trailer with applied filters.
- `includeTitles: true` joins media titles once per distinct title (default off); unresolved rows retain their data and are disclosed in the notice.

---

### `seerr_request_media` <sub>tool</sub>

- **Guarded write.** `mode: preview` (default) returns the resolved title and exact `POST /request` payload without writing. `mode: request` asks for confirmation bound to the same caller, title and payload; declined, cancelled or invalid answers return `request_cancelled`.
- TV requests require `seasons: "all"` or a list such as `[1, 2]`; season 0 (Specials) requires special episodes to be enabled. Instance capability checks run before any POST; existing requests appear in output and duplicate rejections return `duplicate_request`.
- Optional routing overrides: `serverId`, `profileId`, `rootFolder`, `languageProfileId`. Omit them to use Jellyseerr's defaults.

---

### `seerr_request_status` <sub>tool</sub>

- Accepts `requestId` from `seerr_request_media`'s `created.requestId` or `seerr_list_requests`. A missing request returns `request_not_found`.
- Returns decoded `requestStatus`, `mediaStatus` / `mediaStatus4k`, requester `{ id, displayName }`, routing (`serverId`, `profileName`, `is4k`), and `stateGuidance`.
- Joins `title` on each call; it is absent when no `tmdbId` exists or the lookup fails.

---

### `seerr_service_options` <sub>tool</sub>

- Returns instance version, media server, capability flags (`movie4kEnabled`, `series4kEnabled`, `partialRequestsEnabled`, `specialEpisodesEnabled`), and service IDs, defaults and quality profiles.
- Failed service legs retain the available results with a notice.
- `includePaths: true` exposes root-folder paths and free space; both are omitted by default.

---

### `seerr://request/{requestId}` <sub>resource</sub>

- Accepts `requestId` from `seerr_request_media` or `seerr_list_requests`; a missing request returns `request_not_found`.
- Mirrors `seerr_request_status`, including redaction and a title join. `title` is absent when no `tmdbId` exists or the lookup fails; resources take no per-read options.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

HTTP requires stateful sessions for 2025-era confirmation rounds; explicit `MCP_SESSION_MODE=stateless` fails startup. Consent records expire after ten minutes and changed or replayed records ask again. Redemption excludes concurrent retries in one process; request creation makes one POST attempt without automatic retries. Cross-instance read-and-delete is not atomic: use shared strongly consistent filesystem, Supabase or Cloudflare D1 storage for routed retries, and account for duplicate-submission races; Cloudflare KV is unsuitable for consent records.

Seerr-specific:

- Read + guarded-request only — admin-scope endpoints (approve/decline, retry, edit/delete, media/file deletion, user/settings/sync) are excluded by design, not by API limitation
- PII/infra redaction centralized in one normalizer choke point — requesters project to `{ id, displayName }`; operator email, Plex/Jellyfin tokens, and `serviceUrl` never reach output; filesystem paths are opt-in via `includePaths`
- Status decoding centralized in one helper — request and media statuses (including the separate 4K availability) decode to `{ raw, label }` everywhere, forward-compatible with new Jellyseerr status codes
- Capability validation against cached instance settings catches most bad requests before they reach the API
- A short-TTL settings cache avoids a round-trip on every preview

Agent-friendly output:

- **Provenance and disclosure** — searches echo the effective query; capped lists disclose truncation; a degraded service leg surfaces a notice instead of silently dropping data
- **Typed, actionable errors** — `media_not_found`, `request_not_found`, `seasons_required`, `four_k_not_enabled`, `duplicate_request`, and more carry a recovery hint so callers can branch and retry without parsing prose

## Getting started

Add the following to your MCP client configuration file, pointing `SEERR_BASE_URL` at your own Jellyseerr or Overseerr instance and supplying its API key.

```json
{
  "mcpServers": {
    "seerr-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/seerr-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "SEERR_BASE_URL": "http://localhost:5055",
        "SEERR_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "seerr-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/seerr-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "SEERR_BASE_URL": "http://localhost:5055",
        "SEERR_API_KEY": "your-api-key"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 SEERR_BASE_URL=http://localhost:5055 SEERR_API_KEY=your-api-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A running Jellyseerr or Overseerr instance, and its API key (Settings → General → API Key).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/seerr-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd seerr-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env — set SEERR_BASE_URL and SEERR_API_KEY
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `SEERR_BASE_URL` | **Required.** Base URL of the Jellyseerr/Overseerr instance, e.g. `http://localhost:5055`. The service appends `/api/v1` — no `/api/v1` suffix, no trailing slash. | — |
| `SEERR_API_KEY` | **Required.** Jellyseerr API key (Settings → General → API Key). Sent as the `X-Api-Key` header. | — |
| `SEERR_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout in milliseconds. | `15000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `MCP_SESSION_MODE` | HTTP session mode; must resolve to stateful for confirmation rounds. The example and Docker image set stateful; an unset value uses auto, resolving to stateful. Explicit stateless fails startup. | `auto` |
| `MCP_REQUEST_STATE_KEY` | Optional key of at least 32 bytes, shared across instances, that seals consent record IDs. | — |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base for traces and metrics; signal-specific endpoints override it. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in log export endpoint; the base endpoint never enables logs. | — |
| `LOG_TOOL_FAILURE_PAYLOADS` | Opt-in failed-call arguments/result logging; redaction matches key names, so secrets in free-form values can remain. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t seerr-mcp-server .
docker run --rm \
  -e SEERR_BASE_URL=http://host.docker.internal:5055 \
  -e SEERR_API_KEY=your-api-key \
  -p 3010:3010 \
  seerr-mcp-server
```

The Dockerfile defaults to HTTP transport, stateful session mode, and logs to `/var/log/seerr-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers the six tools + one resource and inits the Seerr service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/seerr` | Jellyseerr API client, status decoders, and the PII/infra redaction normalizers. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap the Jellyseerr API: validate raw → normalize and redact to a domain type → return the output schema; never fabricate missing fields, and never let operator PII or paths reach output

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
