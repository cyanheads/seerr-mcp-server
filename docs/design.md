# seerr-mcp-server — Design

Workflow MCP server over a self-hosted **Seerr** instance (the maintained successor to Overseerr/Jellyseerr that fronts Jellyfin/Plex/Emby + Radarr + Sonarr). The unit of work is not "download a movie" — it is *search Seerr → resolve the exact TMDB-backed title → check current availability/request state → create a guarded Seerr request that Radarr/Sonarr act on*. Seerr owns permissions, quotas, routing, and status; this server never touches Radarr/Sonarr directly.

Local-only (`hostable: false`), stdio default. Auth to Seerr is a single `X-Api-Key` header.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `seerr_search_media` | Search movies and TV shows by title; returns ranked matches with TMDB ID, year, overview, and decoded availability/request status when Seerr already tracks the title. Required first step before requesting. | `query` (req), `mediaType` (movie\|tv\|all), `page`, `language`, `limit` | `readOnlyHint`, `openWorldHint` |
| `seerr_get_media` | Fetch exact movie or show details by TMDB ID + media type to confirm the right title before any write. For TV, optionally include season summaries or one season's episode list. | `mediaType` (movie\|tv, req), `tmdbId` (req), `seasonNumber?` | `readOnlyHint`, `openWorldHint` |
| `seerr_list_requests` | List recent media requests with status/type/requester filters; echoes filters and decodes numeric statuses. Titles are opt-in (`includeTitles`) because their cost scales with the page. | `filter?`, `mediaType?`, `requestedById?`, `sort?`, `sortDirection?`, `take`, `skip`, `includeTitles` (default false) | `readOnlyHint`, `openWorldHint` |
| `seerr_request_media` | **Guarded write.** Resolves the exact title, previews the request payload (default `mode: preview`, no write), and creates the Seerr request only on `mode: request`. Treats "download X" as "create a Seerr request." | `mediaType` (req), `tmdbId` (req), `mode` (preview\|request, default preview), `is4k?`, `seasons?`, route overrides (`serverId?`, `profileId?`, `rootFolder?`, `languageProfileId?`) | `destructiveHint`, `openWorldHint`, `idempotentHint:false` |
| `seerr_request_status` | Fetch one request by ID; returns the joined title, decoded request status, decoded media availability (incl. 4K), requester, routing summary, and a recovery hint for pending/failed/processing states. | `requestId` (req) | `readOnlyHint`, `openWorldHint` |
| `seerr_service_options` | Summarize configured Radarr/Sonarr services + default quality profiles, plus compact Seerr version and public feature flags (4K, partial requests, specials) so an agent can reason about request capability. Redacts filesystem paths unless `includePaths: true`. | `service?` (radarr\|sonarr\|all), `includePaths` (default false) | `readOnlyHint`, `openWorldHint` |

Six tools. The surface is self-sufficient for a tool-only client: discover (`search`) → confirm (`get`) → understand routing (`service_options`) → request (`request_media`) → track (`request_status` / `list_requests`).

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `seerr://request/{requestId}` | Read-once request summary — joined title, decoded status + media availability + routing. Mirrors `seerr_request_status` for clients that support injectable context. | None (single record) |

One resource, fully covered by the tool surface. No `list()` — request enumeration is the job of `seerr_list_requests` (filterable, the tool-only access path).

### Prompts

None. This is an action/data server — no recurring multi-step interaction pattern earns a prompt template. (The guarded-write workflow lives in the tool, not a prompt.)

---

## Overview

Seerr exposes OpenAPI 3.0.2 at `/api/v1` (base path). The local instance probed for this design reports **Seerr 3.3.0**, `mediaServerType: 2` (Jellyfin), with `movie4kEnabled`, `series4kEnabled`, and `partialRequestsEnabled` all `true`, `enableSpecialEpisodes: false`. One Radarr (id 0) and one Sonarr (id 0) are configured, both `isDefault` and `is4k`-capable.

**Audience:** local media-stack operators who want an agent to add movies/shows to their Seerr request flow *without* handing the agent direct Radarr/Sonarr control. The agent searches, disambiguates, previews, and (on explicit confirmation) requests; Seerr enforces everything else.

**Why not just `tmdb-mcp-server`:** TMDB answers catalog/recommendation questions. This server performs *operational request workflows* against a running media stack — availability state, request lifecycle, service routing. `composes-with: tmdb-mcp-server` (TMDB for discovery breadth, Seerr for the request action).

---

## Requirements

- **Auth:** single `X-Api-Key` header, value from `SEERR_API_KEY`. No cookie/credential auth — `/auth/*` is probe-only and never wired into the server.
- **Base URL:** `SEERR_BASE_URL` (e.g. `http://localhost:5055`); the service appends `/api/v1`.
- **Read + guarded-request only.** First release deliberately excludes everything `X-Api-Key`'s admin reach makes *possible*: user/admin management, settings updates, sync jobs, media/file deletion, issue management, watchlist/blocklist writes, and request approval/decline. See **Admin-scope exclusions**.
- **Two-step guarded write.** `seerr_request_media` defaults to `mode: preview` (resolve + preview, no POST). The actual `POST /request` fires only on `mode: request`, gated by a `ctx.requestInput` confirmation round that must come back accepted, with `destructiveHint` surfacing the risk in client-side approval flows.
- **Status decoding everywhere.** Every output that carries a request or media status emits both the decoded label and the raw number. Request status: `1=pending`, `2=approved`, `3=declined`. Media status: `1=unknown`, `2=pending`, `3=processing`, `4=partially_available`, `5=available`, `6=deleted`. Media carries a **second** `status4k` field on the same scale — decode it too.
- **Error normalization.** Seerr returns **HTTP 500 `{"message":"Unable to retrieve movie."}`** for a missing movie (confirmed live). Map to a domain `media_not_found` with a search-recovery hint — never surface a raw 500.
- **PII / infra redaction.** Raw Seerr objects leak operator data (see **PII & path redaction**). Project `User` → `{ id, displayName }`, drop tokens/email/avatars; strip `serviceUrl`/`serviceUrl4k` (internal host:port); redact Radarr/Sonarr `activeDirectory` and root-folder `path` unless explicitly requested.
- **Capped lists disclose truncation** via the `enrichment` block (optional `truncated`/`shown`/`cap`; required `totalCount` via the total enricher) — see **Output & enrichment conventions**.

---

## Status Decoding (canonical)

Verified against the OpenAPI spec (`MediaRequest.status`, `MediaInfo.status` descriptions) and live `/request` + `/movie/{id}` payloads.

**Request status** (`MediaRequest.status`, Seerr `MediaRequestStatus` enum):

| Raw | Label |
|:--|:--|
| 1 | `pending` (pending approval) |
| 2 | `approved` |
| 3 | `declined` |
| 4 | `failed` |
| 5 | `completed` |

> Live-confirmed: a working instance returns 4 (failed) and 5 (completed) on real requests — over half the requests on the probed instance were status 5. Decoding only 1-3 mislabels every completed/failed request as `unrecognized`.

**Media status** (`MediaInfo.status` and `MediaInfo.status4k`, Seerr `MediaStatus` enum):

| Raw | Label |
|:--|:--|
| 1 | `unknown` |
| 2 | `pending` |
| 3 | `processing` |
| 4 | `partially_available` |
| 5 | `available` |
| 6 | `blocklisted` |
| 7 | `deleted` |

> `BLOCKLISTED` was inserted at 6, shifting `DELETED` to 7 — mapping 6 to `deleted` mislabels a blocklisted item and leaves a deleted item `unrecognized`.

Decoding is a pure `src/services/seerr/status.ts` helper: `decodeRequestStatus(n)` / `decodeMediaStatus(n)` → `{ raw: number, label: string }`. Unknown numbers map to `{ raw: n, label: 'unrecognized' }` rather than throwing — Seerr could add a status code; the agent should still see the raw value. Every tool output that includes a status uses an object `{ raw, label }`, never a bare number or bare string.

`mediaServerType` (settings): `1=Plex`, `2=Jellyfin`, `3=Emby` — decoded in `seerr_service_options` to a `mediaServer` label.

---

## PII & path redaction

The raw API exposes operator-private data that must not reach tool output. Confirmed from the live instance and the `User` schema:

