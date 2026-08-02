/**
 * @fileoverview The mandatory PII / infrastructure redaction choke point. Every
 * raw Seerr payload is projected to a domain shape HERE — never in `format()` —
 * so both `structuredContent` and `content[]` are clean by construction.
 *
 * Live Seerr payloads leak operator-private data that must NEVER reach tool output:
 *   - `User` objects (BOTH `requestedBy` and `modifiedBy`): email, Plex/Jellyfin
 *     auth tokens, `jellyfinUserId`, `plexId`, avatar, permissions bitfield, quotas.
 *   - `MediaInfo.serviceUrl` / `serviceUrl4k`: internal `http://<tailscale-ip>:<port>/…`.
 *   - `jellyfinMediaId`, `ratingKey`, download status, etc. on `MediaInfo`.
 *   - Radarr/Sonarr `activeDirectory` + `activeAnimeDirectory` and root-folder `path`
 *     (filesystem paths) — gated behind `includePaths`.
 *   - `/settings/public` `vapidPublic` (push key) + `plexClientIdentifier` (Plex UUID).
 *
 * The projection functions below allow-list the fields they emit. They read named
 * fields off the raw object and drop everything else — a leaked field cannot pass
 * through because it is never copied. The base URL and API key live only in config
 * and likewise never appear in any projected shape.
 * @module services/seerr/normalizers
 */

import { type DecodedStatus, decodeMediaStatus, decodeRequestStatus } from './status.js';
import type {
  DomainUser,
  RawEpisode,
  RawMediaInfo,
  RawMediaRequest,
  RawRootFolder,
  RawSeason,
  RawServiceProfile,
  RawUser,
} from './types.js';

/**
 * Project a raw `User` to `{ id, displayName }` — the ONLY user shape allowed in
 * output. `displayName` is the first present of `username` → `jellyfinUsername` →
 * `plexUsername` → Seerr's own `displayName` → `User #<id>`. Every other field
 * (email, tokens, IDs, avatar, permissions, quotas) is dropped by omission.
 */
export function redactUser(raw: RawUser): DomainUser {
  const displayName =
    raw.username ??
    raw.jellyfinUsername ??
    raw.plexUsername ??
    raw.displayName ??
    `User #${raw.id}`;
  return { id: raw.id, displayName };
}

/** Decoded availability projected from a raw `MediaInfo`. `status4k` is omitted when absent. */
export interface DomainAvailability {
  status: DecodedStatus;
  status4k?: DecodedStatus;
}

/**
 * Project the availability fields of a raw `MediaInfo` to decoded `{ status, status4k? }`.
 * Reads ONLY `status` / `status4k` — `serviceUrl`, `jellyfinMediaId`, `ratingKey`,
 * and the rest of the leak surface are never touched. Status 1 (`unknown`) is the
 * fallback when the raw status is absent.
 */
export function redactAvailability(raw: RawMediaInfo): DomainAvailability {
  const status = decodeMediaStatus(raw.status ?? 1);
  return {
    status,
    ...(typeof raw.status4k === 'number' ? { status4k: decodeMediaStatus(raw.status4k) } : {}),
  };
}

/** Normalize requested season numbers off a raw request — handles both `number[]` and `{seasonNumber}[]`. */
export function normalizeSeasons(raw: RawMediaRequest): number[] {
  const seasons = raw.seasons;
  if (!Array.isArray(seasons)) return [];
  return seasons
    .map((s) => (typeof s === 'number' ? s : s?.seasonNumber))
    .filter((n): n is number => typeof n === 'number');
}

/** The existing-request projection surfaced on detail/preview outputs. */
export interface DomainOpenRequest {
  is4k: boolean;
  requestId: number;
  status: DecodedStatus;
}

/**
 * Pick the most recent request from a raw `MediaInfo.requests[]` and project it to
 * `{ requestId, status, is4k }`. Returns `undefined` when there are no requests.
 */
export function redactOpenRequest(media: RawMediaInfo | undefined): DomainOpenRequest | undefined {
  const requests = media?.requests;
  if (!Array.isArray(requests) || requests.length === 0) return;
  const latest = requests.reduce((newest, r) =>
    requestSortKey(r) >= requestSortKey(newest) ? r : newest,
  );
  return {
    requestId: latest.id,
    status: decodeRequestStatus(latest.status ?? 1),
    is4k: latest.is4k === true,
  };
}

/** Sort key for "most recent" request — `createdAt` epoch, falling back to `id`. */
function requestSortKey(r: RawMediaRequest): number {
  const t = r.createdAt ? Date.parse(r.createdAt) : Number.NaN;
  return Number.isNaN(t) ? r.id : t;
}

/** Project a raw season summary (TV detail) — allow-listed fields only. */
export function redactSeason(raw: RawSeason): {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
} {
  return {
    seasonNumber: raw.seasonNumber ?? 0,
    name: raw.name ?? '',
    episodeCount: raw.episodeCount ?? 0,
    airDate: raw.airDate ?? null,
  };
}

/** Project a raw episode (season detail) — allow-listed fields only; `overview` omitted when empty. */
export function redactEpisode(raw: RawEpisode): {
  episodeNumber: number;
  name: string;
  airDate: string | null;
  overview?: string;
} {
  const overview = raw.overview?.trim();
  return {
    episodeNumber: raw.episodeNumber ?? 0,
    name: raw.name ?? '',
    airDate: raw.airDate ?? null,
    ...(overview ? { overview } : {}),
  };
}

