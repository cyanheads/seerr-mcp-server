---
name: seerr-guide
description: Judgment for the seerr_* tools on a self-hosted Seerr/Jellyseerr/Overseerr instance — whether a movie or show is already available or requested, requesting specific TV seasons or 4K, and why a request hasn't shown up. Use before submitting with seerr_request_media or answering a request-status question; covers regular vs 4K tracks, season handling, who owns server-made requests, the user-owned confirmation, and what a refusal means.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The server works one self-hosted Seerr instance (`SEERR_BASE_URL` plus `SEERR_API_KEY`): look up titles, read availability and request state, and create requests that Seerr routes to Radarr (movies) or Sonarr (TV). It never contacts Radarr, Sonarr, or the media server, and it reports no download progress or ETA.

It cannot approve or decline a request, retry a failed one, edit or delete a request, delete media, or change users and settings. When the answer needs one of those, say it has to be done in the Seerr web UI by someone with that permission; don't promise it.

For catalog questions (what else is like X, who stars in it), a TMDB catalog server answers better. This server's search is a way to get a `tmdbId` for a request.

## Identifiers

| ID | Where it comes from | Watch for |
|:---|:--------------------|:----------|
| `tmdbId` + `mediaType` | `seerr_search_media` results | Movie and TV IDs are separate number spaces: the same number names an unrelated movie and show. Always pass the `mediaType` from the same result. |
| `requestId` | `created.requestId` after a submit; `availability.openRequest` on `seerr_get_media`; `existingRequest` on a preview; rows of `seerr_list_requests` | `seerr_list_requests` cannot filter by title. To find the request for one title, read `seerr_get_media` first. |
| Seerr user ID (`requestedById`) | `requestedBy.id` on request rows | A Seerr account ID, not a Plex or Jellyfin ID. See gate 6 before filtering by it. |
| `serverId`, `profileId` | `seerr_service_options` | Leave both out unless the user asks for a specific server or quality profile. Seerr picks the default server for the request's quality. |

## Gates

1. **Read the track that matches the request's quality.** Seerr tracks the regular copy and the 4K copy separately: `status` and `mediaStatus` describe the regular one, `status4k` and `mediaStatus4k` the 4K one. Having it in 4K says nothing about the regular copy, and the reverse is also true. For a 4K request, judge progress by `mediaStatus4k`.

2. **`tracked: false` means Seerr has no record of the title.** Nobody has requested it and Seerr hasn't seen it in the library. Search results omit `availability` for an untracked title; `seerr_get_media` reports it as `unknown (1)`, which here means "no record", not "state can't be determined".

3. **`openRequest` and `existingRequest` are only the most recent request.** They report the latest request for the title at any quality and in any state, completed and declined included. The label "open" doesn't mean it is still open, so read its `status` and `is4k` before you say a request is pending. For a movie, Seerr refuses a second request at the same quality while one is pending, approved, or failed. After a declined or completed one, it accepts a new request.

4. **Season-level state isn't exposed.** `seerr_get_media` lists each season's episode count, but not its availability or request state. A show reads `partially_available` as a whole. The seasons already asked for appear in each request's `seasons` (from `seerr_request_status` or the list rows). When a TV request arrives, Seerr drops any season that is already requested or available and requests the rest. If no season is left, it creates nothing and the submit returns an error, not a `created.requestId`. Only a response that carries `created.requestId` means a new request exists.

5. **The confirmation belongs to the user.** `mode: request` makes the client show the user a yes/no prompt that names the title, plus 4K when requested and the seasons for TV. It carries no year, so the preview step is where the user confirms which title it is. The agent never answers it.
   - A declined or cancelled prompt returns `request_cancelled`. Treat that as the user's answer and resubmit only if they ask again.
   - `client_capability_missing` means this client can't show the prompt, so nothing was submitted. Tell the user to request it in the Seerr UI or from a client that supports form elicitation. Never look for a route around it.

6. **Requests made here belong to the API key's account, not to the person asking.** The server sends no user identity, so Seerr records the request under the API key's account: user 1, the instance's original admin. That account's permissions decide whether the request is auto-approved. As a result, "my requests" filtered by the person's own Seerr user ID won't include the ones made through this server.

7. **After a refused or failed submit, check before retrying.** A submit is attempted once, with no automatic retry.
   - **HTTP 403:** Seerr refused it for permission, quota, or a blocklisted title. The server withholds Seerr's reason, so don't guess which one.
   - **HTTP 409 or `duplicate_request`:** a request already exists (gate 3).
   - **Timeout or 5xx:** the request may have been created anyway. Read `seerr_get_media` and its `openRequest` before you submit again.

## Workflows

**"Is X already available or requested?"** Call `seerr_search_media`. A result with `tracked: false` is new to Seerr (gate 2). For a tracked result, call `seerr_get_media`, which has the request data that search results lack. Answer from the track the user cares about (gate 1). For an `openRequest`, report its status and quality, or follow it with `seerr_request_status` for the requester and next step.

**Request a movie or show.** Before any submit, preview with `seerr_request_media` and show the user the resolved title and year. Remakes and same-name shows are told apart by year. For a movie, if the preview carries an `existingRequest` at the same quality that is pending, approved, or failed, track that request instead of submitting (gate 3). Then submit with `mode: request` and the same arguments, and hand the resulting `created.requestId` to `seerr_request_status`.

**Specific seasons, Specials, or 4K.** A preview already runs the instance's 4K, per-season, and Specials checks, so a refusal there (`four_k_not_enabled`, `partial_requests_disabled`, `special_episodes_not_enabled`) costs nothing. `"all"` never includes Specials. Seerr expands it to the numbered seasons that have episodes, so request season 0 explicitly, and only when `specialEpisodesEnabled` is true in `seerr_service_options`. Asking for seasons the user already has costs nothing, because Seerr drops them (gate 4). If every season is already covered, nothing gets created and the submit errors; confirm with `seerr_get_media` and tell the user it is already requested or available rather than reporting a new request.

**"Why hasn't my request shown up?"** Find the request: `seerr_get_media` for a known title, otherwise `seerr_list_requests` with `includeTitles`. Then read `seerr_request_status` and its `stateGuidance`, using the 4K track for a 4K request:

| Request | Media | Meaning and next step |
|:--------|:------|:----------------------|
| `pending` | any | Waiting for an operator to approve it in Seerr. This server can't approve. |
| `approved` | `unknown` | Nothing has started. If it stays that way, an operator retries it in Seerr. |
| `approved` | `pending` / `processing` / `partially_available` | With Radarr/Sonarr; `partially_available` means some of it is already watchable. No progress or ETA is available here. |
| `approved` / `completed` | `available` | Seerr considers it done. If the user still can't find it, the cause is on the media server, outside this server's reach. |
| `failed` | any | Seerr couldn't hand it off. An operator retries it from the Seerr UI; this server has no retry. |
| `declined` | any | An operator declined it. Request again only if the user wants the decision revisited. |

**Choose a quality profile or server.** `seerr_service_options` lists each Radarr and Sonarr server with its `is4k` flag, its default `activeProfileId`, and its profile names. Pass `serverId` and `profileId` only when the user named a profile or server. Seerr sends the request to the server you name even when its `is4k` flag doesn't match the request, so a 4K request needs an `is4k` server and a regular request needs a non-4K one.
