/**
 * @fileoverview SeerrService — the typed client for the Seerr REST API v1
 * (`{SEERR_BASE_URL}/api/v1`, `X-Api-Key` auth). One upstream API, one service,
 * init/accessor pattern. Every method wraps a single-attempt fetch + parse in
 * `withRetry` (the retry boundary covers the full pipeline). Not-found-bearing GETs
 * (movie/tv/request) route their non-OK responses through the `errors.ts` classifier
 * so Seerr's idiosyncratic 500/404 not-found bodies become clean domain errors.
 *
 * The instance is a trusted local LAN / Tailscale host, so requests use plain
 * `fetch` (the framework's `fetchWithTimeout` SSRF guard would block the private
 * IP, and the classifier needs body access on non-OK). The base URL and API key
 * never leave this file's request construction — no method returns them.
 * @module services/seerr/seerr-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type NotFoundKind, throwClassifiedSeerrError } from './errors.js';
import type {
  CreateRequestBody,
  RawMediaRequest,
  RawMovieDetail,
  RawPublicSettings,
  RawRequestListResponse,
  RawSearchResponse,
  RawSeasonDetail,
  RawServiceDetail,
  RawServiceListEntry,
  RawStatus,
  RawTvDetail,
} from './types.js';

/**
 * `GET /request/{id}` and `POST /request` return a `MediaRequest` — aliased here
 * for method-return clarity (same shape as the list entries).
 */
export type RawMediaRequestDetail = RawMediaRequest;

const SERVICE_NAME = 'Seerr';
const SETTINGS_CACHE_KEY = 'seerr:settings:public';
const SETTINGS_CACHE_TTL_SECONDS = 300;

/**
 * Percent-encode a query key or value for Seerr. Seerr validates the UNDECODED
 * query string with `express-openapi-validator`, which rejects any value matching
 * `/[:\/?#\[\]@!$&'()*+,;=]/` — so neither `URLSearchParams` (form-encodes a space
 * to `+`, itself reserved) nor bare `encodeURIComponent` (leaves `!`, `'`, `(`,
 * `)`, `*` intact) is sufficient. Those five are escaped on top of
 * `encodeURIComponent`, which already covers the rest of the set.
 */
function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a query string from ordered params, skipping `undefined` values. Every
 * query-building call site goes through here so a free-text param can never
 * reach Seerr under-encoded.
 */