| Raw field (where) | Risk | Handling |
|:--|:--|:--|
| `requestedBy` / `modifiedBy` (full `User`) | `email`, `plexToken`, `jellyfinAuthToken`, `jellyfinUserId`, `plexId`, `avatar`, `permissions` bitfield, `settings`, quotas, `recoveryLinkExpirationDate`, `warnings` | Project to `{ id, displayName }` only. `displayName` = first present of `username` → `jellyfinUsername` → `plexUsername` → `User #<id>`. Never emit tokens/email/IDs. Applies to **both** `requestedBy` and `modifiedBy` — both are full `User` objects with equal PII. |
| `media.serviceUrl` / `serviceUrl4k` | Internal `http://<host>:<port>/...` (private LAN/VPN IP + Radarr/Sonarr port) — **confirmed live** | Drop from output. The agent doesn't route by URL; Seerr does. |
| `RadarrSettings.activeDirectory`, `SonarrSettings.activeDirectory`, `SonarrSettings.activeAnimeDirectory`, `rootFolders[].path` | Filesystem paths (`/media/Movies`); Sonarr also exposes `activeAnimeDirectory` | Redact by default in `seerr_service_options`. Surface only when `includePaths: true`. Profile/folder **IDs and names** are always safe. |
| `RadarrSettings.apiKey`, `hostname`, `port` | Downstream service credentials/network | Never request the fields; the list/detail endpoints used (`/service/radarr`, `/service/sonarr`) already omit `apiKey`. |
| `rootFolders[].freeSpace` | Low-risk but irrelevant | Optionally summarize (human bytes) under `includePaths`; omit otherwise. Note: live field name is `freeSpace` (not `freeSpaceBytes` — design corrected). |
| `settings/public` fields: `vapidPublic`, `plexClientIdentifier` | Push notification public key and Plex client UUID — low external risk but operator-internal | Do not surface in `seerr_service_options` output; only emit the fields the agent needs for capability reasoning (`movie4kEnabled`, `series4kEnabled`, `partialRequestsEnabled`, `enableSpecialEpisodes`, `mediaServerType`, `applicationTitle`). |

Redaction lives in the service layer's normalizers, not in `format()` — so both `structuredContent` and `content[]` are clean.

---

## Admin-scope exclusions (first release)

`X-Api-Key` likely carries `ADMIN`. The surface is scoped *away* from that reach by design, not by API limitation. Excluded endpoints and why:

| Excluded | Endpoint(s) | Reason |
|:--|:--|:--|
| Request approve/decline | `POST /request/{id}/{status}` | Approval workflow is an operator/manage action; no concrete demand. Defer. |
| Request retry | `POST /request/{id}/retry` | Manage-only; the agent surfaces "failed → retry in Seerr UI" via recovery hint instead. |
| Request edit/delete | `PUT`/`DELETE /request/{id}` | Mutates/removes existing requests; out of scope for a request-creation workflow. |
| Media delete / file delete | `DELETE /media/{id}`, `DELETE /media/{id}/file` | **Catastrophic + irreversible** — file deletion is unrecoverable and stays in the Seerr UI. Excluded from the tool surface entirely (not merely `destructiveHint`). |
| User / settings / sync | `/user/*`, `/settings/*` (writes), sync jobs | Admin management. Out of scope. |
| Issues, watchlist, blocklist | `/issue/*`, `/watchlist/*`, `/blocklist/*` | Separate workflows, no demand. |

The only write in the surface is `POST /request` — and it is double-guarded (preview default + confirmation round). `/settings/public` and `/status` are read for capability context only (folded into `seerr_service_options`, no standalone tool).

---

## Tool Specifications

Conventions for all tools: framework re-exports `z` (`import { tool, z } from '@cyanheads/mcp-ts-core'`). Handlers are pure and throw — the framework catches/classifies. Every Zod field has `.describe()`. Statuses are `{ raw, label }` objects. `format()` renders every output field (lint-enforced `format-parity`).

---

### 1. `seerr_search_media`

**Purpose:** Title disambiguation entry point. Wraps `GET /search`, filters to movie/TV (drops `person` results), normalizes each hit, and decodes `mediaInfo` status when Seerr already tracks the title. The required first step before any request.

**Endpoint:** `GET /search?query={query}&page={page}&language={language}`

**Input:**
```ts
z.object({
  query: z.string().min(1)
    .describe('Title to search for, e.g. "Mulan" or "Severance". Natural-language titles are fine; Seerr matches against TMDB.'),
  mediaType: z.enum(['movie', 'tv', 'all']).default('all')
    .describe('Restrict results to movies, TV shows, or both. People are always excluded — this server requests media, not actors.'),
  page: z.number().int().min(1).max(1000).default(1)
    .describe('1-based result page. Seerr returns ~20 results per page; use with totalPages from a prior call to page through.'),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional()
    .describe('ISO 639-1 language for titles/overviews, e.g. "en" or "pt-BR". Defaults to the Seerr instance locale when omitted.'),
  limit: z.number().int().min(1).max(20).default(10)
    .describe('Max normalized results to return from this page (caps output size; does not change which page is fetched).'),
})
```

**Output:**
```ts
z.object({
  results: z.array(z.object({
    tmdbId: z.number().describe('TMDB ID — pass to seerr_get_media or seerr_request_media as tmdbId.'),
    mediaType: z.enum(['movie', 'tv']).describe('Whether this is a movie or TV show.'),
    title: z.string().describe('Display title (movie title or show name).'),
    year: z.number().optional().describe('Release year (movies) or first-air year (TV); omitted when the date is unknown.'),
    overview: z.string().optional().describe('Short synopsis; omitted when TMDB has none.'),
    voteAverage: z.number().optional().describe('TMDB vote average (0–10) for relevance/quality signal.'),
    tracked: z.boolean().describe('True when Seerr already tracks this title (mediaInfo present) — availability/request data follows.'),
    availability: z.object({
      status: StatusRef.describe('Decoded media availability {raw,label}.'),
      status4k: StatusRef.optional().describe('Decoded 4K availability {raw,label} when the instance has 4K enabled.'),
    }).optional().describe('Current Seerr availability; present only when tracked is true.'),
  })).describe('Ranked movie/TV matches. Empty array when nothing matched.'),
})
```
`StatusRef` = `z.object({ raw: z.number(), label: z.string() })`, shared in `status.ts`.

**Enrichment:** `totalCount` (via `ctx.enrich.total(response.totalResults)` — note the search envelope uses `totalResults`, not `pageInfo.results`), `effectiveQuery` (echo the parsed query), `truncated`/`shown`/`cap` (optional — fired only when the page yields more than `limit`), `notice` (optional, set on empty results: `No movie/TV match for "<query>". Try a different spelling or broaden mediaType to "all".`).

**Errors:** No domain contract needed — empty results are a normal success (`results: []` + notice), upstream 5xx bubbles as `ServiceUnavailable`. `query` min-length handled by Zod (`ValidationError`).

**Annotations:** `{ readOnlyHint: true, openWorldHint: true }`.

**Field-shape note (live):** Search response envelope is `{ page, totalPages, totalResults, results[] }` — the enrichment `totalCount` must use `totalResults` (not `pageInfo.results`, which is the request-list pattern). Search hits are `MovieResult`/`TvResult`; `mediaInfo` is **absent** when the title is not tracked (Mulan 1998 returned no `mediaInfo` key). Hence `tracked` boolean + `availability?` optional. Movies use `title`/`releaseDate`; TV uses `name`/`firstAirDate` — normalize both to `title`/`year`. When `mediaInfo` IS present, it does **not** include `requests[]` in the search result — only the movie/tv detail endpoints (`GET /movie/{id}`, `GET /tv/{id}`) include `mediaInfo.requests[]`. The search result's `mediaInfo` carries `status`/`status4k` only — no open-request data.

---

### 2. `seerr_get_media`

**Purpose:** Confirm the exact title before a write. Wraps `GET /movie/{id}` or `GET /tv/{id}`, optionally `GET /tv/{id}/season/{n}` for episodes. Returns enough to verify the agent picked the right title and to see current availability + whether a request already exists.

**Endpoints:** `GET /movie/{tmdbId}` · `GET /tv/{tvId}` · `GET /tv/{tvId}/season/{seasonNumber}` (only when `seasonNumber` provided and `mediaType=tv`).

