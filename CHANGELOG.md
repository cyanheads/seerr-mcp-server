# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-08-02

Adds opt-in title hydration to seerr_list_requests and unconditional hydration to seerr_request_status/resource; narrows the retry budget for best-effort title lookups; corrects a stale docs/design.md claim about the service's HTTP layer.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-08-02

Fixes unencoded search/list query strings, 4K request-status guidance, and season-0 (Specials) requests; consolidates README redaction prose; mcp-ts-core ^0.11.0 and TypeScript 7.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release: 6 tools + 1 resource over a local Jellyseerr/Overseerr instance — search, confirm, list, guarded request, track, and service routing, with mandatory PII/infra redaction.