function buildQuery(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeQueryComponent(key)}=${encodeQueryComponent(String(value))}`)
    .join('&');
}

/** Options for a single Seerr request. */
interface RequestOptions {
  /** Retry backoff base (ms). LAN instance recovers fast; default 300. */
  baseDelayMs?: number;
  /** JSON body for POST. */
  body?: unknown;
  /** HTTP method (default GET). */
  method?: 'GET' | 'POST';
  /**
   * When set, a non-OK response is routed through the not-found classifier for
   * this endpoint kind before the generic status mapping. Omit for endpoints
   * without special not-found semantics.
   */
  notFoundKind?: NotFoundKind;
}

/** Filters accepted by `listRequests`. */
export interface ListRequestsParams {
  filter: string;
  mediaType: string;
  requestedById?: number;
  skip: number;
  sort: string;
  sortDirection: string;
  take: number;
}

export class SeerrService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor() {
    const server = getServerConfig();
    this.baseUrl = `${server.baseUrl.replace(/\/+$/, '')}/api/v1`;
    this.apiKey = server.apiKey;
    this.timeoutMs = server.requestTimeoutMs;
  }

  /* ------------------------------------------------------------------ *
   * Search + media detail
   * ------------------------------------------------------------------ */

  /** `GET /search` — title disambiguation. */
  search(
    params: { query: string; page: number; language?: string },
    ctx: Context,
  ): Promise<RawSearchResponse> {
    const qs = buildQuery({
      query: params.query,
      page: params.page,
      language: params.language,
    });
    return this.request<RawSearchResponse>(`/search?${qs}`, ctx);
  }

  /** `GET /movie/{id}` — movie detail. 500 "Unable to retrieve movie." → media_not_found. */
  getMovie(tmdbId: number, ctx: Context): Promise<RawMovieDetail> {
    return this.request<RawMovieDetail>(`/movie/${tmdbId}`, ctx, { notFoundKind: 'media' });
  }

  /** `GET /tv/{id}` — TV detail. */
  getTv(tmdbId: number, ctx: Context): Promise<RawTvDetail> {
    return this.request<RawTvDetail>(`/tv/${tmdbId}`, ctx, { notFoundKind: 'media' });
  }

  /** `GET /tv/{id}/season/{n}` — episode list for one season. */
  getSeason(tmdbId: number, seasonNumber: number, ctx: Context): Promise<RawSeasonDetail> {
    return this.request<RawSeasonDetail>(`/tv/${tmdbId}/season/${seasonNumber}`, ctx, {
      notFoundKind: 'media',
    });
  }

  /* ------------------------------------------------------------------ *
   * Requests
   * ------------------------------------------------------------------ */

  /** `GET /request` — list requests with filters. */
  listRequests(params: ListRequestsParams, ctx: Context): Promise<RawRequestListResponse> {
    const qs = buildQuery({
      take: params.take,
      skip: params.skip,
      filter: params.filter,
      sort: params.sort,
      sortDirection: params.sortDirection,
      mediaType: params.mediaType && params.mediaType !== 'all' ? params.mediaType : undefined,
      requestedBy: params.requestedById,
    });
    return this.request<RawRequestListResponse>(`/request?${qs}`, ctx);
  }

  /** `GET /request/{id}` — single request. 404 "Request not found." → request_not_found. */
  getRequest(requestId: number, ctx: Context): Promise<RawMediaRequestDetail> {
    return this.request<RawMediaRequestDetail>(`/request/${requestId}`, ctx, {
      notFoundKind: 'request',
    });
  }

  /** `POST /request` — create a media request. The only write in the surface. */
  createRequest(body: CreateRequestBody, ctx: Context): Promise<RawMediaRequestDetail> {
    return this.request<RawMediaRequestDetail>('/request', ctx, { method: 'POST', body });
  }

  /* ------------------------------------------------------------------ *
   * Services + settings
   * ------------------------------------------------------------------ */

  /** `GET /service/radarr` — Radarr service list. */
  getRadarrServices(ctx: Context): Promise<RawServiceListEntry[]> {
    return this.request<RawServiceListEntry[]>('/service/radarr', ctx);
  }

  /** `GET /service/radarr/{id}` — Radarr profiles + root folders. */
  getRadarrDetail(serverId: number, ctx: Context): Promise<RawServiceDetail> {
    return this.request<RawServiceDetail>(`/service/radarr/${serverId}`, ctx);
  }

  /** `GET /service/sonarr` — Sonarr service list. */
  getSonarrServices(ctx: Context): Promise<RawServiceListEntry[]> {
    return this.request<RawServiceListEntry[]>('/service/sonarr', ctx);
  }

  /** `GET /service/sonarr/{id}` — Sonarr profiles + root folders. */
  getSonarrDetail(serverId: number, ctx: Context): Promise<RawServiceDetail> {
    return this.request<RawServiceDetail>(`/service/sonarr/${serverId}`, ctx);
  }

  /** `GET /status` — Seerr version. */
  getStatus(ctx: Context): Promise<RawStatus> {
    return this.request<RawStatus>('/status', ctx);
  }

  /**
   * `GET /settings/public` — capability flags. Cached in `ctx.state` with a short
   * TTL: capability checks read it on most calls (preview validation, search/get
   * 4K decoding) but instance config changes rarely. Cache failures are non-fatal.
   */
  async getPublicSettings(
    ctx: Context,
    options: { forceRefresh?: boolean } = {},
  ): Promise<RawPublicSettings> {
    if (!options.forceRefresh) {
      const cached = await ctx.state.get<RawPublicSettings>(SETTINGS_CACHE_KEY).catch(() => null);
      if (cached) return cached;
    }
    const settings = await this.request<RawPublicSettings>('/settings/public', ctx);
    await ctx.state
      .set(SETTINGS_CACHE_KEY, settings, { ttl: SETTINGS_CACHE_TTL_SECONDS })
      .catch(() => {});
    return settings;
  }

  /* ------------------------------------------------------------------ *
   * Core request pipeline
   * ------------------------------------------------------------------ */

  /**
   * Single Seerr request: fetch (single attempt) + status check + JSON parse, all
   * inside `withRetry`. Non-OK responses route through the not-found classifier
   * (when `notFoundKind` is set) or the framework's status mapping. The retry
   * boundary wraps the whole pipeline so a transient parse failure also retries.
   */
  private request<T>(path: string, ctx: Context, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = options.method ?? 'GET';
    return withRetry(
      async () => {
        const headers: Record<string, string> = {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
        };
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';

        const response = await fetch(url, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]),
        });

        if (!response.ok) {
          await throwClassifiedSeerrError(response, options.notFoundKind ?? 'media', SERVICE_NAME);
        }

        const text = await response.text();
        if (text.length === 0) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch (cause) {
          throw serializationError(
            `${SERVICE_NAME} returned a non-JSON response.`,
            { path },
            { cause },
          );
        }
      },
      {
        operation: `SeerrService.request ${method} ${path}`,
        context: { requestId: ctx.requestId, timestamp: ctx.timestamp },
        baseDelayMs: options.baseDelayMs ?? 300,
        signal: ctx.signal,
      },
    );
  }
}

/* --- Init/accessor pattern --- */

let _service: SeerrService | undefined;

/**
 * Initialize the singleton SeerrService — called from `createApp`'s `setup()`.
 * Config and storage are accepted to match the framework's init signature; the
 * service reads its own env config via `getServerConfig()` and uses tenant-scoped
 * `ctx.state` (not the raw storage handle) for the settings cache.
 */
export function initSeerrService(_config: AppConfig, _storage: StorageService): void {
  _service = new SeerrService();
}

/** Accessor for the SeerrService singleton. Throws if `initSeerrService` was not called. */
export function getSeerrService(): SeerrService {
  if (!_service) {
    throw new Error('SeerrService not initialized — call initSeerrService() in setup()');
  }
  return _service;
}
