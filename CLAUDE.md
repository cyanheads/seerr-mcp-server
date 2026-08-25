# Developer Protocol

**Server:** seerr-mcp-server
**Version:** 0.1.3
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.12.3`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What This Server Does

A workflow MCP server over a self-hosted Jellyseerr/Overseerr instance: **search → confirm the TMDB-backed title → check availability/request state → create a guarded request** that Radarr/Sonarr act on. Jellyseerr owns permissions, quotas, routing, and status; this server never touches Radarr/Sonarr directly. Read + guarded-request only — admin-scope endpoints (approve/decline, retry, edit/delete, media/file deletion, user/settings/sync) are excluded by design.

**Surface:** six tools (`seerr_search_media`, `seerr_get_media`, `seerr_list_requests`, `seerr_request_media`, `seerr_request_status`, `seerr_service_options`) + one resource (`seerr://request/{requestId}`). No prompts.

**Two invariants that must never regress:**

1. **Guarded write.** `seerr_request_media` is the only mutation. It defaults to `mode: preview` (resolve + validate, no POST); the real write fires only on `mode: request` and only once the handler is re-entered with a schema-valid acceptance on `ctx.inputs`, with `destructiveHint: true` surfacing the risk in client-side approval flows. There is no branch that proceeds without an acceptance — a client that never answers leaves the write un-run. Capability validation (4K/seasons/partial) runs locally against cached settings before any POST. `MCP_SESSION_MODE` must resolve to `stateful`: the round trip needs a live session for 2025-era clients, and `stateless` refuses it.
2. **PII/infra redaction.** Every raw Jellyseerr payload is projected through `src/services/seerr/normalizers.ts` — the single choke point — before output. It allow-lists fields: `User` → `{ id, displayName }`, and drops operator email, Plex/Jellyfin tokens, `serviceUrl`, `vapidPublic`, and filesystem paths (gated behind `includePaths`). The base URL and API key live only in config and never appear in output. Redaction lives in normalizers, not `format()`, so both `structuredContent` and `content[]` are clean. `ctx.log` is a third output surface — it is dual-sink as of mcp-ts-core 0.12.0, mirroring every call to the client as `notifications/message` — so log only classified reasons and the caller's own inputs, never a raw upstream or network message.

The authoritative tool surface, live API quirks, and status-decoding tables are in [`docs/design.md`](docs/design.md).

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Real example, condensed from `src/mcp-server/tools/definitions/search-media.tool.ts`. Note the `title` is the hyphenated machine name prefix (`seerr-mcp-server: …`), statuses are `{ raw, label }` via `StatusRef`, and redaction happens in the normalizer (`redactAvailability`), never in `format()`.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { redactAvailability } from '@/services/seerr/normalizers.js';
import { getSeerrService } from '@/services/seerr/seerr-service.js';
import { StatusRef, statusText } from '@/services/seerr/status.js';

export const searchMediaTool = tool('seerr_search_media', {
  title: 'seerr-mcp-server: search media',
  description: 'Search movies and TV shows by title and return ranked matches ...',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().min(1).describe('Title to search for, e.g. "Mulan".'),
    mediaType: z.enum(['movie', 'tv', 'all']).default('all').describe('Restrict results ...'),
    limit: z.number().int().min(1).max(20).default(10).describe('Max normalized results ...'),
  }),
  output: z.object({
    results: z.array(z.object({
      tmdbId: z.number().describe('TMDB ID — pass to seerr_get_media or seerr_request_media.'),
      tracked: z.boolean().describe('True when Seerr already tracks this title.'),
      availability: z.object({
        status: StatusRef.describe('Decoded media availability {raw,label}.'),
      }).optional().describe('Current Seerr availability; present only when tracked.'),
    })).describe('Ranked movie/TV matches. Empty array when nothing matched.'),
  }),
  enrichment: { totalCount: z.number().describe('Total results before this page limit.') },

  async handler(input, ctx) {
    const seerr = getSeerrService();
    const response = await seerr.search({ query: input.query }, ctx);
    // ... filter to movie/tv, normalize, redact mediaInfo via redactAvailability ...
    ctx.enrich.total(response.totalResults ?? 0);
    ctx.log.info('Seerr search completed', { query: input.query });
    return { results: [] };
  },

  // format() renders content[] (the markdown twin of structuredContent). Both surfaces
  // must carry the same data — lint enforces every output field appears in the text.
  format: (result) =>
    [{ type: 'text', text: result.results.map((r) => `**${r.tmdbId}**`).join('\n') }],
});
```

### Resource

The one resource, from `src/mcp-server/resources/definitions/request.resource.ts`. It reuses the same `projectRequestDetail` redaction choke point as `seerr_request_status`, so the output is identical and equally PII-clean.

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { projectRequestDetail } from '@/services/seerr/normalizers.js';
import { getSeerrService } from '@/services/seerr/seerr-service.js';

export const seerrRequestResource = resource('seerr://request/{requestId}', {
  name: 'seerr-request',
  title: 'seerr-mcp-server: request',
  description: 'Read-once summary of one Seerr media request by ID ...',
  mimeType: 'application/json',
  params: z.object({
    requestId: z.string().regex(/^\d+$/).describe('Numeric Seerr request ID.'),
  }),
  errors: [
    { reason: 'request_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'No request exists with the given ID (Seerr returns HTTP 404).',
      recovery: 'List requests with seerr_list_requests to find a valid requestId, then retry.' },
  ],
  async handler(params, ctx) {
    const seerr = getSeerrService();
    const raw = await seerr.getRequest(Number.parseInt(params.requestId, 10), ctx);
    return projectRequestDetail(raw);
  },
});
```

