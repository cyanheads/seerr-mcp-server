# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-09-20 · ⚠️ Breaking

Adopts mcp-ts-core 0.13.6: the HTTP session posture is declared in src/ so a stateless deployment fails startup instead of serving an unusable guarded write, argument rejections reach callers as InvalidParams with a recovery hint, and the framework skill tree moves to framework-skills/.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-08-25 · ⚠️ Breaking · 🛡️ Security

Adopts mcp-ts-core 0.12 (strict tool inputs, @modelcontextprotocol/server); closes the seerr_request_media confirmation bypass for non-elicit clients; fixes a settings-cache key bug and a title-lookup log leak.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-08-02

Adds opt-in title hydration to seerr_list_requests and unconditional hydration to seerr_request_status/resource; narrows the retry budget for best-effort title lookups; corrects a stale docs/design.md claim about the service's HTTP layer.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-08-02

Fixes unencoded search/list query strings, 4K request-status guidance, and season-0 (Specials) requests; consolidates README redaction prose; mcp-ts-core ^0.11.0 and TypeScript 7.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release: 6 tools + 1 resource over a local Jellyseerr/Overseerr instance — search, confirm, list, guarded request, track, and service routing, with mandatory PII/infra redaction.