**Input:**
```ts
z.object({
  mediaType: z.enum(['movie', 'tv'])
    .describe('Whether tmdbId refers to a movie or TV show. Determines which detail endpoint is queried.'),
  tmdbId: z.number().int().positive()
    .describe('TMDB ID from seerr_search_media (the results[].tmdbId field).'),
  seasonNumber: z.number().int().min(0).optional()
    .describe('TV only: fetch this season\'s episode list. Season 0 is Specials. Omit for a show-level summary with per-season counts.'),
})
```

**Output (discriminated by mediaType; one object with optional arms):**
```ts
z.object({
  tmdbId: z.number().describe('TMDB ID for chaining to seerr_request_media.'),
  mediaType: z.enum(['movie', 'tv']).describe('Movie or TV.'),
  title: z.string().describe('Title (movie) or name (TV).'),
  year: z.number().optional().describe('Release/first-air year; omitted when unknown.'),
  overview: z.string().optional().describe('Synopsis.'),
  runtimeMinutes: z.number().optional().describe('Movie runtime in minutes (movies only).'),
  productionStatus: z.string().optional().describe('TMDB production status, e.g. "Released", "Returning Series".'),
  availability: z.object({
    tracked: z.boolean().describe('True when Seerr tracks this title.'),
    status: StatusRef.describe('Decoded availability {raw,label}.'),
    status4k: StatusRef.optional().describe('Decoded 4K availability when 4K is enabled.'),
    openRequest: z.object({
      requestId: z.number().describe('Existing request ID — pass to seerr_request_status.'),
      status: StatusRef.describe('Decoded request status {raw,label}.'),
      is4k: z.boolean().describe('Whether the open request is for 4K.'),
    }).optional().describe('Most recent existing request for this title, if any — avoids duplicate requests.'),
  }).describe('Seerr availability + existing-request context for this title.'),
  seasons: z.array(z.object({
    seasonNumber: z.number().describe('Season number; 0 = Specials.'),
    name: z.string().describe('Season name.'),
    episodeCount: z.number().describe('Episode count in this season.'),
    airDate: z.string().nullable().describe('Season air date (ISO) or null when unannounced.'),
  })).optional().describe('TV only: per-season summary (omitted for movies).'),
  episodes: z.array(z.object({
    episodeNumber: z.number().describe('Episode number within the season.'),
    name: z.string().describe('Episode title.'),
    airDate: z.string().nullable().describe('Air date (ISO) or null.'),
    overview: z.string().optional().describe('Episode synopsis.'),
  })).optional().describe('TV only: episode list, present only when seasonNumber was provided.'),
})
```

**Errors (typed contract):**
```ts
errors: [
  { reason: 'media_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'The TMDB ID does not resolve to a movie/show (Seerr returns HTTP 500 "Unable to retrieve movie.")',
    recovery: 'Call seerr_search_media to find the correct tmdbId, then retry with the exact ID and matching mediaType.' },
]
```
The service maps upstream **HTTP 500 with body `Unable to retrieve movie.`** → `ctx.fail('media_not_found', …)`. Other 5xx bubble as `ServiceUnavailable`.

**Annotations:** `{ readOnlyHint: true, openWorldHint: true }`.

