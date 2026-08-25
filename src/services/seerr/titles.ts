/**
 * @fileoverview Title hydration for request-shaped output. Seerr's `MediaRequest`
 * objects carry no title field — only `media.tmdbId` — so a readable request row
 * costs one extra `GET /movie/{id}` or `GET /tv/{id}` per distinct title. This
 * module owns that join and the three properties it needs:
 *
 *   - **De-duplication.** A 4K and a non-4K request for one film, or several
 *     seasons of one show, share a `(mediaType, tmdbId)` and resolve once.
 *   - **Bounded fan-out.** Lookups run through a fixed-size worker pool, never
 *     one-shot `Promise.all` over an entire page. Each leg is single-attempt, so
 *     the pool's width is also the real ceiling on upstream calls.
 *   - **Degradation.** A lookup that throws, returns an empty title, or has no
 *     `tmdbId` to look up yields no title and no error — the row keeps every
 *     other field. Callers disclose the count; nothing here throws.
 * @module services/seerr/titles
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { DomainRequestDetail } from './normalizers.js';
import type { SeerrService } from './seerr-service.js';

/**
 * Simultaneous detail lookups per hydration pass. Seerr is a single-node app
 * proxying TMDB on a self-hosted LAN host, so a 100-row page must not open 100
 * sockets against it; 6 matches the per-origin connection budget browsers have
 * long used against one host, and drains a full page in ~17 sequential waves.
 */
const TITLE_LOOKUP_CONCURRENCY = 6;

/**
 * A title is cosmetic, so a leg that fails is absorbed — which makes the default
 * retry budget actively harmful here: a transient-classified detail read would
 * burn four upstream calls and seconds of backoff to produce the same absent
 * title, occupying a worker and multiplying load on the single-node instance the
 * pool exists to protect. One attempt, then degrade.
 */
const BEST_EFFORT = { maxRetries: 0 } as const;

/** The identity of one title lookup — the pair that de-duplicates a request page. */
export interface TitleKey {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
}

/** Outcome of one hydration pass. */
export interface TitleLookup {
  /** Resolved titles, keyed by {@link titleKeyOf}. A key absent here did not resolve. */
  titles: Map<string, string>;
  /** Distinct pairs looked up — the number of upstream detail calls this pass made. */
  uniqueKeys: number;
}

/** Map key for a resolved title. */
export function titleKeyOf(mediaType: 'movie' | 'tv', tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

/**
 * Resolve titles for a batch of `(mediaType, tmdbId)` pairs. Duplicates collapse
 * before any fetch, so N rows sharing a title cost one call. Never throws — a
 * failed leg is absorbed, leaving its key absent from `titles`.
 */
export async function resolveTitles(
  keys: readonly TitleKey[],
  seerr: SeerrService,
  ctx: Context,
): Promise<TitleLookup> {
  const distinct = new Map<string, TitleKey>();
  for (const key of keys) distinct.set(titleKeyOf(key.mediaType, key.tmdbId), key);
  const entries = [...distinct];

  const titles = new Map<string, string>();
  let cursor = 0;

  /**
   * Pull-based worker: each pulls the next index and runs to exhaustion, so a
   * slow lookup delays only itself rather than stalling a fixed-size chunk.
   */
  const worker = async (): Promise<void> => {
    for (let entry = entries[cursor++]; entry !== undefined; entry = entries[cursor++]) {
      const [key, { mediaType, tmdbId }] = entry;
      const title = await fetchTitle(mediaType, tmdbId, seerr, ctx);
      if (title) titles.set(key, title);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(TITLE_LOOKUP_CONCURRENCY, entries.length) }, worker),
  );

  return { titles, uniqueKeys: entries.length };
}

/**
 * Attach a resolved title to a single projected request detail. Returns the
 * detail untouched when there is no `tmdbId` to look up or the lookup fails —
 * the shared path behind seerr_request_status and the request resource, both of
 * which hydrate unconditionally (one request, one extra call).
 */
export async function hydrateRequestTitle(
  detail: DomainRequestDetail,
  seerr: SeerrService,
  ctx: Context,
): Promise<DomainRequestDetail> {
  if (typeof detail.tmdbId !== 'number') return detail;
  const title = await fetchTitle(detail.mediaType, detail.tmdbId, seerr, ctx);
  return title ? { ...detail, title } : detail;
}

/**
 * One detail fetch reduced to its title. `RawMovieDetail.title` / `RawTvDetail.name`
 * are the same fields seerr_get_media reads. Upstream failures (including Seerr's
 * 500-flavored not-found) resolve to `undefined` rather than throwing.
 */
async function fetchTitle(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  seerr: SeerrService,
  ctx: Context,
): Promise<string | undefined> {
  try {
    const title =
      mediaType === 'tv'
        ? (await seerr.getTv(tmdbId, ctx, BEST_EFFORT)).name
        : (await seerr.getMovie(tmdbId, ctx, BEST_EFFORT)).title;
    return title?.trim() || undefined;
  } catch (error) {
    ctx.log.debug('Seerr title lookup failed', { mediaType, tmdbId, cause: causeOf(error) });
    return;
  }
}

/**
 * A classified label for a swallowed lookup failure. `ctx.log` is dual-sink — every
 * call also reaches the client as `notifications/message` — and a raw upstream or
 * network message can echo the instance host or a root-folder path, neither of which
 * passes through the `normalizers.ts` choke point. The classifier's own reason (or
 * the error's constructor name) carries the diagnostic without the free text.
 */
function causeOf(error: unknown): string {
  if (error instanceof McpError) {
    const reason = (error.data as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' ? reason : `McpError(${error.code})`;
  }
  return error instanceof Error ? error.name : 'unknown';
}
