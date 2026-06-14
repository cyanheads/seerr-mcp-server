/**
 * @fileoverview Raw upstream Seerr API types (hand-written from the OpenAPI spec +
 * live read-only probes against Seerr 3.3.0) and the normalized domain types this
 * server exposes. Raw types default to optional unless the live payload guarantees
 * presence — third-party APIs omit fields rather than nulling them, and over-strict
 * raw types either fail validation or invent facts. The domain types are the
 * PII-redacted projections produced by `normalizers.ts`.
 * @module services/seerr/types
 */

/* ------------------------------------------------------------------ *
 * Raw upstream types
 * ------------------------------------------------------------------ */

/**
 * Raw Seerr `User` object. Nested in `requestedBy` AND `modifiedBy` on requests.
 * Carries heavy PII — email, Plex/Jellyfin tokens and IDs, quotas, avatar,
 * permissions bitfield. `normalizers.ts` projects it to `{ id, displayName }`;
 * nothing else here may reach tool output.
 */
export interface RawUser {
  avatar?: string;
  displayName?: string;
  email?: string;
  id: number;
  jellyfinUserId?: string;
  jellyfinUsername?: string;
  permissions?: number;
  plexId?: number;
  plexUsername?: string;
  username?: string;
  [key: string]: unknown;
}

/**
 * Raw `MediaInfo` nested on search results, movie/TV detail, and request `media`.
 * Leaks `serviceUrl`/`serviceUrl4k` (internal host:port), `jellyfinMediaId`,
 * `ratingKey`, etc. — only `status`/`status4k`/`tmdbId`/`mediaType` are read.
 * `requests[]` is present ONLY on movie/TV detail, never on search results.
 */
export interface RawMediaInfo {
  id?: number;
  mediaType?: string;
  requests?: RawMediaRequest[];
  serviceUrl?: string;
  serviceUrl4k?: string;
  status?: number;
  status4k?: number;
  tmdbId?: number;
  [key: string]: unknown;
}

/**
 * Raw `MediaRequest`. The media-type discriminator is `type` (not `mediaType`).
 * `profileName` is present at the list endpoint but ABSENT at `GET /request/{id}`.
 * Both `requestedBy` and `modifiedBy` are full `RawUser` objects.
 */
export interface RawMediaRequest {
  createdAt?: string;
  id: number;
  is4k?: boolean;
  isAutoRequest?: boolean;
  languageProfileId?: number | null;
  media?: RawMediaInfo;
  modifiedBy?: RawUser;
  profileId?: number;
  profileName?: string | null;
  requestedBy?: RawUser;
  rootFolder?: string | null;
  seasonCount?: number;
  seasons?: Array<{ seasonNumber?: number } | number>;
  serverId?: number;
  status?: number;
  type?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** Raw search-result hit (`MovieResult` | `TvResult`); `person` is filtered out upstream of this. */
export interface RawSearchResult {
  firstAirDate?: string;
  id: number;
  mediaInfo?: RawMediaInfo;
  mediaType?: string;
  name?: string;
  overview?: string;
  releaseDate?: string;
  title?: string;
  voteAverage?: number;
  [key: string]: unknown;
}

/** Raw `/search` response envelope (flat — distinct from the request-list `pageInfo` envelope). */
export interface RawSearchResponse {
  page?: number;
  results?: RawSearchResult[];
  totalPages?: number;
  totalResults?: number;
}

/** Raw season summary on TV detail (`seasons[]`). */
export interface RawSeason {
  airDate?: string | null;
  episodeCount?: number;
  id?: number;
  name?: string;
  overview?: string;
  seasonNumber?: number;
  [key: string]: unknown;
}

/** Raw episode on a season detail (`/tv/{id}/season/{n}` → `episodes[]`). */
export interface RawEpisode {
  airDate?: string | null;
  episodeNumber?: number;
  id?: number;
  name?: string;
  overview?: string;
  [key: string]: unknown;
}

/** Raw movie detail (`GET /movie/{id}`). */
export interface RawMovieDetail {
  id: number;
  mediaInfo?: RawMediaInfo;
  overview?: string;
  releaseDate?: string;
  runtime?: number;
  status?: string;
  title?: string;
  [key: string]: unknown;
}

/** Raw TV detail (`GET /tv/{id}`). Live API uses `numberOfSeasons` (plural). */
export interface RawTvDetail {
  firstAirDate?: string;
  id: number;
  mediaInfo?: RawMediaInfo;
  name?: string;
  numberOfSeasons?: number;
  overview?: string;
  seasons?: RawSeason[];
  status?: string;
  [key: string]: unknown;
}

/** Raw season detail (`GET /tv/{id}/season/{n}`). */
export interface RawSeasonDetail {
  episodes?: RawEpisode[];
  id?: number;
  name?: string;
  seasonNumber?: number;
  [key: string]: unknown;
}

/** Raw request-list envelope (`{ pageInfo, results, serviceErrors }`). */
export interface RawRequestListResponse {
  pageInfo?: { page?: number; pages?: number; pageSize?: number; results?: number };
  results?: RawMediaRequest[];
}

/** Raw `/settings/public`. Drives capability + validation; `vapidPublic`/`plexClientIdentifier` are stripped from output. */
export interface RawPublicSettings {
  applicationTitle?: string;
  enableSpecialEpisodes?: boolean;
  mediaServerType?: number;
  movie4kEnabled?: boolean;
  partialRequestsEnabled?: boolean;
  series4kEnabled?: boolean;
  [key: string]: unknown;
}

/** Raw `/status`. */
export interface RawStatus {
  version?: string;
  [key: string]: unknown;
}

/** Raw Radarr/Sonarr list entry. Leaks `activeDirectory` (+ `activeAnimeDirectory` on Sonarr). */
export interface RawServiceListEntry {
  activeAnimeDirectory?: string;
  activeAnimeProfileId?: number;
  activeDirectory?: string;
  activeProfileId?: number;
  id: number;
  is4k?: boolean;
  isDefault?: boolean;
  name?: string;
  [key: string]: unknown;
}

/** Raw quality profile (`{ id, name }`) from a service detail endpoint. */
export interface RawServiceProfile {
  id: number;
  name?: string;
  [key: string]: unknown;
}

/** Raw root folder from a service detail endpoint (`freeSpace`, not `freeSpaceBytes`). */
export interface RawRootFolder {
  freeSpace?: number;
  id?: number;
  path?: string;
  [key: string]: unknown;
}

/** Raw service detail (`/service/radarr/{id}` | `/service/sonarr/{id}`). `profiles` is an array. */
export interface RawServiceDetail {
  languageProfiles?: unknown;
  profiles?: RawServiceProfile[];
  rootFolders?: RawRootFolder[];
  server?: RawServiceListEntry;
  [key: string]: unknown;
}

/**
 * Body submitted to `POST /request`. Also the `payload` surfaced in preview output,
 * so `is4k` is always present (the tool sets it explicitly). `userId` is
 * intentionally never set — the request is made as the API key's user.
 */
export interface CreateRequestBody {
  is4k: boolean;
  languageProfileId?: number;
  mediaId: number;
  mediaType: 'movie' | 'tv';
  profileId?: number;
  rootFolder?: string;
  seasons?: number[] | 'all';
  serverId?: number;
}

/* ------------------------------------------------------------------ *
 * Domain (redacted) types
 * ------------------------------------------------------------------ */

/** PII-safe requester/modifier projection. The ONLY shape of a Seerr user that may reach output. */
export interface DomainUser {
  displayName: string;
  id: number;
}