/** Project a raw quality profile to `{ id, name }`. */
export function redactProfile(raw: RawServiceProfile): { id: number; name: string } {
  return { id: raw.id, name: raw.name ?? `Profile ${raw.id}` };
}

/**
 * Project a raw root folder. Paths and free space are operator-private and are
 * surfaced ONLY when `includePaths` is true; otherwise this returns `undefined`
 * so the caller omits the folder entirely rather than emitting an empty shell.
 */
export function redactRootFolder(
  raw: RawRootFolder,
  includePaths: boolean,
): { path: string; freeSpace?: number } | undefined {
  if (!includePaths) return;
  return {
    path: raw.path ?? '',
    ...(typeof raw.freeSpace === 'number' ? { freeSpace: raw.freeSpace } : {}),
  };
}

/** Fully-redacted single-request projection — the shared shape behind seerr_request_status and the resource. */
export interface DomainRequestDetail {
  createdAt: string;
  is4k: boolean;
  mediaStatus?: DecodedStatus;
  mediaStatus4k?: DecodedStatus;
  mediaType: 'movie' | 'tv';
  requestedBy: DomainUser;
  requestId: number;
  requestStatus: DecodedStatus;
  routing: { serverId?: number; profileName?: string; is4k: boolean };
  seasons?: number[];
  stateGuidance?: string;
  title?: string;
  tmdbId?: number;
  updatedAt: string;
}

/**
 * Project a raw `MediaRequest` (single-request / created shape) to the redacted
 * `DomainRequestDetail`. The media-type discriminator is `type` (not `mediaType`);
 * `requestedBy` is projected to `{ id, displayName }`; `modifiedBy`, `serviceUrl`,
 * tokens, and paths are dropped by omission. `routing` carries names/IDs only.
 * `title` is never set here — request objects have no title field, so it is
 * joined from the media detail endpoint by `hydrateRequestTitle` (`titles.ts`),
 * keeping this projection sync and I/O-free.
 * `stateGuidance` reads `status4k` for a 4K request and `status` otherwise.
 */
export function projectRequestDetail(raw: RawMediaRequest): DomainRequestDetail {
  const mediaType: 'movie' | 'tv' = raw.type === 'tv' ? 'tv' : 'movie';
  const requestStatus = decodeRequestStatus(raw.status ?? 1);
  const mediaStatus =
    typeof raw.media?.status === 'number' ? decodeMediaStatus(raw.media.status) : undefined;
  const mediaStatus4k =
    typeof raw.media?.status4k === 'number' ? decodeMediaStatus(raw.media.status4k) : undefined;
  const seasons = normalizeSeasons(raw);
  const is4k = raw.is4k === true;
  /**
   * A 4K request downloads through the 4K Radarr/Sonarr service, whose progress
   * lives on `status4k` — the non-4K `status` describes a separate pipeline and
   * commonly sits at `unknown` while the 4K copy is already processing.
   */
  const availability = is4k && mediaStatus4k ? mediaStatus4k : mediaStatus;
  const guidance = stateGuidanceFor(requestStatus, availability);
  const tmdbId = raw.media?.tmdbId;

  return {
    requestId: raw.id,
    mediaType,
    ...(typeof tmdbId === 'number' ? { tmdbId } : {}),
    requestStatus,
    ...(mediaStatus ? { mediaStatus } : {}),
    ...(mediaStatus4k ? { mediaStatus4k } : {}),
    is4k,
    ...(seasons.length > 0 ? { seasons } : {}),
    requestedBy: raw.requestedBy ? redactUser(raw.requestedBy) : { id: 0, displayName: 'Unknown' },
    routing: {
      ...(typeof raw.serverId === 'number' ? { serverId: raw.serverId } : {}),
      ...(raw.profileName ? { profileName: raw.profileName } : {}),
      is4k,
    },
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt ?? '',
    ...(guidance ? { stateGuidance: guidance } : {}),
  };
}

/**
 * Derive a next-step hint from the decoded request status plus the availability
 * that tracks THIS request (`status4k` for a 4K request, `status` otherwise).
 * Guidance only — never an ETA.
 */
function stateGuidanceFor(
  requestStatus: DecodedStatus,
  availability: DecodedStatus | undefined,
): string | undefined {
  switch (requestStatus.label) {
    case 'pending':
      return 'Awaiting approval in Seerr. An operator must approve it before it downloads.';
    case 'declined':
      return 'This request was declined in Seerr. Re-request only if the decision should change.';
    case 'failed':
      return 'This request failed in Seerr. Retry it from the Seerr UI; the API does not expose a retry.';
    case 'completed':
      return 'This request is complete. The media should be available to watch.';
    case 'approved':
      break;
    default:
      return;
  }
  switch (availability?.label) {
    case 'processing':
    case 'pending':
      return 'Approved and downloading via Radarr/Sonarr. Check back shortly.';
    case 'partially_available':
      return 'Some media is available; the rest is still downloading.';
    case 'available':
      return 'Media is available to watch.';
    case 'unknown':
      return 'Approved, but no download has started — if it stays stuck, retry the request in the Seerr UI.';
    default:
      return;
  }
}