This server has no prompts — the guarded-write workflow lives in the tool, not a prompt template.

### Server config

The real schema from `src/config/server-config.ts` — two required vars (base URL + API key) and an optional timeout.

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z.string().url().describe('Seerr instance base URL, e.g. http://host:5055. No /api/v1 suffix, no trailing slash.'),
  apiKey: z.string().min(1).describe('Seerr API key (Settings → General → API Key). Sent as the X-Api-Key header.'),
  requestTimeoutMs: z.coerce.number().int().positive().default(15000).describe('Per-request HTTP timeout in milliseconds.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'SEERR_BASE_URL',
    apiKey: 'SEERR_API_KEY',
    requestTimeoutMs: 'SEERR_REQUEST_TIMEOUT_MS',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`SEERR_BASE_URL`) not the path (`baseUrl`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

The real `createApp()` call from `src/index.ts`. The identity block is **`name` + `title` ONLY** — both the hyphenated machine name (`seerr-mcp-server`, never Title Case). `description` is NOT set here — it derives from `package.json` (the canonical source); `websiteUrl` is not an identity field for this server.

```ts
await createApp({
  name: 'seerr-mcp-server',
  title: 'seerr-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  instructions:
    'Local Seerr request workflow. Search first (seerr_search_media), confirm the exact title ' +
    '(seerr_get_media), then request via seerr_request_media — which defaults to mode:preview and ' +
    'only writes on mode:request. "Download X" means "create a Seerr request for X"; never bypass to Radarr/Sonarr.',
  setup(core) {
    initSeerrService(core.config, core.storage);
  },
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Use it for deployment guidance instead of repeating the same context across tool descriptions. Client adoption is uneven, but there's no downside when set.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — used to cache `/settings/public` + `/status` with a short TTL so capability checks don't round-trip on every preview. |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. The guarded-write confirmation on `mode: request` runs through it. |
| `ctx.inputs` | Reader over a retried request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped`. Empty on the first round. Pass the schema to `.accepted()`: the SDK never re-validates what the client sent back. |
| `ctx.enrich` | Output enrichment — `.total(n)`, `.echo(query)`, `.truncated({ shown, cap })`, `.notice(msg)` for capped-list disclosure and effective-query echo. |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.fail` / `ctx.recoveryFor` | Typed-error contract throw + recovery-metadata lookup against each tool's `errors[]`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point (name + title only)
  config/
    server-config.ts                    # SEERR_BASE_URL / SEERR_API_KEY / timeout (Zod schema)
  services/
    seerr/
      seerr-service.ts                  # Jellyseerr REST client (init/accessor pattern)
      status.ts                         # Pure status decoders → { raw, label }
      normalizers.ts                    # PII/infra redaction choke point (the security boundary)
      titles.ts                         # Request → title join (deduped, capped, best-effort)
      errors.ts                         # Upstream-error classifier (500 → media_not_found, 404 → request_not_found)
      types.ts                          # Raw upstream + domain types
  mcp-server/
    tools/definitions/                  # Six *.tool.ts + barrel
    resources/definitions/              # request.resource.ts + barrel (no prompts/)
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `techniques` | Catalog of reusable response/data-shaping patterns — overflow handling, payload shaping, retrieval |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService — persistent self-refreshing local mirror of a bulk upstream dataset (not used by this server) |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs (`node_modules/**` `skills/`, `.claude/`, `.agents/`, `SKILL.md`) that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `npm run devcheck` passes
