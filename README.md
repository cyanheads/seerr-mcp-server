<div align="center">
  <h1>@cyanheads/seerr-mcp-server</h1>
  <p><b>Search Jellyseerr/Overseerr, check availability, and create guarded media requests via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/seerr-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/seerr-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

- Free-text title query matched against TMDB; `mediaType` filters to `movie` / `tv` / `all` (people always excluded)
- Decoded availability (`status`, plus `status4k` when 4K is enabled) only for titles Jellyseerr already tracks
- `page` pagination (1–1000); `limit` caps returned results per call (1–20, default 10)
- Optional ISO 639-1 `language` override for localized titles/overviews
- Empty results are a normal success — returns `[]` with a guidance notice, not an error

---

### `seerr_get_media` <sub>tool</sub>

- Availability plus any existing open request for the title (avoids duplicate requests)
- TV: omit `seasonNumber` for a per-season summary, or pass one to fetch that season's episode list (season 0 is Specials)
- A TMDB ID that doesn't resolve surfaces as a typed `media_not_found` with a search-recovery hint (Jellyseerr's raw HTTP 500 is classified in the service layer)

---

### `seerr_list_requests` <sub>tool</sub>

- Lifecycle `filter` (pending, processing, available, failed, …), `mediaType`, and `requestedById` filters
- Sort by created (`added`) or last-changed (`modified`), ascending or descending
- `take` (1–100, default 20) / `skip` pagination; the enrichment trailer echoes the applied filter set
- Requester is PII-redacted to `{ id, displayName }`
- Titles aren't on request objects — `includeTitles: true` joins them from media records (one lookup per distinct title, default off); unresolved rows keep every other field and are disclosed in the notice

---

### `seerr_request_media` <sub>tool</sub>

- **Guarded write.** `mode: preview` (default) resolves the title and returns the exact `POST /request` payload that would be submitted, with no write; `mode: request` submits only after an explicit confirmation round comes back accepted — declining, cancelling, or an invalid answer cancels before submission (`request_cancelled`), and `destructiveHint: true` flags the risk to client approval flows
- Runs `stateful` by design — a 2025-era client answers the confirmation over a live session, which `stateless` can't hold open. The server declares that posture itself, so an HTTP deployment that sets `MCP_SESSION_MODE=stateless` fails at startup rather than serving an unusable tool
- Capability validation (4K enabled? seasons valid? partial requests allowed?) runs locally against cached instance settings before any POST, so a bad request fails with a typed error instead of a failed write
- TV requests take `seasons: "all"` or an explicit list (e.g. `[1, 2]`); season 0 (Specials) is rejected unless the instance enables it
- Optional routing overrides — `serverId`, `profileId`, `rootFolder`, `languageProfileId` — omit to use Jellyseerr's defaults (recommended)
- An existing request for the title surfaces in the output; a duplicate rejection from Jellyseerr maps to a typed `duplicate_request` pointing back at it

---

### `seerr_request_status` <sub>tool</sub>

- Wraps `GET /request/{id}`; `requestId` comes from `seerr_request_media`'s `created.requestId` or `seerr_list_requests`
- Returns decoded `requestStatus` and `mediaStatus`/`mediaStatus4k`, requester (`{ id, displayName }`), and a routing summary (`serverId`, `profileName`, `is4k` — no filesystem paths)
- `title` is joined from the media detail endpoint on every call (no opt-in flag needed) and omitted when the request has no `tmdbId` or the lookup fails
- `stateGuidance` returns a next-step hint tuned to the current status
- A missing request ID surfaces as a typed `request_not_found` (Jellyseerr's raw HTTP 404 is classified in the service layer)

---

### `seerr_service_options` <sub>tool</sub>

- Instance capability summary: Jellyseerr version, media server, and the `movie4kEnabled` / `series4kEnabled` / `partialRequestsEnabled` / `specialEpisodesEnabled` flags
- Per-service routing: server ID, default-server flag, 4K capability, and the active + available quality profiles (IDs and names, safe to surface)
- Filesystem root-folder paths and free space are operator-private — omitted unless `includePaths: true`
- One failed service leg (Radarr/Sonarr detail, settings, or version) degrades to a disclosed notice instead of failing the whole call

---

### `seerr://request/{requestId}` <sub>resource</sub>

- Mirrors `seerr_request_status` — same `projectRequestDetail` redaction choke point and title join, so the output is identical and equally PII-clean
- `requestId` comes from `seerr_request_media` or `seerr_list_requests`
- No per-read options — title is always joined (one request, one extra read); absent when there's no `tmdbId` or the lookup fails
- A missing request ID surfaces as a typed `request_not_found`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

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
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/seerr-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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
