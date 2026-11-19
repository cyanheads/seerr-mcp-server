/**
 * @fileoverview SeerrService — the typed client for the Seerr REST API v1
 * (`{SEERR_BASE_URL}/api/v1`, `X-Api-Key` auth). One upstream API, one service,
 * init/accessor pattern. Reads wrap fetch + parse in `withRetry` (the retry
 * boundary covers the full pipeline); request creation makes one attempt because
 * Seerr provides no idempotency key. Endpoints whose statuses carry their own
 * meaning (movie/tv/season/request detail, the request list, request creation)
 * route their non-OK responses through the `errors.ts` classifier, so Seerr's
 * 500/404 not-found bodies, the list's 400, and the create's 409 become domain
 * errors.
 *
 * The instance is a trusted local LAN / Tailscale host, so requests use plain
 * `fetch` (the framework's `fetchWithTimeout` SSRF guard would block the private
 * IP, and the classifier needs body access on non-OK). The base URL and API key
 * never leave this file's request construction — no method returns them.
 * @module services/seerr/seerr-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { invalidParams, serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type SeerrEndpoint, throwClassifiedSeerrError } from './errors.js';
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
/** `ctx.state` restricts keys to `[a-zA-Z0-9_.\-/]`; a colon-separated key is rejected outright. */
const SETTINGS_CACHE_KEY = 'seerr/settings/public';
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

/**
 * Per-call overrides for the media-detail reads (`getMovie` / `getTv`). Both are
 * called on a required path (`seerr_get_media`, where the detail IS the answer)
 * and on a best-effort path (the title join), whose failure is absorbed — so the
 * retry budget has to be the caller's choice rather than one fixed policy.
 */
export interface DetailReadOptions {
  /** Retry budget for this call. Omit for the framework default; `0` = single attempt. */
  maxRetries?: number;
}

/** Options for a single Seerr request. */
interface RequestOptions extends DetailReadOptions {
  /** Retry backoff base (ms). LAN instance recovers fast; default 300. */
  baseDelayMs?: number;
  /** JSON body for POST. */
  body?: unknown;
  /**
   * The endpoint whose status semantics classify a non-OK response before the
   * generic status mapping. Omitted, the media-detail semantics apply.
   */
  endpoint?: SeerrEndpoint;
  /** HTTP method (default GET). */
  method?: 'GET' | 'POST';
}

/** Filters accepted by `listRequests`. */
export interface ListRequestsParams {
  filter: string;
  mediaType: string;
  requestedById?: number;
  skip: number;
  sort: string;
  sortDirection: 'asc' | 'desc';
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
  getMovie(tmdbId: number, ctx: Context, options: DetailReadOptions = {}): Promise<RawMovieDetail> {
    return this.request<RawMovieDetail>(`/movie/${tmdbId}`, ctx, {
      endpoint: 'media',
      ...options,
    });
  }

  /** `GET /tv/{id}` — TV detail. */
  getTv(tmdbId: number, ctx: Context, options: DetailReadOptions = {}): Promise<RawTvDetail> {
    return this.request<RawTvDetail>(`/tv/${tmdbId}`, ctx, { endpoint: 'media', ...options });
  }

  /**
   * `GET /tv/{id}/season/{n}` — episode list for one season. 500 "Unable to retrieve
   * season." → season_not_found.
   */
  getSeason(tmdbId: number, seasonNumber: number, ctx: Context): Promise<RawSeasonDetail> {
    return this.request<RawSeasonDetail>(`/tv/${tmdbId}/season/${seasonNumber}`, ctx, {
      endpoint: 'season',
    });
  }

  /* ------------------------------------------------------------------ *
   * Requests
   * ------------------------------------------------------------------ */

  /**
   * `GET /request` — list requests with filters. HTTP 400 → unsupported_filter.
   * `sortDirection` is sent only for `asc`: Overseerr and Jellyseerr < 2.2 reject the
   * parameter outright, and every version orders newest first without it.
   */
  listRequests(params: ListRequestsParams, ctx: Context): Promise<RawRequestListResponse> {
    const qs = buildQuery({
      take: params.take,
      skip: params.skip,
      filter: params.filter,
      sort: params.sort,
      sortDirection: params.sortDirection === 'asc' ? 'asc' : undefined,
      mediaType: params.mediaType && params.mediaType !== 'all' ? params.mediaType : undefined,
      requestedBy: params.requestedById,
    });
    return this.request<RawRequestListResponse>(`/request?${qs}`, ctx, {
      endpoint: 'requestList',
    });
  }

  /** `GET /request/{id}` — single request. 404 "Request not found." → request_not_found. */
  getRequest(requestId: number, ctx: Context): Promise<RawMediaRequestDetail> {
    return this.request<RawMediaRequestDetail>(`/request/${requestId}`, ctx, {
      endpoint: 'request',
    });
  }

  /**
   * `POST /request` — one attempt; a failed response may still have created the
   * request. Seerr answers 201 with the new request, HTTP 409 for a same-quality
   * duplicate (→ duplicate_request), and 202 when no requested season is left to
   * request, creating nothing (→ no_seasons_available): each is already requested or
   * available at that quality, or — Seerr 3.5+ expands `"all"` to the numbered seasons
   * with `episode_count > 0` — none has episodes listed yet. Any other 2xx answer that
   * carries no numeric `id` is refused as well, so no caller can report a request it
   * cannot track.
   */
  async createRequest(body: CreateRequestBody, ctx: Context): Promise<RawMediaRequestDetail> {
    const response = await this.send<RawMediaRequestDetail | null | undefined>('/request', ctx, {
      method: 'POST',
      body,
      maxRetries: 0,
      endpoint: 'requestCreate',
    });
    if (response.status === 202) {
      throw invalidParams(
        'Seerr created no request: every requested season is already requested or available at this quality, or has no episodes listed yet.',
        { reason: 'no_seasons_available', httpStatus: response.status, retryable: false },
      );
    }
    const created = response.body;
    if (typeof created?.id !== 'number') {
      throw serializationError(
        `${SERVICE_NAME} answered the request without a request ID, so whether one was created is unknown.`,
        {
          httpStatus: response.status,
          recovery: {
            hint: "Read the title's latest request with seerr_get_media before submitting again.",
          },
        },
      );
    }
    return created;
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

  /** A Seerr request whose caller needs only the parsed body. */
  private async request<T>(path: string, ctx: Context, options: RequestOptions = {}): Promise<T> {
    return (await this.send<T>(path, ctx, options)).body;
  }

  /**
   * Single Seerr request: fetch (single attempt) + status check + JSON parse, all
   * inside `withRetry`. Non-OK responses route through the `errors.ts` classifier
   * with the endpoint's status semantics. The retry boundary wraps the whole
   * pipeline so a transient parse failure also retries. Returns the 2xx status
   * beside the body for the one endpoint whose success statuses differ in meaning.
   */
  private send<T>(
    path: string,
    ctx: Context,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: T }> {
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
          await throwClassifiedSeerrError(response, options.endpoint ?? 'media', SERVICE_NAME);
        }

        const { status } = response;
        const text = await response.text();
        if (text.length === 0) return { status, body: undefined as T };
        try {
          return { status, body: JSON.parse(text) as T };
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
        // `Context extends RequestContext`, so the handler ctx passes through whole —
        // a hand-rolled slice would drop traceId, spanId, tenantId, and extra.
        context: ctx,
        baseDelayMs: options.baseDelayMs ?? 300,
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
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