**Field-shape notes (live):** Movie detail includes `mediaInfo` (with `status`, `status4k`, `requests[]`); `numberOfSeasons` on TV detail is **plural** in the live API (the spec's `numberOfSeason` is wrong — verified against `/tv/1399`). `seasons[]` includes season 0 (Specials). Movies have no `seasons`. `openRequest` is derived from `mediaInfo.requests` (take the most recent), with the `User` projected and status decoded.

---

### 3. `seerr_list_requests`

**Purpose:** Review recent requests and their lifecycle. Wraps `GET /request`. Echoes the filters the server applied and decodes every numeric status.

**Endpoint:** `GET /request?take={take}&skip={skip}&filter={filter}&sort={sort}&sortDirection={sortDirection}&requestedBy={id}&mediaType={mediaType}`

**Input:**
```ts
z.object({
  filter: z.enum(['all','approved','available','pending','processing','unavailable','failed','deleted','completed'])
    .default('all')
    .describe('Lifecycle filter. "pending" = awaiting approval; "processing" = downloading; "available" = ready to watch; "failed" = needs retry in Seerr.'),
  mediaType: z.enum(['movie','tv','all']).default('all')
    .describe('Restrict to movies, TV, or both.'),
  requestedById: z.number().int().positive().optional()
    .describe('Seerr numeric user ID to show only one requester\'s requests. Omit for all (requires manage permission on the API key, which the default key has).'),
  sort: z.enum(['added','modified']).default('added')
    .describe('Sort key: when the request was created ("added") or last changed ("modified").'),
  sortDirection: z.enum(['asc','desc']).default('desc')
    .describe('Sort direction. Default desc shows the most recent first.'),
  take: z.number().int().min(1).max(100).default(20)
    .describe('Page size — max requests to return in one call.'),
  skip: z.number().int().min(0).default(0)
    .describe('Number of requests to skip for pagination (offset). Use take+skip to page.'),
  includeTitles: z.boolean().default(false)
    .describe('Resolve each row\'s title. Default false keeps the call to a single upstream read; true adds one media lookup per distinct title on the page (rows sharing a title, such as a 4K and a non-4K request, resolve once). Rows that cannot be resolved keep every other field and stay "Untitled".'),
})
```

**Output:**
```ts
z.object({
  requests: z.array(z.object({
    requestId: z.number().describe('Request ID — pass to seerr_request_status.'),
    mediaType: z.enum(['movie','tv']).describe('Movie or TV (derived from request.type field on the raw object).'),
    title: z.string().optional().describe('Title of the requested media. Present only when includeTitles was set and the lookup succeeded — request objects carry no title field.'),
    tmdbId: z.number().optional().describe('TMDB ID of the requested media (from request.media.tmdbId).'),
    requestStatus: StatusRef.describe('Decoded request status {raw,label}.'),
    mediaStatus: StatusRef.optional().describe('Decoded availability of the non-4K copy {raw,label} (from media.status).'),
    mediaStatus4k: StatusRef.optional().describe('Decoded availability of the 4K copy {raw,label} (from media.status4k). The 4K copy downloads through a separate Radarr/Sonarr service, so this is the field that tracks an is4k request.'),
    is4k: z.boolean().describe('Whether this is a 4K request.'),
    seasons: z.array(z.number()).optional().describe('Requested season numbers (TV); empty array or omitted for movies or full-series requests.'),
    requestedBy: z.object({
      id: z.number().describe('Requester user ID.'),
      displayName: z.string().describe('Requester display name (no email/tokens).'),
    }).describe('Who requested it — projected to id + display name only (email/tokens/jellyfinUserId stripped).'),
    createdAt: z.string().describe('ISO timestamp the request was created.'),
  })).describe('Matching requests, most-recent first by default.'),
})
```

**Enrichment:** `totalCount` (from `pageInfo.results` via `ctx.enrich.total` — live confirmed: `{ page, pages, pageSize, results }` where `results` is the total count), `truncated`/`shown`/`cap` (optional — fired when `results.length >= take` and the total exceeds what was returned), `echo` of the applied filter set (`filter=…, mediaType=…, sort=…`), `notice` on empty and on partial title hydration. `ctx.enrich.truncated` writes the same `notice` field (last-wins), so the handler composes the pagination hint and any hydration disclosure into one string rather than issuing two calls.

**Errors:** None declared — empty is normal; upstream 5xx bubbles.

**Annotations:** `{ readOnlyHint: true, openWorldHint: true }`.

**Field-shape note (live):** real `MediaRequest` carries `type`, `seasonCount`, `profileName`, `isAutoRequest`, `canRemove` (absent in some calls), `tags`, `serverId`, `profileId`, `rootFolder`, `languageProfileId`, and a nested `media` with `status`/`status4k`. The output projects the agent-relevant subset. **`title` is NOT a field on the request object** — neither at list nor single-request endpoints. It is resolved by calling `GET /movie/{tmdbId}` or `GET /tv/{tmdbId}` using `media.tmdbId`, which this tool does inline when `includeTitles` is set (`src/services/seerr/titles.ts`); the `title` output field stays `optional` because `media.tmdbId` is not guaranteed — `media` can be absent entirely, and present-but-without-`tmdbId` also occurs — and because a lookup can fail. Neither case is an error: the row keeps every other field, and the two outcomes are disclosed separately (attempted-and-failed vs. never-hydratable) so a normal missing ID never reads as a failure. `mediaType` in the response comes from `request.type` (the field on the request is `type`, not `mediaType`). `requestedBy` and `modifiedBy` are full `User` objects — both must be projected to `{ id, displayName }` via normalizers. `pageInfo` is `{ page, pages, pageSize, results }`. Note that `serviceErrors` is also present at the list level (`{ radarr: [], sonarr: [] }`) — ignore/drop it from output.

---

### 4. `seerr_request_media`  (the guarded write)

**Purpose:** The only mutation in the surface. Resolves and previews a request payload, then creates it only on explicit confirmation. "Download Mulan" = "create a Seerr request for Mulan" — never a direct Radarr/Sonarr call.

**Endpoints:** `GET /movie/{id}` or `GET /tv/{id}` (resolve + duplicate check, always) → `POST /request` (only when `mode: request` and confirmed).

**Input:**
```ts
z.object({
  mediaType: z.enum(['movie','tv'])
    .describe('Whether tmdbId is a movie or TV show.'),
  tmdbId: z.number().int().positive()
    .describe('TMDB ID from seerr_search_media. Must be the exact resolved ID — preview shows the title it resolves to so you can confirm before requesting.'),
  mode: z.enum(['preview','request']).default('preview')
    .describe('"preview" (default) resolves and returns the exact payload that WOULD be submitted WITHOUT creating anything. "request" submits the request to Seerr. Always preview first unless the title is already confirmed.'),
  is4k: z.boolean().default(false)
    .describe('Request the 4K version. Only valid when the instance has 4K enabled for this media type (preview reports capability); Seerr rejects 4K requests otherwise.'),
  seasons: z.union([
    z.literal('all'),
    z.array(z.number().int().min(0)).min(1),
  ]).optional()
    .describe('TV only. "all" hands the whole series to the instance, which decides whether that includes season 0 (Specials). An explicit list (e.g. [1,2]) requests exactly those seasons, and season 0 is rejected unless the instance enables special episodes. Required for TV requests; ignored for movies.'),
  serverId: z.number().int().min(0).optional()
    .describe('Override the Radarr/Sonarr server ID (from seerr_service_options). Omit to use the Seerr default — recommended.'),
  profileId: z.number().int().positive().optional()
    .describe('Override the quality profile ID (from seerr_service_options). Omit to use the server default.'),
  rootFolder: z.string().optional()
    .describe('Override the root folder path. Omit to use the server default — recommended. Rarely needed; Seerr routes by default.'),
  languageProfileId: z.number().int().positive().optional()
    .describe('Sonarr language profile ID override (TV only). Omit to use the default.'),
})
```

**Output (discriminated union on `mode`):**
```ts
z.object({
  mode: z.enum(['preview','request']).describe('Which arm ran.'),
  resolved: z.object({
    tmdbId: z.number().describe('Resolved TMDB ID.'),
    mediaType: z.enum(['movie','tv']).describe('Movie or TV.'),
    title: z.string().describe('Resolved title — confirm this matches intent before requesting.'),
    year: z.number().optional().describe('Release/first-air year.'),
  }).describe('What the tmdbId resolved to — the confirmation surface.'),
  capability: z.object({
    is4kEnabled: z.boolean().describe('Whether 4K is enabled for this media type on the instance.'),
    partialRequestsEnabled: z.boolean().describe('Whether per-season TV requests are allowed.'),
  }).describe('Instance constraints relevant to this request.'),
  payload: z.object({
    mediaType: z.enum(['movie','tv']).describe('Payload media type.'),
    mediaId: z.number().describe('TMDB ID Seerr will request.'),
    is4k: z.boolean().describe('4K flag in the payload.'),
    seasons: z.union([z.literal('all'), z.array(z.number())]).optional().describe('Seasons in the payload (TV).'),
    serverId: z.number().optional().describe('Server override, if any.'),
    profileId: z.number().optional().describe('Profile override, if any.'),
    rootFolder: z.string().optional().describe('Root folder override, if any.'),
    languageProfileId: z.number().optional().describe('Language profile override, if any.'),
  }).describe('The exact request body that was (or would be) submitted.'),
  existingRequest: z.object({
    requestId: z.number().describe('Existing request ID for this title, if one already exists.'),
    status: StatusRef.describe('Decoded status of the existing request.'),
    is4k: z.boolean().describe('Whether the existing request is 4K.'),
  }).optional().describe('Surfaced when the title already has a request — preview warns; request still proceeds if the agent intends a distinct (e.g. 4K) request.'),
  created: z.object({
    requestId: z.number().describe('New request ID — pass to seerr_request_status.'),
    requestStatus: StatusRef.describe('Decoded status of the created request (often "pending" or auto-"approved").'),
    mediaStatus: StatusRef.optional().describe('Decoded media availability after creation.'),
  }).optional().describe('Present only when mode=request and the POST succeeded.'),
})
```

**Handler flow:**

| # | Call | Purpose | Mode gate |
|:--|:--|:--|:--|
| 1 | `GET /settings/public` (cached) | Read `movie4kEnabled`/`series4kEnabled`/`partialRequestsEnabled`/`enableSpecialEpisodes` for capability + validation | always |
| 2 | `GET /movie/{id}` or `/tv/{id}` | Resolve title/year, read `mediaInfo` for existing requests | always |
| 3 | Build `payload`, validate (4K allowed? seasons valid? partial allowed?) | Local validation → typed errors before any write | always |
| 4 | `ctx.requestInput` confirmation round | Human confirms the resolved title + payload before the POST; the handler suspends and is re-entered with the answer | `request` only |
| 5 | `POST /request` | Create the request | `request` only |
| 6 | Decode response, project, return `created` | Post-write state for chaining | `request` only |

Settings (step 1) cached in `ctx.state` with a short TTL (instance config rarely changes) to avoid a round-trip on every preview.

**Confirmation round (guarded write):**
```ts
annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false },
// ...
// First pass through the request arm carries no response — suspend and ask.
if (ctx.inputs.view(CONFIRM_KEY).kind === 'missing') {
  return ctx.requestInput({
    inputRequests: {
      [CONFIRM_KEY]: inputRequired.elicit({
        message: `Create a Seerr request for "${resolved.title}"${input.is4k ? ' (4K)' : ''}` +
          `${seasonSummary}? This adds it to your Radarr/Sonarr download queue.`,
        requestedSchema: ConfirmSchema,
      }),
    },
  });
}
// Re-entered. Anything that is not a schema-valid acceptance is terminal, never a re-ask.
if (ctx.inputs.accepted(CONFIRM_KEY, ConfirmSchema)?.confirmed !== true) {
  throw ctx.fail('request_cancelled', 'Request cancelled before submission.');
}
// POST proceeds.
```
`mode: preview` default is the blast-radius safe default; `mode: request` plus an accepted confirmation is the explicit, confirmed path. The schema is passed to both the request and the read because the SDK never re-validates the response against the schema its request advertised. There is no "proceed anyway when the round is unavailable" branch — `ctx.requestInput` is present on every transport and both protocol eras, so a client that never answers simply leaves the write un-run. That requires `MCP_SESSION_MODE` to resolve to `stateful` under HTTP: a 2025-era client answers over a live session, which `stateless` has no way to hold open.

**Errors (typed contract):**
```ts
errors: [
  { reason: 'media_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'tmdbId does not resolve to a movie/show (Seerr 500 "Unable to retrieve movie.")',
    recovery: 'Run seerr_search_media to get the correct tmdbId and retry.' },
  { reason: 'seasons_required', code: JsonRpcErrorCode.InvalidParams,
    when: 'mediaType is tv but no seasons were provided',
    recovery: 'Provide seasons: "all" for the whole series or an explicit list like [1,2].' },
  { reason: 'four_k_not_enabled', code: JsonRpcErrorCode.InvalidParams,
    when: 'is4k:true but the instance has no 4K configured for this media type',
    recovery: 'Resubmit with is4k:false, or check seerr_service_options for 4K availability.' },
  { reason: 'partial_requests_disabled', code: JsonRpcErrorCode.InvalidParams,
    when: 'an explicit season list was given but the instance disallows partial requests',
    recovery: 'Use seasons:"all" to request the full series.' },
  { reason: 'special_episodes_not_enabled', code: JsonRpcErrorCode.InvalidParams,
    when: 'the season list includes 0 (Specials) but the instance has special episodes disabled',
    recovery: 'Drop season 0 from the list, or confirm specialEpisodesEnabled via seerr_service_options first.' },
  { reason: 'duplicate_request', code: JsonRpcErrorCode.InvalidParams,
    when: 'Seerr rejects the POST because an identical request already exists',
    recovery: 'Check the existingRequest in this output; track it with seerr_request_status instead of re-requesting.' },
  { reason: 'request_cancelled', code: JsonRpcErrorCode.InvalidParams,
    when: 'the confirmation round came back declined, cancelled, or without a valid acceptance',
    recovery: 'Re-run with mode:request and confirm if you intend to submit.' },
]
```
Validation errors (4K, seasons) are caught **locally before the POST** using the cached settings — the agent gets an actionable error without a failed write. `duplicate_request` is detected from the POST's upstream rejection (Seerr 409/500) and cross-checked against the resolved `mediaInfo.requests`.

**Annotations:** `{ destructiveHint: true, openWorldHint: true, idempotentHint: false }`.

**Field-shape notes (live):** `POST /request` body fields confirmed from spec: `mediaType` (enum movie|tv), `mediaId` (number, = TMDB ID), `seasons` (`number[]` or `"all"`), `is4k`, `serverId`, `profileId`, `rootFolder`, `languageProfileId`, `userId` (we never set `userId` — the request is made as the API key's user). Required: `mediaType`, `mediaId`. Response is a `MediaRequest`. **No write was executed during design** — POST shape is from the spec; preview path was validated against live GETs only.

---

### 5. `seerr_request_status`

**Purpose:** Track one request through its lifecycle. Wraps `GET /request/{id}`. Returns decoded request + media status, requester, routing summary, and a recovery hint tuned to the current state.

**Endpoint:** `GET /request/{requestId}`

**Input:**
```ts
z.object({
  requestId: z.number().int().positive()
    .describe('Request ID from seerr_request_media (created.requestId) or seerr_list_requests (requests[].requestId).'),
})
```

**Output:**
```ts
z.object({
  requestId: z.number().describe('The request ID.'),
  mediaType: z.enum(['movie','tv']).describe('Movie or TV.'),
  title: z.string().optional().describe('Title of the requested media, joined from the media record; absent when the request carries no tmdbId or the lookup failed.'),
  tmdbId: z.number().optional().describe('TMDB ID of the media.'),
  requestStatus: StatusRef.describe('Decoded request status {raw,label}.'),
  mediaStatus: StatusRef.optional().describe('Decoded media availability {raw,label}.'),
  mediaStatus4k: StatusRef.optional().describe('Decoded 4K availability {raw,label} when applicable.'),
  is4k: z.boolean().describe('Whether this is a 4K request.'),
  seasons: z.array(z.number()).optional().describe('Requested season numbers (TV).'),
  requestedBy: z.object({
    id: z.number().describe('Requester user ID.'),
    displayName: z.string().describe('Requester display name (no email/tokens).'),
  }).describe('Who requested it — id + display name only.'),
  routing: z.object({
    serverId: z.number().optional().describe('Radarr/Sonarr server ID handling the request.'),
    profileName: z.string().optional().describe('Quality profile name (human-readable, not a path); null at the single-request endpoint — use seerr_service_options to resolve profile names by ID.'),
    is4k: z.boolean().describe('Whether routed to the 4K service.'),
  }).describe('Routing summary — names/IDs only, no filesystem paths.'),
  createdAt: z.string().describe('ISO creation timestamp.'),
  updatedAt: z.string().describe('ISO last-updated timestamp.'),
  stateGuidance: z.string().optional()
    .describe('Recovery/next-step hint tuned to the current status, e.g. failed → "retry in the Seerr UI"; pending → "awaiting approval".'),
})
```

**Errors (typed contract):**
```ts
errors: [
  { reason: 'request_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'No request exists with the given ID',
    recovery: 'List requests with seerr_list_requests to find a valid requestId.' },
]
```

**Annotations:** `{ readOnlyHint: true, openWorldHint: true }`.

**Field-shape notes (live):** `routing.profileName` should be declared **optional** — the field is `null` on the `GET /request/{id}` response in live probes (present at the list level but null here). Declare `routing.profileName` as `z.string().optional()`. `title` is not present on the request object — it is joined from the media endpoint on every call here (one request, one extra read, so no opt-in flag), and stays `optional` because a request with no `media.tmdbId`, or a failed lookup, degrades to no title rather than an error. `request.type` (not `mediaType`) is the raw field name. `modifiedBy` is present and must also be projected through the redaction normalizer (same PII as `requestedBy`). `stateGuidance` is derived locally from the decoded request status plus the availability that tracks the request — `media.status4k` when `is4k` is true, `media.status` otherwise, since the two resolutions download through separate Radarr/Sonarr services. It is *guidance*, not a fabricated fact; it never claims an ETA the API doesn't provide.

**Output fix — `routing.profileName` must be optional:**
```ts
routing: z.object({
  serverId: z.number().optional().describe('Radarr/Sonarr server ID handling the request.'),
  profileName: z.string().optional().describe('Quality profile name; null when not set on this request.'),
  is4k: z.boolean().describe('Whether routed to the 4K service.'),
}).describe('Routing summary — names/IDs only, no filesystem paths.'),
```

---

### 6. `seerr_service_options`

**Purpose:** Let an agent reason about request capability and routing without a separate status tool. Summarizes configured Radarr/Sonarr services + default quality profiles, folds in compact Seerr version and public feature flags (4K, partial requests, specials). Redacts filesystem paths by default.

**Endpoints:** `GET /service/radarr` + `GET /service/sonarr` (lists), optionally `GET /service/radarr/{id}` + `/service/sonarr/{id}` (profiles/folders), `GET /settings/public`, `GET /status`. Fanned out with `Promise.allSettled` so one failure degrades gracefully.

**Input:**
```ts
z.object({
  service: z.enum(['radarr','sonarr','all']).default('all')
    .describe('Which service(s) to summarize. "all" covers both movie (Radarr) and TV (Sonarr) routing.'),
  includePaths: z.boolean().default(false)
    .describe('Include filesystem root-folder paths and free space. Default false redacts paths (operator-private). Set true only when you explicitly need routing paths.'),
})
```

**Output:**
```ts
z.object({
  instance: z.object({
    version: z.string().describe('Seerr version, e.g. "3.3.0".'),
    mediaServer: z.string().describe('Decoded media server: "plex" | "jellyfin" | "emby".'),
    movie4kEnabled: z.boolean().describe('Whether 4K movie requests are allowed.'),
    series4kEnabled: z.boolean().describe('Whether 4K TV requests are allowed.'),
    partialRequestsEnabled: z.boolean().describe('Whether per-season TV requests are allowed.'),
    specialEpisodesEnabled: z.boolean().describe('Whether season 0 (Specials) can be requested.'),
  }).describe('Instance capability summary — what kinds of requests will be accepted.'),
  services: z.array(z.object({
    kind: z.enum(['radarr','sonarr']).describe('Service type — Radarr (movies) or Sonarr (TV).'),
    serverId: z.number().describe('Server ID — pass to seerr_request_media serverId to override routing.'),
    name: z.string().describe('Service display name.'),
    isDefault: z.boolean().describe('Whether this is the default server for its media type.'),
    is4k: z.boolean().describe('Whether this server handles 4K.'),
    activeProfileId: z.number().describe('Default quality profile ID — pass as profileId to override.'),
    profiles: z.array(z.object({
      id: z.number().describe('Quality profile ID for profileId overrides.'),
      name: z.string().describe('Quality profile name, e.g. "HD-1080p", "Ultra-HD".'),
    })).optional().describe('Available quality profiles (from the detail endpoint).'),
    rootFolders: z.array(z.object({
      path: z.string().describe('Root folder path — only present when includePaths is true.'),
      freeSpace: z.number().optional().describe('Free space in bytes (raw API field name: freeSpace, not freeSpaceBytes) — only when includePaths is true.'),
    })).optional().describe('Root folders — omitted unless includePaths is true (paths are operator-private).'),
  })).describe('Configured Radarr/Sonarr services with routing defaults.'),
})
```

**Enrichment:** `notice` (optional) when a service leg failed (`Sonarr details unavailable; profile list omitted.`) so a partial result is honestly disclosed.

**Errors:** None declared — partial failures degrade to a `notice`; a total Seerr outage bubbles as `ServiceUnavailable`.

**Annotations:** `{ readOnlyHint: true, openWorldHint: true }`.

**Field-shape notes (live):** the **list** endpoint leaks `activeDirectory` (`/media/Movies`) on Radarr and `activeDirectory` + `activeAnimeDirectory` on Sonarr — the normalizer must drop both unless `includePaths`. Sonarr list also includes `activeAnimeProfileId`. The Sonarr **detail** endpoint (`/service/sonarr/0`) returns `{ server, profiles[], rootFolders[], tags, languageProfiles }` — `languageProfiles` is `null` on this instance (Sonarr v3+ dropped language profiles; `languageProfileId` on requests is still accepted by Sonarr v4 but does nothing). The **detail** endpoint returns `profiles[]` (array, not single object as the spec says) and `rootFolders[]` with `{ id, path, freeSpace }` — field is `freeSpace` (not `freeSpaceBytes`). `profiles`/`rootFolders` require the per-service detail call; the list alone gives `activeProfileId` but not profile names. Detail fetched only when needed (always for profile names; folders only when `includePaths`). Sonarr detail also has a `tags` array — ignore. The `activeProfileName` field is **absent** from both list and detail endpoints — profile names only come from the detail's `profiles[]`.

---

## Services

| Service | Wraps | Used By |
|:--|:--|:--|
| `SeerrService` (`src/services/seerr/seerr-service.ts`) | Seerr REST API v1 (`{SEERR_BASE_URL}/api/v1`), `X-Api-Key` auth | All six tools + the resource |

Single service, init/accessor pattern (`getSeerrService()`), initialized in `setup()`. One upstream API → one service. Internal structure:

- `seerr-service.ts` — the client: typed methods (`search`, `getMovie`, `getTv`, `getSeason`, `listRequests`, `getRequest`, `createRequest`, `getRadarrServices`, `getRadarrDetail`, `getSonarrServices`, `getSonarrDetail`, `getPublicSettings`, `getStatus`). Each wraps plain `fetch` + `withRetry` (`@cyanheads/mcp-ts-core/utils`) — **not** `fetchWithTimeout`, whose SSRF guard would block the private LAN/Tailscale address and whose thrown error hides the response body the not-found classifier reads. The timeout comes from `AbortSignal.timeout` instead.
- `status.ts` — pure status decoders (`decodeRequestStatus`, `decodeMediaStatus`, `decodeMediaServer`) returning `{ raw, label }`.
- `normalizers.ts` — raw→domain projection, including the `User`→`{id,displayName}` and path/URL redaction. The single choke point for PII/infra stripping.
- `titles.ts` — the request→title join (`resolveTitles` for a page, `hydrateRequestTitle` for one record). Request objects carry no title, so this reads `getMovie`/`getTv` and keeps only the title string. De-duplicates by `(mediaType, tmdbId)`, caps concurrency, and makes every leg single-attempt; a failed or impossible lookup yields no title rather than an error.
- `types.ts` — raw upstream types (hand-written from spec + live probes) and domain types.
- `errors.ts` — the upstream-error classifier: detects HTTP 500 + body `Unable to retrieve movie.` → `media_not_found`; maps other non-OK to `ServiceUnavailable`.

**Resilience:**

| Concern | Decision |
|:--|:--|
| Retry boundary | Service method wraps fetch + parse via `withRetry`. |
| Backoff | ~300ms base (local/LAN instance recovers fast; not rate-limited). |
| HTTP status check | The service checks `response.ok` itself and hands the non-OK response to the error classifier, which inspects status+body to distinguish `media_not_found` from generic `ServiceUnavailable` **before** the generic mapping. |
| Parse classification | Seerr returns JSON error envelopes (`{message}`); the classifier reads them rather than treating a 500 body as a serialization failure. |
| Settings cache | `getPublicSettings()`/`getStatus()` cached in `ctx.state` with a short TTL — read on most calls (capability checks), changes rarely. |

**API efficiency:** no batch endpoints exist (single-ID GETs). `seerr_service_options` fans out service+settings+status with `Promise.allSettled`. `seerr_request_media` reuses the cached settings for capability validation instead of re-fetching per call. No DataCanvas — this is a discovery/operational surface (categorical metadata + lifecycle state), not analytical row sets an agent would SQL.

---

## Config

`src/config/server-config.ts` — lazy-parsed Zod schema, separate from framework config (`parseEnvConfig` maps schema paths → env var names so errors name the variable).

| Env Var | Required | Description |
|:--|:--|:--|
| `SEERR_BASE_URL` | Yes | Base URL of the Seerr instance, e.g. `http://localhost:5055`. The service appends `/api/v1`. No trailing slash. |
| `SEERR_API_KEY` | Yes | Seerr API key (Settings → General → API Key). Sent as the `X-Api-Key` header. |
| `SEERR_REQUEST_TIMEOUT_MS` | No (default 15000) | Per-request HTTP timeout in milliseconds. |

```ts
const ServerConfigSchema = z.object({
  baseUrl: z.string().url().describe('Seerr instance base URL (no /api/v1 suffix, no trailing slash).'),
  apiKey: z.string().min(1).describe('Seerr API key sent as X-Api-Key.'),
  requestTimeoutMs: z.coerce.number().int().positive().default(15000).describe('HTTP request timeout (ms).'),
});
// parseEnvConfig(ServerConfigSchema, {
//   baseUrl: 'SEERR_BASE_URL', apiKey: 'SEERR_API_KEY', requestTimeoutMs: 'SEERR_REQUEST_TIMEOUT_MS',
// })
```

Both `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`) must list `SEERR_BASE_URL` + `SEERR_API_KEY` (lint:packaging verifies the names match). `.codex-plugin/mcp.json` and `.claude-plugin/plugin.json` get the same two env vars.

**Auth model:** `auth: 'none'` at the framework level (stdio, local-only, single-tenant). No per-tool MCP auth scopes — the only credential is the Seerr API key in config, not an MCP-layer JWT. `hostable: false` is enforced by design (a hosted deployment would need per-user base URLs + keys + a human approval model).

---

## Identity

`createApp()` (`src/index.ts`):
```ts
await createApp({
  name: 'seerr-mcp-server',
  title: 'seerr-mcp-server',                      // hyphenated machine name — NOT "Seerr MCP Server"
  // websiteUrl and description are NOT set here — description derives from package.json (canonical),
  // websiteUrl is not in the identity block (name + title ONLY per cyanheads convention).
  tools: [ /* the six */ ],
  resources: [ seerrRequestResource ],
  instructions:
    'Local Seerr request workflow. Search first (seerr_search_media), confirm the exact title ' +
    '(seerr_get_media), then request via seerr_request_media — which defaults to mode:preview and ' +
    'only writes on mode:request. "Download X" means "create a Seerr request for X"; never bypass to Radarr/Sonarr.',
});
```
`description` derives from `package.json` (canonical) — never duplicated into `createApp()`. `websiteUrl` is not an identity field for this server (per project convention: `createApp` canonical block is `name` + `title` ONLY). `manifest.json` `display_name` = `seerr-mcp-server`. Display identity is the hyphenated repo name on every surface — never Title Case.

---

## Implementation Order

1. **Config + server setup** — `server-config.ts` (`SEERR_BASE_URL`/`SEERR_API_KEY`/timeout), wire `createApp` identity, drop echo definitions.
2. **`SeerrService`** — client methods, `status.ts` decoders, `errors.ts` classifier (the 500→`media_not_found` map), `normalizers.ts` (User projection + path/URL redaction), `types.ts`. Independently testable against the live instance (read-only).
3. **Read-only tools** — `seerr_search_media`, `seerr_get_media`, `seerr_list_requests`, `seerr_request_status`, `seerr_service_options`. Each ships with a test using `createMockContext`, including a **sparse-payload case** (untracked title → no `mediaInfo`) per the framework checklist.
4. **Write tool** — `seerr_request_media`: preview arm first (pure resolve+validate, fully testable without writing), then the confirmation-guarded `request` arm. Validation (4K/seasons/partial) tested against cached settings; the POST path tested with a faked service (never the live instance).
5. **Resource** — `seerr://request/{requestId}` reusing the service + normalizers.
6. **Polish** — `polish-docs-meta` (README, badges, CHANGELOG, server.json/manifest env vars), `devcheck`, `security-pass` (output injection on title/overview strings, the PII redaction choke point, the guarded-write blast radius).

Each step is independently testable; read-only steps (2–3, 5) verify against the live instance, the write step (4) against fakes only.

---

## Design Decisions

1. **Six tools, no more.** The idea.md sketch maps 1:1 to the surface — each is a distinct agent action (discover / confirm / list / request / track / understand-routing). No tool was cut; none added. `/status` and `/settings/public` fold into `seerr_service_options` (capability context) and the request tool's validation rather than a standalone status tool — version/flags are only useful *attached to* a routing or request decision.

2. **Guarded write = preview default + confirmation round + destructiveHint, three layers.** `mode: preview` is the blast-radius-safe default (a sloppy call shows the payload, writes nothing). `mode: request` suspends on `ctx.requestInput` and writes only once re-entered with a schema-valid acceptance. `destructiveHint: true` surfaces the risk in client-side approval flows. Local pre-validation (4K/seasons/partial, from cached settings) means most bad requests fail *before* the POST with an actionable error, not as a failed write. This matches the design skill's workflow-safety pattern exactly.

3. **Status is always `{ raw, label }`, never a bare number or string.** Decoding both halves (request status + media status, plus the separate `status4k`) is the single most repeated requirement in idea.md. Centralizing it in `status.ts` and typing every status field as `StatusRef` makes it impossible to leak a raw number to the agent, while preserving the raw value for debugging. Unknown codes degrade to `{raw:n, label:'unrecognized'}` — forward-compatible with new Seerr statuses.

4. **Error normalization is a service-layer classifier, not per-handler try/catch.** The live-confirmed HTTP 500 `Unable to retrieve movie.` is the canonical case — mapped to `media_not_found` (NotFound) with a search-recovery hint. Handlers stay pure (throw via `ctx.fail`); the classifier inspecting status+body lives once in `errors.ts`. Other 5xx bubble as `ServiceUnavailable` (retryable).

5. **PII/infra redaction is mandatory and centralized.** Live payloads leak operator email, Jellyfin/Plex IDs and tokens, avatar URLs, and internal `serviceUrl` (Tailscale IP:port), plus filesystem paths in `activeDirectory`/`rootFolders[].path`. The `normalizers.ts` choke point projects `User`→`{id,displayName}`, drops URLs/tokens, and gates paths behind `includePaths`. Doing this in normalizers (not `format()`) keeps **both** client surfaces clean. This is also a `security-pass` focus.

6. **Admin scope excluded by design.** The API key carries admin reach, but the surface is read + guarded-request only. Approval/decline, retry, edit/delete, **media/file deletion** (catastrophic + irreversible → excluded entirely, not just `destructiveHint`), user/settings/sync, issues, watchlist — all deferred. The single write is `POST /request`, double-guarded.

7. **Capped-list disclosure uses optional enrichment fields.** `truncated`/`shown`/`cap` are declared **optional** in the `enrichment` block (the framework only populates them when the cap is actually hit — declaring them required throws -32007 on every non-truncated result). `totalCount` is the required field, populated via `ctx.enrich.total(n)` on every call. Applies to `seerr_search_media` and `seerr_list_requests`.

8. **Title hydration is opt-in exactly where its cost scales with the input.** Request objects carry no title, so a readable row costs one media detail call. `seerr_list_requests` gates that behind `includeTitles` (default false) because a page can hold up to 100 rows — with the flag unset the tool makes the same single upstream call it always did. `seerr_request_status` and the `seerr://request/{id}` resource hydrate unconditionally: one request means one extra read, so a flag there would be schema noise, and a resource has no per-read input to gate on anyway. Within a hydrating call, lookups de-duplicate by `(mediaType, tmdbId)` — a 4K and a non-4K request for one film, or several seasons of one show, resolve once — and run through a fixed 6-wide worker pool so a full page never fans out unbounded against a self-hosted single-node instance. No cross-call title cache: intra-call de-duplication covers the case whose cost scales with `take`, while a keyed `ctx.state` cache would add an unbounded key space, a TTL, and N state round-trips to save only on repeated identical list calls. Rows that cannot be hydrated degrade rather than fail, and the disclosure keeps "lookup attempted and failed" separate from "no `tmdbId` to look up" so the normal case never reads as an error.

9. **No DataCanvas, no resource list().** The surface is categorical/operational metadata + lifecycle state (titles, IDs, statuses, routing) — a find-then-act discovery shape, not analytical rows an agent runs SQL over. DataCanvas would be dead weight. The one resource (`seerr://request/{id}`) is single-record; request *enumeration* is the filterable `seerr_list_requests` tool, which is the tool-only access path.

---

## Spec-vs-reality findings (from live read-only probes, Seerr 3.3.0)

The OpenAPI spec lags the running API in several places — the design follows the live shapes:

| Area | Spec says | Live reality | Design follows |
|:--|:--|:--|:--|
| `MediaInfo.status` | single `status` | `status` **and** `status4k` (separate 4K availability) | both decoded |
| `MediaRequest` | minimal (`id`, `status`, `media`, …) | rich: `type`, `seasonCount`, `profileName` (null at single-request endpoint), `isAutoRequest`, nested `media.status/status4k/serviceUrl`; **no `title` field** | project agent-relevant subset; `title` optional, joined from the media endpoint (`titles.ts`) |
| `MediaRequest.profileName` | present | **null at `GET /request/{id}`** — zero on live probe | declare `routing.profileName` as optional |
| `MediaRequest.type` | (not well documented) | `"movie"` or `"tv"` — field is `type`, NOT `mediaType` | normalizer maps `request.type → mediaType` in output |
| `/request` (list) | `pageInfo` + `results` | `{ pageInfo: { page, pages, pageSize, results }, results[], serviceErrors }` | use `pageInfo.results` for `totalCount` |
| `/search` response | (inconsistent) | `{ page, totalPages, totalResults, results[] }` — `totalResults` is the count | use `response.totalResults` for `totalCount` |
| `/search` result `mediaInfo` | includes `requests[]` | **no `requests[]`** in search results — only in `/movie/{id}` and `/tv/{id}` detail responses | `seerr_search_media` can only surface availability status, not open-request data |
| `/service/radarr/{id}` | `profiles` = single `ServiceProfile` | `{ server, profiles[], rootFolders[], tags }` — `profiles` is an **array**, `rootFolders[]` undocumented | array + folders |
| `/service/radarr` (list) | includes `activeProfileName` (required) | omits `activeProfileName`; includes `activeDirectory` (a path) | profile names need the detail call; redact `activeDirectory` |
| `/service/sonarr` (list) | (not detailed) | includes `activeDirectory`, `activeAnimeDirectory`, `activeAnimeProfileId`, `activeTags` | redact both directory fields; `activeAnimeProfileId` safe |
| `/service/sonarr/{id}` | (not detailed) | `{ server, profiles[], rootFolders[], tags, languageProfiles: null }` | `languageProfiles` null on Sonarr v4; `languageProfileId` accepted but no-ops |
| `rootFolders[].freeSpace` | (undocumented) | field is `freeSpace` (integer bytes), NOT `freeSpaceBytes` | use `freeSpace` in schema |
| `TvDetails` | `numberOfSeason` (singular) | `numberOfSeasons` (plural) | use plural |
| Missing movie | (no error schema) | **HTTP 500 `{"message":"Unable to retrieve movie."}`** | classify → `media_not_found` |
| Missing request | (no error schema) | **HTTP 404 `{"message":"Request not found."}`** | classify → `request_not_found` (NotFound) |
| `User` (nested in requests) | `{id,email,…}` | also `jellyfinUserId`, `jellyfinUsername`, `plexUsername`, `plexId`, avatars, quotas, `settings`, `recoveryLinkExpirationDate`, `warnings`, `userType`, `requestCount` — **both `requestedBy` AND `modifiedBy`** are full `User` | project both to `{id,displayName}` |
| `/settings/public` | `{initialized, plexClientIdentifier}` | also `movie4kEnabled`, `series4kEnabled`, `partialRequestsEnabled`, `enableSpecialEpisodes`, `mediaServerType`, `vapidPublic`, `applicationTitle` | drive capability + validation; strip `vapidPublic`/`plexClientIdentifier` from output |

**Probed (read-only, no writes):** `/status`, `/settings/public`, `/search?query=Mulan`, `/search?query=Disclosure` (tracked result), `/movie/1275779` (tracked), `/movie/99999999999` (forced 500), `/tv/1399` (season shape), `/request?take=3` and `/request?take=20` (real requests + nested User + serviceErrors), `/request/45` (single-request, confirmed null `profileName`), `/request/999999` (forced 404), `/service/radarr`, `/service/radarr/0`, `/service/sonarr`, `/service/sonarr/0`. **No `POST /request` or any write was executed.**

---

## Known Limitations

- **No `userId` impersonation.** Requests are created as the API key's user; the design never sets the `userId` POST field. Multi-user request attribution is out of scope (and an admin concern).
- **4K and partial-request capability are instance-dependent.** The tool validates against `/settings/public`, but if an operator changes settings, the short-TTL cache may briefly lag (acceptable — Seerr re-validates on the POST and the typed error surfaces it).
- **No native batch.** Seerr's GETs are single-ID; N titles = N calls. The surface mitigates by enriching search/get with availability inline (no follow-up needed to see status).
- **Request ETA is not available.** `stateGuidance` offers next-step advice (pending/processing/failed) but never fabricates a completion time the API doesn't provide.
- **Hostability blocked by design.** Per-user base URLs + keys + a stronger human-approval model would be required to host publicly; local stdio is the right shape.
- **`title` not on request objects.** Neither `GET /request` (list) nor `GET /request/{id}` returns a `title` field — the media nested object only carries `tmdbId`, `mediaType`, and status fields, so a title costs a secondary `GET /movie/{tmdbId}` or `GET /tv/{tmdbId}`. The single-request surfaces pay it on every read; the list gates it behind `includeTitles` and de-duplicates, so the flag's real cost is one call per *distinct* title on the page, not per row. `title` stays optional everywhere — `media.tmdbId` is not guaranteed, and a failed lookup degrades rather than erroring.
- **`languageProfileId` is a no-op on Sonarr v4.** The field is accepted by the POST but has no effect. The design exposes it as an override for completeness (useful for Sonarr v3 instances), but `seerr_service_options` correctly reports `languageProfiles: null` for v4.

---

## Review pass

*Design reviewer: cold pass against live Seerr 3.3.0. Read-only API probes executed. No writes. 2026-06-13.*

### Findings fixed in this pass

**1. `modifiedBy` PII — missing from redaction table.**
`modifiedBy` is a full `User` object with the same PII surface as `requestedBy` (confirmed live: email, `jellyfinUserId`, avatar, quotas, etc.). The original redaction table only listed `requestedBy`/`modifiedBy` as a combined entry but the handling description mentioned only `requestedBy` by name. Updated the PII table to explicitly call out `modifiedBy` and confirm both must be projected through the normalizer. Normalizer must strip both.

**2. `settings/public` fields not in redaction scope — `vapidPublic`, `plexClientIdentifier`.**
The live `/settings/public` response includes `vapidPublic` (push notification public key) and `plexClientIdentifier` (Plex client UUID). Neither was in the original redaction table. Neither should reach `seerr_service_options` output. Added to PII table with explicit "strip from output" handling.

**3. `rootFolders[].freeSpaceBytes` is wrong — live field is `freeSpace`.**
The design's `seerr_service_options` output schema declared `freeSpaceBytes` for the root folder free-space field. Live probe of `/service/radarr/0` returned `{ id, path, freeSpace }` — no `freeSpaceBytes`. Fixed to `freeSpace` in both the output schema and the spec-vs-reality table.

**4. Sonarr `activeAnimeDirectory` not in redaction scope.**
Live `/service/sonarr` list returned `activeDirectory`, `activeAnimeDirectory`, and `activeAnimeProfileId`. The design only mentioned `activeDirectory` for Sonarr. Both `activeDirectory` and `activeAnimeDirectory` are filesystem paths and must be redacted unless `includePaths`. Updated PII table and the `seerr_service_options` field-shape notes.

**5. Search response `totalResults` vs `pageInfo.results` distinction.**
The search endpoint (`/search`) uses `{ page, totalPages, totalResults, results[] }` — a flat envelope. The request-list endpoint uses `{ pageInfo: { page, pages, pageSize, results }, results[], serviceErrors }` — a nested envelope. The original enrichment note for `seerr_search_media` said "via `ctx.enrich.total(totalResults)`" which was correct but didn't explicitly call out the field-name difference from the request-list pattern. Clarified both enrichment annotations to name the exact source field for each tool.

**6. Search result `mediaInfo` does not include `requests[]`.**
The original design's `seerr_get_media` section noted that `mediaInfo.requests[]` is available on the movie/TV detail endpoints, but the `seerr_search_media` availability spec implicitly assumed the same structure. Live probe confirmed: search result `mediaInfo` has `status`/`status4k` but no `requests[]`. The `availability` output of `seerr_search_media` cannot include `openRequest` data. The field-shape note is updated to make this explicit.

**7. `title` is not a field on request objects — affects `seerr_list_requests` and `seerr_request_status`.**
Live probe of `GET /request` (list) and `GET /request/{id}` confirms: no `title` field on any request object. The nested `media` object has `tmdbId` and `mediaType` but no title. Both `seerr_list_requests` and `seerr_request_status` output schemas declared `title: z.string().optional()` — this was already optional, which is correct. The field-shape notes are updated to explain how `title` must be obtained (secondary media fetch) and that it is left unpopulated by default in list results to avoid N×1 fetches.

**8. `routing.profileName` is null at the single-request endpoint.**
Live probe of `GET /request/45` returned `profileName: null`. The output schema already declared this optional, which is correct. The field-shape note is updated to explicitly call this out and note that `seerr_service_options` is the right tool to resolve profile names by ID.

**9. `request.type` vs `mediaType` field naming.**
The raw request object uses `type` (`"movie"` or `"tv"`), not `mediaType`. The normalizer must map `request.type → mediaType` in output. Added to spec-vs-reality table and field-shape notes.

**10. Missing request → HTTP 404, not 500.**
The design's `seerr_request_status` typed contract correctly mapped `request_not_found` to `NotFound`. Confirmed via live probe: `GET /request/999999` returns HTTP 404 `{"message":"Request not found."}`. This is a clean 404 (not the ambiguous 500 pattern for movies). The error classifier in `errors.ts` must handle both patterns: 500+body for movie/tv not-found, and 404 for request not-found. Added to spec-vs-reality table.

**11. `activeProfileName` absent from Radarr list endpoint.**
Confirmed: `/service/radarr` (list) does not return `activeProfileName` — the spec claimed it was required. Already noted in the design, now explicitly added to the spec-vs-reality table.

**12. Identity block — `websiteUrl` and `description` removed from `createApp()`.**
The original identity snippet passed `websiteUrl` to `createApp()`. Per cyanheads convention, the `createApp` identity block is `name` + `title` ONLY. `description` derives from `package.json`; `websiteUrl` is not an identity field. Fixed in the identity section.

**13. Sonarr `languageProfiles` is null on v4 — `languageProfileId` override is a no-op.**
Live probe of `/service/sonarr/0` returned `languageProfiles: null`. Added to spec-vs-reality table and known limitations. The `languageProfileId` input field on `seerr_request_media` is retained for Sonarr v3 compatibility but documented as a no-op on v4.

### Items confirmed correct (no changes)

- Status decoding tables (request: 1-3, media: 1-6) — matches OpenAPI spec and live payloads.
- HTTP 500 `{"message":"Unable to retrieve movie."}` for missing TMDB IDs — confirmed live.
- `numberOfSeasons` plural on TV detail — confirmed live (`/tv/1399`).
- Guarded write design (preview default + confirmation round + `destructiveHint`) — structurally sound.
- `truncated`/`shown`/`cap` declared optional (correct — avoids -32007 on non-truncated results). `totalCount` via `.total()` required.
- `serviceUrl`/`serviceUrl4k` in `media` — confirmed live (internal host:port URL, redacted from this doc).
- Admin-scope exclusions complete.
- `profiles` is an array on `/service/radarr/0` — confirmed live.
- Settings cache pattern for capability validation — sound.
- `auth: 'none'` at framework level, local-only stdio — correct for this use case.
